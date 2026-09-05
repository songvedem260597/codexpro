import { app, clipboard, dialog, nativeImage } from "electron";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_REQUEST_ATTACHMENTS = 4;
export const MAX_REQUEST_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_REQUEST_ATTACHMENTS_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_REQUEST_TEXT_PREVIEW_BYTES = 512 * 1024;

export function mimeTypeForFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json",
    ".js": "text/javascript", ".jsx": "text/javascript", ".ts": "text/typescript", ".tsx": "text/typescript",
    ".html": "text/html", ".css": "text/css", ".xml": "application/xml", ".yaml": "application/yaml", ".yml": "application/yaml",
    ".pdf": "application/pdf", ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".zip": "application/zip"
  })[extension] || "application/octet-stream";
}

export function requestFileSummary(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`Không phải file hợp lệ: ${path.basename(resolved)}`);
  const mimeType = mimeTypeForFile(resolved);
  let previewDataUrl = "";
  if (mimeType.startsWith("image/")) {
    try {
      const image = nativeImage.createFromPath(resolved);
      if (!image.isEmpty()) {
        const { width, height } = image.getSize();
        const longest = Math.max(width, height, 1);
        const scale = Math.min(1, 96 / longest);
        const thumbnail = scale < 1
          ? image.resize({
              width: Math.max(1, Math.round(width * scale)),
              height: Math.max(1, Math.round(height * scale)),
              quality: "good"
            })
          : image;
        previewDataUrl = thumbnail.toDataURL();
      }
    } catch {
      previewDataUrl = "";
    }
  }
  return { path: resolved, name: path.basename(resolved), size: stat.size, mimeType, previewDataUrl };
}

function canPreviewRequestFileAsText(mimeType) {
  return String(mimeType || "").startsWith("text/")
    || ["application/json", "application/xml", "application/yaml"].includes(String(mimeType || ""));
}

export async function requestFilePreview(filePath) {
  const summary = requestFileSummary(filePath);
  if (summary.size > MAX_REQUEST_ATTACHMENT_BYTES) throw new Error("File lớn quá 8 MB nên không thể xem trước.");
  if (summary.mimeType.startsWith("image/")) {
    const bytes = await fs.promises.readFile(summary.path);
    return {
      kind: "image",
      name: summary.name,
      size: summary.size,
      mimeType: summary.mimeType,
      dataUrl: `data:${summary.mimeType};base64,${bytes.toString("base64")}`
    };
  }
  if (canPreviewRequestFileAsText(summary.mimeType)) {
    const handle = await fs.promises.open(summary.path, "r");
    try {
      const bytesToRead = Math.min(summary.size, MAX_REQUEST_TEXT_PREVIEW_BYTES);
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
      return {
        kind: "text",
        name: summary.name,
        size: summary.size,
        mimeType: summary.mimeType,
        text: buffer.subarray(0, bytesRead).toString("utf8"),
        truncated: summary.size > bytesRead
      };
    } finally {
      await handle.close();
    }
  }
  return { kind: "unsupported", name: summary.name, size: summary.size, mimeType: summary.mimeType };
}

export async function chooseRequestFiles() {
  const result = await dialog.showOpenDialog({
    title: "Chọn file gửi cùng yêu cầu",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Tài liệu, mã nguồn và hình ảnh", extensions: ["txt", "md", "csv", "json", "js", "jsx", "ts", "tsx", "html", "css", "xml", "yaml", "yml", "pdf", "doc", "docx", "xls", "xlsx", "png", "jpg", "jpeg", "gif", "webp", "zip"] },
      { name: "Tất cả file", extensions: ["*"] }
    ]
  });
  if (result.canceled) return [];
  if (result.filePaths.length > MAX_REQUEST_ATTACHMENTS) throw new Error("Mỗi yêu cầu được đính kèm tối đa 4 file.");
  const files = result.filePaths.map(requestFileSummary);
  if (files.some((file) => file.size > MAX_REQUEST_ATTACHMENT_BYTES)) throw new Error("Mỗi file được tối đa 8 MB.");
  if (files.reduce((total, file) => total + file.size, 0) > MAX_REQUEST_ATTACHMENTS_TOTAL_BYTES) throw new Error("Tổng file đính kèm được tối đa 10 MB.");
  return files;
}

