import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
  createNaiTranslator,
  hideNaiInternalWidget,
  withSyncedDomWidth,
  writeNaiNodeWidget,
} from "./nai_frontend_helpers.js";
import {
  bindOfficialImageDrop,
  buildStoredImageUrl,
  imageFileFromTransfer,
  normalizeStoredImageReference,
  uploadInputImage,
} from "./nai_image_drop.js";
import {
  META_MODEL_PROPERTY,
  META_SAMPLER_PROPERTY,
  META_SCHEDULER_PROPERTY,
  applyNaiMetadata,
  naiModelNodes,
  naiSamplerNodes,
  naiSchedulerNodes,
  naiTargetLabel,
  readNaiMetadataSnapshot,
  sendAllNaiPrompts,
  sendNaiMetadataCharacter,
} from "./nai_meta_core.js";

const NODE_CLASS = "NAI Meta Loader";
const IMAGE_REF_PROPERTY = "nai4a_imported_image_ref";
const RETURN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7 4 12l5 5M5 12h9a5 5 0 0 1 5 5"/></svg>';
const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v10A1.5 1.5 0 0 0 5.5 17H8"/></svg>';
const APPLY_ALL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="11" height="8" rx="1.5"/><path d="M7 2h10a1.5 1.5 0 0 1 1.5 1.5V10M10 18h10M16 14l4 4-4 4"/></svg>';
const APPLY_PARAMETERS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h9M3 12h7M3 18h9M8 4v4M6 10v4M9 16v4M14 12h6M17 9l3 3-3 3"/></svg>';

