use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::{get_associated_token_address, AssociatedToken};
use anchor_spl::token::spl_token::instruction::AuthorityType;
use anchor_spl::token::{self, Burn, Mint, MintTo, SetAuthority, Token, TokenAccount, Transfer};

declare_id!("9ggxpWrwYXH7sygoqQs2N5qCva38vVkJvr5ZzwPijPUu");

/// Precision factor for reward-per-point math.
pub const PRECISION: u128 = 1_000_000_000_000;
/// 20% tax on unstake.
pub const TAX_BPS: u64 = 2_000;
/// Of the unstake tax, 25% (5% of the unstake amount) is burned forever;
/// the remaining 75% (15% of the amount) still funds the rebate vault.
pub const TAX_BURN_SHARE_BPS: u64 = 2_500;
/// 1% swap fee, baked into the constant-product invariant (stays in the pool).
pub const SWAP_FEE_BPS: u64 = 100;
pub const BPS_DENOMINATOR: u64 = 10_000;
/// The creator may never receive more than this share of the supply. It is
/// enforced on-chain, in `mint_supply` — not as a UI convention.
pub const MAX_CREATOR_SHARE_BPS: u64 = 500;

#[program]
pub mod holder {
    use super::*;

    /// Initialize the global vault state and the stake vault. Token accounts
    /// are created separately in `mint_supply` (splitting the old `initialize`
    /// in two also removes the SBF stack-overflow on this instruction).
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let mint_key = ctx.accounts.mint.key();
        let vault_state_key = ctx.accounts.vault_state.key();
        let stake_vault_key = ctx.accounts.stake_vault.key();
        let (treasury, treasury_bump) =
            Pubkey::find_program_address(&[b"treasury".as_ref(), mint_key.as_ref()], ctx.program_id);

