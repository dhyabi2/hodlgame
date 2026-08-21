#!/bin/sh
# Community re-pin: anyone can mirror every token image so no single pinning
# account (or its billing) is load-bearing. Requires a local IPFS daemon
# (`ipfs daemon`) or adapt the loop to POST to your pinning service.
#
#   ./repin-images.sh https://<holdfun-host>
set -e
HOST="${1:?usage: repin-images.sh <holdfun base url>}"
curl -s "$HOST/api/state" |
  grep -oE '(ipfs://(ipfs/)?|https?://[^"]+/ipfs/)[A-Za-z0-9]+' |
  grep -oE '[A-Za-z0-9]{40,}' | sort -u |
  while read -r cid; do
    echo "pinning $cid"
    ipfs pin add "$cid" || echo "  failed (will retry next run): $cid"
  done
