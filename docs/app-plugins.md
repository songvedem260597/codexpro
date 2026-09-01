# App plugin cho CodexPro Manager

App plugin là một repo bên ngoài có giao diện web được build sẵn. CodexPro chỉ lưu đường dẫn repo và mở giao diện đó trong tab **Plugin**; mã nguồn plugin không được copy vào app.

## Manifest

Tạo file `.codexpro-plugin/plugin.json` trong thư mục gốc của repo:

```json
{
  "schema_version": 1,
  "id": "my-dashboard",
  "name": "My Dashboard",
  "version": "1.0.0",
  "description": "Dashboard riêng cho dự án",
  "ui": {
    "entry": "dist/index.html"
  }
}
```

- `id`: chữ thường, số và dấu gạch ngang; tối đa 64 ký tự.
- `ui.entry`: file HTML tương đối nằm trong repo. CodexPro chỉ phục vụ file này và tài nguyên nằm cùng thư mục con của nó.
- Các đường dẫn trong HTML nên là đường dẫn tương đối, ví dụ `./assets/index.js`.

## Cài và phát triển

1. Build giao diện plugin để tạo file ở `ui.entry`.
2. Mở tab **Plugin** trong CodexPro Manager.
3. Chọn **Cài từ repo** và chọn thư mục gốc của repo.
4. Sau khi sửa/build lại plugin, chọn **Reload plugin**. Không cần restart Manager.
5. **Gỡ plugin** chỉ xóa đăng ký trong `~/.codexpro/app-plugins.json`; repo và các file build không bị xóa.

## Taste Skill tích hợp sẵn

Tab **Plugin** có catalog dành cho [leonxlnx/taste-skill](https://github.com/leonxlnx/taste-skill). Nút **Cài Taste Skill** sẽ:

1. Clone nhánh `main` vào `~/.codexpro/app-plugin-repos/taste-skill`.
2. Quét `skills/*/SKILL.md` và sinh catalog giao diện cục bộ.
3. Đăng ký repo bằng manifest app plugin mà không restart Manager.
4. Cho phép tìm, xem và copy đầy đủ từng skill từ iframe sandbox.

Nút **Cập nhật** chỉ thực hiện fast-forward từ upstream, sinh lại catalog rồi reload plugin một lần. Có thể dùng CLI tương đương:

```powershell
npm --prefix manager run app-plugin:install -- taste-skill
```

## Ranh giới an toàn

Giao diện plugin chạy trong iframe sandbox, không có Node.js, Electron preload, local storage của Manager hoặc quyền truy cập DOM cha. Một plugin hỏng được đánh dấu riêng và không ngăn các plugin khác hoặc worker tiếp tục chạy. Plugin có thể gọi API HTTP/WebSocket của chính nó; API đặc quyền của CodexPro chưa được cấp trực tiếp cho plugin ở schema version 1.
