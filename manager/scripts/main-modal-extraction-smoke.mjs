import assert from "node:assert/strict";
import fs from "node:fs";

const main = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
const workerModal = fs.readFileSync(new URL("../src/features/profiles/worker-update-confirm-modal.jsx", import.meta.url), "utf8");
const inspectionModal = fs.readFileSync(new URL("../src/features/projects/inspection-modal.jsx", import.meta.url), "utf8");

assert.match(main, /import \{ WorkerUpdateConfirmModal \}/, "main.jsx must import worker update modal");
assert.match(main, /import \{ InspectionModal \}/, "main.jsx must import inspection modal");
assert.match(main, /<WorkerUpdateConfirmModal[\s\S]*?open=\{workerUpdateConfirmOpen\}/, "App must keep worker update state ownership");
assert.match(main, /<InspectionModal inspection=\{inspection\}/, "App must keep inspection state ownership");
assert.doesNotMatch(main, /className="worker-update-dialog"/, "worker update implementation must stay out of main.jsx");
assert.doesNotMatch(main, /className="modal codexgraph-modal"/, "inspection implementation must stay out of main.jsx");
assert.doesNotMatch(main, /const CodeGraphView =/, "CodeGraph lazy dependency must move with inspection modal");
assert.match(workerModal, /if \(!open\) return null;/, "closed worker update modal must render nothing");
assert.match(workerModal, /onMouseDown=.*event\.target === event\.currentTarget && onClose\(\)/, "worker update backdrop must close modal");
assert.match(workerModal, /onClick=\{onConfirm\}>Cập nhật worker/, "worker update confirm action must remain wired");
assert.match(inspectionModal, /React\.lazy\(\(\) => import\("\.\.\/\.\.\/code-graph-view\.jsx"\)/, "inspection modal must own lazy CodeGraph dependency");
assert.match(inspectionModal, /CodeGraphView graphData=\{inspection\.result\.codexgraph\}/, "inspection modal must render CodeGraph data");
assert.match(inspectionModal, /aria-label="Đóng kiểm tra workspace"/, "inspection close control must remain accessible");

console.log("main-modal-extraction-smoke: ok");