        let vault = &mut ctx.accounts.vault_state;
        vault.authority = ctx.accounts.authority.key();
        vault.mint = mint_key;
        vault.vault_token_account = get_associated_token_address(&vault_state_key, &mint_key);
        vault.stake_vault = stake_vault_key;
        vault.stake_token_account = get_associated_token_address(&stake_vault_key, &mint_key);
        vault.treasury = treasury;
        vault.treasury_bump = treasury_bump;
        vault.total_staked = 0;
        vault.total_points = 0;
        vault.reward_per_point = 0;
        vault.last_update_time = Clock::get()?.unix_timestamp;
        vault.last_recorded_balance = 0;
        vault.total_supply = 0;
        vault.creator_share = 0;
        vault.supply_minted = false;
        vault.created_at = Clock::get()?.unix_timestamp;
        vault.bump = ctx.bumps.vault_state;
        ctx.accounts.stake_vault.bump = ctx.bumps.stake_vault;
        Ok(())
    }

    /// Mint the entire supply exactly once: `MAX_CREATOR_SHARE_BPS` (5%) to the
    /// creator, the remainder to the community treasury. The program holds the
    /// mint authority, so this — and the `renounce` that nulls it — are the only
    /// way supply ever moves. A creator can never be allocated more than 5%.
    pub fn mint_supply(ctx: Context<MintSupply>, total_supply: u64) -> Result<()> {
        require!(total_supply > 0, HolderError::ZeroAmount);

        let vault = &mut ctx.accounts.vault_state;
        require!(!vault.supply_minted, HolderError::SupplyAlreadyMinted);

        let creator_share = total_supply
            .checked_mul(MAX_CREATOR_SHARE_BPS)
            .unwrap()
            .checked_div(BPS_DENOMINATOR)
            .unwrap();
        require!(creator_share > 0, HolderError::SupplyTooSmall);
        let community_share = total_supply.checked_sub(creator_share).unwrap();

        let mint_key = ctx.accounts.mint.key();
        let mint_authority_seeds = &[
            b"mint_authority".as_ref(),
            mint_key.as_ref(),
            &[ctx.bumps.mint_authority],
        ];
        let signer = &[&mint_authority_seeds[..]];

        // 5% — the creator's share, and their only share.
        let cpi_accounts = MintTo {
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.creator_token_account.to_account_info(),
            authority: ctx.accounts.mint_authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        token::mint_to(cpi_ctx, creator_share)?;

        // 95% — the community's share, held by the treasury PDA.
        let cpi_accounts = MintTo {
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.treasury_token_account.to_account_info(),
            authority: ctx.accounts.mint_authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        token::mint_to(cpi_ctx, community_share)?;

        vault.total_supply = total_supply;
        vault.creator_share = creator_share;
        vault.supply_minted = true;

        emit!(SupplyEvent {
            mint: mint_key,
            total_supply,
            creator_share,
            community_share,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Irrevocably null the mint authority. `mint_supply` is already one-time,
    /// so no more tokens can ever be minted; this removes the authority entirely
    /// so even a program upgrade could not print supply.
    pub fn renounce(ctx: Context<Renounce>) -> Result<()> {
        let cpi_accounts = SetAuthority {
            account_or_mint: ctx.accounts.mint.to_account_info(),
            current_authority: ctx.accounts.mint_authority.to_account_info(),
        };
        let mint_key = ctx.accounts.mint.key();
        let mint_authority_seeds = &[
            b"mint_authority".as_ref(),
            mint_key.as_ref(),
            &[ctx.bumps.mint_authority],
        ];
        let signer = &[&mint_authority_seeds[..]];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        token::set_authority(cpi_ctx, AuthorityType::MintTokens, None)?;

        emit!(RenounceEvent {
            mint: mint_key,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Stake tokens into the program. No tax on stake.
    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(amount > 0, HolderError::ZeroAmount);

        let vault = &mut ctx.accounts.vault_state;
        let now = Clock::get()?.unix_timestamp;
        update_vault_points(vault, now);

        let stake_account = &mut ctx.accounts.stake_account;
        if stake_account.owner == Pubkey::default() {
            stake_account.owner = ctx.accounts.user.key();
            stake_account.bump = ctx.bumps.stake_account;
            stake_account.last_update_time = now;
        }

        let vault_reward_per_point = vault.reward_per_point;
        update_stake_account_points(stake_account, now);

        // Transfer tokens from user to stake vault.
        let cpi_accounts = Transfer {
            from: ctx.accounts.user_token_account.to_account_info(),
            to: ctx.accounts.stake_token_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        stake_account.amount = stake_account.amount.checked_add(amount).unwrap();
        vault.total_staked = vault.total_staked.checked_add(amount).unwrap();
        stake_account.reward_debt = stake_account
            .points
            .checked_mul(vault_reward_per_point)
            .unwrap()
            .checked_div(PRECISION)
            .unwrap();

        emit!(StakeEvent {
            user: ctx.accounts.user.key(),
            amount,
            total_staked: stake_account.amount,
            timestamp: now,
        });

        Ok(())
    }

    /// Unstake tokens. 20% is taxed on exit: 5% of the amount is burned
    /// forever, 15% funds the rebate vault, 80% returns to the user.
    pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
        require!(amount > 0, HolderError::ZeroAmount);

        let stake_account = &mut ctx.accounts.stake_account;
        require!(stake_account.amount >= amount, HolderError::InsufficientStake);

        let vault = &mut ctx.accounts.vault_state;
        let now = Clock::get()?.unix_timestamp;
        update_vault_points(vault, now);
        let vault_reward_per_point = vault.reward_per_point;
        update_stake_account_points(stake_account, now);

        let tax = amount
            .checked_mul(TAX_BPS)
            .unwrap()
            .checked_div(BPS_DENOMINATOR)
            .unwrap();
        let burn_amount = tax
            .checked_mul(TAX_BURN_SHARE_BPS)
            .unwrap()
            .checked_div(BPS_DENOMINATOR)
            .unwrap();
        let rebate_amount = tax.checked_sub(burn_amount).unwrap();
        let to_user = amount.checked_sub(tax).unwrap();

        let mint_key = ctx.accounts.mint.key();
        let stake_vault_seeds = &[
            b"stake_vault".as_ref(),
            mint_key.as_ref(),
            &[ctx.accounts.stake_vault.bump],
        ];
        let stake_vault_signer = &[&stake_vault_seeds[..]];

        // A slice of the tax is burned forever — permanent deflation.
        if burn_amount > 0 {
            let cpi_accounts = Burn {
                mint: ctx.accounts.mint.to_account_info(),
                from: ctx.accounts.stake_token_account.to_account_info(),
                authority: ctx.accounts.stake_vault.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                stake_vault_signer,
            );
            token::burn(cpi_ctx, burn_amount)?;
        }

        // The rest of the tax goes to the protocol vault.
        if rebate_amount > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.stake_token_account.to_account_info(),
                to: ctx.accounts.vault_token_account.to_account_info(),
                authority: ctx.accounts.stake_vault.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                stake_vault_signer,
            );
            token::transfer(cpi_ctx, rebate_amount)?;
        }

        // Remainder returns to the user.
        if to_user > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.stake_token_account.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.stake_vault.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                stake_vault_signer,
            );
            token::transfer(cpi_ctx, to_user)?;
        }

        stake_account.amount = stake_account.amount.checked_sub(amount).unwrap();
        vault.total_staked = vault.total_staked.checked_sub(amount).unwrap();
        stake_account.reward_debt = stake_account
            .points
            .checked_mul(vault_reward_per_point)
            .unwrap()
            .checked_div(PRECISION)
            .unwrap();

        sync_vault_rewards(vault, ctx.accounts.vault_token_account.amount)?;

        emit!(UnstakeEvent {
            user: ctx.accounts.user.key(),
            amount,
            tax,
            burn: burn_amount,
            total_staked: stake_account.amount,
            timestamp: now,
        });

        Ok(())
    }

    /// Claim accumulated rebates from the vault.
    pub fn claim_rebate(ctx: Context<ClaimRebate>) -> Result<()> {
        let vault = &mut ctx.accounts.vault_state;
        let now = Clock::get()?.unix_timestamp;
        update_vault_points(vault, now);
        let vault_reward_per_point = vault.reward_per_point;

        let stake_account = &mut ctx.accounts.stake_account;
        let reward_debt_before = stake_account.reward_debt;
        update_stake_account_points(stake_account, now);

        let full_debt = stake_account
            .points
            .checked_mul(vault_reward_per_point)
            .unwrap()
            .checked_div(PRECISION)
            .unwrap();
        let pending = full_debt.checked_sub(reward_debt_before).unwrap();

        require!(pending > 0, HolderError::NoRewards);

        // Clamp the payout to what the vault actually holds, but only settle the
        // amount that is paid — a shortfall stays accrued rather than forfeited.
        let available = ctx.accounts.vault_token_account.amount as u128;
        let payout = pending.min(available);
        let shortfall = pending.checked_sub(payout).unwrap();
        stake_account.reward_debt = full_debt.checked_sub(shortfall).unwrap();

        let mint_key = ctx.accounts.mint.key();
        let vault_seeds = &[b"vault_state".as_ref(), mint_key.as_ref(), &[vault.bump]];
        let vault_signer = &[&vault_seeds[..]];

        let vault_account_info = vault.to_account_info();
        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: vault_account_info,
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            vault_signer,
        );
        token::transfer(cpi_ctx, payout as u64)?;

        vault.last_recorded_balance = ctx
            .accounts
            .vault_token_account
            .amount
            .checked_sub(payout as u64)
            .unwrap();

        emit!(ClaimEvent {
            user: ctx.accounts.user.key(),
            amount: payout as u64,
            timestamp: now,
        });

        Ok(())
    }

    /// Permissionless crank: distribute any new tokens that have arrived in the vault.
    pub fn sync_rewards(ctx: Context<SyncRewards>) -> Result<()> {
        let vault = &mut ctx.accounts.vault_state;
        let now = Clock::get()?.unix_timestamp;
        update_vault_points(vault, now);
        sync_vault_rewards(vault, ctx.accounts.vault_token_account.amount)?;
        Ok(())
    }

    /// Authority-only: seed the SOL/token swap pool. SOL comes from the
    /// authority; tokens come from the community treasury (never the creator's
    /// own wallet), so the creator cannot direct the 95% anywhere but the pool.
    pub fn initialize_pool(ctx: Context<InitializePool>, sol_amount: u64, hold_amount: u64) -> Result<()> {
        require!(sol_amount > 0 && hold_amount > 0, HolderError::ZeroAmount);

        let cpi_accounts = system_program::Transfer {
            from: ctx.accounts.authority.to_account_info(),
            to: ctx.accounts.swap_pool.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.system_program.to_account_info(), cpi_accounts);
        system_program::transfer(cpi_ctx, sol_amount)?;

        let mint_key = ctx.accounts.mint.key();
        let treasury_bump = ctx.accounts.vault_state.treasury_bump;
        let treasury_seeds = &[b"treasury".as_ref(), mint_key.as_ref(), &[treasury_bump]];
        let treasury_signer = &[&treasury_seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.treasury_token_account.to_account_info(),
            to: ctx.accounts.hold_vault.to_account_info(),
            authority: ctx.accounts.treasury.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            treasury_signer,
        );
        token::transfer(cpi_ctx, hold_amount)?;

        let pool = &mut ctx.accounts.swap_pool;
        pool.mint = mint_key;
        pool.hold_vault = ctx.accounts.hold_vault.key();
        pool.bump = ctx.bumps.swap_pool;

        Ok(())
    }

    /// Authority-only: top up the swap pool's liquidity from the treasury.
    pub fn add_liquidity(ctx: Context<AddLiquidity>, sol_amount: u64, hold_amount: u64) -> Result<()> {
        require!(sol_amount > 0 || hold_amount > 0, HolderError::ZeroAmount);

        if sol_amount > 0 {
            let cpi_accounts = system_program::Transfer {
                from: ctx.accounts.authority.to_account_info(),
                to: ctx.accounts.swap_pool.to_account_info(),
            };
            let cpi_ctx = CpiContext::new(ctx.accounts.system_program.to_account_info(), cpi_accounts);
            system_program::transfer(cpi_ctx, sol_amount)?;
        }

        if hold_amount > 0 {
            let mint_key = ctx.accounts.mint.key();
            let treasury_bump = ctx.accounts.vault_state.treasury_bump;
            let treasury_seeds = &[b"treasury".as_ref(), mint_key.as_ref(), &[treasury_bump]];
            let treasury_signer = &[&treasury_seeds[..]];

            let cpi_accounts = Transfer {
                from: ctx.accounts.treasury_token_account.to_account_info(),
                to: ctx.accounts.hold_vault.to_account_info(),
                authority: ctx.accounts.treasury.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                treasury_signer,
            );
            token::transfer(cpi_ctx, hold_amount)?;
        }

        Ok(())
    }

    /// Swap devnet SOL for HOLD against the constant-product pool.
    pub fn swap_sol_for_hold(ctx: Context<SwapSolForHold>, sol_in: u64, min_hold_out: u64) -> Result<()> {
        require!(sol_in > 0, HolderError::ZeroAmount);

        let pool_info = ctx.accounts.swap_pool.to_account_info();
        let rent_exempt = Rent::get()?.minimum_balance(pool_info.data_len());
        let sol_reserve = pool_info
            .lamports()
            .checked_sub(rent_exempt)
            .ok_or(error!(HolderError::InsufficientLiquidity))?;
        let hold_reserve = ctx.accounts.hold_vault.amount;
        require!(sol_reserve > 0 && hold_reserve > 0, HolderError::InsufficientLiquidity);

        let hold_out = constant_product_out(sol_reserve, hold_reserve, sol_in, SWAP_FEE_BPS)?;
        require!(hold_out >= min_hold_out, HolderError::SlippageExceeded);
        require!(hold_out < hold_reserve, HolderError::InsufficientLiquidity);

        let cpi_accounts = system_program::Transfer {
            from: ctx.accounts.user.to_account_info(),
            to: ctx.accounts.swap_pool.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.system_program.to_account_info(), cpi_accounts);
        system_program::transfer(cpi_ctx, sol_in)?;

        let mint_key = ctx.accounts.mint.key();
        let pool_seeds = &[
            b"swap_pool".as_ref(),
            mint_key.as_ref(),
            &[ctx.accounts.swap_pool.bump],
        ];
        let pool_signer = &[&pool_seeds[..]];
        let cpi_accounts = Transfer {
            from: ctx.accounts.hold_vault.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.swap_pool.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            pool_signer,
        );
        token::transfer(cpi_ctx, hold_out)?;

        emit!(SwapEvent {
            user: ctx.accounts.user.key(),
            sol_amount: sol_in,
            hold_amount: hold_out,
            sol_to_hold: true,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Swap HOLD for devnet SOL against the constant-product pool.
    pub fn swap_hold_for_sol(ctx: Context<SwapHoldForSol>, hold_in: u64, min_sol_out: u64) -> Result<()> {
        require!(hold_in > 0, HolderError::ZeroAmount);

        let pool_info = ctx.accounts.swap_pool.to_account_info();
        let rent_exempt = Rent::get()?.minimum_balance(pool_info.data_len());
        let sol_reserve = pool_info
            .lamports()
            .checked_sub(rent_exempt)
            .ok_or(error!(HolderError::InsufficientLiquidity))?;
        let hold_reserve = ctx.accounts.hold_vault.amount;
        require!(sol_reserve > 0 && hold_reserve > 0, HolderError::InsufficientLiquidity);

        let sol_out = constant_product_out(hold_reserve, sol_reserve, hold_in, SWAP_FEE_BPS)?;
        require!(sol_out >= min_sol_out, HolderError::SlippageExceeded);
        require!(sol_out < sol_reserve, HolderError::InsufficientLiquidity);

        let cpi_accounts = Transfer {
            from: ctx.accounts.user_token_account.to_account_info(),
            to: ctx.accounts.hold_vault.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, hold_in)?;

        {
            let pool_account_info = ctx.accounts.swap_pool.to_account_info();
            let user_account_info = ctx.accounts.user.to_account_info();
            **pool_account_info.try_borrow_mut_lamports()? = pool_account_info
                .lamports()
                .checked_sub(sol_out)
                .ok_or(error!(HolderError::InsufficientLiquidity))?;
            **user_account_info.try_borrow_mut_lamports()? =
                user_account_info.lamports().checked_add(sol_out).unwrap();
        }

        emit!(SwapEvent {
            user: ctx.accounts.user.key(),
            sol_amount: sol_out,
            hold_amount: hold_in,
            sol_to_hold: false,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

}

fn update_vault_points(vault: &mut Account<VaultState>, now: i64) {
    if now > vault.last_update_time && vault.total_staked > 0 {
        let elapsed = (now - vault.last_update_time) as u128;
        let added = elapsed.checked_mul(vault.total_staked as u128).unwrap();
        vault.total_points = vault.total_points.checked_add(added).unwrap();
    }
    vault.last_update_time = now;
}

/// Advance a stake account's accrued points (stake × time) to `now`. Does NOT
/// touch `reward_debt` — settling the debt is the caller's job, so `claim_rebate`
/// can read the pre-settlement debt to compute what's actually owed.
fn update_stake_account_points(stake_account: &mut Account<StakeAccount>, now: i64) {
    if now > stake_account.last_update_time && stake_account.amount > 0 {
        let elapsed = (now - stake_account.last_update_time) as u128;
        let added = elapsed.checked_mul(stake_account.amount as u128).unwrap();
        stake_account.points = stake_account.points.checked_add(added).unwrap();
    }
    stake_account.last_update_time = now;
}

/// Constant-product swap quote: how much of `reserve_out` you get for `amount_in`
/// of `reserve_in`, with `fee_bps` taken off the input before the invariant is
/// applied (the fee stays in the pool as reserve growth — no separate fee vault).
fn constant_product_out(
    reserve_in: u64,
    reserve_out: u64,
    amount_in: u64,
    fee_bps: u64,
) -> Result<u64> {
    let amount_in_after_fee = (amount_in as u128)
        .checked_mul((BPS_DENOMINATOR.checked_sub(fee_bps).unwrap()) as u128)
        .unwrap()
        .checked_div(BPS_DENOMINATOR as u128)
        .unwrap();
    let numerator = amount_in_after_fee.checked_mul(reserve_out as u128).unwrap();
    let denominator = (reserve_in as u128).checked_add(amount_in_after_fee).unwrap();
    require!(denominator > 0, HolderError::InsufficientLiquidity);
    let out = numerator.checked_div(denominator).unwrap();
    Ok(out as u64)
}

fn sync_vault_rewards(vault: &mut Account<VaultState>, current_balance: u64) -> Result<()> {
    if current_balance > vault.last_recorded_balance {
        if vault.total_points > 0 {
            let new_rewards = (current_balance - vault.last_recorded_balance) as u128;
            let increment = new_rewards
                .checked_mul(PRECISION)
                .unwrap()
                .checked_div(vault.total_points)
                .unwrap();
            vault.reward_per_point = vault.reward_per_point.checked_add(increment).unwrap();
            vault.last_recorded_balance = current_balance;
        }
        // Rewards that arrive while nothing is staked (total_points == 0) are
        // left unrecorded so they are distributed to the first stakers on the
        // next sync, rather than being silently dropped.
    }
    Ok(())
}

#[account]
pub struct StakeVault {
    pub bump: u8,
}

impl StakeVault {
    pub const SIZE: usize = 1;
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + VaultState::SIZE,
        seeds = [b"vault_state", mint.key().as_ref()],
        bump
    )]
    pub vault_state: Box<Account<'info, VaultState>>,

    #[account(
        init,
        payer = authority,
        space = 8 + StakeVault::SIZE,
        seeds = [b"stake_vault", mint.key().as_ref()],
        bump
    )]
    pub stake_vault: Box<Account<'info, StakeVault>>,

    pub mint: Box<Account<'info, Mint>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct MintSupply<'info> {
    #[account(
        mut,
        seeds = [b"vault_state", mint.key().as_ref()],
        bump = vault_state.bump,
        has_one = mint,
        has_one = authority,
    )]
    pub vault_state: Box<Account<'info, VaultState>>,

    #[account(mut)]
    pub mint: Box<Account<'info, Mint>>,

    #[account(seeds = [b"mint_authority", mint.key().as_ref()], bump)]
    /// CHECK: PDA that holds the mint authority; the program signs with it.
    pub mint_authority: UncheckedAccount<'info>,

    #[account(seeds = [b"treasury", mint.key().as_ref()], bump = vault_state.treasury_bump)]
    /// CHECK: treasury PDA that owns the community token account.
    pub treasury: UncheckedAccount<'info>,

    #[account(mut, associated_token::mint = mint, associated_token::authority = treasury)]
    pub treasury_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut, associated_token::mint = mint, associated_token::authority = authority)]
    pub creator_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Renounce<'info> {
    #[account(
        seeds = [b"vault_state", mint.key().as_ref()],
        bump = vault_state.bump,
        has_one = mint,
    )]
    pub vault_state: Box<Account<'info, VaultState>>,

    #[account(mut)]
    pub mint: Box<Account<'info, Mint>>,

    #[account(seeds = [b"mint_authority", mint.key().as_ref()], bump)]
    /// CHECK: PDA that holds the mint authority; the program signs with it.
    pub mint_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(
        mut,
        seeds = [b"vault_state", mint.key().as_ref()],
        bump = vault_state.bump,
        has_one = mint,
        has_one = stake_vault,
        has_one = stake_token_account,
    )]
    pub vault_state: Box<Account<'info, VaultState>>,

    #[account(
        seeds = [b"stake_vault", mint.key().as_ref()],
        bump = stake_vault.bump,
    )]
    pub stake_vault: Box<Account<'info, StakeVault>>,

    pub mint: Box<Account<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + StakeAccount::SIZE,
        seeds = [b"stake_account", vault_state.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub stake_account: Box<Account<'info, StakeAccount>>,

    #[account(mut, associated_token::mint = mint, associated_token::authority = stake_vault)]
    pub stake_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(
        mut,
        seeds = [b"vault_state", mint.key().as_ref()],
        bump = vault_state.bump,
        has_one = mint,
        has_one = vault_token_account,
        has_one = stake_vault,
        has_one = stake_token_account,
    )]
    pub vault_state: Box<Account<'info, VaultState>>,

    #[account(
        seeds = [b"stake_vault", mint.key().as_ref()],
        bump = stake_vault.bump,
    )]
    pub stake_vault: Box<Account<'info, StakeVault>>,

    #[account(mut)]
    pub mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [b"stake_account", vault_state.key().as_ref(), user.key().as_ref()],
        bump = stake_account.bump,
    )]
    pub stake_account: Box<Account<'info, StakeAccount>>,

    #[account(mut, associated_token::mint = mint, associated_token::authority = stake_vault)]
    pub stake_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut, associated_token::mint = mint, associated_token::authority = vault_state)]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint,
        associated_token::authority = user,
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ClaimRebate<'info> {
    #[account(
        mut,
        seeds = [b"vault_state", mint.key().as_ref()],
        bump = vault_state.bump,
        has_one = mint,
        has_one = vault_token_account,
    )]
    pub vault_state: Box<Account<'info, VaultState>>,

    pub mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [b"stake_account", vault_state.key().as_ref(), user.key().as_ref()],
        bump = stake_account.bump,
    )]
    pub stake_account: Box<Account<'info, StakeAccount>>,

    #[account(mut, associated_token::mint = mint, associated_token::authority = vault_state)]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint,
        associated_token::authority = user,
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct SyncRewards<'info> {
    #[account(
        mut,
        seeds = [b"vault_state", mint.key().as_ref()],
        bump = vault_state.bump,
        has_one = mint,
        has_one = vault_token_account,
    )]
    pub vault_state: Account<'info, VaultState>,

    pub mint: Account<'info, Mint>,

    #[account(mut, associated_token::mint = mint, associated_token::authority = vault_state)]
    pub vault_token_account: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(
        seeds = [b"vault_state", mint.key().as_ref()],
        bump = vault_state.bump,
        has_one = authority,
        has_one = mint,
    )]
    pub vault_state: Box<Account<'info, VaultState>>,

    #[account(
        init,
        payer = authority,
        space = 8 + SwapPool::SIZE,
        seeds = [b"swap_pool", mint.key().as_ref()],
        bump
    )]
    pub swap_pool: Box<Account<'info, SwapPool>>,

    pub mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        associated_token::mint = mint,
        associated_token::authority = swap_pool,
    )]
    pub hold_vault: Box<Account<'info, TokenAccount>>,

    #[account(seeds = [b"treasury", mint.key().as_ref()], bump = vault_state.treasury_bump)]
    /// CHECK: treasury PDA that owns the community token account.
    pub treasury: UncheckedAccount<'info>,

    #[account(mut, associated_token::mint = mint, associated_token::authority = treasury)]
    pub treasury_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(
        seeds = [b"vault_state", mint.key().as_ref()],
        bump = vault_state.bump,
        has_one = authority,
        has_one = mint,
    )]
    pub vault_state: Box<Account<'info, VaultState>>,

    #[account(
        mut,
        seeds = [b"swap_pool", mint.key().as_ref()],
        bump = swap_pool.bump,
        has_one = mint,
        has_one = hold_vault,
    )]
    pub swap_pool: Box<Account<'info, SwapPool>>,

    pub mint: Box<Account<'info, Mint>>,

    #[account(mut)]
    pub hold_vault: Box<Account<'info, TokenAccount>>,

    #[account(seeds = [b"treasury", mint.key().as_ref()], bump = vault_state.treasury_bump)]
    /// CHECK: treasury PDA that owns the community token account.
    pub treasury: UncheckedAccount<'info>,

    #[account(mut, associated_token::mint = mint, associated_token::authority = treasury)]
    pub treasury_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SwapSolForHold<'info> {
    pub mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [b"swap_pool", mint.key().as_ref()],
        bump = swap_pool.bump,
        has_one = mint,
        has_one = hold_vault,
    )]
    pub swap_pool: Box<Account<'info, SwapPool>>,

    #[account(mut)]
    pub hold_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint,
        associated_token::authority = user,
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct SwapHoldForSol<'info> {
    pub mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [b"swap_pool", mint.key().as_ref()],
        bump = swap_pool.bump,
        has_one = mint,
        has_one = hold_vault,
    )]
    pub swap_pool: Box<Account<'info, SwapPool>>,

    #[account(mut)]
    pub hold_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[account]
