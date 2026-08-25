import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
  NAI4A_SAMPLER_RESOLUTION_EVENT,
  connectedGraphNodes,
  createNaiTranslator,
  hideNaiInternalWidget,
  naiNodeClass,
  setNaiWidgetVisible,
  withSyncedDomWidth,
  writeNaiNodeWidget,
} from "./nai_frontend_helpers.js";

export const NAI_SAMPLER_NODE_CLASS = "NovelAI4ASampler";
export const NAI_SAMPLER_NODE_DISPLAY_NAME = "NAI Sampler";
export const NAI_IMAGE_INPUT_NODE_CLASS = "NovelAI4AImageInput";
export const NAI_SAMPLER_PARAMETER_NAMES = Object.freeze([
  "steps",
  "cfg",
  "sampler",
  "scheduler",
  "cfg_rescale",
]);
export const NAI_RESOLUTION_PRESETS = Object.freeze({
  Normal: Object.freeze([[832, 1216], [1024, 1024], [1216, 832]]),
  Large: Object.freeze([[1024, 1536], [1472, 1472], [1536, 1024]]),
  Wallpaper: Object.freeze([[1088, 1920], [1920, 1088]]),
  Small: Object.freeze([[512, 768], [640, 640], [768, 512]]),
});
export const NAI_ASPECT_RATIOS = Object.freeze({
  "1:1": Object.freeze([1, 1]),
  "4:5": Object.freeze([4, 5]),
  "5:4": Object.freeze([5, 4]),
  "3:4": Object.freeze([3, 4]),
  "4:3": Object.freeze([4, 3]),
  "2:3": Object.freeze([2, 3]),
  "3:2": Object.freeze([3, 2]),
  "9:16": Object.freeze([9, 16]),
  "16:9": Object.freeze([16, 9]),
});

const RESOLUTION_TIERS = Object.freeze(Object.keys(NAI_RESOLUTION_PRESETS));
const RESOLUTION_TIER_LABELS = Object.freeze({
  Small: "小图",
  Normal: "普通",
  Large: "大图",
  Wallpaper: "壁纸",
});
const SWAP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h14M15 4l3 3-3 3M20 17H6M9 14l-3 3 3 3"/></svg>';

function naiToggleOn(widget) {
  return widget?.value === true || widget?.value === 1 || widget?.value === "true";
}

function imageInputControlWidgets(node) {
  const budgetWidget = node?.widgets?.find((widget) => widget?.name === "scale_to_budget");
  const sizeClassWidget = node?.widgets?.find((widget) => widget?.name === "size_class");
  const upscaleWidget = node?.widgets?.find((widget) => widget?.name === "upscale");
  const upscaleScaleWidget = node?.widgets?.find((widget) => widget?.name === "upscale_scale");
  if (!budgetWidget || !sizeClassWidget || !upscaleWidget || !upscaleScaleWidget) {
    return null;
  }
  return { budgetWidget, sizeClassWidget, upscaleWidget, upscaleScaleWidget };
}

function syncNaiImageInputMode(node, changed) {
  const controls = imageInputControlWidgets(node);
  if (!controls || node.__nai4aImageInputSyncing) return false;
  const { budgetWidget, sizeClassWidget, upscaleWidget, upscaleScaleWidget } = controls;
  node.__nai4aImageInputSyncing = true;
  try {
    if (changed === "upscale" && naiToggleOn(upscaleWidget)) {
      writeNaiNodeWidget(node, budgetWidget, false);
    } else if (changed === "budget" && naiToggleOn(budgetWidget)) {
      writeNaiNodeWidget(node, upscaleWidget, false);
    }
    setNaiWidgetVisible(sizeClassWidget, naiToggleOn(budgetWidget));
    setNaiWidgetVisible(upscaleScaleWidget, naiToggleOn(upscaleWidget));
    if (typeof node.setSize === "function" && typeof node.computeSize === "function") {
      node.setSize(node.computeSize());
    }
    node.setDirtyCanvas?.(true, true);
  } finally {
    node.__nai4aImageInputSyncing = false;
  }
  return true;
}

