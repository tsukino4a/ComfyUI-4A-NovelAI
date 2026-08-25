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
  imageReferenceFromComboValue,
  imageReferenceLabel,
  normalizeStoredImageReference,
  uploadInputImage,
} from "./nai_image_drop.js";
import { applyNaiMetadata, readNaiMetadataSnapshot } from "./nai_meta_core.js";

const NODE_CLASS = "NAI Meta Apply";
const IMAGE_REF_PROPERTY = "nai4a_imported_image_ref";
const MIN_WIDGET_HEIGHT = 160;

function injectStyles() {
  if (document.getElementById("nai4a-meta-apply-styles")) return;
  const style = document.createElement("style");
  style.id = "nai4a-meta-apply-styles";
  style.textContent = `
    .nai4a-meta-apply-root {
      width: 100%;
      height: 100%;
      min-height: 0;
      box-sizing: border-box;
      padding: 4px 10px 6px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      overflow: hidden;
      color: #c9ced3;
      font: 12px/1.35 system-ui, sans-serif;
    }
    .nai4a-meta-apply-root * { box-sizing: border-box; }
    .nai4a-meta-apply-preview {
      flex: 1 1 auto;
      min-height: 0;
      border: 1px solid #464a50;
      border-radius: 6px;
      background: #141618;
      display: grid;
      place-items: center;
      overflow: hidden;
    }
    .nai4a-meta-apply-preview img {
      width: 100%;
      height: 100%;
      min-height: 0;
      object-fit: contain;
      user-select: none;
      -webkit-user-drag: none;
    }
    .nai4a-meta-apply-empty { max-width: 180px; color: #858c94; text-align: center; }
    .nai4a-meta-apply-pick {
      flex: 0 0 auto;
      height: 26px;
      border: 0;
      border-radius: 4px;
      color: #c9cdd1;
      background: #3a3e43;
      cursor: pointer;
      font: inherit;
    }
    .nai4a-meta-apply-pick:hover { color: #fff; background: #464b51; }
    .nai4a-meta-apply-status {
      flex: 0 0 auto;
      min-height: 28px;
      padding: 5px 8px;
      border: 1px solid #464a50;
      border-radius: 5px;
      background: #292c30;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;
  document.head.appendChild(style);
}

function widget(node, name) {
  return node.widgets?.find((entry) => entry?.name === name) || null;
}

function viewPath() {
  return api.fileURL?.("/view") || app.api?.apiURL?.("/view") || "/view";
}

function storedImageReference(node) {
  return normalizeStoredImageReference(node.properties?.[IMAGE_REF_PROPERTY])
    || imageReferenceFromComboValue(widget(node, "image")?.value);
}

function writeImageReference(node, reference) {
  node.properties = node.properties || {};
  node.properties[IMAGE_REF_PROPERTY] = reference;
  const image = widget(node, "image");
  if (image) writeNaiNodeWidget(node, image, imageReferenceLabel(reference));
}

export function formatNaiMetaApplyStatus(result, hasEnabledSelection, t) {
  const applied = Array.isArray(result?.applied) ? result.applied : [];
  const items = applied.map((item) => t(item)).join(t("、"));
  if (applied.length || !hasEnabledSelection) {
    return t("已应用：{items}", { items });
  }
  return t("没有可用的 NAI 元数据");
}

export function formatNaiMetaApplyError(error, t) {
  const message = error?.message || String(error || "");
  if ([
    "仅支持 NovelAI 原图元数据",
    "图片中没有识别到正面或负面提示词",
  ].includes(message)) {
    return t("没有可用的 NAI 元数据");
  }
  return t(message);
}

function setupNode(node) {
  if (node.__nai4aMetaApplyReady) return;
  node.__nai4aMetaApplyReady = true;
  injectStyles();
  hideNaiInternalWidget(widget(node, "image"));
  const t = createNaiTranslator(app);

  const main = document.createElement("div");
  main.className = "nai4a-meta-apply-root";
  main.addEventListener("pointerdown", (event) => event.stopPropagation());

  const preview = document.createElement("div");
  preview.className = "nai4a-meta-apply-preview";
  const previewImage = document.createElement("img");
  previewImage.draggable = false;
  previewImage.hidden = true;
  const previewEmpty = document.createElement("div");
  previewEmpty.className = "nai4a-meta-apply-empty";
  previewEmpty.textContent = t("选择或拖入预览图");
  preview.append(previewImage, previewEmpty);

  const pick = document.createElement("button");
  pick.type = "button";
  pick.className = "nai4a-meta-apply-pick";
  pick.textContent = t("选择或拖入预览图");
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/png,image/webp,image/jpeg,.png,.webp,.jpg,.jpeg";
  fileInput.hidden = true;

  const status = document.createElement("div");
  status.className = "nai4a-meta-apply-status";
  status.setAttribute("aria-live", "polite");
  main.append(pick, fileInput, status, preview);
  const setStatus = (message) => {
    const text = t(String(message || "等待 NovelAI 图片"));
    status.textContent = text;
    status.title = text;
  };
  setStatus(t("等待 NovelAI 图片"));

  const characters = widget(node, "Characters");
  const append = widget(node, "└ Append");
  const syncAppend = () => {
    const enabled = characters?.value === true;
    if (!enabled && append?.value) writeNaiNodeWidget(node, append, false);
    if (append) {
      append.disabled = !enabled;
      append.options = { ...(append.options || {}), disabled: !enabled };
    }
    node.setDirtyCanvas?.(true, true);
  };
  if (characters) {
    const previous = characters.callback;
    characters.callback = function () {
      const result = previous?.apply(this, arguments);
      syncAppend();
      return result;
    };
  }
  if (append) {
    const previous = append.callback;
    append.callback = function () {
      if (characters?.value !== true) {
        writeNaiNodeWidget(node, append, false);
        syncAppend();
        return false;
      }
      return previous?.apply(this, arguments);
    };
  }
  syncAppend();

  const showStoredPreview = (reference) => {
    const url = buildStoredImageUrl(reference, viewPath());
    if (!url) {
      previewImage.removeAttribute("src");
      previewImage.hidden = true;
      previewEmpty.hidden = false;
      previewEmpty.textContent = t("选择或拖入预览图");
      return;
    }
    previewImage.src = url;
    previewImage.hidden = false;
    previewEmpty.hidden = true;
  };
  previewImage.addEventListener("error", () => {
    previewImage.hidden = true;
    previewEmpty.hidden = false;
    previewEmpty.textContent = t("预览文件不可用，请重新拖入图片");
  });

  const restorePreview = () => {
    hideNaiInternalWidget(widget(node, "image"));
    const reference = storedImageReference(node);
    if (!reference) return;
    writeImageReference(node, reference);
    showStoredPreview(reference);
  };

  let generation = 0;
  const applyFile = async (file) => {
    if (!file || (!file.type?.startsWith("image/") && !/\.(?:png|webp|jpe?g)$/i.test(file.name || ""))) {
      setStatus(t("只支持 PNG、WebP 或 JPEG 图片"));
      return;
    }
    const current = ++generation;
    setStatus(t("正在读取并应用 NAI 元数据…"));
    try {
      const reference = await uploadInputImage(
        file,
        (url, init) => api.fetchApi(url, init),
      );
      if (current !== generation) return;
      writeImageReference(node, reference);
      showStoredPreview(reference);
      const { document } = await readNaiMetadataSnapshot(file, { requireNovelAI: true });
      if (current !== generation) return;
      const selection = {
        require_novelai: true,
        prompt: widget(node, "Prompt")?.value === true,
        uc: widget(node, "UC")?.value === true,
        characters: characters?.value === true,
        append_characters: characters?.value === true && append?.value === true,
        settings: widget(node, "Settings")?.value === true,
        seed: widget(node, "Seed")?.value === true,
      };
      const result = applyNaiMetadata(node, document, selection);
      const hasEnabledSelection = [
        selection.prompt,
        selection.uc,
        selection.characters,
        selection.settings,
        selection.seed,
      ].some(Boolean);
      setStatus(formatNaiMetaApplyStatus(result, hasEnabledSelection, t));
    } catch (error) {
      if (current === generation) setStatus(formatNaiMetaApplyError(error, t));
    }
  };

  const importTransfer = async (dataTransfer) => {
    try {
      const file = await imageFileFromTransfer(dataTransfer, { viewPath: viewPath() });
      if (!file) return false;
      await applyFile(file);
      return true;
    } catch (error) {
      setStatus(error?.message || String(error));
      return true;
    }
  };

  pick.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (file) void applyFile(file);
  });

  bindOfficialImageDrop(main, { app, node, onDrop: importTransfer });

  let uiWidget = null;
  uiWidget = node.addDOMWidget("nai4a_meta_apply_ui", "nai4a_meta_apply", main, withSyncedDomWidth({
    serialize: false,
    hideOnZoom: false,
    margin: 0,
    getMinHeight: () => MIN_WIDGET_HEIGHT,
    getMaxHeight: () => {
      const measuredTop = Number(uiWidget?.last_y);
      const widgetTop = Number.isFinite(measuredTop) && measuredTop > 0 ? measuredTop : 55;
      return Math.max(MIN_WIDGET_HEIGHT, Number(node.size?.[1] || 420) - widgetTop - 8);
    },
  }));
  node.resizable = true;
  if (!Array.isArray(node.size) || node.size[1] < 420) {
    node.setSize?.([315, 420]);
  }
  node.__nai4aMetaApplyRestore = () => {
    syncAppend();
    restorePreview();
  };
  node.__nai4aMetaApplyRestore();
}

app.registerExtension({
  name: "ComfyUI-4A-NovelAI.MetaApply",
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
      this.__nai4aMetaApplyRestore?.();
      return result;
    };
  },
});
