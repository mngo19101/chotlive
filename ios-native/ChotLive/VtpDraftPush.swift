import SwiftUI
import UIKit

/// Màu thương hiệu Viettel Post cho nút "Đẩy nháp VTP" và nhãn "Nháp VTP".
enum VtpDraftColors {
    static let brand = Color(hex: 0xEE0033)
    static let ink = Color.dynamic(0xD1002D, 0xFF6B86)
    static let soft = Color.dynamic(0xFFEEF2, 0x3A1620)
}

// MARK: - Bảng "Đẩy N khách vào nháp"

/// Đẩy lần lượt từng khách vào mục Đơn nháp trên viettelpost.vn, từ máy này (VtpDraftClient).
/// Viettel Post CHƯA nhận đơn, chưa gọi bưu tá. Khách có nháp cũ (đã sửa sau khi đẩy) thì xoá nháp cũ rồi đẩy mới.
struct VtpDraftPushSheet: View {
    let groups: [Vtp.Group]
    let service: String
    @EnvironmentObject var vtpDraft: VtpDraftClient
    @EnvironmentObject var store: Store
    @EnvironmentObject var ui: AppUI

    struct Outcome: Identifiable {
        var id: String          // mã khách
        var name: String
        var code: String?
        var error: String?
        var skipped = false
        var note: String?
    }

    @State private var running = false
    @State private var stopRequested = false
    @State private var done = 0
    @State private var outcomes: [Outcome] = []
    @State private var finished = false
    /// Dừng cả lượt vì lỗi chung (bị chặn, hết phiên): lý do hiện trên cùng.
    @State private var haltReason: String?

