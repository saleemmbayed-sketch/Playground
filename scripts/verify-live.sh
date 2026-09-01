#!/usr/bin/env bash
# Verifies the live TED API and the whole stack from a machine WITH internet access.
# Run once before launch, then monthly.
set -euo pipefail

echo "== 1. Raw TED API reachability (POST is required; GET returns an error) =="
curl -sS -X POST https://api.ted.europa.eu/v3/notices/search \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -d '{
        "query": "publication-date>='"$(date -u -d '3 days ago' +%Y%m%d 2>/dev/null || date -u -v-3d +%Y%m%d)"' AND (classification-cpv=72* OR classification-cpv=48*) SORT BY publication-date DESC",
        "fields": ["publication-number","notice-title","buyer-name","buyer-country","classification-cpv","publication-date","deadline","total-value","total-value-cur"],
        "page": 1, "limit": 3, "scope": "ACTIVE", "paginationMode": "PAGE_NUMBER"
      }' | head -c 2000
echo -e "\n"

echo "== 2. Which fields does TED accept today? =="
TED_OFFLINE=false npx tsx src/cli.ts probe-fields

echo -e "\n== 3. End-to-end through the app client =="
TED_OFFLINE=false npx tsx src/cli.ts check-ted --days 3

echo -e "\n== 4. Full preflight =="
TED_OFFLINE=false npx tsx src/cli.ts doctor

echo -e "\nIf step 3 printed notices and step 4 shows no blocking issues, you are ready to launch."
