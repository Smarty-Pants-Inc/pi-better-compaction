#!/usr/bin/env bash
# Per-repo smarty-dev#1246 guard: the fleet scan covers private repositories only.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
exec bun "$repo_root/scripts/ci/no-hosted-runners.ts" "${1:-.github/workflows}"
