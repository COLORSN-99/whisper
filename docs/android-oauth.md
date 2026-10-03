# Android 的 ChatGPT 登录

v0.3.0 按 OpenAI 公开的本地／开源应用协议实现，使用手机 Chrome 和临时 IPv4 loopback 回调。没有官方 Android SDK 依赖，也没有复制 devkit 代码。官方资料描述的协议是实现依据；真实账号是否获准仍由 OpenAI 服务决定。[官方登录协议](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[本地个人／开源范围](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)

## 在手机使用

1. 安装新版 APK，打开 **设置 → 通过 Chrome 登录 ChatGPT**。
2. 默认仅本次使用登录。需要跨应用重启保留时，主动勾选加密保存。
3. 点击 **打开 Chrome**，在 `auth.openai.com` 官方页面登录并同意授权。没有 Chrome 时回退到系统浏览器；密码只输入官方页面。
4. 浏览器显示“授权已收到”后，切回 whisper 查看最终校验结果；此页面本身不代表登录成功。
5. 点击 **读取可用模型**。打开私聊或群聊的 **成员**，选择 ChatGPT 和账号返回的模型。
6. 发消息前确认发送内容和消耗订阅用量。群聊上下文及前一成员回复会发送给后续成员所用的供应商。

这不会导入 ChatGPT 对话、Dear 身份、记忆或私有工具权限。不要求 API key，也不读取已有 Codex 登录。

目前一次使用一个账号注册；返回不同账号身份会拒绝接入。登录等待 10 分钟，支持主动取消。若 Android 在 Chrome 登录期间终止了 whisper 进程，本次回调无法完成，需要重新打开应用登录；没有后台常驻服务。退出后 Chrome 自己的官方网页登录可能仍然存在，whisper 不删除浏览器 Cookie。

## 会话与网络

- 首次使用 `dynamic_agent_client`、稳定的安装 host ID 和应用名；仅使用回调中 issued client ID 交换授权码。后续复用已验证注册，不把入口 ID 用于换令牌。
- 每次生成新的 state、OIDC nonce、PKCE S256 verifier；回调一次性消费，只监听 `127.0.0.1`，端口临时分配，路径固定 `/auth/callback`。同次授权与换码使用完全相同的 redirect URI。
- 校验 Host、方法、路径、参数重复、state、可选 issuer；拒绝带 Origin 或请求体的回调。请求大小、连接读取和登录等待都有上限。回调页面不含授权码、令牌、外部脚本或自动跳转。
- 校验官方 JWKS RS256 签名、issuer、audience/azp、时间、subject、nonce 和可选 at_hash。只有实际获授 `resource.invoke` 与 `chatgpt.tokens.use.direct` 才能使用模型。
- 令牌默认只在进程内存；勾选保存后整条会话由 Android Keystore AES-GCM 加密存入应用 no-backup 目录，原子写入并读回验证。下次启动不自动恢复，恢复必须另行同意。安装 ID、issued client ID 和 subject 的 SHA-256 映射保存为应用私有的非令牌元数据。
- 续期串行执行，禁止自动重试。轮换结果先以未验证状态加密保存，完成身份校验后提交可用状态。网络结果不确定或验证失败时停止使用并要求重新登录，不重放可能已轮换的旧刷新令牌。保存中断或残留未验证状态只允许清除后重新登录。
- 退出停止本地使用，尝试撤销当前内存刷新令牌并清除保存。远程撤销未确认时明确提示到 ChatGPT 设置断开授权；不为了退出而擅自恢复未同意读取的加密记录。
- 官方 HTTPS 请求固定到 OpenAI 端点；平台 TLS 校验、受检公网 DNS、无代理、无重定向、无自动重试。授权码、完整授权 URL、令牌和原始上游错误不输出日志或 UI。

模型目录从授权账号读取；聊天使用 `POST /v1/responses`，`store:false`、`stream:true`，每次提供上下文。不是第三方 Chat Completions 入口，也没有 API-key 回退。不声明或执行手机／电脑工具；流失败保留已收到的文字，发送请求不自动重试。[预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

## 验证边界

JVM 测试用临时 RSA 密钥、假服务端及本机回调覆盖换码、签名与身份绑定、权限不足、错误 state、取消时的竞态、保存恢复、续期不确定性、模型目录和 Responses 结束标识。Android 模拟器另测原生确认界面、生命周期及手机本地回调；Chrome 只访问带合成 state/code 的手机回环 URL。

**未发起真实 OpenAI 授权、未读写真实令牌、未调用真实模型、未测试实体手机。** 因此不能将离线或浏览器回调测试称作真实订阅登录已通过。用户需在自己的手机官方页面完成授权，检查模型列表并主动发送消息验收。实际失败时只收集安全的阶段／HTTP 状态，不提供 Cookie、完整授权 URL、授权码或令牌。