function currentImageInputMode(node) {
  const controls = imageInputControlWidgets(node);
  return controls && naiToggleOn(controls.upscaleWidget) ? "upscale" : "budget";
}

export function setupNaiImageInputNode(node, hostApp = app) {
  const controls = imageInputControlWidgets(node);
  if (!node || !controls) return false;
  const { budgetWidget, sizeClassWidget, upscaleWidget } = controls;

  if (!node.__nai4aImageInputReady) {
    node.__nai4aImageInputReady = true;
    const t = createNaiTranslator(hostApp);
    const previousLabel = sizeClassWidget.options?.getOptionLabel;
    sizeClassWidget.options = sizeClassWidget.options || {};
    sizeClassWidget.options.getOptionLabel = (value) => {
      const raw = String(value ?? "");
      const label = RESOLUTION_TIER_LABELS[raw];
      if (label) return t(label);
      return previousLabel?.(value) ?? raw;
    };
    const wrapCallback = (widget, changed) => {
      const previous = widget.callback;
      widget.callback = function () {
        const result = previous?.apply(this, arguments);
        syncNaiImageInputMode(node, changed);
        return result;
      };
    };
    wrapCallback(budgetWidget, "budget");
    wrapCallback(upscaleWidget, "upscale");
    const originalConfigure = node.onConfigure?.bind(node);
    node.onConfigure = function (info) {
      const result = originalConfigure?.apply(this, arguments);
      const mode = currentImageInputMode(this);
      syncNaiImageInputMode(this, mode);
      globalThis.requestAnimationFrame?.(() => {
        syncNaiImageInputMode(this, currentImageInputMode(this));
      });
      return result;
    };
  }

  syncNaiImageInputMode(node, currentImageInputMode(node));
  return true;
}

export function isNaiSamplerNode(node) {
  const className = naiNodeClass(node);
  return (
    className === NAI_SAMPLER_NODE_CLASS
    || className === NAI_SAMPLER_NODE_DISPLAY_NAME
  );
}

function allNaiSamplerNodes() {
  const results = [];
  const visit = (graph) => {
    for (const node of graph?._nodes || graph?.nodes || []) {
      if (isNaiSamplerNode(node)) results.push(node);
      if (node?.subgraph) visit(node.subgraph);
    }
  };
  visit(app.graph);
  return results;
}

export function selectedNaiSamplerNodes(payload) {
  const all = allNaiSamplerNodes();
  if (Array.isArray(payload?.node_ids) && payload.node_ids.length) {
    const ids = new Set(payload.node_ids.map((entry) => String(entry?.node_id ?? entry)));
    return all.filter((node) => ids.has(String(node.id)));
  }
  const source = app.canvas?.selected_nodes;
  const selected = (source instanceof Map ? [...source.values()] : Object.values(source || {}))
    .filter(isNaiSamplerNode);
  if (selected.length) return selected;
  if (all.length === 1) return all;
  return [];
}

export function isNaiSamplerSettingsEvent(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  if (
    Object.prototype.hasOwnProperty.call(payload, "node_class")
    && payload.node_class !== NAI_SAMPLER_NODE_DISPLAY_NAME
    && payload.node_class !== NAI_SAMPLER_NODE_CLASS
  ) return false;
  if (
    Object.prototype.hasOwnProperty.call(payload, "target_mode")
    && String(payload.target_mode || "").toLowerCase() !== "nai"
  ) return false;
  return (
    Object.prototype.hasOwnProperty.call(payload, "node_class")
    || Object.prototype.hasOwnProperty.call(payload, "target_mode")
  );
}

export function roundNaiDimension(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.max(64, Math.min(2048, Math.round(value / 64) * 64));
}