pub struct VaultState {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub vault_token_account: Pubkey,
    pub stake_vault: Pubkey,
    pub stake_token_account: Pubkey,
    pub treasury: Pubkey,
    pub total_staked: u64,
    pub total_points: u128,
    pub reward_per_point: u128,
    pub last_update_time: i64,
    pub last_recorded_balance: u64,
    pub total_supply: u64,
    pub creator_share: u64,
    pub supply_minted: bool,
    pub created_at: i64,
    pub bump: u8,
    pub treasury_bump: u8,
}

impl VaultState {
    pub const SIZE: usize = 32 + 32 + 32 + 32 + 32 + 32 + 8 + 16 + 16 + 8 + 8 + 8 + 8 + 1 + 8 + 1 + 1;
}

#[account]
pub struct StakeAccount {
    pub owner: Pubkey,
    pub amount: u64,
    pub points: u128,
    pub reward_debt: u128,
    pub last_update_time: i64,
    pub bump: u8,
}

impl StakeAccount {
    pub const SIZE: usize = 32 + 8 + 16 + 16 + 8 + 1;
}

#[account]
pub struct SwapPool {
    pub mint: Pubkey,
    pub hold_vault: Pubkey,
    pub bump: u8,
}

impl SwapPool {
    pub const SIZE: usize = 32 + 32 + 1;
}

