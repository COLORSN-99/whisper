# CLI 来源、发布能力与升级建议

核查日期：2026-10-03。没有修改安装、读取身份或调用模型。

## 本机实际使用哪份 CLI

父应用 PATH 中优先发现：

```
<local-path>
  -> ../lib/node_modules/@openai/codex/bin/codex.js
真实路径 <local-path>
包名 @openai/codex，版本 0.147.0
```

另有 `/opt/homebrew/bin/codex`，同样指向该前缀下的 npm `@openai/codex` 0.147.0。这两条已核实路径都是独立 npm 安装，不是指向 Codex.app 的捆绑二进制；不由此推断应用内部没有另一份 CLI。whisper先在父 PATH 中解析绝对路径，然后启动隔离的子进程。

## 旧RPC形态与本桥不匹配，不等于CLI没有隔离能力

GitHub 最新稳定标记为 **0.160.0**，tag `rust-v0.160.0`，发布于2026-10-01，提交前缀 `a956835`。[官方发布页](https://github.com/openai/codex/releases/tag/rust-v0.160.0)

发布 tag 的 [SandboxPolicy.ts](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/schema/typescript/v2/SandboxPolicy.ts)、[JSON schema](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.schemas.json)、[Rust 协议定义](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/protocol/src/protocol.rs) 的 `readOnly` 仍只有类型和网络设置，没有本桥要求的 `access`、`readableRoots` 和 `includePlatformDefaults`。

[最新 App Server 文档](https://developers.openai.com/codex/app-server/) 描述了限定读取字段，但当前已核实发布 tag 与文档不一致。**这些证据仅证明本桥现有RPC参数不兼容**。它们不足以证明CLI缺少等效目录隔离；先前把恢复执行只归于等待字段升级或另建沙箱的结论过窄，现更正。

官方已经提供另一条路径：`default_permissions` 和 `[permissions.<name>.filesystem]` 命名权限配置，底层有 `FileSystemSandboxPolicy`。本机0.147.0的 `codex sandbox -P <name>` 可以加载该配置；它与旧 `sandbox_mode` 不能混用。macOS底层由官方CLI的Seatbelt实现。必须实际测试目录外读写、链接和网络，不能仅凭配置被接受宣称隔离成立。[官方权限文档](https://learn.chatgpt.com/docs/permissions)、[0.147.0权限类型](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/protocol/src/permissions.rs)、[配置实现](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/core/src/config/permissions.rs)。

本次单独创建无敏感内容的fixture和独立HOME/CODEX_HOME验证该路线，不登录、不创建thread、不调用模型。完整配置、正控、拒绝证据和限制见[命名权限实测](codex-profile.md)。尤其 `:minimal` 包含平台默认权限，不能把它理解为只读取某几个运行库。CLI的命令沙箱也不自动约束app-server主进程的模型/认证请求或其他未审查工具。

## 建议

目前没有证据支持“升级到0.160.0即可解锁现有桥”，因此未升级任何CLI。恢复通用命令需把经过fixture验收的命名权限策略正确接入app-server，并重新验证实际回合、工具批准和逃逸拒绝；也可以等待兼容RPC。两条路线都不能仅靠模型提示词或cwd限制替代。本桥在完成这些工作前继续在取令牌前停止。

应用现在已有可用的**受限文件API**：无任意命令，仅专用目录列出/读取/新建文本，每次审批，已完成真实本地文件链路测试。该路线不依赖CLI，是本次交付的实际执行能力；它不是OS沙箱，也不代表通用shell已开放。模型调用同一API的代码通过假传输测试，真实模型端到端尚未验证。

如果用户另行授权**常规更新独立 CLI**，官方支持 npm 安装渠道（`npm install -g @openai/codex`），也提供独立安装器、Homebrew和发布二进制。先确认 `command -v codex` 与 `npm prefix -g` 对应同一安装，避免本机两份CLI更新错对象。未确定前不执行全局更新，不删除或覆盖任何现有安装。[该发布 tag 的安装说明](https://github.com/openai/codex/blob/rust-v0.160.0/README.md#installing-and-running-codex-cli)

## 不使用凭据的能力验证

```sh
npm run check:codex
```

脚本使用临时的独立HOME/CODEX_HOME，调用本机 `--version` 与 `app-server generate-json-schema`，检查实际生成协议，之后清理临时目录。它不创建thread、不登录、不调用令牌提供器、不发起推理。输出JSON的 `supported:false` 和退出码2表示能力未满足；`tokenRequested` 应始终为false。

这里的 `supported` 只代表**旧桥所选RPC形态**是否满足，绝非CLI整体能力判定。即使将来 `supported:true`，也只证明字段存在。还必须验证真实沙箱确实拒绝目录外读取、写入、网络、符号链接和扩权，并在用户明确授权后进行一次有界的真实模型任务。当前未进行该最终验收。
