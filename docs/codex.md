# 本地 Codex 任务桥

本模块使用本机 `codex app-server`，通过 stdio JSONL 连接。它不监听 TCP 或 WebSocket，也不读取原有 Codex 登录文件。每次任务从应用自己的 OAuth 服务取当前 access token，创建新进程和独立 HOME / CODEX_HOME。

启动前仅用父应用的 PATH 定位 Codex 的绝对可执行路径（含用户的 `.local/bin` 安装），随后使用独立环境启动；不通过 shell 查找，也不把父 PATH 或其他环境变量复制给子进程。`initialize.clientInfo.name` 固定为 `Whisper`，与 OAuth 注册的 `agent_name_hint` 一致。

## 首版可用范围

本桥原计划用于专用任务目录内的只读检查，当前仍禁用。应用已通过独立的[受限文件工具](file-agent.md)实现真实本地操作，不能将本桥状态与该功能混同。浏览器不能提交 cwd、执行程序、环境变量或权限配置。开始任务前必须显示任务内容、模型、目录和权限，并取得用户本次确认；服务端再传 `confirmed: true`。此布尔值是服务端内部约定，不能替代 HTTP 层的会话认证、CSRF 防护和明确的 UI 确认。

**本机 Codex CLI 0.147.0 与本桥选择的RPC形态不兼容。** 它生成的 `TurnStartParams` schema 只有 `readOnly.networkAccess`，没有 `readOnly.access` 的限定读取目录设置。桥在读取 OAuth token 之前返回 `CODEX_READ_ISOLATION_UNAVAILABLE`；该错误码描述桥的前置条件，不能理解为CLI不存在任何等效隔离能力。官方另有命名权限配置，已单独研究并以自建fixture测试，见[接口与能力的区分](cli-compatibility.md)。接入app-server后仍须验收；不能保证单纯升级会解决。单纯设置cwd或read-only并不能保证只读取该目录，因此不会降级到不受限读取。

支持新版 schema 后，桥会发送限定 `readableRoots` 的只读策略，同时启用必要的平台默认读取路径。CLI 的操作系统沙箱仍是执行权限的实现者；此版本尚未通过真实模型任务验证其端到端执行能力。

## 集成接口

```js
import { CodexBridge } from './server/codex.mjs';

const bridge = new CodexBridge({
  dataDir: '/absolute/app-private/codex-runtime',
  workspace: '/absolute/app-private/task-workspace',
  getAccessToken: () => oauth.getAccessToken(), // Promise<string>，仅应用自身的新授权
  onEvent: (event) => publishToAuthenticatedLocalClient(event),
});

// 只在用户确认此次任务后调用。
await bridge.start({
  taskId: 'task_123',
  prompt: '总结任务目录中的说明文件',
  model: selectedModel,
  confirmed: true,
});
bridge.approve({ id: approvalId, decision: 'allow-once' }); // 或 'deny'
await bridge.cancel();
bridge.status();
await bridge.close();
```

两个目录必须是服务端配置的绝对路径且互不包含。任务目录不允许符号链接。`taskId` 接受 1–128 个字母、数字、下划线或连字符；prompt 最长 32,000 字符。start 不接受其他字段。模型必须明确指定；此桥不把目录列表视为模型授权证明。

每次任务是新的临时 thread；首版没有跨进程恢复或持续运行任务。每次重新开始都会重新向 OAuth 服务取 token。运行中令牌过期会导致任务失败，用户可在应用刷新授权后重新确认任务。未实现自动重试已执行的动作。

`start()` 在创建 turn 后返回状态，后续进展通过 `onEvent` 发送。仅 `turn.status=completed` 记为成功；失败或中断不会显示成功。默认任务时限 10 分钟，单条 RPC 时限 15 秒。取消会发送 `turn/interrupt`，然后 SIGTERM 终止独立进程组，宽限 1 秒后 SIGKILL。

## 事件

事件共有 `type`、`taskId`、ISO `timestamp`。接收方应按 taskId 路由，不能假定迟到的取消事件属于最新任务。