function nearestResolutionAnchor(tier, ratio) {
  const anchors = NAI_RESOLUTION_PRESETS[tier] || NAI_RESOLUTION_PRESETS.Normal;
  return anchors.reduce((best, anchor) => (
    Math.abs(Math.log(ratio / (anchor[0] / anchor[1])))
      < Math.abs(Math.log(ratio / (best[0] / best[1])))
      ? anchor
      : best
  ), anchors[0]);
}

export function naiDimensionsForTier(
  tier,
  sourceWidth,
  sourceHeight,
  currentWidth = 832,
  currentHeight = 1216,
) {
  const width = Number(sourceWidth);
  const height = Number(sourceHeight);
  if (!(width > 0) || !(height > 0)) {
    return [
      roundNaiDimension(currentWidth) ?? 832,
      roundNaiDimension(currentHeight) ?? 1216,
    ];
  }
  const ratio = width / height;
  const anchor = nearestResolutionAnchor(tier, ratio);
  const area = anchor[0] * anchor[1];
  let nextWidth = Math.sqrt(area * ratio);
  let nextHeight = Math.sqrt(area / ratio);
  const longest = Math.max(nextWidth, nextHeight);
  if (longest > 2048) {
    const scale = 2048 / longest;
    nextWidth *= scale;
    nextHeight *= scale;
  }
  return [
    roundNaiDimension(nextWidth) ?? 832,
    roundNaiDimension(nextHeight) ?? 1216,
  ];
}

export function naiDimensionsForRatio(
  tier,
  ratioKey,
  currentWidth = 832,
  currentHeight = 1216,
) {
  const ratio = NAI_ASPECT_RATIOS[ratioKey] || [currentWidth, currentHeight];
  return naiDimensionsForTier(tier, ratio[0], ratio[1], currentWidth, currentHeight);
}

export function readNaiSamplerResolution(node, fallback = { width: 832, height: 1216 }) {
  const width = roundNaiDimension(
    node?.widgets?.find((widget) => widget?.name === "width")?.value,
  );
  const height = roundNaiDimension(
    node?.widgets?.find((widget) => widget?.name === "height")?.value,
  );
  return {
    width: width ?? fallback.width,
    height: height ?? fallback.height,
  };
}

export function findConnectedNaiSamplers(schedulerNode) {
  return connectedGraphNodes(schedulerNode, "downstream").filter(isNaiSamplerNode);
}

export function resolveConnectedNaiSampler(schedulerNode) {
  const samplers = findConnectedNaiSamplers(schedulerNode);
  return samplers.length === 1 ? samplers[0] : null;
}

export function notifyNaiSamplerResolution(node, scope = globalThis) {
  const resolution = readNaiSamplerResolution(node);
  const detail = {
    sampler_id: node?.id,
    width: resolution.width,
    height: resolution.height,
  };
  for (const candidate of connectedGraphNodes(node, "upstream")) {
    candidate.__nai4aSchedulerReceiveSamplerResolution?.(detail);
  }
  if (typeof scope.dispatchEvent === "function") {
    const EventClass = scope.CustomEvent;
    if (typeof EventClass === "function") {
      scope.dispatchEvent(new EventClass(NAI4A_SAMPLER_RESOLUTION_EVENT, { detail }));
    }
  }
  return detail;
}

export function snapshotNaiSamplerParameters(node) {
  if (!Array.isArray(node?.widgets)) return null;
  const values = NAI_SAMPLER_PARAMETER_NAMES
    .map((name) => {
      const widget = node.widgets.find((candidate) => candidate?.name === name);
      return widget ? { name, value: widget.value } : null;
    })
    .filter(Boolean);
  return { id: node.id, values };
}

export function restoreNaiSamplerParameters(node, snapshot) {
  if (!Array.isArray(node?.widgets) || !snapshot) return [];
  const restored = [];
  for (const entry of snapshot.values || []) {
    if (!NAI_SAMPLER_PARAMETER_NAMES.includes(entry?.name)) continue;
    const widget = node.widgets.find((candidate) => candidate?.name === entry.name);
    if (!widget) continue;
    writeNaiNodeWidget(node, widget, entry.value, { callback: true });
    restored.push(entry.name);
  }
  node.setDirtyCanvas?.(true, true);
  node.graph?.setDirtyCanvas?.(true, true);
  return restored;
}

