use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("9ggxpWrwYXH7sygoqQs2N5qCva38vVkJvr5ZzwPijPUu");

/// Precision factor for reward-per-point math.
pub const PRECISION: u128 = 1_000_000_000_000;
/// 20% tax on unstake.
pub const TAX_BPS: u64 = 2_000;
/// 1% swap fee, baked into the constant-product invariant (stays in the pool).
pub const SWAP_FEE_BPS: u64 = 100;
pub const BPS_DENOMINATOR: u64 = 10_000;

#[program]
pub mod holder {
    use super::*;

    /// Initialize the global vault state, the tax vault, and the stake vault.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let vault = &mut ctx.accounts.vault_state;
        vault.authority = ctx.accounts.authority.key();
        vault.mint = ctx.accounts.mint.key();
        vault.vault_token_account = ctx.accounts.vault_token_account.key();
        vault.stake_vault = ctx.accounts.stake_vault.key();
        vault.stake_token_account = ctx.accounts.stake_token_account.key();
        vault.total_staked = 0;
        vault.total_points = 0;
        vault.reward_per_point = 0;
        vault.last_update_time = Clock::get()?.unix_timestamp;
        vault.last_recorded_balance = 0;
        vault.bump = ctx.bumps.vault_state;
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
        update_stake_account_points(stake_account, now, vault_reward_per_point);

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

    /// Unstake tokens. 20% is taxed to the vault, 80% returns to the user.
    pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
        require!(amount > 0, HolderError::ZeroAmount);

        let stake_account = &mut ctx.accounts.stake_account;
        require!(stake_account.amount >= amount, HolderError::InsufficientStake);

        let vault = &mut ctx.accounts.vault_state;
        let now = Clock::get()?.unix_timestamp;
        update_vault_points(vault, now);
        let vault_reward_per_point = vault.reward_per_point;
        update_stake_account_points(stake_account, now, vault_reward_per_point);

        let tax = amount
            .checked_mul(TAX_BPS)
            .unwrap()
            .checked_div(BPS_DENOMINATOR)
            .unwrap();
        let to_user = amount.checked_sub(tax).unwrap();

        let mint_key = ctx.accounts.mint.key();
        let stake_vault_seeds = &[
            b"stake_vault".as_ref(),
            mint_key.as_ref(),
            &[ctx.accounts.stake_vault.bump],
        ];
        let stake_vault_signer = &[&stake_vault_seeds[..]];

        // Taxed portion goes to the protocol vault.
        if tax > 0 {
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
            token::transfer(cpi_ctx, tax)?;
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
        update_stake_account_points(stake_account, now, vault_reward_per_point);

        let pending = stake_account
            .points
            .checked_mul(vault_reward_per_point)
            .unwrap()
            .checked_div(PRECISION)
            .unwrap()
            .checked_sub(stake_account.reward_debt)
            .unwrap();

        require!(pending > 0, HolderError::NoRewards);

        stake_account.reward_debt = stake_account
            .points
            .checked_mul(vault_reward_per_point)
            .unwrap()
            .checked_div(PRECISION)
            .unwrap();

        let available = ctx.accounts.vault_token_account.amount;
        let payout = pending.min(available as u128) as u64;

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
        token::transfer(cpi_ctx, payout)?;

        vault.last_recorded_balance = ctx
            .accounts
            .vault_token_account
            .amount
            .checked_sub(payout)
            .unwrap();

        emit!(ClaimEvent {
            user: ctx.accounts.user.key(),
            amount: payout,
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

    /// Authority-only: seed the SOL/HOLD swap pool with initial liquidity.
    pub fn initialize_pool(ctx: Context<InitializePool>, sol_amount: u64, hold_amount: u64) -> Result<()> {
        require!(sol_amount > 0 && hold_amount > 0, HolderError::ZeroAmount);

        let cpi_accounts = system_program::Transfer {
            from: ctx.accounts.authority.to_account_info(),
            to: ctx.accounts.swap_pool.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.system_program.to_account_info(), cpi_accounts);
        system_program::transfer(cpi_ctx, sol_amount)?;

        let cpi_accounts = Transfer {
            from: ctx.accounts.authority_token_account.to_account_info(),
            to: ctx.accounts.hold_vault.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, hold_amount)?;

        let pool = &mut ctx.accounts.swap_pool;
        pool.mint = ctx.accounts.mint.key();
        pool.hold_vault = ctx.accounts.hold_vault.key();
        pool.bump = ctx.bumps.swap_pool;

        Ok(())
    }

    /// Authority-only: top up the swap pool's liquidity.
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
            let cpi_accounts = Transfer {
                from: ctx.accounts.authority_token_account.to_account_info(),
                to: ctx.accounts.hold_vault.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            };
            let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
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

fn update_stake_account_points(
    stake_account: &mut Account<StakeAccount>,
    now: i64,
    reward_per_point: u128,
) {
    if now > stake_account.last_update_time && stake_account.amount > 0 {
        let elapsed = (now - stake_account.last_update_time) as u128;
        let added = elapsed.checked_mul(stake_account.amount as u128).unwrap();
        stake_account.points = stake_account.points.checked_add(added).unwrap();
    }
    stake_account.last_update_time = now;
    stake_account.reward_debt = stake_account
        .points
        .checked_mul(reward_per_point)
        .unwrap()
        .checked_div(PRECISION)
        .unwrap();
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

    #[account(
        init,
        payer = authority,
        associated_token::mint = mint,
        associated_token::authority = vault_state,
    )]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = authority,
        associated_token::mint = mint,
        associated_token::authority = stake_vault,
    )]
    pub stake_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
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

    #[account(mut)]
    pub authority_token_account: Box<Account<'info, TokenAccount>>,

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

    #[account(mut)]
    pub authority_token_account: Box<Account<'info, TokenAccount>>,

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
    pub total_staked: u64,
    pub total_points: u128,
    pub reward_per_point: u128,
    pub last_update_time: i64,
    pub last_recorded_balance: u64,
    pub bump: u8,
}

impl VaultState {
    pub const SIZE: usize = 32 + 32 + 32 + 32 + 32 + 8 + 16 + 16 + 8 + 8 + 1;
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
}
