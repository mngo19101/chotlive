import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass

/// Giữ danh sách bình luận đứng yên chốc lát khi có bình luận chốt, để bấm in khỏi trượt sang dòng khác
/// (bật/tắt trong Tôi › Từ khoá chốt đơn). Tắt thì danh sách chạy như cũ.
enum LiveHold {
    static let enabledKey = "liveHoldOnClosing"
    /// Số giây giữ cố định; 0 là tự động theo độ đông của live.
    static let secondsKey = "liveHoldSeconds"
    static let options: [(value: String, title: String)] = [("0", "Tự động"), ("1", "1 giây"), ("2", "2 giây"), ("3", "3 giây")]
}

/// Quyết định lúc nào bình luận mới được hiện lên đầu danh sách khi đang ở trên cùng.
///
/// Bình luận mới đến thì nằm chờ, rồi được đẩy lên cả lô một lần (một lần xê dịch thay vì nhiều lần):
/// - cách lần đẩy trước ít nhất `minGap`,
/// - vừa hiện bình luận chốt thì giữ yên một lúc; tự động thì càng đông càng giữ ngắn để hàng chờ không phình,
/// - đang chạm tay (và một chút sau khi thả) thì giữ yên,
/// - nhưng không bình luận nào phải chờ quá `maxLag`.
@MainActor
final class CommentPacer: ObservableObject {
    static let minGap: TimeInterval = 0.7
    static let maxLag: TimeInterval = 4
    static let touchGrace: TimeInterval = 1.5
    /// Từ lúc mắt thấy tới lúc ngón tay chạm màn hình: danh sách xê dịch trong khoảng này là người bán đang nhắm vào chỗ cũ.
    static let reactionTime: TimeInterval = 0.35
    static let autoHoldMin: TimeInterval = 0.6
    static let autoHoldMax: TimeInterval = 2.5
    /// Chỉ giữ chừng 70% khoảng cách trung bình giữa hai bình luận chốt, để hàng chờ không dồn lên.
    static let autoHoldShare = 0.7
    static let rateWindow: TimeInterval = 20

    /// Chỉ hiện bình luận tới mốc này; nil là hiện hết.
    @Published private(set) var cutoff: Date?
    /// Đang giữ yên trong khi có bình luận chờ.
    @Published private(set) var holding = false
    /// Vừa bỏ qua một lần bấm in vì danh sách mới xê dịch.
    @Published private(set) var retapNotice = false

    /// Số giây giữ cố định, 0 là tự động.
    var fixedHold = 0
    private(set) var isActive = false
    private var latest: Date?
    private var waitingClosing = 0
    private var pendingSince: Date?
    private var holdUntil = Date.distantPast
    private var lastFlush = Date.distantPast
    private var lastShift = Date.distantPast
    private var closingTimes: [Date] = []
    private var activeSince = Date()
    private var noticeTask: Task<Void, Never>?

    /// Bật khi đang ở đầu danh sách; tắt (đang cuộn xuống đọc, hay tắt cài đặt) thì hiện hết như cũ.
    func setActive(_ on: Bool, newest: Date?, now: Date = Date()) {
        guard on != isActive else { return }
        isActive = on
        latest = newest
        cutoff = on ? newest : nil
        pendingSince = nil
        waitingClosing = 0
        holdUntil = .distantPast
        if on { activeSince = now }
        setHolding(false)
    }

    /// Có bình luận mới (danh sách mới nhất trước).
    func arrived(_ comments: [LiveComment], isClosing: (LiveComment) -> Bool,
                 touching: Bool, lastTouchUp: Date, now: Date = Date()) {
        guard isActive, let newest = comments.first?.ts else { return }
        guard let cut = cutoff else {
            cutoff = newest
            latest = newest
            return
        }
        latest = newest
        guard newest > cut else { return }
        waitingClosing = comments.prefix { $0.ts > cut }.filter(isClosing).count
        if pendingSince == nil { pendingSince = now }
        tick(touching: touching, lastTouchUp: lastTouchUp, now: now)
    }

