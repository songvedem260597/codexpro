import assert from "node:assert/strict";
import fs from "node:fs";

const main = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
const modal = fs.readFileSync(new URL("../src/features/chat/attachment-preview-modal.jsx", import.meta.url), "utf8");

assert.match(main, /import \{ AttachmentPreviewModal \} from "\.\/features\/chat\/attachment-preview-modal\.jsx";/, "main.jsx must consume the extracted attachment preview modal");
assert.match(main, /<AttachmentPreviewModal preview=\{attachmentPreview\} onClose=\{\(\) => setAttachmentPreview\(null\)\} \/>/, "App must keep attachment preview state ownership");
assert.doesNotMatch(main, /attachment-lightbox-backdrop/, "attachment lightbox implementation must stay out of main.jsx");
assert.doesNotMatch(main, /formatFileSize/, "main.jsx should no longer import file-size formatting only for the lightbox");
assert.match(modal, /export function AttachmentPreviewModal\(/, "attachment preview module must export the modal");
assert.match(modal, /if \(!preview\) return null;/, "null preview must render nothing");
assert.match(modal, /import \{ formatFileSize \} from "\.\.\/\.\.\/file-size\.js";/, "attachment preview must own file-size formatting");
assert.match(modal, /event\.key === "Escape"[\s\S]*?onClose\(\)/, "Escape must close the preview");
assert.match(modal, /event\.target === event\.currentTarget && onClose\(\)/, "backdrop click must close the preview");
assert.match(modal, /role="dialog" aria-modal="true" aria-label=\{`Xem trước \$\{preview\.name \|\| "file"\}`\}/, "dialog accessibility semantics must remain intact");
assert.match(modal, /preview\.loading[\s\S]*?preview\.kind === "image"[\s\S]*?preview\.kind === "text"[\s\S]*?Không thể xem trước file này/, "loading, image, text, and unsupported states must remain available");
assert.match(modal, /preview\.truncated \? " · chỉ hiển thị phần đầu" : ""/, "truncated preview metadata must remain visible");

console.log("attachment-preview-modal-smoke: ok");
