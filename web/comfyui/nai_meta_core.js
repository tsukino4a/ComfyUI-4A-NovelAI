import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { getPngMetadata, getWebpMetadata } from "../../scripts/pnginfo.js";
import {
  connectedGraphNodes,
  graphNodes,
  naiNodeClass,
  writeNaiNodeWidget,
} from "./nai_frontend_helpers.js";
import {
  NAI_SCHEDULER_NODE_CLASS,
} from "./nai_prompt_scheduler.js";
import {
  NAI_SAMPLER_NODE_CLASS,
  applyNaiSamplerSettingsPlan,
} from "./nai_sampler.js";
import {
  extractNovelAIStealthMetadata,
  parseNovelAIMetadata,
  parsePromptOnlyMetadata,
  sanitizeNaiRawMetadata,
} from "./nai_image_metadata.js";

export const NAI_MODEL_NODE_CLASS = "NovelAI4AModel";
export const META_SCHEDULER_PROPERTY = "nai4a_meta_scheduler_id";
export const META_SAMPLER_PROPERTY = "nai4a_meta_sampler_id";
export const META_MODEL_PROPERTY = "nai4a_meta_model_id";

function isClass(node, nodeClass) {
  return naiNodeClass(node) === nodeClass;
}

export function naiSchedulerNodes(graph) {
  return graphNodes(graph).filter((node) => isClass(node, NAI_SCHEDULER_NODE_CLASS));
}

export function naiSamplerNodes(graph) {
  return graphNodes(graph).filter((node) => isClass(node, NAI_SAMPLER_NODE_CLASS));
}

export function naiModelNodes(graph) {
  return graphNodes(graph).filter((node) => isClass(node, NAI_MODEL_NODE_CLASS));
}

export function naiTargetLabel(node) {
  return node?.title || `${naiNodeClass(node)} #${node?.id}`;
}

function selectNode(nodes, id, label, required = true) {
  const requested = String(id || "");
  const selected = requested
    ? nodes.find((node) => String(node?.id) === requested)
    : (nodes.length === 1 ? nodes[0] : null);
  if (selected || !required) return selected;
  if (!nodes.length) throw new Error(`工作流中没有${label}`);
  throw new Error(`工作流中有多个${label}，请先选择目标`);
}

function graphLink(graph, id) {
  const links = graph?.links;
  const link = links instanceof Map ? links.get(id) : links?.[id];
  if (Array.isArray(link)) {
    return { origin_id: link[1], origin_slot: link[2], target_id: link[3], target_slot: link[4] };
  }
  return link || null;
}

function graphNode(graph, id) {
  return graph?.getNodeById?.(id)
    || graphNodes(graph).find((node) => String(node?.id) === String(id))
    || null;
}

function inputOrigin(node, name) {
  const input = node?.inputs?.find((entry) => entry?.name === name);
  if (input?.link === null || input?.link === undefined) return null;
  return graphNode(node.graph, graphLink(node.graph, input.link)?.origin_id);
}

function connectedSampler(scheduler) {
  const nodes = connectedGraphNodes(scheduler, "downstream")
    .filter((node) => isClass(node, NAI_SAMPLER_NODE_CLASS));
  return nodes.length === 1 ? nodes[0] : null;
}

function connectedScheduler(sampler) {
  const nodes = connectedGraphNodes(sampler, "upstream")
    .filter((node) => isClass(node, NAI_SCHEDULER_NODE_CLASS));
  return nodes.length === 1 ? nodes[0] : null;
}

function connectedModel(sampler) {
  const origin = inputOrigin(sampler, "model");
  if (isClass(origin, NAI_MODEL_NODE_CLASS)) return origin;
  const nodes = connectedGraphNodes(sampler, "upstream")
    .filter((node) => isClass(node, NAI_MODEL_NODE_CLASS));
  return nodes.length === 1 ? nodes[0] : null;
}

