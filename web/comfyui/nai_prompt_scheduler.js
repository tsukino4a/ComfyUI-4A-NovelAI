import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ChangeTracker } from "../../scripts/changeTracker.js";
import {
  NAI4A_INTERNAL_INPUT_TYPE,
  createNaiTranslator,
  graphNodes,
  hideNaiInternalWidget,
  nai4aRequestJson,
  withSyncedDomWidth,
} from "./nai_frontend_helpers.js";
import {
  createNaiPromptEditor,
  createNaiPromptHistory,
  installNaiPromptUndoGuard,
} from "./nai_prompt_editor.js";
import {
  applyNaiSamplerRatioHint,
  readNaiSamplerResolution,
  resolveConnectedNaiSampler,
  setupNaiSamplerNode,
} from "./nai_sampler.js";
import {
  NAI_TRACK_INPUT_PREFIX,
  attachNaiSerialBatchHook,
} from "./nai_serial_runner.js";

export const NAI_SCHEDULER_NODE_CLASS = "NAI Prompt Scheduler (4A Prompt Manager)";

const INTERNAL_INPUT_NAMES = new Set(["config_json", "execution_index", "run_id"]);
const INTERNAL_WIDGET_NAMES = new Set(INTERNAL_INPUT_NAMES);
const BASE_SLOTS = new Set(["quality", "character", "action", "scene", "negative"]);
const FIXED_TRACK_NAMES = Object.freeze({
  quality: "质量",
  character: "角色",
  action: "动作",
  scene: "场景",
});
const MODE_ICONS = Object.freeze({
  sequence: '<svg viewBox="0 0 24 24"><path d="M4 7h13l-2.5-2.5M17 7l-2.5 2.5M20 17H7l2.5 2.5M7 17l2.5-2.5"/></svg>',
  random: '<svg viewBox="0 0 24 24"><path d="M4 7h3c4.5 0 5.5 10 10 10h3M17 14l3 3-3 3M4 17h3c1.7 0 2.8-1.4 3.8-3.2M13.2 10.2C14.2 8.4 15.3 7 17 7h3M17 4l3 3-3 3"/></svg>',
});
const COLLAPSE_ICONS = Object.freeze({
  expanded: '<svg viewBox="0 0 24 24"><path d="m7 9 5 5 5-5"/></svg>',
  collapsed: '<svg viewBox="0 0 24 24"><path d="m9 7 5 5-5 5"/></svg>',
});
const BYPASS_ICONS = Object.freeze({
  enabled: '<svg viewBox="0 0 24 24"><path d="M5 7h14M5 12h11M5 17h8"/></svg>',
  bypassed: '<svg viewBox="0 0 24 24"><path d="M5 7h14M5 12h11M5 17h8M4 4l16 16"/></svg>',
});
let generatedId = 0;

function nextId(prefix) {
  generatedId += 1;
  const random = globalThis.crypto?.randomUUID?.();
  return random
    ? `${prefix}-${random}-${generatedId}`
    : `${prefix}-${Date.now()}-${generatedId}`;
}

function uniqueId(raw, prefix, index, seen) {
  const base = String(raw || `${prefix}-${index + 1}`).trim() || `${prefix}-${index + 1}`;
  let candidate = base;
  let suffix = 2;
  while (seen.has(candidate)) candidate = `${base}-${suffix++}`;
  seen.add(candidate);
  return candidate;
}

function normalizedHeight(raw, minimum = 54) {
  const value = Number(raw);
  return Number.isFinite(value)
    ? Math.max(minimum, Math.min(1200, Math.round(value)))
    : null;
}

function normalizedMode(raw) {
  return raw === "random" || raw === "shuffle" ? raw : "sequence";
}

function defaultTrack(id, name) {
  return {
    id,
    name,
    enabled: true,
    text: "",
    mode: "sequence",
    collapsed: false,
    ui_height: null,
  };
}

function defaultCharacterName(index = 0) {
  return `角色 ${index + 1}`;
}

function localizeCharacterName(name, index, t) {
  return t(String(name || "").trim() || defaultCharacterName(index));
}

function storeCharacterName(name, index) {
  const raw = String(name || "").trim();
  const match = /^(?:角色|Char|Character)\s+(\d+)$/i.exec(raw);
  if (match) return `角色 ${match[1]}`;
  return raw || defaultCharacterName(index);
}

function defaultCharacter(index = 0) {
  return {
    id: nextId("char"),
    name: defaultCharacterName(index),
    enabled: true,
    collapsed: false,
    positive: "",
    negative: "",
    mode: "sequence",
    use_position: false,
    x: 0.5,
    y: 0.5,
    use_order: true,
    prompt_tab: "positive",
    prompt_ui_height: null,
  };
}

export function defaultNaiSchedulerConfig() {
  return {
    start_index: 0,
    task_count: 1,
    negative: "",
    quality_prompt_tab: "positive",
    use_coords: false,
    positions_initialized: false,
    tracks: [
      defaultTrack("quality", "质量"),
      defaultTrack("character", "角色"),
      defaultTrack("action", "动作"),
      defaultTrack("scene", "场景"),
    ],
    characters: [],
    settings_apply_nai: false,
  };
}

export function normalizeNaiSchedulerConfig(value) {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw || "{}");
    } catch (_) {
      raw = {};
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = {};
  const fallback = defaultNaiSchedulerConfig();
  const seenTracks = new Set();
  const tracks = (Array.isArray(raw.tracks) ? raw.tracks : fallback.tracks)
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry, index) => {
      const id = uniqueId(entry.id, "track", index, seenTracks);
      return {
        id,
        name: FIXED_TRACK_NAMES[id]
          || String(entry.name || `栏目 ${index + 1}`).trim()
          || `栏目 ${index + 1}`,
        enabled: entry.enabled !== false,
        text: typeof entry.text === "string" ? entry.text : "",
        mode: normalizedMode(entry.mode),
        collapsed: Boolean(entry.collapsed),
        ui_height: normalizedHeight(entry.ui_height),
      };
    });
  for (const [id, name] of Object.entries(FIXED_TRACK_NAMES)) {
    if (!tracks.some((track) => track.id === id)) tracks.push(defaultTrack(id, name));
  }
  const seenCharacters = new Set();
  const characters = (Array.isArray(raw.characters) ? raw.characters : [])
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry, index) => {
      const promptTab = entry.prompt_tab === "negative" ? "negative" : "positive";
      const x = Number(entry.x);
      const y = Number(entry.y);
      return {
        id: uniqueId(entry.id, "char", index, seenCharacters),
        name: storeCharacterName(entry.name, index),
        enabled: entry.enabled !== false,
        collapsed: Boolean(entry.collapsed),
        positive: typeof entry.positive === "string" ? entry.positive : "",
        negative: typeof entry.negative === "string" ? entry.negative : "",
        mode: normalizedMode(entry.mode),
        use_position: Boolean(entry.use_position),
        x: Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0.5,
        y: Number.isFinite(y) ? Math.max(0, Math.min(1, y)) : 0.5,
        use_order: Boolean(entry.use_order),
        prompt_tab: promptTab,
        prompt_ui_height: normalizedHeight(entry.prompt_ui_height),
      };
    });
  return {
    start_index: Math.max(0, Number.parseInt(raw.start_index ?? 0, 10) || 0),
    task_count: Math.max(1, Number.parseInt(raw.task_count ?? 1, 10) || 1),
    negative: typeof raw.negative === "string" ? raw.negative : "",
    quality_prompt_tab: raw.quality_prompt_tab === "negative" ? "negative" : "positive",
    use_coords: Boolean(raw.use_coords),
    positions_initialized: typeof raw.positions_initialized === "boolean"
      ? raw.positions_initialized
      : false,
    tracks,
    characters,
    settings_apply_nai: Boolean(raw.settings_apply_nai),
  };
}

export function naiSchedulerTrackInputName(trackId) {
  const bytes = new TextEncoder().encode(String(trackId));
  let encoded = "";
  for (const byte of bytes) encoded += byte.toString(16).padStart(2, "0");
  return `${NAI_TRACK_INPUT_PREFIX}${encoded}`;
}

