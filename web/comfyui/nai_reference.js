import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
  NAI4A_INTERNAL_INPUT_TYPE,
  createNaiTranslator,
  hideNaiInternalWidget,
  withSyncedDomWidth,
  writeNaiNodeWidget,
} from "./nai_frontend_helpers.js";
import { scheduleNaiAccountRefresh } from "./nai_settings.js";

export const NAI_REFERENCE_NODE_CLASS = "NovelAI4AReference";
export const NAI_REFERENCE_INPUT_PREFIX = "nai_ref_";
const COMFY_ASSET_INFO_MIME = "application/x-comfy-asset-info";
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

const INTERNAL_WIDGETS = new Set(["config_json"]);
const INTERNAL_INPUTS = new Set(["config_json"]);
let generatedId = 0;

function nextId() {
  generatedId += 1;
  return globalThis.crypto?.randomUUID?.()
    ? `reference-${globalThis.crypto.randomUUID()}-${generatedId}`
    : `reference-${Date.now()}-${generatedId}`;
}

function numberInRange(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(minimum, Math.min(maximum, number))
    : fallback;
}

function normalizeContent(value) {
  const source = String(value || "").toLowerCase();
  if (source === "character") return "character";
  if (source === "style") return "style";
  return "character&style";
}

export function defaultNaiReferenceItem(index = 0) {
  return {
    id: nextId(),
    name: `参考 ${index + 1}`,
    enabled: true,
    source: "image",
    vibe_file: "",
    image_file: "",
    vibe_cache_required: true,
    information_extracted: 0.7,
    strength: 0.6,
    reference_content: "character&style",
    fidelity: 1,
  };
}

export function normalizeNaiReferenceConfig(value) {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw || "{}");
    } catch (_) {
      raw = {};
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = {};
  const normalizedMode = raw.mode === "precise" ? "precise" : "vibe";
  const seen = new Set();
  const normalizeItems = (sourceItems, itemMode) => (
    (Array.isArray(sourceItems) ? sourceItems : [])
      .filter((item) => item && typeof item === "object" && !Array.isArray(item))
      .map((item, index) => {
      const base = String(item.id || `reference-${index + 1}`).trim()
        || `reference-${index + 1}`;
      let id = base;
      let suffix = 2;
      while (seen.has(id)) id = `${base}-${suffix++}`;
      seen.add(id);
      const vibeFilename = String(item.vibe_file || "").trim();
      const imageFilename = String(item.image_file || "").trim();
      const source = item.source === "file" ? "file" : "image";
      return {
        id,
        name: String(item.name || `参考 ${index + 1}`).trim() || `参考 ${index + 1}`,
        enabled: item.enabled !== false,
        source,
        vibe_file: vibeFilename,
        image_file: imageFilename,
        vibe_cache_required: Boolean(imageFilename || vibeFilename)
          && item.vibe_cache_required !== false,
        information_extracted: numberInRange(
          item.information_extracted,
          0.7,
          0.01,
          1,
        ),
        strength: numberInRange(
          item.strength,
          0.6,
          itemMode === "vibe" ? 0.01 : 0,
          1,
        ),
        reference_content: normalizeContent(item.reference_content),
        fidelity: numberInRange(item.fidelity, 1, 0, 1),
      };
      })
  );
  const vibeItems = normalizeItems(
    raw.vibe_items,
    "vibe",
  );
  const preciseItems = normalizeItems(
    raw.precise_items,
    "precise",
  );
  return {
    mode: normalizedMode,
    encode_model: raw.encode_model === "V4.5 Curated"
      ? "V4.5 Curated"
      : "V4.5 Full",
    vibe_items: vibeItems,
    precise_items: preciseItems,
  };
}