function injectStyles() {
  if (document.getElementById("nai4a-meta-loader-styles")) return;
  const style = document.createElement("style");
  style.id = "nai4a-meta-loader-styles";
  style.textContent = `
    .nai4a-meta-loader { width:100%; height:100%; min-height:0; padding:0 4px 2px; display:flex; flex-direction:column; gap:7px; overflow:hidden; box-sizing:border-box; color:#e8e8e8; background:transparent; border:0; border-radius:0; font:12px/1.35 system-ui,sans-serif; }
    .nai4a-meta-loader * { box-sizing:border-box; }
    .nai4a-meta-summary { min-height:28px; padding:3px 5px 3px 7px; display:flex; align-items:center; gap:6px; border:1px solid #464a50; border-radius:5px; background:#292c30; }
    .nai4a-meta-title { min-width:80px; flex:1; font-weight:700; color:#e6e8ea; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .nai4a-meta-status { min-width:0; max-width:42%; color:#9ca3aa; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:right; }
    .nai4a-meta-button { height:24px; padding:2px 7px; border:0; border-radius:4px; color:#c9cdd1; background:#3a3e43; cursor:pointer; font:inherit; white-space:nowrap; }
    .nai4a-meta-button:hover { color:#fff; background:#464b51; }
    .nai4a-meta-target { width:142px; height:24px; min-width:0; padding:2px 5px; border:1px solid #4b5359; border-radius:4px; color:#ddd; background:#1b1d20; font:inherit; }
    .nai4a-meta-workspace { min-height:0; flex:1; display:flex; gap:0; overflow:hidden; }
    .nai4a-meta-preview { flex:0 0 34%; min-width:120px; min-height:0; overflow:hidden; display:flex; flex-direction:column; border:1px solid #464a50; border-radius:6px; background:#202327; }
    .nai4a-meta-preview[hidden] { display:none; }
    .nai4a-meta-preview-frame { min-height:0; flex:1; padding:6px; display:grid; place-items:center; overflow:hidden; color:#858c94; text-align:center; background:#141618; }
    .nai4a-meta-preview img { width:100%; height:100%; min-height:0; display:block; object-fit:contain; user-select:none; -webkit-user-drag:none; }
    .nai4a-meta-preview-size { min-height:27px; padding:5px 8px; display:flex; align-items:center; justify-content:center; border-top:1px solid #3f4348; color:#aab1b8; background:#202327; font:11px/1.35 ui-monospace,SFMono-Regular,Consolas,monospace; }
    .nai4a-meta-splitter { position:relative; flex:0 0 13px; min-height:0; cursor:col-resize; touch-action:none; user-select:none; }
    .nai4a-meta-splitter[hidden] { display:none; }
    .nai4a-meta-splitter::before { content:""; position:absolute; top:0; bottom:0; left:6px; width:1px; border-radius:2px; background:#4b5056; transition:width .12s ease,left .12s ease,background .12s ease,box-shadow .12s ease; }
    .nai4a-meta-splitter:hover::before { left:5px; width:3px; background:#159eff; box-shadow:0 0 5px rgba(21,158,255,.55); }
    .nai4a-meta-list { min-width:240px; min-height:0; flex:1 1 auto; overflow:auto; padding-right:3px; display:flex; flex-direction:column; gap:7px; scrollbar-width:thin; }
    .nai4a-meta-empty { padding:18px 12px; border:1px dashed #4b4f55; border-radius:6px; color:#9298a0; text-align:center; }
    .nai4a-meta-card { flex:0 0 auto; overflow:hidden; border:1px solid #464a50; border-radius:6px; background:#292c30; }
    .nai4a-meta-card.uc { border-color:#59464b; background:#2b2729; }
    .nai4a-meta-card.parameters { border-color:#46535b; background:#292e31; }
    .nai4a-meta-card.model { border-color:#4a555e; background:#292e32; }
    .nai4a-meta-card-header { min-height:28px; padding:2px 6px 2px 9px; display:flex; align-items:center; gap:6px; background:#30343a; }
    .nai4a-meta-card.uc .nai4a-meta-card-header { color:#e0b5bd; background:#342d30; }
    .nai4a-meta-card.parameters .nai4a-meta-card-header { background:#30383d; }
    .nai4a-meta-card.model .nai4a-meta-card-header { background:#313940; }
    .nai4a-meta-card-title-group { flex:1; min-width:0; display:flex; align-items:center; gap:3px; }
    .nai4a-meta-card-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:650; }
    .nai4a-meta-copy, .nai4a-meta-return { width:24px; height:24px; flex:0 0 24px; padding:2px; display:grid; place-items:center; border:0; border-radius:4px; color:#c5c9ce; background:transparent; cursor:pointer; }
    .nai4a-meta-copy:hover, .nai4a-meta-return:hover { background:#3b4046; }
    .nai4a-meta-copy:disabled, .nai4a-meta-return:disabled { opacity:.35; cursor:default; background:transparent; }
    .nai4a-meta-copy svg, .nai4a-meta-return svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:1.9; stroke-linecap:round; stroke-linejoin:round; pointer-events:none; }
    .nai4a-meta-card-body { padding:6px; border-top:1px solid #42464b; }
    .nai4a-meta-card.uc .nai4a-meta-card-body { border-top-color:#4e3d42; }
    .nai4a-meta-text { width:100%; height:46px; min-height:46px; max-height:none; padding:5px 7px; resize:none; overflow:hidden; border:1px solid #4b4f55; border-radius:4px; color:#eceeef; background:#151719; font:12px/1.4 system-ui,sans-serif; user-select:text; cursor:text; }
    .nai4a-meta-parameter-grid { padding:5px; display:flex; flex-wrap:wrap; align-items:stretch; gap:4px; border-top:1px solid #424b50; }
    .nai4a-meta-parameter-item { flex:0 0 auto; width:max-content; max-width:100%; min-width:0; padding:3px 6px; display:flex; align-items:baseline; gap:5px; border:1px solid #454d52; border-radius:4px; background:#1b1e20; }
    .nai4a-meta-parameter-key { flex:0 0 auto; color:#99a2aa; font-size:10px; font-weight:650; letter-spacing:.04em; line-height:1.2; }
    .nai4a-meta-parameter-value { min-width:0; white-space:nowrap; color:#e7e9ea; font-size:12px; user-select:text; }
    .nai4a-meta-model-list { padding:5px 6px; border-top:1px solid #464950; }
    .nai4a-meta-model-row { min-height:27px; padding:2px 3px 2px 7px; display:flex; align-items:center; gap:7px; overflow:hidden; border:1px solid #45484e; border-radius:4px; background:#1b1d20; }
    .nai4a-meta-model-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#e2e6e9; user-select:text; }
    .nai4a-meta-model-hash { flex:0 1 auto; max-width:38%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#aeb8c2; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; user-select:text; }
    .nai4a-meta-model-row .nai4a-meta-copy { width:22px; height:22px; flex-basis:22px; }
    .nai4a-meta-card.character { border-color:#4a6078; background:#303c49; }
    .nai4a-meta-card.character .nai4a-meta-card-header { background:#222d39; }
    .nai4a-meta-card.character .nai4a-meta-card-body { border-top-color:#46596d; }
    .nai4a-meta-card.character.negative-mode { border-color:#76526f; background:#4a3548; }
    .nai4a-meta-card.character.negative-mode .nai4a-meta-card-header { background:#352635; }
    .nai4a-meta-coordinate { margin-left:5px; color:#b8c7d5; font-size:11px; font-variant-numeric:tabular-nums; white-space:nowrap; }
    .nai4a-meta-polarity { position:relative; width:70px; height:22px; flex:0 0 70px; padding:0; display:grid; grid-template-columns:1fr 1fr; place-items:center; overflow:visible; border:0; outline:0; background:transparent; color:#89939d; font:650 11px/1.35 system-ui,sans-serif; isolation:isolate; cursor:pointer; }
    .nai4a-meta-polarity-thumb { position:absolute; z-index:-1; top:1px; left:1px; width:34px; height:20px; border-radius:5px; background:#2c353e; box-shadow:inset 0 0 0 1px #526171; transform:translateX(0); transition:transform .16s ease,background-color .16s ease,box-shadow .16s ease; pointer-events:none; }
    .nai4a-meta-polarity-label { position:relative; z-index:1; width:100%; text-align:center; transition:color .16s ease; pointer-events:none; }
    .nai4a-meta-polarity-positive { color:#e2e9ef; }
    .nai4a-meta-polarity.negative .nai4a-meta-polarity-thumb { background:#5b3444; box-shadow:inset 0 0 0 1px #8b5266; transform:translateX(34px); }
    .nai4a-meta-polarity.negative .nai4a-meta-polarity-positive { color:#89939d; }
    .nai4a-meta-polarity.negative .nai4a-meta-polarity-negative { color:#f1d7df; }
    .nai4a-meta-overlay { position:fixed; inset:0; z-index:100000; display:grid; place-items:center; padding:30px; background:rgba(0,0,0,.65); }
    .nai4a-meta-dialog { width:min(900px,90vw); height:min(700px,86vh); display:flex; flex-direction:column; border:1px solid #555e69; border-radius:9px; background:#1c1f24; box-shadow:0 20px 60px #000; overflow:hidden; }
    .nai4a-meta-dialog-header { display:flex; gap:8px; align-items:center; padding:8px 10px; border-bottom:1px solid #414852; }
    .nai4a-meta-dialog-header strong { flex:1; }
    .nai4a-meta-dialog pre { flex:1; margin:0; padding:12px; overflow:auto; color:#d8dce1; white-space:pre-wrap; font:12px/1.5 ui-monospace,Consolas,monospace; }
  `;
  document.head.appendChild(style);
}

