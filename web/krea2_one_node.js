// One Node · Krea 2 — frontend dashboard
// Architecture and visual design copied from one-node-flux-2-klein: the Python
// node is a placeholder; this file renders the whole UI in a DOM widget,
// patches the API-format workflow template and submits it to /prompt.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const LIME = "#f0ff41";
const C = {
  lime: LIME, bg0: "#0b0b0b", bg1: "#111111", bg2: "#181818",
  bg3: "#222222", border: "#2a2a2a", borderH: "#3c3c3c",
  text: "#dedede", muted: "#565656", dim: "#2e2e2e",
  warn: "#ffb347", err: "#ff6767", ok: "#7ddc82",
  adv: "#8a8ade", advBorder: "#44447e",
};

const NODE_W = 980;
const NODE_H = Math.round(NODE_W * 9 / 16);
const MIN_W = 760;
const MIN_H = 430;
const LS_KEY = "krea2_onenode_state";

// Size presets (base generation size; the latent upscale factor applies on top).
const PRESETS = [
  { w: 1920, h: 1088 },  // 1080p landscape
  { w: 1088, h: 1920 },  // 1080p portrait
  { w: 1280, h: 720 },   // 720p landscape
  { w: 720,  h: 1280 },  // 720p portrait
  { w: 640,  h: 480 },   // VGA landscape
  { w: 480,  h: 640 },   // VGA portrait
  { w: 1024, h: 1024 },  // 1:1
  { w: 512,  h: 512 },   // 1:1 small
];
const CUSTOM = -1;

const SAMPLERS = ["euler", "euler_ancestral", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_sde", "dpmpp_3m_sde", "res_multistep", "lcm", "ddim", "uni_pc", "er_sde"];
const SCHEDULERS = ["simple", "sgm_uniform", "normal", "karras", "exponential", "beta", "linear_quadratic", "kl_optimal"];
const UPSCALE_METHODS = ["bislerp", "nearest-exact", "bilinear", "area", "bicubic"];
const MODES = ["T2I", "I2I", "EDIT", "PAINT", "FACESWAP", "POSE", "UPSCALE"];

// Scene tab: allowed per-row batch sizes and the rough per-image duration used
// for the pre-run time estimate (user's machine averages ~2.5 min/image).
const SCENE_BATCHES = [1, 2, 4, 8];
const PER_IMAGE_MIN = 2.5;

// ── state ────────────────────────────────────────────────────────────────────
function defaultState() {
  return {
    prompt: "",
    presetIdx: 2,               // 1280×720
    customW: 1280, customH: 720,
    batch: 1,
    seed: Math.floor(Math.random() * 1e15),
    randomizeSeed: true,
    lastSeed: null,
    loras: [],                  // {on, name, strength}
    autoSave: true,
    soundOn: true,
    advancedUI: false,
    modelUnet: "krea2_turbo_bf16.safetensors",
    modelClip: "qwen3vl_4b_fp8_scaled.safetensors",
    modelVae: "qwen_image_vae.safetensors",
    p1: { steps: 8, cfg: 1.0, sampler: "euler", scheduler: "simple", endStep: 8 },
    p2: { steps: 10, cfg: 0.8, sampler: "dpmpp_2m_sde", scheduler: "sgm_uniform", startStep: 5 },
    upscaleMethod: "bislerp",
    upscaleBy: 1.8,
    tab: "t2i",                 // "t2i" | "scene"
    sceneRows: [{ prompt: "", batch: 1 }],
  };
}
function loadState() {
  try {
    const s = Object.assign(defaultState(), JSON.parse(localStorage.getItem(LS_KEY) || "{}"));
    if (s.presetIdx !== CUSTOM && !PRESETS[s.presetIdx]) s.presetIdx = 2;
    if (s.tab !== "scene") s.tab = "t2i";
    if (!Array.isArray(s.sceneRows) || !s.sceneRows.length) s.sceneRows = [{ prompt: "", batch: 1 }];
    s.sceneRows = s.sceneRows.map(r => ({
      prompt: typeof r?.prompt === "string" ? r.prompt : "",
      batch: SCENE_BATCHES.includes(r?.batch) ? r.batch : 1,
    }));
    return s;
  }
  catch (e) { return defaultState(); }
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

// completion chime (reference-style gentle two-tone)
function playDone() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const mkTone = (freq, t0, dur) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.value = freq;
      g.gain.setValueAtTime(0, ctx.currentTime + t0);
      g.gain.linearRampToValueAtTime(0.18, ctx.currentTime + t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t0 + dur);
      o.connect(g); g.connect(ctx.destination);
      o.start(ctx.currentTime + t0); o.stop(ctx.currentTime + t0 + dur + 0.05);
    };
    mkTone(660, 0, 0.35);
    mkTone(880, 0.13, 0.45);
    setTimeout(() => ctx.close?.(), 1200);
  } catch (e) {}
}

// ── tiny DOM helpers (mirroring the reference) ───────────────────────────────
const mk = (tag, css = {}, props = {}) => { const e = document.createElement(tag); Object.assign(e.style, css); Object.assign(e, props); return e; };
const tx = (e, t) => { e.textContent = t; return e; };
const cap = (t) => tx(mk("div", {
  fontSize: "9px", fontWeight: "700", letterSpacing: ".1em",
  textTransform: "uppercase", color: C.muted, marginBottom: "5px",
}), t);
const noDrag = (e) => {
  e.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  return e;
};

if (!document.getElementById("krea2-onenode-css")) {
  const st = document.createElement("style");
  st.id = "krea2-onenode-css";
  st.textContent = `@keyframes k2-light-sweep{0%{left:-80%;opacity:1}100%{left:130%;opacity:0}}`;
  document.head.appendChild(st);
}

function Pill(txt, active, onClick, disabled) {
  const b = mk("button", {
    background: active ? LIME : C.bg2, color: active ? "#111" : (disabled ? C.muted : C.text),
    border: `1px solid ${active ? LIME : C.border}`,
    borderRadius: "20px", padding: "3px 9px", fontSize: "9px",
    fontWeight: active ? "700" : "400", cursor: disabled ? "not-allowed" : "pointer",
    transition: "all .14s", outline: "none", whiteSpace: "nowrap",
    opacity: disabled ? ".5" : "1",
  });
  tx(b, txt);
  if (!disabled) {
    b.onmousedown = () => b.style.transform = "scale(.95)";
    b.onmouseup = () => b.style.transform = "";
    b.onmouseleave = () => b.style.transform = "";
    b.onclick = onClick;
  }
  return noDrag(b);
}

function TBtn(txt, onClick, disabled) {
  const b = mk("button", {
    background: "transparent", border: `1.5px solid ${C.borderH}`,
    borderRadius: "6px", padding: "4px 11px", cursor: disabled ? "not-allowed" : "pointer",
    color: C.muted, fontSize: "11px", fontWeight: "700",
    display: "flex", alignItems: "center", gap: "5px",
    transition: "opacity .15s, border-color .15s, color .15s", outline: "none",
    opacity: disabled ? ".45" : "1",
  });
  tx(b, txt);
  if (!disabled) {
    b.onmouseenter = () => { b.style.borderColor = C.text; b.style.color = C.text; };
    b.onmouseleave = () => { b.style.borderColor = C.borderH; b.style.color = C.muted; };
    b.onclick = onClick;
  }
  return noDrag(b);
}

function NI(val, min, max, step, onChange, width = "72px") {
  const inp = mk("input", {
    width, height: "28px", background: C.bg2, border: `1px solid ${C.border}`,
    borderRadius: "6px", boxSizing: "border-box", color: C.text,
    fontSize: "11px", padding: "0 7px", outline: "none", transition: "border-color .15s",
  }, { type: "number", value: val, min, max, step });
  inp.onfocus = () => inp.style.borderColor = LIME;
  inp.onblur = () => inp.style.borderColor = C.border;
  inp.addEventListener("change", () => onChange(parseFloat(String(inp.value).replace(",", "."))));
  inp.addEventListener("keydown", (e) => e.stopPropagation());
  return noDrag(inp);
}

// iOS-style toggle (reference preferences)
function Toggle(on, onChange) {
  const t = mk("button", {
    width: "40px", height: "22px", borderRadius: "20px", border: "none",
    cursor: "pointer", position: "relative", outline: "none", flexShrink: "0",
    transition: "background .18s",
  });
  const knob = mk("div", {
    position: "absolute", top: "3px", width: "16px", height: "16px",
    borderRadius: "50%", transition: "left .18s, background .18s",
  });
  t.appendChild(knob);
  const sync = () => {
    t.style.background = t._on ? LIME : C.bg3;
    knob.style.left = t._on ? "21px" : "3px";
    knob.style.background = t._on ? "#111" : C.muted;
  };
  t._on = !!on;
  sync();
  t.onclick = (e) => { e.stopPropagation(); t._on = !t._on; sync(); onChange(t._on); };
  t._set = (v) => { t._on = !!v; sync(); };
  return noDrag(t);
}

