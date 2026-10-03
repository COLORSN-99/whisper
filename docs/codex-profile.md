# Codex 命名权限 profile 本机验证

2026-10-03 的结论：本机 Codex **确实提供官方命名权限 profile**；目前测试没有验证出符合 Whisper 要求的完整目录边界，因此不能据此开放通用命令桥。协议缺少某个旧字段，不等于 CLI 没有隔离读取的能力。

## 检查范围

- CLI：`<local-path>`，实际输出 `codex-cli 0.147.0`。
- 本机帮助明确提供 `codex sandbox -P NAME -C DIR -- COMMAND`。这版没有 `macos` 子命令；`--strict-config` 也不能用于 `sandbox`。
- 使用 Codex 自己生成的 macOS Seatbelt 沙箱，未编写自定义 SBPL，未修改全局 CLI、OS 权限或安全设置。
- 每次生成独立 `/tmp/whisper-profile-*`，规范化为 `/private/tmp/...`；里面有 `inside`、`outside`、全新 `HOME`、`CODEX_HOME` 和 `TMPDIR`。所有文件都是固定无秘密测试数据，结束时删除。
- 子进程环境只包含 `HOME`、`CODEX_HOME`、`TMPDIR`、固定 `PATH` 和 `LANG`。没有读取现有登录、API key、环境秘密或其他项目，也没有 OAuth、模型推理、第三方 API 调用。
- 网络正控是脚本自己的 `127.0.0.1` 临时 TCP 监听。没有向外网发请求；测试只证明这个 TCP 连接被拒绝，不代表检验了所有协议。

## 官方配置依据

[0.147.0 配置 schema](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/core/config.schema.json) 和[命名权限编译实现](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/core/src/config/permissions.rs)提供 `default_permissions`、`permissions.<name>.filesystem` 和 `permissions.<name>.network`。本次没有使用 `extends`、`--sandbox`、`sandbox_mode` 或 `sandbox_workspace_write`，避免旧设置覆盖命名 profile。

基于[官方权限说明](https://learn.chatgpt.com/docs/permissions)，该能力仍处于 beta，边界针对沙箱内命令。模型服务、认证、MCP 或浏览器不是本次命令沙箱验证的对象。独立测试通过也不能自动证明 app-server 的同等配置、工具入口和审批链已经正确接线。

## 实际结果

先在不加 Codex 沙箱的情况下运行固定 probe，确认所有文件访问、链接和本机 TCP 都成功，避免把文件不存在或端口未启动误认为拒绝。然后清理其写入结果，在同一个沙箱内 Perl 进程中重复全部操作。符号链接由该进程在直接读写测试之后创建，排除了预置目录链接干扰。

| 操作 | 正控 | 含 `:minimal` 的 profile |
| --- | --- | --- |
| 读取 `inside/sentinel.txt` | 成功 | 成功 |
| 创建 `inside/created.txt` | 成功 | 成功 |
| 读取 `outside/sentinel.txt` | 成功 | **成功，未拒绝** |
| 创建 `outside/created.txt` | 成功 | **成功，未拒绝** |
| 经内部符号链接读取 outside | 成功 | **成功，未拒绝** |
| 经内部目录符号链接创建 outside 文件 | 成功 | **成功，未拒绝** |
| 从 outside 源创建内部硬链接及读取 | 成功 | **成功，未拒绝** |
| 连接临时本机 TCP 监听 | 成功 | 拒绝，`EPERM` / errno 1 |

最后一次完整对比时间为 `2026-10-03T10:54:29.993Z`。配置包含 `:root = deny`、`:tmpdir = deny`、`:slash_tmp = deny`、`:minimal = read`、`/System/Library/Perl = read` 和唯一 inside 根 `write`，network 为 false。无沙箱正控全部成功，沙箱正控成功，但文件边界失败；outside 既有 sentinel 内容未改变。

原因有官方源码支持：[0.147.0 的 platform defaults](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/sandboxing/src/restricted_read_only_platform_defaults.sbpl#L84-L88)在启用 `:minimal` 时额外允许共享临时目录读写。[Seatbelt 实现](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/sandboxing/src/seatbelt.rs#L690-L702)会附加这些默认规则。因此，不能把 `:minimal` 理解为仅开放只读运行库；本机显式拒绝那些特殊路径的 profile 也没有覆盖这项额外授权。

## 不含 `:minimal` 的配置

随后移除 `:minimal`，仍显式拒绝根目录和临时目录，只授权 inside 写入，外加 `/usr/bin`、`/usr/lib`、`/System/Library` 读取，以及 `/dev/fd`、`/dev/null` 标准输入输出读写。

`2026-10-03T10:59:08.835Z` 的结果：无沙箱完整正控成功；沙箱内 `/usr/bin/true`、只打印固定字符串的 Perl、完整 Perl probe 都退出 **134**，没有 stdout/stderr。因此这组配置**未取得目录内允许访问的正控，不能算隔离验证通过**。尚未定位这个启动失败的具体运行时条件，也未证明所有官方配置都不可行。

早期使用临时 C probe 的两次正控成功，随后同一类新编译二进制在未加 Codex 沙箱时被 `SIGKILL`，故最终改用系统 Perl，避免将二进制启动失败混同为目录限制。早期预置硬链接也可读取，但当时整个共享临时目录都可访问，这不能单独证明硬链接绕过。当前脚本验证的是“从拒绝的外部源创建硬链接”，不声称已经覆盖预先导入的硬链接、所有竞态或所有文件工具。

## 重复执行

在项目根目录运行：

```sh
node scripts/check-codex-profile.mjs --platform-defaults
node scripts/check-codex-profile.mjs
node --test test/profile.test.mjs
```

第一个命令复现包含 `:minimal` 的对比；第二个复现显式运行库配置。两者当前预期都返回退出码 2：分别因为目录外访问仍被允许、以及没有取得沙箱内启动正控。脚本仅当目录内读/写都成功、外部读/写/链接访问和本机 TCP 都以 `EPERM` 或 `EACCES` 明确失败时，才将 `fixtureBoundaryPassed` 标为 true。文件不存在、端口拒绝和进程启动失败都不会冒充权限拒绝。

外层 Codex 工具沙箱会阻止本机监听（`listen EPERM`），也不允许嵌套应用 Seatbelt（`sandbox_apply: Operation not permitted`）。本次只对上述固定离线 fixture 使用了工具的 `require_escalated` 审核，不申请任何新 OS 权限。测试环境若仍在外层沙箱内，这类错误属于环境阻碍，不能得出内层 profile 结论。

脚本和测试不改桥接逻辑。后续若继续研究，必须先取得完整正控、目录及链接拒绝结果，再独立验证 app-server 的最终有效策略和所有暴露工具；本记录不足以支持开启通用命令执行。