    private var okCount: Int { outcomes.filter { $0.code != nil && !$0.skipped }.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    T(finished ? "Đã đẩy \(okCount)/\(groups.count) khách" : "Đẩy \(groups.count) khách vào nháp",
                      20, .heavy, Theme.ink, track: -0.3)
                    T("Dịch vụ \(service.isEmpty ? Vtp.defaultService : service)", 12.5, .medium, Theme.muted)
                }
                Spacer()
                if !running {
                    Button { ui.dismissSheet() } label: {
                        Icon(name: .close, size: 17, weight: 2.4).frame(width: 36, height: 36).background(Circle().fill(Theme.field))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.bottom, 12)

            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 12) {
                    if !finished && !running {
                        T("Đơn vào mục Đơn nháp trên viettelpost.vn. Viettel Post CHƯA nhận đơn, chưa gọi bưu tá. Bạn duyệt lại trên web Viettel Post, hoặc quay lại đây bấm Lên vận đơn.",
                          13.5, .medium, Theme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    accountRow
                    if running || finished { progress }
                    if let haltReason {
                        T(haltReason, 13, .bold, Theme.red).fixedSize(horizontal: false, vertical: true)
                    }
                    if !outcomes.isEmpty { results }
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.bottom, 12)
            }
            .frame(maxHeight: .infinity)

            footer
                .padding(.horizontal, Metrics.gutter)
                .padding(.top, 14)
                .background(Theme.card.overlay(alignment: .top) { HairLine() })
        }
        .frame(height: Metrics.sheetHeight(top: UIScreen.main.bounds.height * 0.25))
    }

    private var accountRow: some View {
        HStack(spacing: 11) {
            T("VTP", 12, .heavy, .white)
                .frame(width: 38, height: 38)
                .background(RoundedRectangle(cornerRadius: 11, style: .continuous).fill(VtpDraftColors.brand))
            VStack(alignment: .leading, spacing: 2) {
                T("Đăng nhập trên máy này", 14, .bold)
                T([vtpDraft.phone, vtpDraft.selectedKho?.name ?? "chưa có kho", "phiên tự làm mới"]
                    .filter { !$0.isEmpty }.joined(separator: " · "), 12, .medium, Theme.muted)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            if !running {
                Button {
                    ui.dismissSheet()
                    ui.push(.vtpDraft)
                } label: { T("Đổi", 13, .bold, Theme.accent) }
                .buttonStyle(.plain)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.field))
    }

    private var progress: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                T("Đã đẩy \(done)/\(groups.count)", 13, .bold)
                Spacer()
                T(finished ? "Xong" : "Đang đẩy…", 13, .bold, finished ? Theme.green : Theme.muted)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.track)
                    Capsule().fill(Theme.green)
                        .frame(width: groups.isEmpty ? 0 : geo.size.width * CGFloat(done) / CGFloat(groups.count))
                }
            }
            .frame(height: 8)
        }
    }

    private var results: some View {
        VStack(spacing: 0) {
            ForEach(Array(outcomes.enumerated()), id: \.element.id) { i, o in
                if i > 0 { HairLine() }
                resultRow(o)
            }
        }
        .cardStyle(16)
    }

    private func resultRow(_ o: Outcome) -> some View {
        let failed = o.error != nil
        let mark = failed ? "✕" : (o.skipped ? "–" : "✓")
        let markColor = failed ? Theme.red : (o.skipped ? Theme.muted : Theme.green)
        return HStack(alignment: .top, spacing: 10) {
            T(mark, 14, .heavy, markColor).frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                T(o.name, 14, .bold).lineLimit(1)
                if let e = o.error {
                    T(e, 12.5, .semibold, Theme.red).fixedSize(horizontal: false, vertical: true)
                } else if let c = o.code {
                    T((o.skipped ? "Đã có nháp " : "Mã nháp ") + c, 12.5, .medium, Theme.muted)
                }
                if let n = o.note {
                    T(n, 12, .semibold, Theme.gomInk).fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 4)
            if failed && !running {
                Button {
                    ui.dismissSheet()
                    ui.push(.addressEdit(o.id))
                } label: { T("Sửa", 13, .bold, Theme.accent) }
                .buttonStyle(.plain)
            }
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 12)
    }

    @ViewBuilder private var footer: some View {
        if running {
            OutlineButton(title: stopRequested ? "Đang dừng…" : "Dừng sau khách này", color: Theme.red, height: 52) {
                stopRequested = true
            }
        } else if finished {
            HStack(spacing: 10) {
                OutlineButton(title: "Đóng", height: 52) { ui.dismissSheet() }
                PrimaryButton(title: "Mở viettelpost.vn", fontSize: 15) {
                    if let url = URL(string: "https://viettelpost.vn/") { UIApplication.shared.open(url) }
                }
            }
        } else {
            VStack(spacing: 8) {
                HStack(spacing: 10) {
                    OutlineButton(title: "Huỷ", height: 52) { ui.dismissSheet() }
                        .frame(width: (Metrics.screenWidth - 50) / 3)
                    PrimaryButton(title: "Đẩy \(groups.count) khách", fontSize: 15,
                                  enabled: !groups.isEmpty && vtpDraft.selectedKho != nil) {
                        start()
                    }
                }
                if vtpDraft.selectedKho == nil {
                    T("Chưa có kho lấy hàng cho nháp. Bấm Đổi để chọn kho.", 12.5, .semibold, Theme.red)
                }
            }
        }
    }

    // MARK: Chạy

    private func start() {
        guard !running, let kho = vtpDraft.selectedKho else { return }
        running = true
        stopRequested = false
        done = 0
        outcomes = []
        haltReason = nil
        let svc = service
        let account = vtpDraft.phone
        let list = groups
        Task { @MainActor in
            for (i, g) in list.enumerated() {
                if stopRequested { break }
                let r = await pushOne(g, kho: kho, service: svc, account: account)
                outcomes.append(r.outcome)
                done = i + 1
                if let halt = r.halt {
                    haltReason = halt
                    break
                }
                // Giãn cách nhỏ giữa các khách: Viettel Post chặn nếu gửi dồn dập.
                try? await Task.sleep(nanoseconds: 400_000_000)
            }
            running = false
            finished = true
        }
    }

    /// Một khách: kiểm lỗi, xoá nháp cũ nếu đã sửa, tra mã địa chỉ, lưu nháp, ghi vào đơn.
    /// Lỗi chung (bị chặn, hết phiên) trả `halt` để dừng cả lượt và không ghi lỗi vào đơn của khách.
    private func pushOne(_ g: Vtp.Group, kho: VtpDraftKho, service: String,
                         account: String) async -> (outcome: Outcome, halt: String?) {
        let name = g.summary.receiver.isEmpty ? g.customer.nickname : g.summary.receiver
        var out = Outcome(id: g.customer.id, name: name)
        let problems = VtpDraftBody.problems(g)
        if !problems.isEmpty {
            out.error = problems.joined(separator: " · ")
            return (out, nil)
        }
        var oldCodes: [String] = []
        switch VtpDraftBody.status(g, service: service) {
        case .pushed(let code, _):
            out.code = code
            out.skipped = true
            return (out, nil)
        case .stale:
            oldCodes = VtpDraftBody.codes(g)
        default:
            break
        }
        do {
            // Nháp cũ: xoá trước để không còn hai nháp cho cùng khách. Xoá lỗi thì vẫn đẩy mới và báo để xoá tay.
            var leftover: [String] = []
            for c in oldCodes {
                do { try await vtpDraft.deleteDraft(c) } catch { leftover.append(c) }
            }
            if !leftover.isEmpty {
                out.note = "Chưa xoá được nháp cũ \(leftover.joined(separator: ", ")) trên Viettel Post, hãy xoá tay trên web."
            }
            let place = try await vtpDraft.locate(VtpDraftBody.addressLine(g))
            let body = VtpDraftBody.make(g, kho: kho, place: place, service: service)
            let code = try await vtpDraft.insertDraft(body)
            store.markDraft(g.orders, code: code, hash: VtpDraftBody.hash(g, service: service), account: account)
            out.code = code
            return (out, nil)
        } catch let e as VtpDraftError {
            let msg = e.errorDescription ?? "Lỗi"
            out.error = msg
            switch e {
            case .blocked, .sessionExpired, .notLoggedIn:
                return (out, msg)
            default:
                store.markDraftError(g.orders, error: msg)
                return (out, nil)
            }
        } catch {
            out.error = error.localizedDescription
            store.markDraftError(g.orders, error: error.localizedDescription)
            return (out, nil)
        }
    }
}
