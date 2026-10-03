# whisper

像聊天一样，与不同模型交流。支持独立运行的 Android 应用，以及本机 Mac 聊天与受监督文件任务。

[下载 Android APK](https://github.com/COLORSN-99/whisper/releases/download/v0.2.0/whisper-v0.2.0-android.apk) · [Android 构建说明](docs/android-build.md) · [桌面版说明](docs/desktop.md)

## Android

从 Releases 下载 `whisper-…-android.apk`，在 Android 8.0 或更新系统上安装。不需要 Mac 服务、端口转发或同一局域网。

- **私聊与群聊**：每位成员绑定自己的供应商和模型；支持流式回复、停止生成和本地会话记录。
- **离线开始**：内置明确标识的演示角色，不联网、不消耗模型额度，也不声称在手机运行了本地大模型。
- **其他厂商**：用户显式配置支持 OpenAI-compatible Chat Completions 的公开 HTTPS API、模型和自己的凭据。原生 Anthropic/Gemini 协议不自动等于兼容协议。
- **凭据控制**：默认只保留在内存；保存到手机需单独勾选，并由 Android Keystore 加密保护。恢复已保存凭据也需要明确确认。

Android 的 ChatGPT 登录尚未接入；不会要求用 OpenAI API key 代替，不会继承现有 ChatGPT 对话、记忆或 Dear 身份。远程电脑配对和手机控制仍在后续范围，本版不申请无障碍、录屏、设备管理员或共享存储权限。

这是早期预览版。真实厂商调用会使用其账户额度；开发测试不使用真实账户或模型。

## Mac 桌面版

需要 Node.js 22+。在独立项目目录执行：

```sh
git clone https://github.com/COLORSN-99/whisper.git
cd whisper
npm start
```

打开 <http://127.0.0.1:4783>。仅监听本机回环，不公开电脑执行接口。可用 `WHISPER_PORT=4784 npm start` 更改本地端口。

桌面支持演示私聊/群聊、官方 Sign in with ChatGPT 接入代码、兼容厂商接口，以及逐次审批的受限文件任务。专用工作区仅能列出、读取和新建顶层文本，不覆盖、不删除、不执行任意 shell；不是操作系统沙箱。桌面 OAuth 与真实模型资格仍需用户亲自授权后验证。

本地聊天、审批与审计位于 `.data/`，没有应用级加密；它们不会进入 Git。桌面凭据默认在内存，macOS Keychain 保存与恢复另行确认。完整边界见 [文件任务](docs/file-agent.md)、[OAuth](docs/oauth.md) 和 [CLI 兼容性](docs/cli-compatibility.md)。

## 开发与验证

```sh
npm run check
npm test
npm run build:files
```

桌面文件测试需要 macOS；`build:files` 只检查固定系统 Python 与脚本语法。桌面零运行时 npm 依赖。

Android 使用 Java 17、Gradle 8.13、AGP 8.13.2；进入 `android/` 后可运行：

```sh
./gradlew testDebugUnitTest lintDebug assembleDebug
./gradlew connectedDebugAndroidTest
```

发布前在本机执行桌面回归、Android 单元测试、Lint 和隔离模拟器测试。仓库附有可选 GitHub Actions 模板；当前 GitHub 授权缺少 workflow 权限，模板尚未启用。APK 在维护者本机用专用长期签名完成，并附带校验文件。[验证结果](docs/validation.md) · [测试范围](docs/android-testing.md) · [签名与发布](docs/android-build.md)

| 路径 | 内容 |
| --- | --- |
| `android/` | 独立 Android 客户端 |
| `public/` | 桌面聊天界面 |
| `server/` | 本机 HTTP、模型接入、OAuth 与任务审批 |
| `scripts/` | 固定文件工具与诊断脚本 |
| `test/` | 桌面离线与真实临时文件测试 |
| `ci-templates/` | 可选 GitHub Actions 构建与模拟器验收模板 |

## 参考

项目独立编写，未复制 Operit 的实现。仅参考 [Operit](https://github.com/AAswordman/Operit) 的聊天驱动任务与按工具授权思路；相关项目拥有各自许可证。APK 中不包含模型权重、账户凭据或第三方项目私有代码。
