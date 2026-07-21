// One Node · Krea 2 — frontend
// Phase 1a stub: confirms the web directory is served and the extension loads.
// The full dashboard UI lands in Phase 1b.
import { app } from "../../scripts/app.js";

app.registerExtension({
  name: "Krea2OneNode.v1",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "Krea2OneNode") return;
    console.log("[Krea2OneNode] extension loaded, node registered");
  },
});