export function snapshotNaiSamplerResolution(node) {
  if (!Array.isArray(node?.widgets)) return null;
  const values = ["size_class", "aspect_ratio", "width", "height"]
    .map((name) => {
      const widget = node.widgets.find((candidate) => candidate?.name === name);
      return widget ? { name, value: widget.value } : null;
    })
    .filter(Boolean);
  return {
    id: node.id,
    tier: node.properties?.nai4a_resolution_tier || "Normal",
    values,
  };
}

export function restoreNaiSamplerResolution(node, snapshot) {
  if (!Array.isArray(node?.widgets) || !snapshot) return [];
  node.properties = node.properties || {};
  node.properties.nai4a_resolution_tier = RESOLUTION_TIERS.includes(snapshot.tier)
    ? snapshot.tier
    : "Normal";
  const restored = [];
  for (const entry of snapshot.values || []) {
    const widget = node.widgets.find((candidate) => candidate?.name === entry.name);
    if (!widget) continue;
    writeNaiNodeWidget(node, widget, entry.value, { callback: true });
    restored.push(entry.name);
  }
  node.__nai4aSamplerSyncResolution?.();
  notifyNaiSamplerResolution(node);
  node.setDirtyCanvas?.(true, true);
  node.graph?.setDirtyCanvas?.(true, true);
  return restored;
}

/**
 * A wildcard card's width/height are only an aspect-ratio hint. The selected
 * sampler tier supplies the target area, so the card never copies its pixels
 * directly into the sampler.
 */
export function applyNaiSamplerRatioHint(node, plan) {
  const hint = plan?.ratio_hint || plan?.source_resolution;
  const sourceWidth = Number(hint?.width);
  const sourceHeight = Number(hint?.height);
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) return null;
  const current = readNaiSamplerResolution(node);
  const tier = RESOLUTION_TIERS.includes(node?.properties?.nai4a_resolution_tier)
    ? node.properties.nai4a_resolution_tier
    : "Normal";
  const [width, height] = naiDimensionsForTier(
    tier,
    sourceWidth,
    sourceHeight,
    current.width,
    current.height,
  );
  if (typeof node?.__nai4aSamplerSetResolution === "function") {
    node.__nai4aSamplerSetResolution(width, height);
  } else {
    const widthWidget = node?.widgets?.find((widget) => widget?.name === "width");
    const heightWidget = node?.widgets?.find((widget) => widget?.name === "height");
    writeNaiNodeWidget(node, widthWidget, width, { callback: true });
    writeNaiNodeWidget(node, heightWidget, height, { callback: true });
    notifyNaiSamplerResolution(node);
  }
  return { width, height, tier };
}

/**
 * Apply only the five card-controlled sampling fields. Width and height are
 * intentionally excluded: a card's resolution is a ratio hint, not an
 * instruction to overwrite the sampler.
 */
export function applyNaiSamplerSettingsPlan(node, plan) {
  if (!Array.isArray(node?.widgets) || !plan || typeof plan !== "object") {
    return { updated: [], skipped: ["plan"] };
  }
  const parameters = plan.parameters && typeof plan.parameters === "object"
    ? plan.parameters
    : plan;
  const updated = [];
  const skipped = [];
  for (const name of NAI_SAMPLER_PARAMETER_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(parameters, name)) continue;
    const widget = node.widgets.find((candidate) => candidate?.name === name);
    if (!widget) {
      skipped.push(name);
      continue;
    }
    writeNaiNodeWidget(node, widget, parameters[name], { callback: true });
    updated.push(name);
  }
  node.setDirtyCanvas?.(true, true);
  node.graph?.setDirtyCanvas?.(true, true);
  return { updated, skipped };
}

