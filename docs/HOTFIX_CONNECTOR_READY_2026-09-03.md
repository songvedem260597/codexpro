# Hotfix: profile chưa thêm/kết nối CodexPro nhưng Manager vẫn báo READY

## Báo lỗi và bằng chứng

Người dùng báo Chrome `1a5c4e8d` chưa thêm CodexPro trong ChatGPT nhưng thẻ
worker vẫn hiển thị `CodexPro READY` và `✓ Đã thêm CodexPro` (worker 0.5.105).
Snapshot runtime khi điều tra trả `connector_installed: true`,
`connector_profile_bound: true`, lần kiểm tra `2026-09-02T12:32:30.865Z`.
Đây là kết quả lưu cũ, không phải kiểm chứng trạng thái ChatGPT tại lúc chụp ảnh.

Các lỗi được xác định trong code và tái hiện bằng test:

1. Bộ nhận diện chấp nhận aria-label chung `Thao tác với plugin` và tìm trên
   toàn trang. Plugin khác/nút có chữ CodexPro ngoài danh sách có thể bị nhận nhầm.
2. Có definition trong danh sách bị coi là đã kết nối. Kiểm tra chuỗi
   `includes('connected')` còn nhận nhầm `disconnected`.
3. Bridge chấp nhận mọi snapshot `ok:true` dù cũ hơn kết quả âm tính mới.
   Heartbeat trong command và kết quả command gửi lại profile chụp trước kiểm tra.
4. Manager tin kết quả 24 giờ; lỗi kiểm tra giữ READY cũ. Bridge cũng không hết
   hạn bằng chứng và khôi phục kết quả này qua restart.

Không kết luận riêng selector nào đã gây ra screenshot: kết nối Browser chỉ
thấy Chrome `CHATGPT 1`, chưa điều khiển được đúng `1a5c4e8d`. CodexPro Bridge
online không đồng nghĩa tiện ích ChatGPT Browser đã kết nối ở cùng profile.

## Thay đổi

- `chrome-extension/connector-installer.js`: giới hạn tìm kiếm vào trang danh
  sách/Settings; bỏ aria chung; kiểm tra đúng heading CodexPro và trạng thái
  Connection riêng. Kiểm tra không bấm Connect hay cấp quyền. Giữ riêng phép
  kiểm tra definition phục vụ luồng setup/recovery.
- `chrome-extension/service-worker.js`: check cần cả definition và Connection;
  setup cũng xác minh lại Connection trước READY. Lưu rõ `connected`, `missing`,
  `unknown`; lỗi không giữ READY. Heartbeat/result đọc profile hiện tại.
  Hoãn kiểm tra khi bận hoặc tab Mac có bản nháp/tệp đính kèm/không đọc được an
  toàn; không đóng/điều hướng lại tab người dùng đã chuyển khỏi trang kiểm tra.
  Các bước đọc UI/điều hướng dùng thời hạn chung 100 giây; bridge dành 120 giây.
- `src/browserExtensionBridge.ts`: nhận bằng chứng theo timestamp cho cả hai
  chiều; cập nhật fingerprint cùng observation. Snapshot cũ chưa có trạng thái
  xác minh là unknown. READY hết hạn sau 15 phút; unknown/missing không tự kích
  hoạt xóa/tạo lại connector như một lỗi migration URL.
- `manager/src/profile-connector-check.js`, `manager/src/main.jsx`: xác minh lại
  khi mở Manager, kiểm tra lần lượt khi rảnh; làm mới sau 10 phút và thử lại
  unknown sau ít nhất 60 giây. Thẻ và bộ đếm không bỏ sót profile chưa sẵn sàng.
- Worker/Manager yêu cầu **0.5.106**, để updater không bỏ qua build mới.

## Kiểm thử

- `node scripts/connector-verification-smoke.mjs`: test nhận nhầm aria thất bại
  trước sửa; đạt sau sửa. Bao gồm list/connection/unknown, stale heartbeat,
  fingerprint, cache hết hạn, legacy cache, retry, bản nháp, đổi trang và deadline.
- `node scripts/browser-agent-smoke.mjs`, `node scripts/domless-send-smoke.mjs`,
  `node scripts/chat-link-smoke.mjs`, `node scripts/chat-tab-lifecycle-smoke.mjs`:
  đạt. Test mới được chạy cùng browser-agent smoke trong `npm run smoke`.
- `npm run build`, `npm run manager:check`, `npm run smoke`: đạt.
  Full smoke có cảnh báo cổng 9224 đang được runtime thật dùng; các test hoàn tất
  exit 0. Không restart runtime khi smoke đang chạy.

## Triển khai / đồng bộ

Push cùng bản sửa lên `mac` và `hotfix`; không đưa các thay đổi UI stopped-profile
đang làm dở hoặc ảnh/build output khác vào commit này. Win cần port thay đổi
liên quan, giữ nguyên chính sách tab và tích hợp nền tảng.

Build/test không thay thế xác minh live trên profile đang lỗi. Sau khi cập nhật
app/runtime và worker 0.5.106, cần kiểm tra profile vắng connector hiện cảnh báo,
profile đã kết nối hiện READY, đồng thời bản nháp và task khác không bị gián đoạn.
