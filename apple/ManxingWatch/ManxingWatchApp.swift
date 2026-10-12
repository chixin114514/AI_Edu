import SwiftUI

@main
@MainActor
struct ManxingWatchApp: App {
    @StateObject private var model = WatchModel()
    // Only the server address persists; pairing codes and bearer tokens never do.
    @AppStorage("serverAddress") private var serverAddress = ""
    @State private var code = ""
    @State private var consent = false

    var body: some Scene {
        WindowGroup {
            ScrollView {
                VStack(spacing: 12) {
                    Text("慢行 · 心率伴行").font(.headline)
                    if model.active {
                        Text(model.heartRate.map { "\(Int($0.rounded()))" } ?? "—")
                            .font(.system(size: 44, weight: .semibold)).monospacedDigit()
                        Text("bpm").font(.caption)
                        Text(model.status).font(.footnote)
                        Button("停止采集", role: .destructive) { model.stop() }
                    } else {
                        Text("先在手机网页开始漫游，选择连接 Apple Watch 并生成配对码。")
                            .font(.footnote)
                        TextField("HTTPS 服务器地址", text: $serverAddress)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                        TextField("8位配对码", text: $code)
                            .textInputAutocapitalization(.characters).autocorrectionDisabled()
                        Text("心率和时间经此服务器临时转发。仅保留最新读数20秒，不落库、不交给模型。结束时丢弃本应用运动总结，系统仍可能保留健康样本。")
                            .font(.caption2)
                        Toggle("同意临时转发", isOn: $consent)
                        Button(model.busy ? "正在连接…" : "配对并开始") {
                            let pairingCode = code
                            Task { await model.pairAndStart(address: serverAddress, code: pairingCode) }
                            code = ""
                        }.disabled(!consent || model.busy || model.finishing || code.isEmpty)
                        if model.busy { Button("取消") { model.stop() } }
                        Text(model.status).font(.footnote)
                    }
                    Text("仅辅助旅行节奏，不作医学判断。")
                        .font(.caption2).foregroundStyle(.secondary)
                }.padding(.horizontal, 4)
            }
        }
    }
}
