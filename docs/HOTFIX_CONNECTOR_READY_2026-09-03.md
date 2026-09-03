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

## Kiểm tra sau cài và bổ sung 0.5.107

- Sau khi cài 0.5.106, cả `1a5c4e8d` và `0261e4f4` đã heartbeat đúng version.
  Runtime tự restart khi hai worker rảnh. Cấu hình/tài khoản Chrome không bị thay.
- `1a5c4e8d` lúc `2026-09-02T20:30:25.413Z`: danh sách Plugins đã tải,
  không có candidate CodexPro; trả `missing` và hiển thị “Profile này chưa thêm
  CodexPro.”, không còn READY/Đã thêm từ cache.
- Kiểm tra chéo `0261e4f4` có một candidate nhưng không match. Không coi đây là
  bằng chứng chắc chắn vắng connector. Điều tra thấy 0.5.106 bỏ qua liên kết
  definition và loại mọi `<article>`, dù plugin card có thể dùng chính markup này.
  Test cho `<article><a href="/plugins/plugin_example">CodexPro</a></article>`
  thất bại trước sửa, đạt sau sửa.
- 0.5.107 cho phép link definition cùng origin trong đúng vùng danh sách, bỏ
  chặn article chung nhưng vẫn chặn transcript. Diagnostic và nhận diện dùng
  cùng scope; candidate không xác định được sẽ là `unknown`, không phải `missing`.
  `installedConnectorId()` cũng chỉ lấy từ link đã được xác minh, không tìm toàn trang.
- Các quyền, URL MCP và consent không được thêm/sửa trong thao tác kiểm tra.
  Chỉ phép setup do người dùng yêu cầu mới được phép kết nối connector.

### Kết quả cài 0.5.107

- Đã cài đè `/Applications/CodexPro Manager.app`; SHA-256 installer trong app
  trùng source (`e159259eaba4c0891b0f94e1d4eb166f5fb2b8e5d6eee00dd78f055ccff371b7`).
  Hai worker đang mở heartbeat 0.5.107; profile đang đóng không bị tự mở.
- `1a5c4e8d`, `2026-09-02T20:46:04.013Z`: danh sách đã tải, đúng scope,
  0 candidate CodexPro, trạng thái `missing`. Manager không còn báo READY giả.
- `0261e4f4`, `2026-09-02T20:45:40.493Z`: đã nhận đúng nút
  “Hành động cho CodexPro”, xác minh heading chi tiết; chưa đọc được trạng thái
  Connection nên trả `unknown`, không kết luận chưa cài hoặc READY.
  Chưa hoàn tất xác minh live profile này. Browser kiểm tra trực tiếp vẫn trả
  `Debugger unattached`; không thay bằng đọc cookie/profile store hoặc tự Connect.
- 0.5.107 đạt các smoke connector-verification, browser-agent, chat-link,
  chat-tab-limit, chat-tab-lifecycle; syntax check hai file extension;
  `npm run build`, `npm run manager:build`, `npm run manager:check` và
  `npx electron-builder --mac --dir` đạt.
- `npm run smoke` của lần 0.5.107 **không đạt**: dừng tại
  `scripts/smoke.mjs:50`, `timeout waiting for tools/call:apply_patch` (exit 1).
  Không tính kết quả full smoke của 0.5.106 thay cho lần này.

## Sửa tiếp 0.5.108: false missing và reload liên tục

Người dùng báo sau 0.5.107 cả hai profile đã có CodexPro nhưng Manager vẫn hiện
nút “Thêm CodexPro”. Đây là báo lỗi, không phải kết quả xác minh cả hai tài khoản.
Ba nguyên nhân độc lập được tái hiện:

1. `preparePluginSearch()` coi nút `Create app` của khung trang là kết quả tìm
   kiếm đã tải; danh sách xuất hiện trễ bị kết luận `missing`.
2. Trạng thái Connection chỉ được tìm trong button/link. ChatGPT hiện
   `Connection / Connected` bằng `div/span`, khiến kết quả thành `unknown`.
3. Manager dùng nút setup cho mọi trạng thái không READY và tự gọi check theo
   mỗi chu kỳ trạng thái. Trên macOS một-tab, check điều hướng tab sang Plugins
   rồi tải lại URL chat cũ; thời gian check dài hơn backoff nên có thể lặp ngay.

0.5.108 chờ riêng kết quả tìm kiếm, đọc trạng thái tĩnh trong đúng panel chi
tiết CodexPro, bỏ cả background check và background migration. Profile chưa rõ
chỉ hiện “Kiểm tra CodexPro”; “Thêm CodexPro” chỉ xuất hiện sau khi người dùng
chủ động kiểm tra và chính lần kiểm tra đó xác nhận `missing`. Bộ đếm “chưa cài”
cũng chỉ đếm các xác nhận thiếu trong phiên Manager hiện tại.

Kiểm thử đạt: connector-verification, browser-agent, chat-link, connected-worker
overview, manual-migration safety, DOM Electron với plugin xuất hiện trễ và
Connection dạng `div/span`, `npm run build`, `npm run manager:check` và
`npm run smoke` (exit 0).

## Sửa tiếp 0.5.109: phân biệt đã cài và chưa kết nối

Kiểm tra trực tiếp UI thật cho thấy `0261e4f4` có CodexPro trong mục **Đã cài
đặt**. Diagnostic panel Connection trả chuỗi **Kết nối**, nhưng chưa phân biệt
được đó là tiêu đề hay nút. 0.5.108 đã gộp trường hợp này vào `missing`, khiến
Manager lại hiện sai **Thêm CodexPro**.

0.5.109 dùng trạng thái riêng `disconnected`: Manager hiện **Chưa kết nối
CodexPro** và nút **Kết nối CodexPro**. Chỉ kết quả kiểm tra thủ công không tìm
thấy definition mới hiện **Chưa cài CodexPro** và **Thêm CodexPro**. Không có
thao tác cài hoặc kết nối tự động.

## Hoàn thiện 0.5.110: trạng thái xuyên worker → bridge → Manager

- Test mới tái hiện bridge bỏ `disconnected` thành `unknown`. Thêm trạng thái
  này vào cả bước nhận heartbeat và bước xuất snapshot; không nâng thành READY.
- Không coi nhãn tĩnh “Kết nối” là nút Connect. Phải có button/link/role=button
  hoặc trạng thái “chưa kết nối” rõ ràng mới kết luận disconnected. Chờ trạng
  thái tải trễ thay vì chốt ngay khi chỉ có tiêu đề. Diagnostic ghi tag/actionable.
- Test DOM bổ sung nhãn tiếng Việt, trạng thái tải trễ và heading không có giá
  trị. Kết quả mơ hồ phải là unknown, không tự kết nối hay thêm connector.
