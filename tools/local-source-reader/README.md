# CodexPro Local Source Reader

Extension thử nghiệm cho `chatgpt.com` theo đúng mục tiêu: **đọc source local read-only một lần và đưa vào ChatGPT bằng đúng 1 attachment**.

## Mục tiêu

- Không MCP.
- Không native host.
- Không local server.
- Không `read_file` từng file rồi gửi hàng loạt message kỹ thuật vào chat.
- Không sửa/xóa/tạo file local.
- Mỗi lần bấm chỉ quét project một lượt, tạo một snapshot text duy nhất rồi attach vào composer.

Ý tưởng được rút gọn từ cách Browser AI Agent dùng File System Access API, Folio dùng workspace local read-only, và Rel.AI dùng full-repo context/attachment. Implementation trong thư mục này là code riêng, cố tình bỏ toàn bộ agent loop và write path.

## Cách dùng

1. Mở `chrome://extensions`.
2. Bật **Developer mode**.
3. Chọn **Load unpacked**.
4. Chọn thư mục `tools/local-source-reader`.
5. Reload `https://chatgpt.com`.
6. Bấm nút **📂 Đọc source local** ở góc phải.
7. Chọn folder project, ví dụ folder CodexPro trên ổ C:.
8. Extension chỉ xin quyền **read**, quét source, tạo `<project>-local-source-snapshot.txt` và tự attach vào ChatGPT.
9. Gõ yêu cầu của bạn và gửi **một message bình thường**. Không có tool-call/result message trung gian.

Nếu ChatGPT thay đổi DOM khiến auto-attach không tìm được file input, extension sẽ tải snapshot xuống máy làm fallback. Kéo đúng **một file snapshot** đó vào composer rồi gửi.

## Snapshot chứa gì

Snapshot gồm:

- metadata project;
- file tree của toàn bộ source được đưa vào;
- danh sách file bị lọc/bỏ qua;
- toàn bộ nội dung source theo marker `===== FILE: path =====`;
- một chỉ dẫn ngắn để ChatGPT coi snapshot này là source-of-truth hiện tại.

Mặc định bỏ generated/dependency folders như `.git`, `node_modules`, `dist`, `build`, `.next`, `coverage`, cache, virtualenv, `target`, `vendor`; bỏ lockfiles, binary/minified/source-map và secret-looking files như `.env`, private keys, credential files.

Giới hạn an toàn hiện tại:

- tối đa 5.000 source files;
- tối đa 3 MB cho một file;
- tối đa 50 MB text trong một snapshot.

Các file vượt giới hạn sẽ xuất hiện trong phần `SKIPPED / FILTERED` thay vì bị bỏ qua âm thầm.

## Read-only thực sự

`manifest.json` không xin quyền filesystem write. Picker gọi `showDirectoryPicker({ mode: "read" })`. Code không có `createWritable`, `removeEntry`, `getFileHandle(..., { create: true })` hay bất kỳ write API nào.

Extension cũng **không tự submit prompt**. Nó chỉ tạo/attach snapshot; người dùng vẫn quyết định message nào được gửi.

## Tại sao không dùng agent loop

Folio/Browser AI Agent dùng vòng `list/read -> TOOL_RESULT -> AI hỏi tiếp`, phù hợp agent tương tác nhưng tạo nhiều technical turns. Nhánh này cố tình làm ngược lại: local source được đóng gói thành **một snapshot duy nhất** để ChatGPT đọc/audit trong một lượt, đúng cho trường hợp muốn hiểu cả project trước khi trao đổi tiếp.
