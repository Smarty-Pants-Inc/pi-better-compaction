# pi-better-compaction #15 — Astra round 4 repair

Reviewed the complete `.local/verdicts/pbc15-astra.md` against incoming HEAD
`10e7bbdf4df8a4272ed8176a33a75356e03789a8`, on current branch `sync/pi-1.0.0`.
The verdict contains one new P1 and no new P0/P2 findings.

## 1. P1 — installed extension fails at the transform-messages import: FIXED

**Cause.** Initialization reaches `src/serializer.ts`, whose top-level npm-subpath
import was not supplied by Pi 1.0's bundled `VIRTUAL_MODULES`. Development
`node_modules` concealed this. Normal package installation suppresses host peers,
so even fallback/Anthropic users could not initialize the extension.

**Fix (files and lines).**

- `src/serializer.ts:4,29–38,186–190`: import the pure helper locally; retain the
  existing normalization call and capability filtering.
- `src/transform-messages.ts:1–264`: reuse the published Pi AI **1.0.0** helper
  from its source map, with MIT attribution. The algorithm is byte-for-byte
  unchanged; only its **type-only** import uses the public Pi AI root.
  Tool/system-update closure, orphan synthesis, images and signatures therefore
  retain the upstream behavior. No second private Pi runtime or host dependency
  was added, and the advertised peer minimum remains `>=0.84.3`.
- `package.json:49`: include the helper in the distributed files.
- `test/helpers/pi-installed-load.ts:9–61` and `test/pi-installed-load.test.ts:5–12`:
  regression copies the actual package's distributed files and the published
  bundled CLI into a `mktemp -d` root. The CLI has only its external `jiti`
  dependency, **no physical Pi host peers**; the extension has no `node_modules`.
  Run with isolated HOME/cwd, allowlisted credential-free environment, offline
  RPC/no discovery/no tools, and input `get_state`. Both root-import success and
  unsupported-subpath failure are controls, alongside actual package loading.
- `test/helpers/pi-cli-boundary.ts:14–15,130–135`: existing real PTY MCP/two-native-
  compaction/resume scenarios now default to isolated distributed-package copies,
  rather than the checkout's development dependency tree.
- `README.md:152–158,165–184`: document helper provenance and installed-loader
  regression boundaries.

**Genuine RED, before production edits.**

```sh
bun test test/pi-installed-load.test.ts
```

Exit **1**: one failed regression. Published bundled CLI version **1.0.0**;
root-only control exit **0**, successful RPC `get_state`; subpath-only control
exit **1**; **actual installed package exit 1** with:

```text
Failed to load extension: Cannot find module '@earendil-works/pi-ai/api/transform-messages'
Require stack:
- <test-owned root>/extension/src/serializer.ts
```

Kept log: `$TASK_OUT/installed-load-red.log`. An initial harness-only attempt lacked
`jiti` and was not counted as finding evidence; the recorded RED above includes
that legitimate external CLI dependency and a passing root control.

**GREEN, same actual bundled CLI/package path after the fix.**

```sh
bun test test/pi-installed-load.test.ts
bun test test/pi-installed-load.test.ts test/pi-cli-boundary.test.ts
node "$TASK_OUT/verify-contract.mjs"
```

All commands exit **0**. Load regression: **1 pass / 0 fail**. Actual installed
extension and root control both exit **0**, with `get_state` `success:true` and
empty stderr. Unsupported-subpath control still exits **1**, demonstrating the
fixture has not regained an accidental host peer installation. Combined CLI
check: **4 pass / 0 fail**; three PTY scenarios validate MCP changes, two V2
compactions and resumed opaque-checkpoint replay, including pending-tool closure.
Every real CLI instance exits **0** (`[0,0]`, `[0,0]`, `[0,0,0]`). Contract probe
confirms unchanged upstream algorithm, helper publication, all three exact 1.0.0
dev pins, unchanged peer ranges, public serializer/replay helpers, entry point,
and `before_provider_request` registration.

Evidence: `$TASK_OUT/installed-load-green.log`, `$TASK_OUT/installed-load-green.json`,
`$TASK_OUT/cli-green.log`, `$TASK_OUT/contract-check.log`, and
`$TASK_OUT/cli-evidence/{true,absent,true-pending-tool}/` (summaries, commands,
PTY logs, branch snapshots and synthetic request bodies).

## Other verdict items

- **Retained pre-checkpoint system filtering:** already fixed at incoming HEAD;
  unchanged and GREEN in real-provider and installed-package CLI tests.
- **False/absent mid-conversation capability and fresh prompt:** already fixed;
  unchanged and GREEN. Full suite covers true/false/absent flags on Responses and
  Codex, retaining the provider-authored prompt rather than persisted stale text.
- **Duplicate/misordered tool outputs:** already fixed by the upstream transform;
  the exact same algorithm is now shipped locally. Real-provider tests cover
  updates before results, between results, and with a trailing orphan; they check
  exact actual/synthetic outputs, ordering, framing, immutability and strict hook
  replay. Full suite runs **72 real-provider cases**, with network calls forbidden.
  The real installed-package pending-tool PTY scenario also passes. These earlier
  items already passed before this repair; no new RED is invented for them.
- **Model-backed canary:** **NOT RUN and NOT WAIVED**. The verdict's owner-posted
  pre-promotion gate remains mandatory. This task forbids credentials and external
  coordination, so local synthetic HTTP/PTY success is **not** model-backed
  acceptance. Lead must run the required canary before coordinated promotion.
  Source: https://github.com/Smarty-Pants-Inc/pi-better-compaction/pull/15#issuecomment-5965652860

## Full repository check (final)

```sh
CI=1 PI_CLI_EVIDENCE_ROOT="$TASK_OUT/cli-evidence" \
  PI_INSTALLED_LOAD_EVIDENCE="$TASK_OUT/installed-load-green.json" bun run check
```

Exit **0**: `tsc --noEmit` passes; **225 pass, 1 skip, 0 fail**, 593 expectations,
226 tests across 15 files. The sole skip is the existing working-model smoke under
`CI=1`, required here to respect the credential-free scope. No other test skipped.
Node **v24.19.0**, Bun **1.4.0**. Logs: `$TASK_OUT/full-check.log` and
`$TASK_OUT/full-check.exit`. `git diff --check` also exits **0**.

All test-owned temporary roots are removed in `finally`; all started CLI/PTY
processes and listeners were awaited and stopped. No push, GitHub action,
credential access, agent spawning, rebase, force, stash, or git identity config.
Kept artifacts live under `/srv/scratch/paul/tasks/direct/fr-pbc15r4/artifacts`.
The report is also copied to `$TASK_OUT/round-answer.md`; the lead's transport
artifacts are `$TASK_OUT/repair.patch` and `$TASK_OUT/repair-head.txt`.
