// One Node · Krea 2 — frontend dashboard
// Architecture copied from one-node-flux-2-klein: the Python node is a placeholder;
// this file renders the whole UI in a DOM widget, and (Phase 1c) patches the
// API-format workflow template and submits it to ComfyUI's /prompt queue.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_W = 980;
const NODE_H = Math.round(980 * 9 / 16); // 551
const LS_KEY = "krea2_onenode_state";

// Size presets: base resolution + tuned latent upscale factor (spec §4 table).
const PRESETS = [
  { label: "2:3 portrait",    w: 640,  h: 960,  scale: 1.8 },
  { label: "3:4 portrait",    w: 672,  h: 896,  scale: 1.8 },
  { label: "9:16 tall",       w: 576,  h: 1024, scale: 1.8 },
  { label: "3:2 landscape",   w: 960,  h: 640,  scale: 1.8 },
  { label: "4:3 landscape",   w: 896,  h: 672,  scale: 1.8 },
  { label: "16:9 widescreen", w: 1024, h: 576,  scale: 1.8 },
  { label: "1:1 square",      w: 768,  h: 768,  scale: 1.8 },
];

const SAMPLERS = ["euler", "euler_ancestral", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_sde", "dpmpp_3m_sde", "res_multistep", "lcm", "ddim", "uni_pc"];
const SCHEDULERS = ["simple", "sgm_uniform", "normal", "karras", "exponential", "beta", "linear_quadratic", "kl_optimal"];
const UPSCALE_METHODS = ["bislerp", "nearest-exact", "bilinear", "area", "bicubic"];

const MODES = ["T2I", "I2I", "EDIT", "PAINT", "FACESWAP", "POSE", "UPSCALE"];

// ── colors ───────────────────────────────────────────────────────────────────
const C = {
  bg0: "#101014", bg1: "#17171d", bg2: "#1f1f27", bg3: "#282833",
  line: "#2e2e3a", text: "#e7e7ee", dim: "#9a9aa8", faint: "#5c5c6b",
  accent: "#4ea3ff", accentText: "#0b1016", danger: "#ff5c5c", ok: "#39d98a",
};

// ── state ────────────────────────────────────────────────────────────────────
function defaultState() {
  return {
    prompt: "",
    presetIdx: 5,               // 16:9 widescreen (matches the source graph 1024×576)
    batch: 1,
    seed: Math.floor(Math.random() * 1e15),
    randomizeSeed: true,
    lastSeed: null,
    loras: [],                  // {on, name, strength}
    autoSave: true,
    // settings gear (defaults = source graph)
    p1: { steps: 8, cfg: 1.0, sampler: "euler", scheduler: "simple", endStep: 8 },
    p2: { steps: 10, cfg: 0.8, sampler: "dpmpp_2m_sde", scheduler: "sgm_uniform", startStep: 5 },
    upscaleMethod: "bislerp",
    upscaleBy: 1.8,
  };
}

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    return Object.assign(defaultState(), s);
  } catch (e) { return defaultState(); }
}
function saveState(S) {
  try {
    const persistable = {};
    for (const [k, v] of Object.entries(S)) if (!k.startsWith("_")) persistable[k] = v;
    localStorage.setItem(LS_KEY, JSON.stringify(persistable));
  } catch (e) { /* quota — non-fatal */ }
}

function _isVueNodes() {
  try {
    const v = app?.ui?.settings?.getSettingValue?.("Comfy.VueNodes.Enabled");
    return v === true || v === "true";
  } catch (e) { return false; }
}

// ── tiny DOM helpers ─────────────────────────────────────────────────────────
function el(tag, style = {}, props = {}) {
  const e = document.createElement(tag);
  Object.assign(e.style, style);
  Object.assign(e, props);
  return e;
}
const stopWheel = (e) => e.stopPropagation(); // keep canvas from zooming under scrollable panels

function styledSelect(options, value, onChange) {
  const s = el("select", {
    background: C.bg2, color: C.text, border: `1px solid ${C.line}`,
    borderRadius: "6px", padding: "5px 8px", fontSize: "12px", outline: "none",
    width: "100%", cursor: "pointer",
  });
  for (const o of options) {
    const opt = el("option", {}, { value: o.value ?? o, textContent: o.label ?? o });
    s.appendChild(opt);
  }
  s.value = value;
  s.addEventListener("change", () => onChange(s.value));
  s.addEventListener("pointerdown", (e) => e.stopPropagation());
  return s;
}