// custom dropdown (reference DD): dark trigger, lime value, fixed filterable panel
function DD(items, selected, onChange, labelOf) {
  const lbl = labelOf || ((x) => String(x));
  let val = selected;
  const wrap = mk("div", { position: "relative", width: "100%", minWidth: "0" });
  const trig = mk("div", {
    background: C.bg3, border: `1px solid ${C.border}`, borderRadius: "7px",
    padding: "0 8px", height: "28px", display: "flex", alignItems: "center",
    justifyContent: "space-between", cursor: "pointer", boxSizing: "border-box",
    transition: "border-color .15s", userSelect: "none", overflow: "hidden",
  });
  const trigTxt = mk("span", {
    fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis",
    whiteSpace: "nowrap", flex: "1", minWidth: "0",
  });
  const setTxt = () => { tx(trigTxt, val != null ? lbl(val) : "— select —"); trigTxt.style.color = val != null ? LIME : C.muted; };
  setTxt();
  const arr = mk("span", { fontSize: "8px", color: C.muted, marginLeft: "5px", flexShrink: "0" });
  tx(arr, "▾");
  trig.append(trigTxt, arr);
  const panel = mk("div", {
    display: "none", position: "fixed", background: C.bg1,
    border: `1px solid ${C.borderH}`, borderRadius: "8px", zIndex: "999999",
    flexDirection: "column", boxShadow: "0 8px 28px rgba(0,0,0,.9)",
    overflow: "hidden", minWidth: "140px",
  });
  const srch = mk("input", {
    background: C.bg2, border: "none", borderBottom: `1px solid ${C.border}`,
    padding: "7px 10px", color: C.text, fontSize: "11px", outline: "none",
    width: "100%", boxSizing: "border-box",
  }, { type: "text", placeholder: "Type to filter…" });
  srch.addEventListener("keydown", (e) => e.stopPropagation());
  const list = mk("div", { overflowY: "auto", maxHeight: "200px" });
  list.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  const render = (q) => {
    list.replaceChildren();
    items().filter(i => !q || lbl(i).toLowerCase().includes(q.toLowerCase())).forEach(item => {
      const isSel = item === val;
      const r = mk("div", {
        padding: "7px 12px", fontSize: "11px", cursor: "pointer",
        color: isSel ? LIME : C.text, background: isSel ? C.bg2 : "transparent",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", transition: "background .1s",
      });
      tx(r, lbl(item));
      r.onmouseenter = () => r.style.background = C.bg3;
      r.onmouseleave = () => r.style.background = item === val ? C.bg2 : "transparent";
      r.onclick = () => { val = item; setTxt(); close(); onChange(item); };
      list.appendChild(r);
    });
  };
  const close = () => { panel.style.display = "none"; document.removeEventListener("pointerdown", onDoc, true); };
  const onDoc = (e) => { if (!panel.contains(e.target) && !trig.contains(e.target)) close(); };
  trig.onclick = () => {
    if (panel.style.display === "flex") { close(); return; }
    const rect = trig.getBoundingClientRect();
    // The node UI is scaled by the canvas zoom, but this panel lives on
    // document.body (unscaled). Scale it to match so it lines up with the
    // trigger at any zoom level.
    let s = 1;
    try { s = app.canvas?.ds?.scale || 1; } catch (e) {}
    panel.style.transformOrigin = "top left";
    panel.style.transform = `scale(${s})`;
    panel.style.left = rect.left + "px";
    panel.style.width = Math.max(rect.width / s, 140) + "px";
    const ph = Math.min(items().length * 28 + 44, 244) * s;
    const fitsBelow = rect.bottom + 4 + ph <= window.innerHeight - 8;
    panel.style.top = (fitsBelow ? rect.bottom + 4 : Math.max(8, rect.top - ph - 4)) + "px";
    srch.value = ""; render("");
    panel.style.display = "flex";
    list.scrollTop = 0;
    srch.focus({ preventScroll: true });
    document.addEventListener("pointerdown", onDoc, true);
  };
  srch.oninput = () => render(srch.value);
  panel.append(srch, list);
  document.body.appendChild(panel);
  wrap.appendChild(trig);
  wrap._setValue = (v) => { val = v; setTxt(); };
  return noDrag(wrap);
}

function LimeChip(txtStr, onClick) {
  const b = mk("button", {
    background: "linear-gradient(135deg,rgba(240,255,65,.10),rgba(240,255,65,.04))",
    border: "1.5px solid rgba(240,255,65,.35)", cursor: "pointer",
    padding: "2px 8px 2px 6px", color: LIME, outline: "none",
    display: "flex", alignItems: "center", gap: "5px", borderRadius: "5px",
    transition: "all .15s", flexShrink: "0",
  });
  const plus = mk("span", { fontSize: "11px", fontWeight: "700", lineHeight: "1" });
  tx(plus, "+");
  const t = mk("span", { fontSize: "9px", fontWeight: "700", letterSpacing: ".04em" });
  tx(t, txtStr);
  const badge = mk("span", {
    fontSize: "7px", fontWeight: "700", background: LIME, color: "#111",
    borderRadius: "20px", padding: "0 4px", lineHeight: "1.6", display: "none", flexShrink: "0",
  });
  b.append(plus, t, badge);
  b.onmouseenter = () => { b.style.background = "linear-gradient(135deg,rgba(240,255,65,.18),rgba(240,255,65,.08))"; b.style.borderColor = LIME; };
  b.onmouseleave = () => { b.style.background = "linear-gradient(135deg,rgba(240,255,65,.10),rgba(240,255,65,.04))"; b.style.borderColor = "rgba(240,255,65,.35)"; };
  b.onclick = (e) => { e.stopPropagation(); onClick(); };
  b._badge = badge;
  return noDrag(b);
}

function DarkChip(txtStr, onClick, disabled) {
  const b = mk("button", {
    background: "rgba(10,10,10,.85)", border: `1px solid ${C.borderH}`,
    borderRadius: "6px", padding: "4px 10px", cursor: disabled ? "not-allowed" : "pointer",
    color: disabled ? C.muted : C.text, fontSize: "10px", fontWeight: "700",
    outline: "none", transition: "all .15s", opacity: disabled ? ".6" : "1",
  });
  tx(b, txtStr);
  if (!disabled && onClick) {
    b.onmouseenter = () => b.style.borderColor = C.text;
    b.onmouseleave = () => b.style.borderColor = C.borderH;
    b.onclick = (e) => { e.stopPropagation(); onClick(); };
  }
  return noDrag(b);
}