function injectStyles() {
  if (document.getElementById("nai4a-reference-styles")) return;
  const style = document.createElement("style");
  style.id = "nai4a-reference-styles";
  style.textContent = `
    .nai4a-reference { position:relative; width:100%; height:100%; min-height:0; padding:0 4px 3px; display:flex; flex-direction:column; gap:7px; overflow:hidden; color:#e9edf1; font:12px/1.3 system-ui,sans-serif; box-sizing:border-box; }
    .nai4a-reference * { box-sizing:border-box; }
    .nai4a-reference button, .nai4a-reference select, .nai4a-reference input { min-width:0; height:27px; border:1px solid #525861; border-radius:4px; color:#edf0f3; background:#262a2f; font:inherit; }
    .nai4a-reference button { padding:3px 7px; cursor:pointer; }
    .nai4a-reference button:hover { filter:brightness(1.14); }
    .nai4a-reference button:disabled { opacity:.45; cursor:not-allowed; }
    .nai4a-reference-head { display:flex; align-items:center; gap:6px; flex:0 0 auto; }
    .nai4a-reference-mode { display:grid; grid-template-columns:1fr 1fr; flex:1; padding:2px; border:1px solid #50565d; border-radius:6px; background:#1c1f23; }
    .nai4a-reference-mode button { height:25px; border:0; background:transparent; color:#aeb5bc; }
    .nai4a-reference-mode button.active { color:#fff; background:#3a4652; font-weight:700; }
    .nai4a-reference-model { display:flex; align-items:center; gap:7px; flex:0 0 auto; color:#aeb6be; }
    .nai4a-reference-model select { flex:1; padding:2px 6px; }
    .nai4a-reference-list { flex:1; min-height:0; display:flex; flex-direction:column; gap:7px; overflow:auto; padding-right:2px; scrollbar-width:thin; }
    .nai4a-reference-card { position:relative; flex:0 0 auto; overflow:hidden; border:1px solid #464a50; border-radius:6px; background:#292c30; }
    .nai4a-reference-card.vibe { border-color:#514b5d; background:#2c2930; }
    .nai4a-reference-card.disabled .nai4a-reference-preview, .nai4a-reference-card.disabled .nai4a-reference-kind { opacity:.55; }
    .nai4a-reference-card-header { min-height:30px; padding:2px 5px 2px 8px; display:flex; align-items:center; gap:4px; background:#30343a; }
    .nai4a-reference-card.vibe .nai4a-reference-card-header { background:#36313d; }
    .nai4a-reference-card-title { flex:1; min-width:0; overflow:hidden; color:#dfe3e7; font-weight:650; text-overflow:ellipsis; white-space:nowrap; }
    .nai4a-reference-kind { flex:0 0 auto; width:100%; height:24px !important; padding:2px 6px; background:#1b1d20 !important; }
    .nai4a-reference-card-actions { flex:0 0 auto; display:flex; align-items:center; gap:1px; }
    .nai4a-reference-action { width:24px; height:24px !important; flex:0 0 24px; padding:0 !important; display:grid; place-items:center; border:0 !important; border-radius:4px !important; color:#c5c9ce !important; background:transparent !important; cursor:pointer; transition:background-color .12s ease,color .12s ease; }
    .nai4a-reference-action:hover { background:#3b4046 !important; filter:none !important; }
    .nai4a-reference-action.enable.enabled { color:#a9d8b1 !important; }
    .nai4a-reference-action.enable.enabled:hover { background:#3c523c !important; }
    .nai4a-reference-action.enable.disabled { color:#d5b0b6 !important; }
    .nai4a-reference-action:disabled { opacity:1 !important; }
    .nai4a-reference-action svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:2.1; stroke-linecap:round; stroke-linejoin:round; pointer-events:none; }
    .nai4a-reference-action.delete { font-size:18px; line-height:1; }
    .nai4a-reference-card-body { padding:6px; display:grid; grid-template-columns:96px minmax(0,1fr); gap:8px; border-top:1px solid #42464b; }
    .nai4a-reference-preview { position:relative; width:96px; height:132px; overflow:hidden; border:1px solid #505760; border-radius:5px; background:#171a1e; }
    .nai4a-reference-preview img { width:100%; height:100%; display:block; object-fit:cover; }
    .nai4a-reference-placeholder { width:100%; height:100%; display:grid; place-items:center; padding:8px; color:#7f8891; text-align:center; }
    .nai4a-reference-parameters { position:relative; min-width:0; display:flex; flex-direction:column; gap:6px; }
    .nai4a-reference-field { min-width:0; display:flex; flex-direction:column; gap:3px; color:#c7cdd3; }
    .nai4a-reference-field-label { color:#d8dce0; font-size:11px; font-weight:700; line-height:1.15; }
    .nai4a-reference-number { display:grid; grid-template-columns:46px minmax(0,1fr); align-items:center; gap:7px; }
    .nai4a-reference-number input[type=number] { width:46px; height:24px; padding:2px 3px; border-color:#474d54; color:#f0f2f4; background:#1c1f23; text-align:center; font-variant-numeric:tabular-nums; appearance:textfield; -moz-appearance:textfield; }
    .nai4a-reference-number input[type=number]::-webkit-inner-spin-button, .nai4a-reference-number input[type=number]::-webkit-outer-spin-button { margin:0; -webkit-appearance:none; }
    .nai4a-reference-number input[type=range] { width:100%; height:18px; padding:0; border:0; background:transparent; appearance:none; -webkit-appearance:none; cursor:pointer; }
    .nai4a-reference-number input[type=range]::-webkit-slider-runnable-track { height:5px; border:1px solid #414850; border-radius:5px; background:#181b1f; box-shadow:inset 0 1px 2px rgba(0,0,0,.45); }
    .nai4a-reference-number input[type=range]::-webkit-slider-thumb { width:14px; height:14px; margin-top:-5px; border:1px solid #8a9dad; border-radius:4px; background:#667b8d; box-shadow:0 1px 3px rgba(0,0,0,.45); appearance:none; -webkit-appearance:none; }
    .nai4a-reference-number input[type=range]:hover::-webkit-slider-thumb { border-color:#a4b8c8; background:#7890a3; }
    .nai4a-reference-number input[type=range]:focus-visible { outline:1px solid #718da5; outline-offset:2px; }
    .nai4a-reference-status { min-height:14px; overflow:hidden; color:#aeb8c3; font-size:10px; line-height:1.35; text-overflow:ellipsis; white-space:nowrap; }
    .nai4a-reference-status.warning { color:#efbd72; }
    .nai4a-reference-encode-row { position:absolute; left:0; right:0; bottom:0; height:42px; min-width:0; }
    .nai4a-reference-encode-row .nai4a-reference-status { position:absolute; left:0; right:0; top:0; }
    .nai4a-reference-encode { min-width:142px; height:25px !important; border-color:#826832 !important; background:#554321 !important; color:#ffe2a4 !important; }
    .nai4a-reference-encode-row .nai4a-reference-encode { position:absolute; right:0; bottom:0; }
    .nai4a-reference-encode:disabled { border-color:#4b4f54 !important; background:#30343a !important; color:#7f878f !important; opacity:.7 !important; }
  `;
  document.head.appendChild(style);
}

