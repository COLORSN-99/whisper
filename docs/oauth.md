# Whisper 的 ChatGPT 登录

实现基于 2026-10-03 查阅的 OpenAI 官方文档。它使用个人本地项目的 **Sign in with ChatGPT / ChatGPT plan usage**，不使用 API key，不读取 Codex 登录文件。Google 登录只可能出现在 OpenAI 官方登录页面，本项目没有 Google OAuth 客户端。

这条授权不会导入 ChatGPT 对话、Dear 身份、记忆、订阅账号的私有工具或应用权限。实际额度资格和允许模型以 OpenAI 授权与服务返回为准。[官方示例与适用范围](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)

## 服务端接口

```js
import { OAuthManager } from './server/oauth.mjs';

const oauth = new OAuthManager({
  dataDir: '/absolute/path/to/whisper/.data/oauth',
  redirectUri: 'http://127.0.0.1:4783/auth/callback',
});
await oauth.init();

// 只在用户明确点击并同意授权后调用。先启动 loopback HTTP 监听器。
const { url } = await oauth.begin({ consent: true, persist: false });
// 将 url 交给系统浏览器，禁止记录该 URL。
// GET /auth/callback handler:
await oauth.callback(new URL(requestUrl, 'http://127.0.0.1:4783'));

oauth.status();                   // 只返回安全状态和账户元数据
await oauth.getAccessToken();     // 仅服务端模型/执行适配器使用
await oauth.logout();             // 撤销并清除；UI 展示返回的 warning
await oauth.close();              // 关闭内存和文件锁；不是远程撤销
```

`init()` 不联网、不生成主机 ID、不读取任何 Keychain 会话。第一次明确 `begin` 后，目录保存稳定主机 ID、注册 ID 与已验证账户元数据，文件权限为 `0600`。访问令牌、刷新令牌、ID token、nonce 和 PKCE verifier 不写入元数据文件。默认令牌只活在进程内存中。

`begin` 还支持 `clientId` 选择已有注册、`newAccount: true` 添加账户、`enablePlan: true` 在用户主动开启额度权限时重新请求同意。首版每次只有一个活动会话，切换账户或保存方式前必须先退出。各注册以 issued client ID 与 verified subject 关联，不凭相同邮箱合并。

回调仅支持 `http://127.0.0.1:<port>/auth/callback`。端口可以变化，协议、主机与路径保持一致；同一次授权和代码交换使用完全相同的 URI。根 HTTP 层必须保留 Origin/Host 校验及防 CSRF 控制，不能把 `getAccessToken` 暴露给浏览器。[注册和登录规范](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)

## 默认内存与可选 Keychain

编译助手只创建可执行文件，不读取或写入钥匙串：

```sh
mkdir -p .runtime
swiftc -module-cache-path .runtime/swift-module-cache -o .runtime/whisper-keychain scripts/keychain.swift
```

使用 `new MacOSKeychainTokenStore({helperPath: absoluteHelperPath})` 注入 `OAuthManager` 的 `store` 参数。构造不执行助手；`status().persistenceAvailable` 表示是否提供了持久存储适配器。真正持久保存必须经过 UI 单独明确勾选，并调用：

```js
await oauth.begin({ consent: true, persist: true, persistenceConsent: true });
```

之后仍需用户在 OpenAI 官方页面完成授权。重新启动应用时，只有用户明确要求读取本应用保存的会话，才调用 `resume({consent: true})`。恢复过程验证签名与注册映射；过期访问令牌在首次需要推理时续期。`close()` 保留用户明确保存的 Keychain 记录；`logout()` 尝试删除该记录。

Swift 助手只访问服务 `com.whisper.oauth` 的指定 account 项，不同步到云端。令牌经进程 stdin/stdout 私密 IPC 传递，没有 shell、命令行秘密参数或明文临时文件。不能把助手 stdout/stderr 接到产品日志。每个不同安装建议使用不同的 Keychain account，避免共享同一个条目。

## 验证、续期与退出

新尝试独立保存 10 分钟的一次性 state、nonce 和 PKCE S256。回调先验证 state，再交换授权码；只有通过官方 JWKS 的 RS256 签名、issuer、audience/azp、exp/iat/nbf、subject、nonce 和可选 at_hash 检查后才切换账户。生产发行者及发现端点固定在 `https://auth.openai.com`，不接受 JWT 指定的外部公钥 URL。

权限来自 token response 的实际 scope；未获 `chatgpt.tokens.use.direct` 和 `resource.invoke` 时禁止返回推理用 access token。有效身份本身不代表用户同意消耗额度。返回浏览器的授权 URL 特意不携带 `id_token_hint`；再次登录会显示官方账户选择页面。

访问令牌接近到期时，在本进程内合并并发刷新。文件锁拒绝另一进程同时使用同一数据目录，避免轮换令牌竞争。刷新失败若为明确失效错误，清除令牌并保留注册映射；临时网络失败保留会话。刷新成功而 Keychain 保存失败时保留最新轮换结果在内存并显示警告，避免重用旧刷新令牌。

退出会等待正在进行的刷新，向 discovery 提供的 revocation endpoint 撤销最新刷新令牌；网络/5xx 最多尝试三次。无论远程撤销是否确认，都停止本地使用。UI 必须显示 `revocationConfirmed`、`localCleared` 与 `warning`；必要时引导用户在 ChatGPT 设置断开应用。[账户、刷新和注销规范](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)

服务崩溃可能遗留 `oauth-session.lock`。确认本项目没有进程运行后才能删除该锁；不要运行多个共享同一数据目录的实例。内存登录在退出应用后不保留令牌，但其注册映射仍可用于重新登录。

## 已验证与未验证

运行 `node --test test/oauth.test.mjs`。测试使用临时 RSA 签名、假 fetch 和模拟 Keychain 进程，覆盖非法 state/签名/nonce/audience/issuer/时间、权限、换号、刷新竞争、退出、存储确认与秘密 IPC。没有联系真实授权/模型端点，没有读取任何现有凭据，也没有操作真实 Keychain。Swift 助手仅做编译检查。

真实 OAuth 登录、实际额度资格、服务端模型响应与真实 Keychain 保存，需要用户在应用中明确授权后验收，不能从离线测试推断已经成功。

补充依据：[令牌字段](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)、[OIDC 发现文档](https://auth.openai.com/.well-known/openid-configuration)、[恢复和错误](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)。