#[event]
pub struct StakeEvent {
    pub user: Pubkey,
    pub amount: u64,
    pub total_staked: u64,
    pub timestamp: i64,
}

#[event]
pub struct UnstakeEvent {
    pub user: Pubkey,
    pub amount: u64,
    pub tax: u64,
    pub burn: u64,
    pub total_staked: u64,
    pub timestamp: i64,
}

#[event]
pub struct ClaimEvent {
    pub user: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct SwapEvent {
    pub user: Pubkey,
    pub sol_amount: u64,
    pub hold_amount: u64,
    pub sol_to_hold: bool,
    pub timestamp: i64,
}

#[event]
pub struct SupplyEvent {
    pub mint: Pubkey,
    pub total_supply: u64,
    pub creator_share: u64,
    pub community_share: u64,
    pub timestamp: i64,
}

#[event]
pub struct RenounceEvent {
    pub mint: Pubkey,
    pub timestamp: i64,
}

#[error_code]
pub enum HolderError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Insufficient staked balance")]
    InsufficientStake,
    #[msg("No rewards available")]
    NoRewards,
    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,
    #[msg("Insufficient pool liquidity")]
    InsufficientLiquidity,
    #[msg("Supply has already been minted")]
    SupplyAlreadyMinted,
    #[msg("Supply is too small to allocate a 5% creator share")]
    SupplyTooSmall,
}