async function copyText(value) {
  const text = String(value || "");
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const input = document.createElement("textarea");
  input.value = text;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

function showRawMetadata(metadata, t) {
  const overlay = document.createElement("div");
  overlay.className = "nai4a-meta-overlay";
  const dialog = document.createElement("div");
  dialog.className = "nai4a-meta-dialog";
  const header = document.createElement("div");
  header.className = "nai4a-meta-dialog-header";
  const title = document.createElement("strong");
  title.textContent = t("完整图片元数据");
  const copy = document.createElement("button");
  copy.textContent = t("复制全部");
  const close = document.createElement("button");
  close.textContent = "×";
  const content = document.createElement("pre");
  content.textContent = JSON.stringify(metadata || {}, null, 2);
  const onKeyDown = (event) => { if (event.key === "Escape") remove(); };
  const remove = () => {
    document.removeEventListener("keydown", onKeyDown, true);
    overlay.remove();
  };
  copy.onclick = () => void copyText(content.textContent);
  close.onclick = remove;
  overlay.onclick = (event) => { if (event.target === overlay) remove(); };
  header.append(title, copy, close);
  dialog.append(header, content);
  overlay.appendChild(dialog);
  document.addEventListener("keydown", onKeyDown, true);
  document.body.appendChild(overlay);
}

function targetSelect(node, property, nodesProvider, title, t) {
  const select = document.createElement("select");
  select.className = "nai4a-meta-target";
  select.title = title;
  const refresh = () => {
    const targets = nodesProvider(node.graph || app.graph);
    const previous = String(node.properties?.[property] || select.value || "");
    select.replaceChildren();
    if (targets.length > 1) {
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = title;
      select.appendChild(placeholder);
    }
    for (const target of targets) {
      const option = document.createElement("option");
      option.value = String(target.id);
      option.textContent = naiTargetLabel(target);
      select.appendChild(option);
    }
    if (targets.some((target) => String(target.id) === previous)) select.value = previous;
    else if (targets.length === 1) select.value = String(targets[0].id);
    else select.value = "";
    select.hidden = targets.length < 2;
    return targets;
  };
  select.onchange = () => {
    node.properties = node.properties || {};
    node.properties[property] = select.value;
  };
  refresh();
  return { select, refresh, value: () => (refresh(), select.value) };
}

function iconButton(className, icon, title) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.innerHTML = icon;
  button.title = title;
  button.setAttribute("aria-label", title);
  return button;
}