function injectStyles() {
  if (document.getElementById("nai4a-sampler-styles")) return;
  const style = document.createElement("style");
  style.id = "nai4a-sampler-styles";
  style.textContent = `
    .nai4a-resolution { width:100%; height:48px; padding:2px 16px 1px; display:grid; grid-template-columns:minmax(92px,.85fr) minmax(108px,1fr) minmax(0,1.35fr) 24px; gap:6px; align-items:center; box-sizing:border-box; color:#ddd; font:11px/1 system-ui,sans-serif; }
    .nai4a-resolution * { box-sizing:border-box; }
    .nai4a-resolution-select, .nai4a-resolution-input { width:100%; height:24px; padding:2px 7px; border:1px solid #555b62; border-radius:6px; outline:0; color:#eee; background:#202328; font:inherit; }
    .nai4a-resolution-select { cursor:pointer; }
    .nai4a-resolution-dimensions { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:5px; }
    .nai4a-resolution-field { position:relative; min-width:0; }
    .nai4a-resolution-label { position:absolute; z-index:1; left:7px; top:50%; transform:translateY(-50%); color:#8f98a3; pointer-events:none; }
    .nai4a-resolution-input { padding-left:28px; text-align:right; appearance:textfield; -moz-appearance:textfield; }
    .nai4a-resolution-input::-webkit-inner-spin-button, .nai4a-resolution-input::-webkit-outer-spin-button { margin:0; -webkit-appearance:none; appearance:none; }
    .nai4a-resolution-swap { width:24px; height:24px; padding:3px; display:grid; place-items:center; border:0; border-radius:4px; color:#c8cdd2; background:transparent; cursor:pointer; }
    .nai4a-resolution-swap:hover { color:#fff; background:#3a3e43; }
    .nai4a-resolution-swap svg { width:17px; height:17px; fill:none; stroke:currentColor; stroke-width:1.9; stroke-linecap:round; stroke-linejoin:round; pointer-events:none; }
  `;
  document.head.appendChild(style);
}

