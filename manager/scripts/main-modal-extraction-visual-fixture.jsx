import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { WorkerUpdateConfirmModal } from "../src/features/profiles/worker-update-confirm-modal.jsx";
import { InspectionModal } from "../src/features/projects/inspection-modal.jsx";

const inspection = {
  project: { name: "codexpro-source", root: "C:/repo/codexpro-source" },
  result: {
    workspace_id: "ws_visual_test",
    root: "C:/repo/codexpro-source",
    git_status: "## win...origin/win",
    tree: "manager/\n  src/\n    main.jsx",
    codexgraph: {
      nodes: [
        { id: "main", name: "main.jsx", kind: "module", path: "manager/src/main.jsx" },
        { id: "app", name: "App", kind: "function", path: "manager/src/main.jsx" }
      ],
      edges: [{ source: "main", target: "app", kind: "contains" }]
    }
  }
};

function Fixture() {
  const [mode, setMode] = useState("worker");
  const [workerOpen, setWorkerOpen] = useState(true);
  const [inspectionOpen, setInspectionOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    window.__showWorkerUpdate = () => { setMode("worker"); setWorkerOpen(true); setInspectionOpen(false); };
    window.__showInspection = () => { setMode("inspection"); setInspectionOpen(true); setWorkerOpen(false); };
    window.__modalFixtureState = () => ({ mode, workerOpen, inspectionOpen, confirmed });
    return () => {
      delete window.__showWorkerUpdate;
      delete window.__showInspection;
      delete window.__modalFixtureState;
    };
  }, [mode, workerOpen, inspectionOpen, confirmed]);

  return (
    <main style={{ minHeight: "100vh" }}>
      <WorkerUpdateConfirmModal
        open={workerOpen}
        reloadCount={3}
        deferredUpdateCount={2}
        workerVersion="0.5.121"
        onClose={() => setWorkerOpen(false)}
        onConfirm={() => { setConfirmed(true); setWorkerOpen(false); }}
      />
      <InspectionModal inspection={inspectionOpen ? inspection : null} onClose={() => setInspectionOpen(false)} />
    </main>
  );
}

createRoot(document.getElementById("root")).render(<Fixture />);