function apiUrl(path) {
  return typeof api.apiURL === "function" ? api.apiURL(path) : path;
}

function looksLikeImageFile(file) {
  return Boolean(file && (
    file.type?.startsWith("image/")
    || /\.(?:png|jpe?g|webp|gif|bmp|tiff?|avif)$/i.test(file.name || "")
  ));
}

function looksLikeVibeFile(file) {
  return Boolean(file && /\.naiv4vibe(?:bundle)?$/i.test(file.name || ""));
}

function hasSupportedReferenceTransfer(dataTransfer) {
  const files = Array.from(dataTransfer?.files || []);
  const items = Array.from(dataTransfer?.items || []);
  const types = Array.from(dataTransfer?.types || []);
  return files.some((file) => looksLikeImageFile(file) || looksLikeVibeFile(file))
    || items.some((item) => item.kind === "file")
    || types.includes("Files")
    || types.includes(COMFY_ASSET_INFO_MIME)
    || types.includes("text/uri-list");
}

async function responseBlobWithinLimit(response) {
  const contentLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
    throw new Error("图片不能超过 32 MB");
  }
  const blob = await response.blob();
  if (blob.size > MAX_IMAGE_BYTES) throw new Error("图片不能超过 32 MB");
  return blob;
}

async function fetchImageFile(url, fileName) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`图片读取失败：${response.status}`);
  const blob = await responseBlobWithinLimit(response);
  const file = new File([blob], fileName || "asset.png", { type: blob.type });
  if (!looksLikeImageFile(file)) throw new Error("拖入的资产不是支持的图片");
  return file;
}

function parseComfyAssetInfo(raw) {
  try {
    const value = JSON.parse(raw || "");
    return value && typeof value.filename === "string" ? value : null;
  } catch (_) {
    return null;
  }
}

function localReferenceFiles(dataTransfer) {
  const directFiles = Array.from(dataTransfer?.files || []).filter(
    (file) => looksLikeImageFile(file) || looksLikeVibeFile(file),
  );
  const itemFiles = Array.from(dataTransfer?.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile?.())
    .filter((file) => looksLikeImageFile(file) || looksLikeVibeFile(file));
  return directFiles.length ? directFiles : itemFiles;
}