function startsNHashLiteral(text, opening) {
  return opening >= 2
    && text[opening - 1] === "#"
    && text[opening - 2] >= "0"
    && text[opening - 2] <= "9";
}

export function naiSchedulerOrdinaryWildcardKeys(value) {
  if (typeof value !== "string" || !value) return [];
  const text = value
    .split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  const keys = [];
  let index = 0;
  while (index < text.length) {
    const opening = text.indexOf("__", index);
    if (opening < 0) break;
    if (startsNHashLiteral(text, opening)) {
      const closing = text.indexOf("__", opening + 2);
      if (closing < 0) break;
      index = closing + 2;
      while (text[index] === "_") index += 1;
      continue;
    }
    let start = opening;
    while (text[start] === "_") start += 1;
    const closing = text.indexOf("__", start);
    if (closing < 0) break;
    const key = text.slice(start, closing).trim();
    if (key) keys.push(key);
    index = closing + 2;
    while (text[index] === "_") index += 1;
  }
  return keys;
}

export function naiSchedulerHasEligibleSequence(value) {
  const tracks = Array.isArray(value?.tracks) ? value.tracks : [];
  if (tracks.some((track) => (
    track?.enabled !== false
    && track?.mode === "sequence"
    && naiSchedulerOrdinaryWildcardKeys(track?.text).length
  ))) return true;
  return (Array.isArray(value?.characters) ? value.characters : []).some((character) => (
    character?.enabled !== false
    && character?.mode === "sequence"
    && (
      naiSchedulerOrdinaryWildcardKeys(character?.positive).length
      || naiSchedulerOrdinaryWildcardKeys(character?.negative).length
    )
  ));
}

export function evenlyDistributedPositions(count, width, height) {
  const total = Math.max(0, Number.parseInt(count, 10) || 0);
  if (!total) return [];
  const aspect = Math.max(0.25, Math.min(4, Number(width) / Number(height) || 1));
  const columns = Math.max(1, Math.min(total, Math.ceil(Math.sqrt(total * aspect))));
  const rows = Math.ceil(total / columns);
  return Array.from({ length: total }, (_, index) => ({
    x: Number((((index % columns) + 0.5) / columns).toFixed(3)),
    y: Number(((Math.floor(index / columns) + 0.5) / rows).toFixed(3)),
  }));
}

export function createCharacterPositionDraft(characters, width, height, initialized) {
  const list = Array.isArray(characters) ? characters : [];
  const fallback = evenlyDistributedPositions(list.length, width, height);
  return list.map((character, index) => ({
    id: String(character?.id || index),
    x: initialized ? Number(character?.x ?? 0.5) : fallback[index].x,
    y: initialized ? Number(character?.y ?? 0.5) : fallback[index].y,
  }));
}

export function applyCharacterPositionDraft(characters, draft) {
  const positions = new Map(
    (Array.isArray(draft) ? draft : []).map((entry) => [String(entry.id), entry]),
  );
  for (const character of Array.isArray(characters) ? characters : []) {
    const position = positions.get(String(character.id));
    if (!position) continue;
    character.x = Math.max(0, Math.min(1, Number(position.x) || 0));
    character.y = Math.max(0, Math.min(1, Number(position.y) || 0));
  }
  return characters;
}

export function initializeCharacterPositions(characters, width, height) {
  return applyCharacterPositionDraft(
    characters,
    createCharacterPositionDraft(characters, width, height, false),
  );
}

export function schedulerCanvasResolution(node) {
  return { ...readNaiSamplerResolution(node), source: "scheduler" };
}

export function applyNaiSchedulerCharacters(currentValue, entries, mode = "replace") {
  const current = normalizeNaiSchedulerConfig(currentValue);
  const incoming = Array.isArray(entries) ? entries : [];
  const characters = mode === "append"
    ? [...current.characters, ...incoming]
    : incoming;
  const next = normalizeNaiSchedulerConfig({ ...current, characters });
  next.use_coords = next.characters.some((character) => character.use_position);
  next.positions_initialized = next.use_coords;
  return next;
}

export function applyNaiSchedulerCharacter(currentValue, entry, index) {
  const current = normalizeNaiSchedulerConfig(currentValue);
  const characters = [...current.characters];
  const target = Math.max(0, Number.parseInt(index, 10) || 0);
  if (target < characters.length) characters[target] = entry;
  else characters.push(entry);
  return applyNaiSchedulerCharacters(current, characters, "replace");
}

export async function invokeNaiSchedulerStartBatch(node, payload, warn = console.warn) {
  const start = node?.__nai4aStartBatch;
  if (typeof start !== "function") {
    warn("[NAI4A Scheduler] batch runner hook is missing");
    return { started: false, reason: "missing-hook" };
  }
  return { started: true, result: await start(payload) };
}

