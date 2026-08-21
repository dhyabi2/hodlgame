#!/usr/bin/env python3
"""HoldFun FROST coordinator gateway.

Bridges HoldFun's TS operator (server/frostSigner.ts) to VELA's blake2b-FROST
signer. Receives a block hash + policy context, runs the 2-of-3 signing round
(each cosigner independently verifies the payout via HoldFun's verifier before
releasing its share — see deploy/holdfun_cosigner.py), and returns the
aggregated group signature. The operator assembles the block + PoW and
broadcasts. The coordinator holds ONE share; no single party can sign alone.

Deploy on the coordinator box (user `holdfun`):
  FROST_DATA_DIR=/opt/holdfun/data/frost \
  FROST_COSIGNERS="2@http://76.13.220.231:8083,3@http://168.231.114.66:8083" \
  FROST_MY_ID=1 \
  COSIGNER_API_KEY=$(cat /opt/holdfun/.cosigner_api_key) \
  HOLDFUN_COORD_KEY=$(cat /opt/holdfun/.coord_key) \
  COORD_PORT=8090 \
  VELA_SRC=/root/verifyXNOPrivacyProtocol/src \
  python3 holdfun_coordinator.py
"""
import os
import sys

from flask import Flask, jsonify, request

sys.path.insert(0, os.environ.get("VELA_SRC", "/root/verifyXNOPrivacyProtocol/src"))
import frost_signer  # noqa: E402  (VELA's coordinator — reused verbatim)

DATA_DIR = os.environ["FROST_DATA_DIR"]
COORD_KEY = os.environ.get("HOLDFUN_COORD_KEY", "")
PORT = int(os.environ.get("COORD_PORT", "8090"))

app = Flask(__name__)


def _denom_for(token_id: str) -> str:
    """HoldFun uses one FROST key group; the 'denomination' is the group dir
    under FROST_DATA_DIR (single group -> the sole subdir)."""
    groups = [d for d in os.listdir(DATA_DIR) if os.path.isdir(os.path.join(DATA_DIR, d)) and d != "nonces"]
    if not groups:
        raise RuntimeError("no FROST group provisioned (run the DKG)")
    return groups[0]


@app.route("/sign", methods=["POST"])
def sign():
    if COORD_KEY and request.headers.get("X-Holdfun-Key") != COORD_KEY:
        return jsonify(error="unauthorized"), 403
    data = request.get_json(force=True)
    block_hash_hex = str(data.get("blockHash", ""))
    context = data.get("context") or {}
    if len(block_hash_hex) != 64:
        return jsonify(error="blockHash must be 32-byte hex"), 400
    if context.get("type") != "holdfun-payout":
        return jsonify(error="unexpected context type"), 400
    try:
        denom = _denom_for(str(context.get("tokenId", "")))
        signer = frost_signer.FrostSigner(data_dir=DATA_DIR, denomination=denom)
        # Runs commit -> sign (cosigners verify via context) -> aggregate, and
        # double-verifies the group signature before returning it.
        signature = signer.sign(bytes.fromhex(block_hash_hex), context)
        return jsonify(signature=signature.hex())
    except Exception as e:  # noqa: BLE001
        return jsonify(error=f"frost signing failed: {e}"), 502


@app.route("/health")
def health():
    try:
        return jsonify(ok=True, group=_denom_for(""))
    except Exception as e:  # noqa: BLE001
        return jsonify(ok=False, error=str(e)), 503


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=PORT)