function textCard({
  kind,
  title,
  text,
  sendTitle,
  onSend,
  sendAllTitle,
  onSendAll,
  setStatus,
  t,
}) {
  const card = document.createElement("section");
  card.className = `nai4a-meta-card ${kind}`;
  const header = document.createElement("div");
  header.className = "nai4a-meta-card-header";
  const titleGroup = document.createElement("div");
  titleGroup.className = "nai4a-meta-card-title-group";
  const caption = document.createElement("div");
  caption.className = "nai4a-meta-card-title";
  caption.textContent = title;
  const copy = iconButton("nai4a-meta-copy", COPY_ICON, t("复制{title}", { title }));
  copy.disabled = !String(text || "").trim();
  copy.onclick = () => void copyText(text).then(() => setStatus(t("已复制{title}", { title })));
  titleGroup.append(caption, copy);
  header.appendChild(titleGroup);
  if (onSendAll) {
    const sendAll = iconButton("nai4a-meta-return", APPLY_ALL_ICON, sendAllTitle);
    sendAll.disabled = !String(text || "").trim();
    sendAll.onclick = async () => {
      sendAll.disabled = true;
      try { setStatus(await onSendAll()); } catch (error) { setStatus(error?.message || String(error)); }
      finally { sendAll.disabled = false; }
    };
    header.appendChild(sendAll);
  }
  if (onSend) {
    const send = iconButton("nai4a-meta-return", RETURN_ICON, sendTitle);
    send.disabled = !String(text || "").trim();
    send.onclick = async () => {
      send.disabled = true;
      try { setStatus(await onSend()); } catch (error) { setStatus(error?.message || String(error)); }
      finally { send.disabled = false; }
    };
    header.appendChild(send);
  }
  const body = document.createElement("div");
  body.className = "nai4a-meta-card-body";
  const content = document.createElement("textarea");
  content.className = "nai4a-meta-text";
  content.readOnly = true;
  content.spellcheck = false;
  content.value = text || "";
  body.appendChild(content);
  card.append(header, body);
  return card;
}

