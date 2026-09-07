# CodexPro Local Source Reader

Extension read-only cho `chatgpt.com`: có hai nút **Upload Full** và **Upload thay đổi**, chỉ cập nhật baseline sau khi ChatGPT xác nhận upload thành công qua network, đồng thời giữ lịch sử snapshot để upload lại đúng bản cũ.

## Nguyên tắc quan trọng

**Attach vào composer chưa được tính là upload thành công.**

Một snapshot chỉ trở thành baseline mới khi extension thấy ChatGPT hoàn tất upload bằng một trong các tín hiệu network có xác nhận rõ ràng:

- `POST /backend-api/files/process_upload_stream` trả SSE có `status: "success"`; hoặc
- `POST /backend-api/files/{file_id}/uploaded` trả JSON có `status: "success"`; hoặc
- đường `files/library/reuse` chỉ được chấp nhận khi response trả explicit `status: "success"`.

`POST /backend-api/files` chỉ dùng để lấy `file_id`/đối chiếu file. Việc request này thành công, việc PUT bytes thành công, hoặc attachment chip xuất hiện trên UI **không tự động cập nhật baseline**.

Nếu upload timeout/thất bại hoặc người dùng xóa attachment trước khi ChatGPT hoàn tất upload, baseline cũ vẫn giữ nguyên. Vì vậy bấm **Upload thay đổi** lần nữa vẫn tạo/upload lại các file thay đổi đó.

## Hai nút upload

### Upload Full

- Quét toàn bộ source text hợp lệ của project.
- Tạo một FULL snapshot.
- Lưu snapshot vào lịch sử ở trạng thái `pending`.
- Attach snapshot vào ChatGPT.
- Chờ network confirmation.
- Chỉ khi network trả success mới chuyển snapshot thành `confirmed` và lưu baseline mới.

FULL mới tăng revision tiếp theo của baseline đã xác nhận thay vì reset revision về 1.

### Upload thay đổi

- Bắt buộc project đã có FULL/DELTA baseline được network-confirm trước đó.
- Luôn so source hiện tại với **baseline đã xác nhận gần nhất**, không so với lần vừa bấm Upload.
- Chỉ đưa file mới/đã sửa vào attachment; file xóa nằm trong `DELETED FILES`.
- Có thể bấm nhiều lần. Nếu lần trước chưa được ChatGPT network-confirm, baseline không đổi nên lần sau vẫn thấy và upload lại cùng thay đổi.
- Chỉ hiển thị `0 file thay đổi` khi source thực sự giống baseline đã được xác nhận.

Ví dụ:

```text
baseline r1: A=v1, B=v1
current:     A=v2, B=v1

Upload thay đổi -> snapshot r1->r2 chứa A=v2
xóa attachment trước khi network success
Upload thay đổi -> vẫn chứa A=v2

khi ChatGPT network SUCCESS:
baseline = r2

Upload thay đổi -> 0 file
```

Nếu trong lúc snapshot r1->r2 đang upload mà local file lại đổi từ `A=v2` sang `A=v3`, sau khi r2 được xác nhận baseline vẫn là đúng nội dung snapshot `v2`. Lần quét tiếp theo sẽ thấy `v3` là thay đổi mới.

## Lịch sử upload

Nút **Lịch sử** hiển thị các snapshot gần đây với trạng thái:

- `pending`: snapshot đã tạo nhưng chưa có network success;
- `failed`: upload lỗi/timeout;
- `confirmed`: ChatGPT đã xác nhận upload.

Mỗi item có nút **Upload lại**. Extension lưu exact snapshot blob trong IndexedDB, nên Upload lại dùng đúng nội dung snapshot của lần đó, không đọc lại filesystem rồi tạo một bản khác.

Nếu upload lại một snapshot đã `confirmed`, baseline không thay đổi. Nếu retry một snapshot `failed/pending`, baseline chỉ được advance nếu revision hiện tại vẫn đúng với `previousRevision` của snapshot; một history item cũ không được phép rollback một baseline mới hơn.

Mỗi project giữ tối đa 12 snapshot gần nhất để tránh IndexedDB tăng vô hạn.

## Persistence sau reload

Baseline được xác nhận lưu dưới key mới `codexproLocalSourceReaderBaselinesV2` trong `localStorage` của ChatGPT. Chỉ metadata/fingerprint được lưu:

- path;
- SHA-256/hash fallback;
- size;
- lastModified;
- revision;
- snapshot/file id network đã xác nhận.

Nội dung exact snapshot/history được lưu trong IndexedDB `codexproLocalSourceReaderV2`.

Không tự migrate baseline V1 vì phiên bản cũ từng coi việc attach thành công là đủ để advance baseline. Sau khi nâng extension lên 0.3.0, hãy **Upload Full một lần** để tạo baseline V2 thực sự được ChatGPT network-confirm.

## Cách dùng

1. Mở `chrome://extensions`.
2. Bật **Developer mode**.
3. Chọn **Load unpacked**.
4. Chọn thư mục `tools/local-source-reader` hoặc thư mục được workflow cài vào `~/CodexProLocalSourceReader`.
5. Reload extension và reload `https://chatgpt.com`.
6. Lần đầu bấm **Upload Full**, chọn folder project.
7. Chờ status báo `ChatGPT network SUCCESS` và baseline đã xác nhận.
8. Sau khi sửa code, bấm **Upload thay đổi**, chọn lại cùng folder.
9. Nếu xóa attachment hoặc upload lỗi trước confirmation, cứ bấm **Upload thay đổi** lại; diff chưa bị mất.
10. Muốn lấy snapshot cũ, mở **Lịch sử** và bấm **Upload lại**.

Extension chỉ attach file, không tự gửi prompt/message.

## Bộ lọc và giới hạn

Mặc định bỏ generated/dependency folders như `.git`, `node_modules`, `dist`, `build`, `.next`, `coverage`, cache, virtualenv, `target`, `vendor`; bỏ lockfiles, binary/minified/source-map và secret-looking files như `.env`, private keys, credential files.

Giới hạn:

- tối đa 5.000 source files;
- tối đa 3 MB cho một file;
- tối đa 50 MB text được theo dõi trong một snapshot.

Các file vượt giới hạn xuất hiện trong `SKIPPED / FILTERED` hoặc `CHANGED BUT NOT ATTACHED DUE TO LIMITS` thay vì bị bỏ qua âm thầm.

## Read-only

`showDirectoryPicker({ mode: "read" })` chỉ đọc source. Code không dùng `createWritable`, `removeEntry` hoặc filesystem write API. Extension cũng không tự submit prompt; người dùng vẫn quyết định message nào được gửi.