function imageDimensions(file) {
  if (!(file instanceof Blob)) return Promise.resolve(null);
  const url = URL.createObjectURL(file);
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
      URL.revokeObjectURL(url);
    };
    image.onerror = () => {
      resolve(null);
      URL.revokeObjectURL(url);
    };
    image.src = url;
  });
}

export async function readNaiMetadataSnapshot(file, { requireNovelAI = false } = {}) {
  const form = new FormData();
  form.append("image", file, file?.name || "metadata-image");
  const response = await api.fetchApi("/novelai4a/image/metadata", {
    method: "POST",
    body: form,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result?.error || `图片元数据读取失败：${response.status}`);
  const name = String(file?.name || "").toLowerCase();
  let metadata = result?.metadata || {};
  if (file?.type === "image/png" || name.endsWith(".png")) {
    metadata = { ...metadata, ...(await getPngMetadata(file)) };
  } else if (file?.type === "image/webp" || name.endsWith(".webp")) {
    metadata = { ...metadata, ...(await getWebpMetadata(file)) };
  }
  let document = parseNovelAIMetadata(metadata);
  if (!document) {
    const stealth = await extractNovelAIStealthMetadata(file);
    if (stealth) {
      metadata = { ...metadata, ...stealth };
      document = parseNovelAIMetadata(stealth);
    }
  }
  if (!document && requireNovelAI) throw new Error("仅支持 NovelAI 原图元数据");
  document ||= parsePromptOnlyMetadata(metadata);
  if (!document) throw new Error("图片中没有识别到正面或负面提示词");
  const dimensions = await imageDimensions(file);
  document = {
    ...document,
    raw_metadata: sanitizeNaiRawMetadata(metadata),
    image_dimensions: dimensions || undefined,
  };
  return { document, promptJson: JSON.stringify(document) };
}

function schedulerTarget(host, selection, required = true) {
  const graph = host?.graph || app.graph;
  const id = selection.scheduler_id ?? host?.properties?.[META_SCHEDULER_PROPERTY];
  return selectNode(naiSchedulerNodes(graph), id, " NAI 提示词调度器", required);
}

function samplerTarget(host, selection, scheduler, required = true) {
  const graph = host?.graph || app.graph;
  const id = selection.sampler_id ?? host?.properties?.[META_SAMPLER_PROPERTY];
  if (id) return selectNode(naiSamplerNodes(graph), id, " NAI 采样器", required);
  return connectedSampler(scheduler)
    || selectNode(naiSamplerNodes(graph), "", " NAI 采样器", required);
}

function modelTarget(host, selection, sampler, required = true) {
  const graph = host?.graph || app.graph;
  const id = selection.model_id ?? host?.properties?.[META_MODEL_PROPERTY];
  if (id) return selectNode(naiModelNodes(graph), id, " NAI 模型加载器", required);
  return connectedModel(sampler)
    || selectNode(naiModelNodes(graph), "", " NAI 模型加载器", required);
}

function samplingParameters(parameters) {
  const result = {};
  for (const key of ["steps", "cfg", "sampler", "scheduler", "cfg_rescale"]) {
    if (Object.prototype.hasOwnProperty.call(parameters || {}, key)) result[key] = parameters[key];
  }
  return result;
}

export function resolveNaiMetadataTargets(host, document, selection = {}) {
  const needsScheduler = Boolean(
    (selection.prompt && typeof document?.prompt === "string")
    || (selection.uc && typeof document?.uc === "string")
    || (selection.characters && Array.isArray(document?.characters))
  );
  let scheduler = schedulerTarget(host, selection, needsScheduler);
  const parameters = document?.parameters || {};
  const needsSampler = Boolean(
    (selection.settings && Object.keys(samplingParameters(parameters)).length)
    || (selection.seed && document?.seed !== null && document?.seed !== undefined)
  );
  let sampler = samplerTarget(host, selection, scheduler, needsSampler);
  if (!scheduler && sampler) scheduler = connectedScheduler(sampler);
  if (!sampler && scheduler) sampler = connectedSampler(scheduler);
  const needsModel = Boolean(selection.settings && document?.model?.label);
  const model = modelTarget(host, selection, sampler, needsModel);
  return { scheduler, sampler, model };
}

export function applyNaiMetadata(host, document, selection = {}) {
  if (!document || typeof document !== "object") throw new Error("元数据内容无效");
  if (selection.require_novelai && document.source_type !== "novelai") {
    throw new Error("仅支持 NovelAI 原图元数据");
  }
  const targets = resolveNaiMetadataTargets(host, document, selection);
  const applied = [];
  if (selection.settings && document.model?.label) {
    const widget = targets.model?.widgets?.find((entry) => entry?.name === "model");
    if (!widget) throw new Error("NAI 模型加载器尚未准备好");
    writeNaiNodeWidget(targets.model, widget, document.model.label, { callback: true });
    applied.push("模型");
  }
  if (selection.settings) {
    const parameters = samplingParameters(document.parameters || {});
    if (Object.keys(parameters).length) {
      const result = applyNaiSamplerSettingsPlan(targets.sampler, { parameters });
      if (result.updated.length) applied.push("生成参数");
    }
  }
  if (selection.seed && document.seed !== null && document.seed !== undefined) {
    const widget = targets.sampler?.widgets?.find((entry) => entry?.name === "seed");
    if (!widget) throw new Error("NAI 采样器没有 Seed 组件");
    writeNaiNodeWidget(targets.sampler, widget, document.seed, { callback: true });
    applied.push("种子");
  }
  if (selection.prompt && typeof document.prompt === "string") {
    if (!targets.scheduler?.__nai4aSchedulerReceiveQuality?.(document.prompt, "replace")) {
      throw new Error("NAI 提示词调度器尚未准备好");
    }
    applied.push("正面提示词");
  }
  if (selection.uc && typeof document.uc === "string") {
    if (!targets.scheduler?.__nai4aSchedulerReceiveSlot?.("negative", document.uc, "replace")) {
      throw new Error("NAI 提示词调度器尚未准备好");
    }
    applied.push("负面提示词");
  }
  if (selection.characters && Array.isArray(document.characters)) {
    const mode = selection.append_characters ? "append" : "replace";
    if (!targets.scheduler?.__nai4aSchedulerReceiveCharacters?.(document.characters, mode)) {
      throw new Error("NAI 提示词调度器尚未准备好");
    }
    applied.push(selection.append_characters ? "追加角色" : "角色");
  }
  host?.graph?.change?.();
  return { applied, targets };
}

export function sendAllNaiPrompts(host, document, selection = {}) {
  const scheduler = schedulerTarget(host, selection, true);
  if (document?.source_type === "novelai") {
    const positive = scheduler.__nai4aSchedulerReceiveSlot?.(
      "quality", String(document.prompt || ""), "replace",
    );
    const negative = scheduler.__nai4aSchedulerReceiveSlot?.(
      "negative", String(document.uc || ""), "replace",
    );
    const characters = scheduler.__nai4aSchedulerReceiveCharacters?.(
      Array.isArray(document.characters) ? document.characters : [], "replace",
    );
    if (!positive || !negative || !characters) {
      throw new Error("NAI 提示词调度器尚未准备好");
    }
    return "已发送全部提示词和角色";
  }
  if (!scheduler.__nai4aSchedulerReceiveSlot?.("action", String(document?.prompt || ""), "replace")) {
    throw new Error("NAI 提示词调度器尚未准备好");
  }
  scheduler.__nai4aSchedulerReceiveSlot?.("negative", String(document?.uc || ""), "replace");
  return "已发送正面和负面提示词";
}

export function sendNaiMetadataCharacter(host, character, index, selection = {}) {
  const scheduler = schedulerTarget(host, selection, true);
  if (!scheduler.__nai4aSchedulerReceiveCharacters?.([character], "append")) {
    throw new Error("NAI 提示词调度器尚未准备好");
  }
  return `已追加角色 ${Number(index) + 1}`;
}