export function setupNaiSamplerNode(node, hostApp = app) {
  if (!node || node.__nai4aSamplerReady) return false;
  const widthWidget = node.widgets?.find((widget) => widget?.name === "width");
  const heightWidget = node.widgets?.find((widget) => widget?.name === "height");
  const sizeClassWidget = node.widgets?.find((widget) => widget?.name === "size_class");
  const aspectRatioWidget = node.widgets?.find((widget) => widget?.name === "aspect_ratio");
  if (!widthWidget || !heightWidget || typeof node.addDOMWidget !== "function") return false;
  node.__nai4aSamplerReady = true;
  injectStyles();
  const t = createNaiTranslator(hostApp);
  const initialSizeClass = String(sizeClassWidget?.value || "");
  const initialAspectRatio = String(aspectRatioWidget?.value || "");
  if (RESOLUTION_TIERS.includes(initialSizeClass)) {
    const anchors = NAI_RESOLUTION_PRESETS[initialSizeClass];
    const anchorIndex = initialAspectRatio === "Landscape"
      ? anchors.length - 1
      : initialAspectRatio === "Square"
        ? Math.floor(anchors.length / 2)
        : 0;
    const anchor = anchors[anchorIndex];
    writeNaiNodeWidget(node, widthWidget, anchor[0]);
    writeNaiNodeWidget(node, heightWidget, anchor[1]);
  }
  hideNaiInternalWidget(widthWidget);
  hideNaiInternalWidget(heightWidget);
  hideNaiInternalWidget(sizeClassWidget);
  hideNaiInternalWidget(aspectRatioWidget);
  node.properties = node.properties || {};
  if (!RESOLUTION_TIERS.includes(node.properties.nai4a_resolution_tier)) {
    node.properties.nai4a_resolution_tier = RESOLUTION_TIERS.includes(initialSizeClass)
      ? initialSizeClass
      : "Normal";
  }
  writeNaiNodeWidget(node, sizeClassWidget, "Custom");

  const root = document.createElement("div");
  root.className = "nai4a-resolution";
  root.addEventListener("pointerdown", (event) => event.stopPropagation());
  root.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
  const tierSelect = document.createElement("select");
  tierSelect.className = "nai4a-resolution-select";
  tierSelect.setAttribute("aria-label", t("分辨率档位"));
  for (const tier of RESOLUTION_TIERS) {
    const option = document.createElement("option");
    option.value = tier;
    option.textContent = t({
      Normal: "普通",
      Large: "大图",
      Wallpaper: "壁纸",
      Small: "小图",
    }[tier] || tier);
    tierSelect.appendChild(option);
  }
  const ratioSelect = document.createElement("select");
  ratioSelect.className = "nai4a-resolution-select";
  ratioSelect.setAttribute("aria-label", t("画面比例"));
  const currentOption = document.createElement("option");
  currentOption.value = "current";
  ratioSelect.appendChild(currentOption);
  for (const key of Object.keys(NAI_ASPECT_RATIOS)) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = key;
    ratioSelect.appendChild(option);
  }
  const swap = document.createElement("button");
  swap.type = "button";
  swap.className = "nai4a-resolution-swap";
  swap.innerHTML = SWAP_ICON;
  swap.title = t("交换宽高（不重新计算）");
  swap.setAttribute("aria-label", swap.title);
  const dimensions = document.createElement("div");
  dimensions.className = "nai4a-resolution-dimensions";
  const dimensionInput = (label) => {
    const field = document.createElement("label");
    field.className = "nai4a-resolution-field";
    const caption = document.createElement("span");
    caption.className = "nai4a-resolution-label";
    caption.textContent = label;
    const input = document.createElement("input");
    input.className = "nai4a-resolution-input";
    input.type = "number";
    input.min = "64";
    input.max = "2048";
    input.step = "64";
    field.append(caption, input);
    dimensions.appendChild(field);
    return input;
  };
  const widthInput = dimensionInput("W");
  const heightInput = dimensionInput("H");
  root.append(tierSelect, ratioSelect, dimensions, swap);

  const sync = () => {
    const current = readNaiSamplerResolution(node);
    tierSelect.value = node.properties.nai4a_resolution_tier;
    widthInput.value = String(current.width);
    heightInput.value = String(current.height);
    const ratio = current.width / current.height;
    let nearest = "current";
    let distance = Number.POSITIVE_INFINITY;
    for (const [key, [rw, rh]] of Object.entries(NAI_ASPECT_RATIOS)) {
      const candidate = Math.abs(Math.log(ratio / (rw / rh)));
      if (candidate < distance) {
        nearest = key;
        distance = candidate;
      }
    }
    ratioSelect.value = distance <= 0.04 ? nearest : "current";
    currentOption.textContent = `${t("当前比例")} ${current.width} × ${current.height}`;
    return current;
  };
  const setResolution = (width, height) => {
    const nextWidth = roundNaiDimension(width);
    const nextHeight = roundNaiDimension(height);
    if (nextWidth === null || nextHeight === null) return false;
    const aspectRatio = Math.abs(nextWidth - nextHeight) <= 32
      ? "Square"
      : nextWidth > nextHeight
        ? "Landscape"
        : "Portrait";
    writeNaiNodeWidget(node, sizeClassWidget, "Custom");
    writeNaiNodeWidget(node, aspectRatioWidget, aspectRatio);
    const widthChanged = writeNaiNodeWidget(
      node,
      widthWidget,
      nextWidth,
      { callback: true },
    );
    const heightChanged = writeNaiNodeWidget(
      node,
      heightWidget,
      nextHeight,
      { callback: true },
    );
    const changed = widthChanged || heightChanged;
    sync();
    if (changed) {
      node.setDirtyCanvas?.(true, true);
      node.graph?.setDirtyCanvas?.(true, true);
      node.graph?.change?.();
      notifyNaiSamplerResolution(node);
    }
    return changed;
  };

  tierSelect.onchange = () => {
    node.properties.nai4a_resolution_tier = RESOLUTION_TIERS.includes(tierSelect.value)
      ? tierSelect.value
      : "Normal";
    const current = readNaiSamplerResolution(node);
    setResolution(...naiDimensionsForTier(
      node.properties.nai4a_resolution_tier,
      current.width,
      current.height,
      current.width,
      current.height,
    ));
  };
  ratioSelect.onchange = () => {
    if (ratioSelect.value === "current") return;
    const current = readNaiSamplerResolution(node);
    setResolution(...naiDimensionsForRatio(
      node.properties.nai4a_resolution_tier,
      ratioSelect.value,
      current.width,
      current.height,
    ));
  };
  for (const input of [widthInput, heightInput]) {
    input.onchange = () => setResolution(
      input === widthInput ? input.value : widthWidget.value,
      input === heightInput ? input.value : heightWidget.value,
    );
    input.onkeydown = (event) => {
      if (event.key === "Enter") input.blur();
    };
  }
  swap.onclick = () => setResolution(heightWidget.value, widthWidget.value);

  node.__nai4aSamplerSyncResolution = sync;
  node.__nai4aSamplerSetResolution = setResolution;
  const resolutionWidget = node.addDOMWidget(
    "nai4a-resolution-ui",
    "nai4a-resolution",
    root,
    withSyncedDomWidth({
      serialize: false,
      hideOnZoom: false,
      margin: 0,
      getMinHeight: () => 48,
      getMaxHeight: () => 48,
    }),
  );
  const firstVisibleWidget = node.widgets?.findIndex((widget) => (
    widget !== widthWidget
    && widget !== heightWidget
    && widget !== resolutionWidget
    && widget?.type !== "hidden"
  ));
  const resolutionIndex = node.widgets?.indexOf(resolutionWidget) ?? -1;
  if (resolutionIndex >= 0 && firstVisibleWidget >= 0) {
    node.widgets.splice(resolutionIndex, 1);
    node.widgets.splice(firstVisibleWidget, 0, resolutionWidget);
  }

  const originalConfigure = node.onConfigure?.bind(node);
  node.onConfigure = function (info) {
    const result = originalConfigure?.(info);
    requestAnimationFrame(() => {
      if (node.__nai4aSamplerReady) {
        hideNaiInternalWidget(widthWidget);
        hideNaiInternalWidget(heightWidget);
        hideNaiInternalWidget(sizeClassWidget);
        hideNaiInternalWidget(aspectRatioWidget);
        writeNaiNodeWidget(node, sizeClassWidget, "Custom");
        sync();
        notifyNaiSamplerResolution(node);
      }
    });
    return result;
  };
  const originalRemoved = node.onRemoved?.bind(node);
  node.onRemoved = function () {
    root.remove();
    delete node.__nai4aSamplerSyncResolution;
    delete node.__nai4aSamplerSetResolution;
    delete node.__nai4aSamplerReady;
    return originalRemoved?.apply(this, arguments);
  };
  sync();
  requestAnimationFrame(() => notifyNaiSamplerResolution(node));
  return true;
}

app.registerExtension({
  name: "ComfyUI-4A-NovelAI.NAISampler",
  setup() {
    api.addEventListener("pm4a_nai_settings_update", (event) => {
      const payload = event?.detail || {};
      if (!isNaiSamplerSettingsEvent(payload)) return;
      const plan = payload.nai || payload.settings || payload.plan || {};
      for (const node of selectedNaiSamplerNodes(payload)) {
        applyNaiSamplerSettingsPlan(node, plan);
      }
    });
  },
  loadedGraphNode(node) {
    if (naiNodeClass(node) !== NAI_IMAGE_INPUT_NODE_CLASS) return;
    setupNaiImageInputNode(node);
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NAI_IMAGE_INPUT_NODE_CLASS) return;
    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      originalCreated?.apply(this, arguments);
      setupNaiImageInputNode(this);
    };
    const originalConfigured = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const result = originalConfigured?.apply(this, arguments);
      setupNaiImageInputNode(this);
      return result;
    };
  },
});
