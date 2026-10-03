# whisper · Whisper

在自己的 Mac 上，把模型聊天、讨论和可监督的任务放在一个会话空间里。首版是可运行的本地应用，默认使用**明确标识的测试适配器**。无需安装 npm 依赖。

## 启动

需要 Node.js 22 或更新版本。在本目录执行：

```sh
npm start
```

本机文件任务使用固定的 `/usr/bin/python3 -I -S` 和本项目脚本，无需安装依赖或编译本地程序。`npm run build:files` 保留为环境与语法检查命令，不会执行文件操作或修改系统权限。

浏览器打开 <http://127.0.0.1:4783>。停止服务使用 `Ctrl+C`。如端口占用，可用 `WHISPER_PORT=4784 npm start`；OAuth 回调会跟随该端口。

项目使用独立目录，运行数据仅保存在本项目。

## 先体验

1. 打开“我的助手”，发送消息，观察流式回复；所有演示回复均写明未调用真实模型。
2. 打开“灵感小组”，一条消息依次交给三位测试角色。`@向导 内容` 可只让某个角色回复。真实群聊每位被选中的成员都会独立产生模型用量。
3. 打开任务面板，选择“本地文件”，新建一份文本草稿。核对完整内容并“允许一次”后，文件才会实际写入专用目录；再分别批准读取或列出文件。无需登录，不调用模型。
4. 新建私聊或群聊，选择成员、供应商和模型。会话及任务记录存于本项目 `.data/conversations.json`，重启后保留；文件没有应用级加密，请按个人敏感资料管理。

## 连接 ChatGPT 计划

“连接与模型”中使用 **Continue with ChatGPT**。先勾选同意前往官方页面，再点击生成的官方链接，自行选择账户、工作区与计划用量授权。Google 只是官方登录页可能提供的身份选项，本应用不自行实现 Google OAuth。

- 接入代码采用官方动态客户端注册、PKCE、state、OIDC nonce、JWKS 签名及账户校验。
- 默认仅在当前服务进程内存保存令牌，关闭进程即清除。不会读取现有 Codex 登录、ChatGPT Cookie 或系统中的其他凭据。
- 已编译的 macOS Keychain 辅助程序仅在用户单独确认保存或恢复时使用。源码为 `scripts/keychain.swift`；重新编译可执行 `npm run build:keychain`，然后重启应用。**编译不读取或保存凭据。** 其他平台保留内存模式。
- 登录后点“刷新模型”，按当前账户目录创建新的真实聊天。目录可见不保证某次请求有可用额度；失败会原样作为失败状态展示，不自动改用 API key 或重复计费重试。
- 退出连接会尝试官方撤销并清理本地会话；如果远端撤销无法确认，界面会提示前往 ChatGPT 管理访问与用量。
- 不会导入现有 ChatGPT 聊天、记忆、Dear 身份、订阅账户中的私有工具权限。聊天历史由本应用自行维护。

这次开发没有发起真实授权、保存真实令牌或验证真实模型回复。

## 其他厂商

连接面板支持 **OpenAI-compatible Chat Completions** 协议的公开 HTTPS 服务，填写厂商地址、模型 ID 与其自己的凭据。凭据仅保留在内存，重启后需要重新输入。禁止本地/私有网络地址与重定向，不会把 ChatGPT OAuth 令牌发给其他厂商。Anthropic、Gemini 等原生协议尚未单独实现；只有明确提供该兼容协议的服务可使用本适配器。

## 电脑任务的当前状态

现在提供三种明确分开的模式：

| 模式 | 实际能力 | 验证状态 |
| --- | --- | --- |
| 本地文件 | 用户选择列出、读取或新建文本，每次审批后执行 | 已通过无模型的真实文件集成测试 |
| ChatGPT 文件助手 | 模型规划并调用相同的三种工具，每次动作仍需审批 | 官方请求代码和假传输测试通过；未做真实模型验收 |
| 演示任务 | 展示进度与审批，不访问文件 | 已验证 |

文件工具固定使用 `.data/task-workspace`，仅接受顶层 `.txt`、`.md`、`.csv`、`.json` 和不超过128 KiB的UTF-8文本。没有任意路径、shell、覆盖、删除或网络工具。新建用原子且不可覆盖的发布；路径穿越、符号链接、硬链接、设备文件和目录替换均拒绝。每张审批绑定不可修改的操作参数和一次性ID，两分钟过期。取消会阻止后续动作，已提交的写入不能撤回。

这是**受限文件API，不是操作系统沙箱**，不防御拥有同一Mac账户权限的恶意本机进程。文件和审计记录由本应用维护。模型模式会在读取审批中明确告知：完整文件文本将发送给OpenAI；界面长结果会标注截断。详见[文件任务接口与边界](file-agent.md)。

另保留 `server/codex.mjs` 的官方 app-server 桥，但**通用shell未开放**。本机0.147.0及已核查0.160.0的旧RPC类型不包含本桥要求的限定读取字段；这是接口形态不兼容，不能据此断言CLI没有目录隔离能力。官方另有命名权限配置，需以实际fixture验证其边界。当前桥仍在取令牌前停止，未静默降低要求或升级CLI。见[版本与等效边界核查](cli-compatibility.md)和[桥说明](codex.md)。

**远程电脑与 Android 控制尚未实现。** 设备页显示该事实；没有端口转发、公网执行接口或后台设备连接。后续需明确设备、工作区、可用动作、可撤销配对、审计与关键动作确认，才能实施与验收。

## 验证与代码入口

```sh
npm test
npm run check
```

测试使用自建临时文件、真实固定文件helper、假模型/授权传输、测试 RSA 密钥和 fake app-server，不消耗模型额度。HTTP 集成测试需允许回环监听。Keychain真实存取、官方登录和真实模型自主调用仍需另行验收。

| 目录 / 模块 | 职责 |
| --- | --- |
| `public/` | 微信式会话列表、私聊/群聊、设置、任务与审批 |
| `server/index.mjs` | 回环 HTTP、会话/CSRF、事件推送和会话协调 |
| `server/providers.mjs` | 测试、ChatGPT Responses、兼容厂商的统一流接口 |
| `server/oauth.mjs` | 官方 OAuth、身份和权限校验、刷新与退出 |
| `server/token-store.mjs` | 内存与 macOS Keychain 存储接口 |
| `server/codex.mjs` | 受监督的本地 app-server 生命周期 |
| `server/file-tools.mjs`、`scripts/file-tools.py` | 固定目录的列出、读取与原子新建文本 |
| `server/file-agent.mjs` | 手动或模型任务、单次审批、停止与结果 |
| `server/store.mjs` | 本地会话与审计持久化 |
| `test/` | 离线协议、安全与集成测试 |

## 参考与许可

实现独立编写，未复制 Operit 代码。[Operit Android](https://github.com/AAswordman/Operit) 的主代码为 LGPL-3.0-only；[Operit2](https://github.com/AAswordman/Operit2) 的根许可证为 AGPL-3.0。仅参考“聊天驱动任务、角色各自绑定模型、按工具授权”的产品模式。

官方接入依据（2026-10-03核实）：[Cookbook](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)、[注册与登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、[app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)、[预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。预览协议会演变，升级时应重新核对，不能把离线测试当成真实服务可用性的证明。