function numInput(value, { min, max, step = 1, width = "64px" }, onChange) {
  const i = el("input", {
    background: C.bg2, color: C.text, border: `1px solid ${C.line}`,
    borderRadius: "6px", padding: "4px 6px", fontSize: "12px", width,
    outline: "none",
  }, { type: "number", value, min, max, step });
  i.addEventListener("change", () => onChange(parseFloat(i.value)));
  i.addEventListener("pointerdown", (e) => e.stopPropagation());
  i.addEventListener("keydown", (e) => e.stopPropagation());
  return i;
}

function label(text, size = "10px") {
  return el("div", {
    color: C.dim, fontSize: size, letterSpacing: "0.08em",
    textTransform: "uppercase", margin: "10px 0 4px",
  }, { textContent: text });
}

function iconBtn(txt, title, onClick, style = {}) {
  const b = el("button", {
    background: C.bg2, color: C.text, border: `1px solid ${C.line}`,
    borderRadius: "6px", padding: "4px 9px", fontSize: "12px", cursor: "pointer",
    ...style,
  }, { textContent: txt, title });
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  b.addEventListener("pointerdown", (e) => e.stopPropagation());
  return b;
}

// ── global websocket listeners ───────────────────────────────────────────────
// Registered once (guarded for hot reload). Events are filtered by the active
// prompt_id so foreign queue runs don't hijack the preview.
function _active() { return window.__krea2_active || null; }
function _isOurs(evt) {
  const a = _active();
  const pid = evt?.detail?.prompt_id;
  return a && a.S._promptId && pid === a.S._promptId;
}
if (!window.__krea2_listeners) {
  window.__krea2_listeners = true;

  api.addEventListener("b_preview", (evt) => {
    const a = _active();
    if (a && a.S._generating && evt.detail instanceof Blob) a.showPreviewBlob(evt.detail);
  });

  api.addEventListener("progress", (evt) => {
    if (!_isOurs(evt)) return;
    const a = _active();
    const d = evt.detail;
    if (d?.max) a.setStatus(`Sampling ${d.value}/${d.max}`);
  });

  api.addEventListener("executed", (evt) => {
    if (!_isOurs(evt)) return;
    const a = _active();
    const imgs = evt.detail?.output?.images;
    if (!imgs?.length) return;
    // Only the final image node emits here (SaveImage or the swapped-in PreviewImage).
    a.showBatch(imgs);
    a.showImage(imgs[0]);
  });

  api.addEventListener("execution_success", (evt) => {
    if (!_isOurs(evt)) return;
    const a = _active();
    a.setStatus("Done.", "#39d98a");
    a.done();
    a.S._promptId = null;
  });

  api.addEventListener("execution_error", (evt) => {
    if (!_isOurs(evt)) return;
    const a = _active();
    const d = evt.detail;
    a.setStatus(`Error in ${d?.node_type || "?"}: ${(d?.exception_message || "unknown").slice(0, 120)}`, "#ff5c5c");
    a.done();
    a.S._promptId = null;
  });

  api.addEventListener("execution_interrupted", (evt) => {
    if (!_isOurs(evt)) return;
    const a = _active();
    a.setStatus("Interrupted.");
    a.done();
    a.S._promptId = null;
  });
}

