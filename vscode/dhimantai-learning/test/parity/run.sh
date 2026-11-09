#!/usr/bin/env bash
# Local runner ↔ sandbox parity across all course languages, inside the sandbox images.
# Needs: podman (or docker), images dhimantai-project-<lang>:v1 built from agent/course_projects/runtime,
# and a Linux Node build in .parity/node matching the container architecture.
#   npm run compile && bash test/parity/run.sh [language ...]      (PARITY_SLOW=1 adds the 45 s timeout case)
set -uo pipefail
cd "$(dirname "$0")/../.."
engine=$(command -v podman || command -v docker)
languages=("${@:-python javascript typescript c java go rust}")
read -r -a languages <<< "${languages[*]}"
report=.parity/report.jsonl
: > "$report"
status=0
for language in "${languages[@]}"; do
  image="dhimantai-project-$([[ $language == typescript ]] && echo javascript || echo "$language"):v1"
  if ! "$engine" image exists "$image" 2>/dev/null && ! "$engine" image inspect "$image" >/dev/null 2>&1; then
    echo "SKIP $language: $image not built"; status=1; continue
  fi
  # Same isolation as the worker: no network, unprivileged user, writable /tmp only.
  if ! "$engine" run --rm --network=none --user 1000:1000 --read-only --tmpfs /tmp:exec -e HOME=/tmp -e PARITY_SLOW="${PARITY_SLOW:-0}" \
      -v "$PWD:/ext:ro" -v "$PWD/.parity/node:/opt/node:ro" --entrypoint /opt/node/bin/node \
      "$image" /ext/out/test/parity/parity.js "$language" >> "$report"; then
    echo "ERROR $language: harness failed"; status=1
  fi
done
node -e '
const rows = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).flatMap(l => JSON.parse(l));
for (const r of rows) {
  const failed = Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k);
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.language.padEnd(10)} ${r.case.padEnd(14)} ${r.local.status}/${r.local.exit_code} line ${r.local.line}` + (failed.length ? `  ✗ ${failed.join(", ")}\n      sandbox ${JSON.stringify(r.sandbox)}\n      local   ${JSON.stringify(r.local)}` : ""));
}
const bad = rows.filter(r => !r.ok).length;
console.log(`\n${rows.length - bad}/${rows.length} cases match the sandbox`);
process.exit(bad ? 1 : 0);
' "$report" || status=1
exit $status