export async function materializeApiWorkerRequest(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const text = String(source.text || source.request || "").trim().slice(0, 20_000);
  const requestedFiles = Array.isArray(source.attachments) ? source.attachments.slice(0, MAX_REQUEST_ATTACHMENTS) : [];
  if (!text && !requestedFiles.length) throw new Error("Hãy nhập yêu cầu hoặc chọn ít nhất một file.");
  const files = requestedFiles.map((file) => requestFileSummary(file?.path));
  if (files.some((file) => file.size > MAX_REQUEST_ATTACHMENT_BYTES)) throw new Error("Mỗi file được tối đa 8 MB.");
  if (files.reduce((total, file) => total + file.size, 0) > MAX_REQUEST_ATTACHMENTS_TOTAL_BYTES) throw new Error("Tổng file đính kèm được tối đa 10 MB.");

  const content = [{ type: "text", text: text || "Hãy xử lý các file đính kèm theo yêu cầu phù hợp với nội dung của chúng." }];
  for (const file of files) {
    if (file.mimeType.startsWith("image/")) {
      const bytes = await fs.promises.readFile(file.path);
      content.push({ type: "image_url", image_url: { url: `data:${file.mimeType};base64,${bytes.toString("base64")}` } });
      continue;
    }
    if (canPreviewRequestFileAsText(file.mimeType)) {
      const bytes = await fs.promises.readFile(file.path);
      const attachmentText = bytes.subarray(0, MAX_REQUEST_TEXT_PREVIEW_BYTES).toString("utf8");
      content[0].text += `\n\n<attachment name="${file.name}" mime="${file.mimeType}">\n${attachmentText}${bytes.length > MAX_REQUEST_TEXT_PREVIEW_BYTES ? "\n[Đã cắt bớt nội dung file; dùng MCP để đọc tiếp.]" : ""}\n</attachment>`;
      continue;
    }
    content[0].text += `\n\nFile đính kèm: ${file.name} (${file.mimeType}) tại ${file.path}. Hãy dùng MCP trong workspace đã khóa để đọc file này.`;
  }
  return { ...source, text, attachments: undefined, attachment_names: files.map((file) => file.name), messages: [{ role: "user", content }] };
}

async function clipboardImagePng() {
  if (typeof clipboard.readImage === "function") {
    const image = await Promise.resolve(clipboard.readImage());
    if (!image?.isEmpty?.()) return image.toPNG();
  }
  if (typeof clipboard.read === "function") {
    const items = await clipboard.read();
    for (const item of items || []) {
      const imageType = (item.types || []).find((type) => /^image\/(png|jpeg|jpg|webp)$/i.test(type));
      if (imageType) {
        const blob = await item.getType(imageType);
        if (blob instanceof Blob) {
          const buffer = Buffer.from(await blob.arrayBuffer());
          if (/^image\/png$/i.test(imageType)) return buffer;
          const image = nativeImage.createFromBuffer(buffer);
          if (!image.isEmpty()) return image.toPNG();
        }
      }
      if ((item.types || []).includes("text/uri-list")) {
        const blob = await item.getType("text/uri-list");
        if (!(blob instanceof Blob)) continue;
        const urls = (await blob.text()).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
        for (const url of urls) {
          if (!url.startsWith("file://")) continue;
          const filePath = fileURLToPath(url);
          if (!/\.(png|jpe?g|gif|webp)$/i.test(filePath) || !fs.existsSync(filePath)) continue;
          const image = nativeImage.createFromBuffer(await fs.promises.readFile(filePath));
          if (!image.isEmpty()) return image.toPNG();
        }
      }
    }
  }
  return null;
}

export async function captureClipboardImage() {
  const png = await clipboardImagePng();
  if (!png?.length) return null;
  if (png.length > MAX_REQUEST_ATTACHMENT_BYTES) throw new Error("Ảnh trong clipboard lớn quá 8 MB.");
  const directory = path.join(app.getPath("temp"), "codexpro-manager", "clipboard-images");
  await fs.promises.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `clipboard-${Date.now()}-${randomBytes(4).toString("hex")}.png`);
  await fs.promises.writeFile(filePath, png, { flag: "wx" });
  return requestFileSummary(filePath);
}