function injectStyles() {
  if (document.getElementById("nai4a-scheduler-styles")) return;
  const style = document.createElement("style");
  style.id = "nai4a-scheduler-styles";
  style.textContent = `
    .nai4a-scheduler { position:relative; width:100%; height:100%; min-height:0; display:flex; flex-direction:column; gap:8px; padding:0 4px 2px; box-sizing:border-box; overflow:hidden; color:#e8e8e8; font:12px/1.35 system-ui,sans-serif; }
    .nai4a-scheduler * { box-sizing:border-box; }
    .nai4a-scheduler input { width:100%; padding:5px 7px; border:1px solid #4b4f55; border-radius:4px; color:#eee; background:#151719; font:inherit; }
    .nai4a-scheduler button { padding:5px 8px; border:1px solid #555b62; border-radius:4px; color:#eee; background:#34383d; cursor:pointer; font:inherit; }
    .nai4a-scheduler button:hover { filter:brightness(1.15); }
    .nai4a-scheduler button:disabled { opacity:.45; cursor:not-allowed; }
    .nai4a-settings { display:flex; align-items:center; gap:7px; min-height:24px; color:#aeb4bb; }
    .nai4a-settings label { display:inline-flex; align-items:center; gap:6px; cursor:pointer; }
    .nai4a-settings input { width:auto; margin:0; }
    .nai4a-controls { display:grid; grid-template-columns:104px 104px auto auto; gap:8px; align-items:end; justify-content:start; }
    .nai4a-controls input, .nai4a-controls button { height:32px; min-height:32px; }
    .nai4a-field { min-width:0; display:flex; flex-direction:column; gap:3px; color:#aeb4bb; }
    .nai4a-run { background:#285f38 !important; border-color:#4b9a61 !important; font-weight:700 !important; }
    .nai4a-status { min-height:16px; color:#e8a0a0; }
    .nai4a-scroll { flex:1; min-height:0; overflow:auto; display:flex; flex-direction:column; gap:7px; padding-right:3px; scrollbar-width:thin; }
    .nai4a-track-list, .nai4a-character-list { display:flex; flex-direction:column; gap:7px; }
    .nai4a-track { flex:0 0 auto; overflow:hidden; border:1px solid #486b48; border-radius:6px; background:#353; }
    .nai4a-track-header, .nai4a-character-header { min-height:28px; padding:2px 4px; display:flex; align-items:center; gap:2px; background:#232; }
    .nai4a-track-title { flex:1; min-width:60px; display:flex; align-items:center; gap:2px; }
    .nai4a-title-text { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#c5d2c5; font-weight:650; }
    .nai4a-title-editor { height:24px; min-width:80px; padding:2px 5px !important; }
    .nai4a-collapse, .nai4a-mode, .nai4a-bypass, .nai4a-icon { width:22px; height:22px; flex:0 0 22px; padding:0 !important; display:grid; place-items:center; border:0 !important; color:#b9bec4 !important; background:transparent !important; }
    .nai4a-collapse, .nai4a-mode, .nai4a-bypass, .nai4a-icon { transition:background-color .12s ease,color .12s ease,filter .12s ease; }
    .nai4a-collapse:hover, .nai4a-mode:hover, .nai4a-icon:hover { background:#3b4046 !important; filter:none !important; }
    .nai4a-bypass:hover { background:#3c523c !important; filter:none !important; }
    .nai4a-bypass.bypassed:hover { background:#3b4046 !important; }
    .nai4a-collapse svg, .nai4a-mode svg, .nai4a-bypass svg { width:17px; height:17px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; pointer-events:none; }
    .nai4a-mode.random { color:#7fdb9a !important; }
    .nai4a-polarity { position:relative; width:70px; height:22px; flex:0 0 70px; padding:0 !important; display:grid; grid-template-columns:1fr 1fr; place-items:center; overflow:visible; border:0 !important; outline:0; background:transparent !important; color:#89939d !important; font-size:11px !important; font-weight:650 !important; isolation:isolate; }
    .nai4a-polarity-thumb { position:absolute; z-index:-1; top:1px; left:1px; width:34px; height:20px; border-radius:5px; background:#2c353e; box-shadow:inset 0 0 0 1px #526171; transform:translateX(0); transition:transform .16s ease,background-color .16s ease,box-shadow .16s ease; pointer-events:none; }
    .nai4a-polarity-label { position:relative; z-index:1; width:100%; text-align:center; transition:color .16s ease; pointer-events:none; }
    .nai4a-polarity-positive { color:#e2e9ef; }
    .nai4a-polarity.negative .nai4a-polarity-thumb { background:#5b3444; box-shadow:inset 0 0 0 1px #8b5266; transform:translateX(34px); }
    .nai4a-polarity.negative .nai4a-polarity-positive { color:#89939d; }
    .nai4a-polarity.negative .nai4a-polarity-negative { color:#f1d7df; }
    .nai4a-polarity:focus-visible .nai4a-polarity-thumb { box-shadow:inset 0 0 0 1px #9eb6ca,0 0 0 1px #9eb6ca; }
    .nai4a-actions { display:flex; align-items:center; gap:1px; }
    .nai4a-track-body, .nai4a-character-body { padding:7px; border-top:1px solid #496649; }
    .nai4a-track.negative-mode { border-color:#7c4d57; background:#56333b; }
    .nai4a-track.negative-mode .nai4a-track-header { background:#382329; }
    .nai4a-track.bypassed, .nai4a-character.bypassed { border-color:#656a72; background:#303237; }
    .nai4a-track.bypassed .nai4a-title-text, .nai4a-character.bypassed .nai4a-title-text { color:#a8adb5; text-decoration:line-through; }
    .nai4a-add { flex:0 0 auto; border-style:dashed !important; }
    .nai4a-character-section { display:flex; align-items:center; gap:10px; padding:8px 3px 2px; }
    .nai4a-section-title { margin-right:auto; color:#d2deeb; font-size:15px; font-weight:750; }
    .nai4a-position-toggle { display:inline-flex; align-items:center; gap:5px; color:#b9c6d4; white-space:nowrap; cursor:pointer; }
    .nai4a-position-toggle input { width:auto; margin:0; }
    .nai4a-character { flex:0 0 auto; overflow:hidden; border:1px solid #4a6078; border-radius:6px; background:#303c49; }
    .nai4a-character-header { background:#222d39; }
    .nai4a-character-body { display:flex; flex-direction:column; gap:7px; border-top-color:#46596d; }
    .nai4a-character.negative-mode { border-color:#76526f; background:#4a3548; }
    .nai4a-character.negative-mode .nai4a-character-header { background:#352635; }
    .nai4a-coordinate { margin-left:5px; color:#b8c7d5; font-size:11px; font-variant-numeric:tabular-nums; white-space:nowrap; }
    .nai4a-position-popover { position:fixed; z-index:10020; width:310px; max-width:calc(100vw - 20px); padding:10px; border:1px solid #53677d; border-radius:8px; color:#dce5ee; background:#222d39; box-shadow:0 12px 34px rgba(0,0,0,.48); }
    .nai4a-position-popover[hidden] { display:none; }
    .nai4a-position-title { margin-bottom:8px; color:#c9d7e5; font-weight:700; }
    .nai4a-position-wrap { width:100%; max-height:300px; padding:6px; display:grid; place-items:center; overflow:hidden; border:1px solid #415367; border-radius:6px; background:#18222d; }
    .nai4a-position-canvas { position:relative; max-height:270px; border:1px solid #64788d; border-radius:4px; background-color:#293846; background-image:linear-gradient(rgba(157,181,204,.12) 1px,transparent 1px),linear-gradient(90deg,rgba(157,181,204,.12) 1px,transparent 1px); background-size:20% 20%; touch-action:none; }
    .nai4a-position-dot { position:absolute; width:24px; height:24px; padding:0; display:grid; place-items:center; border:2px solid #eef6ff; border-radius:50%; color:#fff; background:#4779a8; font-size:11px; font-weight:700; transform:translate(-50%,-50%); cursor:grab; touch-action:none; }
    .nai4a-position-list { max-height:86px; margin-top:7px; overflow:auto; color:#aebdcb; font-size:11px; font-variant-numeric:tabular-nums; }
    .nai4a-position-list div { padding:2px 1px; display:flex; justify-content:space-between; gap:8px; }
    .nai4a-position-actions { margin-top:8px; display:flex; justify-content:flex-end; gap:7px; }
    .nai4a-position-save { background:#315f43 !important; border-color:#4c8b63 !important; }
    .nai4a-socket { position:absolute; z-index:30; width:8px; height:8px; padding:0; border:1.25px solid #020402; border-radius:50%; background:transparent; box-shadow:inset 0 0 1px .5px rgba(75,255,103,.72),0 0 1px .5px rgba(70,245,96,.58); transform:translate(-50%,-50%); cursor:crosshair; touch-action:none; }
    .nai4a-socket.connected { border-color:#78f28a; background:#78f28a; }
  `;
  document.head.appendChild(style);
}

function schedulerNodes() {
  const results = [];
  const visit = (graph) => {
    for (const node of graphNodes(graph)) {
      if (!node) continue;
      if (
        node.comfyClass === NAI_SCHEDULER_NODE_CLASS
        || node.type === NAI_SCHEDULER_NODE_CLASS
      ) results.push(node);
      if (node.subgraph) visit(node.subgraph);
    }
  };
  visit(app.graph);
  return results;
}

function selectedSchedulerNodes(payload) {
  const all = schedulerNodes();
  if (Array.isArray(payload?.node_ids) && payload.node_ids.length) {
    const ids = new Set(payload.node_ids.map((entry) => String(entry?.node_id ?? entry)));
    return all.filter((node) => ids.has(String(node.id)));
  }
  const source = app.canvas?.selected_nodes;
  const selected = (source instanceof Map ? [...source.values()] : Object.values(source || {}))
    .filter((node) => (
      node?.comfyClass === NAI_SCHEDULER_NODE_CLASS
      || node?.type === NAI_SCHEDULER_NODE_CLASS
    ));
  if (selected.length) return selected;
  if (all.length === 1) return all;
  return all.length
    ? [all.reduce((left, right) => Number(left.id) >= Number(right.id) ? left : right)]
    : [];
}

export function isNaiSchedulerEventPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  let identified = false;
  if (Object.prototype.hasOwnProperty.call(payload, "node_class")) {
    if (payload.node_class !== NAI_SCHEDULER_NODE_CLASS) return false;
    identified = true;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "target_mode")) {
    if (String(payload.target_mode || "").toLowerCase() !== "nai") return false;
    identified = true;
  }
  return identified;
}

