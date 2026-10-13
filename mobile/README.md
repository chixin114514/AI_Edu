# 慢行 Android App

`mobile/` 使用 Capacitor 封装，Electron 外壳位于 `desktop/`。Android 安装包内包含界面和本地后端：`/api/*` 在手机内执行，地图、天气与模型请求直接访问对应服务。

App 不需要运行电脑上的 `npm start`，也不需要填写电脑 IP。页面地址 `https://localhost` 是 WebView 的本地资源来源。电脑端 `.env` 和 `127.0.0.1:7897` 代理不会自动带进 App；手机联网使用手机自己的网络。

## 构建与安装

需要 Node.js 22.21+、JDK 21 和 Android SDK（版本见 `android/variables.gradle`）。在项目根目录执行：

```bash
cd mobile
npm ci
npm test
# ANDROID_HOME 指向当前机器的 Android SDK
npm run apk
```

APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`。将新 APK 覆盖安装到手机，签名须与原安装包一致。仅更新源码或运行根目录的 `npm start` 不会更新已安装的 App。

使用 Android Studio 时，先运行 `npm run build` 和 `npx cap sync android`，再打开 `mobile/android` 构建；同步会同时更新网页资源、原生插件和 `CapacitorHttp` 配置。

## 服务配置与自检

打开 App 顶部的「服务配置」，填写高德 **Web服务 Key**。没有 Key 时默认使用内置样本；填好保存后会重新加载并进入实况模式。和风天气、DeepSeek、Jev 可按需配置。配置保存在当前设备，网页服务器的配置不与 App 同步。

「服务配置 → 网络自检 → 检查连接」分别检查本地请求桥、本地服务、原生 HTTP 插件及高德接口：

- 本地服务未启动：检查安装包是否包含最新启动模块，重新构建、同步并覆盖安装。
- 原生 HTTP 未就绪：运行 `npx cap sync android` 后重新构建安装。
- 未配置高德 Key：填写 Web服务 Key 并保存。
- 高德返回错误码：检查 Key 的服务类型、授权与配额。
- 外部请求失败或超时：检查手机网络和手机侧代理；电脑的本地代理地址无法直接用于手机。

## 本次启动修复

所有 HTML 入口统一按「本地后端 → 请求桥 → 本地服务检查 → 原生适配层 → 前端」启动，包含独立的登录、注册等页面。同源 `/api/*` 留在设备内，外部接口保留原生 HTTP 通道。初始化失败显示重试入口，并在控制台记录失败阶段。

后端清理计时器兼容浏览器的数字句柄；设备端 Buffer 替身支持登录摘要的十六进制解码、地图图片签名检查与 base64 编码。

原生联网使用 Capacitor 内置的 [CapacitorHttp](https://capacitorjs.com/docs/apis/http)，在 `capacitor.config.json` 中开启 `plugins.CapacitorHttp.enabled`。保留 HTTPS 本地来源与 TLS 校验。

## 验证

`npm test` 构建真实后端与请求桥后验证：所有页面入口注入、启动顺序、外部请求转发、网络诊断，以及不提供 Node Buffer、使用浏览器数字计时器的隔离环境中离线启动、注册登录、权限和地图图片处理。原有本地行程、设备适配与实况配置测试继续运行。

2026-10-13 本轮验证：网络相关 5 项、原有移动端 26 项，以及根目录的路由、Watch、账号和前端 69 项均通过；`npm run check` 通过。受当前环境限制，使用已有 esbuild 0.27.7 单独构建后端与请求桥验证；依赖下载被网络权限阻止，完整原生模块构建未运行。当前环境没有 JDK、Android SDK 或 adb，未生成 APK，也未完成安卓真机联网测试。