async function referenceFilesFromTransfer(dataTransfer) {
  const local = localReferenceFiles(dataTransfer);
  if (local.length) return local;
  let fetchError = null;
  const asset = parseComfyAssetInfo(dataTransfer?.getData?.(COMFY_ASSET_INFO_MIME));
  if (asset?.filename) {
    const url = new URL(apiUrl("/view"), location.href);
    url.searchParams.set("filename", asset.filename);
    url.searchParams.set("type", asset.type || "output");
    if (asset.subfolder) url.searchParams.set("subfolder", asset.subfolder);
    try {
      return [await fetchImageFile(url, asset.filename)];
    } catch (error) {
      fetchError = error;
    }
  }
  const uriText = dataTransfer?.getData?.("text/uri-list") || "";
  const firstUri = uriText.split(/\r?\n/).find((line) => line && !line.startsWith("#"));
  if (firstUri) {
    try {
      const url = new URL(firstUri, location.href);
      if (url.origin === location.origin) {
        return [await fetchImageFile(
          url,
          url.searchParams.get("filename") || url.pathname.split("/").pop(),
        )];
      }
    } catch (error) {
      fetchError ||= error;
    }
  }
  if (fetchError) throw fetchError;
  return [];
}

function setupReferenceNode(node) {
  if (node.__nai4aReferenceReady || typeof node.addDOMWidget !== "function") return;
  const widget = (name) => node.widgets?.find((item) => item?.name === name);
  const configWidget = widget("config_json");
  if (!configWidget) return;
  node.__nai4aReferenceReady = true;
  const t = createNaiTranslator(app);
  injectStyles();
  for (const item of node.widgets || []) {
    if (INTERNAL_WIDGETS.has(item?.name)) hideNaiInternalWidget(item);
  }
  let config = normalizeNaiReferenceConfig(configWidget.value);
  const itemsForMode = (mode = config.mode) => (
    mode === "precise" ? config.precise_items : config.vibe_items
  );
  let library = [];
  let referenceWidget = null;
  const vibeMatchStates = new Map();

  for (const input of node.inputs || []) {
    if (INTERNAL_INPUTS.has(input?.name)) input.type = NAI4A_INTERNAL_INPUT_TYPE;
  }
  for (let index = (node.inputs?.length || 0) - 1; index >= 0; index -= 1) {
    const name = node.inputs[index]?.name;
    if (
      name === "image"
      || name === "references"
      || name?.startsWith(NAI_REFERENCE_INPUT_PREFIX)
    ) node.removeInput(index);
  }
  const originalConnectInput = node.onConnectInput?.bind(node);
  node.onConnectInput = function (inputIndex) {
    if (INTERNAL_INPUTS.has(this.inputs?.[inputIndex]?.name)) return false;
    return originalConnectInput ? originalConnectInput(...arguments) : true;
  };

  const main = document.createElement("div");
  main.className = "nai4a-reference";
  main.addEventListener("pointerdown", (event) => {
    const rect = main.getBoundingClientRect();
    if (
      Number(event.clientX) >= rect.right - 20
      && Number(event.clientY) >= rect.bottom - 20
    ) return;
    event.stopPropagation();
  });
  main.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
  const persist = () => {
    writeNaiNodeWidget(node, configWidget, JSON.stringify(config));
    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
  };

  const head = document.createElement("div");
  head.className = "nai4a-reference-head";
  const mode = document.createElement("div");
  mode.className = "nai4a-reference-mode";
  const vibeMode = document.createElement("button");
  vibeMode.type = "button";
  vibeMode.textContent = "Vibe";
  const preciseMode = document.createElement("button");
  preciseMode.type = "button";
  preciseMode.textContent = "Precise Reference";
  mode.append(vibeMode, preciseMode);
  head.append(mode);

  const modelRow = document.createElement("label");
  modelRow.className = "nai4a-reference-model";
  modelRow.textContent = t("Vibe 编码模型");
  const modelSelect = document.createElement("select");
  for (const value of ["V4.5 Full", "V4.5 Curated"]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    modelSelect.appendChild(option);
  }
  modelRow.appendChild(modelSelect);
  const list = document.createElement("div");
  list.className = "nai4a-reference-list";
  main.append(head, modelRow, list);

  const refreshLibrary = async () => {
    const response = await api.fetchApi("/novelai4a/vibes");
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || t("读取 Vibe 文件失败"));
    library = Array.isArray(payload.items) ? payload.items : [];
    renderAll();
  };
  const ensureVibeMatch = async (item) => {
    if (
      config.mode !== "vibe"
      || (!item.image_file && !item.vibe_file)
    ) return;
    const key = [
      item.image_file || item.vibe_file,
      config.encode_model,
      Number(item.information_extracted).toFixed(4),
    ].join("|");
    const existing = vibeMatchStates.get(item.id);
    if (existing?.key === key) return;
    vibeMatchStates.set(item.id, { key, status: "loading", matched: false });
    const requestIsCurrent = () => vibeMatchStates.get(item.id)?.key === key;
    try {
      const query = new URLSearchParams({
        model: config.encode_model,
        information: String(item.information_extracted),
      });
      if (item.image_file) query.set("image", item.image_file);
      else query.set("vibe", item.vibe_file);
      const response = await api.fetchApi(`/novelai4a/vibes/match?${query}`);
      const payload = await response.json();
      if (!requestIsCurrent()) return;
      if (!response.ok) throw new Error(payload.error || t("Vibe 缓存检查失败"));
      const forcedDisabled = item.vibe_cache_required === true;
      if (payload.matched) {
        item.vibe_cache_required = false;
        if (forcedDisabled) item.enabled = true;
        vibeMatchStates.set(item.id, {
          key,
          status: "ready",
          matched: true,
          canEncode: payload.can_encode !== false,
        });
      } else {
        item.vibe_cache_required = true;
        item.enabled = false;
        vibeMatchStates.set(item.id, {
          key,
          status: "missing",
          matched: false,
          canEncode: payload.can_encode !== false,
        });
      }
      persist();
      renderAll();
    } catch (error) {
      if (!requestIsCurrent()) return;
      item.vibe_cache_required = true;
      item.enabled = false;
      vibeMatchStates.set(item.id, {
        key,
        status: "error",
        matched: false,
        error: String(error.message || error),
      });
      persist();
      renderAll();
    }
  };
  const invalidateVibeMatch = (item) => {
    if (item.image_file || item.vibe_file) {
      item.vibe_cache_required = true;
      item.enabled = false;
      vibeMatchStates.delete(item.id);
    }
    persist();
    renderAll();
  };
  const previewFor = (item) => {
    if (config.mode === "vibe" && item.source === "file" && item.vibe_file) {
      const entry = library.find((candidate) => candidate.filename === item.vibe_file);
      if (entry?.has_preview) {
        return apiUrl(`/novelai4a/vibes/preview?name=${encodeURIComponent(item.vibe_file)}`);
      }
    }
    if (item.image_file) {
      return apiUrl(
        `/novelai4a/references/image?name=${encodeURIComponent(item.image_file)}`,
      );
    }
    if (item.source === "file" && item.vibe_file) {
      const entry = library.find((candidate) => candidate.filename === item.vibe_file);
      if (entry?.has_preview) {
        return apiUrl(`/novelai4a/vibes/preview?name=${encodeURIComponent(item.vibe_file)}`);
      }
    }
    return "";
  };
  const inputPair = (
    item,
    key,
    label,
    minimum,
    maximum,
    step = 0.01,
    onCommit = null,
  ) => {
    const row = document.createElement("label");
    row.className = "nai4a-reference-field";
    const caption = document.createElement("span");
    caption.className = "nai4a-reference-field-label";
    caption.textContent = label;
    const controls = document.createElement("span");
    controls.className = "nai4a-reference-number";
    const number = document.createElement("input");
    number.type = "number";
    number.min = String(minimum);
    number.max = String(maximum);
    number.step = String(step);
    number.value = String(item[key]);
    const range = document.createElement("input");
    range.type = "range";
    range.min = String(minimum);
    range.max = String(maximum);
    range.step = String(step);
    range.value = String(item[key]);
    let committedValue = item[key];
    const apply = (source) => {
      item[key] = numberInRange(source.value, item[key], minimum, maximum);
      number.value = String(item[key]);
      range.value = String(item[key]);
    };
    const commit = (source) => {
      apply(source);
      if (Object.is(item[key], committedValue)) return;
      committedValue = item[key];
      if (onCommit) onCommit();
      else persist();
    };
    number.onchange = () => commit(number);
    number.onblur = () => commit(number);
    range.oninput = () => apply(range);
    range.onchange = () => commit(range);
    range.onblur = () => commit(range);
    controls.append(number, range);
    row.append(caption, controls);
    return row;
  };

  const encodeCard = async (item, button, status) => {
    persist();
    const confirmed = globalThis.confirm?.(
      `${t("模型")}: ${config.encode_model}\n`
      + `${t("Information Extracted：{value}", { value: item.information_extracted })}\n\n`
      + t("预计消耗 2 Anlas，是否继续？"),
    );
    if (confirmed === false) return;
    button.disabled = true;
    status.textContent = t("正在执行 Vibe 编码…");
    status.classList.remove("warning");
    let authorized = false;
    try {
      const authorization = await api.fetchApi("/novelai4a/vibes/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          node_id: String(node.id),
          card_id: item.id,
        }),
      });
      const authorizationPayload = await authorization.json();
      if (!authorization.ok) {
        throw new Error(authorizationPayload.error || t("无法取得一次性授权"));
      }
      authorized = true;
      const response = await api.fetchApi("/novelai4a/vibes/encode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          node_id: String(node.id),
          card_id: item.id,
          image_file: item.image_file,
          vibe_file: item.vibe_file,
          model: config.encode_model,
          information_extracted: item.information_extracted,
          strength: item.strength,
          name: item.name,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || t("Vibe 编码失败"));
      const current = itemsForMode("vibe").find((candidate) => candidate.id === item.id);
      if (current) {
        current.source = "file";
        current.vibe_file = payload.filename;
        current.vibe_cache_required = false;
        current.enabled = true;
        vibeMatchStates.delete(current.id);
      }
      library = Array.isArray(payload.items) ? payload.items : library;
      persist();
      renderAll();
      if (payload.cached !== true) scheduleNaiAccountRefresh(true);
    } catch (error) {
      if (authorized) {
        await api.fetchApi("/novelai4a/vibes/authorize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            node_id: String(node.id),
            card_id: item.id,
            action: "revoke",
          }),
        }).catch(() => {});
      }
      button.disabled = false;
      status.textContent = t("编码失败：{message}", {
        message: error.message || error,
      });
      status.classList.add("warning");
    }
  };

  const renderCard = (item, index) => {
    const card = document.createElement("section");
    card.className = `nai4a-reference-card ${config.mode}`;
    const header = document.createElement("div");
    header.className = "nai4a-reference-card-header";
    const title = document.createElement("div");
    title.className = "nai4a-reference-card-title";
    title.textContent = /^参考 \d+$/.test(item.name) ? t(item.name) : item.name;
    header.appendChild(title);
    const needsVibeMatch = config.mode === "vibe"
      && Boolean(item.image_file || item.vibe_file);
    const matchState = vibeMatchStates.get(item.id);
    const vibeUnavailable = needsVibeMatch && matchState?.matched !== true;
    const shownEnabled = item.enabled && !vibeUnavailable;
    card.classList.toggle("disabled", !shownEnabled);
    const actions = document.createElement("div");
    actions.className = "nai4a-reference-card-actions";
    const enable = document.createElement("button");
    enable.type = "button";
    enable.className = `nai4a-reference-action enable ${
      shownEnabled ? "enabled" : "disabled"
    }`;
    enable.innerHTML = shownEnabled
      ? '<svg viewBox="0 0 24 24"><path d="m5 12 4 4 10-10"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="m5 12 4 4 10-10"/><path d="M5 5l14 14"/></svg>';
    enable.disabled = vibeUnavailable;
    enable.title = vibeUnavailable
      ? t("编码可用后才能启用")
      : t(item.enabled ? "停用" : "启用");
    enable.onclick = () => {
      item.enabled = !item.enabled;
      persist();
      renderAll();
    };
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "nai4a-reference-action delete";
    remove.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    remove.title = t("删除");
    remove.onclick = () => {
      vibeMatchStates.delete(item.id);
      itemsForMode().splice(index, 1);
      persist();
      renderAll();
    };
    actions.append(enable, remove);
    header.appendChild(actions);

    const cardBody = document.createElement("div");
    cardBody.className = "nai4a-reference-card-body";
    const preview = document.createElement("div");
    preview.className = "nai4a-reference-preview";
    const source = previewFor(item);
    if (source) {
      const image = document.createElement("img");
      image.src = source;
      image.alt = item.name;
      preview.appendChild(image);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "nai4a-reference-placeholder";
      placeholder.textContent = item.source === "file"
        ? t("Vibe 编码文件")
        : t("拖入图片");
      preview.appendChild(placeholder);
    }
    const body = document.createElement("div");
    body.className = "nai4a-reference-parameters";

    if (config.mode === "vibe") {
      body.append(
        inputPair(
          item,
          "information_extracted",
          "Information Extracted",
          0.01,
          1,
          0.01,
          () => invalidateVibeMatch(item),
        ),
        inputPair(item, "strength", "Reference Strength", 0.01, 1),
      );
      const encodeRow = document.createElement("div");
      encodeRow.className = "nai4a-reference-encode-row";
      const status = document.createElement("div");
      status.className = "nai4a-reference-status";
      const encode = document.createElement("button");
      encode.type = "button";
      encode.className = "nai4a-reference-encode";
      encode.textContent = t("编码并保存（预计 2 Anlas）");
      const ready = !needsVibeMatch || matchState?.matched === true;
      if (ready) {
        encode.disabled = true;
        encode.title = t("当前 Information Extracted 已有对应编码");
      } else if (!matchState || matchState.status === "loading") {
        status.textContent = t("正在检查当前 Information Extracted 的 Vibe 编码…");
        encode.disabled = true;
      } else if (matchState.status === "error") {
        status.textContent = t("Vibe 编码检查失败：{message}", {
          message: matchState.error,
        });
        status.classList.add("warning");
        encode.disabled = matchState.canEncode === false;
      } else {
        if (matchState.canEncode === false) {
          status.textContent = t("没有匹配当前 Information Extracted 的编码，且该文件不包含可重新编码的原图。");
          encode.disabled = true;
        } else {
          status.textContent = t("没有匹配当前 Information Extracted 的 Vibe 编码。");
        }
      }
      encode.onclick = () => encodeCard(item, encode, status);
      encodeRow.append(status, encode);
      body.appendChild(encodeRow);
      if (needsVibeMatch) {
        Promise.resolve().then(() => ensureVibeMatch(item));
      }
    } else {
      const kind = document.createElement("select");
      kind.className = "nai4a-reference-kind";
      for (const [value, label] of [
        ["character&style", "角色与风格"],
        ["character", "角色"],
        ["style", "风格"],
      ]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = t(label);
        kind.appendChild(option);
      }
      kind.value = item.reference_content;
      kind.onchange = () => {
        item.reference_content = kind.value;
        persist();
      };
      body.append(
        kind,
        inputPair(item, "strength", "Strength", 0, 1),
        inputPair(item, "fidelity", "Fidelity", 0, 1),
      );
    }
    cardBody.append(preview, body);
    card.append(header, cardBody);
    return card;
  };

  function renderAll() {
    list.replaceChildren();
    vibeMode.classList.toggle("active", config.mode === "vibe");
    preciseMode.classList.toggle("active", config.mode === "precise");
    modelRow.hidden = config.mode !== "vibe";
    modelSelect.value = config.encode_model;
    const activeItems = itemsForMode();
    if (activeItems.length) {
      activeItems.forEach((item, index) => list.appendChild(renderCard(item, index)));
    }
  }

  vibeMode.onclick = () => {
    config.mode = "vibe";
    persist();
    renderAll();
  };
  preciseMode.onclick = () => {
    config.mode = "precise";
    persist();
    renderAll();
  };
  modelSelect.onchange = () => {
    config.encode_model = modelSelect.value;
    for (const item of itemsForMode("vibe")) {
      if (!item.image_file && !item.vibe_file) continue;
      item.vibe_cache_required = true;
      item.enabled = false;
      vibeMatchStates.delete(item.id);
    }
    persist();
    renderAll();
  };

  const uploadDroppedFile = async (file) => {
    if (looksLikeVibeFile(file)) {
      if (config.mode !== "vibe") {
        throw new Error(t(".naiv4vibe 只能拖入 Vibe 模式"));
      }
      const vibeItems = itemsForMode("vibe");
      if (vibeItems.length >= 16) throw new Error(t("Vibe 最多支持 16 个资源"));
      const form = new FormData();
      form.append("file", file, file.name);
      const response = await api.fetchApi("/novelai4a/vibes/upload", {
        method: "POST",
        body: form,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || t("Vibe 文件读取失败"));
      library = Array.isArray(payload.items) ? payload.items : library;
      const summary = library.find((entry) => entry.filename === payload.filename);
      const item = defaultNaiReferenceItem(vibeItems.length);
      item.name = String(summary?.name || file.name.replace(/\.naiv4vibe(?:bundle)?$/i, ""));
      item.source = "file";
      item.vibe_file = payload.filename;
      item.image_file = "";
      const availableInformation = Array.isArray(summary?.information_extracted)
        ? summary.information_extracted
        : [];
      if (availableInformation.length) {
        item.information_extracted = availableInformation.includes(0.7)
          ? 0.7
          : Number(availableInformation[0]);
      }
      item.vibe_cache_required = true;
      item.enabled = false;
      vibeItems.push(item);
      return;
    }
    if (!looksLikeImageFile(file)) throw new Error(t("只支持图片或 .naiv4vibe 文件"));
    if (file.size > MAX_IMAGE_BYTES) throw new Error(t("图片不能超过 32 MB"));
    const activeItems = itemsForMode();
    if (config.mode === "vibe" && activeItems.length >= 16) {
      throw new Error(t("Vibe 最多支持 16 个资源"));
    }
    const form = new FormData();
    form.append("file", file, file.name);
    const response = await api.fetchApi("/novelai4a/references/upload-image", {
      method: "POST",
      body: form,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || t("参考图片读取失败"));
    const item = defaultNaiReferenceItem(activeItems.length);
    item.name = String(payload.name || file.name.replace(/\.[^.]+$/, "") || item.name);
    item.source = "image";
    item.image_file = payload.filename;
    item.vibe_file = "";
    item.vibe_cache_required = config.mode === "vibe";
    item.enabled = config.mode !== "vibe";
    activeItems.push(item);
  };

  const importTransfer = async (dataTransfer) => {
    const files = await referenceFilesFromTransfer(dataTransfer);
    if (!files.length) return false;
    const errors = [];
    for (const file of files) {
      try {
        await uploadDroppedFile(file);
      } catch (error) {
        errors.push(`${file.name || t("文件")}: ${t(error.message || error)}`);
      }
    }
    persist();
    renderAll();
    if (errors.length) globalThis.alert?.(errors.join("\n"));
    return files.length > errors.length;
  };
  const setOuterDropHighlight = (active) => {
    if (active) app.dragOverNode = node;
    else if (app.dragOverNode === node || app.dragOverNode?.id === node.id) {
      app.dragOverNode = null;
    }
    node.setDirtyCanvas?.(false, true);
    app.canvas?.setDirty?.(false, true);
  };
  const acceptsInnerDrop = (event) => {
    if (!hasSupportedReferenceTransfer(event?.dataTransfer)) return false;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    setOuterDropHighlight(true);
    return true;
  };
  main.addEventListener("dragenter", acceptsInnerDrop);
  main.addEventListener("dragover", acceptsInnerDrop);
  main.addEventListener("dragleave", (event) => {
    if (!main.contains(event.relatedTarget)) setOuterDropHighlight(false);
  });
  main.addEventListener("drop", async (event) => {
    if (!acceptsInnerDrop(event)) return;
    setOuterDropHighlight(false);
    await importTransfer(event.dataTransfer).catch(
      (error) => globalThis.alert?.(t("参考资源读取失败：{message}", {
        message: error.message || error,
      })),
    );
  });
  const originalOnDragDrop = node.onDragDrop;
  node.onDragDrop = async function (event) {
    if (hasSupportedReferenceTransfer(event?.dataTransfer)) {
      setOuterDropHighlight(false);
      return importTransfer(event.dataTransfer);
    }
    return originalOnDragDrop?.apply(this, arguments) ?? false;
  };
  const originalOnDragOver = node.onDragOver;
  node.onDragOver = function (event) {
    if (hasSupportedReferenceTransfer(event?.dataTransfer)) return true;
    return originalOnDragOver?.apply(this, arguments) ?? false;
  };

  const originalRemoved = node.onRemoved;
  node.onRemoved = function () {
    setOuterDropHighlight(false);
    main.remove();
    delete node.__nai4aReferenceReady;
    return originalRemoved?.apply(this, arguments);
  };

  referenceWidget = node.addDOMWidget(
    "nai4a-reference-ui",
    "nai4a-reference",
    main,
    withSyncedDomWidth({
      serialize: false,
      hideOnZoom: false,
      margin: 0,
      getMinHeight: () => 220,
      getMaxHeight: () => {
        const measuredTop = Number(referenceWidget?.last_y);
        const widgetTop = Number.isFinite(measuredTop) && measuredTop > 0
          ? measuredTop
          : 55;
        return Math.max(220, Number(node.size?.[1] || 330) - widgetTop - 8);
      },
    }),
  );
  node.resizable = true;
  persist();
  renderAll();
  node.setSize?.([
    Math.max(420, Number(node.size?.[0]) || 0),
    Math.max(330, Number(node.size?.[1]) || 0),
  ]);
  void refreshLibrary().catch(() => {});
}

app.registerExtension({
  name: "ComfyUI-4A-NovelAI.NAIReference",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NAI_REFERENCE_NODE_CLASS) return;
    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      originalCreated?.apply(this, arguments);
      setupReferenceNode(this);
    };
  },
});