function setupSchedulerNode(node) {
  if (node.__nai4aSchedulerReady) return;
  const getWidget = (name) => node.widgets?.find((widget) => widget?.name === name);
  let configWidget = getWidget("config_json");
  const indexWidget = getWidget("execution_index");
  const runWidget = getWidget("run_id");
  if (!configWidget || !indexWidget || !runWidget) return;
  node.__nai4aSchedulerReady = true;
  injectStyles();
  const t = createNaiTranslator(app);
  for (const widget of node.widgets || []) {
    if (INTERNAL_WIDGET_NAMES.has(widget?.name)) hideNaiInternalWidget(widget);
  }
  let config = normalizeNaiSchedulerConfig(configWidget.value);
  let schedulerWidget = null;
  let persistTimer = null;
  let connectionTimer = null;
  let layoutFrame = 0;
  let removed = false;
  let positionDraft = [];
  const trackViews = new Map();
  const socketMarkers = new Map();

  const lockInternalInputs = () => {
    for (const input of node.inputs || []) {
      if (INTERNAL_INPUT_NAMES.has(input?.name)) input.type = NAI4A_INTERNAL_INPUT_TYPE;
    }
  };
  lockInternalInputs();
  const originalConnectInput = node.onConnectInput?.bind(node);
  node.onConnectInput = function (inputIndex) {
    if (INTERNAL_INPUT_NAMES.has(this.inputs?.[inputIndex]?.name)) return false;
    return originalConnectInput ? originalConnectInput(...arguments) : true;
  };
  // Positioned track sockets belong visually to the DOM fields. Exclude them
  // from Node 2.0 slot bounds, otherwise their custom Y positions push the DOM
  // widget down and create a self-reinforcing empty-space layout loop.
  const originalMeasureSlots = node._measureSlots?.bind(node);
  if (originalMeasureSlots) {
    node._measureSlots = function () {
      const allInputs = this._concreteInputs;
      if (!Array.isArray(allInputs)) return originalMeasureSlots(...arguments);
      const positioned = [];
      this._concreteInputs = allInputs.filter((input, index) => {
        if (!input?.name?.startsWith(NAI_TRACK_INPUT_PREFIX)) return true;
        positioned.push({ input, index });
        return false;
      });
      let bounds;
      try {
        bounds = originalMeasureSlots(...arguments);
      } finally {
        this._concreteInputs = allInputs;
      }
      for (const { input, index } of positioned) {
        this._measureSlot?.(input, index, true);
      }
      return bounds;
    };
  }
  const originalDrawSlots = node.drawSlots?.bind(node);
  if (originalDrawSlots) {
    node.drawSlots = function () {
      const inputs = this._concreteInputs;
      if (!Array.isArray(inputs)) return originalDrawSlots(...arguments);
      this._concreteInputs = inputs.filter((input) => (
        !input?.name?.startsWith(NAI_TRACK_INPUT_PREFIX)
        && !INTERNAL_INPUT_NAMES.has(input?.name)
      ));
      try {
        return originalDrawSlots(...arguments);
      } finally {
        this._concreteInputs = inputs;
      }
    };
  }

  const main = document.createElement("div");
  main.className = "nai4a-scheduler";
  main.addEventListener("pointerdown", (event) => event.stopPropagation());
  main.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
  const persist = () => {
    if (removed) return;
    configWidget = getWidget("config_json") || configWidget;
    configWidget.value = JSON.stringify(config);
    if (Array.isArray(node.widgets_values)) {
      const index = node.widgets.indexOf(configWidget);
      if (index >= 0) node.widgets_values[index] = configWidget.value;
    }
    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
  };
  const schedulePersist = () => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persist, 120);
  };

  const settingsRow = document.createElement("div");
  settingsRow.className = "nai4a-settings";
  const settingsToggle = document.createElement("label");
  settingsToggle.title = t("采样数据仅临时覆盖相连的 NAI Sampler，任务结束后恢复");
  const settingsCheckbox = document.createElement("input");
  settingsCheckbox.type = "checkbox";
  settingsCheckbox.checked = config.settings_apply_nai;
  const settingsText = document.createElement("span");
  settingsText.textContent = t("自动应用采样数据");
  settingsToggle.append(settingsCheckbox, settingsText);
  settingsRow.append(settingsToggle);
  settingsCheckbox.onchange = () => {
    config.settings_apply_nai = settingsCheckbox.checked;
    persist();
  };

  const controls = document.createElement("div");
  controls.className = "nai4a-controls";
  const makeNumberField = (labelText, key, minimum) => {
    const label = document.createElement("label");
    label.className = "nai4a-field";
    label.textContent = labelText;
    const input = document.createElement("input");
    input.type = "number";
    input.min = String(minimum);
    input.step = "1";
    input.value = String(config[key]);
    input.onchange = () => {
      config[key] = Math.max(minimum, Number.parseInt(input.value, 10) || minimum);
      input.value = String(config[key]);
      persist();
    };
    label.appendChild(input);
    controls.appendChild(label);
    return input;
  };
  const startInput = makeNumberField(t("起始位置"), "start_index", 0);
  const taskInput = makeNumberField(t("任务数量"), "task_count", 1);
  const countButton = document.createElement("button");
  countButton.textContent = t("统计数量");
  const runButton = document.createElement("button");
  runButton.className = "nai4a-run";
  runButton.textContent = t("批量运行");
  controls.append(countButton, runButton);
  const statusEl = document.createElement("div");
  statusEl.className = "nai4a-status";
  statusEl.hidden = true;
  const setUi = ({ running, error } = {}) => {
    if (running !== undefined) {
      runButton.textContent = running ? t("停止批量") : t("批量运行");
      countButton.disabled = Boolean(running);
      startInput.disabled = Boolean(running);
      taskInput.disabled = Boolean(running);
    }
    if (error !== undefined) {
      statusEl.textContent = error || "";
      statusEl.hidden = !error;
    }
  };

  const scroll = document.createElement("div");
  scroll.className = "nai4a-scroll";
  const trackList = document.createElement("div");
  trackList.className = "nai4a-track-list";
  const addTrackButton = document.createElement("button");
  addTrackButton.className = "nai4a-add";
  addTrackButton.textContent = t("+ 新增栏目");
  const promptEditors = new Set();
  const promptHistories = new Map();
  const promptHistory = (key, value) => {
    let history = promptHistories.get(key);
    if (!history) {
      history = createNaiPromptHistory(value);
      promptHistories.set(key, history);
    } else {
      history.sync(value);
    }
    return history;
  };
  const removePromptHistories = (prefix) => {
    for (const key of promptHistories.keys()) {
      if (key.startsWith(prefix)) promptHistories.delete(key);
    }
  };
  const mountPromptEditor = (options) => {
    const editor = createNaiPromptEditor(options);
    promptEditors.add(editor);
    return editor;
  };
  const characterHeader = document.createElement("div");
  characterHeader.className = "nai4a-character-section";
  const characterTitle = document.createElement("span");
  characterTitle.className = "nai4a-section-title";
  characterTitle.textContent = t("角色提示词");
  const editPositionsButton = document.createElement("button");
  editPositionsButton.type = "button";
  editPositionsButton.textContent = t("编辑角色位置");
  const positionsToggle = document.createElement("label");
  positionsToggle.className = "nai4a-position-toggle";
  const positionsCheckbox = document.createElement("input");
  positionsCheckbox.type = "checkbox";
  const positionsText = document.createElement("span");
  positionsText.textContent = t("使用自定义位置");
  positionsToggle.append(positionsCheckbox, positionsText);
  characterHeader.append(characterTitle, editPositionsButton, positionsToggle);
  const characterList = document.createElement("div");
  characterList.className = "nai4a-character-list";
  const addCharacterButton = document.createElement("button");
  addCharacterButton.className = "nai4a-add";
  addCharacterButton.textContent = t("+ 新增角色");
  scroll.append(
    trackList,
    addTrackButton,
    characterHeader,
    characterList,
    addCharacterButton,
  );
  main.append(settingsRow, controls, scroll, statusEl);

  const popover = document.createElement("div");
  popover.className = "nai4a-position-popover";
  popover.hidden = true;
  popover.addEventListener("pointerdown", (event) => event.stopPropagation());
  const popoverTitle = document.createElement("div");
  popoverTitle.className = "nai4a-position-title";
  popoverTitle.textContent = t("角色位置");
  const canvasWrap = document.createElement("div");
  canvasWrap.className = "nai4a-position-wrap";
  const positionCanvas = document.createElement("div");
  positionCanvas.className = "nai4a-position-canvas";
  canvasWrap.appendChild(positionCanvas);
  const positionList = document.createElement("div");
  positionList.className = "nai4a-position-list";
  const positionActions = document.createElement("div");
  positionActions.className = "nai4a-position-actions";
  const cancelPositions = document.createElement("button");
  cancelPositions.textContent = t("取消");
  const savePositions = document.createElement("button");
  savePositions.className = "nai4a-position-save";
  savePositions.textContent = t("保存");
  positionActions.append(cancelPositions, savePositions);
  popover.append(popoverTitle, canvasWrap, positionList, positionActions);
  document.body.appendChild(popover);

  const placePopover = () => {
    const anchor = editPositionsButton.getBoundingClientRect();
    const width = Math.min(310, Math.max(240, globalThis.innerWidth - 20));
    let left = anchor.right + 8;
    if (left + width > globalThis.innerWidth - 10) left = anchor.left - width - 8;
    popover.style.left = `${Math.max(10, left)}px`;
    const height = popover.offsetHeight || 420;
    popover.style.top = `${Math.max(10, Math.min(anchor.top, globalThis.innerHeight - height - 10))}px`;
  };
  const closePopover = () => {
    popover.hidden = true;
    positionDraft = [];
  };
  const renderPositionDraft = () => {
    positionCanvas.replaceChildren();
    positionList.replaceChildren();
    const { width, height } = schedulerCanvasResolution(node);
    const scale = Math.min(280 / width, 270 / height);
    positionCanvas.style.width = `${Math.max(80, Math.round(width * scale))}px`;
    positionCanvas.style.height = `${Math.max(80, Math.round(height * scale))}px`;
    for (const [index, draft] of positionDraft.entries()) {
      const character = config.characters.find((item) => String(item.id) === String(draft.id));
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "nai4a-position-dot";
      dot.textContent = String(index + 1);
      const characterName = localizeCharacterName(character?.name, index, t);
      dot.title = characterName;
      const row = document.createElement("div");
      const label = document.createElement("span");
      label.textContent = `${index + 1}. ${characterName}`;
      const coords = document.createElement("span");
      row.append(label, coords);
      const sync = () => {
        dot.style.left = `${draft.x * 100}%`;
        dot.style.top = `${draft.y * 100}%`;
        coords.textContent = `X ${draft.x.toFixed(3)} · Y ${draft.y.toFixed(3)}`;
      };
      const move = (event) => {
        const rect = positionCanvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        draft.x = Number(
          Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)).toFixed(3),
        );
        draft.y = Number(
          Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)).toFixed(3),
        );
        sync();
      };
      dot.onpointerdown = (event) => {
        event.preventDefault();
        dot.setPointerCapture?.(event.pointerId);
        move(event);
      };
      dot.onpointermove = (event) => {
        if (dot.hasPointerCapture?.(event.pointerId)) move(event);
      };
      sync();
      positionCanvas.appendChild(dot);
      positionList.appendChild(row);
    }
  };
  editPositionsButton.onclick = () => {
    const resolution = schedulerCanvasResolution(node);
    positionDraft = createCharacterPositionDraft(
      config.characters,
      resolution.width,
      resolution.height,
      config.positions_initialized,
    );
    renderPositionDraft();
    popover.hidden = false;
    requestAnimationFrame(placePopover);
  };
  cancelPositions.onclick = closePopover;
  savePositions.onclick = () => {
    applyCharacterPositionDraft(config.characters, positionDraft);
    config.positions_initialized = true;
    config.use_coords = true;
    for (const character of config.characters) {
      character.use_position = true;
      character.use_order = true;
    }
    persist();
    closePopover();
    renderAll();
  };
  positionsCheckbox.onchange = () => {
    if (positionsCheckbox.checked && !config.positions_initialized) {
      const resolution = schedulerCanvasResolution(node);
      applyCharacterPositionDraft(
        config.characters,
        createCharacterPositionDraft(
          config.characters,
          resolution.width,
          resolution.height,
          false,
        ),
      );
      config.positions_initialized = true;
    }
    config.use_coords = positionsCheckbox.checked;
    for (const character of config.characters) {
      character.use_position = config.use_coords;
      character.use_order = true;
    }
    persist();
    renderAll();
  };

  const resizeObserver = new ResizeObserver((entries) => {
    let changed = false;
    for (const entry of entries) {
      const height = Math.max(54, Math.min(1200, Math.round(entry.target.offsetHeight)));
      const kind = entry.target.dataset.nai4aResizeKind;
      const ownerId = entry.target.dataset.nai4aOwnerId;
      if (kind === "negative" || kind === "track") {
        const id = kind === "negative" ? "quality" : ownerId;
        const track = config.tracks.find((candidate) => candidate.id === id);
        if (track && track.ui_height !== height) {
          track.ui_height = height;
          changed = true;
        }
      }
      if (kind?.startsWith("character-")) {
        const character = config.characters.find((candidate) => candidate.id === ownerId);
        if (character && character.prompt_ui_height !== height) {
          character.prompt_ui_height = height;
          changed = true;
        }
      }
    }
    if (changed) schedulePersist();
    scheduleInputLayout();
  });

  const linkedTrack = (trackId) => {
    const input = node.inputs?.find(
      (candidate) => candidate.name === naiSchedulerTrackInputName(trackId),
    );
    return input?.link !== null && input?.link !== undefined;
  };
  const applyLinkedState = () => {
    const linkedTitle = t("已由外部输入接管，运行时使用连线内容");
    for (const [trackId, view] of trackViews) {
      const linked = linkedTrack(view.activeInputName || trackId);
      view.editor?.setReadOnly(linked, linked ? linkedTitle : "");
    }
  };
  function scheduleInputLayout() {
    if (removed) return;
    if (layoutFrame) cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      const mainRect = main.getBoundingClientRect();
      if (!mainRect.height) return;
      const scale = Math.max(0.01, Number(app.canvas?.ds?.scale) || 1);
      const measuredTop = Number(schedulerWidget?.last_y);
      const widgetTop = Number.isFinite(measuredTop) && measuredTop > 0 ? measuredTop : 55;
      for (const input of node.inputs || []) {
        if (!input?.name?.startsWith(NAI_TRACK_INPUT_PREFIX)) continue;
        const trackId = input.__nai4aTrackId;
        const view = trackViews.get(trackId);
        const qualityView = trackViews.get("quality");
        const anchor = trackId === "negative"
          ? (qualityView?.activeInputName === "negative"
            ? qualityView.prompt
            : qualityView?.header)
          : (view?.activeInputName === trackId ? view.prompt : view?.header);
        if (!anchor) continue;
        const rect = anchor.getBoundingClientRect();
        const promptInput = anchor.matches("textarea, [contenteditable]");
        const x = promptInput ? (rect.left - mainRect.left + 1) / scale : 0;
        const localTop = (
          rect.top - mainRect.top + (promptInput ? 1 : rect.height / 2)
        ) / scale;
        input.pos = [x, widgetTop + localTop];
        const marker = socketMarkers.get(input.name);
        if (marker) {
          marker.style.left = `${x}px`;
          marker.style.top = `${localTop}px`;
          marker.classList.toggle(
            "connected",
            input.link !== null && input.link !== undefined,
          );
        }
      }
      applyLinkedState();
      node.setDirtyCanvas?.(true, true);
    });
  }
  const createSocketMarker = (inputName) => {
    const marker = document.createElement("span");
    marker.className = "nai4a-socket";
    marker.dataset.inputName = inputName;
    const forward = (method, event) => {
      event.preventDefault();
      event.stopPropagation();
      app.canvas?.[method]?.(event);
    };
    marker.onpointerdown = (event) => {
      if (event.button !== 0) return;
      marker.setPointerCapture?.(event.pointerId);
      forward("processMouseDown", event);
    };
    marker.onpointermove = (event) => {
      if (marker.hasPointerCapture?.(event.pointerId)) {
        forward("processMouseMove", event);
      }
    };
    const finish = (event) => {
      if (!marker.hasPointerCapture?.(event.pointerId)) return;
      forward("processMouseUp", event);
      marker.releasePointerCapture?.(event.pointerId);
      requestAnimationFrame(scheduleInputLayout);
    };
    marker.onpointerup = finish;
    marker.onpointercancel = finish;
    main.appendChild(marker);
    return marker;
  };
  const syncTrackInputs = ({ removeStale = true } = {}) => {
    const desired = new Map([
      ...config.tracks.map((track) => [naiSchedulerTrackInputName(track.id), track.id]),
      [naiSchedulerTrackInputName("negative"), "negative"],
    ]);
    for (let index = (node.inputs?.length || 0) - 1; index >= 0; index -= 1) {
      const input = node.inputs[index];
      if (
        removeStale
        && input?.name?.startsWith(NAI_TRACK_INPUT_PREFIX)
        && !desired.has(input.name)
      ) {
        socketMarkers.get(input.name)?.remove();
        socketMarkers.delete(input.name);
        node.removeInput(index);
      }
    }
    for (const [name, trackId] of desired) {
      let input = node.inputs?.find((candidate) => candidate.name === name);
      if (!input) input = node.addInput(name, "STRING", { label: " " });
      if (!input) continue;
      input.type = "STRING";
      input.label = " ";
      input.__nai4aTrackId = trackId;
      if (!socketMarkers.has(name)) socketMarkers.set(name, createSocketMarker(name));
    }
    scheduleInputLayout();
  };

  const iconButton = (symbol, title) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "nai4a-icon";
    button.textContent = symbol;
    button.title = title;
    return button;
  };
  const setupCollapse = (button, owner, rerender, expand, collapse) => {
    const render = () => {
      button.innerHTML = COLLAPSE_ICONS[owner.collapsed ? "collapsed" : "expanded"];
      button.title = t(owner.collapsed ? expand : collapse);
      button.setAttribute("aria-expanded", String(!owner.collapsed));
    };
    button.onclick = () => {
      owner.collapsed = !owner.collapsed;
      persist();
      rerender();
    };
    render();
  };
  const setupMode = (owner) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "nai4a-mode";
    const render = () => {
      const random = owner.mode === "random" || owner.mode === "shuffle";
      button.innerHTML = MODE_ICONS[random ? "random" : "sequence"];
      button.classList.toggle("random", random);
      button.title = t(random
        ? "当前：随机；点击切换为顺序"
        : "当前：顺序；点击切换为随机");
    };
    button.onclick = () => {
      owner.mode = owner.mode === "sequence" ? "random" : "sequence";
      persist();
      render();
    };
    render();
    return button;
  };
  const setupBypass = (owner, card) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "nai4a-bypass";
    const render = () => {
      const bypassed = !owner.enabled;
      card.classList.toggle("bypassed", bypassed);
      button.classList.toggle("bypassed", bypassed);
      button.innerHTML = BYPASS_ICONS[bypassed ? "bypassed" : "enabled"];
      button.title = t(bypassed
        ? "当前已停用；点击重新启用"
        : "当前已启用；点击停用");
    };
    button.onclick = () => {
      owner.enabled = !owner.enabled;
      persist();
      render();
    };
    render();
    return button;
  };
  const setupPolarity = (owner, key, card, onChange = () => {}) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "nai4a-polarity";
    const thumb = document.createElement("span");
    thumb.className = "nai4a-polarity-thumb";
    const positiveLabel = document.createElement("span");
    positiveLabel.className = "nai4a-polarity-label nai4a-polarity-positive";
    positiveLabel.textContent = t("正面");
    const negativeLabel = document.createElement("span");
    negativeLabel.className = "nai4a-polarity-label nai4a-polarity-negative";
    negativeLabel.textContent = t("负面");
    button.append(thumb, positiveLabel, negativeLabel);
    button.setAttribute("role", "switch");
    const render = () => {
      const negative = owner[key] === "negative";
      button.classList.toggle("negative", negative);
      button.dataset.state = negative ? "negative" : "positive";
      button.setAttribute("aria-checked", String(negative));
      button.setAttribute("aria-label", t(negative ? "负面提示词" : "正面提示词"));
      card.classList.toggle("negative-mode", negative);
      button.title = t(negative ? "切换到正面提示词" : "切换到负面提示词");
    };
    button.onclick = () => {
      owner[key] = owner[key] === "negative" ? "positive" : "negative";
      persist();
      render();
      onChange(owner[key]);
    };
    render();
    return button;
  };

  function renderTracks({ removeStaleInputs = true } = {}) {
    trackList.replaceChildren();
    trackViews.clear();
    for (const track of config.tracks) {
      const card = document.createElement("section");
      card.className = "nai4a-track";
      card.dataset.trackId = track.id;
      const qualityNegative = track.id === "quality"
        && config.quality_prompt_tab === "negative";
      const header = document.createElement("div");
      header.className = "nai4a-track-header";
      const collapse = document.createElement("button");
      collapse.type = "button";
      collapse.className = "nai4a-collapse";
      setupCollapse(collapse, track, renderAll, "展开栏目", "收起栏目");
      const title = document.createElement("div");
      title.className = "nai4a-track-title";
      const titleText = document.createElement("span");
      titleText.className = "nai4a-title-text";
      const fixedName = FIXED_TRACK_NAMES[track.id];
      titleText.textContent = fixedName ? t(fixedName) : track.name;
      let switchPromptView = () => {};
      title.append(titleText, setupBypass(track, card));
      if (track.id === "quality") {
        title.appendChild(setupPolarity(
          config,
          "quality_prompt_tab",
          card,
          () => switchPromptView(),
        ));
      }
      if (!fixedName) {
        const edit = iconButton("✎", t("编辑栏目名称"));
        edit.onclick = () => {
          const input = document.createElement("input");
          input.className = "nai4a-title-editor";
          input.value = track.name;
          let finished = false;
          const finish = (save) => {
            if (finished) return;
            finished = true;
            if (save) track.name = input.value.trim() || t("未命名栏目");
            persist();
            renderAll();
          };
          input.onblur = () => finish(true);
          input.onkeydown = (event) => {
            if (event.key === "Enter") input.blur();
            if (event.key === "Escape") finish(false);
          };
          title.replaceChildren(input);
          input.focus();
          input.select();
        };
        title.appendChild(edit);
      }
      header.append(collapse, title, setupMode(track));
      if (!fixedName) {
        const actions = document.createElement("div");
        actions.className = "nai4a-actions";
        const index = config.tracks.indexOf(track);
        const move = (direction, symbol, label) => {
          const button = iconButton(symbol, label);
          const target = index + direction;
          button.disabled = target < 0 || target >= config.tracks.length;
          button.onclick = () => {
            [config.tracks[index], config.tracks[target]] = [
              config.tracks[target],
              config.tracks[index],
            ];
            persist();
            renderAll();
          };
          return button;
        };
        const remove = iconButton("×", t("删除栏目"));
        remove.onclick = () => {
          config.tracks = config.tracks.filter((candidate) => candidate.id !== track.id);
          removePromptHistories(`track:${track.id}:`);
          persist();
          renderAll();
        };
        actions.append(
          move(-1, "↑", t("上移栏目")),
          move(1, "↓", t("下移栏目")),
          remove,
        );
        header.appendChild(actions);
      }
      card.appendChild(header);
      let prompt = null;
      let editor = null;
      if (!track.collapsed) {
        const body = document.createElement("div");
        body.className = "nai4a-track-body";
        const promptPlaceholder = () => (
          track.id === "quality" && config.quality_prompt_tab === "negative"
            ? ""
            : t("固定 NAI 文本，或粘贴 __文件夹路径__")
        );
        editor = mountPromptEditor({
          value: qualityNegative ? config.negative : track.text,
          history: promptHistory(
            `track:${track.id}:${qualityNegative ? "negative" : "positive"}`,
            qualityNegative ? config.negative : track.text,
          ),
          placeholder: promptPlaceholder(),
          resizeKind: qualityNegative ? "negative" : "track",
          ownerId: track.id,
          height: track.ui_height,
          onInput: (value) => {
            if (track.id === "quality" && config.quality_prompt_tab === "negative") {
              config.negative = value;
            } else {
              track.text = value;
            }
            schedulePersist();
          },
        });
        switchPromptView = () => {
          const negative = config.quality_prompt_tab === "negative";
          const placeholder = promptPlaceholder();
          const value = negative ? config.negative : track.text;
          editor.setHistory(
            promptHistory(`track:${track.id}:${negative ? "negative" : "positive"}`, value),
            value,
          );
          editor.input.placeholder = placeholder;
          editor.preview.dataset.placeholder = placeholder;
          editor.root.dataset.nai4aResizeKind = negative ? "negative" : "track";
          const view = trackViews.get(track.id);
          if (view) view.activeInputName = negative ? "negative" : track.id;
          applyLinkedState();
          scheduleInputLayout();
        };
        prompt = editor.input;
        resizeObserver.observe(editor.root);
        body.appendChild(editor.root);
        card.appendChild(body);
      }
      trackViews.set(track.id, {
        track,
        header,
        prompt,
        editor,
        activeInputName: qualityNegative ? "negative" : track.id,
      });
      trackList.appendChild(card);
    }
    syncTrackInputs({ removeStale: removeStaleInputs });
  }

  function renderCharacters() {
    characterList.replaceChildren();
    for (const [index, character] of config.characters.entries()) {
      const card = document.createElement("section");
      card.className = "nai4a-character";
      card.dataset.characterId = character.id;
      const header = document.createElement("div");
      header.className = "nai4a-character-header";
      const collapse = document.createElement("button");
      collapse.type = "button";
      collapse.className = "nai4a-collapse";
      setupCollapse(collapse, character, renderAll, "展开角色", "收起角色");
      const title = document.createElement("div");
      title.className = "nai4a-track-title";
      const titleText = document.createElement("span");
      titleText.className = "nai4a-title-text";
      titleText.textContent = localizeCharacterName(character.name, index, t);
      let switchPromptView = () => {};
      const edit = iconButton("✎", t("编辑栏目名称"));
      edit.onclick = () => {
        const input = document.createElement("input");
        input.className = "nai4a-title-editor";
        input.value = localizeCharacterName(character.name, index, t);
        let finished = false;
        const finish = (save) => {
          if (finished) return;
          finished = true;
          if (save) {
            character.name = storeCharacterName(
              input.value.trim() || t("未命名角色"),
              index,
            );
          }
          persist();
          renderAll();
        };
        input.onblur = () => finish(true);
        input.onkeydown = (event) => {
          if (event.key === "Enter") input.blur();
          if (event.key === "Escape") finish(false);
        };
        title.replaceChildren(input);
        input.focus();
        input.select();
      };
      title.append(
        titleText,
        edit,
        setupBypass(character, card),
        setupPolarity(character, "prompt_tab", card, () => switchPromptView()),
      );
      if (config.positions_initialized) {
        const coords = document.createElement("span");
        coords.className = "nai4a-coordinate";
        coords.textContent = `X ${Number(character.x).toFixed(3)} · Y ${Number(character.y).toFixed(3)}`;
        title.appendChild(coords);
      }
      header.append(collapse, title, setupMode(character));
      const actions = document.createElement("div");
      actions.className = "nai4a-actions";
      const move = (direction, symbol, label) => {
        const button = iconButton(symbol, label);
        const target = index + direction;
        button.disabled = target < 0 || target >= config.characters.length;
        button.onclick = () => {
          [config.characters[index], config.characters[target]] = [
            config.characters[target],
            config.characters[index],
          ];
          persist();
          renderAll();
        };
        return button;
      };
      const remove = iconButton("×", t("删除角色"));
      remove.onclick = () => {
        config.characters = config.characters.filter(
          (candidate) => candidate.id !== character.id,
        );
        removePromptHistories(`character:${character.id}:`);
        if (!config.characters.length) {
          config.use_coords = false;
          config.positions_initialized = false;
        }
        persist();
        renderAll();
      };
      actions.append(
        move(-1, "↑", t("上移角色")),
        move(1, "↓", t("下移角色")),
        remove,
      );
      header.appendChild(actions);
      card.appendChild(header);
      if (!character.collapsed) {
        const body = document.createElement("div");
        body.className = "nai4a-character-body";
        const activeKey = character.prompt_tab === "negative" ? "negative" : "positive";
        const editor = mountPromptEditor({
          value: character[activeKey],
          history: promptHistory(
            `character:${character.id}:${activeKey}`,
            character[activeKey],
          ),
          placeholder: t(activeKey === "positive"
            ? "角色 NAI 正面提示词"
            : "角色 NAI 负面提示词"),
          resizeKind: `character-${activeKey}`,
          ownerId: character.id,
          height: character.prompt_ui_height,
          onInput: (value) => {
            const key = character.prompt_tab === "negative" ? "negative" : "positive";
            character[key] = value;
            schedulePersist();
          },
        });
        switchPromptView = () => {
          const key = character.prompt_tab === "negative" ? "negative" : "positive";
          const placeholder = t(key === "positive"
            ? "角色 NAI 正面提示词"
            : "角色 NAI 负面提示词");
          editor.setHistory(
            promptHistory(`character:${character.id}:${key}`, character[key]),
            character[key],
          );
          editor.input.placeholder = placeholder;
          editor.preview.dataset.placeholder = placeholder;
          editor.root.dataset.nai4aResizeKind = `character-${key}`;
        };
        body.appendChild(editor.root);
        resizeObserver.observe(editor.root);
        card.appendChild(body);
      }
      characterList.appendChild(card);
    }
  }

  function renderAll({ removeStaleInputs = true } = {}) {
    resizeObserver.disconnect();
    for (const editor of [...promptEditors]) {
      editor.destroy();
      promptEditors.delete(editor);
    }
    renderTracks({ removeStaleInputs });
    renderCharacters();
    editPositionsButton.disabled = config.characters.length === 0;
    positionsCheckbox.disabled = config.characters.length === 0;
    positionsCheckbox.checked = config.use_coords;
    settingsCheckbox.checked = config.settings_apply_nai;
    applyLinkedState();
    scheduleInputLayout();
  }

  addTrackButton.onclick = () => {
    config.tracks.push(defaultTrack(
      nextId("track"),
      `栏目 ${config.tracks.length + 1}`,
    ));
    persist();
    renderAll();
    scroll.scrollTop = scroll.scrollHeight;
  };
  addCharacterButton.onclick = () => {
    const character = defaultCharacter(config.characters.length);
    character.use_position = config.use_coords;
    config.characters.push(character);
    if (config.use_coords) {
      const resolution = schedulerCanvasResolution(node);
      initializeCharacterPositions(
        config.characters,
        resolution.width,
        resolution.height,
      );
      config.positions_initialized = true;
    } else {
      config.positions_initialized = false;
    }
    persist();
    renderAll();
    scroll.scrollTop = scroll.scrollHeight;
  };
  scroll.addEventListener("scroll", scheduleInputLayout, { passive: true });

  const combineText = (current, incoming, mode) => {
    if (mode === "replace") return incoming;
    const existing = String(current || "").trim();
    const addition = String(incoming || "").trim();
    if (!existing) return addition;
    if (!addition) return existing;
    return `${existing.replace(/,+$/, "")},\n${addition}`;
  };
  const receiveQuality = (text, mode = "replace") => {
    if (typeof text !== "string") return false;
    const quality = config.tracks.find((track) => track.id === "quality");
    if (!quality) return false;
    quality.text = combineText(quality.text, text, mode);
    persist();
    renderAll();
    return true;
  };
  const receiveTrack = (entry, mode = "replace") => {
    if (!entry || typeof entry.text !== "string") return false;
    if (entry.id === "negative") {
      config.negative = combineText(config.negative, entry.text, mode);
    } else {
      if (entry.id === "quality") return receiveQuality(entry.text, mode);
      const genericPositive = entry.id === "positive" || entry.name === "正面";
      const target = genericPositive
        ? config.tracks.find((track) => track.id === "action")
        : config.tracks.find((track) => track.id === entry.id)
          || config.tracks.find((track) => track.name === entry.name);
      if (!target) return false;
      target.text = combineText(target.text, entry.text, mode);
    }
    persist();
    renderAll();
    return true;
  };
  const receiveSlot = (slot, text, mode = "append") => {
    if (!BASE_SLOTS.has(slot) || typeof text !== "string") return false;
    return receiveTrack({
      id: slot,
      name: FIXED_TRACK_NAMES[slot] || "负面",
      text,
    }, mode);
  };
  const receiveCharacters = (entries, mode = "replace") => {
    config = applyNaiSchedulerCharacters(config, entries, mode);
    persist();
    renderAll();
    return true;
  };
  const receiveCharacter = (entry, index = 0) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    config = applyNaiSchedulerCharacter(config, entry, index);
    persist();
    renderAll();
    return true;
  };
  node.__nai4aSchedulerReceiveTrack = receiveTrack;
  node.__nai4aSchedulerReceiveSlot = receiveSlot;
  node.__nai4aSchedulerReceiveQuality = receiveQuality;
  node.__nai4aSchedulerReceiveCharacters = receiveCharacters;
  node.__nai4aSchedulerReceiveCharacter = receiveCharacter;
  countButton.onclick = async () => {
    if (!naiSchedulerHasEligibleSequence(config)) return;
    countButton.disabled = true;
    try {
      const data = await nai4aRequestJson("/nai4a/api/scheduler/counts", { config });
      const maximum = Number(data.maximum || 0);
      if (maximum < 1) throw new Error(t("没有找到可循环的 NAI 文件夹通配符"));
      config.task_count = maximum;
      taskInput.value = String(maximum);
      persist();
    } catch (error) {
      console.error("[NAI4A Scheduler] Failed to count tasks", error);
      setUi({ error: String(error?.message || error) });
    } finally {
      countButton.disabled = false;
    }
  };
  const setStartIndex = (index) => {
    config.start_index = Math.max(0, Number.parseInt(index, 10) || 0);
    startInput.value = String(config.start_index);
    persist();
  };
  attachNaiSerialBatchHook(node, {
    requestJson: nai4aRequestJson,
    setStartIndex,
    setUi,
    getSampler: () => resolveConnectedNaiSampler(node),
    t,
  });
  const onUnload = () => node.__nai4aCancelBatch?.();
  globalThis.addEventListener?.("pagehide", onUnload);
  globalThis.addEventListener?.("beforeunload", onUnload);
  indexWidget.beforeQueued = () => {
    const state = node.__nai4aBatchState;
    indexWidget.value = state ? state.currentIndex : config.start_index;
    runWidget.value = state ? state.runId : "";
  };
  runButton.onclick = async () => {
    if (node.__nai4aBatchRunning) {
      node.__nai4aCancelBatch?.();
      return;
    }
    config.start_index = Math.max(0, Number.parseInt(startInput.value, 10) || 0);
    config.task_count = Math.max(1, Number.parseInt(taskInput.value, 10) || 1);
    clearTimeout(persistTimer);
    persist();
    setUi({ error: "" });
    try {
      await invokeNaiSchedulerStartBatch(node, {
        config: normalizeNaiSchedulerConfig(config),
        seed: Number(getWidget("seed")?.value) || 0,
        indexWidget,
        runWidget,
      });
    } catch (error) {
      console.error("[NAI4A Scheduler] batch runner failed", error);
      setUi({ error: String(error?.message || error) });
    }
  };

  const loadFromWidget = ({ restoring = false } = {}) => {
    configWidget = getWidget("config_json") || configWidget;
    config = normalizeNaiSchedulerConfig(configWidget.value);
    if (restoring) promptHistories.clear();
    startInput.value = String(config.start_index);
    taskInput.value = String(config.task_count);
    renderAll();
    lockInternalInputs();
    if (!restoring) persist();
  };
  const originalConfigure = node.onConfigure?.bind(node);
  node.onConfigure = function (info) {
    const result = originalConfigure?.(info);
    requestAnimationFrame(() => {
      if (!removed) loadFromWidget({ restoring: true });
    });
    return result;
  };
  const originalConnections = node.onConnectionsChange?.bind(node);
  node.onConnectionsChange = function () {
    const result = originalConnections?.apply(this, arguments);
    scheduleInputLayout();
    clearTimeout(connectionTimer);
    connectionTimer = setTimeout(() => {
      connectionTimer = null;
      lockInternalInputs();
      for (let index = (node.inputs?.length || 0) - 1; index >= 0; index -= 1) {
        const input = node.inputs[index];
        if (
          INTERNAL_INPUT_NAMES.has(input?.name)
          && input.link !== null
          && input.link !== undefined
        ) node.disconnectInput(index);
      }
    }, 0);
    return result;
  };
  const originalRemoved = node.onRemoved?.bind(node);
  node.onRemoved = function () {
    removed = true;
    node.__nai4aCancelBatch?.();
    globalThis.removeEventListener?.("pagehide", onUnload);
    globalThis.removeEventListener?.("beforeunload", onUnload);
    clearTimeout(persistTimer);
    clearTimeout(connectionTimer);
    if (layoutFrame) cancelAnimationFrame(layoutFrame);
    resizeObserver.disconnect();
    for (const editor of promptEditors) editor.destroy();
    promptEditors.clear();
    promptHistories.clear();
    for (const marker of socketMarkers.values()) marker.remove();
    socketMarkers.clear();
    main.remove();
    popover.remove();
    indexWidget.beforeQueued = undefined;
    for (const name of [
      "__nai4aSchedulerReceiveTrack",
      "__nai4aSchedulerReceiveSlot",
      "__nai4aSchedulerReceiveQuality",
      "__nai4aSchedulerReceiveCharacters",
      "__nai4aSchedulerReceiveCharacter",
      "__nai4aStartBatch",
      "__nai4aCancelBatch",
      "__nai4aBatchRunning",
      "__nai4aBatchState",
      "__nai4aSchedulerReady",
    ]) delete node[name];
    return originalRemoved?.apply(this, arguments);
  };

  schedulerWidget = node.addDOMWidget(
    "nai4a-scheduler-ui",
    "nai4a-scheduler",
    main,
    withSyncedDomWidth({
      serialize: false,
      hideOnZoom: false,
      margin: 0,
      getMinHeight: () => 340,
      getMaxHeight: () => Math.max(340, Number(node.size?.[1] || 720) - 100),
    }),
  );
  const bottomWidgets = node.widgets?.filter((widget) => (
    widget?.name === "seed" || widget?.name === "control_after_generate"
  )) || [];
  if (bottomWidgets.length) {
    const resolutionWidget = node.widgets.find(
      (widget) => widget?.name === "nai4a-resolution-ui",
    );
    for (const widget of [schedulerWidget, resolutionWidget]) {
      const widgetIndex = node.widgets.indexOf(widget);
      if (widgetIndex >= 0) node.widgets.splice(widgetIndex, 1);
    }
    const firstBottom = Math.min(...bottomWidgets.map((widget) => node.widgets.indexOf(widget)));
    node.widgets.splice(
      firstBottom,
      0,
      ...[schedulerWidget, resolutionWidget].filter(Boolean),
    );
  }
  node.resizable = true;
  node.setSize([520, 720]);
  renderAll();
}