function setupNode(node) {
  if (node.__nai4aMetaLoaderReady) return;
  node.__nai4aMetaLoaderReady = true;
  injectStyles();
  node.properties = node.properties || {};
  const t = createNaiTranslator(app);
  const imported = node.widgets?.find((entry) => entry?.name === "imported_json");
  hideNaiInternalWidget(imported);

  const main = document.createElement("div");
  main.className = "nai4a-meta-loader";
  main.addEventListener("pointerdown", (event) => event.stopPropagation());
  main.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
  const summary = document.createElement("div");
  summary.className = "nai4a-meta-summary";
  const title = document.createElement("div");
  title.className = "nai4a-meta-title";
  title.textContent = t("拖入图片读取元数据");
  const status = document.createElement("div");
  status.className = "nai4a-meta-status";
  const setStatus = (value) => { status.textContent = t(String(value || "")); };
  const sentStatus = (result) => t("已发送：{items}", {
    items: result.applied.map((item) => t(item)).join(t("、")),
  });
  const schedulerTarget = targetSelect(
    node, META_SCHEDULER_PROPERTY, naiSchedulerNodes, t("选择 NAI 调度器"), t,
  );
  const rawButton = document.createElement("button");
  rawButton.type = "button";
  rawButton.className = "nai4a-meta-button";
  rawButton.textContent = t("查看完整元数据");
  rawButton.hidden = true;
  summary.append(title, status, schedulerTarget.select, rawButton);

  const workspace = document.createElement("div");
  workspace.className = "nai4a-meta-workspace";
  const preview = document.createElement("div");
  preview.className = "nai4a-meta-preview";
  preview.hidden = true;
  const previewFrame = document.createElement("div");
  previewFrame.className = "nai4a-meta-preview-frame";
  const previewImage = document.createElement("img");
  previewImage.hidden = true;
  const previewEmpty = document.createElement("div");
  previewEmpty.textContent = t("重新拖入图片即可预览");
  previewFrame.append(previewImage, previewEmpty);
  const previewSize = document.createElement("div");
  previewSize.className = "nai4a-meta-preview-size";
  preview.append(previewFrame, previewSize);
  const splitter = document.createElement("div");
  splitter.className = "nai4a-meta-splitter";
  splitter.hidden = true;
  const list = document.createElement("div");
  list.className = "nai4a-meta-list";
  const empty = document.createElement("div");
  empty.className = "nai4a-meta-empty";
  empty.textContent = t("将含元数据的图片拖入此节点");
  list.appendChild(empty);
  let textResizeFrame = 0;
  const resizeTexts = () => {
    textResizeFrame = 0;
    for (const text of list.querySelectorAll?.(".nai4a-meta-text") || []) {
      text.style.height = "0px";
      const measured = Number(text.scrollHeight);
      text.style.height = `${Math.max(46, Number.isFinite(measured) ? Math.ceil(measured) + 2 : 46)}px`;
    }
  };
  const scheduleTextResize = () => {
    if (textResizeFrame) cancelAnimationFrame(textResizeFrame);
    textResizeFrame = requestAnimationFrame(resizeTexts);
  };
  const listResizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(scheduleTextResize)
    : null;
  listResizeObserver?.observe(list);
  workspace.append(preview, splitter, list);
  main.append(summary, workspace);

  let previewRatio = Number(node.properties.nai4a_meta_preview_ratio);
  if (!Number.isFinite(previewRatio)) previewRatio = 0.34;
  const setPreviewRatio = (value) => {
    previewRatio = Math.max(0.18, Math.min(0.68, Number(value) || 0.34));
    preview.style.flexBasis = `${previewRatio * 100}%`;
    node.properties.nai4a_meta_preview_ratio = previewRatio;
  };
  setPreviewRatio(previewRatio);
  splitter.onpointerdown = (event) => {
    event.preventDefault();
    const rect = workspace.getBoundingClientRect();
    const move = (moveEvent) => setPreviewRatio((moveEvent.clientX - rect.left) / rect.width);
    const stop = () => {
      globalThis.removeEventListener("pointermove", move, true);
      globalThis.removeEventListener("pointerup", stop, true);
    };
    globalThis.addEventListener("pointermove", move, true);
    globalThis.addEventListener("pointerup", stop, true);
  };

  const domWidget = node.addDOMWidget("nai4a_meta_loader_ui", "nai4a_meta_loader", main, withSyncedDomWidth({
    serialize: false,
    hideOnZoom: false,
    margin: 0,
    getMinHeight: () => 390,
    getMaxHeight: () => Math.max(390, Number(node.size?.[1] || 520) - 8),
  }));
  let currentDocument = null;
  const modelTarget = targetSelect(
    node, META_MODEL_PROPERTY, naiModelNodes, t("选择 NAI 模型加载器"), t,
  );
  const samplerTarget = targetSelect(
    node, META_SAMPLER_PROPERTY, naiSamplerNodes, t("选择 NAI 采样器"), t,
  );
  const targetIds = () => ({
    scheduler_id: schedulerTarget.value(),
    sampler_id: samplerTarget.value(),
    model_id: modelTarget.value(),
  });

  const addModelCard = (payload) => {
    const model = payload?.model;
    if (!model) return;
    const card = document.createElement("section");
    card.className = "nai4a-meta-card model";
    const header = document.createElement("div");
    header.className = "nai4a-meta-card-header";
    const titleGroup = document.createElement("div");
    titleGroup.className = "nai4a-meta-card-title-group";
    const caption = document.createElement("div");
    caption.className = "nai4a-meta-card-title";
    caption.textContent = t("使用模型");
    titleGroup.appendChild(caption);

    const applyAll = iconButton(
      "nai4a-meta-return",
      APPLY_PARAMETERS_ICON,
      t("发送所有模型、生成参数、分辨率和种子"),
    );
    applyAll.onclick = () => {
      try {
        const result = applyNaiMetadata(node, payload, {
          ...targetIds(), settings: true, seed: true,
        });
        setStatus(sentStatus(result));
      } catch (error) { setStatus(error?.message || String(error)); }
    };
    const send = iconButton("nai4a-meta-return", RETURN_ICON, t("发送模型"));
    send.disabled = !model.label;
    send.onclick = () => {
      try {
        const result = applyNaiMetadata(
          node,
          { ...payload, parameters: {}, seed: null },
          { ...targetIds(), settings: true },
        );
        setStatus(sentStatus(result));
      } catch (error) { setStatus(error?.message || String(error)); }
    };
    header.append(titleGroup, modelTarget.select, applyAll, send);

    const modelList = document.createElement("div");
    modelList.className = "nai4a-meta-model-list";
    const row = document.createElement("div");
    row.className = "nai4a-meta-model-row";
    const name = document.createElement("span");
    name.className = "nai4a-meta-model-name";
    const label = String(model.label || "").trim();
    const raw = String(model.raw || "").trim();
    name.textContent = label
      ? `NovelAI ${label}`
      : raw.replace(/^NovelAI\s+Diffusion\s*/i, "NovelAI ") || t("未知 NAI 模型");
    name.title = name.textContent;
    const hash = document.createElement("span");
    hash.className = "nai4a-meta-model-hash";
    hash.textContent = String(model.hash || "");
    hash.title = hash.textContent;
    const copy = iconButton("nai4a-meta-copy", COPY_ICON, t("复制模型信息"));
    const modelText = [name.textContent, hash.textContent].filter(Boolean).join(" ");
    copy.disabled = !modelText;
    copy.onclick = () => void copyText(modelText).then(() => setStatus(t("已复制模型信息")));
    row.append(name, hash, copy);
    modelList.appendChild(row);
    card.append(header, modelList);
    list.appendChild(card);
  };

  const addParameterCard = (payload) => {
    const parameters = payload.parameters || {};
    const hasParameters = Object.keys(parameters).length || payload.seed !== null;
    if (!hasParameters) return;
    const card = document.createElement("section");
    card.className = "nai4a-meta-card parameters";
    const header = document.createElement("div");
    header.className = "nai4a-meta-card-header";
    const caption = document.createElement("div");
    caption.className = "nai4a-meta-card-title";
    caption.textContent = t("生成参数");
    const titleGroup = document.createElement("div");
    titleGroup.className = "nai4a-meta-card-title-group";
    titleGroup.appendChild(caption);
    const send = iconButton(
      "nai4a-meta-return",
      RETURN_ICON,
      t("发送生成参数、分辨率和种子"),
    );
    header.append(titleGroup, samplerTarget.select, send);
    const grid = document.createElement("div");
    grid.className = "nai4a-meta-parameter-grid";
    const rows = [...Object.entries(parameters)];
    if (payload.seed !== null && payload.seed !== undefined) rows.push(["seed", payload.seed]);
    for (const [key, value] of rows) {
      const item = document.createElement("div");
      item.className = "nai4a-meta-parameter-item";
      const name = document.createElement("div");
      name.className = "nai4a-meta-parameter-key";
      const labels = {
        steps: "步数",
        width: "宽度",
        height: "高度",
        cfg: "CFG",
        sampler: "采样器",
        scheduler: "调度器",
        cfg_rescale: "CFG 重缩放",
        seed: "种子",
      };
      name.textContent = t(labels[key] || key);
      const content = document.createElement("div");
      content.className = "nai4a-meta-parameter-value";
      content.textContent = String(value);
      item.append(name, content);
      grid.appendChild(item);
    }
    send.onclick = () => {
      try {
        const result = applyNaiMetadata(node, { ...payload, model: null }, {
          ...targetIds(), settings: true, seed: true,
        });
        setStatus(sentStatus(result));
      } catch (error) { setStatus(error?.message || String(error)); }
    };
    card.append(header, grid);
    list.appendChild(card);
  };

  const addCharacterCard = (character, index) => {
    const card = document.createElement("section");
    card.className = "nai4a-meta-card character";
    const header = document.createElement("div");
    header.className = "nai4a-meta-card-header";
    const caption = document.createElement("div");
    caption.className = "nai4a-meta-card-title";
    const defaultName = t("角色 {index}", { index: index + 1 });
    caption.textContent = /^角色\s+\d+$/.test(String(character.name || ""))
      ? defaultName : (character.name || defaultName);
    const titleGroup = document.createElement("div");
    titleGroup.className = "nai4a-meta-card-title-group";
    titleGroup.appendChild(caption);
    if (character.use_position) {
      const xy = document.createElement("span");
      xy.className = "nai4a-meta-coordinate";
      xy.textContent = `X ${Number(character.x).toFixed(3)} · Y ${Number(character.y).toFixed(3)}`;
      titleGroup.appendChild(xy);
    }
    const polarity = document.createElement("button");
    polarity.type = "button";
    polarity.className = "nai4a-meta-polarity";
    const thumb = document.createElement("span");
    thumb.className = "nai4a-meta-polarity-thumb";
    const positiveLabel = document.createElement("span");
    positiveLabel.className = "nai4a-meta-polarity-label nai4a-meta-polarity-positive";
    positiveLabel.textContent = t("正面");
    const negativeLabel = document.createElement("span");
    negativeLabel.className = "nai4a-meta-polarity-label nai4a-meta-polarity-negative";
    negativeLabel.textContent = t("负面");
    polarity.append(thumb, positiveLabel, negativeLabel);
    titleGroup.appendChild(polarity);
    const send = iconButton("nai4a-meta-return", RETURN_ICON, t("追加这个角色"));
    const body = document.createElement("div");
    body.className = "nai4a-meta-card-body";
    const content = document.createElement("textarea");
    content.className = "nai4a-meta-text";
    content.readOnly = true;
    content.spellcheck = false;
    body.appendChild(content);
    let activeKind = "positive";
    const show = (kind) => {
      activeKind = kind === "negative" ? "negative" : "positive";
      const negative = activeKind === "negative";
      polarity.classList.toggle("negative", negative);
      card.classList.toggle("negative-mode", negative);
      polarity.title = t(negative ? "显示角色正面提示词" : "显示角色负面提示词");
      polarity.setAttribute("aria-label", polarity.title);
      content.value = character[activeKind] || "";
    };
    polarity.onclick = () => show(activeKind === "negative" ? "positive" : "negative");
    send.onclick = () => {
      try {
        sendNaiMetadataCharacter(node, character, index, targetIds());
        setStatus(t("已追加角色 {index}", { index: index + 1 }));
      }
      catch (error) { setStatus(error?.message || String(error)); }
    };
    header.append(titleGroup, send);
    card.append(header, body);
    show("positive");
    list.appendChild(card);
  };

  const render = (document) => {
    currentDocument = document;
    list.replaceChildren();
    if (!document) {
      previewImage.removeAttribute("src");
      previewImage.hidden = true;
      previewEmpty.hidden = false;
      preview.hidden = true;
      splitter.hidden = true;
      list.appendChild(empty);
      title.textContent = t("拖入图片读取元数据");
      rawButton.hidden = true;
      scheduleTextResize();
      return;
    }
    preview.hidden = false;
    splitter.hidden = false;
    const isNai = document.source_type === "novelai";
    title.textContent = isNai ? t("NovelAI 图片元数据") : t("图片提示词元数据");
    rawButton.hidden = !document.raw_metadata;
    if (isNai && document.model) addModelCard(document);
    if (isNai) addParameterCard(document);
    list.appendChild(textCard({
      kind: "prompt", title: t("正面提示词"), text: document.prompt || "",
      sendTitle: t("发送正面提示词"), setStatus, t,
      sendAllTitle: t("发送所有提示词和角色（替换）"),
      onSendAll: isNai ? () => sendAllNaiPrompts(node, document, targetIds()) : null,
      onSend: () => {
        const result = applyNaiMetadata(node, document, { ...targetIds(), prompt: true });
        return sentStatus(result);
      },
    }));
    list.appendChild(textCard({
      kind: "uc", title: t("负面提示词"), text: document.uc || "",
      sendTitle: t("发送负面提示词"), setStatus, t,
      onSend: () => {
        const result = applyNaiMetadata(node, document, { ...targetIds(), uc: true });
        return sentStatus(result);
      },
    }));
    if (isNai) {
      for (const [index, character] of (document.characters || []).entries()) {
        addCharacterCard(character, index);
      }
    }
    scheduleTextResize();
  };

  rawButton.onclick = () => showRawMetadata(currentDocument?.raw_metadata, t);

  const viewPath = () => api.fileURL?.("/view") || app.api?.apiURL?.("/view") || "/view";
  const showStoredPreview = (reference, dimensions) => {
    const url = buildStoredImageUrl(reference, viewPath());
    if (!url) {
      previewImage.removeAttribute("src");
      previewImage.hidden = true;
      previewEmpty.hidden = false;
      return;
    }
    previewImage.src = url;
    previewImage.hidden = false;
    previewEmpty.hidden = true;
    preview.hidden = false;
    splitter.hidden = false;
    previewSize.textContent = dimensions
      ? `${dimensions.width} × ${dimensions.height}` : "";
  };

  const loadFile = async (file) => {
    setStatus(t("正在读取元数据…"));
    try {
      const reference = await uploadInputImage(
        file,
        (url, init) => api.fetchApi(url, init),
      );
      const { document, promptJson } = await readNaiMetadataSnapshot(file);
      node.properties = node.properties || {};
      node.properties[IMAGE_REF_PROPERTY] = reference;
      writeNaiNodeWidget(node, imported, promptJson);
      render(document);
      showStoredPreview(reference, document.image_dimensions);
      setStatus(t("元数据读取完成"));
      node.graph?.change?.();
    } catch (error) {
      setStatus(error?.message || String(error));
    }
  };

  const importTransfer = async (dataTransfer) => {
    try {
      const file = await imageFileFromTransfer(dataTransfer, { viewPath: viewPath() });
      if (!file) return false;
      await loadFile(file);
      return true;
    } catch (error) {
      setStatus(error?.message || String(error));
      return true;
    }
  };
  bindOfficialImageDrop(main, { app, node, onDrop: importTransfer });

  const restore = () => {
    try { render(JSON.parse(String(imported?.value || ""))); }
    catch (_) { render(null); }
    const reference = normalizeStoredImageReference(node.properties?.[IMAGE_REF_PROPERTY]);
    if (reference && currentDocument) {
      showStoredPreview(reference, currentDocument.image_dimensions);
    }
  };
  node.__nai4aMetaLoaderRestore = restore;
  restore();
  const originalRemoved = node.onRemoved?.bind(node);
  node.onRemoved = function () {
    listResizeObserver?.disconnect();
    if (textResizeFrame) cancelAnimationFrame(textResizeFrame);
    return originalRemoved?.(...arguments);
  };
  node.resizable = true;
  node.setSize?.([700, 520]);
  if (domWidget) domWidget._node = node;
}

app.registerExtension({
  name: "ComfyUI-4A-NovelAI.MetaLoader",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_CLASS) return;
    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      originalCreated?.apply(this, arguments);
      setupNode(this);
    };
    const originalConfigured = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const result = originalConfigured?.apply(this, arguments);
      setupNode(this);
      this.__nai4aMetaLoaderRestore?.();
      return result;
    };
  },
});
