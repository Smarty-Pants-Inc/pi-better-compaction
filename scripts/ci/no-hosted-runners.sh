#!/usr/bin/env bash
# Per-repo smarty-dev#1246 guard: the fleet scan covers private repositories only.
# The Bun guard allows only matrix expressions and one exact full-label reserved-pool
# route from tristar-root-proof.yml; no other routing expressions are approved.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
exec bun "$repo_root/scripts/ci/no-hosted-runners.ts" "${1:-.github/workflows}"
