#!/bin/sh
# One-shot try-out: boot the console, run tests, then replay happy + not-found + dispute.
set -eu

npm run console &
CONSOLE_PID=$!
trap 'kill "$CONSOLE_PID" 2>/dev/null || true' EXIT

port="${RELAY_CONSOLE_PORT:-3000}"
i=0
while [ "$i" -lt 50 ]; do
  if node --input-type=module -e "fetch('http://127.0.0.1:${port}').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"; then
    break
  fi
  i=$((i + 1))
  sleep 0.2
done

if [ "$i" -eq 50 ]; then
  echo "console did not become ready on :${port}" >&2
  exit 1
fi

npm test

npm run verify

npm run replay -- --capability capabilities/lookup-member-savings.json --input memberId=12345
npm run replay -- --capability capabilities/lookup-member-savings.json --input memberId=99999
npm run replay -- --capability capabilities/verify-and-file-dispute.json \
  --input memberId=12345 --input disputeId=DSP-1001 --input reason=Unauthorized \
  --approve-risky
