# Hotfix: Chrome 0261e4f4 không tải tin nhắn / tab cuối biến mất

## Bằng chứng và nguyên nhân

- Manager ghi nhận hai lần `get-profile-response` timeout khoảng 75 giây lúc
  16:12:04 và 16:13:20 UTC ngày 2026-09-02. Conversation được chọn nằm trong
  lịch sử gần đây nhưng không còn mở ở tab hiện tại.
- Luồng đọc cũ vẫn mở/điều hướng conversation và chờ tải trang ngay cả khi chỉ
  đọc network/canonical. Vì thế việc đọc lịch sử phụ thuộc không cần thiết vào
  giới hạn tab và trạng thái renderer.
- Test tái hiện xác định: `waitForTab` đọc trạng thái `loading` trước khi đăng ký
  listener; sự kiện `complete` chen giữa bị bỏ lỡ. Tab đã tải xong nhưng lời gọi
  vẫn báo `ChatGPT tải quá lâu` (thực tế có thể chờ 45 giây).
- Nhánh health cleanup còn đóng tab Mac cuối trước khi tạo tab thay thế. Điều
  này có thể đóng cửa sổ profile/worker; fix trước chỉ bảo vệ nhánh recovery khác.
- Các build khác nhau cùng mang version 0.5.104 nên updater có thể bỏ qua reload.
  Bản này tăng đồng bộ manifest, Electron và UI lên **0.5.105**.

Mất heartbeat lúc 16:13:41 UTC chưa đủ chứng minh Chrome crash hay bị đóng bởi
health cleanup. Không coi lỗi chờ tải là lời giải thích chắc chắn cho mọi lần
mất profile; cần đối chiếu lifecycle event và crash evidence khi tái diễn.

## Thay đổi

- `chrome-extension/service-worker.js`: đọc conversation chưa mở từ canonical
  API trên tab ChatGPT cùng profile, không điều hướng/đóng tab. Vẫn kiểm tra
  conversation thuộc ba chat gần nhất; không mượn network/busy state của tab nguồn.
  Network-only trả nhanh để Manager chuyển sang đọc canonical; lỗi canonical
  được trả rõ ràng, không tự mở tab mới để che lỗi.
- `waitForTab`: đăng ký listener trước khi đọc status; dọn listener/timer khi
  thành công, timeout, lỗi hoặc tab bị đóng.
- Health cleanup: tạo tab thay thế trước khi đóng tab Mac cuối; lỗi tạo thì giữ
  tab cũ và ghi `health_replacement_failed`. Giữ nguyên bảo vệ tab bận và cap Win.
- Thêm test thực thi cho race tải trang, thay tab an toàn, lỗi tạo, tab được bảo
  vệ, đọc lịch sử không điều hướng và phân tách conversation. Đưa vào `npm run smoke`.

## Kiểm chứng

- Test race thất bại trước sửa, đạt sau sửa.
- `node scripts/chat-tab-lifecycle-smoke.mjs`: đạt.
- `node scripts/unopened-chat-response-smoke.mjs`: đạt.
- `node scripts/chat-tab-limit-smoke.mjs`: đạt.
- `node scripts/chat-link-smoke.mjs`: đạt.
- `node scripts/browser-agent-smoke.mjs`: đạt.
- `npm run build`, `npm run manager:check`, `npm run smoke`: đạt.
- `npx electron-builder --mac --dir`: đạt (build không ký).
- SHA-256 worker nguồn và worker đóng gói/cài vào Applications trùng nhau.
- Đã cài `/Applications/CodexPro Manager.app`, bản trước được giữ trong
  `/tmp/codexpro-pre-hotfix-install.TBix9W/` để rollback trong phiên này.
- Manager thực tế ghi nhận `1a5c4e8d` và `e3b58d66` chuyển 0.5.104 → 0.5.105
  lúc 16:43:02 UTC. `0261e4f4` vẫn disconnected, chưa xác nhận reload/test được.
- Sau cài app, runtime đã restart trong khi smoke còn chạy; cổng 9224 không
  listen. Sau khi smoke kết thúc, restart LaunchAgent đã khôi phục cả 8787 và
  9224 trên cùng process. Không dùng trạng thái tạm này để kết luận Chrome crash.

## Lưu ý triển khai/đồng bộ Win

Chỉ port các thay đổi liên quan từ commit hotfix; không ghi đè toàn bộ nhánh Mac
sang Win. Giữ cap ba tab của Win, một tab của Mac, native focus/autostart/headless.
Updater hoãn reload worker bận. Build app mới không đồng nghĩa extension đang
chạy đã reload: cần xác nhận heartbeat báo 0.5.105.

Kiểm thử trực tiếp ChatGPT bằng Browser trong phiên này bị chặn do native-host
của plugin Browser chưa được cấu hình, dù tiện ích đã bật ở Profile 22. Không
coi test source/build là xác nhận end-to-end Chrome thật.
