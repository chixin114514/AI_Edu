# Apple Watch＋Safari 接入

旅行仍在 iPhone Safari 中操作。这个目录提供独立的 watchOS 10+ SwiftUI 应用源码；手表通过 HealthKit 采集，HTTPS 向慢行服务端发送最新心率，网页按当前行程读取。无需第三方心率广播服务，也不需要另做 iPhone 旅行界面。

**交付状态：** 网页、后端和原生工程源码已实现。当前开发环境为 Linux，没有 Xcode/Apple SDK，尚未编译、签名或在真实 Apple Watch 上验证；本目录不是已经安装好的应用。模拟网页联调不代表硬件验收。

## 准备

- Mac、支持目标手表系统版本的 Xcode、Xcode 命令行工具，安装 XcodeGen 2.42+（`brew install xcodegen`）。
- watchOS 10 或更新版本的手表，与自己的 iPhone 配对；真机调试按 Xcode 提示启用开发者模式。
- 在 Xcode 中登录具备所需签名与 HealthKit 能力的开发团队。若 Personal Team 无法签发该能力，需要相应 Apple Developer Program 团队；不要关闭 HealthKit 或伪造心率来绕过。
- 手表和 iPhone 都能访问同一个 HTTPS 服务地址。推荐使用有公开可信证书的域名；不接受忽略证书错误。当前局域网自建 CA 是否被手表信任需实测，在 iPhone 上信任并不代表手表一定信任。
- 后端使用现有原生 HTTPS 启动方式。若使用 TLS 反向代理，当前转发接口不会信任任意客户端的 `X-Forwarded-Proto`；需让代理到应用也使用 TLS，或另行实现受信代理配置。

## 生成和安装

在 Mac 上获取完整仓库后：

```bash
cd apple
xcodegen generate
open ManxingWatch.xcodeproj
```

1. 在 `ManxingWatch` target 的 Signing & Capabilities 中选择自己的 Team，并将 Bundle Identifier 改成自己的唯一标识（也可先修改 `project.yml` 再生成）。
2. 确认 HealthKit 与 Workout processing 后台能力已启用，选择已配对的真实 Apple Watch 为运行目标。
3. 点击 Run 安装。无需在聊天中提供 Apple ID 密码、证书私钥或开发账号凭据。
4. 编译检查也可以使用 `xcodebuild -project ManxingWatch.xcodeproj -scheme ManxingWatch -sdk watchsimulator -configuration Debug CODE_SIGNING_ALLOWED=NO build`；模拟器无法验证真实心率。

`Generated/`、`.xcodeproj/`、构建目录及个人签名设置不入库。重新生成工程可能覆盖 Xcode 内的手工设置；稳定的 Bundle ID 可写入 `project.yml`，个人 Team 配置保留在本地。

## 使用

1. Safari 打开慢行，生成或选择行程，点击“开始漫游”。
2. 点击“连接 Apple Watch”，阅读临时转发说明，勾选同意并生成配对码。
3. 打开手表“慢行伴行”，填入网页显示的 HTTPS 服务地址（含端口，不带路径）和 8 位配对码。地址只需填一次；可使用配对 iPhone 的手表键盘输入功能。
4. 在手表上勾选临时转发同意，点击“配对并开始”，完成 HealthKit 授权。健康授权对话框完成不代表已允许读取心率；若没有读数，检查佩戴接触及系统健康权限。
5. 网页出现实时心率后，点击“采集静息基线”，静坐至少 30 秒，收到至少 6 条不同的新读数后完成。手表读数不保证每秒更新；页面每 2.5 秒读取，手表约每 5 秒发送最新读数。
6. 需要融合步频时，另外点击“启用步频”并授权。只有满足已有持续趋势规则时才建议调整，不会仅因连上手表就自动改线。
7. 在网页点击“停止传感器”或结束行程，也可在手表点击“停止采集”。退出登录、删除行程数据、报告不适、重新配对都会撤销对应连接。网页刷新后需重新配对；不自动恢复健康采集。

Safari 切到后台或锁屏时停止趋势累计，返回前台后重新积累。手表运动采集可能继续，但不代表网页能后台判断；可以直接从手表停止。网络中断时只重试最新的有效读数，不补传历史。

## 数据边界

- 配对码一次有效，5 分钟过期；设备 token 只授予写入当前连接的权限，不能读取行程或其他人的心率。连接最长 4 小时。
- token 仅存手表内存，服务端只留哈希；不写 UserDefaults/Keychain，不放 URL。重新启动应用或服务后重新配对。
- 服务端只在进程内存中保留每条连接的最新一条心率；20 秒后读接口不再返回，并由每秒清理任务删除。既不写 SQLite，也不写应用日志、报告或发送到大模型。
- 原始读数经 HTTPS 到服务器，不能再宣称这一路径“原始心率不上传”。普通蓝牙路径保持端侧读取。
- 手表结束时丢弃本应用运动总结；Apple Health 仍可能保留系统采集的健康样本。本说明的“不保存”指项目服务端不持久化，不代表删除 Apple Health 数据。
- 生产环境须关闭心率接口的请求体/响应体记录、APM payload 捕获与代理缓存；已有反向代理默认访问日志也不应包含 Authorization。当前代码不提供多进程共享内存中转，多实例需粘性路由或另行设计。

## 真机验收

- 正确配对，佩戴后网页心率与手表一致；重复轮询不算新采样。
- 拒绝健康读取、摘表、断网 20 秒后不显示旧值、不触发疲劳建议。
- 配对码重复使用/过期无效；另一个账号无法读当前心率。
- 停止、结束行程、退出登录后，旧 token 返回 401；手表下一次发送时停止会话。
- Safari 锁屏再返回，趋势重新开始；结束手表采集后恢复手动反馈。
- 检查 SQLite、导出行程与日志无原始读数；测量实际耗电与网络延迟。

依据：[Apple HealthKit 运动会话](https://developer.apple.com/documentation/healthkit/running-workout-sessions)、[watchOS 网络请求](https://developer.apple.com/documentation/watchos-apps/keeping-your-watchos-app-s-content-up-to-date)、[XcodeGen 工程格式](https://github.com/yonaskolb/XcodeGen/blob/master/Docs/ProjectSpec.md)。
