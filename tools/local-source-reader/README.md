# CodexPro Local Source Reader

Extension thử nghiệm cho `chatgpt.com`: đọc source local **read-only**, attach full source một lần, sau đó các lần upload tiếp theo chỉ attach những file source đã thay đổi.

## Cách hoạt động mới

- Lần đầu chọn một project: tạo **FULL baseline** và attach đúng 1 snapshot.
- Sau khi FULL attach thành công, extension chỉ ghi nhớ metadata của baseline trong browser storage: `path + hash + size + lastModified`. **Không lưu nội dung source** vào storage.
- Lần sau chọn lại cùng project: quét lại source, so sánh hash và chỉ đưa nội dung file **mới / đã sửa** vào attachment DELTA.
- File đã bị xóa được liệt kê trong `DELETED FILES` để ChatGPT biết phải loại file đó khỏi baseline cũ.
- File không đổi không được đưa lại vào DELTA.
- Nếu không có thay đổi, extension không tạo attachment.
- Nút **Full lại** luôn cho phép upload lại toàn bộ source và đặt lại baseline, nên dùng khi chuyển sang một chat mới hoặc muốn reset trạng thái so sánh.

DELTA giả định FULL/DELTA trước đó vẫn nằm trong cùng cuộc trò chuyện ChatGPT. Nếu mở chat mới, hãy bấm **Full lại** trước.

## Mục tiêu

- Không MCP.
- Không native host.
- Không local server.
- Không `read_file` từng file rồi gửi hàng loạt message kỹ thuật vào chat.
- Không sửa/xóa/tạo file local.
- Mỗi lần bấm chỉ quét project một lượt và attach tối đa một snapshot text.

Implementation trong thư mục này là code riêng, cố tình bỏ toàn bộ agent loop và write path.

## Cách dùng

1. Mở `chrome://extensions`.
2. Bật **Developer mode**.
3. Chọn **Load unpacked**.
4. Chọn thư mục `tools/local-source-reader` hoặc thư mục local đã được workflow cài vào `~/CodexProLocalSourceReader`.
5. Reload extension và reload `https://chatgpt.com`.
6. Bấm **📂 Upload source**.
7. Chọn folder project, ví dụ CodexPro.
8. Lần đầu extension tạo `<project>-local-source-snapshot.txt` và attach vào ChatGPT.
9. Sau khi code thay đổi, bấm lại **📂 Upload source** và chọn cùng folder. Extension tạo `<project>-local-source-delta-rN.txt` chỉ chứa file code thay đổi/mới cùng danh sách file đã xóa.
10. Gõ yêu cầu và gửi message bình thường. Extension không tự submit prompt.

Nếu ChatGPT thay đổi DOM khiến auto-attach không tìm được file input, extension tải snapshot xuống máy làm fallback. Trong trường hợp fallback, baseline **không được cập nhật tự động** để tránh đánh dấu nhầm thay đổi là đã gửi.

## Snapshot FULL chứa gì

- metadata project;
- revision baseline;
- file tree của toàn bộ source được đưa vào;
- danh sách file bị lọc/bỏ qua;
- toàn bộ nội dung source theo marker `===== FILE: path =====`;
- chỉ dẫn để ChatGPT coi snapshot này là full source baseline hiện tại.

## Snapshot DELTA chứa gì

- previous/new baseline revision;
- danh sách `CHANGED / NEW FILES`;
- danh sách `DELETED FILES`;
- nội dung đầy đủ chỉ của file mới/đã sửa;
- danh sách thay đổi bị chặn bởi giới hạn kích thước nếu có.

Các file không xuất hiện trong DELTA được coi là không đổi so với baseline trước đó.

## Bộ lọc và giới hạn

Mặc định bỏ generated/dependency folders như `.git`, `node_modules`, `dist`, `build`, `.next`, `coverage`, cache, virtualenv, `target`, `vendor`; bỏ lockfiles, binary/minified/source-map và secret-looking files như `.env`, private keys, credential files.

Giới hạn an toàn:

- tối đa 5.000 source files;
- tối đa 3 MB cho một file;
- tối đa 50 MB text được theo dõi trong một snapshot.

Các file vượt giới hạn xuất hiện trong phần `SKIPPED / FILTERED` thay vì bị bỏ qua âm thầm.

## Baseline được ghi nhớ như thế nào

Baseline được lưu dưới key `codexproLocalSourceReaderBaselinesV1` trong browser storage của trang ChatGPT. Chỉ fingerprint/metadata được lưu, không lưu source text. Baseline được phân biệt theo tên folder project vì File System Access API không cung cấp absolute path cho trang web.

Nếu có hai project folder khác nhau nhưng trùng tên, dùng **Full lại** khi chuyển project để tránh dùng nhầm baseline.

## Read-only thực sự

`manifest.json` không xin quyền filesystem write. Picker gọi `showDirectoryPicker({ mode: "read" })`. Code không có `createWritable`, `removeEntry`, `getFileHandle(..., { create: true })` hay write API local nào.

Extension cũng **không tự submit prompt**. Nó chỉ tạo/attach snapshot; người dùng vẫn quyết định message nào được gửi.