// ── extension ────────────────────────────────────────────────────────────────
app.registerExtension({
  name: "Krea2OneNode.v1",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "Krea2OneNode") return;

    nodeType.prototype.onNodeCreated = function () {
      this.color = C.bg0; this.bgcolor = C.bg0; this.resizable = false;
      this.outputs = [];
      if (this.widgets) this.widgets = [];
      this.addOutput("image", "IMAGE");

      if (!window.__krea2_nodes) window.__krea2_nodes = {};
      const cached = window.__krea2_nodes[this.id];
      if (cached) {
        // Workflow switch: node instance rebuilt, reuse the cached DOM + state.
        cached.currentNode = this;
        this._mountUI(cached.root);
        return;
      }
      this._buildUI();
    };

    nodeType.prototype._mountUI = function (root) {
      const self = this;
      this.addDOMWidget("k2_ui", "div", root, {
        getValue() { return null; }, setValue() {}, serialize: false,
        // classic mode: canvasOnly stops the Parameters side-panel stealing the widget;
        // Nodes 2.0 (Vue) skips canvasOnly widgets entirely, so it must be off there.
        canvasOnly: !_isVueNodes(),
        computeSize() {
          const slotH = (LiteGraph.NODE_SLOT_HEIGHT || 20);
          const rows = Math.max((self.inputs || []).length, (self.outputs || []).length);
          return [NODE_W, NODE_H + rows * slotH];
        },
      });
      const slotH = (LiteGraph.NODE_SLOT_HEIGHT || 20);
      const rows = Math.max((this.inputs || []).length, (this.outputs || []).length);
      this.setSize([NODE_W, NODE_H + rows * slotH]);

      // Nodes 2.0: hide the injected node-type badge.
      const hideBadge = () => {
        let e = root;
        for (let i = 0; i < 6; i++) {
          e = e?.parentElement; if (!e) break;
          e.querySelectorAll("[class*='bg-node-component-surface']").forEach(b => b.style.display = "none");
        }
      };
      requestAnimationFrame(() => {
        hideBadge();
        if (typeof MutationObserver !== "undefined") {
          let obs = root;
          for (let i = 0; i < 4; i++) obs = obs?.parentElement || obs;
          try { new MutationObserver(hideBadge).observe(obs, { childList: true, subtree: true }); } catch (e) {}
        }
      });
    };

    nodeType.prototype.onResize = function () {
      const slotH = (LiteGraph.NODE_SLOT_HEIGHT || 20);
      const rows = Math.max((this.inputs || []).length, (this.outputs || []).length);
      this.size = [NODE_W, NODE_H + rows * slotH];
    };
    nodeType.prototype.onDrawConnections = function () {};
    nodeType.prototype.getSlotMenuOptions = function () { return []; };
    nodeType.prototype.onRemoved = function () {
      const c = window.__krea2_nodes?.[this.id];
      if (c && c.currentNode === this) delete window.__krea2_nodes[this.id];
    };

    // ── UI build ─────────────────────────────────────────────────────────────
    nodeType.prototype._buildUI = function () {
      const self = this;
      const S = loadState();
      S._loraFiles = [];
      S._generating = false;
      const persist = () => saveState(S);

      const root = el("div", {
        width: "100%", height: NODE_H + "px", boxSizing: "border-box",
        background: C.bg0, color: C.text, display: "flex", flexDirection: "column",
        fontFamily: "'Inter','Segoe UI',system-ui,sans-serif", fontSize: "13px",
        borderRadius: "8px", overflow: "hidden", position: "relative",
        userSelect: "none",
      });
      root.addEventListener("wheel", stopWheel, { passive: false });

      // ── header: title + mode pills + gear ──────────────────────────────────
      const header = el("div", {
        display: "flex", alignItems: "center", gap: "10px",
        padding: "10px 14px 8px", borderBottom: `1px solid ${C.line}`,
        background: C.bg1, flex: "0 0 auto",
      });
      header.appendChild(el("div", { fontWeight: "700", fontSize: "14px", whiteSpace: "nowrap" },
        { textContent: "One Node · Krea 2" }));

      const pills = el("div", { display: "flex", gap: "6px", flex: "1", justifyContent: "center" });
      for (const m of MODES) {
        const active = m === "T2I";
        const pill = el("div", {
          padding: "4px 12px", borderRadius: "999px", fontSize: "11px", fontWeight: "600",
          letterSpacing: "0.04em",
          background: active ? C.accent : C.bg2,
          color: active ? C.accentText : C.faint,
          border: `1px solid ${active ? C.accent : C.line}`,
          cursor: active ? "default" : "not-allowed",
          opacity: active ? "1" : "0.55",
        }, { textContent: m, title: active ? "Generate (text to image)" : `${m} — coming in a later phase` });
        pills.appendChild(pill);
      }
      header.appendChild(pills);

      let settingsOpen = false;
      const gearBtn = iconBtn("⚙", "Two-pass sampler settings", () => {
        settingsOpen = !settingsOpen;
        settingsPanel.style.display = settingsOpen ? "block" : "none";
        gearBtn.style.borderColor = settingsOpen ? C.accent : C.line;
      }, { fontSize: "14px", padding: "3px 9px" });
      header.appendChild(gearBtn);
      root.appendChild(header);

      // ── body: left controls / right preview ────────────────────────────────
      const body = el("div", { display: "flex", flex: "1", minHeight: "0" });
      root.appendChild(body);

      // ---- left panel ----
      const left = el("div", {
        width: "355px", flex: "0 0 355px", padding: "10px 14px", boxSizing: "border-box",
        borderRight: `1px solid ${C.line}`, background: C.bg1,
        overflowY: "auto", display: "flex", flexDirection: "column",
      });
      body.appendChild(left);

      // size preset
      left.appendChild(label("Size"));
      const presetSel = styledSelect(
        PRESETS.map((p, i) => ({ value: String(i), label: `${p.label}  ·  ${p.w}×${p.h} → ${Math.round(p.w * p.scale)}×${Math.round(p.h * p.scale)}` })),
        String(S.presetIdx),
        (v) => { S.presetIdx = parseInt(v, 10); persist(); },
      );
      left.appendChild(presetSel);

      // prompt
      left.appendChild(label("Prompt"));
      const promptBox = el("textarea", {
        background: C.bg2, color: C.text, border: `1px solid ${C.line}`,
        borderRadius: "8px", padding: "8px 10px", fontSize: "13px", lineHeight: "1.45",
        width: "100%", height: "110px", resize: "none", outline: "none",
        boxSizing: "border-box", fontFamily: "inherit",
      }, { value: S.prompt, placeholder: "Describe the image…", spellcheck: false });
      promptBox.addEventListener("input", () => { S.prompt = promptBox.value; persist(); });
      promptBox.addEventListener("pointerdown", (e) => e.stopPropagation());
      promptBox.addEventListener("keydown", (e) => e.stopPropagation());
      left.appendChild(promptBox);

      // LoRA stack
      const loraHead = el("div", { display: "flex", alignItems: "center", justifyContent: "space-between" });
      loraHead.appendChild(label("LoRA Stack"));
      const addLoraBtn = iconBtn("+ Add LoRA", "Add a LoRA row", () => {
        S.loras.push({ on: true, name: "", strength: 1.0 });
        persist(); renderLoras();
      }, { fontSize: "11px", marginTop: "6px" });
      loraHead.appendChild(addLoraBtn);
      left.appendChild(loraHead);

      const loraList = el("div", { display: "flex", flexDirection: "column", gap: "6px" });
      left.appendChild(loraList);

      function renderLoras() {
        loraList.replaceChildren();
        if (!S.loras.length) {
          loraList.appendChild(el("div", { color: C.faint, fontSize: "11px", padding: "2px 0 4px" },
            { textContent: "No LoRAs — base model only." }));
          return;
        }
        S.loras.forEach((row, idx) => {
          const r = el("div", {
            display: "flex", alignItems: "center", gap: "6px",
            background: C.bg2, border: `1px solid ${C.line}`, borderRadius: "8px",
            padding: "5px 7px", opacity: row.on ? "1" : "0.45",
          });
          // enable toggle
          const tog = iconBtn(row.on ? "●" : "○", row.on ? "Disable" : "Enable", () => {
            row.on = !row.on; persist(); renderLoras();
          }, { padding: "1px 7px", color: row.on ? C.ok : C.faint, border: "none", background: "transparent", fontSize: "13px" });
          r.appendChild(tog);
          // file picker
          const opts = [{ value: "", label: "— select LoRA —" },
            ...S._loraFiles.map(f => ({ value: f, label: f.replace(/\.safetensors$/i, "") }))];
          if (row.name && !S._loraFiles.includes(row.name)) opts.push({ value: row.name, label: row.name + " (missing)" });
          const sel = styledSelect(opts, row.name, (v) => { row.name = v; persist(); });
          sel.style.flex = "1"; sel.style.minWidth = "0";
          r.appendChild(sel);
          // strength
          const st = numInput(row.strength, { min: -4, max: 4, step: 0.05, width: "52px" }, (v) => {
            row.strength = isFinite(v) ? v : 1.0; persist();
          });
          st.title = "Strength";
          r.appendChild(st);
          // remove
          r.appendChild(iconBtn("✕", "Remove", () => {
            S.loras.splice(idx, 1); persist(); renderLoras();
          }, { padding: "1px 6px", color: C.faint, border: "none", background: "transparent" }));
          loraList.appendChild(r);
        });
      }

      // fetch lora filenames for the pickers
      api.fetchApi("/krea2_onenode/models").then(r => r.json()).then(d => {
        S._loraFiles = Array.isArray(d?.loras) ? d.loras : [];
        renderLoras();
      }).catch(() => renderLoras());
      renderLoras();

      // seed row
      left.appendChild(label("Seed"));
      const seedRow = el("div", { display: "flex", alignItems: "center", gap: "6px" });
      const seedIn = numInput(S.seed, { min: 0, max: 1e15, step: 1, width: "150px" }, (v) => {
        S.seed = Math.max(0, Math.floor(v || 0)); persist();
      });
      seedRow.appendChild(seedIn);
      const randBtn = iconBtn("🎲", "Randomize seed each generation", () => {
        S.randomizeSeed = !S.randomizeSeed; persist(); syncSeedUI();
      });
      seedRow.appendChild(randBtn);
      const reuseBtn = iconBtn("↩", "Reuse last generation's seed", () => {
        if (S.lastSeed != null) {
          S.seed = S.lastSeed; S.randomizeSeed = false;
          seedIn.value = S.seed; persist(); syncSeedUI();
        }
      });
      seedRow.appendChild(reuseBtn);
      function syncSeedUI() {
        randBtn.style.borderColor = S.randomizeSeed ? C.accent : C.line;
        randBtn.style.color = S.randomizeSeed ? C.accent : C.text;
        seedIn.style.opacity = S.randomizeSeed ? "0.5" : "1";
        reuseBtn.style.opacity = S.lastSeed != null ? "1" : "0.4";
      }
      syncSeedUI();
      left.appendChild(seedRow);

      // generate + batch
      const genRow = el("div", { display: "flex", gap: "8px", marginTop: "14px", alignItems: "stretch" });
      const genBtn = el("button", {
        flex: "1", background: C.accent, color: C.accentText, border: "none",
        borderRadius: "8px", padding: "10px", fontSize: "14px", fontWeight: "700",
        cursor: "pointer", letterSpacing: "0.02em",
      }, { textContent: "Generate" });
      genBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
      genBtn.addEventListener("click", (e) => { e.stopPropagation(); doGenerate(); });
      genRow.appendChild(genBtn);
      const batchSel = styledSelect(
        [1, 2, 4, 8].map(n => ({ value: String(n), label: `×${n}` })),
        String(S.batch),
        (v) => { S.batch = parseInt(v, 10); persist(); },
      );
      batchSel.style.width = "64px"; batchSel.style.flex = "0 0 64px";
      batchSel.title = "Batch count";
      genRow.appendChild(batchSel);
      left.appendChild(genRow);

      // status line
      const statusLine = el("div", {
        marginTop: "8px", fontSize: "11px", color: C.dim, minHeight: "15px",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      }, { textContent: "" });
      left.appendChild(statusLine);
      const setStatus = (t, color = C.dim) => { statusLine.textContent = t; statusLine.style.color = color; };

      // ---- right panel ----
      const right = el("div", { flex: "1", display: "flex", flexDirection: "column", minWidth: "0", background: C.bg0 });
      body.appendChild(right);

      const previewWrap = el("div", {
        flex: "1", display: "flex", alignItems: "center", justifyContent: "center",
        minHeight: "0", position: "relative", overflow: "hidden",
      });
      right.appendChild(previewWrap);
      const previewImg = el("img", {
        maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "none",
      });
      previewImg.addEventListener("pointerdown", (e) => e.stopPropagation());
      previewWrap.appendChild(previewImg);
      const previewEmpty = el("div", { color: C.faint, fontSize: "12px", textAlign: "center" },
        { innerHTML: "No image yet<br><span style='font-size:10px'>Generate to see the result here</span>" });
      previewWrap.appendChild(previewEmpty);

      // batch thumbnail strip
      const thumbStrip = el("div", {
        display: "none", gap: "6px", padding: "6px 10px", overflowX: "auto",
        flex: "0 0 auto", borderTop: `1px solid ${C.line}`, background: C.bg1,
      });
      right.appendChild(thumbStrip);

      // output bar
      const outBar = el("div", {
        display: "flex", alignItems: "center", gap: "8px",
        padding: "8px 12px", borderTop: `1px solid ${C.line}`, background: C.bg1,
        flex: "0 0 auto",
      });
      const useAsSel = styledSelect([{ value: "", label: "Use as…" }], "", () => {});
      useAsSel.disabled = true;
      useAsSel.style.width = "110px"; useAsSel.style.opacity = "0.4"; useAsSel.style.cursor = "not-allowed";
      useAsSel.title = "Send to I2I / Edit — coming with those modes";
      outBar.appendChild(useAsSel);
      outBar.appendChild(el("div", { flex: "1" }));
      const saveBtn = iconBtn("Save", "Save the shown image to the output folder", () => doSaveTemp());
      saveBtn.style.opacity = "0.4";
      outBar.appendChild(saveBtn);
      const autoSaveBtn = iconBtn("Auto-save", "When on, every generation is saved to the output folder", () => {
        S.autoSave = !S.autoSave; persist(); syncAutoSave();
      });
      function syncAutoSave() {
        autoSaveBtn.style.borderColor = S.autoSave ? C.accent : C.line;
        autoSaveBtn.style.color = S.autoSave ? C.accent : C.text;
        saveBtn.style.display = S.autoSave ? "none" : "";
      }
      syncAutoSave();
      outBar.appendChild(autoSaveBtn);
      outBar.appendChild(iconBtn("📁", "Open output folder", () => {
        api.fetchApi("/krea2_onenode/open_folder", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(S._lastImage?.type === "output" ? S._lastImage : {}),
        }).catch(() => {});
      }));
      right.appendChild(outBar);

      // ---- settings panel (overlay) ----
      const settingsPanel = el("div", {
        position: "absolute", top: "44px", right: "10px", width: "300px",
        background: C.bg1, border: `1px solid ${C.line}`, borderRadius: "10px",
        boxShadow: "0 8px 30px rgba(0,0,0,0.5)", padding: "10px 14px 14px",
        display: "none", zIndex: "20",
      });
      settingsPanel.addEventListener("pointerdown", (e) => e.stopPropagation());
      settingsPanel.addEventListener("wheel", stopWheel, { passive: false });
      root.appendChild(settingsPanel);

      function settingsRow(text, control) {
        const r = el("div", { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", margin: "5px 0" });
        r.appendChild(el("div", { fontSize: "11px", color: C.dim, flex: "1" }, { textContent: text }));
        control.style.width = "130px";
        r.appendChild(control);
        return r;
      }
      settingsPanel.appendChild(el("div", { fontWeight: "700", fontSize: "12px", margin: "4px 0 2px" }, { textContent: "Pass 1 · base" }));
      settingsPanel.appendChild(settingsRow("Steps", numInput(S.p1.steps, { min: 1, max: 100, width: "130px" }, v => { S.p1.steps = v; S.p1.endStep = v; persist(); })));
      settingsPanel.appendChild(settingsRow("CFG", numInput(S.p1.cfg, { min: 0, max: 30, step: 0.1, width: "130px" }, v => { S.p1.cfg = v; persist(); })));
      settingsPanel.appendChild(settingsRow("Sampler", styledSelect(SAMPLERS, S.p1.sampler, v => { S.p1.sampler = v; persist(); })));
      settingsPanel.appendChild(settingsRow("Scheduler", styledSelect(SCHEDULERS, S.p1.scheduler, v => { S.p1.scheduler = v; persist(); })));
      settingsPanel.appendChild(el("div", { fontWeight: "700", fontSize: "12px", margin: "10px 0 2px" }, { textContent: "Pass 2 · hi-res refine" }));
      settingsPanel.appendChild(settingsRow("Steps", numInput(S.p2.steps, { min: 1, max: 100, width: "130px" }, v => { S.p2.steps = v; persist(); })));
      settingsPanel.appendChild(settingsRow("CFG", numInput(S.p2.cfg, { min: 0, max: 30, step: 0.1, width: "130px" }, v => { S.p2.cfg = v; persist(); })));
      settingsPanel.appendChild(settingsRow("Sampler", styledSelect(SAMPLERS, S.p2.sampler, v => { S.p2.sampler = v; persist(); })));
      settingsPanel.appendChild(settingsRow("Scheduler", styledSelect(SCHEDULERS, S.p2.scheduler, v => { S.p2.scheduler = v; persist(); })));
      settingsPanel.appendChild(settingsRow("Start at step", numInput(S.p2.startStep, { min: 0, max: 100, width: "130px" }, v => { S.p2.startStep = v; persist(); })));
      settingsPanel.appendChild(el("div", { fontWeight: "700", fontSize: "12px", margin: "10px 0 2px" }, { textContent: "Upscale (latent)" }));
      settingsPanel.appendChild(settingsRow("Method", styledSelect(UPSCALE_METHODS, S.upscaleMethod, v => { S.upscaleMethod = v; persist(); })));
      settingsPanel.appendChild(settingsRow("Factor", numInput(S.upscaleBy, { min: 1, max: 4, step: 0.05, width: "130px" }, v => { S.upscaleBy = v; persist(); })));

      // ── image display helpers ──────────────────────────────────────────────
      function viewUrl(img) {
        const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || "", type: img.type || "output", t: Date.now() });
        return api.apiURL(`/view?${q}`);
      }
      function showImage(img) {
        S._lastImage = img;
        previewImg.src = viewUrl(img);
        previewImg.style.display = "";
        previewEmpty.style.display = "none";
        saveBtn.style.opacity = img.type === "temp" ? "1" : "0.4";
        pushOutput(img);
      }
      function showBatch(images) {
        thumbStrip.replaceChildren();
        if (images.length <= 1) { thumbStrip.style.display = "none"; return; }
        thumbStrip.style.display = "flex";
        images.forEach((img) => {
          const t = el("img", {
            height: "56px", borderRadius: "6px", cursor: "pointer",
            border: `1px solid ${C.line}`,
          }, { src: viewUrl(img) });
          t.addEventListener("pointerdown", (e) => e.stopPropagation());
          t.addEventListener("click", (e) => { e.stopPropagation(); showImage(img); });
          thumbStrip.appendChild(t);
        });
      }
      function showPreviewBlob(blob) {
        // live b_preview stream during sampling
        try {
          const url = URL.createObjectURL(blob);
          const old = previewImg.dataset.blobUrl;
          previewImg.src = url;
          previewImg.dataset.blobUrl = url;
          previewImg.style.display = "";
          previewEmpty.style.display = "none";
          if (old) URL.revokeObjectURL(old);
        } catch (e) {}
      }
      function pushOutput(img) {
        // let the Python placeholder replay this image on its IMAGE output
        const nodeId = (window.__krea2_nodes && Object.entries(window.__krea2_nodes).find(([, v]) => v.S === S)?.[0]) ?? self.id;
        api.fetchApi("/krea2_onenode/set_output", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ node_id: String(nodeId), ...img }),
        }).catch(() => {});
      }

      // ── template patch + submit ────────────────────────────────────────────
      let _template = null;
      async function getTemplate() {
        if (!_template) {
          const r = await api.fetchApi("/krea2_onenode/workflow_generate");
          if (!r.ok) throw new Error(`template fetch failed (${r.status})`);
          _template = await r.json();
        }
        return _template;
      }

      function buildPrompt(tpl) {
        const p = JSON.parse(JSON.stringify(tpl));
        const preset = PRESETS[S.presetIdx] || PRESETS[5];

        p["K2:pos"].inputs.text = S.prompt || "";
        p["K2:latent"].inputs.width = preset.w;
        p["K2:latent"].inputs.height = preset.h;
        p["K2:latent"].inputs.batch_size = S.batch;

        if (S.randomizeSeed) S.seed = Math.floor(Math.random() * 1e15);
        S.lastSeed = S.seed;
        seedIn.value = S.seed;
        syncSeedUI();
        p["K2:seed"].inputs.seed = S.seed;

        // LoRA stack → Power Lora Loader dynamic inputs
        let li = 1;
        for (const row of S.loras) {
          if (!row.name) continue;
          p["K2:lora"].inputs[`lora_${li}`] = {
            on: !!row.on, lora: row.name, strength: row.strength, strengthTwo: null,
          };
          li++;
        }

        // settings gear
        p["K2:sampler1"].inputs.steps = S.p1.steps;
        p["K2:sampler1"].inputs.cfg = S.p1.cfg;
        p["K2:sampler1"].inputs.sampler_name = S.p1.sampler;
        p["K2:sampler1"].inputs.scheduler = S.p1.scheduler;
        p["K2:sampler1"].inputs.end_at_step = S.p1.endStep;
        p["K2:sampler2"].inputs.steps = S.p2.steps;
        p["K2:sampler2"].inputs.cfg = S.p2.cfg;
        p["K2:sampler2"].inputs.sampler_name = S.p2.sampler;
        p["K2:sampler2"].inputs.scheduler = S.p2.scheduler;
        p["K2:sampler2"].inputs.start_at_step = S.p2.startStep;
        p["K2:upscale"].inputs.upscale_method = S.upscaleMethod;
        p["K2:upscale"].inputs.scale_by = S.upscaleBy;

        // auto-save off → PreviewImage (temp) instead of SaveImage
        if (!S.autoSave) {
          p["K2:save"] = {
            inputs: { images: p["K2:save"].inputs.images },
            class_type: "PreviewImage",
            _meta: { title: "Preview (unsaved)" },
          };
        }
        return p;
      }

      async function doGenerate() {
        if (S._generating) return;
        if (!S.prompt.trim()) { setStatus("Enter a prompt first.", C.danger); return; }
        S._generating = true;
        genBtn.textContent = "Generating…";
        genBtn.style.opacity = "0.6";
        setStatus("Queued…");
        persist();
        try {
          const prompt = buildPrompt(await getTemplate());
          const resp = await api.fetchApi("/prompt", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt, client_id: api.clientId, extra_data: { enable_previews: true } }),
          });
          const result = await resp.json();
          if (!resp.ok || result.error) {
            const msg = result?.error?.message || result?.error || `HTTP ${resp.status}`;
            const nodeErrs = result?.node_errors && Object.values(result.node_errors)
              .flatMap(e => (e.errors || []).map(x => x.message)).join("; ");
            throw new Error(nodeErrs || msg);
          }
          S._promptId = result.prompt_id || null;
          window.__krea2_active = { S, showImage, showBatch, showPreviewBlob, setStatus, done: finishGenerate };
          setStatus("Running…");
        } catch (e) {
          finishGenerate();
          setStatus(`Error: ${e.message}`, C.danger);
          console.error("[Krea2OneNode] submit failed:", e);
        }
      }
      function finishGenerate() {
        S._generating = false;
        genBtn.textContent = "Generate";
        genBtn.style.opacity = "1";
      }

      async function doSaveTemp() {
        const img = S._lastImage;
        if (!img || img.type !== "temp") { setStatus("Nothing unsaved to save.", C.faint); return; }
        try {
          const r = await api.fetchApi("/krea2_onenode/save_temp", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename: img.filename, subfolder: img.subfolder || "" }),
          });
          const d = await r.json();
          if (d.ok) {
            S._lastImage = { filename: d.filename, subfolder: d.subfolder, type: "output" };
            saveBtn.style.opacity = "0.4";
            setStatus(`Saved as ${d.filename}`, C.ok);
          } else setStatus(`Save failed: ${d.error}`, C.danger);
        } catch (e) { setStatus(`Save failed: ${e.message}`, C.danger); }
      }

      // ── mount + cache ──────────────────────────────────────────────────────
      window.__krea2_nodes[this.id] = { root, S, currentNode: this };
      // this.id is -1 during onNodeCreated; re-key the cache under the real id next frame.
      requestAnimationFrame(() => {
        const staleKey = -1;
        if (window.__krea2_nodes[staleKey] && self.id !== staleKey) {
          window.__krea2_nodes[self.id] = window.__krea2_nodes[staleKey];
          delete window.__krea2_nodes[staleKey];
        }
      });
      this._mountUI(root);
    };
  },
});
