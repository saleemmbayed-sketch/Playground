#!/usr/bin/env bash
# One-shot verification that the live TED API still answers with the shape we expect.
# Run this from a machine with internet access BEFORE going live, and monthly after.
#   ./scripts/verify-live.sh
set -euo pipefail

echo "== 1. Raw TED API reachability =="
curl -sS -X POST https://api.ted.europa.eu/v3/notices/search \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -d '{
        "query": "classification-cpv IN (72*) AND publication-date >= today(-3)",
        "fields": ["publication-number","notice-title","buyer-name","buyer-country","classification-cpv","publication-date","deadline-receipt-tender-date-lot","total-value"],
        "page": 1, "limit": 3, "scope": "ACTIVE"
      }' | head -c 2000
echo -e "\n"

echo "== 2. End-to-end through the app's own client =="
TED_OFFLINE=false npx tsx src/cli.ts check-ted --days 3

echo -e "\n== 3. Full ingest + dry-run digest =="
TED_OFFLINE=false npx tsx src/cli.ts ingest --days 3
npx tsx src/cli.ts stats

echo -e "\nIf step 2 printed notices, the machine is wired to live data."
