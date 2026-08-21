#!/usr/bin/env python3
"""HoldFun FROST cosigner — VELA's blake2b-FROST cosigner with HoldFun's policy.

Reuses ~/verifyXNOPrivacyProtocol's frost_bridge (Rust signing) and the same
commit -> sign HTTP protocol, but replaces VELA's ZK-withdrawal verification
with HoldFun's cosigner-as-verifier: before releasing a signature share it
POSTs the payout context to the LOCAL HoldFun verifier (server/server.ts
/frost/verify-payout over loopback) and signs only on a 200 approval.

Deploy per box as user `holdfun-cosigner`:
  FROST_DATA_DIR=/opt/holdfun/data/frost \
  COSIGNER_PORT=8083 \
  COSIGNER_API_KEY=$(cat /opt/holdfun/.cosigner_api_key) \
  HOLDFUN_VERIFY_URL=http://127.0.0.1:8080/frost/verify-payout \
  HOLDFUN_VERIFY_KEY=$(cat /opt/holdfun/.verify_key) \
  VELA_SRC=/root/verifyXNOPrivacyProtocol/src \
  python3 holdfun_cosigner.py

The share never leaves the box; the full key never exists (dealerless DKG).
"""
import json
import os
import sys
import time

import requests
from flask import Flask, jsonify, request

sys.path.insert(0, os.environ.get("VELA_SRC", "/root/verifyXNOPrivacyProtocol/src"))
import frost_bridge  # noqa: E402  (VELA's Rust FFI bridge — reused verbatim)

DATA_DIR = os.environ["FROST_DATA_DIR"]
PORT = int(os.environ.get("COSIGNER_PORT", "8083"))
API_KEY = os.environ.get("COSIGNER_API_KEY", "")
VERIFY_URL = os.environ["HOLDFUN_VERIFY_URL"]
VERIFY_KEY = os.environ.get("HOLDFUN_VERIFY_KEY", "")

app = Flask(__name__)
_nonces = {}  # request_id -> (nonces_path, created_at)


def _key_package(denom: str) -> str:
    return os.path.join(DATA_DIR, denom, "key_package")


def _authed() -> bool:
    return not API_KEY or request.headers.get("X-Holdfun-Key") == API_KEY


@app.route("/frost/commit", methods=["POST"])
def commit():
    if not _authed():
        return jsonify(error="unauthorized"), 403
    data = request.get_json(force=True)
    rid, denom = str(data["request_id"]), str(data["denomination"])
    nonces_path = os.path.join(DATA_DIR, "nonces", f"{rid}.nonces")
    os.makedirs(os.path.dirname(nonces_path), exist_ok=True)
    commitments = frost_bridge.commit(_key_package(denom), nonces_path)
    _nonces[rid] = (nonces_path, time.time())
    return jsonify(commitments=commitments)


@app.route("/frost/sign", methods=["POST"])
def sign():
    if not _authed():
        return jsonify(error="unauthorized"), 403
    data = request.get_json(force=True)
    rid, denom = str(data["request_id"]), str(data["denomination"])
    ctx = data.get("context") or {}

    # HoldFun policy: only sign a payout that is actually owed, per the local
    # verifier's independent settlement replay. Fail closed on any non-200.
    if ctx.get("type") != "holdfun-payout":
        return jsonify(error="unexpected context type"), 400
    try:
        vr = requests.post(
            VERIFY_URL,
            json={"tokenId": ctx.get("tokenId"), "to": ctx.get("to"), "amountRaw": ctx.get("amountRaw")},
            headers={"X-Verify-Key": VERIFY_KEY},
            timeout=120,
        )
    except Exception as e:  # noqa: BLE001
        return jsonify(error=f"verifier unreachable: {e}"), 502
    if vr.status_code != 200:
        return jsonify(error=f"payout rejected by verifier: {vr.text[:200]}"), 409

    entry = _nonces.pop(rid, None)
    if not entry:
        return jsonify(error="unknown or expired request_id"), 400
    nonces_path, _ = entry
    try:
        share = frost_bridge.sign(_key_package(denom), nonces_path, data["signing_package"])
    finally:
        try:
            os.unlink(nonces_path)
        except OSError:
            pass
    return jsonify(signature_share=share)


if __name__ == "__main__":
    app.run(host=os.environ.get("COSIGNER_BIND", "0.0.0.0"), port=PORT)