| type | 额外字段 |
| --- | --- |
| `state` | `status`: starting / running / awaiting-approval / completed / failed / cancelled |
| `delta` | `text`, `itemId` |
| `progress` | `method`, `message`, `itemId`；计划更新可有 `data: [{step,status}]` |
| `approval` | `id`, `kind: commandExecution`, `command`, `cwd`, `reason`, `decisions` |
| `approval-resolved` | `id`, `decision` |
| `blocked` | `method`, `reason` |
| `error` | `code`, `message` |
| `completed` | `status`, `threadId`, `turnId` |

`status()` 返回当前状态、taskId/threadId/turnId、固定 workspace、sandbox、networkAccess、待处理 approvals 和 blockedReason。浏览器只接收挑选后的事件；stderr 不转发，已知 token 与敏感字段脱敏。消息 delta 和命令输出使用跨事件过滤：普通文本即时发送，可能属于 token 前缀的尾部暂存；完整 token 替换为 `[REDACTED]`。item 完成、任务结束、错误或取消时，未完的候选片段也替换为 `[REDACTED]`，绝不按明文 flush。这可能隐藏恰好与 token 前缀相同的少量正常末尾文本。

## 权限和凭据约束

- 配置固定指向 `https://api.openai.com/v1`，`env_key=ACCESS_TOKEN`、`requires_openai_auth=false`、`supports_websockets=false`。令牌不放进参数、不写到桥生成的配置文件，且不进入工具 shell 的继承环境。
- app-server 子进程只有明确白名单环境。HOME、CODEX_HOME、TMPDIR、XDG_CONFIG_HOME 是本次隔离目录；不继承代理、其他 API key、SSH agent 或原有 Codex 环境。CLI 使用 ephemeral 凭据存储。
- 使用 `untrusted` 审批（由本机 schema 决定兼容拼写）、用户审批方、read-only 沙箱、工具网络禁用。关闭 web search、多 agent、Code Mode、shell snapshot；MCP 配置为空。
- command approval 可能意味着绕过沙箱，所以首版只允许明确审批固定的 `pwd`、`ls`、`ls -l`、`ls -a`、`ls -la`、`ls -al`（可带 `/bin/`），且 cwd 必须精确匹配任务目录。其余命令、文件写入、网络访问、权限扩展和未知 RPC 请求全部拒绝。没有会话永久批准功能。
- 模型推理本身需要联网到官方服务；“网络禁用”指任务工具的网络权限，并不声称阻止官方推理连接。
- 运行目录可能保存 CLI 本地诊断/状态文件，应留在应用私有目录。此模块不清理用户任务资料。

## 已验证与尚未验证

执行 `node --test test/codex.test.mjs`。测试全部使用假子进程、假令牌和协议 fixture，覆盖握手顺序、权限配置、旧 schema 阻断、环境隔离、审批拒绝、单次审批、取消、强制终止、超时、错误消息和取消后重启竞态。

2026-10-03 本机 smoke check：Codex 0.147.0 在独立 HOME / CODEX_HOME 中使用官方 provider 参数，`initialize` 成功；完整 start 的前置 schema 检查按预期阻断，token 提供器调用次数为 0。未调用真实 OAuth、未创建持久授权、未发起模型推理、未执行模型生成命令。

真实授权后的模型权限、任务执行沙箱、续期后的任务重试仍需后续用户授权验收。没有远程电脑连接、Android 控制、native computer use 或 hosted connector 支持。

## 官方依据

- [ChatGPT plan usage 的 Codex app-server 配置](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)：官方 provider 参数、初始化、令牌更新与回合结果。
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)：HTTP/SSE 和 `store:false` / `stream:true` 由 app-server 设置；本地工具与 hosted 工具能力不同。
- [Codex App Server RPC 文档](https://learn.chatgpt.com/docs/app-server)：stdio、thread/turn、审批、只读目录限制和中断协议。实现同时核对本机生成的 schema，遇到版本不兼容时停止。
