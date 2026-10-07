# pi-better-compaction

[English](README.md) | 中文

一个 [pi](https://github.com/nicepkg/pi) 扩展，通过三条协同策略提升上下文压缩效果：

1. **OpenAI Responses 系列 API** 使用提供商原生压缩端点，保留纯文本摘要无法留存的不透明上下文。
2. **Anthropic Messages API** 使用 Anthropic 服务端按需压缩（beta `compact-2026-09-04`），并回放带签名的压缩块。
3. **其他所有 API**（Gemini 等）可用一个**独立的低成本模型**执行 pi 内置压缩，避免在主模型上消耗额度。

所有环节都安全降级——任何步骤无法执行时，pi 的默认压缩自动接管。

## 安装

```bash
# 从 npm 安装（推荐）
pi install npm:@lll9p/pi-better-compaction

# 临时试用，不安装
pi -e npm:@lll9p/pi-better-compaction

# 从源码安装
git clone https://github.com/lll9p/pi-better-compaction.git
cd pi-better-compaction && pi install .
```

安装后执行 `/reload` 生效。

## 要求

- **pi** ≥ 0.84.3（`@earendil-works/pi-coding-agent >= 0.84.3`）

## 配置

配置文件路径：

```
~/.pi/agent/extensions/pi-better-compaction/config.json
```

文件不存在时使用默认值。扩展不会自动创建此文件。

### 默认配置

```jsonc
{
  "enabled": true,
  "compactionVersion": "v2",
  "compactionModel": null,
  "compactionThinkingLevel": "off",
  "responsesCompactApis": ["openai-responses", "openai-codex-responses"],
  "allowCompactionContinuityBreak": false,

  // 调试与日志
  "notifyOnLoad": false,
  "debug": false,
  "logProviderPayloads": false,
  "logCompactResponses": false,
  "redactSensitiveData": true,
  "artifactRoot": "~/.pi/agent/artifacts/pi-better-compaction"
}
```

### 配置项说明

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | `boolean` | `true` | 总开关。设为 `false` 完全禁用扩展。 |
| `compactionVersion` | `"v1" \| "v2"` | `"v2"` | Responses 系列 API 的压缩协议。**V2**（流式，加密 blob）是 OpenAI 当前默认协议；**V1** 使用旧版 `/responses/compact` 端点。 |
| `compactionModel` | `string \| null` | `null` | 回退压缩使用的模型（用于非 Responses API，或原生压缩失败时）。格式：`"provider/model-id"`，如 `"openai/gpt-5.1-mini"`。`null` = 由 pi 使用当前对话模型。 |
| `compactionThinkingLevel` | `string` | `"off"` | 回退压缩模型的思考级别。可选：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。 |
| `responsesCompactApis` | `string[]` | `["openai-responses", "openai-codex-responses"]` | 启用原生压缩的 Responses API 列表。只能缩小内置集合，不能添加新值。 |
| `allowCompactionContinuityBreak` | `boolean` | `false` | 当会话最近一次压缩不是本扩展创建的时，是否允许重新开始原生压缩。会在该边界处牺牲不透明窗口的连续性。 |
| `notifyOnLoad` | `boolean` | `false` | 扩展加载时在 TUI 中显示通知。 |
| `debug` | `boolean` | `false` | 写入生命周期和压缩事件的调试文件。 |
| `logProviderPayloads` | `boolean` | `false` | 写入 `before_provider_request` 请求体调试文件。 |
| `logCompactResponses` | `boolean` | `false` | 写入压缩端点的请求/响应调试文件。 |
| `redactSensitiveData` | `boolean` | `true` | 在调试文件中脱敏。 |
| `artifactRoot` | `string` | `"~/.pi/agent/artifacts/pi-better-compaction"` | 调试文件根目录。支持 `~/` 和相对路径（相对于配置文件目录解析）。 |

### 示例：使用低成本模型做回退压缩

```json
{
  "compactionModel": "openai/gpt-5.1-mini",
  "compactionThinkingLevel": "off"
}
```

### 示例：强制使用 V1 压缩协议

```json
{
  "compactionVersion": "v1"
}
```

## 工作原理

pi 触发压缩时（`session_before_compact`）：

1. **检测到 Responses API** → 执行原生压缩（根据配置选择 V2 或 V1）：
   - **V2**：向 `/responses` 端点发送携带 `compaction_trigger` 的流式请求，API 返回加密压缩 blob。保留的用户/开发者消息 + blob 组成压缩后的上下文。
   - **V1**：POST 到 `/responses/compact`，接收不透明的压缩窗口。
   - 成功后，压缩窗口被存储，后续请求通过 `before_provider_request` 钩子回放。

2. **Anthropic Messages API**（`anthropic-messages`）→ 使用 Pi 序列化的请求，将本次要丢弃的消息发送到服务端，携带 `compaction: {type: "summarize"}` 和 `compact-2026-09-04` beta：
   - 响应中的带签名 `compaction` 块存入压缩条目的 `details`，按提供商、API、模型和基础 URL 匹配。块中的文本同时作为 Pi 的摘要。
   - 后续使用同一提供商和模型时，用原始压缩块替换 Pi 的摘要消息；Pi 保留的消息不变。
   - 切换提供商或模型后改用文本摘要，不向其他提供商或模型发送压缩块。
   - 如果提供商对携带压缩块的请求返回 HTTP 400，该块会在当前会话中停用，后续使用文本摘要。
   - 某些网关（如使用 Claude 订阅的 CLIProxyAPI）会向启用 thinking 的请求注入 `context_management`，而 Anthropic 不允许它与 `compaction` 同时出现。仅遇到这一特定的 HTTP 400 时，扩展会移除请求的 thinking 参数重试一次。历史中的 thinking 块保留，后续对话的思考级别不变。
   - 压缩阈值仍由 Pi 的 `compaction` 设置控制。

3. **非原生 API，或原生压缩失败** → 若配置了 `compactionModel` 且与当前模型不同，使用该模型执行 pi 内置的 `compact()` 方法。

4. **未配置回退模型** → pi 的默认压缩照常执行，如同扩展未安装。

判断依据是 API 类型而非提供商——任何使用 Responses API 协议的 OpenAI 兼容代理都会触发原生压缩尝试。如果端点不支持，请求失败后自动回退。

## 调试

启用调试文件输出：

```json
{
  "debug": true,
  "logCompactResponses": true
}
```

然后 `/reload`，执行 `/compact`，发送一条后续消息，检查：

```
<artifactRoot>/sessions/<session-id>/
├── provider-requests/
├── compact-responses/
├── compaction-events/
└── lifecycle/
```

## 测试

```bash
bun test
bun test --coverage --coverage-reporter=text --coverage-reporter=lcov
```

## 许可证

MIT