// ── global websocket listeners ───────────────────────────────────────────────
function _active() { return window.__krea2_active || null; }
function _isOurs(evt) {
  const a = _active();
  const pid = evt?.detail?.prompt_id;
  return !!(a && pid && (pid === a.S._promptId || a.S._scene?.jobs?.has(pid)));
}
// Scene job for this event, or null when it's a single T2I run.
function _sceneJob(evt) {
  const a = _active();
  return a?.S?._scene?.jobs?.get(evt?.detail?.prompt_id) || null;
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
    const job = _sceneJob(evt);
    if (job && job.status !== "running") { job.status = "running"; a.sceneRowUpdate?.(job.idx, "running"); }
    if (d?.max) a.setStatus(job ? `Scene ${job.seq}/${a.S._scene.total} · Sampling ${d.value}/${d.max}` : `Sampling ${d.value}/${d.max}`);
  });

  api.addEventListener("executed", (evt) => {
    if (!_isOurs(evt)) return;
    const a = _active();
    const imgs = evt.detail?.output?.images;
    if (!imgs?.length) return;
    a.showBatch(imgs);
    a.showImage(imgs[0]);
  });

  api.addEventListener("execution_success", (evt) => {
    if (!_isOurs(evt)) return;
    const a = _active();
    const job = _sceneJob(evt);
    if (job) {
      const sc = a.S._scene;
      job.status = "done"; sc.done++;
      a.sceneRowUpdate?.(job.idx, "done");
      if (sc.done >= sc.total) {
        a.setStatus(`Scene complete — ${sc.total} prompt${sc.total > 1 ? "s" : ""} done.`, C.ok);
        if (a.S.soundOn) playDone();  // single chime at scene end
        a.S._scene = null;
        a.done();
      } else {
        a.setStatus(`Scene ${sc.done}/${sc.total} complete.`);
      }
      return;
    }
    a.setStatus("Done.", C.ok);
    if (a.S.soundOn) playDone();
    a.done();
    a.S._promptId = null;
  });

  api.addEventListener("execution_error", (evt) => {
    if (!_isOurs(evt)) return;
    const a = _active();
    const d = evt.detail;
    const job = _sceneJob(evt);
    if (job) {
      // One failed row must not end the scene — the rest of the server queue
      // keeps executing. End only once every job is accounted for.
      const sc = a.S._scene;
      job.status = "error"; sc.done++;
      a.sceneRowUpdate?.(job.idx, "error");
      a.setStatus(`Scene ${job.seq}/${sc.total} error in ${d?.node_type || "?"}: ${(d?.exception_message || "unknown").slice(0, 100)}`, C.err);
      if (sc.done >= sc.total) { a.S._scene = null; a.done(); }
      return;
    }
    a.setStatus(`Error in ${d?.node_type || "?"}: ${(d?.exception_message || "unknown").slice(0, 140)}`, C.err);
    a.done();
    a.S._promptId = null;
  });

  api.addEventListener("execution_interrupted", (evt) => {
    if (!_isOurs(evt)) return;
    const a = _active();
    if (a.S._scene) {
      // Stop already cleared the pending queue server-side; tear down locally.
      // (If Stop tore down first, _isOurs is already false — idempotent.)
      a.S._scene = null;
      a.setStatus("Scene stopped.");
      a.done();
      return;
    }
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
      this.color = C.bg0; this.bgcolor = C.bg0; this.resizable = true;
      this.outputs = [];
      if (this.widgets) this.widgets = [];
      this.addOutput("image", "IMAGE");

      if (!window.__krea2_nodes) window.__krea2_nodes = {};
      const cached = window.__krea2_nodes[this.id];
      if (cached) {
        cached.currentNode = this;
        this._mountUI(cached.root);
        return;
      }
      this._buildUI();
    };

    nodeType.prototype._mountUI = function (root) {
      const self = this;
      // Widget size tracks the live node size so the dashboard fills the node
      // at any user-dragged size (the layout engine treats computeSize/
      // getMinHeight as fixed — it does not stretch DOM widgets for us).
      const slotH0 = (LiteGraph.NODE_SLOT_HEIGHT || 20);
      const rowsOf = () => Math.max((self.inputs || []).length, (self.outputs || []).length);
      const innerH = () => Math.max(360, self.size[1] - rowsOf() * slotH0 - 18);
      this.addDOMWidget("k2_ui", "div", root, {
        getValue() { return null; }, setValue() {}, serialize: false,
        // classic mode: canvasOnly stops the Parameters side-panel stealing the widget;
        // Nodes 2.0 (Vue) skips canvasOnly widgets entirely, so it must be off there.
        canvasOnly: !_isVueNodes(),
        computeSize() { return [Math.max(MIN_W, self.size[0]), innerH()]; },
        getMinHeight: innerH,
        getMaxHeight: innerH,
      });
      const slotH = (LiteGraph.NODE_SLOT_HEIGHT || 20);
      const rows = Math.max((this.inputs || []).length, (this.outputs || []).length);
      if (!this.size || this.size[0] < MIN_W || this.size[1] < MIN_H + rows * slotH) {
        this.setSize([NODE_W, NODE_H + rows * slotH]);
      }

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
      // Free resize with a sane floor so the dashboard never collapses.
      const slotH = (LiteGraph.NODE_SLOT_HEIGHT || 20);
      const rows = Math.max((this.inputs || []).length, (this.outputs || []).length);
      this.size[0] = Math.max(this.size[0], MIN_W);
      this.size[1] = Math.max(this.size[1], MIN_H + rows * slotH);
    };
    // LiteGraph clamps a node to computeSize() while dragging the resize
    // corner. The default derives it from widget heights — but our widget's
    // height tracks the node height, which feeds back and auto-grows the node
    // (~10px per frame while held). Return a static minimum instead.
    nodeType.prototype.computeSize = function () {
      const slotH = (LiteGraph.NODE_SLOT_HEIGHT || 20);
      const rows = Math.max((this.inputs || []).length, (this.outputs || []).length);
      return [MIN_W, MIN_H + rows * slotH];
    };
    nodeType.prototype.onDrawConnections = function () {};
    nodeType.prototype.getSlotMenuOptions = function () { return []; };
    // NOTE: no onRemoved cache cleanup — onRemoved also fires on a workflow
    // SWITCH (graph cleared), and deleting the cache there wiped the UI state
    // and the in-flight result. The cache must survive tab switches so the
    // preview is still there when the user comes back.

    // ── UI build ─────────────────────────────────────────────────────────────
    nodeType.prototype._buildUI = function () {
      const self = this;
      const S = loadState();
      S._models = { diffusion_models: [], text_encoders: [], vaes: [], loras: [] };
      S._generating = false;
      const persist = () => saveState(S);

      const root = mk("div", {
        width: "100%", height: "100%", boxSizing: "border-box",
        background: C.bg0, color: C.text, display: "flex", flexDirection: "column",
        gap: "10px", padding: "12px 14px",
        fontFamily: "'Inter','Segoe UI',system-ui,sans-serif", fontSize: "12px",
        borderRadius: "8px", overflow: "hidden", position: "relative", userSelect: "none",
      });
      // Forward wheel events to the graph canvas so scroll-to-zoom works over
      // the node (same as the original — the canvas is a sibling of the DOM
      // widget, so bubbling alone never reaches it). Scrollable child areas
      // stop propagation first when they actually have content to scroll.
      root.addEventListener("wheel", (e) => {
        const cv = app.canvas?.canvas;
        if (cv) cv.dispatchEvent(new WheelEvent("wheel", {
          deltaY: e.deltaY, deltaX: e.deltaX,
          clientX: e.clientX, clientY: e.clientY,
          ctrlKey: e.ctrlKey, metaKey: e.metaKey,
          bubbles: true, cancelable: true,
        }));
        e.preventDefault();
      }, { passive: false });
      const scrollGuard = (el, horizontal) => el.addEventListener("wheel", (e) => {
        if (horizontal ? el.scrollWidth > el.clientWidth + 2 : el.scrollHeight > el.clientHeight + 2) e.stopPropagation();
      }, { passive: true });

      // ── toolbar ────────────────────────────────────────────────────────────
      const toolbar = mk("div", { display: "flex", alignItems: "center", gap: "5px", flex: "0 0 auto" });
      let pillT2I, pillScene;
      for (const m of MODES) {
        const p = Pill(m, m === "T2I" && S.tab !== "scene", m === "T2I" ? () => setTab("t2i") : () => {}, m !== "T2I");
        if (m !== "T2I") p.title = `${m} — coming in a later phase`;
        toolbar.appendChild(p);
        if (m === "T2I") {
          pillT2I = p;
          pillScene = Pill("SCENE", S.tab === "scene", () => setTab("scene"), false);
          pillScene.title = "Scene — queue multiple prompts in one run";
          toolbar.appendChild(pillScene);
        }
      }
      // Pill() bakes active styling at creation; tab switches restyle in place.
      function setPillActive(p, active) {
        p.style.background = active ? LIME : C.bg2;
        p.style.color = active ? "#111" : C.text;
        p.style.border = `1px solid ${active ? LIME : C.border}`;
        p.style.fontWeight = active ? "700" : "400";
      }
      toolbar.appendChild(mk("div", { flex: "1" }));

      const galleryBtn = mk("button", {
        background: "linear-gradient(90deg,#1a1a2e,#0f3460,#533483)",
        border: "1.5px solid rgba(255,255,255,.15)",
        borderRadius: "6px", padding: "4px 11px", cursor: "not-allowed", color: "#e0e0ff",
        fontSize: "11px", fontWeight: "700", display: "flex", alignItems: "center", gap: "5px",
        outline: "none", opacity: ".45",
      }, { title: "Gallery — coming in a later phase" });
      galleryBtn.append(tx(mk("span", { fontSize: "12px" }), "▦"), tx(mk("span"), "Gallery"));
      toolbar.appendChild(noDrag(galleryBtn));

      const helpBtn = TBtn("✦ Help", null, true);
      helpBtn.title = "Help — coming in a later phase";
      toolbar.appendChild(helpBtn);

      const settingsBtn = TBtn("⚙ Settings", () => { settingsOverlay.style.display = "flex"; });
      toolbar.appendChild(settingsBtn);
      root.appendChild(toolbar);

      // ── main row ───────────────────────────────────────────────────────────
      const mainRow = mk("div", { display: "flex", gap: "12px", alignItems: "stretch", flex: "1", minHeight: "0" });
      root.appendChild(mainRow);

      const left = mk("div", {
        width: "300px", flexShrink: "0", minHeight: "0", overflowY: "auto", overflowX: "hidden",
        display: "flex", flexDirection: "column",
      });
      scrollGuard(left);
      mainRow.appendChild(left);

      // SIZE — dropdown of "W × H" + Custom…, like the original
      left.appendChild(cap("Size"));
      const sizeItems = () => [...PRESETS.map((_, i) => i), CUSTOM];
      const sizeLbl = (i) => i === CUSTOM ? "Custom…" : `${PRESETS[i].w} × ${PRESETS[i].h}`;
      const presetDD = DD(sizeItems, S.presetIdx, (i) => {
        S.presetIdx = i;
        if (i !== CUSTOM) { S.customW = PRESETS[i].w; S.customH = PRESETS[i].h; }
        persist(); syncSize();
      }, sizeLbl);
      left.appendChild(presetDD);

      const whRow = mk("div", { display: "flex", alignItems: "center", gap: "6px", marginTop: "8px" });
      const dims = () => S.presetIdx === CUSTOM
        ? { w: S.customW, h: S.customH }
        : { w: PRESETS[S.presetIdx].w, h: PRESETS[S.presetIdx].h };
      const wIn = NI(dims().w, 64, 4096, 16, (v) => {
        S.customW = Math.max(64, Math.round((v || 64) / 16) * 16);
        S.presetIdx = CUSTOM; presetDD._setValue(CUSTOM); persist(); syncSize();
      }, "72px");
      const hIn = NI(dims().h, 64, 4096, 16, (v) => {
        S.customH = Math.max(64, Math.round((v || 64) / 16) * 16);
        S.presetIdx = CUSTOM; presetDD._setValue(CUSTOM); persist(); syncSize();
      }, "72px");
      const swapBtn = mk("button", {
        background: C.bg2, border: `1px solid ${C.border}`, borderRadius: "6px",
        width: "28px", height: "28px", cursor: "pointer", color: C.muted, fontSize: "12px",
        outline: "none", flexShrink: "0", transition: "color .15s,border-color .15s",
      }, { title: "Swap orientation" });
      tx(swapBtn, "⇅");
      swapBtn.onmouseenter = () => { swapBtn.style.color = C.text; swapBtn.style.borderColor = C.borderH; };
      swapBtn.onmouseleave = () => { swapBtn.style.color = C.muted; swapBtn.style.borderColor = C.border; };
      swapBtn.onclick = (e) => {
        e.stopPropagation();
        const d = dims();
        if (S.presetIdx !== CUSTOM) {
          const j = PRESETS.findIndex(p => p.w === d.h && p.h === d.w);
          if (j >= 0) { S.presetIdx = j; presetDD._setValue(j); persist(); syncSize(); return; }
        }
        S.customW = d.h; S.customH = d.w;
        S.presetIdx = CUSTOM; presetDD._setValue(CUSTOM); persist(); syncSize();
      };
      const finalTxt = mk("div", { fontSize: "9px", color: "rgba(240,255,65,.55)", fontWeight: "700", whiteSpace: "nowrap" });
      whRow.append(wIn, noDrag(swapBtn), hIn, finalTxt);
      left.appendChild(whRow);

      function syncSize() {
        const d = dims();
        wIn.value = d.w; hIn.value = d.h;
        tx(finalTxt, `→ ${Math.round(d.w * S.upscaleBy)}×${Math.round(d.h * S.upscaleBy)}`);
      }

      // BATCH
      const batchCap = cap("Batch"); batchCap.style.marginTop = "12px";
      left.appendChild(batchCap);
      const batchWrap = mk("div", { width: "90px" });
      batchWrap.appendChild(DD(() => [1, 2, 4, 8], S.batch, (n) => { S.batch = n; persist(); }, (n) => `×${n}`));
      left.appendChild(batchWrap);

      // ── ADVANCED CONTROL box (indigo, toggled from Settings prefs) ─────────
      const advCap = (t) => tx(mk("span", {
        fontSize: "9px", fontWeight: "700", letterSpacing: ".08em",
        textTransform: "uppercase", color: C.adv, flexShrink: "0",
      }), t);
      const advPanel = mk("div", {
        display: "none", flexDirection: "column", gap: "8px",
        border: `1.5px solid ${C.advBorder}`, borderRadius: "10px",
        padding: "10px", marginTop: "12px", boxSizing: "border-box",
      });
      left.appendChild(advPanel);

      // grid row: label+control pairs locked on one line; controls shrink, never wrap
      function advGrid(...pairs) {
        const cols = pairs.map(([, , w]) => `auto ${w || "1fr"}`).join(" ");
        const r = mk("div", { display: "grid", gridTemplateColumns: cols, gap: "7px", alignItems: "center" });
        for (const [labelTxt, control] of pairs) {
          r.appendChild(advCap(labelTxt));
          control.style.width = "100%";
          control.style.minWidth = "0";
          control.style.boxSizing = "border-box";
          r.appendChild(control);
        }
        return r;
      }
      const advDivider = (t) => {
        const d = mk("div", { display: "flex", alignItems: "center", gap: "6px", marginTop: "2px" });
        d.appendChild(advCap(t));
        d.appendChild(mk("div", { flex: "1", height: "1px", background: C.advBorder, opacity: ".5" }));
        return d;
      };

      // pass 1
      advPanel.appendChild(advDivider("Pass 1 · base"));
      const p1Steps = NI(S.p1.steps, 1, 100, 1, v => { S.p1.steps = v; S.p1.endStep = v; persist(); });
      const p1Cfg = NI(S.p1.cfg, 0, 30, 0.1, v => { S.p1.cfg = v; persist(); });
      advPanel.appendChild(advGrid(["Steps", p1Steps], ["CFG", p1Cfg]));
      const p1Samp = DD(() => SAMPLERS, S.p1.sampler, v => { S.p1.sampler = v; persist(); });
      const p1Sched = DD(() => SCHEDULERS, S.p1.scheduler, v => { S.p1.scheduler = v; persist(); });
      advPanel.appendChild(advGrid(["Sampler", p1Samp], ["Sched", p1Sched]));

      // seed (reference keeps seed in the advanced box)
      const seedIn = NI(S.seed, 0, 1e15, 1, (v) => { S.seed = Math.max(0, Math.floor(v || 0)); persist(); });
      const randChip = mk("button", {
        background: "none", border: "none", cursor: "pointer", outline: "none",
        display: "flex", alignItems: "center", gap: "4px", padding: "0 2px", flexShrink: "0",
      }, { title: "Randomize seed each generation" });
      const randIco = tx(mk("span", { fontSize: "11px" }), "⊡");
      const randLbl = tx(mk("span", { fontSize: "9px", fontWeight: "700", letterSpacing: ".08em" }), "RANDOM");
      randChip.append(randIco, randLbl);
      randChip.onclick = (e) => { e.stopPropagation(); S.randomizeSeed = !S.randomizeSeed; persist(); syncSeedUI(); };
      const reuseBtn = mk("button", {
        background: "none", border: "none", cursor: "pointer", outline: "none",
        color: C.muted, fontSize: "12px", padding: "0 2px", flexShrink: "0",
      }, { title: "Reuse last generation's seed" });
      tx(reuseBtn, "↩");
      reuseBtn.onclick = (e) => {
        e.stopPropagation();
        if (S.lastSeed != null) {
          S.seed = S.lastSeed; S.randomizeSeed = false;
          seedIn.value = S.seed; persist(); syncSeedUI();
        }
      };
      function syncSeedUI() {
        randIco.style.color = S.randomizeSeed ? LIME : C.muted;
        randLbl.style.color = S.randomizeSeed ? LIME : C.muted;
        seedIn.style.opacity = S.randomizeSeed ? ".45" : "1";
        reuseBtn.style.opacity = S.lastSeed != null ? "1" : ".4";
      }
      {
        const seedRow = mk("div", { display: "grid", gridTemplateColumns: "auto 1fr auto auto", gap: "7px", alignItems: "center" });
        seedRow.appendChild(advCap("Seed"));
        seedIn.style.width = "100%"; seedIn.style.minWidth = "0"; seedIn.style.boxSizing = "border-box";
        seedRow.append(seedIn, noDrag(randChip), noDrag(reuseBtn));
        advPanel.appendChild(seedRow);
      }
      syncSeedUI();

      // pass 2
      advPanel.appendChild(advDivider("Pass 2 · refine"));
      const p2Steps = NI(S.p2.steps, 1, 100, 1, v => { S.p2.steps = v; persist(); });
      const p2Cfg = NI(S.p2.cfg, 0, 30, 0.1, v => { S.p2.cfg = v; persist(); });
      const p2Start = NI(S.p2.startStep, 0, 100, 1, v => { S.p2.startStep = v; persist(); });
      advPanel.appendChild(advGrid(["Steps", p2Steps], ["CFG", p2Cfg], ["Start", p2Start]));
      const p2Samp = DD(() => SAMPLERS, S.p2.sampler, v => { S.p2.sampler = v; persist(); });
      const p2Sched = DD(() => SCHEDULERS, S.p2.scheduler, v => { S.p2.scheduler = v; persist(); });
      advPanel.appendChild(advGrid(["Sampler", p2Samp], ["Sched", p2Sched]));

      // upscale
      advPanel.appendChild(advDivider("Upscale (latent)"));
      const upMeth = DD(() => UPSCALE_METHODS, S.upscaleMethod, v => { S.upscaleMethod = v; persist(); });
      const upFac = NI(S.upscaleBy, 1, 4, 0.05, v => { S.upscaleBy = v; persist(); syncSize(); });
      advPanel.appendChild(advGrid(["Method", upMeth], ["×", upFac]));

      const syncAdv = () => { advPanel.style.display = S.advancedUI ? "flex" : "none"; };
      syncAdv();

      // spacer then Generate pinned to bottom
      left.appendChild(mk("div", { flex: "1", minHeight: "10px" }));

      // Scene time estimate (scene tab only) — sits just above the Generate row.
      const estimateLine = mk("div", {
        display: "none", fontSize: "10px", fontWeight: "700",
        color: "rgba(240,255,65,.55)", marginBottom: "6px", whiteSpace: "nowrap",
        overflow: "hidden", textOverflow: "ellipsis", flexShrink: "0",
      });
      left.appendChild(estimateLine);
      function sceneImageCount() {
        return S.sceneRows.reduce((n, r) => n + (r.prompt.trim() ? r.batch : 0), 0);
      }
      function fmtEst(mins) {
        if (mins >= 60) return `~${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m`;
        return `~${Math.round(mins)}m`;
      }
      function updateEstimate() {
        const n = sceneImageCount();
        tx(estimateLine, n ? `${n} image${n > 1 ? "s" : ""} · ${fmtEst(n * PER_IMAGE_MIN)}` : "No prompts yet");
      }

      const genRow = mk("div", { display: "flex", gap: "0", alignItems: "stretch", width: "100%", boxSizing: "border-box", flexShrink: "0" });
      const genBtn = mk("button", {
        background: LIME, color: "#111", border: "2px solid transparent", borderRadius: "8px",
        padding: "0", height: "38px", fontSize: "13px", fontWeight: "700",
        cursor: "pointer", flex: "1", letterSpacing: ".02em",
        transition: "background .3s,color .3s,border-color .3s,transform .1s",
        outline: "none", position: "relative", overflow: "hidden",
      });
      tx(genBtn, "Generate");
      const genSweep = mk("div", {
        position: "absolute", top: "0", left: "-80%", width: "50%", height: "100%",
        background: "linear-gradient(90deg,transparent 0%,rgba(255,255,255,.75) 50%,transparent 100%)",
        transform: "skewX(-20deg)", pointerEvents: "none", opacity: "0",
      });
      genBtn.appendChild(genSweep);
      genBtn.onmouseenter = () => {
        if (!S._generating) {
          genSweep.style.animation = "none"; void genSweep.offsetWidth;
          genSweep.style.animation = "k2-light-sweep 1s ease forwards";
        }
      };
      genBtn.addEventListener("click", (e) => { e.stopPropagation(); S.tab === "scene" ? doRunScene() : doGenerate(); });
      noDrag(genBtn);

      const stopBtn = mk("button", {
        background: "transparent", border: `1px solid ${C.border}`, borderRadius: "8px",
        color: C.muted, fontSize: "12px", cursor: "pointer",
        maxWidth: "0", minWidth: "0", width: "0", opacity: "0", padding: "0", height: "38px",
        transition: "max-width .25s ease, opacity .25s ease, padding .25s ease, margin .25s ease",
        outline: "none", overflow: "hidden", flexShrink: "0", whiteSpace: "nowrap",
      });
      tx(stopBtn, "■ Stop");
      stopBtn.onmouseenter = () => { stopBtn.style.borderColor = C.err; stopBtn.style.color = C.err; };
      stopBtn.onmouseleave = () => { stopBtn.style.borderColor = C.border; stopBtn.style.color = C.muted; };
      stopBtn.onclick = async (e) => {
        e.stopPropagation();
        if (S._scene) {
          // Clear pending FIRST so the interrupt can't let the next queued job
          // start before the clear lands. NOTE: {clear:true} empties ALL
          // pending items in ComfyUI's server queue, not just this scene's.
          try {
            await api.fetchApi("/queue", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ clear: true }),
            });
          } catch (err) {}
          try { await api.fetchApi("/interrupt", { method: "POST" }); } catch (err) {}
          // execution_interrupted never fires if we stopped between jobs —
          // tear down locally instead of waiting for it.
          S._scene = null;
          finishGenerate();
          setStatus("Scene stopped; queue cleared.");
          return;
        }
        try { await api.fetchApi("/interrupt", { method: "POST" }); } catch (err) {}
      };
      noDrag(stopBtn);
      function syncStop(running) {
        if (running) {
          stopBtn.style.maxWidth = "80px"; stopBtn.style.width = "auto";
          stopBtn.style.opacity = "1"; stopBtn.style.padding = "0 12px"; stopBtn.style.marginLeft = "8px";
        } else {
          stopBtn.style.maxWidth = "0"; stopBtn.style.width = "0";
          stopBtn.style.opacity = "0"; stopBtn.style.padding = "0"; stopBtn.style.marginLeft = "0";
        }
      }
      genRow.append(genBtn, stopBtn);
      left.appendChild(genRow);

      // ── scene column (SCENE tab): multi-prompt queue ───────────────────────
      const sceneCol = mk("div", {
        width: "300px", flexShrink: "0", minHeight: "0",
        display: "none", flexDirection: "column",
      });
      sceneCol.appendChild(cap("Scene prompts"));
      const sceneRowsEl = mk("div", {
        display: "flex", flexDirection: "column", gap: "8px",
        overflowY: "auto", overflowX: "hidden", flex: "1", minHeight: "0", paddingRight: "2px",
      });
      scrollGuard(sceneRowsEl);
      sceneCol.appendChild(sceneRowsEl);
      const sceneAddBtn = LimeChip("Add prompt", () => {
        if (S._scene) return;
        S.sceneRows.push({ prompt: "", batch: 1 });
        persist(); renderSceneRows(); updateEstimate();
      });
      sceneAddBtn.style.alignSelf = "flex-start";
      sceneAddBtn.style.marginTop = "8px";
      sceneCol.appendChild(sceneAddBtn);
      mainRow.appendChild(sceneCol);

      // Per-row status dots. Rebuilt with the rows; structural edits are locked
      // while a scene runs, so indices stay valid for the whole run.
      const SCENE_TA_MIN = 40, SCENE_TA_MAX = 160;
      let _sceneDots = [];
      function sceneDotSet(dot, status) {
        const m = {
          idle:    { t: String((dot._idx ?? 0) + 1), c: C.muted, title: "" },
          queued:  { t: "○", c: C.muted, title: "Queued" },
          running: { t: "●", c: LIME,    title: "Running" },
          done:    { t: "●", c: C.ok,    title: "Done" },
          error:   { t: "●", c: C.err,   title: "Error" },
        }[status] || { t: String((dot._idx ?? 0) + 1), c: C.muted, title: "" };
        tx(dot, m.t); dot.style.color = m.c; dot.title = m.title;
      }
      function sceneRowUpdate(idx, status) {
        const dot = _sceneDots[idx];
        if (dot) sceneDotSet(dot, status);
      }
      // Structural edits (add/remove/batch) are disabled during a run so the
      // row list can't drift out of sync with the submitted job snapshot;
      // textareas stay editable (prompts are snapshotted at queue time).
      function syncSceneLock() {
        const lock = !!S._scene;
        sceneAddBtn.style.pointerEvents = lock ? "none" : "";
        sceneAddBtn.style.opacity = lock ? ".4" : "1";
        sceneRowsEl.querySelectorAll("[data-k2-lock]").forEach(el => {
          el.style.pointerEvents = lock ? "none" : "";
          el.style.opacity = lock ? ".4" : "1";
        });
      }
      function renderSceneRows() {
        sceneRowsEl.replaceChildren();
        _sceneDots = [];
        S.sceneRows.forEach((row, idx) => {
          const r = mk("div", { display: "flex", alignItems: "flex-start", gap: "6px" });

          const dot = mk("div", {
            fontSize: "9px", fontWeight: "700", width: "12px", flexShrink: "0",
            marginTop: "9px", textAlign: "center", color: C.muted, userSelect: "none",
          });
          dot._idx = idx;
          sceneDotSet(dot, "idle");
          _sceneDots.push(dot);
          r.appendChild(dot);

          const ta = mk("textarea", {
            flex: "1", minWidth: "0", height: SCENE_TA_MIN + "px", resize: "none",
            background: C.bg2, border: `1px solid ${C.border}`, borderRadius: "8px",
            color: C.text, fontSize: "11px", padding: "7px 9px",
            boxSizing: "border-box", outline: "none", lineHeight: "1.5",
            fontFamily: "inherit", transition: "border-color .15s", display: "block",
            overflowY: "hidden",
          }, { placeholder: `Prompt ${idx + 1}…`, spellcheck: false });
          ta.value = row.prompt;
          const grow = () => {
            ta.style.height = "auto";
            const h = Math.min(Math.max(SCENE_TA_MIN, ta.scrollHeight), SCENE_TA_MAX);
            ta.style.height = h + "px";
            ta.style.overflowY = ta.scrollHeight > SCENE_TA_MAX ? "auto" : "hidden";
          };
          ta.onfocus = () => ta.style.borderColor = LIME;
          ta.onblur = () => ta.style.borderColor = C.border;
          // Input only mutates state — never re-render here (it would drop focus).
          ta.oninput = () => { row.prompt = ta.value; persist(); grow(); updateEstimate(); };
          ta.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); ta.blur(); } });
          scrollGuard(ta);
          noDrag(ta);
          requestAnimationFrame(grow);
          r.appendChild(ta);

          const bWrap = mk("div", { width: "58px", flexShrink: "0", marginTop: "3px" });
          bWrap.dataset.k2Lock = "1";
          bWrap.appendChild(DD(() => SCENE_BATCHES, row.batch,
            (n) => { row.batch = n; persist(); updateEstimate(); }, (n) => `×${n}`));
          r.appendChild(bWrap);

          const rm = mk("button", {
            background: "none", border: "none", cursor: "pointer", padding: "0 2px",
            color: C.muted, fontSize: "13px", outline: "none", flexShrink: "0", marginTop: "8px",
          }, { title: "Remove" });
          rm.dataset.k2Lock = "1";
          tx(rm, "✕");
          rm.onmouseenter = () => rm.style.color = C.err;
          rm.onmouseleave = () => rm.style.color = C.muted;
          rm.onclick = (e) => {
            e.stopPropagation();
            if (S._scene) return;
            S.sceneRows.splice(idx, 1);
            if (!S.sceneRows.length) S.sceneRows.push({ prompt: "", batch: 1 });
            persist(); renderSceneRows(); updateEstimate();
          };
          r.appendChild(noDrag(rm));

          sceneRowsEl.appendChild(r);
        });
        syncSceneLock();
      }

      // Tab switching: one shared skeleton, scene swaps the T2I batch control,
      // prompt bar and Generate label for the prompt-list column + estimate.
      function syncTab() {
        const scene = S.tab === "scene";
        setPillActive(pillT2I, !scene);
        setPillActive(pillScene, scene);
        batchCap.style.display = scene ? "none" : "";
        batchWrap.style.display = scene ? "none" : "";
        sceneCol.style.display = scene ? "flex" : "none";
        promptWrap.style.display = scene ? "none" : "";
        estimateLine.style.display = scene ? "" : "none";
        if (!S._generating) {
          tx(genBtn, scene ? "Run Scene" : "Generate");
          genBtn.appendChild(genSweep);
        }
        if (scene) updateEstimate();
      }
      function setTab(t) {
        if (S.tab === t) return;
        S.tab = t; persist(); syncTab();
      }

      // ---- right: preview ----
      const right = mk("div", {
        flex: "1", minWidth: "0", minHeight: "0", position: "relative",
        background: "#000", borderRadius: "8px", overflow: "hidden",
        display: "flex", alignItems: "center", justifyContent: "center",
        border: `1px solid ${C.border}`,
      });
      mainRow.appendChild(right);

      const previewImg = mk("img", { maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "none" });
      noDrag(previewImg);
      previewImg.onerror = () => {
        // Restored image no longer on disk (e.g. temp cleared by a ComfyUI
        // restart) — fall back to the empty state instead of a broken icon.
        if ((previewImg.src || "").includes("/view")) {
          previewImg.style.display = "none";
          previewEmpty.style.display = "";
          saveChip.style.display = "none";
        }
      };
      right.appendChild(previewImg);
      const previewEmpty = mk("div", { color: C.muted, fontSize: "11px", textAlign: "center", lineHeight: "1.7" });
      previewEmpty.innerHTML = "No image yet<br><span style='font-size:9px'>Generate to see the result here</span>";
      right.appendChild(previewEmpty);

      const overlayTR = mk("div", { position: "absolute", top: "8px", right: "8px", display: "flex", gap: "6px", zIndex: "5" });
      const saveChip = DarkChip("Save", () => doSaveTemp());
      saveChip.style.display = "none";
      const useAsChip = DarkChip("Use as…  ▾", null, true);
      useAsChip.title = "Send to I2I / Edit — coming with those modes";
      overlayTR.append(saveChip, useAsChip);
      right.appendChild(overlayTR);

      const thumbStrip = mk("div", {
        position: "absolute", left: "8px", right: "8px", bottom: "8px",
        display: "none", gap: "6px", overflowX: "auto", zIndex: "5",
        padding: "4px", background: "rgba(10,10,10,.6)", borderRadius: "8px",
      });
      scrollGuard(thumbStrip, true);
      right.appendChild(thumbStrip);

      // ── PROMPT ─────────────────────────────────────────────────────────────
      const promptWrap = mk("div", { display: "flex", flexDirection: "column", gap: "5px", flex: "0 0 auto" });
      const promptHdr = mk("div", { display: "flex", alignItems: "center", gap: "5px" });
      const promptCap = cap("Prompt"); promptCap.style.marginBottom = "0";
      const loraBtn = LimeChip("Add LoRA", () => { loraOverlay.style.display = "flex"; renderLoraRows(); });
      loraBtn.style.marginLeft = "auto";
      promptHdr.append(promptCap, loraBtn);
      promptWrap.appendChild(promptHdr);

      const TA_MIN = 64, TA_MAX = 240;
      const promptTA = mk("textarea", {
        width: "100%", height: TA_MIN + "px", resize: "none",
        background: C.bg2, border: `1px solid ${C.border}`, borderRadius: "8px",
        color: C.text, fontSize: "12px", padding: "9px 12px",
        boxSizing: "border-box", outline: "none", lineHeight: "1.55",
        fontFamily: "inherit", transition: "border-color .15s", display: "block",
        overflowY: "hidden",
      }, { placeholder: "Describe what you want to generate…", spellcheck: false });
      promptTA.value = S.prompt;
      // Auto-grow with the text (up to a cap, then scroll) instead of clipping.
      const taGrow = () => {
        promptTA.style.height = "auto";
        const h = Math.min(Math.max(TA_MIN, promptTA.scrollHeight), TA_MAX);
        promptTA.style.height = h + "px";
        promptTA.style.overflowY = promptTA.scrollHeight > TA_MAX ? "auto" : "hidden";
      };
      promptTA.onfocus = () => promptTA.style.borderColor = LIME;
      promptTA.onblur = () => promptTA.style.borderColor = C.border;
      promptTA.oninput = () => { S.prompt = promptTA.value; persist(); taGrow(); };
      promptTA.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); promptTA.blur(); } });
      scrollGuard(promptTA);
      noDrag(promptTA);
      promptWrap.appendChild(promptTA);
      requestAnimationFrame(taGrow);
      root.appendChild(promptWrap);

      const statusLine = mk("div", {
        fontSize: "10px", color: C.muted, minHeight: "13px", flex: "0 0 auto",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      });
      root.appendChild(statusLine);
      const setStatus = (t, color = C.muted) => { statusLine.textContent = t; statusLine.style.color = color; };

      // ── LoRA overlay ───────────────────────────────────────────────────────
      const loraOverlay = mk("div", {
        position: "absolute", inset: "0", zIndex: "250", display: "none",
        alignItems: "center", justifyContent: "center",
        padding: "14px", boxSizing: "border-box",
      });
      const loraBg = mk("div", { position: "absolute", inset: "0", background: "rgba(0,0,0,.6)" });
      const loraPanel = mk("div", {
        position: "relative",
        background: "linear-gradient(145deg,#111 0%,#0d0d0d 100%)",
        border: "1px solid rgba(240,255,65,.18)",
        borderRadius: "16px", padding: "18px 20px 20px", width: "100%", maxWidth: "560px",
        maxHeight: "100%",
        boxShadow: "0 20px 60px rgba(0,0,0,.95),inset 0 1px 0 rgba(255,255,255,.04)",
        display: "flex", flexDirection: "column", gap: "14px", boxSizing: "border-box",
      });
      noDrag(loraPanel);
      const loraHdr = mk("div", { display: "flex", alignItems: "center", gap: "8px" });
      const loraTitle = mk("div", {
        fontSize: "12px", fontWeight: "700", color: "#fff", flex: "1",
        letterSpacing: ".06em", textTransform: "uppercase",
      });
      tx(loraTitle, "LoRA");
      const loraClose = mk("button", {
        background: "none", border: "none", cursor: "pointer",
        color: C.muted, fontSize: "16px", lineHeight: "1", padding: "0", outline: "none", flexShrink: "0",
      });
      tx(loraClose, "×");
      loraClose.onmouseenter = () => loraClose.style.color = "#fff";
      loraClose.onmouseleave = () => loraClose.style.color = C.muted;
      const closeLora = () => { loraOverlay.style.display = "none"; };
      loraClose.onclick = closeLora;
      loraBg.onclick = closeLora;
      loraHdr.append(loraTitle, loraClose);
      const loraDivider = mk("div", { width: "100%", height: "1px", background: "rgba(240,255,65,.10)", marginTop: "-6px" });
      const loraRows = mk("div", { display: "flex", flexDirection: "column", gap: "10px", overflowY: "auto", minHeight: "0" });
      loraRows.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
      const loraAddRow = LimeChip("Add LoRA", () => {
        S.loras.push({ on: true, name: "", strength: 1.0 });
        persist(); renderLoraRows();
      });
      loraAddRow.style.alignSelf = "flex-start";
      loraPanel.append(loraHdr, loraDivider, loraRows, loraAddRow);
      loraOverlay.append(loraBg, loraPanel);
      root.appendChild(loraOverlay);

      function syncLoraBadge() {
        const n = S.loras.filter(l => l.name && l.on !== false).length;
        tx(loraBtn._badge, String(n));
        loraBtn._badge.style.display = n > 0 ? "" : "none";
        loraBtn.style.borderColor = n > 0 ? LIME : "rgba(240,255,65,.35)";
      }

      function renderLoraRows() {
        loraRows.replaceChildren();
        if (!S.loras.length) {
          loraRows.appendChild(tx(mk("div", { color: C.muted, fontSize: "11px" }), "No LoRAs — base model only."));
        }
        S.loras.forEach((row, idx) => {
          const r = mk("div", { display: "flex", alignItems: "center", gap: "8px", opacity: row.on ? "1" : ".45" });
          const togBtn = mk("button", {
            background: "none", border: "none", cursor: "pointer", padding: "0 2px",
            color: row.on ? LIME : C.muted, fontSize: "13px", outline: "none", flexShrink: "0",
          }, { title: row.on ? "Disable" : "Enable" });
          tx(togBtn, row.on ? "●" : "○");
          togBtn.onclick = (e) => { e.stopPropagation(); row.on = !row.on; persist(); renderLoraRows(); syncLoraBadge(); };
          r.appendChild(noDrag(togBtn));

          const dd = DD(
            () => S._models.loras,
            row.name || null,
            (v) => { row.name = v; persist(); syncLoraBadge(); },
            (f) => f.replace(/\.safetensors$/i, ""),
          );
          dd.style.flex = "1"; dd.style.minWidth = "0";
          r.appendChild(dd);

          const st = NI(row.strength, -4, 4, 0.05, (v) => { row.strength = isFinite(v) ? v : 1.0; persist(); }, "58px");
          st.title = "Strength";
          r.appendChild(st);

          const rm = mk("button", {
            background: "none", border: "none", cursor: "pointer", padding: "0 2px",
            color: C.muted, fontSize: "13px", outline: "none", flexShrink: "0",
          }, { title: "Remove" });
          tx(rm, "✕");
          rm.onmouseenter = () => rm.style.color = C.err;
          rm.onmouseleave = () => rm.style.color = C.muted;
          rm.onclick = (e) => { e.stopPropagation(); S.loras.splice(idx, 1); persist(); renderLoraRows(); syncLoraBadge(); };
          r.appendChild(noDrag(rm));

          loraRows.appendChild(r);
        });
      }
      syncLoraBadge();

      // ── SETTINGS overlay (models + preferences, like the original) ─────────
      const settingsOverlay = mk("div", {
        position: "absolute", inset: "0", zIndex: "300", display: "none",
        flexDirection: "column", background: C.bg0, borderRadius: "10px",
        padding: "16px 20px", boxSizing: "border-box", gap: "14px",
        overflowY: "auto",
      });
      noDrag(settingsOverlay);
      settingsOverlay.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
      root.appendChild(settingsOverlay);

      const setHdr = mk("div", { display: "flex", alignItems: "center", gap: "8px" });
      const setTitle = mk("div", {
        fontSize: "15px", fontWeight: "700", letterSpacing: ".12em",
        textTransform: "uppercase", color: "#fff", flex: "1",
      });
      tx(setTitle, "Settings");
      const refreshBtn = TBtn("↻ Refresh models", () => loadModels(true));
      const closeBtn = mk("button", {
        background: "transparent", border: `1.5px solid rgba(255,103,103,.55)`,
        borderRadius: "6px", padding: "4px 11px", cursor: "pointer",
        color: C.err, fontSize: "11px", fontWeight: "700", outline: "none",
        transition: "all .15s",
      });
      tx(closeBtn, "× Close");
      closeBtn.onmouseenter = () => { closeBtn.style.background = "rgba(255,103,103,.1)"; };
      closeBtn.onmouseleave = () => { closeBtn.style.background = "transparent"; };
      closeBtn.onclick = (e) => { e.stopPropagation(); settingsOverlay.style.display = "none"; };
      setHdr.append(setTitle, refreshBtn, noDrag(closeBtn));
      settingsOverlay.appendChild(setHdr);

      // model pickers row
      const modelsRow = mk("div", { display: "flex", gap: "16px" });
      function modelCol(title, path, listKey, get, set) {
        const col = mk("div", { flex: "1", minWidth: "0" });
        const t = cap(title); t.style.marginBottom = "1px";
        const p = mk("div", { fontSize: "10px", color: C.muted, marginBottom: "6px" });
        tx(p, path);
        const dd = DD(() => S._models[listKey], get() || null, (v) => { set(v); persist(); });
        col.append(t, p, dd);
        col._dd = dd;
        return col;
      }
      const unetCol = modelCol("Model", "/models/diffusion_models", "diffusion_models",
        () => S.modelUnet, (v) => S.modelUnet = v);
      const clipCol = modelCol("Text encoder", "/models/text_encoders", "text_encoders",
        () => S.modelClip, (v) => S.modelClip = v);
      const vaeCol = modelCol("VAE", "/models/vae", "vaes",
        () => S.modelVae, (v) => S.modelVae = v);
      modelsRow.append(unetCol, clipCol, vaeCol);
      settingsOverlay.appendChild(modelsRow);

      // preferences
      const prefCap = cap("Preferences"); prefCap.style.marginTop = "10px";
      settingsOverlay.appendChild(prefCap);
      function prefRow(labelTxt, toggle, subTxt) {
        const wrap = mk("div", { borderBottom: `1px solid ${C.dim}`, padding: "10px 0" });
        const r = mk("div", { display: "flex", alignItems: "center", gap: "10px" });
        r.appendChild(tx(mk("div", { fontSize: "13px", color: C.text, flex: "1" }), labelTxt));
        r.appendChild(toggle);
        wrap.appendChild(r);
        if (subTxt) wrap.appendChild(tx(mk("div", { fontSize: "10px", color: C.muted, marginTop: "5px", lineHeight: "1.5" }), subTxt));
        return wrap;
      }
      settingsOverlay.appendChild(prefRow("Notification sound on complete",
        Toggle(S.soundOn, (v) => { S.soundOn = v; persist(); })));
      settingsOverlay.appendChild(prefRow("Advanced control (steps, CFG, sampler…)",
        Toggle(S.advancedUI, (v) => { S.advancedUI = v; persist(); syncAdv(); })));
      settingsOverlay.appendChild(prefRow("Auto-save results",
        Toggle(S.autoSave, (v) => { S.autoSave = v; persist(); }),
        "When off, results are temporary until you click Save on the preview."));
      const folderRow = mk("div", { padding: "10px 0", display: "flex", alignItems: "center", gap: "10px" });
      folderRow.appendChild(tx(mk("div", { fontSize: "13px", color: C.text, flex: "1" }), "Output folder"));
      folderRow.appendChild(TBtn("Open", () => {
        api.fetchApi("/krea2_onenode/open_folder", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(S.lastImage?.type === "output" ? S.lastImage : {}),
        }).catch(() => {});
      }));
      settingsOverlay.appendChild(folderRow);

      function loadModels(showStatus) {
        return api.fetchApi("/krea2_onenode/models").then(r => r.json()).then(d => {
          S._models = {
            diffusion_models: d.diffusion_models || [],
            text_encoders: d.text_encoders || [],
            vaes: d.vaes || [],
            loras: d.loras || [],
          };
          if (showStatus) setStatus("Model lists refreshed.", C.ok);
        }).catch(() => { if (showStatus) setStatus("Model refresh failed.", C.err); });
      }
      loadModels(false);

      // ── image display helpers ──────────────────────────────────────────────
      function viewUrl(img) {
        const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || "", type: img.type || "output", t: Date.now() });
        return api.apiURL(`/view?${q}`);
      }
      function showImage(img) {
        S.lastImage = img;
        previewImg.src = viewUrl(img);
        previewImg.style.display = "";
        previewEmpty.style.display = "none";
        saveChip.style.display = img.type === "temp" ? "" : "none";
        pushOutput(img);
      }
      function showBatch(images) {
        thumbStrip.replaceChildren();
        if (images.length <= 1) { thumbStrip.style.display = "none"; return; }
        thumbStrip.style.display = "flex";
        images.forEach((img) => {
          const t = mk("img", {
            height: "52px", borderRadius: "6px", cursor: "pointer",
            border: `1px solid ${C.borderH}`,
          }, { src: viewUrl(img) });
          t.addEventListener("click", (e) => { e.stopPropagation(); showImage(img); });
          thumbStrip.appendChild(noDrag(t));
        });
      }
      function showPreviewBlob(blob) {
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

      // Default opts reproduce the single-run T2I behavior exactly; the Scene
      // tab overrides prompt/batch/seed per queued row and forces SaveImage.
      function buildPrompt(tpl, o = {}) {
        const { promptText = S.prompt, batch = S.batch, seed = null, forceSave = false } = o;
        const p = JSON.parse(JSON.stringify(tpl));
        const d = dims();

        p["K2:unet"].inputs.unet_name = S.modelUnet;
        p["K2:clip"].inputs.clip_name = S.modelClip;
        p["K2:vae"].inputs.vae_name = S.modelVae;

        p["K2:pos"].inputs.text = promptText || "";
        p["K2:latent"].inputs.width = d.w;
        p["K2:latent"].inputs.height = d.h;
        p["K2:latent"].inputs.batch_size = batch;

        if (seed != null) {
          p["K2:seed"].inputs.seed = seed;
        } else {
          if (S.randomizeSeed) S.seed = Math.floor(Math.random() * 1e15);
          S.lastSeed = S.seed;
          seedIn.value = S.seed;
          syncSeedUI();
          p["K2:seed"].inputs.seed = S.seed;
        }

        // LoRA stack → Power Lora Loader dynamic inputs
        let li = 1;
        for (const row of S.loras) {
          if (!row.name) continue;
          p["K2:lora"].inputs[`lora_${li}`] = {
            on: !!row.on, lora: row.name, strength: row.strength, strengthTwo: null,
          };
          li++;
        }

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
        // (scene runs pass forceSave — unattended results must land on disk)
        if (!S.autoSave && !forceSave) {
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
        if (!S.prompt.trim()) { setStatus("Enter a prompt first.", C.err); return; }
        S._generating = true;
        tx(genBtn, "Generating…");
        genBtn.appendChild(genSweep);
        genBtn.style.background = C.bg3;
        genBtn.style.color = C.muted;
        syncStop(true);
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
          setStatus(`Error: ${e.message}`, C.err);
          console.error("[Krea2OneNode] submit failed:", e);
        }
      }
      function finishGenerate() {
        S._generating = false;
        tx(genBtn, S.tab === "scene" ? "Run Scene" : "Generate");
        genBtn.appendChild(genSweep);
        genBtn.style.background = LIME;
        genBtn.style.color = "#111";
        syncStop(false);
        syncSceneLock();
      }

      // ── scene run: queue every prompt upfront (server-side queue does the
      // sequencing, so the run survives the frontend sleeping overnight) ─────
      async function doRunScene() {
        if (S._generating) return;
        const rows = S.sceneRows
          .map((r, i) => ({ prompt: r.prompt.trim(), batch: r.batch, idx: i }))
          .filter(r => r.prompt);
        if (!rows.length) { setStatus("Add at least one prompt.", C.err); return; }
        S._generating = true;
        tx(genBtn, "Queueing…");
        genBtn.appendChild(genSweep);
        genBtn.style.background = C.bg3;
        genBtn.style.color = C.muted;
        syncStop(true);
        setStatus("Queueing scene…");
        persist();
        try {
          const tpl = await getTemplate();
          S.sceneRows.forEach((_, i) => sceneRowUpdate(i, "idle"));
          S._scene = { jobs: new Map(), total: rows.length, done: 0 };
          syncSceneLock();
          // Register before the first POST — the first job can start emitting
          // events while later rows are still being queued.
          window.__krea2_active = { S, showImage, showBatch, showPreviewBlob, setStatus, done: finishGenerate, sceneRowUpdate };
          let lastSeed = null, images = 0, failed = null;
          for (let si = 0; si < rows.length; si++) {
            const r = rows[si];
            const seed = S.randomizeSeed ? Math.floor(Math.random() * 1e15) : S.seed;
            const prompt = buildPrompt(tpl, { promptText: r.prompt, batch: r.batch, seed, forceSave: true });
            const resp = await api.fetchApi("/prompt", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ prompt, client_id: api.clientId, extra_data: { enable_previews: true } }),
            });
            const result = await resp.json();
            if (!resp.ok || result.error) {
              const msg = result?.error?.message || result?.error || `HTTP ${resp.status}`;
              const nodeErrs = result?.node_errors && Object.values(result.node_errors)
                .flatMap(e => (e.errors || []).map(x => x.message)).join("; ");
              sceneRowUpdate(r.idx, "error");
              failed = { row: si + 1, msg: nodeErrs || msg };
              // A /prompt rejection is almost always a shared settings/template
              // problem — the remaining rows would fail identically. Abort the
              // loop; already-queued jobs keep running and stay tracked.
              break;
            }
            S._scene.jobs.set(result.prompt_id, { idx: r.idx, seq: si + 1, status: "queued" });
            sceneRowUpdate(r.idx, "queued");
            lastSeed = seed;
            images += r.batch;
          }
          if (lastSeed != null) {
            S.lastSeed = lastSeed;
            if (S.randomizeSeed) { S.seed = lastSeed; seedIn.value = lastSeed; }
            syncSeedUI();
            persist();
          }
          if (!S._scene.jobs.size) {
            S._scene = null;
            finishGenerate();
            setStatus(failed ? `Scene failed to queue (row ${failed.row}): ${failed.msg}` : "Scene failed to queue.", C.err);
            return;
          }
          S._scene.total = S._scene.jobs.size;
          tx(genBtn, "Running scene…");
          genBtn.appendChild(genSweep);
          setStatus(failed
            ? `Scene: ${S._scene.total} queued, row ${failed.row} failed: ${failed.msg}`
            : `Scene queued — ${S._scene.total} prompt${S._scene.total > 1 ? "s" : ""} · ${images} image${images > 1 ? "s" : ""} · ${fmtEst(images * PER_IMAGE_MIN)}`,
            failed ? C.warn : C.muted);
        } catch (e) {
          S._scene = null;
          finishGenerate();
          setStatus(`Error: ${e.message}`, C.err);
          console.error("[Krea2OneNode] scene submit failed:", e);
        }
      }

      async function doSaveTemp() {
        const img = S.lastImage;
        if (!img || img.type !== "temp") { setStatus("Nothing unsaved to save."); return; }
        try {
          const r = await api.fetchApi("/krea2_onenode/save_temp", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename: img.filename, subfolder: img.subfolder || "" }),
          });
          const d = await r.json();
          if (d.ok) {
            S.lastImage = { filename: d.filename, subfolder: d.subfolder, type: "output" };
            saveChip.style.display = "none";
            setStatus(`Saved as ${d.filename}`, C.ok);
          } else setStatus(`Save failed: ${d.error}`, C.err);
        } catch (e) { setStatus(`Save failed: ${e.message}`, C.err); }
      }

      syncSize();
      renderSceneRows();
      updateEstimate();
      syncTab();

      // Restore the last result into the preview after a rebuild (page reload,
      // workflow switch that didn't hit the cache) — the image is on disk.
      if (S.lastImage?.filename) {
        previewImg.src = viewUrl(S.lastImage);
        previewImg.style.display = "";
        previewEmpty.style.display = "none";
        saveChip.style.display = S.lastImage.type === "temp" ? "" : "none";
      }

      // ── mount + cache ──────────────────────────────────────────────────────
      window.__krea2_nodes[this.id] = { root, S, currentNode: this };
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