app.registerExtension({
  name: "ComfyUI-4A-NovelAI.NAIPromptScheduler",
  setup() {
    installNaiPromptUndoGuard(ChangeTracker);
    api.addEventListener("pm4a_nai_widget_update", (event) => {
      const payload = event?.detail || {};
      if (!isNaiSchedulerEventPayload(payload)) return;
      const slot = String(payload.slot || payload.widget_name || "");
      if (!BASE_SLOTS.has(slot) || typeof payload.value !== "string") return;
      const mode = payload.mode === "replace" ? "replace" : "append";
      for (const node of selectedSchedulerNodes(payload)) {
        node.__nai4aSchedulerReceiveSlot?.call(node, slot, payload.value, mode);
      }
    });
    api.addEventListener("pm4a_nai_resolution_update", (event) => {
      const payload = event?.detail || {};
      if (!isNaiSchedulerEventPayload(payload)) return;
      if (payload.resolution_mode !== "ratio") return;
      for (const node of selectedSchedulerNodes(payload)) {
        applyNaiSamplerRatioHint(node, payload);
      }
    });
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NAI_SCHEDULER_NODE_CLASS) return;
    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      originalCreated?.apply(this, arguments);
      setupNaiSamplerNode(this);
      setupSchedulerNode(this);
    };
  },
});
