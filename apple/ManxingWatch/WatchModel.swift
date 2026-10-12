import Foundation
import Combine
import HealthKit

@MainActor
final class WatchModel: NSObject, ObservableObject {
    @Published private(set) var active = false
    @Published private(set) var busy = false
    @Published private(set) var finishing = false
    @Published private(set) var heartRate: Double?
    @Published private(set) var status = "等待网页配对码"
    private let health = HKHealthStore()
    private var workout: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?
    private var relay: RelayClient?
    private var token: String?
    private var expires = Date.distantPast
    private var latest: (bpm: Double, date: Date)?
    private var lastSent = Date.distantPast
    private var sequence = 0
    private var generation = 0
    private var timer: Timer?
    private var upload: Task<Void, Never>?

    func pairAndStart(address: String, code: String) async {
        guard !active, !busy, !finishing else { return }
        busy = true; generation += 1
        let attempt = generation
        var pairedToken: String?
        var client: RelayClient?
        do {
            guard HKHealthStore.isHealthDataAvailable() else {
                throw RelayFailure(status: 0, message: "此设备无法使用健康数据")
            }
            let endpoint = try RelayClient(address: address); client = endpoint
            let cleaned = code.filter { !$0.isWhitespace }.uppercased()
            let data = try await endpoint.post("pair", body: ["code": cleaned])
            let pair = try JSONDecoder().decode(PairReply.self, from: data)
            pairedToken = pair.token
            guard attempt == generation else { throw CancellationError() }
            let heartType = HKQuantityType.quantityType(forIdentifier: .heartRate)!
            try await health.requestAuthorization(toShare: [HKObjectType.workoutType()], read: [heartType])
            guard attempt == generation else { throw CancellationError() }
            let configuration = HKWorkoutConfiguration()
            configuration.activityType = .walking
            configuration.locationType = .outdoor
            let session = try HKWorkoutSession(healthStore: health, configuration: configuration)
            let live = session.associatedWorkoutBuilder()
            live.dataSource = HKLiveWorkoutDataSource(healthStore: health, workoutConfiguration: configuration)
            session.delegate = self; live.delegate = self
            workout = session; builder = live; relay = endpoint; token = pair.token
            expires = Date(timeIntervalSince1970: pair.expires_at / 1000)
            sequence = 0; lastSent = .distantPast; latest = nil; heartRate = nil
            let start = Date()
            session.startActivity(with: start)
            active = true; busy = false; status = "正在采集，请佩戴好手表并允许读取心率"
            live.beginCollection(withStart: start) { [weak self] success, _ in
                Task { @MainActor in
                    guard let self, self.generation == attempt else { return }
                    if !success { self.stop(message: "无法开始采集，请检查健康权限后重新配对") }
                }
            }
            timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.sendLatest() }
            }
        } catch {
            // Revoke even when cancellation arrives during pairing/authorization.
            if let client, let pairedToken { _ = try? await client.post("disconnect", body: [:], token: pairedToken) }
            if attempt == generation { busy = false; status = error.localizedDescription }
        }
    }
    private func sendLatest() {
        guard active else { return }
        guard Date() < expires else { stop(message: "连接已到期，请在网页重新配对"); return }
        if let latest, Date().timeIntervalSince(latest.date) > 20 { heartRate = nil }
        guard upload == nil, let latest, Date().timeIntervalSince(latest.date) <= 20,
              latest.date > lastSent, let relay, let token else { return }
        sequence += 1
        let seq = sequence, attempt = generation
        upload = Task {
            do {
                _ = try await relay.post("sample", body: ["bpm": latest.bpm,
                    "timestamp": Int64(latest.date.timeIntervalSince1970 * 1000), "sequence": seq], token: token)
                guard attempt == generation else { return }
                lastSent = latest.date; status = "已发送至当前网页行程"
            } catch {
                guard attempt == generation else { return }
                if let error = error as? RelayFailure, error.status == 401 {
                    stop(message: "网页已断开或配对失效，请重新配对"); return
                }
                if let error = error as? RelayFailure, error.status == 409 { lastSent = latest.date }
                status = "暂未送达，检查网络及手表时间；仅重试最新读数"
            }
            if attempt == generation { upload = nil }
        }
    }
    func stop(message: String = "已停止；重新连接请生成新配对码") {
        generation += 1; timer?.invalidate(); timer = nil
        upload?.cancel(); upload = nil
        let endpoint = relay, credential = token
        relay = nil; token = nil; latest = nil; heartRate = nil
        active = false; busy = false; status = message
        if let session = workout, let live = builder {
            finishing = true; workout = nil; builder = nil
            session.end()
            live.endCollection(withEnd: Date()) { [weak self] _, _ in
                live.discardWorkout()
                Task { @MainActor in self?.finishing = false }
            }
        }
        if let endpoint, let credential {
            Task {
                do { _ = try await endpoint.post("disconnect", body: [:], token: credential) }
                catch { /* No readings remain locally. Server data expires after 20 seconds. */ }
            }
        }
    }
}

extension WatchModel: HKWorkoutSessionDelegate {
    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didChangeTo toState: HKWorkoutSessionState,
                                    from fromState: HKWorkoutSessionState, date: Date) {
        if toState == .ended {
            Task { @MainActor in
                guard self.workout === workoutSession else { return }
                self.stop(message: "采集已结束，请重新配对")
            }
        }
    }
    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        Task { @MainActor in
            guard self.workout === workoutSession else { return }
            self.stop(message: "采集失败，请检查权限或其他正在进行的运动")
        }
    }
}
extension WatchModel: HKLiveWorkoutBuilderDelegate {
    nonisolated func workoutBuilderDidCollectEvent(_ workoutBuilder: HKLiveWorkoutBuilder) {}
    nonisolated func workoutBuilder(_ workoutBuilder: HKLiveWorkoutBuilder, didCollectDataOf collectedTypes: Set<HKSampleType>) {
        let type = HKQuantityType.quantityType(forIdentifier: .heartRate)!
        guard collectedTypes.contains(type), let statistics = workoutBuilder.statistics(for: type),
              let value = statistics.mostRecentQuantity(), let interval = statistics.mostRecentQuantityDateInterval() else { return }
        let bpm = value.doubleValue(for: HKUnit.count().unitDivided(by: .minute()))
        let date = interval.end
        guard bpm.isFinite, (25...240).contains(bpm), Date().timeIntervalSince(date) <= 20 else { return }
        Task { @MainActor in
            guard self.builder === workoutBuilder, self.active else { return }
            self.latest = (bpm, date); self.heartRate = bpm
        }
    }
}
