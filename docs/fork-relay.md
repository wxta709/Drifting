# Fork 差异：中转站 Provider（relay）

本 fork 相对上游 `chihumyum/Drifting`（基线 0.1.0-alpha.11，main @ 2e643c2a5）的唯一功能性差异是新增了一个 BYOK provider `relay`：作者自有的 OpenAI 兼容中转站（自定义 baseURL + Key），用于 General Agent 的文本功能。

## 行为契约

- 协议：OpenAI Chat Completions（`{baseURL}/chat/completions`），支持函数工具与流式；复用上游 `OpenAICompatibleCompletionDriver`（reasoningMode 'disabled' 路径）。
- **传输原生化**：中转站网关普遍不响应 CORS 预检（OPTIONS 直接 401、无 `Access-Control-Allow-*`），WebView 的带 `Authorization` 请求会被拦截。因此 relay 的全部 HTTP（聊天流式 + 模型列表）走原生 Rust host（`src-tauri/src/relay_api.rs`，仿 `openai_responses.rs`）：渲染层只传 baseURL 与受限 JSON body，`byok.relay` 密钥由原生侧注入、不进 IPC；https（回环允许 http）、拒绝重定向、请求/错误/响应字节与时长受限、可按请求 id 取消。
- 不发送 `reasoning_effort`（`omitReasoningEffort`，防严格后端 400）；无 web_search、无图片输入、思考档固定为关。
- 模型目录：原生 `GET {baseURL}/models`（Bearer key，20s 超时，≤500 条，兼容 `{data:[{id}]}` 与 `{models:[...]}`）+ 手动输入兜底；bundled 兜底列表为空（有意为之）；设置行提供「重新获取模型」按钮（强制刷新并显示数量）。
- 凭据：Key 存系统钥匙串 `byok.relay`；baseURL 是非机密配置，存 localStorage `fork.relay-endpoint.baseURL`。
- 失败语义与上游一致：事务性缓冲 + 有限重试 + fail closed，坏响应显式报错（原生错误码 `RELAY_*`），不静默换路由。

## 与上游安全边界的取舍（本机自用，有意为之）

1. **CSP `connect-src` 加入 `https:`**（`src-tauri/tauri.conf.json`）：relay 的 HTTP 已改走原生传输、不再依赖 CSP；保留 `https:` 是给未来渲染层直连留口（也覆盖本地部署网关之外的小工具），属放宽项，接受此取舍。
2. **manifest 措辞**：`drifting-agent-capability-manifest.ts` 的 `apiKeyModelDiscovery.catalog` 注明 relay 列表由原生 host 读取（上游三家的原生端点行为不变）。
3. **relay 仅原生 App 可用**：CORS 壁垒决定了它不能走纯 Web 渲染层；这与上游 OpenAI Responses 路由"仅原生"的定位一致。

## 文件清单

| 文件 | 改动 |
| --- | --- |
| `src/renderer/lib/agent/protocol.ts` | `AgentProviderChoice` += `'relay'` |
| `src/renderer/lib/byok-keychain.ts` | `BYOKProvider` += `'relay'`（键 `byok.relay`） |
| `src/renderer/lib/agent/runtime/agent-provider-contract.ts` | relay 目录条目（空 bundled 模型）、宽松模型 ID 正则（允许 `@` `/`）、`NO_REASONING` profile、`models[0]` 空目录守卫 |
| `src/renderer/lib/ai/client/providers/openai-runtime.ts` | `omitReasoningEffort` 配置 |
| `src/renderer/lib/ai/client/build-default-client.ts` | relay 直连/Agent 客户端工厂 |
| `src/renderer/lib/ai/relay-endpoint.ts`（新） | baseURL 读写与规范化 |
| `src/renderer/lib/ai/credentials/env.ts` | dev 用 `VITE_RELAY_API_KEY` |
| `src/renderer/lib/agent/byok-model-catalog.ts` | relay 的 `/models` 渲染层拉取分支 |
| `src/renderer/lib/ai/test-provider-connection.ts` | relay 测试连接（URL/模型前置校验，不走 OpenAI 原生固定源路径） |
| `src/renderer/features/settings/panels/IntelligenceSettingsPanels.tsx` | `RelayProviderRow`（URL + Key + 测试 + 断开） |
| `src/renderer/features/agent/AgentComposerConfig.tsx` | 模型菜单的手输模型入口 |
| `src/renderer/features/agent/onboarding/AgentOnboarding.tsx` + `agent-onboarding.ts` | 首次引导 relay 行（URL+Key）；`AGENT_PROVIDER_KEY_PAGES.relay = ''`（无取键页） |
| `src/renderer/lib/agent/runtime/eval/provider-extension.live.eval.ts` | relay 无 env canary |
| `src/renderer/lib/agent/runtime/drifting-agent-capability-manifest.ts` (+test) | manifest 如实描述 relay 发现方式 |
| `src-tauri/src/relay_api.rs`（新） | 原生 relay 传输：`relay_models_list` / `relay_chat_stream` / `relay_chat_cancel`；https(+回环 http)、无重定向、字节/时长上限、错误脱敏、可取消；5 个单元测试 |
| `src-tauri/src/lib.rs` | 注册 `relay_api` 模块、状态与三条命令 |
| `src/renderer/lib/ai/relay-native-fetch.ts`（新） | 给 OpenAI SDK 用的 fetch 适配器（转原生 channel 流） |
| `src/renderer/platform/{contracts,types,tauri}.ts` | `relayApi` 平台接口：`listModels` / `request`（channel 流 → `Response`） |
| `src-tauri/tauri.conf.json` | `connect-src` += `https:`（csp 与 devCsp；原生传输后已非必需，保留） |
| `src/renderer/locales/*.json`（9 语言） | `settings.relayProvider.*`、`settings.models.providers.relay`、`agentPanel.config.relayModel*` |
| 测试 | `agent-provider-contract.test.ts`、`byok-model-catalog.test.ts`、`drifting-agent-capability-manifest.test.ts` 断言同步；新增 `src/renderer/lib/agent/relay-provider.test.ts` |
| 生成证据 | `docs/qa/interface-locales.json`、`docs/agent-runtime/acceptance/agent-capabilities.*` 再生成 |

## 无 Rust 代码改动

`byok.` 前缀的钥匙串读写、NSIS 安装器、更新器（见下）均不需要改 Rust。

## 更新器与 Hosted

本地构建**不注入** `DRIFTING_UPDATER_PUBLIC_KEY` → `app_update.rs` 的更新器插件不激活（`option_env!`），应用正常打开、仅更新检查报告未配置——fork 不会被官方 release 自动覆盖。`DRIFTING_HOSTED_ORIGIN` 同样不注入，Hosted 同步功能不可用（本地功能不受影响）。

## 替换安装

标识符 `cc.drifting.client` 与 productName `Drifting` 保持不变：NSIS（per-user）原地覆盖安装，`%LOCALAPPDATA%\cc.drifting.client\`（SQLite 库、资产、EBWebView 偏好）与凭据管理器中的 `byok.*` 键全部保留。
