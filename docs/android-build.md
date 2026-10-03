# Android 构建与发布

已固定兼容组合：Java 17、Gradle 8.13、AGP 8.13.2，compile/target SDK 36，min SDK 26。Gradle wrapper JAR 已按官方 SHA-256 核对，distribution 也配置 SHA-256。[官方 AGP 兼容表](https://developer.android.com/build/releases/agp-8-13-0-release-notes)

Android Studio 可以直接打开 `android/`。命令行需要本机已配置 Java 17 和 Android SDK：

```sh
cd android
./gradlew testDebugUnitTest lintDebug assembleDebug
./gradlew connectedDebugAndroidTest
```

第二条命令需要测试模拟器。本项目使用单独创建的 Android 35 模拟器，不连接用户真实手机。测试只用合成聊天和假凭据，不调用真实模型。

运行时使用 Android 平台 Views、内部存储与 Keystore，以及固定版本 OkHttp 4.12.0。自定义 DNS 验证解析结果后，将该组地址直接交给连接器；不使用系统代理，不重定向，不自动重试，TLS 仍校验原域名。依赖版本见 `android/app/build.gradle`；OkHttp 的发布元数据与 Apache-2.0 许可证见 [Maven Central POM](https://repo.maven.apache.org/maven2/com/squareup/okhttp3/okhttp/4.12.0/okhttp-4.12.0.pom)。

## 发布签名

APK 使用专用长期 PKCS#12 签名。私钥和密码仅保存在维护者本机，不进入 Git、GitHub Secrets、CI 或附件。CI 用 `-PunsignedRelease=true` 显式构建无签名中间产物；此附件不可直接安装。维护者下载测试通过的提交对应产物，在本机用 Android 官方 `apksigner` 签名与验证，再将签名 APK、`SHA256SUMS.txt` 和公开的 `signature-verification.txt` 上传到 GitHub Release。

本机 Gradle 直接构建签名版也可设置 `WHISPER_KEYSTORE_FILE` 和 `WHISPER_SIGNING_PASSWORD`；alias 固定 `whisper`。没有签名配置且未显式选择中间产物时，`assembleRelease` 会失败。

维护者应离线妥善备份专用签名文件及密码，保持 package ID 和签名身份不变。签名丢失会影响覆盖更新。[Android 官方签名说明](https://developer.android.com/studio/publish/app-signing)

`ci-templates/` 提供可选工作流模板，只有仓库读取权限，不读取签名秘密，也不自动发布。当前 GitHub 登录缺少 workflow 权限，模板未启用，发布验证在本机隔离工具链完成。完成测试后才创建版本 tag 和可安装的预发布附件。

## 移动端 OAuth 范围

当前未集成 ChatGPT Android OAuth。已查阅的官方开源应用方案描述 loopback 回调和桌面示例，不能据此宣称 Android 回调已受支持。后续确认官方移动注册与回调契约后再接入；不会复用已有 ChatGPT/Codex 登录、Dear 身份或私人工具权限。[官方注册流程](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
