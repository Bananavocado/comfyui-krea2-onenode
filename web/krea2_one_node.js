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
// w/h are the landscape base dims, rounded to multiples of 16; the orientation
// toggle swaps them. Squares ignore orientation.
const PRESETS = [
  { label: "360p",  w: 640,  h: 368 },
  { label: "480p",  w: 864,  h: 480 },
  { label: "720p",  w: 1280, h: 720 },
  { label: "1080p", w: 1920, h: 1088 },
  { label: "2K",    w: 2560, h: 1440 },
  { label: "4K",    w: 3840, h: 2160 },
  { label: "Square (512×512)",   w: 512,  h: 512,  square: true },
  { label: "Square (1024×1024)", w: 1024, h: 1024, square: true },
];
const CUSTOM = -1;
// Old numeric presetIdx (pre-orientation states) → [new presetIdx, orient].
const LEGACY_PRESET_MAP = {
  0: [3, "land"], 1: [3, "port"], 2: [2, "land"], 3: [2, "port"],
  4: [1, "land"], 5: [1, "port"], 6: [7, "land"], 7: [6, "land"],
};

const SAMPLERS = ["euler", "euler_ancestral", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_sde", "dpmpp_3m_sde", "res_multistep", "lcm", "ddim", "uni_pc", "er_sde"];
const SCHEDULERS = ["simple", "sgm_uniform", "normal", "karras", "exponential", "beta", "linear_quadratic", "kl_optimal"];
const MODES = ["T2I", "EDIT", "UPSCALE"];

// Batch tab: rough per-image duration used for the pre-run time estimate
// (user's machine averages ~2.5 min/image).
const PER_IMAGE_MIN = 2.5;

// ── state ────────────────────────────────────────────────────────────────────
function defaultState() {
  return {
    prompt: "",
    presetIdx: 2,               // 720p
    orient: "land",             // "land" | "port" (ignored for squares/custom)
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
    // EDIT tab: always loaded at strength 1.0, only the file is pickable.
    modelIdLora: "krea2_identity_edit_v1_2.safetensors",
    // T2I (quality template): ClownsharK two-pass, same-res refine, no upscale.
    q: {
      p1Steps: 8, p1Cfg: 1.0, p1Sampler: "linear/euler", p1Sched: "simple",
      denoise: 0.2, eta: 0.9, p2Cfg: 1.0, p2Sampler: "exponential/res_2s", p2Sched: "bong_tangent",
      grain: 0.09, grainOn: true, sharpen: 1, sharpenOn: true,
    },
    // Upscale tab. Two engines: "cloud" = SeedVR2 on fal.ai (paid per call,
    // fixed target resolution, noise 0.1 = node default) and "local" = the
    // same model run on your own GPU through ComfyUI's core SeedVR2 nodes
    // (free, needs the weights on disk). `local` is nested so it can't collide
    // with the stale up.model/up.factor keys loadState still strips.
    up: {
      engine: "cloud", resolution: "2160p", noise: 0.1, folder: null,
      local: {
        model: "", vae: "", factor: 2, tile: 512,
        steps: 1, cfg: 1, sampler: "euler", scheduler: "simple",
      },
    },
    // Edit tab (Krea2 Edit / identity-edit): mode "none" = plain I2I edit,
    // "mask" = painted-region edit, "ref" = two-image person-into-scene.
    // Defaults mirror the source workflows (ref_boost 4 = fidelity preset).
    edit: {
      mode: "none", mp: 1,
      refBoost: 4, refBoostA: 1, fitMode: "fit", groundingPx: 768,
      steps: 10, cfg: 1, sampler: "euler", scheduler: "simple", denoise: 1,
    },
    tab: "t2i",                 // "t2i" | "scene" | "upscale" | "edit"
    // BATCH tab (internal id "scene"): one prompt per line; each non-empty
    // line queues one image on Generate.
    sceneText: "",
  };
}
function loadState() {
  try {
    const s = Object.assign(defaultState(), JSON.parse(localStorage.getItem(LS_KEY) || "{}"));
    if (s.orient !== "land" && s.orient !== "port") {
      // Pre-orientation state: remap the old preset list onto the new one.
      s.orient = "land";
      if (s.presetIdx !== CUSTOM && LEGACY_PRESET_MAP[s.presetIdx]) {
        [s.presetIdx, s.orient] = LEGACY_PRESET_MAP[s.presetIdx];
      }
    }
    if (s.presetIdx !== CUSTOM && !PRESETS[s.presetIdx]) s.presetIdx = 2;
    s.q = Object.assign(defaultState().q, s.q || {});
    s.up = Object.assign(defaultState().up, s.up || {});
    // Stale keys from earlier upscaler iterations (4x UltraSharpV2 / factor mode).
    delete s.up.model; delete s.up.blend; delete s.up.mode; delete s.up.factor;
    if (!["1080p", "1440p", "2160p"].includes(s.up.resolution)) s.up.resolution = "2160p";
    s.up.local = Object.assign(defaultState().up.local, s.up.local || {});
    if (!["cloud", "local"].includes(s.up.engine)) s.up.engine = "cloud";
    if (![2, 4, 6, 8].includes(s.up.local.factor)) s.up.local.factor = 2;
    if (![128, 256, 512].includes(s.up.local.tile)) s.up.local.tile = 512;
    s.edit = Object.assign(defaultState().edit, s.edit || {});
    delete s.edit.growPx; delete s.edit.blurRad;   // stale: composite chain removed
    if (!["none", "mask", "ref"].includes(s.edit.mode)) s.edit.mode = "none";
    if (![1, 1.5, 2.25].includes(s.edit.mp)) s.edit.mp = 1;
    // The legacy turbo T2I pipeline is gone — its tab, template and per-pass
    // settings collapsed into the (former) HQ one, which is now just "T2I".
    if (s.tab === "t2iq") s.tab = "t2i";
    delete s.p1; delete s.p2; delete s.upscaleMethod; delete s.upscaleBy;
    if (!["t2i", "scene", "upscale", "edit"].includes(s.tab)) s.tab = "t2i";
    // 2026-08-05: per-row scene prompts (+per-row batch) collapsed into one
    // text blob, one prompt per line. Old rows migrate as one line each.
    if (typeof s.sceneText !== "string") {
      s.sceneText = Array.isArray(s.sceneRows)
        ? s.sceneRows.map(r => (typeof r?.prompt === "string" ? r.prompt.trim() : "")).filter(Boolean).join("\n")
        : "";
    }
    delete s.sceneRows;
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
  st.textContent = [
    `@keyframes k2-light-sweep{0%{left:-80%;opacity:1}100%{left:130%;opacity:0}}`,
    `@keyframes k2-thumb-in{from{opacity:0;transform:translateY(8px) scale(.92)}}`,
    `@keyframes k2-lb-in{from{opacity:0}}`,
    `.k2-thumbs::-webkit-scrollbar{height:5px}`,
    `.k2-thumbs::-webkit-scrollbar-thumb{background:rgba(255,255,255,.18);border-radius:3px}`,
    `.k2-thumbs::-webkit-scrollbar-track{background:transparent}`,
    `@media (prefers-reduced-motion: reduce){.k2-lb,.k2-lb *,.k2-thumbs,.k2-thumbs *{animation:none!important;transition:none!important}}`,
  ].join("\n");
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

// Effective UI scale for panels that live on document.body (DD panels, tips,
// rect math): the canvas zoom normally, or the fullscreen overlay's own scale
// while a dashboard is fullscreened (the overlay bypasses the canvas
// transform entirely, so ds.scale is wrong there).
let _k2FsScale = null;   // non-null while a dashboard is fullscreen
function uiScale() {
  if (_k2FsScale) return _k2FsScale;
  try { return app.canvas?.ds?.scale || 1; } catch (e) { return 1; }
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

// Drag-to-scrub number box: hold + drag horizontally = ±step per notch
// (~10px of travel), plain click (no movement) = type a custom value.
function DragNI(val, min, max, step, onChange, width = "48px") {
  const wrap = mk("div", {
    width, height: "28px", background: C.bg2, border: `1px solid ${C.border}`,
    borderRadius: "6px", boxSizing: "border-box", color: C.text,
    fontSize: "11px", display: "flex", alignItems: "center", justifyContent: "center",
    cursor: "ew-resize", userSelect: "none", transition: "border-color .15s",
    overflow: "hidden", flexShrink: "0",
  });
  let value = val;
  const fmt = (v) => String(parseFloat((Math.round(v * 100) / 100).toFixed(2)));
  const lbl = mk("span", { pointerEvents: "none" });
  tx(lbl, fmt(value));
  wrap.appendChild(lbl);
  const clamp = (v) => Math.min(max, Math.max(min, v));

  const PX_PER_STEP = 10;
  let drag = null;
  wrap.addEventListener("pointerdown", (e) => {
    e.stopPropagation();               // keep LiteGraph from dragging the node
    if (wrap._editing) return;
    drag = { x0: e.clientX, v0: value, moved: false, id: e.pointerId };
    try { wrap.setPointerCapture(e.pointerId); } catch (err) {}
  });
  wrap.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    if (!drag.moved && Math.abs(dx) < 4) return;   // click-vs-drag threshold
    drag.moved = true;
    wrap.style.borderColor = LIME;
    const v = clamp(drag.v0 + Math.round(dx / PX_PER_STEP) * step);
    if (v !== value) { value = v; tx(lbl, fmt(value)); onChange(value); }
  });
  const endDrag = () => {
    if (!drag) return;
    const wasDrag = drag.moved;
    try { wrap.releasePointerCapture(drag.id); } catch (err) {}
    drag = null;
    wrap.style.borderColor = C.border;
    if (!wasDrag) startEdit();
  };
  wrap.addEventListener("pointerup", endDrag);
  wrap.addEventListener("pointercancel", endDrag);

  function startEdit() {
    wrap._editing = true;
    lbl.style.display = "none";
    const inp = mk("input", {
      width: "100%", height: "100%", background: "transparent", border: "none",
      color: LIME, fontSize: "11px", textAlign: "center", outline: "none",
      boxSizing: "border-box", padding: "0",
    }, { type: "text", value: fmt(value) });
    wrap.appendChild(inp);
    wrap.style.cursor = "text";
    wrap.style.borderColor = LIME;
    const done = (commitVal) => {
      if (!wrap._editing) return;
      wrap._editing = false;
      if (commitVal) {
        const v = parseFloat(String(inp.value).replace(",", "."));
        if (isFinite(v)) { value = clamp(v); onChange(value); }
      }
      inp.remove();
      tx(lbl, fmt(value));
      lbl.style.display = "";
      wrap.style.cursor = "ew-resize";
      wrap.style.borderColor = C.border;
    };
    inp.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); done(true); }
      if (e.key === "Escape") { e.preventDefault(); done(false); }
    });
    inp.addEventListener("blur", () => done(true));
    inp.addEventListener("pointerdown", (e) => e.stopPropagation());
    requestAnimationFrame(() => { inp.focus(); inp.select(); });
  }
  wrap._setValue = (v) => { value = clamp(v); tx(lbl, fmt(value)); };
  return wrap;
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
    // The node UI is scaled by the canvas zoom (or the fullscreen overlay),
    // but this panel lives on document.body (unscaled). Scale it to match so
    // it lines up with the trigger at any zoom level.
    const s = uiScale();
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
  return !!(a && pid && (pid === a.S._promptId || a.S._scene?.jobs?.has(pid) || a.S._batchRun?.jobs?.has(pid)));
}
// Scene job for this event, or null when it's a single T2I run.
function _sceneJob(evt) {
  const a = _active();
  return a?.S?._scene?.jobs?.get(evt?.detail?.prompt_id) || null;
}
// Batch job for this event (T2I batch ×N runs as N sequential jobs), or null.
function _batchJob(evt) {
  const a = _active();
  return a?.S?._batchRun?.jobs?.get(evt?.detail?.prompt_id) || null;
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
    if (d?.max) {
      // Unified progress bar: pass 1 fills 0 → split, pass 2 continues
      // split → 100 (no reset between passes). Split comes from the step
      // settings snapshotted at submit. Non-sampler progress (tiled VAE etc.)
      // only updates the label so the bar never jumps backwards.
      const nodeId = String(d.node || "");
      const plan = a.prog || { split: 0.5, p2Start: 0 };
      if (nodeId.endsWith("sampler1")) {
        const f = d.value / d.max;
        a.setStage?.(`Pass 1 · Step ${d.value}/${d.max}`, f * plan.split * 100);
      } else if (nodeId.endsWith("sampler2")) {
        // Rebase: a legacy pass 2 reports values from start_at_step, not 0.
        const s = d.max > plan.p2Start ? plan.p2Start : 0;
        const f = Math.min(1, Math.max(0, (d.value - s) / (d.max - s)));
        a.setStage?.(`Pass 2 · Step ${d.value}/${d.max}`, (plan.split + f * (1 - plan.split)) * 100);
      } else if (nodeId === "K2U:up" || nodeId === "K2UL:sampler") {
        // Upscale: the fal API node may not report at all; the local SeedVR2
        // KSampler does. Either way it's a single-stage bar.
        a.setStage?.(`Upscaling · ${d.value}/${d.max}`, (d.value / d.max) * 100);
      } else if (nodeId === "K2E:sampler") {
        // Edit: single KSampler — single-stage bar.
        a.setStage?.(`Editing · Step ${d.value}/${d.max}`, (d.value / d.max) * 100);
      } else {
        a.setStage?.("Finishing…", null);
      }
    }
    const bjob = _batchJob(evt);
    if (bjob) {
      if (d?.max) a.setStatus(`Image ${bjob.seq}/${a.S._batchRun.total} · ${bjob.up ? "Upscaling" : bjob.edit ? "Editing" : "Sampling"} ${d.value}/${d.max}`);
      return;
    }
    const job = _sceneJob(evt);
    if (job && job.status !== "running") {
      job.status = "running";
      // Don't downgrade a row dot that already went red — a later job of the
      // same row starting must not repaint it as running.
      if (!a.S._scene.rows?.get(job.idx)?.error) a.sceneRowUpdate?.(job.idx, "running");
    }
    if (d?.max) a.setStatus(job ? `Batch image ${job.seq}/${a.S._scene.total} · Sampling ${d.value}/${d.max}` : `Sampling ${d.value}/${d.max}`);
  });

  api.addEventListener("executed", (evt) => {
    if (!_isOurs(evt)) return;
    const a = _active();
    const imgs = evt.detail?.output?.images;
    if (!imgs?.length) return;
    const bjob = _batchJob(evt);
    if (bjob) {
      // Rolling queue: pop the fresh image up immediately, accumulate the
      // thumb strip across jobs instead of replacing it per job.
      const br = a.S._batchRun;
      br.images.push(...imgs);
      // Upscale/edit jobs: remember the before/after pair for the compare
      // view, and copy folder-batch results back next to their source.
      if ((bjob.up || bjob.edit) && bjob.before)
        a.registerCompare?.(imgs[0], bjob.before, bjob.edit ? "edit" : "up", bjob.origin || null);
      if (bjob.copyTo) {
        api.fetchApi("/krea2_onenode/copy_result", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...imgs[0], ...bjob.copyTo }),
        }).then(r => r.json())
          .then(d => { if (!d.ok) a.setStatus?.(`Copy-back failed: ${d.error}`, C.warn); })
          .catch(() => {});
      }
      a.galAdd(imgs);
      a.showImage(imgs[0]);
      return;
    }
    const sjob = _sceneJob(evt);
    if (sjob) {
      // Scene: same accumulation — the strip collects every finished image.
      const sc = a.S._scene;
      sc.images = sc.images || [];
      sc.images.push(...imgs);
      a.galAdd(imgs);
      a.showImage(imgs[0]);
      return;
    }
    a.galAdd(imgs);
    a.showImage(imgs[0]);
  });

  api.addEventListener("execution_success", (evt) => {
    if (!_isOurs(evt)) return;
    const a = _active();
    const bjob = _batchJob(evt);
    if (bjob) {
      const br = a.S._batchRun;
      br.done++;
      if (br.done >= br.total) {
        a.setStatus(`Done — ${br.images.length || br.total} image${br.total > 1 ? "s" : ""}.`, C.ok);
        if (a.S.soundOn) playDone();  // single chime once the queue drains
        a.S._batchRun = null;
        a.done();
      } else {
        a.setStatus(`Image ${br.done}/${br.total} done.`);
        a.syncQueueUI?.();
      }
      return;
    }
    const job = _sceneJob(evt);
    if (job) {
      const sc = a.S._scene;
      job.status = "done"; sc.done++;
      const row = sc.rows?.get(job.idx);
      if (row) {
        row.done++;
        // Row dot goes green only once every one of its images is done
        // (and none errored — error dots are sticky).
        if (row.done >= row.total && !row.error) a.sceneRowUpdate?.(job.idx, "done");
      } else {
        a.sceneRowUpdate?.(job.idx, "done");
      }
      if (sc.done >= sc.total) {
        a.setStatus(`Batch complete — ${sc.total} image${sc.total > 1 ? "s" : ""} done.`, C.ok);
        if (a.S.soundOn) playDone();  // single chime at batch end
        a.S._scene = null;
        a.done();
      } else {
        a.setStatus(`Batch ${sc.done}/${sc.total} images done.`);
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
    const bjob = _batchJob(evt);
    if (bjob) {
      // One failed image must not end the queue — later jobs keep executing.
      const br = a.S._batchRun;
      br.done++;
      a.setStatus(`Image ${bjob.seq}/${br.total} error in ${d?.node_type || "?"}: ${(d?.exception_message || "unknown").slice(0, 100)}`, C.err);
      if (br.done >= br.total) { a.S._batchRun = null; a.done(); }
      else a.syncQueueUI?.();
      return;
    }
    const job = _sceneJob(evt);
    if (job) {
      // One failed image must not end the scene — the rest of the server queue
      // keeps executing. End only once every job is accounted for.
      const sc = a.S._scene;
      job.status = "error"; sc.done++;
      const row = sc.rows?.get(job.idx);
      if (row) { row.done++; row.error = true; }
      a.sceneRowUpdate?.(job.idx, "error");
      a.setStatus(`Batch image ${job.seq}/${sc.total} error in ${d?.node_type || "?"}: ${(d?.exception_message || "unknown").slice(0, 100)}`, C.err);
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
    if (a.S._batchRun) {
      a.S._batchRun = null;
      a.setStatus("Batch stopped.");
      a.done();
      return;
    }
    if (a.S._scene) {
      // Stop already cleared the pending queue server-side; tear down locally.
      // (If Stop tore down first, _isOurs is already false — idempotent.)
      a.S._scene = null;
      a.setStatus("Batch stopped.");
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
      // No _k2Init here: node.id is still -1 and properties aren't restored yet.
    };
    // Hook order (measured): onNodeCreated(id -1) → onAdded(real id, no
    // properties) → onConfigure(id + properties). Workflow loads always reach
    // onConfigure, so build there; a node added from the menu never gets one,
    // hence the deferred onAdded fallback (a timeout, not rAF — rAF is frozen
    // in background tabs, and it lands after configure in the same task).
    nodeType.prototype.onConfigure = function () { this._k2Init(); };
    nodeType.prototype.onAdded = function () { setTimeout(() => this._k2Init(), 0); };

    // Cache key: a uuid kept in node.properties (serialized with the workflow).
    // node.id can't be used — it is -1 inside onNodeCreated, and it is only
    // unique within ONE workflow, so two workflows would share a dashboard.
    const K2_UID = "k2_uid";
    const newUid = () => (crypto?.randomUUID?.() || `k2-${Math.random().toString(36).slice(2)}`);

    nodeType.prototype._k2Uid = function () {
      if (!this.properties) this.properties = {};
      let uid = this.properties[K2_UID];
      const cached = uid && window.__krea2_nodes[uid];
      // A copy/pasted node inherits the uid; if the original owner is still
      // live in the graph, mint a fresh uid so they don't share one dashboard.
      if (cached && cached.currentNode !== this &&
          app.graph?.getNodeById?.(cached.currentNode?.id) === cached.currentNode) uid = null;
      if (!uid) { uid = newUid(); this.properties[K2_UID] = uid; }
      return uid;
    };

    nodeType.prototype._k2Init = function () {
      if (this._k2Ready) return;
      if (this.id == null || this.id === -1) return;   // not in a graph yet
      this._k2Ready = true;
      if (!window.__krea2_nodes) window.__krea2_nodes = {};
      const uid = this._k2uid = this._k2Uid();
      const cached = window.__krea2_nodes[uid];
      if (cached) {
        cached.currentNode = this;
        cached.S._node = this;
        this._mountUI(cached.root);
        return;
      }
      this._buildUI();
    };

    nodeType.prototype._mountUI = function (root) {
      const self = this;
      // A workflow switch can remount a dashboard that is currently
      // fullscreened — pull it back out of the overlay first, or the widget
      // system re-parents it with the fullscreen styles still applied.
      root._k2ExitFs?.();
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
      S._models = { diffusion_models: [], text_encoders: [], vaes: [], loras: [], upscale_models: [] };
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
        // Fullscreen: the dashboard isn't on the canvas — don't zoom the
        // graph hiding behind the overlay.
        if (_k2FsScale) { e.preventDefault(); return; }
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
      let pillT2I, pillScene, pillUp, pillEdit;
      for (const m of MODES) {
        const p = Pill(m,
          (m === "T2I" && S.tab === "t2i") || (m === "UPSCALE" && S.tab === "upscale") || (m === "EDIT" && S.tab === "edit"),
          m === "T2I" ? () => setTab("t2i") : m === "UPSCALE" ? () => setTab("upscale") : () => setTab("edit"),
          false);
        if (m === "UPSCALE") { pillUp = p; p.title = "Upscale — SeedVR2 (fal.ai API, paid) folder batch"; }
        if (m === "EDIT") { pillEdit = p; p.title = "Edit — instruction-driven image editing (mask / reference)"; }
        toolbar.appendChild(p);
        if (m === "T2I") {
          pillT2I = p;
          p.title = "Text to image — ClownsharK two-pass + grain/sharpen";
          pillScene = Pill("BATCH", S.tab === "scene", () => setTab("scene"), false);
          pillScene.title = "Batch — one prompt per line (paste or import .txt); Generate queues them all";
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

      const helpBtn = TBtn("✦ Help", () => { helpOverlay.style.display = "flex"; checkPacks(); });
      helpBtn.title = "Help — where to get the models and node packs";
      toolbar.appendChild(helpBtn);

      const settingsBtn = TBtn("⚙ Settings", () => { settingsOverlay.style.display = "flex"; });
      toolbar.appendChild(settingsBtn);

      // ── fullscreen (reference-node pattern): move the whole dashboard into a
      // fixed overlay on document.body and scale it to fill the viewport. The
      // node on the canvas goes blank until exit; Esc or the button exits.
      const FS_EXPAND = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>`;
      const FS_COLLAPSE = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5"/></svg>`;
      const fsBtn = TBtn("", () => { _fsOn ? exitFullscreen() : enterFullscreen(); });
      fsBtn.title = "Fullscreen";
      fsBtn.style.padding = "4px 8px";
      fsBtn.innerHTML = FS_EXPAND;
      toolbar.appendChild(fsBtn);
      root.appendChild(toolbar);

      let _fsOn = false, _fsOverlay = null, _fsWrap = null;
      let _fsParent = null, _fsNext = null;
      const _fsKey = (e) => {
        if (e.key !== "Escape") return;
        // Layered UIs keep Esc for themselves (their capture handlers are
        // registered on open, i.e. after this one, so we must yield here).
        if (lb.style.display !== "none" || mpWrap.style.display !== "none") return;
        e.preventDefault(); e.stopPropagation();
        exitFullscreen();
      };
      function enterFullscreen() {
        if (_fsOn) return;
        // Freeze the dashboard at its current rendered size (layout px —
        // offsetWidth ignores the canvas transform) and scale that up.
        const w = root.offsetWidth || MIN_W, h = root.offsetHeight || MIN_H;
        if (!_fsOverlay) {
          _fsOverlay = mk("div", {
            // Below the DD panels / lightbox / ctx menu / tips (999999+), so
            // body-level popups still show above the fullscreen dashboard.
            position: "fixed", inset: "0", zIndex: "999000",
            background: "rgba(6,6,8,.97)", display: "none",
            alignItems: "center", justifyContent: "center",
            boxSizing: "border-box", overflow: "hidden",
          });
          document.body.appendChild(_fsOverlay);
        }
        _fsParent = root.parentNode; _fsNext = root.nextSibling;
        const sc = Math.min(window.innerWidth / w, window.innerHeight / h) * 0.97;
        root.style.width = w + "px"; root.style.height = h + "px";
        root.style.position = "absolute"; root.style.top = "0"; root.style.left = "0";
        root.style.margin = "0";
        root.style.transformOrigin = "top left";
        root.style.transform = `scale(${sc})`;
        _fsWrap = mk("div", {
          width: Math.round(w * sc) + "px", height: Math.round(h * sc) + "px",
          position: "relative", flexShrink: "0", overflow: "hidden",
        });
        _fsWrap.appendChild(root);
        _fsOverlay.appendChild(_fsWrap);
        _fsOverlay.style.display = "flex";
        _k2FsScale = sc;
        fsBtn.innerHTML = FS_COLLAPSE;
        fsBtn.title = "Exit fullscreen (Esc)";
        document.addEventListener("keydown", _fsKey, true);
        _fsOn = true;
      }
      function exitFullscreen() {
        if (!_fsOn) return;
        if (_fsParent) {
          if (_fsNext) _fsParent.insertBefore(root, _fsNext);
          else _fsParent.appendChild(root);
        }
        root.style.position = ""; root.style.top = ""; root.style.left = "";
        root.style.margin = ""; root.style.width = "100%"; root.style.height = "100%";
        root.style.transform = ""; root.style.transformOrigin = "";
        _fsWrap?.remove(); _fsWrap = null;
        _fsOverlay.style.display = "none";
        _k2FsScale = null;
        fsBtn.innerHTML = FS_EXPAND;
        fsBtn.title = "Fullscreen";
        document.removeEventListener("keydown", _fsKey, true);
        _fsOn = false;
      }
      root._k2ExitFs = exitFullscreen;

      // ── main row ───────────────────────────────────────────────────────────
      const mainRow = mk("div", { display: "flex", gap: "12px", alignItems: "stretch", flex: "1", minHeight: "0" });
      root.appendChild(mainRow);

      const left = mk("div", {
        width: "300px", flexShrink: "0", minHeight: "0", overflowY: "auto", overflowX: "hidden",
        display: "flex", flexDirection: "column",
      });
      scrollGuard(left);
      mainRow.appendChild(left);

      // ADVANCED toggle — lives at the top of the left column (moved out of
      // Settings preferences); shows/hides the indigo advanced box below.
      const advTogRow = mk("div", { display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px", flexShrink: "0" });
      const advTogCap = cap("Advanced"); advTogCap.style.marginBottom = "0";
      advTogRow.append(advTogCap, mk("div", { flex: "1" }),
        Toggle(S.advancedUI, v => { S.advancedUI = v; persist(); syncAdv(); }));
      left.appendChild(advTogRow);

      // ── UPSCALE tab: drop zone + source folder + factor ────────────────────
      const upBox = mk("div", { display: "none", flexDirection: "column", gap: "8px" });
      upBox.appendChild(cap("Source"));

      // Drop zone — primary input. Drag images or a folder in, or click to
      // browse files. Dropped items upload straight to ComfyUI's input via
      // /upload/image; browsers hide their on-disk path, so drops can't
      // copy results back beside the source — the native Choose Folder flow
      // below remains the copy-back path. Choosing one source clears the other.
      const IMG_RE = /\.(png|jpe?g|webp)$/i;
      const upFileInput = mk("input", { display: "none" },
        { type: "file", multiple: true, accept: ".png,.jpg,.jpeg,.webp" });
      const dz = mk("div", {
        border: `1.5px dashed ${C.borderH}`, borderRadius: "10px",
        padding: "16px 10px", textAlign: "center", cursor: "pointer",
        transition: "border-color .15s, background .15s", position: "relative",
        boxSizing: "border-box", userSelect: "none",
      });
      const dzIcon = tx(mk("div", { fontSize: "15px", color: C.muted, marginBottom: "3px", pointerEvents: "none" }), "⇣");
      const dzMain = tx(mk("div", { fontSize: "10px", fontWeight: "700", color: C.text, pointerEvents: "none" }), "Drag & drop images or a folder");
      const dzSub = tx(mk("div", { fontSize: "9px", color: C.muted, marginTop: "3px", pointerEvents: "none" }), "or click to browse files");
      const dzClear = mk("button", {
        position: "absolute", top: "4px", right: "6px", background: "none",
        border: "none", cursor: "pointer", color: C.muted, fontSize: "12px",
        outline: "none", display: "none", padding: "2px",
      }, { title: "Clear dropped images" });
      tx(dzClear, "✕");
      dzClear.onmouseenter = () => dzClear.style.color = C.err;
      dzClear.onmouseleave = () => dzClear.style.color = C.muted;
      dzClear.onclick = (e) => { e.stopPropagation(); S._upDrop = null; syncUpSource(); };
      dz.append(dzIcon, dzMain, dzSub, dzClear, upFileInput);
      dz.onmouseenter = () => { if (!dz._drag) dz.style.borderColor = C.text; };
      dz.onmouseleave = () => { if (!dz._drag) dz.style.borderColor = C.borderH; };
      dz.onclick = (e) => { e.stopPropagation(); upFileInput.click(); };
      upFileInput.addEventListener("change", () => {
        setDropFiles([...upFileInput.files]);
        upFileInput.value = "";
      });
      const dzDragOn = (on) => {
        dz._drag = on;
        dz.style.borderColor = on ? LIME : C.borderH;
        dz.style.background = on ? "rgba(240,255,65,.05)" : "";
      };
      for (const ev of ["dragenter", "dragover"]) {
        dz.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dzDragOn(true); });
      }
      dz.addEventListener("dragleave", (e) => { e.stopPropagation(); dzDragOn(false); });
      dz.addEventListener("drop", async (e) => {
        e.preventDefault(); e.stopPropagation();   // keep ComfyUI's workflow-load drop handler out
        dzDragOn(false);
        try { setDropFiles(await filesFromDrop(e.dataTransfer)); }
        catch (err) { setStatus(`Drop failed: ${err.message}`, C.err); }
      });
      noDrag(dz);
      // Resolve a drop into File objects: plain files pass through, a dropped
      // folder is read one level deep (same top-level-only rule as list_folder).
      async function filesFromDrop(dt) {
        const entries = [...(dt.items || [])].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
        if (!entries.length) return [...(dt.files || [])].filter(f => IMG_RE.test(f.name));
        const entFile = (ent) => new Promise(res => ent.file(res, () => res(null)));
        const out = [];
        for (const ent of entries) {
          if (ent.isFile) {
            const f = await entFile(ent);
            if (f && IMG_RE.test(f.name) && !f.name.startsWith(".")) out.push(f);
          } else if (ent.isDirectory) {
            const reader = ent.createReader();
            let batch;
            do {   // readEntries returns ≤100 per call — drain it
              batch = await new Promise(res => reader.readEntries(res, () => res([])));
              for (const e2 of batch) {
                if (!e2.isFile) continue;
                const f = await entFile(e2);
                if (f && IMG_RE.test(f.name) && !f.name.startsWith(".")) out.push(f);
              }
            } while (batch.length);
          }
        }
        return out;
      }
      function setDropFiles(files) {
        const seen = new Set();
        const list = (files || []).filter(f => !seen.has(f.name) && seen.add(f.name));
        if (!list.length) { setStatus("No usable images (png/jpg/webp).", C.err); return; }
        S._upDrop = list;
        S.up.folder = null;     // drops replace the folder source
        S._upFiles = undefined;
        persist();
        syncUpSource();
      }
      upBox.appendChild(dz);

      const upPickChip = LimeChip("Choose Folder…", () => doPickFolder());
      upPickChip.style.alignSelf = "flex-start";
      upPickChip.title = "Native folder picker — results also copy back into <folder>/upscaled/";
      upBox.appendChild(upPickChip);
      const upPathRow = mk("div", { display: "flex", alignItems: "center", gap: "4px", minWidth: "0" });
      const upPathTxt = mk("div", {
        fontSize: "10px", color: C.muted, whiteSpace: "nowrap", flex: "1", minWidth: "0",
        overflow: "hidden", textOverflow: "ellipsis", direction: "rtl", textAlign: "left",
      });
      const upPathClear = mk("button", {
        background: "none", border: "none", cursor: "pointer", color: C.muted,
        fontSize: "11px", outline: "none", flexShrink: "0", padding: "0 2px",
      }, { title: "Clear folder" });
      tx(upPathClear, "✕");
      upPathClear.onmouseenter = () => upPathClear.style.color = C.err;
      upPathClear.onmouseleave = () => upPathClear.style.color = C.muted;
      upPathClear.onclick = (e) => {
        e.stopPropagation();
        S.up.folder = null;
        S._upFiles = undefined;
        persist();
        syncUpSource();
      };
      upPathRow.append(upPathTxt, noDrag(upPathClear));
      const upCountTxt = mk("div", { fontSize: "9px", fontWeight: "700", color: "rgba(240,255,65,.55)" });
      upBox.append(upPathRow, upCountTxt);
      // Engine picker. Cloud = fal.ai API (paid, nothing to download); local =
      // ComfyUI's core SeedVR2 nodes on your own GPU (free, weights on disk).
      const upEngCap = cap("Engine"); upEngCap.style.marginTop = "6px"; upEngCap.style.marginBottom = "0";
      upBox.appendChild(upEngCap);
      const upEngRow = mk("div", { display: "flex", gap: "5px" });
      const engPills = [
        { key: "cloud", label: "☁ CLOUD", tip: "SeedVR2 on fal.ai — no download, but a PAID API call per image (needs FAL_KEY)" },
        { key: "local", label: "🖥 LOCAL", tip: "SeedVR2 on this machine's GPU — free, needs the SeedVR2 model + VAE on disk" },
      ].map(({ key, label, tip }) => {
        const p = Pill(label, S.up.engine === key, () => {
          S.up.engine = key; persist(); syncUpEngine();
        });
        p._key = key; p.title = tip;
        upEngRow.appendChild(p);
        return p;
      });
      upBox.appendChild(upEngRow);

      // Cloud: target resolution.
      const upCloudBox = mk("div", { display: "flex", flexDirection: "column", gap: "0" });
      const upFacCap = cap("Upscale To"); upFacCap.style.marginTop = "8px"; upFacCap.style.marginBottom = "5px";
      upCloudBox.appendChild(upFacCap);
      const upFacRow = mk("div", { display: "flex", gap: "5px" });
      const UP_RESOLUTIONS = ["1080p", "1440p", "2160p"];
      const facPills = UP_RESOLUTIONS.map(res => {
        const p = Pill(res, S.up.resolution === res, () => {
          S.up.resolution = res; persist(); syncUpFactor();
        });
        p._res = res;
        upFacRow.appendChild(p);
        return p;
      });
      function syncUpFactor() {
        facPills.forEach(p => setPillActive(p, S.up.resolution === p._res));
        scalePills.forEach(p => setPillActive(p, S.up.local.factor === p._fac));
      }
      upCloudBox.appendChild(upFacRow);
      // Where the key goes — the fal nodes read it from their own pack, so
      // there is nothing to set inside this node.
      const upCloudHint = mk("div", { fontSize: "9px", color: C.muted, marginTop: "6px", lineHeight: "1.55" });
      upCloudHint.innerHTML = "Paid fal.ai API call per image — needs a key. Put "
        + "<b style=\"color:#8a8a8a\">FAL_KEY = your_key</b> in "
        + "<b style=\"color:#8a8a8a\">custom_nodes/fal-api/config.ini</b>, or set a "
        + "<b style=\"color:#8a8a8a\">FAL_KEY</b> environment variable (better on a cloud box — "
        + "it stays out of the image). Get one at fal.ai/dashboard/keys. "
        + "Restart ComfyUI after adding it.";
      upCloudBox.appendChild(upCloudHint);
      upBox.appendChild(upCloudBox);

      // Local: scale factor drives ResizeImageMaskNode, SeedVR2 restores the
      // detail. Model/VAE are the SeedVR2 pair, NOT the Krea 2 ones.
      const upLocalBox = mk("div", { display: "none", flexDirection: "column", gap: "0" });
      const upScaleCap = cap("Scale"); upScaleCap.style.marginTop = "8px"; upScaleCap.style.marginBottom = "5px";
      upLocalBox.appendChild(upScaleCap);
      const upScaleRow = mk("div", { display: "flex", gap: "5px" });
      const UP_FACTORS = [2, 4, 6, 8];
      const scalePills = UP_FACTORS.map(f => {
        const p = Pill(`${f}×`, S.up.local.factor === f, () => {
          S.up.local.factor = f; persist(); syncUpFactor();
        });
        p._fac = f;
        upScaleRow.appendChild(p);
        return p;
      });
      upLocalBox.appendChild(upScaleRow);
      const upRow = (label, ctrl) => {
        const r = mk("div", { display: "grid", gridTemplateColumns: "62px 1fr", gap: "8px", alignItems: "center", marginTop: "7px" });
        const l = cap(label); l.style.marginBottom = "0";
        r.append(l, ctrl);
        return r;
      };
      // SeedVR2 weights live in diffusion_models / vae like any other model, so
      // the pickers reuse the same lists Settings uses.
      const upModelDD = DD(() => S._models.diffusion_models, S.up.local.model || null,
        v => { S.up.local.model = v; persist(); });
      const upVaeDD = DD(() => S._models.vaes, S.up.local.vae || null,
        v => { S.up.local.vae = v; persist(); });
      const upTileDD = DD(() => [512, 256, 128], S.up.local.tile,
        v => { S.up.local.tile = +v; persist(); }, v => String(v));
      upLocalBox.append(upRow("Model", upModelDD), upRow("VAE", upVaeDD), upRow("VAE tile", upTileDD));
      const upTileHint = tx(mk("div", { fontSize: "9px", color: C.muted, marginTop: "5px", lineHeight: "1.5" }),
        "Smaller tiles use less VRAM and run slower. The result is the source × scale, so 4× on a large image gets heavy fast.");
      upLocalBox.appendChild(upTileHint);
      upBox.appendChild(upLocalBox);

      // First sight of the model lists: pick the obvious SeedVR2 files so the
      // local engine works without a trip to the dropdowns.
      function upAutoPickModels() {
        const has = (list, name) => (list || []).includes(name);
        const find = (list, ...needles) =>
          (list || []).find(f => needles.every(n => f.toLowerCase().includes(n))) || "";
        const dm = S._models?.diffusion_models, vs = S._models?.vaes;
        if (!dm?.length) return;
        if (!S.up.local.model || !has(dm, S.up.local.model)) S.up.local.model = find(dm, "seedvr");
        if (!S.up.local.vae || !has(vs, S.up.local.vae)) S.up.local.vae = find(vs, "ema_vae") || find(vs, "seedvr");
        upModelDD._setValue?.(S.up.local.model || null);
        upVaeDD._setValue?.(S.up.local.vae || null);
      }
      function syncUpEngine() {
        const local = S.up.engine === "local";
        engPills.forEach(p => setPillActive(p, S.up.engine === p._key));
        upCloudBox.style.display = local ? "none" : "flex";
        upLocalBox.style.display = local ? "flex" : "none";
        if (local) upAutoPickModels();
        // Advanced rows and the seed row are engine-dependent. syncAdv is a
        // const defined further down, so the initial call has to come after it
        // (see below) — from a click handler it is always live.
        syncAdv();
      }
      const syncUpSource = () => {
        const drop = S._upDrop;
        if (drop?.length) {
          tx(dzMain, `${drop.length} image${drop.length > 1 ? "s" : ""} ready`);
          dzMain.style.color = LIME;
          tx(dzSub, "drop or click to pick different files");
          dzClear.style.display = "";
        } else {
          tx(dzMain, "Drag & drop images or a folder");
          dzMain.style.color = C.text;
          tx(dzSub, "or click to browse files");
          dzClear.style.display = "none";
        }
        tx(upPathTxt, S.up.folder || "");
        upPathRow.style.display = S.up.folder ? "flex" : "none";
        upPathTxt.title = S.up.folder || "";
        const f = S._upFiles;
        tx(upCountTxt, !S.up.folder ? ""
          : f === null ? "Choose the folder again (server restarted)"
          : f === undefined ? "…"
          : `${f.length} image${f.length === 1 ? "" : "s"}`);
        upCountTxt.style.display = S.up.folder ? "" : "none";
        upCountTxt.style.color = f === null ? C.warn : "rgba(240,255,65,.55)";
      };
      async function refreshUpFolder() {
        if (!S.up.folder) { syncUpSource(); return; }
        S._upFiles = undefined; syncUpSource();
        try {
          const d = await api.fetchApi(`/krea2_onenode/list_folder?path=${encodeURIComponent(S.up.folder)}`).then(r => r.json());
          S._upFiles = d.ok ? d.files : null;
          if (!d.ok && !d.unauthorized) setStatus(`Folder error: ${d.error}`, C.err);
        } catch (e) { S._upFiles = null; }
        syncUpSource();
      }
      async function doPickFolder() {
        try {
          const d = await api.fetchApi("/krea2_onenode/pick_folder").then(r => r.json());
          if (d.cancelled) return;
          if (!d.ok) { setStatus(`Picker error: ${d.error}`, C.err); return; }
          S.up.folder = d.path;
          S._upDrop = null;     // the folder replaces any dropped files
          persist();
          await refreshUpFolder();
        } catch (e) { setStatus(`Picker failed: ${e.message}`, C.err); }
      }
      left.appendChild(upBox);
      if (S.up.folder) refreshUpFolder(); else syncUpSource();

      // ── EDIT tab: source/person wells, mode pills, output size ─────────────
      // Sources are runtime-only (S._editSrc / S._editRef): File objects and
      // /view refs don't survive persistence. kind "file" = local pick/drop
      // (uploaded at submit), kind "view" = a result sent via "Use as…"
      // (fed to LoadImage as an annotated name, no upload).
      const editBox = mk("div", { display: "none", flexDirection: "column", gap: "8px" });

      // Image well (drop / click). getVal/setVal close over the slot. With
      // onExtra set the well takes MULTIPLE files: the first becomes the slot's
      // image, the rest are handed over as a batch queue.
      function imageWell(capTxt, getVal, setVal, emptyMain, onExtra) {
        const wrap = mk("div", { display: "flex", flexDirection: "column", gap: "4px" });
        const wcap = cap(capTxt); wcap.style.marginBottom = "0";
        wrap.appendChild(wcap);
        const fileInput = mk("input", { display: "none" },
          { type: "file", accept: ".png,.jpg,.jpeg,.webp", multiple: !!onExtra });
        const well = mk("div", {
          border: `1.5px dashed ${C.borderH}`, borderRadius: "10px",
          padding: "10px", textAlign: "center", cursor: "pointer", position: "relative",
          boxSizing: "border-box", userSelect: "none", minHeight: "52px", overflow: "hidden",
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          transition: "border-color .15s, background .15s",
        });
        const thumb = mk("img", {
          maxWidth: "100%", maxHeight: "110px", borderRadius: "6px",
          display: "none", pointerEvents: "none",
        }, { draggable: false });
        const mainL = tx(mk("div", { fontSize: "10px", fontWeight: "700", color: C.text, pointerEvents: "none" }), emptyMain);
        const subL = tx(mk("div", { fontSize: "9px", color: C.muted, marginTop: "3px", pointerEvents: "none" }),
          onExtra ? "drop images or click to browse — one job each" : "drop an image or click to browse");
        const nameL = mk("div", {
          fontSize: "9px", color: "rgba(240,255,65,.7)", marginTop: "4px", pointerEvents: "none",
          maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        });
        const clr = mk("button", {
          position: "absolute", top: "4px", right: "6px", background: "rgba(8,8,8,.6)",
          border: "none", cursor: "pointer", color: C.muted, fontSize: "12px",
          outline: "none", display: "none", padding: "2px 4px", borderRadius: "4px", zIndex: "2",
        }, { title: "Clear image" });
        tx(clr, "✕");
        clr.onmouseenter = () => clr.style.color = C.err;
        clr.onmouseleave = () => clr.style.color = C.muted;
        clr.onclick = (e) => { e.stopPropagation(); setVal(null); syncEditUI(); };
        well.append(thumb, mainL, subL, nameL, clr, fileInput);
        // Read one File into a slot value (dimensions come from the decoded
        // image, which is also what the output-size maths needs).
        const readFile = (f) => new Promise((res) => {
          if (!f || !IMG_RE.test(f.name)) { res(null); return; }
          const url = URL.createObjectURL(f);
          const im = new Image();
          im.onload = () => res({ kind: "file", file: f, name: f.name, w: im.naturalWidth, h: im.naturalHeight, url });
          im.onerror = () => { URL.revokeObjectURL(url); res(null); };
          im.src = url;
        });
        const setFromFiles = async (files) => {
          const list = [...(files || [])].filter(f => IMG_RE.test(f.name));
          if (!list.length) { setStatus("PNG / JPG / WebP only.", C.err); return; }
          const vals = (await Promise.all(list.map(readFile))).filter(Boolean);
          if (!vals.length) { setStatus("Couldn't read that image.", C.err); return; }
          setVal(vals[0]);
          if (onExtra) onExtra(vals.slice(1));
          syncEditUI();
        };
        well.onclick = () => fileInput.click();
        fileInput.onchange = () => { setFromFiles(fileInput.files); fileInput.value = ""; };
        well.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); well.style.borderColor = LIME; well.style.background = "rgba(240,255,65,.05)"; });
        well.addEventListener("dragleave", () => { well.style.borderColor = C.borderH; well.style.background = "transparent"; });
        well.addEventListener("drop", (e) => {
          e.preventDefault(); e.stopPropagation();
          well.style.borderColor = C.borderH; well.style.background = "transparent";
          setFromFiles(e.dataTransfer?.files);
        });
        wrap._sync = () => {
          const v = getVal();
          const has = !!v;
          thumb.style.display = has ? "" : "none";
          if (has) thumb.src = v.url || viewUrl(v.img);
          mainL.style.display = has ? "none" : "";
          subL.style.display = has ? "none" : "";
          clr.style.display = has ? "" : "none";
          tx(nameL, has ? `${v.name || v.img?.filename || ""} · ${v.w || "?"}×${v.h || "?"}` : "");
          nameL.style.display = has ? "" : "none";
          well.style.borderStyle = has ? "solid" : "dashed";
        };
        wrap.appendChild(well);
        return wrap;
      }

      // Changing the source invalidates any painted mask (it's aligned to it).
      function setEditSource(v) {
        const old = S._editSrc;
        if (old?.url) URL.revokeObjectURL(old.url);
        S._editSrc = v;
        S._editMask = null;
        // Any new primary drops the extra queue — those belonged to the drop
        // being replaced. A multi-file drop re-fills it right after this call.
        setEditExtra(null);
      }
      function setEditRef(v) {
        const old = S._editRef;
        if (old?.url) URL.revokeObjectURL(old.url);
        S._editRef = v;
      }
      // Extra sources (runtime only): dropping N images edits all of them with
      // the same prompt and settings, one job each. The first is the primary
      // source — it drives the preview thumb, the output-size maths and the
      // mask editor; mask mode ignores the rest (a painted mask only lines up
      // with the image it was drawn on).
      const setEditExtra = (list) => {
        (S._editExtra || []).forEach(v => { if (v.url) URL.revokeObjectURL(v.url); });
        S._editExtra = list && list.length ? list : null;
      };
      const srcWell = imageWell("Source", () => S._editSrc, setEditSource,
        "Drop image(s) to edit", setEditExtra);
      editBox.appendChild(srcWell);

      const editQueueRow = mk("div", {
        display: "none", alignItems: "center", gap: "6px",
        fontSize: "9px", color: C.muted, marginTop: "-2px",
      });
      const editQueueTxt = mk("div", { flex: "1", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
      const editQueueClr = mk("button", {
        background: "transparent", border: "none", cursor: "pointer", color: C.muted,
        fontSize: "11px", outline: "none", padding: "0 2px", flexShrink: "0",
      }, { title: "Drop the extra images" });
      tx(editQueueClr, "✕");
      editQueueClr.onmouseenter = () => editQueueClr.style.color = C.err;
      editQueueClr.onmouseleave = () => editQueueClr.style.color = C.muted;
      editQueueClr.onclick = (e) => { e.stopPropagation(); setEditExtra(null); syncEditUI(); };
      editQueueRow.append(editQueueTxt, noDrag(editQueueClr));
      editBox.appendChild(editQueueRow);

      // Mode pills — mutually exclusive; click the active one to turn it off.
      const editModeRow = mk("div", { display: "flex", gap: "5px" });
      const mkModePill = (label, key, title) => {
        const p = Pill(label, S.edit.mode === key, () => {
          S.edit.mode = S.edit.mode === key ? "none" : key;
          persist(); syncEditUI(); syncAdv();
        });
        p.title = title;
        return p;
      };
      const maskPill = mkModePill("⬚ MASK", "mask", "Paint the editable region — everything else stays untouched");
      const refPill = mkModePill("👤 REFERENCE", "ref", "Two-image edit: source = scene, person below = reference");
      editModeRow.append(maskPill, refPill);
      editBox.appendChild(editModeRow);

      // Mask mode row: painter entry + status.
      const editMaskRow = mk("div", { display: "none", alignItems: "center", gap: "6px" });
      const paintChip = LimeChip("Paint mask…", () => openMaskEditor());
      const editMaskStat = mk("div", {
        fontSize: "9px", fontWeight: "700", color: C.muted, flex: "1", minWidth: "0",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      });
      const maskClr = mk("button", {
        background: "none", border: "none", cursor: "pointer", color: C.muted,
        fontSize: "11px", outline: "none", padding: "2px", display: "none",
      }, { title: "Clear painted mask" });
      tx(maskClr, "✕");
      maskClr.onclick = (e) => { e.stopPropagation(); S._editMask = null; syncEditUI(); };
      editMaskRow.append(paintChip, editMaskStat, maskClr);
      editBox.appendChild(editMaskRow);

      // Reference mode: the person image (always image 2 — scene is image 1,
      // the order rule from the identity workflow).
      const refWell = imageWell("Person (reference)", () => S._editRef, setEditRef, "Drop the person to insert");
      const refHint = tx(mk("div", { fontSize: "9px", color: C.muted, display: "none" }),
        "source image = scene · this image = person");
      editBox.append(refWell, refHint);

      // Output size: auto — source aspect × MP target, /16 rounding.
      const editOutRow = mk("div", { display: "flex", alignItems: "center", gap: "6px" });
      const editOutCap = cap("Output"); editOutCap.style.marginBottom = "0";
      const mpDD = DD(() => [1, 1.5, 2.25], S.edit.mp,
        v => { S.edit.mp = v; persist(); syncEditUI(); },
        v => `${v} MP${v === 1 ? " (recommended)" : ""}`);
      const mpDDWrap = mk("div", { flex: "1", minWidth: "0" });
      mpDDWrap.appendChild(mpDD);
      editOutRow.append(editOutCap, mpDDWrap);
      const editDimsTxt = mk("div", { fontSize: "9px", fontWeight: "700", color: "rgba(240,255,65,.55)" });
      editBox.append(editOutRow, editDimsTxt);

      // Output size for one source: its aspect at the MP target, rounded to
      // /16. Each queued image gets its own dims — they need not share aspect.
      function editDimsFor(s) {
        if (!s?.w || !s?.h) return null;
        const scale = Math.sqrt((S.edit.mp * 1e6) / (s.w * s.h));
        const r16 = (v) => Math.max(64, Math.round((v * scale) / 16) * 16);
        return { w: r16(s.w), h: r16(s.h) };
      }
      function editDims() { return editDimsFor(S._editSrc); }
      function syncEditUI() {
        srcWell._sync();
        refWell._sync();
        setPillActive(maskPill, S.edit.mode === "mask");
        setPillActive(refPill, S.edit.mode === "ref");
        editMaskRow.style.display = S.edit.mode === "mask" ? "flex" : "none";
        refWell.style.display = S.edit.mode === "ref" ? "flex" : "none";
        refHint.style.display = S.edit.mode === "ref" ? "" : "none";
        tx(editMaskStat, S._editMask ? "mask painted" : "no mask yet");
        editMaskStat.style.color = S._editMask ? "rgba(240,255,65,.7)" : C.muted;
        maskClr.style.display = S._editMask ? "" : "none";
        const d = editDims();
        tx(editDimsTxt, d ? `output ${d.w}×${d.h}` : "output — pick a source image");
        // Extra sources: one job each, unless Mask mode is on (the mask is
        // drawn against the first image, so the rest can't use it).
        const extra = S._editExtra || [];
        const maskMode = S.edit.mode === "mask";
        editQueueRow.style.display = extra.length ? "flex" : "none";
        if (extra.length) {
          tx(editQueueTxt, maskMode
            ? `+${extra.length} more ignored — Mask edits the first image only`
            : `+${extra.length} more queued — ${extra.length + 1} images, one job each`);
          editQueueTxt.style.color = maskMode ? C.warn : "rgba(240,255,65,.7)";
        }
        syncGenEnabled();
      }
      // NOTE: no syncEditUI() here — genBtn doesn't exist yet (TDZ) and the
      // build-ending syncTab() covers the initial sync.
      left.appendChild(editBox);

      // SIZE — named preset dropdown + orientation toggle; W/H boxes only for
      // Custom. Presets store landscape base dims; "port" swaps them.
      const sizeCap = cap("Size");
      left.appendChild(sizeCap);
      const dims = () => {
        if (S.presetIdx === CUSTOM) return { w: S.customW, h: S.customH };
        const p = PRESETS[S.presetIdx];
        return (!p.square && S.orient === "port") ? { w: p.h, h: p.w } : { w: p.w, h: p.h };
      };
      const sizeRow = mk("div", { display: "flex", alignItems: "center", gap: "6px" });
      const sizeItems = () => [...PRESETS.map((_, i) => i), CUSTOM];
      const sizeLbl = (i) => i === CUSTOM ? "Custom…" : PRESETS[i].label;
      const presetDD = DD(sizeItems, S.presetIdx, (i) => {
        S.presetIdx = i;
        if (i !== CUSTOM) { const d = dims(); S.customW = d.w; S.customH = d.h; }
        persist(); syncSize();
      }, sizeLbl);
      const ddWrap = mk("div", { flex: "1", minWidth: "0" });
      ddWrap.appendChild(presetDD);
      const orientBtn = mk("button", {
        background: C.bg2, border: `1px solid ${C.border}`, borderRadius: "6px",
        width: "28px", height: "28px", cursor: "pointer", color: C.muted, fontSize: "12px",
        outline: "none", flexShrink: "0", transition: "color .15s,border-color .15s",
      }, { title: "Landscape / portrait" });
      orientBtn.onmouseenter = () => { if (!orientBtn.disabled) { orientBtn.style.color = C.text; orientBtn.style.borderColor = C.borderH; } };
      orientBtn.onmouseleave = () => { orientBtn.style.color = C.muted; orientBtn.style.borderColor = C.border; };
      orientBtn.onclick = (e) => {
        e.stopPropagation();
        if (S.presetIdx !== CUSTOM && PRESETS[S.presetIdx].square) return;
        if (S.presetIdx === CUSTOM) {
          const t = S.customW; S.customW = S.customH; S.customH = t;
          S.orient = S.customW >= S.customH ? "land" : "port";
        } else {
          S.orient = S.orient === "land" ? "port" : "land";
        }
        persist(); syncSize();
      };
      sizeRow.append(ddWrap, noDrag(orientBtn));
      left.appendChild(sizeRow);

      const whRow = mk("div", { display: "none", alignItems: "center", gap: "6px", marginTop: "8px" });
      const wIn = NI(dims().w, 64, 4096, 16, (v) => {
        S.customW = Math.max(64, Math.round((v || 64) / 16) * 16);
        persist(); syncSize();
      }, "72px");
      const hIn = NI(dims().h, 64, 4096, 16, (v) => {
        S.customH = Math.max(64, Math.round((v || 64) / 16) * 16);
        persist(); syncSize();
      }, "72px");
      const xTxt = tx(mk("span", { color: C.muted, fontSize: "10px", flexShrink: "0" }), "×");
      whRow.append(wIn, xTxt, hIn);
      left.appendChild(whRow);

      const finalTxt = mk("div", {
        fontSize: "9px", color: "rgba(240,255,65,.55)", fontWeight: "700",
        whiteSpace: "nowrap", marginTop: "6px",
      });
      left.appendChild(finalTxt);

      function syncSize() {
        const d = dims();
        wIn.value = d.w; hIn.value = d.h;
        whRow.style.display = S.presetIdx === CUSTOM && S.tab !== "upscale" ? "flex" : "none";
        const sq = S.presetIdx !== CUSTOM && PRESETS[S.presetIdx].square;
        orientBtn.disabled = sq;
        orientBtn.style.opacity = sq ? ".35" : "1";
        orientBtn.style.cursor = sq ? "default" : "pointer";
        tx(orientBtn, d.w >= d.h ? "▭" : "▯");
        // Pass 2 refines at the same resolution — there is no latent upscale.
        tx(finalTxt, `${d.w}×${d.h}`);
      }

      // BATCH

      // ── POST-PROCESSING controls (rendered inside the HQ advanced section).
      // Off deletes the node from the submitted graph (buildPrompt rewires
      // decode → [grain] → [sharpen] → save).
      const qGrain = NI(S.q.grain, 0, 1, 0.01, v => { S.q.grain = isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.09; persist(); });
      const qSharp = NI(S.q.sharpen, 1, 12, 1, v => { S.q.sharpen = Math.min(12, Math.max(1, Math.round(v || 1))); persist(); });
      const qGrainTog = Toggle(S.q.grainOn !== false, v => { S.q.grainOn = v; persist(); syncPostUI(); });
      const qSharpTog = Toggle(S.q.sharpenOn !== false, v => { S.q.sharpenOn = v; persist(); syncPostUI(); });
      function syncPostUI() {
        qGrain.disabled = S.q.grainOn === false;
        qGrain.style.opacity = S.q.grainOn === false ? ".4" : "1";
        qSharp.disabled = S.q.sharpenOn === false;
        qSharp.style.opacity = S.q.sharpenOn === false ? ".4" : "1";
      }
      syncPostUI();

      // ── LORAS (inline list in the left column — replaces the old modal) ────
      const loraBox = mk("div", { display: "flex", flexDirection: "column", gap: "8px", marginTop: "12px" });
      const loraCap = cap("LoRAs"); loraCap.style.marginBottom = "0";
      loraBox.appendChild(loraCap);
      const loraRows = mk("div", { display: "flex", flexDirection: "column", gap: "8px" });
      loraBox.appendChild(loraRows);
      const loraAddRow = LimeChip("Add LoRA", () => {
        S.loras.push({ on: true, name: "", strength: 1.0 });
        persist(); renderLoraRows();
      });
      loraAddRow.style.alignSelf = "flex-start";
      loraBox.appendChild(loraAddRow);
      left.appendChild(loraBox);

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

      // grid row: label+control pairs locked on one line; controls shrink, never
      // wrap. Labels may be strings or prebuilt elements (capI label + ⓘ).
      function advGrid(...pairs) {
        const cols = pairs.map(([, , w]) => `auto ${w || "1fr"}`).join(" ");
        const r = mk("div", { display: "grid", gridTemplateColumns: cols, gap: "7px", alignItems: "center" });
        for (const [labelTxt, control] of pairs) {
          r.appendChild(typeof labelTxt === "string" ? advCap(labelTxt) : labelTxt);
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

      // ⓘ info tips — one shared fixed-position panel on document.body (escapes
      // the canvas transform; scaled to match the zoom like the DD panels).
      const tipEl = mk("div", {
        position: "fixed", zIndex: "1000002", display: "none",
        background: C.bg1, border: `1px solid ${C.borderH}`, borderRadius: "8px",
        boxShadow: "0 12px 32px rgba(0,0,0,.85)", padding: "9px 11px",
        fontSize: "10px", lineHeight: "1.55", color: C.text, whiteSpace: "pre-line",
        maxWidth: "300px", boxSizing: "border-box", pointerEvents: "none",
        fontFamily: "'Inter','Segoe UI',system-ui,sans-serif", transformOrigin: "top left",
      });
      document.body.appendChild(tipEl);
      let tipFor = null;
      function showTip(anchor, text) {
        tipFor = anchor;
        tx(tipEl, text);
        const s = uiScale();
        tipEl.style.transform = `scale(${s})`;
        tipEl.style.display = "block";
        const r = anchor.getBoundingClientRect();
        const w = tipEl.offsetWidth * s, h = tipEl.offsetHeight * s;
        tipEl.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px";
        tipEl.style.top = (r.bottom + 6 + h <= window.innerHeight - 8
          ? r.bottom + 6 : Math.max(8, r.top - h - 6)) + "px";
      }
      const hideTip = (anchor) => {
        if (!anchor || tipFor === anchor) { tipEl.style.display = "none"; tipFor = null; }
      };
      function InfoIcon(text) {
        const i = mk("span", {
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: "12px", height: "12px", borderRadius: "50%", boxSizing: "border-box",
          border: `1px solid ${C.advBorder}`, color: C.adv, fontSize: "8px",
          fontWeight: "700", cursor: "help", flexShrink: "0", userSelect: "none",
          lineHeight: "1", fontStyle: "italic", fontFamily: "Georgia,serif",
        });
        tx(i, "i");
        i.onmouseenter = () => showTip(i, text);
        i.onmouseleave = () => hideTip(i);
        i.onclick = (e) => { e.stopPropagation(); tipFor === i ? hideTip(i) : showTip(i, text); };
        return noDrag(i);
      }
      // label + ⓘ pair for advGrid rows
      const capI = (label, tip) => {
        const w = mk("span", { display: "inline-flex", alignItems: "center", gap: "4px" });
        w.append(advCap(label), InfoIcon(tip));
        return w;
      };

      // Per-mode sections: T2I (ClownsharK two-pass, same-res refine),
      // Upscale, Edit. The seed row is shared.
      const advSec = () => mk("div", { display: "flex", flexDirection: "column", gap: "8px" });
      const advQ1 = advSec(), advQ2 = advSec();

      // T2I pass 1 — ClownsharK sampler/scheduler option lists come from the
      // live /object_info (huge RES4LYF list); until the fetch lands the DDs
      // offer just the template defaults.
      S._clown = {
        samplers: ["linear/euler", "exponential/res_2s"],
        schedulers: ["simple", "bong_tangent"],
      };
      api.fetchApi("/object_info/ClownsharKSampler_Beta").then(r => r.json()).then(d => {
        const req = d?.ClownsharKSampler_Beta?.input?.required || {};
        const opts = (spec) => !Array.isArray(spec) ? null
          : Array.isArray(spec[0]) ? spec[0]                  // classic combo: [[...options], cfg]
          : spec[1]?.options || null;                          // v3 combo: ["COMBO", {options}]
        S._clown.samplers = opts(req.sampler_name) || S._clown.samplers;
        S._clown.schedulers = opts(req.scheduler) || S._clown.schedulers;
      }).catch(() => {});
      advQ1.appendChild(advDivider("Pass 1 · base"));
      const q1Steps = NI(S.q.p1Steps, 1, 100, 1, v => { S.q.p1Steps = Math.max(1, Math.round(v || 8)); persist(); });
      const q1Cfg = NI(S.q.p1Cfg, 0, 30, 0.1, v => { S.q.p1Cfg = isFinite(v) ? v : 1.0; persist(); });
      advQ1.appendChild(advGrid(["Steps", q1Steps], ["CFG", q1Cfg]));
      const q1Samp = DD(() => S._clown.samplers, S.q.p1Sampler, v => { S.q.p1Sampler = v; persist(); });
      const q1Sched = DD(() => S._clown.schedulers, S.q.p1Sched, v => { S.q.p1Sched = v; persist(); });
      advQ1.appendChild(advGrid(["Sampler", q1Samp], ["Sched", q1Sched]));
      advPanel.append(advQ1);

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
      const seedRowEl = mk("div", { display: "grid", gridTemplateColumns: "auto 1fr auto auto", gap: "7px", alignItems: "center" });
      seedRowEl.appendChild(advCap("Seed"));
      seedIn.style.width = "100%"; seedIn.style.minWidth = "0"; seedIn.style.boxSizing = "border-box";
      seedRowEl.append(seedIn, noDrag(randChip), noDrag(reuseBtn));
      advPanel.appendChild(seedRowEl);
      syncSeedUI();

      // T2I pass 2 (same-res refine; steps = ceil(denoise × 8))
      advQ2.appendChild(advDivider("Pass 2 · refine"));
      const q2Den = NI(S.q.denoise, 0.05, 1, 0.05, v => { S.q.denoise = isFinite(v) ? Math.min(1, Math.max(0.05, v)) : 0.2; persist(); });
      const q2Eta = NI(S.q.eta, 0, 2, 0.05, v => { S.q.eta = isFinite(v) ? v : 0.9; persist(); });
      const q2Cfg = NI(S.q.p2Cfg, 0, 30, 0.1, v => { S.q.p2Cfg = isFinite(v) ? v : 1.0; persist(); });
      advQ2.appendChild(advGrid(["Denoise", q2Den], ["Eta", q2Eta], ["CFG", q2Cfg]));
      const q2Samp = DD(() => S._clown.samplers, S.q.p2Sampler, v => { S.q.p2Sampler = v; persist(); });
      const q2Sched = DD(() => S._clown.schedulers, S.q.p2Sched, v => { S.q.p2Sched = v; persist(); });
      advQ2.appendChild(advGrid(["Sampler", q2Samp], ["Sched", q2Sched]));
      // Post-processing (toggle + value per effect; controls defined earlier).
      advQ2.appendChild(advDivider("Post"));
      const advPostRow = (label, tog, ni) => {
        const r = mk("div", { display: "grid", gridTemplateColumns: "56px auto 1fr", gap: "8px", alignItems: "center" });
        r.appendChild(advCap(label));
        ni.style.width = "100%"; ni.style.minWidth = "0"; ni.style.boxSizing = "border-box";
        r.append(tog, ni);
        return r;
      };
      advQ2.append(advPostRow("Grain", qGrainTog, qGrain), advPostRow("Sharpen", qSharpTog, qSharp));
      // (Krea2T-Enhancer stays at the template default — enabled, strength 1.5 —
      // with no UI control, per user preference.)
      advPanel.append(advQ2);

      // Upscale tab, cloud engine: SeedVR2 noise scale (the seed row stays
      // hidden — the fal template pins seed -1, i.e. fal picks per call).
      const advU = advSec();
      advU.appendChild(advDivider("Upscale · cloud"));
      const upNoise = DragNI(S.up.noise, 0, 1, 0.05, v => { S.up.noise = v; persist(); }, "48px");
      upNoise.title = "SeedVR2 noise scale — 0.1 = default; higher invents more detail";
      advU.appendChild(advGrid(["Noise", upNoise]));
      advPanel.appendChild(advU);

      // Upscale tab, local engine: the KSampler that drives SeedVR2. One step
      // is the model's design point — it restores detail in a single pass.
      const advUL = advSec();
      advUL.appendChild(advDivider("Upscale · local"));
      const ulSteps = NI(S.up.local.steps, 1, 20, 1, v => { S.up.local.steps = Math.max(1, Math.round(v || 1)); persist(); });
      const ulCfg = NI(S.up.local.cfg, 0, 30, 0.1, v => { S.up.local.cfg = isFinite(v) ? v : 1; persist(); });
      advUL.appendChild(advGrid(
        [capI("Steps", "SeedVR2 is a one-step restorer — 1 is the intended value. More steps cost time without adding much."), ulSteps],
        [capI("CFG", "Keep 1. SeedVR2's conditioning comes from the image itself, not a prompt."), ulCfg]));
      const ulSamp = DD(() => SAMPLERS, S.up.local.sampler, v => { S.up.local.sampler = v; persist(); });
      const ulSched = DD(() => SCHEDULERS, S.up.local.scheduler, v => { S.up.local.scheduler = v; persist(); });
      advUL.appendChild(advGrid(["Sampler", ulSamp], ["Sched", ulSched]));
      advPanel.appendChild(advUL);

      // Edit tab section — Krea2 Edit patch + KSampler + mask processing.
      // Every row carries an ⓘ tip with the source workflows' guidance.
      const advE = advSec();
      advE.appendChild(advDivider("Edit model"));
      const eBoost = DragNI(S.edit.refBoost, 0, 20, 0.5, v => { S.edit.refBoost = v; persist(); });
      const eBoostA = DragNI(S.edit.refBoostA, 0, 10, 0.5, v => { S.edit.refBoostA = v; persist(); });
      advE.appendChild(advGrid(
        [capI("Ref boost", "THE FIDELITY DIAL (ref_boost) — how hard the model looks at your reference.\n\n1.0 = classic v1.1 behavior\n4.0 = recommended (pre-set): much stronger face + body likeness, more reliable edits\n>10 = over-copy: removals/replacements start failing\n<1 = suppress the reference (creative freedom)\n\nApplies to the person (image 2) in Reference mode, else to your image."), eBoost],
        [capI("Boost A", "The scene dial (image 1) in Reference (two-image) mode — leave at 1.0 unless you are exploring. No effect in single-image edits."), eBoostA]));
      const eFit = DD(() => ["fit", "crop (legacy)"], S.edit.fitMode, v => { S.edit.fitMode = v; persist(); });
      const eGround = NI(S.edit.groundingPx, 0, 4096, 64,
        v => { S.edit.groundingPx = Math.max(0, Math.min(4096, Math.round((isFinite(v) ? v : 768) / 64) * 64)); persist(); });
      advE.appendChild(advGrid(
        [capI("Fit", "How inputs fit a different output aspect ratio.\n\nfit = resample to the output shape (default, recommended)\ncrop (legacy) = center-crop, only for v1/v1.1 weights."), eFit],
        [capI("Ground", "grounding_px — how large the model 'sees' the input while reading your instruction (longest side, px). 384–768 is the trained range; 0 = native.\n\nGetting doubled/split compositions? LOWER it."), eGround]));
      advE.appendChild(advDivider("Sampler"));
      const eSteps = NI(S.edit.steps, 1, 100, 1, v => { S.edit.steps = Math.max(1, Math.round(v || 10)); persist(); });
      const eCfg = NI(S.edit.cfg, 0, 30, 0.1, v => { S.edit.cfg = isFinite(v) ? v : 1; persist(); });
      advE.appendChild(advGrid(
        [capI("Steps", "Turbo model step dial:\n8 = stronger composition / instruction adherence\n10 = balanced (recommended)\n12 = more face detail"), eSteps],
        [capI("CFG", "Turbo model: keep CFG 1. The (empty) negative prompt only matters at CFG > 1.\n\nUsing krea2_raw instead of turbo: 40 steps, CFG 3–4."), eCfg]));
      const eSamp = DD(() => SAMPLERS, S.edit.sampler, v => { S.edit.sampler = v; persist(); });
      const eSched = DD(() => SCHEDULERS, S.edit.scheduler, v => { S.edit.scheduler = v; persist(); });
      advE.appendChild(advGrid(
        [capI("Sampler", "euler / simple is the Krea 2 turbo default — both source edit workflows sample with it."), eSamp],
        ["Sched", eSched]));
      const eDen = NI(S.edit.denoise, 0.05, 1, 0.05,
        v => { S.edit.denoise = isFinite(v) ? Math.min(1, Math.max(0.05, v)) : 1; persist(); });
      advE.appendChild(advGrid(
        [capI("Denoise", "1 = full re-render of the output canvas (normal for edits — your image steers the model through the reference patch, not the latent)."), eDen]));
      advPanel.appendChild(advE);

      const syncAdv = () => {
        advPanel.style.display = S.advancedUI ? "flex" : "none";
        const up = S.tab === "upscale", ed = S.tab === "edit";
        const upLocal = up && S.up.engine === "local";
        advQ1.style.display = up || ed ? "none" : "flex";
        advQ2.style.display = up || ed ? "none" : "flex";
        advU.style.display = up && !upLocal ? "flex" : "none";
        advUL.style.display = upLocal ? "flex" : "none";
        advE.style.display = ed ? "flex" : "none";
        // The local engine runs a real KSampler, so its seed is meaningful;
        // the fal template pins seed -1 and picks its own.
        seedRowEl.style.display = up && !upLocal ? "none" : "grid";
      };
      syncAdv();
      syncUpEngine();   // needs syncAdv to exist — hence not at upBox build time

      // spacer then Generate pinned to bottom
      left.appendChild(mk("div", { flex: "1", minHeight: "10px" }));

      // Batch time estimate (batch tab only) — sits just above the Generate row.
      const estimateLine = mk("div", {
        display: "none", fontSize: "10px", fontWeight: "700",
        color: "rgba(240,255,65,.55)", marginBottom: "6px", whiteSpace: "nowrap",
        overflow: "hidden", textOverflow: "ellipsis", flexShrink: "0",
      });
      left.appendChild(estimateLine);
      function sceneImageCount() {
        return sceneParse().length;
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
      genBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        S.tab === "scene" ? doRunScene() : S.tab === "upscale" ? doRunUpscaleBatch() : S.tab === "edit" ? doRunEdit() : doGenerate();
      });
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
        if (S._scene || S._batchRun) {
          // Clear pending FIRST so the interrupt can't let the next queued job
          // start before the clear lands. NOTE: {clear:true} empties ALL
          // pending items in ComfyUI's server queue, not just this run's.
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
          S._batchRun = null;
          finishGenerate();
          setStatus("Batch stopped; queue cleared.");
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
      // BATCH — lime "×N ▾" chip next to Generate, like the reference node.
      const batchDD = DD(() => [1, 2, 4, 8], S.batch, (n) => {
        S.batch = n; persist();
        batchTxt.style.color = "#111"; // DD's setTxt paints the value lime; chip needs dark-on-lime
      }, (n) => `×${n}`);
      Object.assign(batchDD.style, { width: "auto", minWidth: "0", flexShrink: "0", marginLeft: "8px" });
      const batchTrig = batchDD.children[0];
      Object.assign(batchTrig.style, {
        background: LIME, border: "2px solid transparent", borderRadius: "8px",
        height: "38px", padding: "0 12px", gap: "2px",
      });
      const batchTxt = batchTrig.children[0];
      Object.assign(batchTxt.style, { color: "#111", fontSize: "13px", fontWeight: "700", flex: "none", overflow: "visible" });
      const batchArr = batchTrig.children[1];
      batchArr.style.color = "#111";
      batchTrig.onmouseenter = () => { batchTrig.style.filter = "brightness(1.08)"; };
      batchTrig.onmouseleave = () => { batchTrig.style.filter = ""; };

      genRow.append(genBtn, batchDD, stopBtn);
      left.appendChild(genRow);

      // ── batch column (BATCH tab): one prompt per line + queue preview ──────
      const sceneCol = mk("div", {
        width: "300px", flexShrink: "0", minHeight: "0",
        display: "none", flexDirection: "column",
      });
      sceneCol.appendChild(cap("Batch prompts — one per line"));

      // Every non-empty line = one prompt = one queued image.
      function sceneParse() {
        return (S.sceneText || "").split("\n").map(t => t.trim()).filter(Boolean);
      }

      const sceneChipRow = mk("div", {
        display: "flex", gap: "6px", alignItems: "center", marginBottom: "6px", flexShrink: "0",
      });
      const sceneFileIn = mk("input", { display: "none" }, { type: "file", accept: ".txt,text/plain" });
      const importSceneText = (text, label) => {
        S.sceneText = String(text).replace(/\r\n?/g, "\n");
        persist();
        sceneTa.value = S.sceneText;
        renderScenePreview(); updateEstimate();
        const n = sceneParse().length;
        setStatus(`Imported ${n} prompt${n === 1 ? "" : "s"}${label ? ` from ${label}` : ""}.`, n ? C.ok : C.warn);
      };
      sceneFileIn.onchange = async () => {
        const f = sceneFileIn.files?.[0];
        sceneFileIn.value = "";
        if (!f) return;
        try { importSceneText(await f.text(), f.name); }
        catch (e) { setStatus(`Couldn't read file: ${e.message}`, C.err); }
      };
      const sceneImportBtn = LimeChip("Import .txt…", () => { if (!S._scene) sceneFileIn.click(); });
      sceneImportBtn.title = "Load a text file — each line becomes one prompt (replaces the list)";
      const sceneClearBtn = mk("button", {
        background: "none", border: `1px solid ${C.border}`, borderRadius: "5px",
        color: C.muted, fontSize: "9px", fontWeight: "700", cursor: "pointer",
        padding: "3px 8px", outline: "none", flexShrink: "0",
      }, { title: "Clear all prompts" });
      tx(sceneClearBtn, "✕ Clear");
      sceneClearBtn.onmouseenter = () => { sceneClearBtn.style.borderColor = C.err; sceneClearBtn.style.color = C.err; };
      sceneClearBtn.onmouseleave = () => { sceneClearBtn.style.borderColor = C.border; sceneClearBtn.style.color = C.muted; };
      sceneClearBtn.onclick = (e) => {
        e.stopPropagation();
        if (S._scene) return;
        S.sceneText = ""; persist();
        sceneTa.value = "";
        renderScenePreview(); updateEstimate();
      };
      noDrag(sceneClearBtn);
      const sceneCount = mk("div", {
        marginLeft: "auto", fontSize: "10px", fontWeight: "700",
        color: "rgba(240,255,65,.55)", whiteSpace: "nowrap",
      });
      sceneChipRow.append(sceneImportBtn, sceneClearBtn, sceneCount);
      sceneCol.append(sceneChipRow, sceneFileIn);

      const sceneTa = mk("textarea", {
        flex: "0 0 38%", minHeight: "70px", width: "100%", resize: "none",
        background: C.bg2, border: `1px solid ${C.border}`, borderRadius: "8px",
        color: C.text, fontSize: "11px", padding: "7px 9px",
        boxSizing: "border-box", outline: "none", lineHeight: "1.5",
        fontFamily: "inherit", transition: "border-color .15s", display: "block",
        overflowY: "auto", whiteSpace: "pre", marginBottom: "8px",
      }, { placeholder: "One prompt per line…\nPaste here, or import / drop a .txt file.", spellcheck: false });
      sceneTa.value = S.sceneText;
      sceneTa.onfocus = () => sceneTa.style.borderColor = LIME;
      sceneTa.onblur = () => sceneTa.style.borderColor = C.border;
      sceneTa.oninput = () => {
        S.sceneText = sceneTa.value; persist();
        renderScenePreview(); updateEstimate();
      };
      sceneTa.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); sceneTa.blur(); } });
      // Drop a .txt straight onto the textarea (same as Import).
      sceneTa.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); sceneTa.style.borderColor = LIME; });
      sceneTa.addEventListener("dragleave", () => { sceneTa.style.borderColor = C.border; });
      sceneTa.addEventListener("drop", async (e) => {
        e.preventDefault(); e.stopPropagation();
        sceneTa.style.borderColor = C.border;
        if (S._scene) return;
        const f = [...(e.dataTransfer?.files || [])].find(f => /\.txt$/i.test(f.name) || f.type === "text/plain");
        if (!f) return;
        try { importSceneText(await f.text(), f.name); }
        catch (err) { setStatus(`Couldn't read file: ${err.message}`, C.err); }
      });
      scrollGuard(sceneTa);
      noDrag(sceneTa);
      sceneCol.appendChild(sceneTa);

      sceneCol.appendChild(cap("Queue preview"));
      const sceneRowsEl = mk("div", {
        display: "flex", flexDirection: "column", gap: "1px",
        overflowY: "auto", overflowX: "hidden", flex: "1", minHeight: "0", paddingRight: "2px",
      });
      scrollGuard(sceneRowsEl);
      sceneCol.appendChild(sceneRowsEl);
      mainRow.appendChild(sceneCol);

      // Per-line status dots, index-aligned with sceneParse(). The textarea is
      // read-only during a run, so indices stay valid for the whole run.
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
      function syncSceneLock() {
        const lock = !!S._scene;
        sceneTa.readOnly = lock;
        sceneTa.style.opacity = lock ? ".6" : "1";
        [sceneImportBtn, sceneClearBtn].forEach(el => {
          el.style.pointerEvents = lock ? "none" : "";
          el.style.opacity = lock ? ".4" : "1";
        });
      }
      function renderScenePreview() {
        const prompts = sceneParse();
        tx(sceneCount, prompts.length ? `${prompts.length} prompt${prompts.length === 1 ? "" : "s"}` : "");
        sceneRowsEl.replaceChildren();
        _sceneDots = [];
        if (!prompts.length) {
          sceneRowsEl.appendChild(tx(mk("div", { color: C.muted, fontSize: "10px", padding: "6px 2px", lineHeight: "1.5" }),
            "No prompts yet — type above, paste, or import a .txt (one prompt per line)."));
          syncSceneLock();
          return;
        }
        prompts.forEach((p, idx) => {
          const r = mk("div", { display: "flex", alignItems: "center", gap: "6px", padding: "2px 2px" });
          const dot = mk("div", {
            fontSize: "9px", fontWeight: "700", width: "18px", flexShrink: "0",
            textAlign: "right", color: C.muted, userSelect: "none",
          });
          dot._idx = idx;
          sceneDotSet(dot, "idle");
          _sceneDots.push(dot);
          const t = mk("div", {
            flex: "1", minWidth: "0", fontSize: "10px", color: C.text,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }, { title: p });
          tx(t, p);
          r.append(dot, t);
          sceneRowsEl.appendChild(r);
        });
        syncSceneLock();
      }

      // Tab switching: one shared skeleton, batch swaps the T2I batch control,
      // prompt bar and Generate label for the prompt-list column + estimate.
      function syncTab() {
        const scene = S.tab === "scene", up = S.tab === "upscale", ed = S.tab === "edit";
        setPillActive(pillT2I, S.tab === "t2i");
        setPillActive(pillScene, scene);
        setPillActive(pillUp, up);
        setPillActive(pillEdit, ed);
        batchDD.style.display = scene || up ? "none" : "";
        sceneCol.style.display = scene ? "flex" : "none";
        promptWrap.style.display = scene || up ? "none" : "";
        estimateLine.style.display = scene ? "" : "none";
        // Upscale / Edit tabs swap the size controls for their own source box.
        upBox.style.display = up ? "flex" : "none";
        editBox.style.display = ed ? "flex" : "none";
        sizeCap.style.display = up || ed ? "none" : "";
        sizeRow.style.display = up || ed ? "none" : "flex";
        finalTxt.style.display = up || ed ? "none" : "";
        loraBox.style.display = up ? "none" : "flex";
        if (up || ed) whRow.style.display = "none";   // else syncSize() below decides
        if (!S._generating) {
          tx(genBtn, scene ? "Run Batch" : up ? "Upscale" : ed ? "Edit" : "Generate");
          genBtn.appendChild(genSweep);
        }
        if (scene) updateEstimate();
        if (ed) syncEditUI();
        syncAdv();
        syncSize();
        syncGenEnabled();
      }
      // Edit needs a source image AND an instruction — grey the button until
      // both exist (other tabs keep their own click-time validation).
      function syncGenEnabled() {
        const off = S.tab === "edit" && (!S._editSrc || !S.prompt.trim());
        genBtn.disabled = off;
        genBtn.style.opacity = off ? ".45" : "1";
        genBtn.style.cursor = off ? "default" : "pointer";
      }
      function setTab(t) {
        if (S.tab === t) return;
        S.tab = t; persist(); syncTab();
      }

      // ---- right: preview ----
      // Right column = preview box on top, thumb strip underneath. The strip
      // used to float over the image and cut off its bottom edge, so it now
      // gets its own row and the preview keeps the space it's given.
      const rightCol = mk("div", {
        flex: "1", minWidth: "0", minHeight: "0",
        display: "flex", flexDirection: "column", gap: "8px",
      });
      mainRow.appendChild(rightCol);

      const right = mk("div", {
        flex: "1", minWidth: "0", minHeight: "0", position: "relative",
        background: "#000", borderRadius: "8px", overflow: "hidden",
        display: "flex", alignItems: "center", justifyContent: "center",
        border: `1px solid ${C.border}`,
      });
      rightCol.appendChild(right);

      const previewImg = mk("img", {
        maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "none",
        cursor: "zoom-in",
      }, { title: "Click to view full size", draggable: false });
      noDrag(previewImg);
      // Full-size lightbox on click; guard the live b_preview blob (only a
      // final /view image can be zoomed / revealed in Finder).
      previewImg.addEventListener("click", (e) => {
        e.stopPropagation();
        if (S.lastImage?.filename && (previewImg.src || "").includes("/view")) openLightbox(S.lastImage);
      });
      previewImg.addEventListener("contextmenu", (e) => {
        if (!S.lastImage?.filename) return;
        e.preventDefault(); e.stopPropagation();
        openCtxMenu(e, S.lastImage);
      });
      previewImg.onerror = () => {
        // Restored image no longer on disk (e.g. temp cleared by a ComfyUI
        // restart) — fall back to the empty state instead of a broken icon.
        if ((previewImg.src || "").includes("/view")) {
          previewImg.style.display = "none";
          previewEmpty.style.display = "";
          saveChip.style.display = "none";
          clearChip.style.display = "none";
          upChip.style.display = "none";
          useAsChip.style.display = "none";
          cmpChip.style.display = "none";
          cmpWrap.style.display = "none";
        }
      };
      right.appendChild(previewImg);
      const previewEmpty = mk("div", { color: C.muted, fontSize: "11px", textAlign: "center", lineHeight: "1.7" });
      previewEmpty.innerHTML = "No image yet<br><span style='font-size:9px'>Generate to see the result here</span>";
      right.appendChild(previewEmpty);

      // ── before/after compare view for upscaled results ─────────────────────
      // Two identically-fitted images; the AFTER is clipped at the divider so
      // left = before, right = after. Drag the divider handle to sweep.
      const cmpWrap = mk("div", { position: "absolute", inset: "0", display: "none", background: "#000", zIndex: "4" });
      // Both images occupy the IDENTICAL full-panel rect and let object-fit
      // scale the pixels (max-* would refuse to scale the smaller BEFORE up,
      // giving the two different geometries and a drifting divider).
      const cmpImgCss = {
        position: "absolute", inset: "0", width: "100%", height: "100%",
        objectFit: "contain",
      };
      const cmpBefore = mk("img", { ...cmpImgCss }, { draggable: false });
      const cmpAfter = mk("img", { ...cmpImgCss }, { draggable: false });
      let cmpX = 50;
      const cmpDiv = mk("div", {
        position: "absolute", top: "0", bottom: "0", left: "50%", width: "18px",
        marginLeft: "-9px", cursor: "ew-resize", zIndex: "3", touchAction: "none",
      });
      const cmpLine = mk("div", {
        position: "absolute", top: "0", bottom: "0", left: "50%", width: "1.5px",
        marginLeft: "-0.75px", background: LIME, boxShadow: "0 0 8px rgba(240,255,65,.6)",
        pointerEvents: "none",
      });
      const cmpGrip = mk("div", {
        position: "absolute", top: "50%", left: "50%", width: "22px", height: "22px",
        transform: "translate(-50%,-50%)", borderRadius: "50%", background: "rgba(10,10,10,.85)",
        border: `1.5px solid ${LIME}`, color: LIME, fontSize: "9px", fontWeight: "700",
        display: "flex", alignItems: "center", justifyContent: "center",
        pointerEvents: "none", boxSizing: "border-box", letterSpacing: "-1px",
      });
      tx(cmpGrip, "◂▸");
      cmpDiv.append(cmpLine, cmpGrip);
      const cmpTag = (t, side) => {
        const e = mk("div", {
          position: "absolute", top: "8px", [side]: "8px", zIndex: "2",
          fontSize: "8px", fontWeight: "700", letterSpacing: ".1em", color: "rgba(255,255,255,.75)",
          background: "rgba(0,0,0,.55)", borderRadius: "4px", padding: "2px 6px",
          pointerEvents: "none",
        });
        tx(e, t);
        return e;
      };
      const cmpTagB = cmpTag("BEFORE", "left");
      const cmpTagA = cmpTag("AFTER", "right");
      cmpTagA.style.top = "36px";   // keep clear of the chips row
      const cmpApply = () => {
        cmpAfter.style.clipPath = `inset(0 0 0 ${cmpX}%)`;
        cmpDiv.style.left = cmpX + "%";
      };
      let cmpDrag = null;
      cmpDiv.addEventListener("pointerdown", (e) => {
        e.stopPropagation(); e.preventDefault();
        cmpDrag = e.pointerId;
        try { cmpDiv.setPointerCapture(e.pointerId); } catch (err) {}
      });
      cmpDiv.addEventListener("pointermove", (e) => {
        if (cmpDrag == null) return;
        const r = cmpWrap.getBoundingClientRect();
        cmpX = Math.min(97, Math.max(3, ((e.clientX - r.left) / r.width) * 100));
        cmpApply();
      });
      const cmpDragEnd = () => {
        if (cmpDrag == null) return;
        try { cmpDiv.releasePointerCapture(cmpDrag); } catch (err) {}
        cmpDrag = null;
      };
      cmpDiv.addEventListener("pointerup", cmpDragEnd);
      cmpDiv.addEventListener("pointercancel", cmpDragEnd);
      // Plain clicks on either half act on the AFTER image (lightbox / menu),
      // same as the normal preview.
      for (const im of [cmpBefore, cmpAfter]) {
        im.addEventListener("click", (e) => {
          e.stopPropagation();
          if (S.lastImage?.filename) openLightbox(S.lastImage);
        });
        im.addEventListener("contextmenu", (e) => {
          e.preventDefault(); e.stopPropagation();
          if (S.lastImage?.filename) openCtxMenu(e, S.lastImage);
        });
        im.style.cursor = "zoom-in";
      }
      cmpWrap.append(cmpBefore, cmpAfter, cmpTagB, cmpTagA, cmpDiv);
      noDrag(cmpWrap);
      right.appendChild(cmpWrap);
      function toggleCompare() {
        S._cmpOn = !S._cmpOn;
        syncCompare();
      }
      // Reconcile preview vs compare for the CURRENT image. Chip shows only
      // when a before/after pair exists for it.
      function syncCompare() {
        const pair = S.lastImage?.filename && S._cmp.get(cmpKey(S.lastImage));
        cmpChip.style.display = pair ? "" : "none";
        cmpChip.style.color = pair && S._cmpOn ? LIME : C.text;
        cmpChip.style.borderColor = pair && S._cmpOn ? "rgba(240,255,65,.5)" : C.borderH;
        const on = !!pair && S._cmpOn;
        cmpWrap.style.display = on ? "" : "none";
        previewImg.style.display = on ? "none" : previewImg.src ? "" : "none";
        if (on) {
          cmpBefore.src = viewUrl(pair);
          cmpAfter.src = viewUrl(S.lastImage);
          cmpApply();
        }
      }

      // ── mask painter (EDIT tab, mask mode) ─────────────────────────────────
      // Full-panel overlay: the source image fitted, a display canvas on top
      // rendering the painted region as a red wash. Strokes land on an
      // offscreen mask canvas at the source's NATIVE resolution; Done exports
      // a PNG whose painted pixels are transparent (LoadImage MASK = 1−alpha,
      // the clipspace convention) and keeps the canvas for repainting.
      const mpWrap = mk("div", {
        position: "absolute", inset: "0", display: "none", flexDirection: "column",
        background: "#000", zIndex: "8",
      });
      const mpStage = mk("div", {
        flex: "1", minHeight: "0", position: "relative",
        display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
      });
      const mpCanvas = mk("canvas", { touchAction: "none", cursor: "crosshair" });
      mpStage.appendChild(mpCanvas);
      const mpBar = mk("div", {
        display: "flex", alignItems: "center", gap: "6px", padding: "8px",
        background: "rgba(8,8,8,.9)", borderTop: "1px solid rgba(255,255,255,.08)",
        flexShrink: "0",
      });
      let mpErase = false;
      const mpBrushPill = Pill("✎ BRUSH", true, () => { mpErase = false; mpSyncTools(); });
      const mpErasePill = Pill("◌ ERASE", false, () => { mpErase = true; mpSyncTools(); });
      function mpSyncTools() {
        setPillActive(mpBrushPill, !mpErase);
        setPillActive(mpErasePill, mpErase);
      }
      S._mpBrush = 40;
      const mpSize = DragNI(S._mpBrush, 4, 256, 4, v => { S._mpBrush = v; }, "44px");
      mpSize.title = "Brush size (drag to scrub)";
      const mpClearBtn = TBtn("Clear", () => {
        if (mp.mctx) { mp.mctx.clearRect(0, 0, mp.w, mp.h); mp.painted = false; mpRender(); }
      });
      const mpCancelBtn = TBtn("Cancel", () => closeMaskPainter(false));
      const mpDoneChip = LimeChip("Done", () => closeMaskPainter(true));
      const mpHint = tx(mk("div", { fontSize: "9px", color: C.muted, flex: "1", textAlign: "center" }),
        "paint the area the edit may change");
      mpBar.append(mpBrushPill, mpErasePill,
        tx(mk("span", { fontSize: "9px", fontWeight: "700", color: C.muted }), "SIZE"), mpSize,
        mpClearBtn, mpHint, mpCancelBtn, mpDoneChip);
      mpWrap.append(mpStage, mpBar);
      right.appendChild(mpWrap);

      const mp = { img: null, mctx: null, tctx: null, w: 0, h: 0, open: false, raf: 0, painted: false };
      function mpRender() {
        if (mp.raf) return;
        mp.raf = requestAnimationFrame(() => {
          mp.raf = 0;
          const ctx = mpCanvas.getContext("2d");
          ctx.clearRect(0, 0, mpCanvas.width, mpCanvas.height);
          ctx.drawImage(mp.img, 0, 0, mpCanvas.width, mpCanvas.height);
          // tint = mask silhouette filled red, composited at 45 %
          mp.tctx.clearRect(0, 0, mp.w, mp.h);
          mp.tctx.globalCompositeOperation = "source-over";
          mp.tctx.drawImage(mp.mctx.canvas, 0, 0);
          mp.tctx.globalCompositeOperation = "source-in";
          mp.tctx.fillStyle = "#ff2b2b";
          mp.tctx.fillRect(0, 0, mp.w, mp.h);
          ctx.globalAlpha = 0.45;
          ctx.drawImage(mp.tctx.canvas, 0, 0, mpCanvas.width, mpCanvas.height);
          ctx.globalAlpha = 1;
        });
      }
      // Screen → native-mask coords via the canvas rect (zoom-independent).
      function mpPoint(e) {
        const r = mpCanvas.getBoundingClientRect();
        return {
          x: ((e.clientX - r.left) / r.width) * mp.w,
          y: ((e.clientY - r.top) / r.height) * mp.h,
          k: mp.w / r.width,   // screen px → native px factor (for brush size)
        };
      }
      let mpStroke = null;
      mpCanvas.addEventListener("pointerdown", (e) => {
        e.stopPropagation(); e.preventDefault();
        if (!mp.open) return;
        try { mpCanvas.setPointerCapture(e.pointerId); } catch (err) {}
        const pt = mpPoint(e);
        mpStroke = { id: e.pointerId, last: pt };
        mpDab(pt, pt);
      });
      mpCanvas.addEventListener("pointermove", (e) => {
        if (!mpStroke || e.pointerId !== mpStroke.id) return;
        const pt = mpPoint(e);
        mpDab(mpStroke.last, pt);
        mpStroke.last = pt;
      });
      const mpStrokeEnd = (e) => {
        if (!mpStroke || e.pointerId !== mpStroke.id) return;
        try { mpCanvas.releasePointerCapture(e.pointerId); } catch (err) {}
        mpStroke = null;
      };
      mpCanvas.addEventListener("pointerup", mpStrokeEnd);
      mpCanvas.addEventListener("pointercancel", mpStrokeEnd);
      function mpDab(a, b) {
        const c = mp.mctx;
        c.globalCompositeOperation = mpErase ? "destination-out" : "source-over";
        c.strokeStyle = "#fff";
        c.lineWidth = Math.max(1, S._mpBrush * a.k);
        c.lineCap = "round";
        c.lineJoin = "round";
        c.beginPath();
        c.moveTo(a.x, a.y);
        c.lineTo(b.x + 0.01, b.y + 0.01);   // dot on click without movement
        c.stroke();
        if (!mpErase) mp.painted = true;
        mpRender();
      }
      const mpKey = (e) => {
        if (e.key === "Escape") { e.stopPropagation(); closeMaskPainter(false); }
      };
      // Native ComfyUI Mask Editor — primary path. The editor only operates
      // on a SELECTED GRAPH NODE with a loaded image (a clipspace stub is
      // ignored — verified), so we spawn a temporary offscreen LoadImage,
      // open the editor on it, and watch its widget: Save pastes the painted
      // PNG back as "clipspace/… [input]" — an annotated name K2E:mask eats
      // directly, no upload. Cancel (dialog gone, value untouched) discards.
      // Any internals mismatch falls back to the built-in painter below.
      let _nmeBusy = false;
      async function openMaskEditor() {
        if (_nmeBusy) return;
        const src = S._editSrc;
        if (!src) { setStatus("Pick a source image first.", C.err); return; }
        // ComfyUI's mask editor is a canvas-level dialog (below our overlay)
        // and needs a selected graph node — leave fullscreen first.
        exitFullscreen();
        _nmeBusy = true;
        let temp = null;
        const cleanup = () => {
          if (temp) { try { app.graph.remove(temp); } catch (e) {} temp = null; }
          try { app.canvas.deselectAll ? app.canvas.deselectAll() : app.canvas.deselectAllNodes?.(); } catch (e) {}
        };
        try {
          if (typeof app.extensionManager?.command?.execute !== "function")
            throw new Error("no command API");
          // stage the image the editor loads: an existing mask re-opens for
          // further editing, file sources upload once and reuse the name
          let name;
          if (S._editMask?.name) {
            name = S._editMask.name;
          } else if (src.kind === "file") {
            if (!src.uploadedName) {
              setStatus("Uploading source…");
              const up = await uploadSource(src.file);
              src.uploadedName = up.imageName;
              src.uploadedBefore = up.before;
            }
            name = src.uploadedName;
          } else {
            name = annotatedName(src.img);
          }
          temp = LiteGraph.createNode("LoadImage");
          if (!temp) throw new Error("LoadImage unavailable");
          temp.pos = [-99999, -99999];
          app.graph.add(temp);
          const w = temp.widgets?.find(x => x.name === "image");
          if (!w) throw new Error("no image widget");
          w.value = name;
          // LoadImage previews load lazily on canvas draw — an offscreen node
          // never draws, so stage the preview image ourselves (the editor
          // reads node.imgs[imageIndex]).
          const m = name.match(/^(.*?)\s*\[(input|temp|output)\]$/);
          const path = m ? m[1] : name;
          const cut = path.lastIndexOf("/");
          const desc = {
            filename: cut >= 0 ? path.slice(cut + 1) : path,
            subfolder: cut >= 0 ? path.slice(0, cut) : "",
            type: m ? m[2] : "input",
          };
          const pv = new Image();
          await new Promise((res, rej) => {
            pv.onload = res;
            pv.onerror = () => rej(new Error("preview failed to load"));
            pv.src = viewUrl(desc);
          });
          temp.imgs = [pv];
          temp.imageIndex = 0;
          app.canvas.selectNode(temp);
          app.extensionManager.command.execute("Comfy.MaskEditor.OpenMaskEditor").catch(() => {});
          setStatus("Mask editor open — paint, then Save.");
          const EDITOR_SEL = ".maskeditor, [class*='mask-editor'], [class*='maskEditor']";
          let sawDialog = false;
          for (let i = 0; i < 1200; i++) {   // ≤10 min in the editor
            await new Promise(r => setTimeout(r, 500));
            if (w.value !== name) {          // Save rewrote the widget
              S._editMask = { name: w.value };
              setStatus("Mask saved.");
              break;
            }
            if (document.querySelector(EDITOR_SEL)) sawDialog = true;
            else if (sawDialog) { setStatus("Mask edit cancelled."); break; }
            else if (i > 10) throw new Error("editor never opened");
          }
          cleanup();
          syncEditUI();
        } catch (e) {
          cleanup();
          console.warn("[Krea2OneNode] native mask editor unavailable:", e);
          setStatus("Native mask editor unavailable — using built-in painter.", C.warn);
          openMaskPainter();
        } finally {
          _nmeBusy = false;
        }
      }

      function openMaskPainter() {
        const src = S._editSrc;
        if (!src) { setStatus("Pick a source image first.", C.err); return; }
        const im = new Image();
        im.onload = () => {
          mp.img = im;
          mp.w = im.naturalWidth;
          mp.h = im.naturalHeight;
          // fit the display canvas into the stage
          const sr = mpStage.getBoundingClientRect();
          const sc = uiScale();
          const availW = Math.max(64, sr.width / sc - 16), availH = Math.max(64, sr.height / sc - 16);
          const f = Math.min(availW / mp.w, availH / mp.h, 1);
          mpCanvas.width = Math.max(1, Math.round(mp.w * f));
          mpCanvas.height = Math.max(1, Math.round(mp.h * f));
          mpCanvas.style.width = mpCanvas.width + "px";
          mpCanvas.style.height = mpCanvas.height + "px";
          const mc = document.createElement("canvas");
          mc.width = mp.w; mc.height = mp.h;
          mp.mctx = mc.getContext("2d");
          const tc = document.createElement("canvas");
          tc.width = mp.w; tc.height = mp.h;
          mp.tctx = tc.getContext("2d");
          // repaint: restore the previous mask canvas for this source
          const prev = S._editMask;
          mp.painted = !!(prev?.canvas && prev.w === mp.w && prev.h === mp.h);
          if (mp.painted) mp.mctx.drawImage(prev.canvas, 0, 0);
          mp.open = true;
          mpErase = false;
          mpSyncTools();
          mpWrap.style.display = "flex";
          document.addEventListener("keydown", mpKey, true);
          mpRender();
        };
        im.onerror = () => setStatus("Couldn't load the source image.", C.err);
        im.src = src.url || viewUrl(src.img);
      }
      function closeMaskPainter(commit) {
        if (!mp.open) return;
        mp.open = false;
        document.removeEventListener("keydown", mpKey, true);
        mpWrap.style.display = "none";
        if (!commit) { syncEditUI(); return; }
        // Export: opaque black, painted region punched to alpha 0.
        const out = document.createElement("canvas");
        out.width = mp.w; out.height = mp.h;
        const octx = out.getContext("2d");
        octx.fillStyle = "#000";
        octx.fillRect(0, 0, mp.w, mp.h);
        octx.globalCompositeOperation = "destination-out";
        octx.drawImage(mp.mctx.canvas, 0, 0);
        out.toBlob((blob) => {
          // nothing painted → no mask (mp.painted tracks brush strokes)
          S._editMask = mp.painted && blob
            ? { blob, canvas: mp.mctx.canvas, w: mp.w, h: mp.h }
            : null;
          syncEditUI();
        }, "image/png");
      }

      const overlayTR = mk("div", { position: "absolute", top: "8px", right: "8px", display: "flex", gap: "6px", zIndex: "5" });
      const cmpChip = DarkChip("◧ Compare", () => toggleCompare());
      cmpChip.style.display = "none";
      cmpChip.title = "Before / after slider for this upscaled result";
      const upChip = DarkChip("⤢ Upscale ▾", () => openUpscaleMenu(upChip));
      upChip.style.display = "none";
      upChip.title = "Upscale this image with SeedVR2 (engine follows the UPSCALE tab)";
      const clearChip = DarkChip("✕ Clear", () => doClearResult());
      clearChip.style.display = "none";
      clearChip.title = "Clear the result from this node (files on disk are untouched)";
      const saveChip = DarkChip("Save", () => doSaveTemp());
      saveChip.style.display = "none";
      const useAsChip = DarkChip("Use as…  ▾", () => openUseAsMenu(useAsChip));
      useAsChip.style.display = "none";
      useAsChip.title = "Send this result to the Edit tab (source or person reference)";
      overlayTR.append(cmpChip, upChip, clearChip, saveChip, useAsChip);
      right.appendChild(overlayTR);

      // Thumb strip — its own row under the preview box (never over the
      // image): "n/total" counter + scrollable thumbnails. The selected thumb
      // (the one in the preview) gets a lime ring, full opacity and a slight
      // raise; the rest sit dimmed. Shown for a single result too, so one-off
      // generations stay one click away; ✕ Clear empties it.
      const thumbStrip = mk("div", {
        flexShrink: "0", display: "none", alignItems: "center", gap: "4px",
        padding: "5px 8px 5px 10px", background: "rgba(16,16,16,.9)",
        border: `1px solid ${C.border}`, borderRadius: "10px",
        boxSizing: "border-box",
      });
      const thumbCounter = mk("div", {
        flexShrink: "0", fontSize: "10px", fontWeight: "700", color: LIME,
        fontVariantNumeric: "tabular-nums", letterSpacing: ".04em",
        paddingRight: "8px", borderRight: "1px solid rgba(255,255,255,.1)",
      });
      const thumbScroller = mk("div", {
        display: "flex", alignItems: "flex-end", gap: "7px", flex: "1", minWidth: "0",
        overflowX: "auto", overflowY: "hidden", padding: "7px 2px 3px 8px",
      });
      thumbScroller.className = "k2-thumbs";
      scrollGuard(thumbScroller, true);
      thumbStrip.append(thumbCounter, thumbScroller);
      rightCol.appendChild(thumbStrip);

      // Progress bar — overlaid at the bottom of the preview box, same design
      // as the one-node-flux-2-klein reference (gradient scrim, lime fill).
      const progWrap = mk("div", {
        position: "absolute", bottom: "0", left: "0", right: "0",
        background: "linear-gradient(transparent,rgba(0,0,0,.88))",
        padding: "16px 14px 12px", display: "none",
        flexDirection: "column", gap: "4px", boxSizing: "border-box",
        pointerEvents: "none", zIndex: "6",
      });
      const progTop = mk("div", { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px" });
      // Stage label doubles as the status surface (the old status row below
      // the prompt is gone — setStatus writes here).
      const progStageL = mk("div", {
        fontSize: "11px", fontWeight: "600", color: C.text, textAlign: "left", flex: "1",
        minWidth: "0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      });
      // Execution timer — lives in the overlay next to the percentage: lime
      // live elapsed while running, frozen muted total after.
      const timerEl = mk("div", {
        fontSize: "10px", color: C.muted, flexShrink: "0", display: "none",
        fontVariantNumeric: "tabular-nums",
      });
      const progPct = mk("div", { fontSize: "10px", color: C.muted, flexShrink: "0" });
      tx(progPct, "0%");
      progTop.append(progStageL, timerEl, progPct);
      const progBar = mk("div", { height: "3px", borderRadius: "2px", background: "rgba(255,255,255,.15)", overflow: "hidden", marginTop: "4px" });
      const progFill = mk("div", { height: "100%", background: LIME, width: "0%", transition: "width .3s ease", borderRadius: "2px" });
      progBar.appendChild(progFill);
      const progDetailL = mk("div", { fontSize: "9px", color: "rgba(255,255,255,.5)", textAlign: "center", marginTop: "2px" });
      progWrap.append(progTop, progBar, progDetailL);
      right.appendChild(progWrap);
      const setStage = (detail, pct) => {
        tx(progDetailL, detail);
        if (pct != null) {  // null → update the label only, keep the bar where it is
          progFill.style.width = pct + "%";
          tx(progPct, Math.round(pct) + "%");
        }
      };
      // Unified-progress plan: pass 1 owns 0→split of the bar, pass 2 the rest.
      // p2Start stays for the handler's rebase arithmetic — both ClownsharK
      // passes report from 0, so it is always 0 here.
      function currentProgPlan() {
        if (S.tab === "upscale") return { split: 1, p2Start: 0 };  // single stage
        if (S.tab === "edit") return { split: 1, p2Start: 0 };     // single KSampler
        const p1 = S.q.p1Steps, p2 = Math.max(1, Math.ceil(S.q.denoise * 8));
        return { split: p1 / (p1 + p2), p2Start: 0 };
      }
      // Running mode: full overlay (bar + detail + %). Idle mode: status text
      // and frozen timer only — used after a run ends and for standalone
      // status messages (save/clear/refresh confirmations).
      const progShow = () => {
        progBar.style.display = "";
        progDetailL.style.display = "";
        progPct.style.display = "";
        setStage("Waiting in queue…", 0);
        progWrap.style.display = "flex";
      };
      const progIdle = () => {
        progBar.style.display = "none";
        progDetailL.style.display = "none";
        progPct.style.display = "none";
        progWrap.style.display = "flex";
      };

      // ── PROMPT ─────────────────────────────────────────────────────────────
      const promptWrap = mk("div", { display: "flex", flexDirection: "column", gap: "5px", flex: "0 0 auto" });
      const promptHdr = mk("div", { display: "flex", alignItems: "center", gap: "5px" });
      const promptCap = cap("Prompt"); promptCap.style.marginBottom = "0";
      promptHdr.append(promptCap);
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
      promptTA.oninput = () => { S.prompt = promptTA.value; persist(); taGrow(); syncGenEnabled(); };
      promptTA.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); promptTA.blur(); } });
      scrollGuard(promptTA);
      noDrag(promptTA);
      promptWrap.appendChild(promptTA);
      requestAnimationFrame(taGrow);
      root.appendChild(promptWrap);

      // Status messages render in the preview overlay's stage label (no more
      // status row under the prompt). A message outside a run pops the
      // overlay in idle mode so save/clear/error feedback stays visible.
      const setStatus = (t, color = C.text) => {
        tx(progStageL, t);
        progStageL.style.color = color;
        if (progWrap.style.display === "none") progIdle();
      };

      let _timerIv = null;
      const fmtDur = (ms) => {
        const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
        const pad = (n) => String(n).padStart(2, "0");
        return h ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
      };
      function timerStart() {
        S._runStart = Date.now();
        timerEl.style.display = "";
        timerEl.style.color = LIME;
        tx(timerEl, "⏱ 0:00");
        if (_timerIv) clearInterval(_timerIv);
        _timerIv = setInterval(() => {
          if (S._runStart) tx(timerEl, "⏱ " + fmtDur(Date.now() - S._runStart));
        }, 500);
      }
      function timerStop() {
        if (_timerIv) { clearInterval(_timerIv); _timerIv = null; }
        if (S._runStart) {
          tx(timerEl, "⏱ " + fmtDur(Date.now() - S._runStart));
          timerEl.style.color = C.muted;
          S._runStart = null;
        }
      }

      // ── LoRA rows (rendered into the left-column loraBox) ──────────────────
      function renderLoraRows() {
        loraRows.replaceChildren();
        S.loras.forEach((row, idx) => {
          const r = mk("div", { display: "flex", alignItems: "center", gap: "6px", opacity: row.on ? "1" : ".45" });
          const togBtn = mk("button", {
            background: "none", border: "none", cursor: "pointer", padding: "0 2px",
            color: row.on ? LIME : C.muted, fontSize: "13px", outline: "none", flexShrink: "0",
          }, { title: row.on ? "Disable" : "Enable" });
          tx(togBtn, row.on ? "●" : "○");
          togBtn.onclick = (e) => { e.stopPropagation(); row.on = !row.on; persist(); renderLoraRows(); };
          r.appendChild(noDrag(togBtn));

          const dd = DD(
            () => S._models.loras,
            row.name || null,
            (v) => { row.name = v; persist(); },
            (f) => f.replace(/\.safetensors$/i, ""),
          );
          dd.style.flex = "1"; dd.style.minWidth = "0";
          r.appendChild(dd);

          const st = DragNI(row.strength, -4, 4, 0.25, (v) => { row.strength = v; persist(); }, "48px");
          st.title = "Strength — drag to adjust (±0.25 per notch), click to type";
          r.appendChild(st);

          const rm = mk("button", {
            background: "none", border: "none", cursor: "pointer", padding: "0 2px",
            color: C.muted, fontSize: "13px", outline: "none", flexShrink: "0",
          }, { title: "Remove" });
          tx(rm, "✕");
          rm.onmouseenter = () => rm.style.color = C.err;
          rm.onmouseleave = () => rm.style.color = C.muted;
          rm.onclick = (e) => { e.stopPropagation(); S.loras.splice(idx, 1); persist(); renderLoraRows(); };
          r.appendChild(noDrag(rm));

          loraRows.appendChild(r);
        });
      }
      renderLoraRows();

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
      // The EDIT tab always loads this one at strength 1.0 on top of the base
      // model — it lives here so it's obvious which file to download and where.
      const idLoraCol = modelCol("Identity edit LoRA", "/models/loras", "loras",
        () => S.modelIdLora, (v) => S.modelIdLora = v);
      idLoraCol.appendChild(tx(mk("div", { fontSize: "9px", color: C.muted, marginTop: "5px", lineHeight: "1.5" }),
        "EDIT tab · always on at strength 1.0"));
      modelsRow.append(unetCol, clipCol, vaeCol, idLoraCol);
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
            upscale_models: d.upscale_models || [],
          };
          // The local upscale engine's model/VAE default to whatever SeedVR2
          // files are on disk — only possible once the lists arrive.
          upAutoPickModels();
          if (showStatus) setStatus("Model lists refreshed.", C.ok);
        }).catch(() => { if (showStatus) setStatus("Model refresh failed.", C.err); });
      }
      loadModels(false);

      // ── HELP overlay (where to get models + required node packs) ───────────
      // Same shape as the reference node's Help: rows of download chips with the
      // destination folder on the right. Everything listed here is what the four
      // workflow templates actually reference — keep it in sync when a template
      // gains or drops a node/model.
      const helpOverlay = mk("div", {
        position: "absolute", inset: "0", zIndex: "300", display: "none",
        flexDirection: "column", background: C.bg0, borderRadius: "10px",
        padding: "16px 20px", boxSizing: "border-box", gap: "8px",
        overflowY: "auto",
      });
      noDrag(helpOverlay);
      helpOverlay.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
      root.appendChild(helpOverlay);

      const helpHdr = mk("div", { display: "flex", alignItems: "center", gap: "8px", flexShrink: "0" });
      const helpTitle = mk("div", {
        fontSize: "15px", fontWeight: "700", letterSpacing: ".12em",
        textTransform: "uppercase", color: "#fff", flex: "1",
      });
      tx(helpTitle, "✦ Help");
      const helpClose = mk("button", {
        background: "transparent", border: `1.5px solid rgba(255,103,103,.55)`,
        borderRadius: "6px", padding: "4px 11px", cursor: "pointer",
        color: C.err, fontSize: "11px", fontWeight: "700", outline: "none",
        transition: "all .15s",
      });
      tx(helpClose, "× Close");
      helpClose.onmouseenter = () => { helpClose.style.background = "rgba(255,103,103,.1)"; };
      helpClose.onmouseleave = () => { helpClose.style.background = "transparent"; };
      helpClose.onclick = (e) => { e.stopPropagation(); helpOverlay.style.display = "none"; };
      helpHdr.append(helpTitle, noDrag(helpClose));
      helpOverlay.appendChild(helpHdr);

      const ICON_DL = "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z";
      const ICON_EXT = "M14 3v2h3.6l-9.8 9.8 1.4 1.4L19 6.4V10h2V3h-7zM5 5h5V3H3v18h18v-7h-2v5H5V5z";
      function helpLink(name, url, iconPath = ICON_DL) {
        const a = mk("a", {
          fontSize: "10px", color: C.text, background: C.bg3,
          border: `1px solid ${C.border}`, borderRadius: "5px", padding: "3px 9px",
          textDecoration: "none", display: "inline-flex", alignItems: "center",
          gap: "4px", transition: "border-color .15s, color .15s", flexShrink: "0",
        }, { href: url, target: "_blank", rel: "noopener" });
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("width", "9"); svg.setAttribute("height", "9");
        svg.style.fill = "currentColor"; svg.style.flexShrink = "0";
        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("d", iconPath);
        svg.appendChild(p);
        a.append(svg, tx(mk("span"), name));
        a.onmouseenter = () => { a.style.borderColor = LIME; a.style.color = LIME; };
        a.onmouseleave = () => { a.style.borderColor = C.border; a.style.color = C.text; };
        return noDrag(a);
      }
      function helpSection(title) {
        const t = mk("div", {
          fontSize: "11px", fontWeight: "700", color: C.text, letterSpacing: ".02em",
          marginTop: "10px", marginBottom: "8px", paddingTop: "10px",
          borderTop: `1px solid ${C.border}`,
        });
        return tx(t, title);
      }
      // Node packs get an installed/missing dot, probed lazily the first time
      // Help opens: /object_info/<class> answers 200 with {} when the class
      // isn't registered, so one tiny request per pack is enough.
      const packProbes = [];
      let packsChecked = false;
      function checkPacks() {
        if (packsChecked) return;
        packsChecked = true;
        packProbes.forEach(({ el, cls }) => {
          api.fetchApi(`/object_info/${encodeURIComponent(cls)}`)
            .then(r => r.json())
            .then(d => {
              const have = !!d && Object.keys(d).length > 0;
              tx(el, have ? "✓ installed" : "● missing");
              el.style.color = have ? C.ok : C.warn;
            })
            .catch(() => { tx(el, ""); });
        });
      }

      // label · chips · right-hand destination (folder path or "needed by" hint)
      function helpRow(label, dest, links, note, icon, probe) {
        const wrap = mk("div", { marginBottom: "7px" });
        const row = mk("div", { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" });
        const lbl = mk("span", {
          fontSize: "9px", fontWeight: "700", color: LIME, letterSpacing: ".06em",
          textTransform: "uppercase", minWidth: "128px", flexShrink: "0",
        });
        tx(lbl, label);
        const cw = mk("div", { display: "flex", gap: "4px", flexWrap: "wrap", flex: "1", alignItems: "center" });
        links.forEach((l, i) => {
          if (i > 0) cw.appendChild(tx(mk("span", { fontSize: "8px", color: C.muted, alignSelf: "center", flexShrink: "0" }), "or"));
          cw.appendChild(helpLink(l.name, l.url, icon));
        });
        const d = mk("div", {
          fontSize: "9px", color: "#888", fontFamily: "monospace",
          whiteSpace: "nowrap", fontWeight: "600",
        });
        tx(d, dest);
        if (probe) {
          const st = mk("span", { fontSize: "9px", fontWeight: "700", color: C.muted, whiteSpace: "nowrap", flexShrink: "0" });
          tx(st, "checking…");
          packProbes.push({ el: st, cls: probe });
          row.append(lbl, cw, st, d);
        } else {
          row.append(lbl, cw, d);
        }
        wrap.appendChild(row);
        if (note) wrap.appendChild(tx(mk("div", {
          fontSize: "8px", color: C.muted, fontStyle: "italic",
          marginTop: "2px", paddingLeft: "134px",
        }), note));
        return wrap;
      }

      const HF = "https://huggingface.co";
      const K2 = `${HF}/Comfy-Org/Krea-2/resolve/main`;
      const IDE = `${HF}/conradlocke/krea2-identity-edit/resolve/main`;

      const modelsTitle = helpSection("Where to Get Models");
      modelsTitle.style.borderTop = "none";
      modelsTitle.style.paddingTop = "0";
      modelsTitle.style.marginTop = "4px";
      helpOverlay.append(modelsTitle);

      const modelsList = mk("div", { display: "flex", flexDirection: "column", gap: "2px" });
      modelsList.append(
        helpRow("Diffusion Model", "→ models/diffusion_models/", [
          { name: "krea2_turbo_bf16", url: `${K2}/diffusion_models/krea2_turbo_bf16.safetensors` },
          { name: "krea2_turbo_fp8_scaled", url: `${K2}/diffusion_models/krea2_turbo_fp8_scaled.safetensors` },
          { name: "krea2_turbo_int8_convrot", url: `${K2}/diffusion_models/krea2_turbo_int8_convrot.safetensors` },
        ], "Turbo variants only — every template is tuned for the 8-step turbo model. bf16 is the template default; fp8/int8 for less VRAM."),
        helpRow("Text Encoder", "→ models/text_encoders/", [
          { name: "qwen3vl_4b_fp8_scaled", url: `${K2}/text_encoders/qwen3vl_4b_fp8_scaled.safetensors` },
          { name: "qwen3vl_4b_bf16", url: `${K2}/text_encoders/qwen3vl_4b_bf16.safetensors` },
        ], "Loaded with CLIPLoader type \"krea2\"."),
        helpRow("VAE", "→ models/vae/", [
          { name: "qwen_image_vae", url: `${K2}/vae/qwen_image_vae.safetensors` },
        ]),
        helpRow("Identity Edit LoRA", "→ models/loras/", [
          { name: "krea2_identity_edit_v1_2", url: `${IDE}/krea2_identity_edit_v1_2.safetensors` },
          { name: "…_v1_2_r128", url: `${IDE}/krea2_identity_edit_v1_2_r128.safetensors` },
          { name: "…_v1_2_r64", url: `${IDE}/krea2_identity_edit_v1_2_r64.safetensors` },
        ], "Required by the EDIT tab (hardwired at strength 1.0, no UI control). r128/r64 are the smaller low-VRAM ranks — rename to krea2_identity_edit_v1_2.safetensors or edit workflows/edit_workflow.json."),
        helpRow("Upscale Model", "→ models/diffusion_models/", [
          { name: "seedvr2 (pick a variant)", url: `${HF}/Comfy-Org/SeedVR2/tree/main/diffusion_models` },
        ], "UPSCALE tab, LOCAL engine — pick the variant that fits your VRAM (3b is the safe default). The CLOUD engine calls fal.ai instead and downloads nothing."),
        helpRow("Upscale VAE", "→ models/vae/", [
          { name: "ema_vae_fp16", url: `${HF}/Comfy-Org/SeedVR2/resolve/main/vae/ema_vae_fp16.safetensors` },
        ], "SeedVR2's own VAE — not the Krea 2 one."),
      );
      helpOverlay.appendChild(modelsList);

      helpOverlay.appendChild(helpSection("Required Custom Node Packs"));
      const packsList = mk("div", { display: "flex", flexDirection: "column", gap: "2px" });
      packsList.append(
        helpRow("rgthree-comfy", "→ all tabs", [
          { name: "rgthree/rgthree-comfy", url: "https://github.com/rgthree/rgthree-comfy" },
        ], "Power Lora Loader + Seed. Required by every template.", ICON_EXT, "Power Lora Loader (rgthree)"),
        helpRow("comfyui-krea2edit", "→ EDIT", [
          { name: "lbouaraba/comfyui-krea2edit", url: "https://github.com/lbouaraba/comfyui-krea2edit" },
        ], "Krea2EditModelPatch + Krea2EditGroundedEncode.", ICON_EXT, "Krea2EditModelPatch"),
        helpRow("RES4LYF", "→ T2I", [
          { name: "ClownsharkBatwing/RES4LYF", url: "https://github.com/ClownsharkBatwing/RES4LYF" },
        ], "ClownsharKSampler_Beta — both HQ passes.", ICON_EXT, "ClownsharKSampler_Beta"),
        helpRow("Krea2T-Enhancer", "→ T2I", [
          { name: "capitan01R/ComfyUI-Krea2T-Enhancer", url: "https://github.com/capitan01R/ComfyUI-Krea2T-Enhancer" },
        ], "Model patch in the HQ chain (enabled, strength 1.5).", ICON_EXT, "ComfyUI-Krea2T-Enhancer"),
        helpRow("ComfyUI_LayerStyle", "→ T2I", [
          { name: "chflame163/ComfyUI_LayerStyle", url: "https://github.com/chflame163/ComfyUI_LayerStyle" },
        ], "LayerFilter: AddGrain — the HQ Grain post step.", ICON_EXT, "LayerFilter: AddGrain"),
        helpRow("WAS Node Suite", "→ T2I", [
          { name: "WASasquatch/was-node-suite-comfyui", url: "https://github.com/WASasquatch/was-node-suite-comfyui" },
        ], "Image Lucy Sharpen — the HQ Sharpen post step.", ICON_EXT, "Image Lucy Sharpen"),
        helpRow("ComfyUI-fal-API", "→ UPSCALE", [
          { name: "gokayfem/ComfyUI-fal-API", url: "https://github.com/gokayfem/ComfyUI-fal-API" },
        ], "SeedVR2 upscale node. Needs a fal.ai API key — paid per call.", ICON_EXT,
          "FalAPI_fal-ai-seedvr-upscale-image"),
      );
      helpOverlay.appendChild(packsList);
      const packsNote = mk("div", { fontSize: "9px", color: C.muted, lineHeight: "1.6", marginTop: "2px" });
      packsNote.innerHTML = "Install everything missing in one go: run <b>install_deps.sh</b> in this node's folder "
        + "(macOS: double-click <b>Install Dependencies.command</b>), then restart ComfyUI. "
        + "<b>rgthree-comfy</b> is needed everywhere; T2I and BATCH also need RES4LYF, Krea2T-Enhancer, "
        + "LayerStyle and WAS; EDIT needs krea2edit; UPSCALE needs fal-API. "
        + "Everything else the templates use (KSampler, LoadImage, ResizeImageMaskNode, SaveImage…) is ComfyUI core. "
        + "Apple Silicon: the float64→float32 MPS guard ships inside this node pack, nothing extra to install.";
      helpOverlay.appendChild(packsNote);

      helpOverlay.appendChild(helpSection("Links"));
      const linksRow = mk("div", { display: "flex", gap: "5px", flexWrap: "wrap", paddingBottom: "6px" });
      [
        { name: "🌐 Krea", url: "https://www.krea.ai/" },
        { name: "🤗 Comfy-Org/Krea-2", url: `${HF}/Comfy-Org/Krea-2` },
        { name: "📖 ComfyUI Krea 2 guide", url: "https://docs.comfy.org/tutorials/image/krea/krea-2" },
        { name: "🤗 Identity Edit LoRA", url: `${HF}/conradlocke/krea2-identity-edit` },
        { name: "🤗 SeedVR2 (local upscale)", url: `${HF}/Comfy-Org/SeedVR2` },
      ].forEach(({ name, url }) => {
        const a = mk("a", {
          fontSize: "10px", color: C.muted, background: C.bg2,
          border: `1px solid ${C.border}`, borderRadius: "5px", padding: "4px 10px",
          textDecoration: "none", transition: "border-color .15s, color .15s",
          display: "inline-block",
        }, { href: url, target: "_blank", rel: "noopener" });
        tx(a, name);
        a.onmouseenter = () => { a.style.borderColor = C.text; a.style.color = C.text; };
        a.onmouseleave = () => { a.style.borderColor = C.border; a.style.color = C.muted; };
        linksRow.appendChild(noDrag(a));
      });
      helpOverlay.appendChild(linksRow);

      // ── image display helpers ──────────────────────────────────────────────
      function viewUrl(img) {
        const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || "", type: img.type || "output", t: Date.now() });
        return api.apiURL(`/view?${q}`);
      }
      function imgEq(a, b) {
        return !!a && !!b && a.filename === b.filename
          && (a.subfolder || "") === (b.subfolder || "")
          && (a.type || "output") === (b.type || "output");
      }
      // Before-image registry for upscaled results — drives the compare view.
      const cmpKey = (img) => `${img.filename}|${img.subfolder || ""}|${img.type || "output"}`;
      S._cmp = new Map();
      S._pfx = new Map();   // cmpKey → save_temp prefix ("up" | "edit")
      // cmpKey → the exact inputs an edit job ran with {src, ref, mode, mask},
      // so "Use as… → original input" can reload a failed result's setup and
      // let the user try again. Runtime only.
      S._orig = new Map();
      function registerCompare(after, before, pfx = "up", origin = null) {
        S._cmp.set(cmpKey(after), before);
        S._pfx.set(cmpKey(after), pfx);   // save_temp prefix for this result
        if (origin) S._orig.set(cmpKey(after), origin);
        S._cmpOn = true;   // fresh upscale/edit pops up in compare mode
      }
      let _gallery = [];   // images last passed to showBatch (lightbox nav + selection)
      function showImage(img) {
        S.lastImage = img;
        previewImg.src = viewUrl(img);
        previewImg.style.display = "";
        previewEmpty.style.display = "none";
        saveChip.style.display = img.type === "temp" ? "" : "none";
        clearChip.style.display = "";
        upChip.style.display = "";
        useAsChip.style.display = "";
        syncCompare();
        pushOutput(img);
        syncThumbSel();
      }
      // Append `imgs` to whatever the strip already holds. The strip is a
      // session gallery: it accumulates across runs and is emptied only by the
      // ✕ Clear chip, never by starting a new generation.
      function galAdd(imgs) { showBatch(_gallery.concat(imgs)); }
      function showBatch(images) {
        // Incremental. Blowing the strip away and rebuilding it with the same
        // srcs on every finished job left every thumb blank (zero-width until
        // its image re-decoded) — only touch the tail that actually changed.
        const kids = [...thumbScroller.children];
        let keep = 0;
        while (keep < kids.length && keep < images.length && imgEq(kids[keep]._img, images[keep])) keep++;
        for (let i = kids.length - 1; i >= keep; i--) kids[i].remove();
        _gallery = images.slice();
        if (!images.length) { thumbStrip.style.display = "none"; lbSyncGallery(); return; }
        thumbStrip.style.display = "flex";
        images.slice(keep).forEach((img, k) => {
          const i = keep + k;
          const w = mk("div", {
            position: "relative", flexShrink: "0", borderRadius: "8px",
            cursor: "pointer", lineHeight: "0", overflow: "hidden",
            border: "1px solid rgba(255,255,255,.13)", opacity: ".55",
            // Reserve a slot so a not-yet-decoded thumb isn't zero-width.
            minWidth: "32px", minHeight: "54px", background: "rgba(255,255,255,.05)",
            transition: "transform .18s cubic-bezier(.22,1,.36,1), box-shadow .18s ease, border-color .18s ease, opacity .18s ease",
          });
          // Everything built here is new to the strip, so it animates in.
          w.style.animation = "k2-thumb-in .28s cubic-bezier(.22,1,.36,1)";
          const im = mk("img", { height: "54px", display: "block", pointerEvents: "none" }, { src: viewUrl(img), draggable: false });
          const num = mk("div", {
            position: "absolute", top: "3px", left: "3px", fontSize: "8px",
            fontWeight: "700", color: "rgba(255,255,255,.85)",
            background: "rgba(0,0,0,.55)", borderRadius: "4px", padding: "1px 4px",
            lineHeight: "1.4", pointerEvents: "none", fontVariantNumeric: "tabular-nums",
          });
          tx(num, String(i + 1));
          w.append(im, num);
          w._img = img;
          w._num = num;
          w.onmouseenter = () => { if (!w._sel) { w.style.opacity = "1"; w.style.transform = "translateY(-2px)"; } };
          w.onmouseleave = () => { if (!w._sel) { w.style.opacity = ".55"; w.style.transform = ""; } };
          w.addEventListener("click", (e) => { e.stopPropagation(); showImage(img); });
          w.addEventListener("dblclick", (e) => { e.stopPropagation(); openLightbox(img); });
          w.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); openCtxMenu(e, img); });
          thumbScroller.appendChild(noDrag(w));
        });
        syncThumbSel();
        lbSyncGallery();
      }
      function syncThumbSel() {
        const kids = [...thumbScroller.children];
        if (!kids.length) return;
        let selIdx = -1;
        kids.forEach((w, i) => {
          const sel = imgEq(w._img, S.lastImage);
          w._sel = sel;
          if (sel) selIdx = i;
          w.style.opacity = sel ? "1" : ".55";
          w.style.transform = sel ? "translateY(-3px)" : "";
          w.style.borderColor = sel ? LIME : "rgba(255,255,255,.13)";
          w.style.boxShadow = sel ? `0 0 0 1px ${LIME}, 0 4px 16px rgba(240,255,65,.28)` : "none";
          w._num.style.background = sel ? LIME : "rgba(0,0,0,.55)";
          w._num.style.color = sel ? "#111" : "rgba(255,255,255,.85)";
        });
        tx(thumbCounter, selIdx >= 0 ? `${selIdx + 1}/${kids.length}` : String(kids.length));
        // Keep the selected thumb in view (rects are canvas-zoom scaled;
        // scroll offsets aren't — divide the delta back out).
        const w = kids[selIdx];
        if (w) {
          const sc = uiScale();
          const sr = thumbScroller.getBoundingClientRect(), wr = w.getBoundingClientRect();
          if (wr.left < sr.left) thumbScroller.scrollBy({ left: (wr.left - sr.left - 24 * sc) / sc, behavior: "smooth" });
          else if (wr.right > sr.right) thumbScroller.scrollBy({ left: (wr.right - sr.right + 24 * sc) / sc, behavior: "smooth" });
        }
      }

      // ── context menu (preview + thumbs + lightbox): Open in Finder etc. ────
      const ctxMenu = mk("div", {
        position: "fixed", zIndex: "1000001", display: "none", flexDirection: "column",
        background: C.bg1, border: `1px solid ${C.borderH}`, borderRadius: "8px",
        boxShadow: "0 12px 32px rgba(0,0,0,.85)", overflow: "hidden", minWidth: "180px",
        padding: "4px",
        fontFamily: "'Inter','Segoe UI',system-ui,sans-serif",
      });
      document.body.appendChild(ctxMenu);
      const closeCtx = () => { ctxMenu.style.display = "none"; document.removeEventListener("pointerdown", ctxDoc, true); };
      const ctxDoc = (e) => { if (!ctxMenu.contains(e.target)) closeCtx(); };
      function ctxItem(icon, label, onClick) {
        const r = mk("div", {
          display: "flex", alignItems: "center", gap: "8px",
          padding: "7px 12px", fontSize: "11px", cursor: "pointer",
          color: C.text, borderRadius: "5px", transition: "background .1s",
          whiteSpace: "nowrap",
        });
        r.append(tx(mk("span", { fontSize: "11px", width: "14px", textAlign: "center", color: C.muted, flexShrink: "0" }), icon), tx(mk("span"), label));
        r.onmouseenter = () => r.style.background = C.bg3;
        r.onmouseleave = () => r.style.background = "transparent";
        r.onclick = (e) => { e.stopPropagation(); closeCtx(); onClick(); };
        return r;
      }
      function openCtxMenu(e, img) {
        ctxMenu.replaceChildren(
          ctxItem("⌘", "Open in Finder", () => revealInFinder(img)),
          ctxItem("↗", "Open in new tab", () => window.open(viewUrl(img), "_blank")),
        );
        ctxMenu.style.left = Math.min(e.clientX, window.innerWidth - 200) + "px";
        ctxMenu.style.top = Math.min(e.clientY, window.innerHeight - 84) + "px";
        ctxMenu.style.display = "flex";
        document.addEventListener("pointerdown", ctxDoc, true);
      }
      // 2× / 4× picker for the viewer's ⤢ Upscale chip (reuses the ctx menu
      // container, anchored under the chip).
      // "Use as…" — send the current result into the EDIT tab. view-kind
      // sources feed LoadImage the annotated "subfolder/file [type]" name,
      // so no re-upload happens.
      // Decode an image descriptor into an edit-slot value (the wells need the
      // pixel dimensions for the output-size maths).
      function viewVal(img) {
        return new Promise((res, rej) => {
          const im = new Image();
          im.onload = () => res({ kind: "view", img, name: img.filename, w: im.naturalWidth, h: im.naturalHeight });
          im.onerror = () => rej(new Error("load failed"));
          im.src = viewUrl(img);
        });
      }
      async function sendToEdit(img, slot) {
        let v;
        try { v = await viewVal(img); }
        catch (e) { setStatus("Couldn't load that image.", C.err); return; }
        if (slot === "ref") {
          setEditRef(v);
          S.edit.mode = "ref";   // person slot implies Reference mode
        } else {
          setEditSource(v);      // also drops any painted mask
        }
        persist();
        if (S.tab !== "edit") setTab("edit");
        else { syncEditUI(); syncAdv(); }
        setStatus(slot === "ref" ? "Sent to Edit as the person reference." : "Sent to Edit as the source image.");
      }
      // Reload the inputs a result was made from, so a bad generation can be
      // re-run with a different prompt/seed instead of hunting for the source
      // again. Edit results restore source + person + mode (+ the painted mask
      // when it was made in the native editor, which lives server-side);
      // upscale results only have a source recorded.
      async function loadOriginalInput(after) {
        const key = cmpKey(after);
        const o = S._orig.get(key) || (S._cmp.has(key) ? { src: S._cmp.get(key) } : null);
        if (!o?.src) { setStatus("No original input recorded for this result.", C.warn); return; }
        let src;
        try { src = await viewVal(o.src); }
        catch (e) { setStatus("The original input is gone from disk.", C.err); return; }
        setEditSource(src);   // clears the mask + extras; both are re-set below
        let lostRef = false;
        if (o.mode !== undefined) {   // full edit origin — restore mode + person too
          let ref = null;
          if (o.ref) {
            try { ref = await viewVal(o.ref); } catch (e) { lostRef = true; }
          }
          setEditRef(ref);
          S.edit.mode = lostRef ? "none" : (o.mode || "none");
          if (o.mask) S._editMask = { name: o.mask };
        }
        persist();
        if (S.tab !== "edit") setTab("edit");
        else { syncEditUI(); syncAdv(); }
        setStatus(lostRef
          ? "Original source loaded — the person image is gone from disk."
          : "Original input loaded — change the prompt or seed and run again.",
          lostRef ? C.warn : C.text);
      }
      function openUseAsMenu(anchor) {
        const img = S.lastImage;
        if (!img?.filename) return;
        const key = cmpKey(img);
        const hasOrig = S._orig.has(key) || S._cmp.has(key);
        ctxMenu.replaceChildren(
          ctxItem("✎", "Edit — source image", () => sendToEdit(img, "src")),
          ctxItem("👤", "Edit — person (reference)", () => sendToEdit(img, "ref")),
          // Only results we made from a known input can offer this.
          ...(hasOrig ? [ctxItem("↺", "Edit — original input", () => loadOriginalInput(img))] : []),
        );
        const r = anchor.getBoundingClientRect();
        ctxMenu.style.left = Math.min(r.left, window.innerWidth - 220) + "px";
        ctxMenu.style.top = Math.min(r.bottom + 4, window.innerHeight - 118) + "px";
        ctxMenu.style.display = "flex";
        document.addEventListener("pointerdown", ctxDoc, true);
      }
      function openUpscaleMenu(anchor) {
        const img = S.lastImage;
        if (!img?.filename) return;
        // Entries follow the UPSCALE tab's engine: target resolutions on the
        // cloud path, scale factors on the local one.
        ctxMenu.replaceChildren(...(S.up.engine === "local"
          ? [2, 4, 6, 8].map(f =>
              ctxItem("⤢", `Upscale ${f}× (local)`, () => doViewerUpscale(img, { engine: "local", factor: f })))
          : ["1080p", "1440p", "2160p"].map(res =>
              ctxItem("⤢", `Upscale → ${res}`, () => doViewerUpscale(img, { engine: "cloud", resolution: res })))
        ));
        const r = anchor.getBoundingClientRect();
        ctxMenu.style.left = Math.min(r.left, window.innerWidth - 200) + "px";
        ctxMenu.style.top = Math.min(r.bottom + 4, window.innerHeight - 118) + "px";
        ctxMenu.style.display = "flex";
        document.addEventListener("pointerdown", ctxDoc, true);
      }

      function revealInFinder(img) {
        // Backend reveals the exact file (open -R); with no filename it opens
        // the gallery output folder instead.
        api.fetchApi("/krea2_onenode/open_folder", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(img || {}),
        }).catch(() => {});
      }

      // ── lightbox: fullscreen viewer on document.body (escapes the canvas
      // zoom transform). Scroll = zoom at cursor, drag = pan, double-click =
      // fit ↔ 100%, ←/→ = prev/next, Esc / backdrop click = close. ──────────
      const lb = mk("div", {
        position: "fixed", inset: "0", zIndex: "1000000", display: "none",
        background: "rgba(5,5,5,.96)", userSelect: "none",
        fontFamily: "'Inter','Segoe UI',system-ui,sans-serif",
      });
      lb.className = "k2-lb";
      document.body.appendChild(lb);
      const lbStage = mk("div", { position: "absolute", inset: "0", overflow: "hidden", cursor: "grab" });
      const lbImg = mk("img", {
        position: "absolute", left: "0", top: "0", transformOrigin: "0 0",
        willChange: "transform", display: "block", opacity: "0",
        transition: "opacity .18s ease",
      }, { draggable: false });
      lbStage.appendChild(lbImg);
      lb.appendChild(lbStage);

      const lbState = { img: null, idx: -1, s: 1, x: 0, y: 0, fit: 1, natW: 0, natH: 0 };
      const lbApply = () => {
        lbImg.style.transform = `translate(${lbState.x}px, ${lbState.y}px) scale(${lbState.s})`;
        tx(lbZoomPct, Math.round(lbState.s * 100) + "%");
      };
      function lbFit() {
        const W = lbStage.clientWidth, H = lbStage.clientHeight;
        if (!lbState.natW || !W) return;
        const fit = Math.min(W / lbState.natW, H / lbState.natH, 1);
        lbState.fit = fit;
        lbState.s = fit;
        lbState.x = (W - lbState.natW * fit) / 2;
        lbState.y = (H - lbState.natH * fit) / 2;
        lbApply();
      }
      function lbZoomTo(s2, cx, cy) {  // cx/cy in stage coords, anchor stays put
        s2 = Math.min(8, Math.max(lbState.fit * 0.25, s2));
        lbState.x = cx - (cx - lbState.x) * (s2 / lbState.s);
        lbState.y = cy - (cy - lbState.y) * (s2 / lbState.s);
        lbState.s = s2;
        lbApply();
      }
      const lbZoomCenter = (f) => lbZoomTo(lbState.s * f, lbStage.clientWidth / 2, lbStage.clientHeight / 2);
      lbStage.addEventListener("wheel", (e) => {
        e.preventDefault(); e.stopPropagation();
        const r = lbStage.getBoundingClientRect();
        lbZoomTo(lbState.s * Math.exp(-e.deltaY * 0.002), e.clientX - r.left, e.clientY - r.top);
      }, { passive: false });
      let lbDrag = null;
      lbStage.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        lbDrag = { x0: e.clientX, y0: e.clientY, sx: lbState.x, sy: lbState.y, id: e.pointerId, moved: false, onImg: e.target === lbImg };
        try { lbStage.setPointerCapture(e.pointerId); } catch (err) {}
        lbStage.style.cursor = "grabbing";
      });
      lbStage.addEventListener("pointermove", (e) => {
        if (!lbDrag) return;
        const dx = e.clientX - lbDrag.x0, dy = e.clientY - lbDrag.y0;
        if (!lbDrag.moved && Math.hypot(dx, dy) < 4) return;
        lbDrag.moved = true;
        lbState.x = lbDrag.sx + dx;
        lbState.y = lbDrag.sy + dy;
        lbApply();
      });
      const lbDragEnd = (e) => {
        if (!lbDrag) return;
        const { moved, onImg, id } = lbDrag;
        lbDrag = null;
        try { lbStage.releasePointerCapture(id); } catch (err) {}
        lbStage.style.cursor = "grab";
        if (!moved && !onImg) closeLightbox();   // plain click on the backdrop
      };
      lbStage.addEventListener("pointerup", lbDragEnd);
      lbStage.addEventListener("pointercancel", lbDragEnd);
      lbStage.addEventListener("dblclick", (e) => {
        e.preventDefault(); e.stopPropagation();
        const r = lbStage.getBoundingClientRect();
        if (lbState.s > lbState.fit * 1.01) lbFit();
        else lbZoomTo(lbState.fit < 0.99 ? 1 : lbState.fit * 2, e.clientX - r.left, e.clientY - r.top);
      });
      lbImg.addEventListener("contextmenu", (e) => {
        e.preventDefault(); e.stopPropagation();
        if (lbState.img) openCtxMenu(e, lbState.img);
      });

      // top bar: filename · counter · zoom controls · Finder · close
      const lbBar = mk("div", {
        position: "absolute", top: "0", left: "0", right: "0", zIndex: "3",
        display: "flex", alignItems: "center", gap: "8px", padding: "12px 16px 22px",
        background: "linear-gradient(rgba(0,0,0,.72), transparent)", pointerEvents: "none",
      });
      const lbName = mk("div", {
        fontSize: "12px", fontWeight: "600", color: C.text, minWidth: "0",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      });
      const lbCount = mk("div", {
        fontSize: "11px", color: C.muted, flexShrink: "0",
        fontVariantNumeric: "tabular-nums",
      });
      function lbBtn(label, title, onClick, wide) {
        const b = mk("button", {
          background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.14)",
          borderRadius: "6px", padding: wide ? "5px 11px" : "5px 9px", cursor: "pointer",
          color: C.text, fontSize: "11px", fontWeight: "600", outline: "none",
          transition: "border-color .15s, background .15s", flexShrink: "0",
          pointerEvents: "auto",
        }, { title });
        tx(b, label);
        b.onmouseenter = () => { b.style.borderColor = "rgba(255,255,255,.4)"; b.style.background = "rgba(255,255,255,.1)"; };
        b.onmouseleave = () => { b.style.borderColor = "rgba(255,255,255,.14)"; b.style.background = "rgba(255,255,255,.06)"; };
        b.onclick = (e) => { e.stopPropagation(); onClick(); };
        return b;
      }
      const lbZoomPct = mk("div", {
        fontSize: "11px", color: C.muted, minWidth: "38px", textAlign: "center",
        fontVariantNumeric: "tabular-nums", flexShrink: "0", cursor: "pointer",
        pointerEvents: "auto",
      }, { title: "Reset zoom to fit" });
      lbZoomPct.onclick = () => lbFit();
      lbBar.append(
        lbName, lbCount, mk("div", { flex: "1" }),
        lbBtn("−", "Zoom out", () => lbZoomCenter(0.8)),
        lbZoomPct,
        lbBtn("+", "Zoom in", () => lbZoomCenter(1.25)),
        lbBtn("Fit", "Fit to screen (0)", () => lbFit(), true),
        lbBtn("1:1", "Actual pixels (1)", () => { lbZoomTo(1, lbStage.clientWidth / 2, lbStage.clientHeight / 2); }, true),
        lbBtn("⌘ Finder", "Reveal this file in Finder", () => { if (lbState.img) revealInFinder(lbState.img); }, true),
        lbBtn("✕", "Close (Esc)", () => closeLightbox()),
      );
      lb.appendChild(lbBar);

      // prev / next arrows (batch runs only)
      function lbArrow(glyph, dir, side) {
        const b = mk("button", {
          position: "absolute", [side]: "16px", top: "50%", transform: "translateY(-50%)",
          width: "40px", height: "40px", borderRadius: "50%", zIndex: "3",
          background: "rgba(0,0,0,.5)", border: "1px solid rgba(255,255,255,.14)",
          color: C.text, fontSize: "20px", lineHeight: "1", cursor: "pointer",
          display: "none", alignItems: "center", justifyContent: "center",
          outline: "none", transition: "border-color .15s, background .15s",
        }, { title: dir < 0 ? "Previous (←)" : "Next (→)" });
        tx(b, glyph);
        b.onmouseenter = () => { b.style.borderColor = LIME; b.style.background = "rgba(0,0,0,.75)"; };
        b.onmouseleave = () => { b.style.borderColor = "rgba(255,255,255,.14)"; b.style.background = "rgba(0,0,0,.5)"; };
        b.onclick = (e) => { e.stopPropagation(); lbNav(dir); };
        lb.appendChild(b);
        return b;
      }
      const lbPrev = lbArrow("‹", -1, "left");
      const lbNext = lbArrow("›", 1, "right");

      const lbHint = mk("div", {
        position: "absolute", bottom: "0", left: "0", right: "0", zIndex: "3",
        textAlign: "center", padding: "22px 16px 12px", pointerEvents: "none",
        fontSize: "10px", color: "rgba(255,255,255,.4)",
        background: "linear-gradient(transparent, rgba(0,0,0,.6))",
      });
      tx(lbHint, "Scroll to zoom · Drag to pan · Double-click for 100% · Right-click for options");
      lb.appendChild(lbHint);

      function lbSyncGallery() {
        // Called when the strip regrows mid-run so an open lightbox keeps an
        // accurate counter / nav state.
        if (lb.style.display === "none") return;
        lbState.idx = _gallery.findIndex(g => imgEq(g, lbState.img));
        tx(lbCount, _gallery.length > 1 && lbState.idx >= 0 ? `${lbState.idx + 1} / ${_gallery.length}` : "");
        lbPrev.style.display = lbNext.style.display = _gallery.length > 1 ? "flex" : "none";
      }
      function lbLoad(img, idx) {
        lbState.img = img;
        lbState.idx = idx;
        tx(lbName, (img.filename || "") + (img.type === "temp" ? " · unsaved" : ""));
        tx(lbCount, _gallery.length > 1 && idx >= 0 ? `${idx + 1} / ${_gallery.length}` : "");
        lbPrev.style.display = lbNext.style.display = _gallery.length > 1 ? "flex" : "none";
        lbImg.style.opacity = "0";
        lbImg.onload = () => {
          lbState.natW = lbImg.naturalWidth;
          lbState.natH = lbImg.naturalHeight;
          lbImg.style.width = lbState.natW + "px";
          lbImg.style.height = lbState.natH + "px";
          lbFit();
          lbImg.style.opacity = "1";
        };
        lbImg.src = viewUrl(img);
      }
      function lbNav(dir) {
        if (_gallery.length < 2) return;
        let i = lbState.idx < 0 ? 0 : (lbState.idx + dir + _gallery.length) % _gallery.length;
        lbLoad(_gallery[i], i);
        showImage(_gallery[i]);   // keep the main preview + thumb ring in sync
      }
      function lbKey(e) {
        e.stopPropagation();
        if (e.key === "Escape") closeLightbox();
        else if (e.key === "ArrowLeft") lbNav(-1);
        else if (e.key === "ArrowRight") lbNav(1);
        else if (e.key === "+" || e.key === "=") lbZoomCenter(1.25);
        else if (e.key === "-") lbZoomCenter(0.8);
        else if (e.key === "0") lbFit();
        else if (e.key === "1") lbZoomTo(1, lbStage.clientWidth / 2, lbStage.clientHeight / 2);
      }
      const lbResize = () => { if (lb.style.display !== "none") lbFit(); };
      function openLightbox(img) {
        lb.style.display = "block";
        lb.style.animation = "k2-lb-in .2s ease-out";
        document.addEventListener("keydown", lbKey, true);
        window.addEventListener("resize", lbResize);
        lbLoad(img, _gallery.findIndex(g => imgEq(g, img)));
      }
      function closeLightbox() {
        lb.style.display = "none";
        lbImg.removeAttribute("src");
        lbState.img = null;
        document.removeEventListener("keydown", lbKey, true);
        window.removeEventListener("resize", lbResize);
        closeCtx();
      }
      function showPreviewBlob(blob) {
        try {
          const url = URL.createObjectURL(blob);
          const old = previewImg.dataset.blobUrl;
          previewImg.src = url;
          previewImg.dataset.blobUrl = url;
          previewImg.style.display = "";
          previewEmpty.style.display = "none";
          cmpWrap.style.display = "none";   // live preview trumps compare
          if (old) URL.revokeObjectURL(old);
        } catch (e) {}
      }
      function pushOutput(img) {
        const nodeId = S._node?.id ?? self.id;   // cache is uid-keyed now
        api.fetchApi("/krea2_onenode/set_output", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ node_id: String(nodeId), ...img }),
        }).catch(() => {});
      }

      // ── template patch + submit ────────────────────────────────────────────
      const _templates = {};   // "quality" (T2I/Scene) | "upscale" | "edit"
      async function getTemplate(which = "quality") {
        if (!_templates[which]) {
          const r = await api.fetchApi(`/krea2_onenode/workflow_${which}`);
          if (!r.ok) throw new Error(`template fetch failed (${r.status})`);
          _templates[which] = await r.json();
        }
        return _templates[which];
      }

      // Default opts reproduce the single-run T2I behavior exactly; the Scene
      // tab overrides prompt/batch/seed per queued row and forces SaveImage.
      // Both use the quality template ("K2Q:" node ids).
      function buildPrompt(tpl, o = {}) {
        const { promptText = S.prompt, batch = S.batch, seed = null, forceSave = false } = o;
        const p = JSON.parse(JSON.stringify(tpl));
        const d = dims();
        const id = (k) => "K2Q:" + k;

        p[id("unet")].inputs.unet_name = S.modelUnet;
        p[id("clip")].inputs.clip_name = S.modelClip;
        p[id("vae")].inputs.vae_name = S.modelVae;

        p[id("pos")].inputs.text = promptText || "";
        p[id("latent")].inputs.width = d.w;
        p[id("latent")].inputs.height = d.h;
        p[id("latent")].inputs.batch_size = batch;

        if (seed != null) {
          p[id("seed")].inputs.seed = seed;
        } else {
          if (S.randomizeSeed) S.seed = Math.floor(Math.random() * 1e15);
          S.lastSeed = S.seed;
          seedIn.value = S.seed;
          syncSeedUI();
          p[id("seed")].inputs.seed = S.seed;
        }

        // LoRA stack → Power Lora Loader dynamic inputs
        let li = 1;
        for (const row of S.loras) {
          if (!row.name) continue;
          p[id("lora")].inputs[`lora_${li}`] = {
            on: !!row.on, lora: row.name, strength: row.strength, strengthTwo: null,
          };
          li++;
        }

        {
          // ClownsharK: pass 2 refines the pass-1 latent at the same
          // resolution; its step count follows the source workflow's
          // ceil(denoise × 8) expression. Krea2T-Enhancer keeps its template
          // default (enabled, strength 1.5).
          p["K2Q:sampler1"].inputs.steps = S.q.p1Steps;
          p["K2Q:sampler1"].inputs.cfg = S.q.p1Cfg;
          p["K2Q:sampler1"].inputs.sampler_name = S.q.p1Sampler;
          p["K2Q:sampler1"].inputs.scheduler = S.q.p1Sched;
          p["K2Q:sampler2"].inputs.denoise = S.q.denoise;
          p["K2Q:sampler2"].inputs.eta = S.q.eta;
          p["K2Q:sampler2"].inputs.cfg = S.q.p2Cfg;
          p["K2Q:sampler2"].inputs.sampler_name = S.q.p2Sampler;
          p["K2Q:sampler2"].inputs.scheduler = S.q.p2Sched;
          p["K2Q:sampler2"].inputs.steps = Math.max(1, Math.ceil(S.q.denoise * 8));
          // Post toggles: an off node is deleted and the image chain rewired
          // around it (decode → [grain] → [sharpen] → save).
          const grainOn = S.q.grainOn !== false;
          const sharpOn = S.q.sharpenOn !== false;
          if (grainOn) p["K2Q:grain"].inputs.grain_power = S.q.grain;
          else delete p["K2Q:grain"];
          if (sharpOn) {
            p["K2Q:sharp"].inputs.iterations = S.q.sharpen;
            p["K2Q:sharp"].inputs.images = grainOn ? ["K2Q:grain", 0] : ["K2Q:decode", 0];
          } else {
            delete p["K2Q:sharp"];
          }
          p["K2Q:save"].inputs.images =
            sharpOn ? ["K2Q:sharp", 0] : grainOn ? ["K2Q:grain", 0] : ["K2Q:decode", 0];
        }

        // auto-save off → PreviewImage (temp) instead of SaveImage
        // (scene runs pass forceSave — unattended results must land on disk)
        if (!S.autoSave && !forceSave) {
          p[id("save")] = {
            inputs: { images: p[id("save")].inputs.images },
            class_type: "PreviewImage",
            _meta: { title: "Preview (unsaved)" },
          };
        }
        return p;
      }

      // ── T2I generate = a rolling queue. The first click starts a queue run
      // (S._batchRun) and the button becomes "Queue (n)" — NOT disabled: every
      // further click snapshots the CURRENT prompt/settings via buildPrompt
      // and appends more jobs to the same run (batch ×N appends N). All jobs
      // land in ComfyUI's server-side queue; results accumulate in the thumb
      // strip like a scene run. The run ends when every queued job resolved.
      function syncQueueUI() {
        const br = S._batchRun;
        if (!br) return;
        const pending = Math.max(0, br.total - br.done);
        tx(genBtn, `Queue (${pending})`);
        genBtn.appendChild(genSweep);
      }
      // Start (or join) the rolling batch-run and (re-)register the active
      // handlers — jobs already running keep emitting events while new ones
      // are queued, and each click refreshes the progress plan snapshot for
      // the latest settings. Shared by T2I generates, Scene runs and upscales.
      function startBatchRun() {
        const first = !S._batchRun;
        if (first) {
          S._batchRun = { jobs: new Map(), total: 0, done: 0, images: [] };
          S._generating = true;
          timerStart();
          progShow();
          syncStop(true);
          setStatus("Queued…");
        }
        window.__krea2_active = {
          S, showImage, showBatch, galAdd, showPreviewBlob, setStatus, setStage,
          syncQueueUI, registerCompare, prog: currentProgPlan(), done: finishGenerate,
        };
        return first;
      }
      async function doGenerate() {
        if (S._submitting || S._scene) return;
        if (!S.prompt.trim()) { setStatus("Enter a prompt first.", C.err); return; }
        S._submitting = true;
        try {
          const tpl = await getTemplate("quality");
          const first = startBatchRun();
          // Batch ×N queues N single-image jobs (seed, seed+1, …) — batched
          // latents degrade quality on MPS, and per-image jobs surface
          // results as they finish.
          const base = S.randomizeSeed ? Math.floor(Math.random() * 1e15) : S.seed;
          S.lastSeed = base;
          if (S.randomizeSeed) { S.seed = base; seedIn.value = base; }
          syncSeedUI();
          persist();
          const br = S._batchRun;
          let failed = null;
          for (let i = 0; i < S.batch; i++) {
            const prompt = buildPrompt(tpl, { batch: 1, seed: base + i });
            const resp = await api.fetchApi("/prompt", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ prompt, client_id: api.clientId, extra_data: { enable_previews: true } }),
            });
            const result = await resp.json();
            if (!resp.ok || result.error) {
              const msg = result?.error?.message || result?.error || `HTTP ${resp.status}`;
              const nodeErrs = result?.node_errors && Object.values(result.node_errors)
                .flatMap(e => (e.errors || []).map(x => x.message)).join("; ");
              // A /prompt rejection is a settings/template problem — the rest
              // of this click's jobs would fail identically. Stop this click;
              // anything already queued keeps running and stays tracked.
              failed = { msg: nodeErrs || msg };
              break;
            }
            br.jobs.set(result.prompt_id, { seq: br.total + 1 });
            br.total++;
          }
          if (first && !br.total) {
            S._batchRun = null;
            throw new Error(failed ? failed.msg : "failed to queue");
          }
          syncQueueUI();
          const pending = br.total - br.done;
          setStatus(failed
            ? `Queue error: ${failed.msg}`
            : pending > 1 ? `${pending} in queue` : "Running…",
            failed ? C.warn : C.text);
        } catch (e) {
          finishGenerate();
          setStatus(`Error: ${e.message}`, C.err);
          console.error("[Krea2OneNode] submit failed:", e);
        } finally {
          S._submitting = false;
        }
      }
      function finishGenerate() {
        S._generating = false;
        timerStop();
        progIdle();
        tx(genBtn, S.tab === "scene" ? "Run Batch" : S.tab === "upscale" ? "Upscale" : S.tab === "edit" ? "Edit" : "Generate");
        genBtn.appendChild(genSweep);
        genBtn.style.background = LIME;
        genBtn.style.color = "#111";
        syncStop(false);
        syncSceneLock();
      }

      // ── upscale submits (viewer chip + folder batch) ───────────────────────
      // "subfolder/name [type]" — LoadImage's validator accepts annotated
      // paths, so temp/output results feed straight back in without uploads.
      const annotatedName = (img) => {
        const base = (img.subfolder ? img.subfolder + "/" : "") + img.filename;
        const t = img.type || "output";
        return t === "input" ? base : `${base} [${t}]`;
      };
      // Current pill selection as a job-scale descriptor (snapshotted per job
      // so a mid-run pill change can't retarget queued work).
      const upScaleSel = () => (S.up.engine === "local"
        ? { engine: "local", factor: S.up.local.factor }
        : { engine: "cloud", resolution: S.up.resolution });
      // auto-save off → PreviewImage (temp). Folder-batch jobs force SaveImage
      // (unattended results must land on disk for the copy-back); viewer
      // upscales respect auto-save.
      const upSaveNode = (p, id, force) => {
        if (S.autoSave || force) return;
        p[id] = {
          inputs: { images: p[id].inputs.images },
          class_type: "PreviewImage",
          _meta: { title: "Preview (unsaved)" },
        };
      };
      function buildUpscalePrompt(tpl, o) {
        const p = JSON.parse(JSON.stringify(tpl));
        p["K2U:load"].inputs.image = o.imageName;
        const u = p["K2U:up"].inputs;   // template pins upscale_mode "target"
        u.target_resolution = o.scale.resolution;
        u.noise_scale = S.up.noise;
        upSaveNode(p, "K2U:save", o.forceSave);
        return p;
      }
      // Local SeedVR2: the scale factor drives ResizeImageMaskNode and the
      // model restores detail at the new size. Tile size is the VRAM dial;
      // overlap follows tile/4, matching ComfyUI's own clamp.
      function buildUpscaleLocalPrompt(tpl, o) {
        const p = JSON.parse(JSON.stringify(tpl));
        p["K2UL:img"].inputs.image = o.imageName;
        p["K2UL:unet"].inputs.unet_name = S.up.local.model;
        p["K2UL:vae"].inputs.vae_name = S.up.local.vae;
        p["K2UL:resize"].inputs["resize_type.multiplier"] =
          Math.max(1, Math.min(8, o.scale.factor || 2));
        const t = S.up.local.tile;
        for (const id of ["K2UL:enc", "K2UL:dec"]) {
          p[id].inputs.tile_size = t;
          p[id].inputs.overlap = t / 4;
        }
        const k = p["K2UL:sampler"].inputs;
        k.seed = o.seed != null ? o.seed : Math.floor(Math.random() * 1e15);
        k.steps = S.up.local.steps;
        k.cfg = S.up.local.cfg;
        k.sampler_name = S.up.local.sampler;
        k.scheduler = S.up.local.scheduler;
        upSaveNode(p, "K2UL:save", o.forceSave);
        return p;
      }
      // Queue upscale jobs onto the shared rolling run. Callers own the
      // S._submitting guard. jobs: [{imageName, scale, before, copyTo?, forceSave?}]
      async function submitUpscaleJobs(jobs) {
        // The local engine loads its own weights — without them the graph fails
        // validation server-side, so say it here instead.
        if (jobs.some(j => j.scale?.engine === "local") && !(S.up.local.model && S.up.local.vae)) {
          setStatus("Pick a SeedVR2 model and VAE for the local engine (see ✦ Help for downloads).", C.err);
          return;
        }
        try {
          // Each job carries its own engine (snapshotted at click time), so a
          // mid-run engine switch can't retarget queued work. Both templates
          // are fetched only if the batch actually mixes engines.
          const tpls = {};
          for (const j of jobs) {
            const eng = j.scale?.engine === "local" ? "upscale_local" : "upscale";
            if (!tpls[eng]) tpls[eng] = await getTemplate(eng);
          }
          const first = startBatchRun();
          const br = S._batchRun;
          let failed = null;
          for (const j of jobs) {
            const local = j.scale?.engine === "local";
            const prompt = local
              ? buildUpscaleLocalPrompt(tpls.upscale_local, j)
              : buildUpscalePrompt(tpls.upscale, j);
            const resp = await api.fetchApi("/prompt", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ prompt, client_id: api.clientId }),
            });
            const result = await resp.json();
            if (!resp.ok || result.error) {
              const msg = result?.error?.message || result?.error || `HTTP ${resp.status}`;
              const nodeErrs = result?.node_errors && Object.values(result.node_errors)
                .flatMap(e => (e.errors || []).map(x => x.message)).join("; ");
              failed = { msg: nodeErrs || msg };
              break;   // rest of this click's jobs would fail identically
            }
            br.jobs.set(result.prompt_id, {
              seq: br.total + 1, up: true, before: j.before || null, copyTo: j.copyTo || null,
            });
            br.total++;
          }
          if (first && !br.total) {
            S._batchRun = null;
            throw new Error(failed ? failed.msg : "failed to queue");
          }
          syncQueueUI();
          const pending = br.total - br.done;
          setStatus(failed
            ? `Queue error: ${failed.msg}`
            : pending > 1 ? `${pending} in queue` : "Upscaling…",
            failed ? C.warn : C.text);
        } catch (e) {
          finishGenerate();
          setStatus(`Error: ${e.message}`, C.err);
          console.error("[Krea2OneNode] upscale submit failed:", e);
        }
      }
      async function doViewerUpscale(img, scale) {
        if (S._submitting) return;
        if (S._scene) { setStatus("Can't upscale during a batch run.", C.err); return; }
        S._submitting = true;
        try {
          await submitUpscaleJobs([{ imageName: annotatedName(img), scale, before: img }]);
        } finally { S._submitting = false; }
      }
      // Stage one source image into ComfyUI's input via the official upload
      // API and return the job fields that identify it.
      async function uploadSource(file) {
        const fd = new FormData();
        fd.append("image", file);
        fd.append("subfolder", "krea2-onenode-src");
        fd.append("overwrite", "true");
        const ur = await api.fetchApi("/upload/image", { method: "POST", body: fd });
        if (!ur.ok) throw new Error(`upload ${ur.status}`);
        const ud = await ur.json();
        const sub = ud.subfolder || "krea2-onenode-src";
        return {
          imageName: (sub ? sub + "/" : "") + ud.name,
          before: { filename: ud.name, subfolder: sub, type: "input" },
        };
      }
      // ── edit submits (EDIT tab) ────────────────────────────────────────────
      // Template patch for K2E:*. The template ships as a superset of both
      // source workflows; the branch the current mode doesn't use is deleted
      // (same pattern as the HQ post-section toggles). Mask and reference are
      // mutually exclusive by UI construction.
      function buildEditPrompt(tpl, o) {
        const p = JSON.parse(JSON.stringify(tpl));
        // Multi-source runs pass the dims of THEIR image; a single edit falls
        // back to the primary source's.
        const d = o.dims || editDims();
        p["K2E:unet"].inputs.unet_name = S.modelUnet;
        p["K2E:clip"].inputs.clip_name = S.modelClip;
        p["K2E:vae"].inputs.vae_name = S.modelVae;
        // The identity-edit LoRA is always in the chain at strength 1.0 — only
        // which file it points at is settable (Settings); user rows stack on top.
        p["K2E:idlora"].inputs.lora_name = S.modelIdLora;
        let li = 1;
        for (const row of S.loras) {
          if (!row.name) continue;
          p["K2E:lora"].inputs[`lora_${li}`] = {
            on: !!row.on, lora: row.name, strength: row.strength, strengthTwo: null,
          };
          li++;
        }
        p["K2E:img"].inputs.image = o.srcName;
        p["K2E:pos"].inputs.prompt = S.prompt || "";
        p["K2E:pos"].inputs.grounding_px = S.edit.groundingPx;
        p["K2E:neg"].inputs.grounding_px = S.edit.groundingPx;
        // Output latent + source/mask resize all get the SAME exact dims so a
        // masked composite aligns pixel-perfect with the resized original.
        p["K2E:latent"].inputs.width = d.w;
        p["K2E:latent"].inputs.height = d.h;
        p["K2E:resize"].inputs["resize_type.width"] = d.w;
        p["K2E:resize"].inputs["resize_type.height"] = d.h;
        const pt = p["K2E:patch"].inputs;
        pt.ref_boost = S.edit.refBoost;
        pt.ref_boost_a = S.edit.refBoostA;
        pt.fit_mode = S.edit.fitMode;
        const k = p["K2E:sampler"].inputs;
        k.seed = o.seed;
        k.steps = S.edit.steps;
        k.cfg = S.edit.cfg;
        k.sampler_name = S.edit.sampler;
        k.scheduler = S.edit.scheduler;
        k.denoise = S.edit.denoise;
        // Mask mode: the painted region feeds ref_boost_mask ONLY — the model
        // does the masked edit internally and the RAW RENDER is the result
        // (matches the source workflow, whose Save Image / Image Comparer sit
        // on the decode; its "Maskin Image" hard composite is deliberately
        // not reproduced — pixel-pasting gave unblended, misaligned seams).
        if (S.edit.mode === "mask") {
          p["K2E:mask"].inputs.image = o.maskName;
          p["K2E:mresize"].inputs["resize_type.width"] = d.w;
          p["K2E:mresize"].inputs["resize_type.height"] = d.h;
        } else {
          delete p["K2E:mask"];
          delete p["K2E:mresize"];
          delete pt.ref_boost_mask;
        }
        if (S.edit.mode === "ref") {
          p["K2E:imgb"].inputs.image = o.refName;
        } else {
          for (const kk of ["imgb", "resizeb", "encb"]) delete p["K2E:" + kk];
          delete pt.source_latent_b;
          delete pt.source_image_b;
          delete p["K2E:pos"].inputs.image_b;
          delete p["K2E:neg"].inputs.image_b;
        }
        if (!S.autoSave && !o.forceSave) {
          p["K2E:save"] = {
            inputs: { images: p["K2E:save"].inputs.images },
            class_type: "PreviewImage",
            _meta: { title: "Preview (unsaved)" },
          };
        }
        return p;
      }
      async function doRunEdit() {
        if (S._submitting) return;
        if (S._scene) { setStatus("Can't edit during a batch run.", C.err); return; }
        const src = S._editSrc;
        if (!src) { setStatus("Pick a source image first.", C.err); return; }
        if (!S.prompt.trim()) { setStatus("Enter an edit instruction first.", C.err); return; }
        if (S.edit.mode === "mask" && !S._editMask) { setStatus("Paint a mask first (or turn Mask off).", C.err); return; }
        if (S.edit.mode === "ref" && !S._editRef) { setStatus("Pick a person image first (or turn Reference off).", C.err); return; }
        const d = editDims();
        if (!d) { setStatus("Couldn't read the source image size.", C.err); return; }
        S._submitting = true;
        try {
          // Sources for this click: the primary plus any extra images dropped
          // with it. Mask mode stays single — the mask only fits image one.
          const sources = [src, ...(S.edit.mode === "mask" ? [] : (S._editExtra || []))];
          // Stage inputs once per click — every batch job reuses them.
          // (File sources may already be staged by the native mask editor.)
          const staged = [];
          for (const s of sources) {
            if (s.kind === "file") {
              if (!s.uploadedName) {
                setStatus(sources.length > 1
                  ? `Uploading ${staged.length + 1}/${sources.length}…`
                  : "Uploading source…");
                const up = await uploadSource(s.file);
                s.uploadedName = up.imageName;
                s.uploadedBefore = up.before;
              }
              staged.push({ name: s.uploadedName, before: s.uploadedBefore, dims: editDimsFor(s) });
            } else {
              staged.push({ name: annotatedName(s.img), before: s.img, dims: editDimsFor(s) });
            }
          }
          let maskName = null;
          if (S.edit.mode === "mask") {
            if (S._editMask.name) {
              maskName = S._editMask.name;   // native editor result, already server-side
            } else {
              setStatus("Uploading mask…");
              const mf = new File([S._editMask.blob], `k2e_mask_${Date.now()}.png`, { type: "image/png" });
              ({ imageName: maskName } = await uploadSource(mf));
            }
          }
          let refName = null, refBefore = null;
          if (S.edit.mode === "ref") {
            const ref = S._editRef;
            if (ref.kind === "file") {
              setStatus("Uploading person image…");
              const up = await uploadSource(ref.file);
              refName = up.imageName;
              refBefore = up.before;
            } else {
              refName = annotatedName(ref.img);
              refBefore = ref.img;
            }
          }
          const tpl = await getTemplate("edit");
          const first = startBatchRun();
          const base = S.randomizeSeed ? Math.floor(Math.random() * 1e15) : S.seed;
          S.lastSeed = base;
          if (S.randomizeSeed) { S.seed = base; seedIn.value = base; }
          syncSeedUI();
          persist();
          const br = S._batchRun;
          let failed = null;
          // One job per image per batch step: 3 images × ×2 = 6 jobs. Each
          // image keeps its own seed run so the batch stays reproducible.
          outer:
          for (const st of staged) {
            for (let i = 0; i < S.batch; i++) {
              const prompt = buildEditPrompt(tpl, {
                seed: base + i, srcName: st.name, maskName, refName, dims: st.dims,
              });
              const resp = await api.fetchApi("/prompt", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ prompt, client_id: api.clientId, extra_data: { enable_previews: true } }),
              });
              const result = await resp.json();
              if (!resp.ok || result.error) {
                const msg = result?.error?.message || result?.error || `HTTP ${resp.status}`;
                const nodeErrs = result?.node_errors && Object.values(result.node_errors)
                  .flatMap(e => (e.errors || []).map(x => x.message)).join("; ");
                failed = { msg: nodeErrs || msg };
                break outer;   // rest of this click's jobs would fail identically
              }
              // origin = everything needed to rebuild this job's inputs in the
              // UI ("Use as… → original input"). Server-side names only, so a
              // local File source is restorable after it's been uploaded.
              br.jobs.set(result.prompt_id, {
                seq: br.total + 1, edit: true, before: st.before,
                origin: { src: st.before, ref: refBefore, mode: S.edit.mode, mask: maskName },
              });
              br.total++;
            }
          }
          if (first && !br.total) {
            S._batchRun = null;
            throw new Error(failed ? failed.msg : "failed to queue");
          }
          syncQueueUI();
          const pending = br.total - br.done;
          setStatus(failed
            ? `Queue error: ${failed.msg}`
            : pending > 1 ? `${pending} in queue` : "Editing…",
            failed ? C.warn : C.text);
        } catch (e) {
          finishGenerate();
          setStatus(`Error: ${e.message}`, C.err);
          console.error("[Krea2OneNode] edit submit failed:", e);
        } finally {
          S._submitting = false;
        }
      }

      async function doRunUpscaleBatch() {
        if (S._submitting) return;
        if (S._scene) { setStatus("Can't upscale during a batch run.", C.err); return; }
        const drop = S._upDrop;
        if (!drop?.length && !S.up.folder) { setStatus("Drop images or choose a folder first.", C.err); return; }
        S._submitting = true;
        try {
          const jobs = [];
          let skipped = 0;
          if (drop?.length) {
            // Dropped/browsed files — the browser hands us the bytes directly;
            // no on-disk path, so no copy-back for these.
            setStatus(`Uploading ${drop.length} image${drop.length > 1 ? "s" : ""}…`);
            for (const f of drop) {
              try {
                jobs.push({ ...(await uploadSource(f)), scale: upScaleSel(), forceSave: true });
              } catch (e) { skipped++; }
            }
          } else {
            await refreshUpFolder();
            const files = S._upFiles;
            if (files == null) { setStatus("Folder not authorized — choose it again.", C.err); return; }
            if (!files.length) { setStatus("No images in the folder.", C.err); return; }
            // Backend only hands us the bytes — no direct folder writes here.
            setStatus(`Uploading ${files.length} image${files.length > 1 ? "s" : ""}…`);
            for (const name of files) {
              try {
                const r = await api.fetchApi(
                  `/krea2_onenode/read_file?path=${encodeURIComponent(S.up.folder)}&name=${encodeURIComponent(name)}`);
                if (!r.ok) throw new Error(`read ${r.status}`);
                const blob = await r.blob();
                jobs.push({
                  ...(await uploadSource(new File([blob], name, { type: blob.type || "image/png" }))),
                  scale: upScaleSel(),
                  copyTo: { dest_dir: S.up.folder, dest_name: "up_" + name },
                  forceSave: true,
                });
              } catch (e) { skipped++; }
            }
          }
          if (!jobs.length) { setStatus("Every file failed to upload.", C.err); return; }
          if (skipped) setStatus(`${skipped} file${skipped > 1 ? "s" : ""} failed to upload — upscaling ${jobs.length}.`, C.warn);
          await submitUpscaleJobs(jobs);
        } finally { S._submitting = false; }
      }

      // ── batch run: queue every line's prompt upfront (server-side queue does
      // the sequencing, so the run survives the frontend sleeping overnight) ──
      async function doRunScene() {
        if (S._generating) return;
        const prompts = sceneParse();
        if (!prompts.length) { setStatus("Add at least one prompt (one per line).", C.err); return; }
        S._generating = true;
        timerStart();
        progShow();
        tx(genBtn, "Queueing…");
        genBtn.appendChild(genSweep);
        genBtn.style.background = C.bg3;
        genBtn.style.color = C.muted;
        syncStop(true);
        setStatus(`Queueing ${prompts.length} prompt${prompts.length > 1 ? "s" : ""}…`);
        persist();
        try {
          const tpl = await getTemplate("quality");
          _sceneDots.forEach(d => sceneDotSet(d, "idle"));
          // One single-image job per line (batched latents degrade quality on
          // MPS, and per-image jobs surface results as they finish).
          // rows: Map(line idx -> {total, done, error}) drives the line dots.
          S._scene = { jobs: new Map(), total: 0, done: 0, rows: new Map() };
          syncSceneLock();
          // Register before the first POST — the first job can start emitting
          // events while later lines are still being queued.
          window.__krea2_active = { S, showImage, showBatch, galAdd, showPreviewBlob, setStatus, setStage, prog: currentProgPlan(), done: finishGenerate, sceneRowUpdate };
          // seed+i per line, so duplicate lines don't collapse into one cached
          // result server-side.
          const baseSeed = S.randomizeSeed ? Math.floor(Math.random() * 1e15) : S.seed;
          let queued = 0, failed = null;
          for (let i = 0; i < prompts.length; i++) {
            const prompt = buildPrompt(tpl, { promptText: prompts[i], batch: 1, seed: baseSeed + i, forceSave: true });
            const resp = await api.fetchApi("/prompt", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ prompt, client_id: api.clientId, extra_data: { enable_previews: true } }),
            });
            const result = await resp.json();
            if (!resp.ok || result.error) {
              const msg = result?.error?.message || result?.error || `HTTP ${resp.status}`;
              const nodeErrs = result?.node_errors && Object.values(result.node_errors)
                .flatMap(e => (e.errors || []).map(x => x.message)).join("; ");
              sceneRowUpdate(i, "error");
              failed = { line: i + 1, msg: nodeErrs || msg };
              // A /prompt rejection is almost always a shared settings/template
              // problem — the remaining jobs would fail identically. Abort;
              // already-queued jobs keep running and stay tracked.
              break;
            }
            S._scene.jobs.set(result.prompt_id, { idx: i, seq: ++queued, status: "queued" });
            S._scene.rows.set(i, { total: 1, done: 0, error: false });
            sceneRowUpdate(i, "queued");
            // Yield every few posts so a 100-line queue doesn't freeze the UI.
            if (i % 10 === 9) await new Promise(r => setTimeout(r, 0));
          }
          if (queued) {
            S.lastSeed = baseSeed;
            if (S.randomizeSeed) { S.seed = baseSeed; seedIn.value = baseSeed; }
            syncSeedUI();
            persist();
          }
          if (!S._scene.jobs.size) {
            S._scene = null;
            finishGenerate();
            setStatus(failed ? `Batch failed to queue (line ${failed.line}): ${failed.msg}` : "Batch failed to queue.", C.err);
            return;
          }
          S._scene.total = S._scene.jobs.size;
          const images = S._scene.total;
          tx(genBtn, "Running batch…");
          genBtn.appendChild(genSweep);
          setStatus(failed
            ? `Batch: ${images} queued, line ${failed.line} failed: ${failed.msg}`
            : `Batch queued — ${images} prompt${images > 1 ? "s" : ""} · ${fmtEst(images * PER_IMAGE_MIN)}`,
            failed ? C.warn : C.muted);
        } catch (e) {
          S._scene = null;
          finishGenerate();
          setStatus(`Error: ${e.message}`, C.err);
          console.error("[Krea2OneNode] batch submit failed:", e);
        }
      }

      function doClearResult() {
        if (S._generating) { setStatus("Can't clear while generating.", C.err); return; }
        S.lastImage = null;
        persist();
        const old = previewImg.dataset.blobUrl;
        if (old) { URL.revokeObjectURL(old); delete previewImg.dataset.blobUrl; }
        previewImg.removeAttribute("src");
        previewImg.style.display = "none";
        previewEmpty.style.display = "";
        saveChip.style.display = "none";
        clearChip.style.display = "none";
        upChip.style.display = "none";
        useAsChip.style.display = "none";
        cmpChip.style.display = "none";
        cmpWrap.style.display = "none";
        S._cmp.clear();
        S._pfx.clear();
        S._orig.clear();
        S._cmpOn = false;
        thumbScroller.replaceChildren();
        thumbStrip.style.display = "none";
        _gallery = [];
        closeLightbox();
        pushOutput({});  // no filename → backend drops the stored replay image
        setStatus("Result cleared.");
      }

      async function doSaveTemp() {
        const img = S.lastImage;
        if (!img || img.type !== "temp") { setStatus("Nothing unsaved to save."); return; }
        const pair = S._cmp.get(cmpKey(img));   // upscale saves as up_*, edits as edit_*
        const pfx = S._pfx.get(cmpKey(img));
        try {
          const r = await api.fetchApi("/krea2_onenode/save_temp", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              filename: img.filename, subfolder: img.subfolder || "",
              ...(pair ? { prefix: pfx || "up" } : {}),
            }),
          });
          const d = await r.json();
          if (d.ok) {
            S.lastImage = { filename: d.filename, subfolder: d.subfolder, type: "output" };
            if (pair) {  // keep compare + the recorded inputs after the identity change
              S._cmp.set(cmpKey(S.lastImage), pair);
              if (pfx) S._pfx.set(cmpKey(S.lastImage), pfx);
              const orig = S._orig.get(cmpKey(img));
              if (orig) S._orig.set(cmpKey(S.lastImage), orig);
            }
            saveChip.style.display = "none";
            setStatus(`Saved as ${d.filename}`, C.ok);
          } else setStatus(`Save failed: ${d.error}`, C.err);
        } catch (e) { setStatus(`Save failed: ${e.message}`, C.err); }
      }

      syncSize();
      renderScenePreview();
      updateEstimate();
      syncTab();

      // Restore the last result into the preview after a rebuild (page reload,
      // workflow switch that didn't hit the cache) — the image is on disk.
      if (S.lastImage?.filename) {
        previewImg.src = viewUrl(S.lastImage);
        previewImg.style.display = "";
        previewEmpty.style.display = "none";
        saveChip.style.display = S.lastImage.type === "temp" ? "" : "none";
        clearChip.style.display = "";
        upChip.style.display = "";
        useAsChip.style.display = "";
      }

      // ── mount + cache ──────────────────────────────────────────────────────
      S._node = this;   // live node ref (id changes across workflow reloads)
      window.__krea2_nodes[this._k2uid || this._k2Uid()] = { root, S, currentNode: this };
      this._mountUI(root);
    };
  },
});
