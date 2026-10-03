# v0.3.0 验证记录

2026-10-04，本机独立项目与专用 Android 35 / ARM64 模拟器完成。没有使用真实账号、授权码、令牌或模型请求，没有连接实体手机。

| 检查 | 结果 |
| --- | --- |
| 桌面语法与 Node.js 回归 | 125 / 125 通过 |
| Android JVM 单元测试 | 57 / 57 通过；Debug 与 Release 均验证 |
| Android Debug / Release Lint | 0 个错误 |
| Android 35 / ARM64 仪器测试 | 10 / 10 通过，`OK (10 tests)` |
| Chrome → 手机 loopback 回调 | 合成 state/code 到达；浏览器显示返回应用提示 |
| Release 签名 | 与 v0.2.0 使用同一证书，apksigner 验证通过 |

新增 13 项 JVM 测试覆盖官方授权协议、PKCE、临时 RSA 签名与账户绑定、scope 不足、错误 state、取消竞态、保存恢复、续期失败不重试、模型目录和 Responses 流。原有聊天与存储测试保持通过。

新增 3 项仪器测试覆盖登录默认不保存、取消与 Activity 重建、手机回调校验、真实 Chrome 访问合成回调。Chrome 首次启动的账号／通知／地区搜索提示起初遮挡测试页面；测试现在选择无账号、拒绝通知并保留原搜索设置，保留完整页面与回调断言。全部 10 项最终用相同 AndroidJUnitRunner 在专用模拟器内执行通过。

APK 只申请网络权限，禁用备份、明文 HTTP 客户端流量和 Release 调试；登录回调的本地 ServerSocket 只在用户开始登录后临时创建。签名私钥仍留在本机，没有上传 GitHub Secrets。

真实 OpenAI 授权和模型响应、实体 Android 设备，以及 Android 26 上的运行仍未验证。Chrome 能访问本地回调和离线协议通过，不能替代真实账号资格验收。使用步骤与失败边界见 [Android OAuth](android-oauth.md)。

---

# v0.2.0 验证记录

2026-10-03，在独立项目目录完成；未连接真实手机，未使用真实模型凭据或调用计费 API。

| 检查 | 结果 |
| --- | --- |
| 桌面 Node.js 测试 | 125 / 125 通过 |
| Android JVM 单元测试 | 44 / 44 通过；Debug 与 Release 变体均验证 |
| Android Debug / Release Lint | 0 个错误 |
| Android 35 / ARM64 模拟器仪器测试 | 7 / 7 通过，`OK (7 tests)` |
| 调试包、测试包、Release 包 | 构建成功 |

仪器测试覆盖离线启动、私聊停止与继续、群聊成员和会话重启恢复、默认不保存凭据、显式保存与恢复、退回内存模式清理旧保存。截图仅含新建的演示会话。

本机 ADB 的长连接会被终止，首次运行因此出现 UiAutomation 连接失效。最终在专用模拟器内独立运行相同 AndroidJUnitRunner，并读回完整结果；没有跳过测试或断言。有效首轮发现测试脚本对滚动容器的错误假设，修正为先判断控件可见，再重跑全部 7 项，通过。

Lint 保留两项非阻断提示：API 33 返回手势声明会被较旧系统忽略（代码保留旧版本回退）；固定 Gradle 8.13 有更新版本可用。

实际模拟器验证版本为 Android 15 / API 35。API 26 是声明的最低版本，并通过静态兼容检查，未逐一测试所有 Android 设备。真实厂商 API、Android ChatGPT OAuth、远程电脑配对与手机控制不在这次验收范围。

发布包由本机长期专用密钥签名；私钥不进入仓库或 GitHub Secrets。Release 附件包含 APK 校验和与公开签名验证报告。
