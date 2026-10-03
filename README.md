# pi-better-compaction

English | [中文](README.zh-CN.md)

A [pi](https://github.com/nicepkg/pi) extension that upgrades context compaction with two coordinated strategies:

1. **OpenAI Responses APIs**, including supported GitHub Copilot models, use the provider's native compaction endpoint, preserving opaque context that plain text summaries lose.
2. **Anthropic Messages API** uses Anthropic's on-demand server-side compaction (beta `compact-2026-09-04`) and replays the signed compaction block.
3. **All other APIs** (Gemini, etc.) can run pi's built-in compaction with a **dedicated cheaper/faster model**, so summarization doesn't consume quota on your primary model.

Everything fails open — if any step cannot proceed, pi's default compaction takes over.

## Install

```bash
# From npm (recommended)
pi install npm:@lll9p/pi-better-compaction

# Try without installing
pi -e npm:@lll9p/pi-better-compaction

# From source
git clone https://github.com/lll9p/pi-better-compaction.git
cd pi-better-compaction && pi install .
```

After installation, run `/reload`.

## Requirements

- **pi** ≥ 0.84.3 (`@earendil-works/pi-coding-agent >= 0.84.3`)

## Configuration

Config file location:

```
~/.pi/agent/extensions/pi-better-compaction/config.json
```

If the file doesn't exist, all defaults apply. The extension never creates this file.

### Defaults

```jsonc
{
  "enabled": true,
  "compactionVersion": "v2",
  "compactionModel": null,
  "compactionThinkingLevel": "off",
  "responsesCompactApis": ["openai-responses", "openai-codex-responses"],
  "allowCompactionContinuityBreak": false,

  // Debug & logging
  "notifyOnLoad": false,
  "debug": false,
  "logProviderPayloads": false,
  "logCompactResponses": false,
  "redactSensitiveData": true,
  "artifactRoot": "~/.pi/agent/artifacts/pi-better-compaction"
}
```

### Options reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Master switch. Set `false` to disable the extension entirely. |
| `compactionVersion` | `"v1" \| "v2"` | `"v2"` | Protocol for Responses-family APIs. **V2** (streaming, encrypted blob) is the current OpenAI default. **V1** uses the legacy `/responses/compact` endpoint. |
| `compactionModel` | `string \| null` | `null` | Model for fallback compaction (non-Responses APIs, or when native compact fails). Format: `"provider/model-id"`, e.g. `"openai/gpt-5.1-mini"`. `null` = let pi use the current chat model. |
| `compactionThinkingLevel` | `string` | `"off"` | Thinking level for the fallback compaction model. One of: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `responsesCompactApis` | `string[]` | `["openai-responses", "openai-codex-responses"]` | Which Responses APIs use native compaction. Can only narrow the built-in set; unknown entries are ignored with a warning. |
| `allowCompactionContinuityBreak` | `boolean` | `false` | Allow restarting native compaction when the latest session compaction was created by pi's default path (not this extension). Sacrifices opaque-window continuity at that boundary. |
| `notifyOnLoad` | `boolean` | `false` | Show a notification in the TUI when the extension loads. |
| `debug` | `boolean` | `false` | Write lifecycle and compaction-event debug artifacts. |
| `logProviderPayloads` | `boolean` | `false` | Write `before_provider_request` payload artifacts. |
| `logCompactResponses` | `boolean` | `false` | Write compact endpoint request/response artifacts. |
| `redactSensitiveData` | `boolean` | `true` | Redact secrets in debug artifacts. |
| `artifactRoot` | `string` | `"~/.pi/agent/artifacts/pi-better-compaction"` | Root directory for debug artifacts. Supports `~/` and relative paths (resolved against config dir). |

### Example: use a cheap model for fallback compaction

```json
{
  "compactionModel": "openai/gpt-5.1-mini",
  "compactionThinkingLevel": "off"
}
```

### Example: force V1 compaction protocol

```json
{
  "compactionVersion": "v1"
}
```

## How it works

When pi triggers compaction (`session_before_compact`):

1. **Responses API detected** → run native compaction (V2 or V1 per config):
   - **V2**: streams a request with `compaction_trigger` to `/responses`; the API returns an encrypted compaction blob. Retained user/developer messages + blob form the compacted context.
   - **V1**: POSTs to `/responses/compact`; receives an opaque compacted window.
   - On success, the compacted window is stored and replayed on subsequent requests via `before_provider_request`.

2. **Anthropic Messages API** (`anthropic-messages`) → send Pi's own serialized request for the messages Pi would discard, with `compaction: {type: "summarize"}` and the `compact-2026-09-04` beta:
   - The response holds one signed `compaction` block. It is stored in the compaction entry's `details`, keyed by provider, API, model and base URL. Its text is also the entry summary.
   - Later requests for the same provider and model replace Pi's summary message with the block, verbatim, as the first message. Pi's kept messages stay unchanged.
   - After a switch to another provider or model, Pi's summary is sent instead. A block is never sent to a different provider or model.
   - If the provider rejects a request that carries the block with an HTTP 400 that names the `compaction` block (for example, `invalid signature in compaction block` after an account failover), the block is retired for the session. The failed reply is omitted from model context, and Pi resends the turn once with its own summary. Rate limits, 5xx errors and other 400s do not retire the block.
   - The compaction threshold stays in Pi's `compaction` settings.

3. **Not a native API, or native compact failed** → if `compactionModel` is configured and differs from the current model, run pi's built-in `compact()` with that model.

4. **No fallback configured** → pi's default compaction runs as if the extension weren't installed.

Selection is by API type, not provider — any OpenAI-compatible proxy speaking a Responses API gets a native compact attempt. If the endpoint doesn't support it, the request fails and falls through to the configured fallback.

## Debugging

Enable debug artifacts:

```json
{
  "debug": true,
  "logCompactResponses": true
}
```

Then `/reload`, run `/compact`, send a follow-up message, and inspect:

```
<artifactRoot>/sessions/<session-id>/
├── provider-requests/
├── compact-responses/
├── compaction-events/
└── lifecycle/
```

## Pi 1.0 system checkpoints

Pi stores the effective prompt in `CompactionEntry.systemMessage` and excludes
system updates from the retained pre-compaction range. Native replay follows that
same filtering, while keeping strict parity checks on the provider transcript.
Updates after the checkpoint remain in conversation input only when the model's
`compat.supportsMidConvoSystemMessages` is explicitly `true`. With `false` or an
absent flag (the Responses APIs' default), Pi folds updates into its authoritative
prompt/instructions; replay preserves that fresh preamble instead of re-emitting
the folded updates.

Message normalization reuses Pi 1.0's provider transform as a vendored pure helper
(with MIT attribution). Its npm subpath is not supplied by Pi's bundled extension
loader, so the extension ships only that helper, not a second private Pi runtime;
the supported peer range is unchanged. A system update
between an assistant tool call and its results is held until actual (or, for an
orphaned call, synthetic) results have been flushed, including at transcript end.
It must not close a pending call early or create duplicate function-call outputs.

## Tests

```bash
bun run check
bun test --coverage --coverage-reporter=text --coverage-reporter=lcov
bun test test/pi-provider-regression.test.ts test/pi-cli-boundary.test.ts test/pi-installed-load.test.ts
```

The provider regressions capture actual Pi 1.0 Responses and Codex payloads in
isolated subprocesses, without the unit-test converter mock or network requests.
They cover MCP updates before and between actual tool results, and a trailing
update with an orphaned call, checking exact output accounting and strict replay.
The installed-package load regression copies the published Pi 1.0 CLI bundle and
its external `jiti` dependency, without any host-provided peer copies. In offline
RPC mode with an isolated HOME it checks a successful root-import control, a
failing unsupported-subpath control, and successful loading of the actual package.
The Linux CLI boundary tests run the repo-local Pi 1.0 bundle in real PTYs against
isolated package copies without development `node_modules`, with throwaway HOME
directories, built-in MCP, two V2 compactions, and resume. A local
synthetic HTTP endpoint captures request bodies; this proves extension loading
and replay up to the network boundary, **not** model-backed context retention.
The pending-tool CLI scenario seeds a historical call/MCP-update/result sequence
using Pi's native session append APIs only while the CLI is stopped, reusing a
builtin-MCP-authored system patch. It verifies real resumed CLI replay and the
next compact request; it is not proof of a live MCP update racing tool execution.
The separate `test:pi` working-model smoke is skipped under `CI=1`; a coordinated
Pi installation still needs a working-model smoke before release acceptance.

## License

MIT