    /// Gọi đều đặn (khoảng 0,1 giây) để đẩy hàng chờ lên khi hết giữ.
    func tick(touching: Bool, lastTouchUp: Date, now: Date = Date()) {
        guard isActive, let cut = cutoff, let latest, latest > cut, let since = pendingSince else {
            setHolding(false)
            return
        }
        let inHold = now < holdUntil
        let touchHold = touching || now.timeIntervalSince(lastTouchUp) < Self.touchGrace
        let tooLate = now.timeIntervalSince(since) >= Self.maxLag
        if !tooLate && (inHold || touchHold || now.timeIntervalSince(lastFlush) < Self.minGap) {
            setHolding(inHold || touchHold)
            return
        }
        cutoff = latest
        lastFlush = now
        pendingSince = nil
        setHolding(false)
        if waitingClosing > 0 {
            closingTimes.append(contentsOf: repeatElement(now, count: waitingClosing))
            holdUntil = now.addingTimeInterval(holdDuration(now: now))
        }
        waitingClosing = 0
    }

    /// Thời gian giữ sau khi hiện bình luận chốt.
    func holdDuration(now: Date = Date()) -> TimeInterval {
        if fixedHold > 0 { return TimeInterval(fixedHold) }
        closingTimes.removeAll { now.timeIntervalSince($0) > Self.rateWindow }
        let window = min(Self.rateWindow, max(5, now.timeIntervalSince(activeSince)))
        let rate = Double(closingTimes.count) / window
        guard rate > 0 else { return Self.autoHoldMax }
        return min(Self.autoHoldMax, max(Self.autoHoldMin, Self.autoHoldShare / rate))
    }

    /// Danh sách đang hiện vừa đổi chỗ.
    func noteShift(now: Date = Date()) { lastShift = now }

    /// Danh sách xê dịch ngay trước (hoặc trong lúc) chạm: người bán đang nhắm vào dòng ở chỗ cũ.
    /// Không biết lúc chạm (chưa gắn được bộ theo dõi chạm, hay bấm bằng VoiceOver) thì không chặn.
    func movedBeforeTap(touchDown: Date, now: Date = Date()) -> Bool {
        guard now.timeIntervalSince(touchDown) < 10 else { return false }
        return lastShift > touchDown.addingTimeInterval(-Self.reactionTime)
    }

    /// Báo ngắn "bấm lại" ở cuối màn, không chặn bấm.
    func showRetapNotice() {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
        noticeTask?.cancel()
        retapNotice = true
        noticeTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 1_400_000_000)
            guard !Task.isCancelled else { return }
            self?.retapNotice = false
        }
    }

    private func setHolding(_ on: Bool) {
        if holding != on { holding = on }
    }
}

/// Biết ngón tay đang chạm màn hình hay không, ở mọi màn hình. Gắn vào cửa sổ, không bao giờ nhận là cử chỉ
/// và không chặn chạm, nên nút bấm và cuộn vẫn chạy bình thường.
@MainActor
final class TouchWatcher: UIGestureRecognizer, UIGestureRecognizerDelegate {
    static let shared: TouchWatcher = {
        let watcher = TouchWatcher(target: nil, action: nil)
        watcher.cancelsTouchesInView = false
        watcher.delaysTouchesBegan = false
        watcher.delaysTouchesEnded = false
        watcher.requiresExclusiveTouchType = false
        watcher.delegate = watcher
        return watcher
    }()

    private var down = false
    /// Lúc ngón tay chạm xuống gần nhất.
    private(set) var lastDown = Date.distantPast
    /// Lúc thả tay gần nhất.
    private(set) var lastUp = Date.distantPast

    /// Đang chạm. Phòng khi lỡ mất sự kiện thả tay, chạm quá lâu coi như đã thả.
    var isTouching: Bool { down && Date().timeIntervalSince(lastDown) < 8 }

    func install() {
        guard view == nil else { return }
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap { $0.windows }
        (windows.first { $0.isKeyWindow } ?? windows.first)?.addGestureRecognizer(self)
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        down = true
        lastDown = Date()
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesEnded(touches, with: event)
        lifted(event)
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesCancelled(touches, with: event)
        lifted(event)
    }

    private func lifted(_ event: UIEvent) {
        let stillDown = event.allTouches?.contains { $0.phase != .ended && $0.phase != .cancelled } ?? false
        guard !stillDown else { return }
        down = false
        lastUp = Date()
        // Kết thúc lượt chạm này để nhận lượt sau từ đầu.
        state = .failed
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        true
    }
}
