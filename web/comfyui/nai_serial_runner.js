/**
 * NAI Prompt Scheduler batch queue.
 *
 * Every task is serialized and added to the ComfyUI queue immediately, the
 * same way 4APM does. Per-task sampler settings are baked in before each
 * queuePrompt; ComfyUI then runs the queued jobs one by one.
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
  createNaiTranslator,
  nai4aRequestJson,
  writeNaiNodeWidget,
} from "./nai_frontend_helpers.js";
import {
  applyNaiSamplerRatioHint,
  applyNaiSamplerSettingsPlan,
  resolveConnectedNaiSampler,
  restoreNaiSamplerParameters,
  restoreNaiSamplerResolution,
  snapshotNaiSamplerParameters,
  snapshotNaiSamplerResolution,
} from "./nai_sampler.js";

export const NAI_TRACK_INPUT_PREFIX = "pm4a_track_";
export const NAI_SCHEDULER_PREPARE_ROUTE = "/nai4a/api/scheduler/prepare";

function asText(value) {
  return String(value?.message || value || "");
}

export function naiSchedulerConnectedDynamicTracks(node) {
  const connected = [];
  for (const input of node?.inputs || []) {
    if (!input?.name?.startsWith(NAI_TRACK_INPUT_PREFIX)) continue;
    if (input.link !== null && input.link !== undefined) {
      connected.push(input.__nai4aTrackId || input.name);
    }
  }
  return connected;
}

export function readPromptId(result) {
  const raw = result?.prompt_id ?? result?.promptId;
  if (raw === null || raw === undefined) return "";
  return String(raw).trim();
}

export function settingsPlanForIndex(plans, executionIndex) {
  const list = Array.isArray(plans) ? plans : [];
  return list.find((entry) => (
    Number(entry?.execution_index) === Number(executionIndex)
  )) || {};
}

function setBatchState(node, value) {
  if (!node) return;
  node.__nai4aBatchState = value;
}

export async function runNaiSerialBatch(payload = {}, deps = {}) {
  const appClient = deps.app || payload.app || app;
  const apiClient = deps.api || payload.api || api;
  const t = deps.t || payload.t || createNaiTranslator(appClient);
  const node = payload.node;
  const config = payload.config || {};
  const setUi = payload.setUi;
  const setStartIndex = payload.setStartIndex;
  const isCancelled = payload.isCancelled || (() => false);
  const indexWidget = payload.indexWidget;
  const runWidget = payload.runWidget;
  const requestJson = payload.requestJson || deps.requestJson || nai4aRequestJson;
  const graphToPrompt = deps.graphToPrompt || (() => appClient.graphToPrompt());
  const queuePrompt = deps.queuePrompt || ((prompt) => apiClient.queuePrompt(0, prompt));

  const resumeAt = (executionIndex) => {
    config.start_index = executionIndex;
    setStartIndex?.(executionIndex);
    return executionIndex;
  };
  const fail = (executionIndex, error, completed = 0) => {
    const message = asText(error) || t("工作流执行失败");
    resumeAt(executionIndex);
    setUi?.({ error: message });
    return {
      status: "failed",
      resumeIndex: executionIndex,
      error: message,
      completed,
    };
  };

  const connectedTracks = naiSchedulerConnectedDynamicTracks(node);
  if (connectedTracks.length) {
    const error = t("连接动态栏目输入时不能使用 NAI 批量运行（后端预计算不支持）");
    setUi?.({ error });
    return { status: "rejected", reason: "dynamic-tracks", error, completed: 0 };
  }

  const startIndex = Math.max(0, Number.parseInt(config.start_index, 10) || 0);
  const taskCount = Math.max(1, Number.parseInt(config.task_count, 10) || 1);
  const indices = Array.from({ length: taskCount }, (_, offset) => startIndex + offset);
  const seedValue = Number(payload.seed);
  const seed = Number.isFinite(seedValue) ? Math.trunc(seedValue) : 0;
  const prepared = await requestJson(NAI_SCHEDULER_PREPARE_ROUTE, {
    config,
    task_count: taskCount,
    seed,
  });
  const runId = prepared?.run_id;
  if (!runId) {
    const error = t("本轮 NAI 提示词快照已失效，请重新准备批量运行");
    setUi?.({ error });
    return { status: "rejected", reason: "prepare", error, completed: 0 };
  }
  const plans = Array.isArray(prepared.nai_settings_plans)
    ? prepared.nai_settings_plans
    : [];
  const applySettings = Boolean(config.settings_apply_nai);
  const sampler = applySettings
    ? (payload.getSampler?.() || resolveConnectedNaiSampler(node))
    : null;
  const samplerBaseline = sampler ? snapshotNaiSamplerParameters(sampler) : null;
  const resolutionBaseline = applySettings ? snapshotNaiSamplerResolution(node) : null;

  setBatchState(node, { runId, currentIndex: startIndex });
  setUi?.({ running: true, error: "" });
  let completed = 0;
  try {
    for (const executionIndex of indices) {
      if (isCancelled()) {
        resumeAt(executionIndex);
        return { status: "cancelled", resumeIndex: executionIndex, completed };
      }
      setBatchState(node, { runId, currentIndex: executionIndex });
      writeNaiNodeWidget(node, indexWidget, executionIndex);
      writeNaiNodeWidget(node, runWidget, runId);

      if (sampler && samplerBaseline) {
        restoreNaiSamplerParameters(sampler, samplerBaseline);
      }
      if (resolutionBaseline) {
        restoreNaiSamplerResolution(node, resolutionBaseline);
      }
      const plan = settingsPlanForIndex(plans, executionIndex);
      if (sampler) {
        applyNaiSamplerSettingsPlan(sampler, plan);
      }
      if (applySettings) applyNaiSamplerRatioHint(node, plan);

      let prompt;
      try {
        prompt = await graphToPrompt();
      } catch (error) {
        return fail(executionIndex, error, completed);
      }
      let queued;
      try {
        queued = await queuePrompt(prompt);
      } catch (error) {
        return fail(executionIndex, error, completed);
      }
      const promptId = readPromptId(queued);
      if (!promptId) return fail(executionIndex, t("ComfyUI 没有返回 prompt_id"), completed);
      completed += 1;
    }
    setUi?.({ error: "" });
    return { status: "ok", completed };
  } finally {
    if (sampler && samplerBaseline) {
      restoreNaiSamplerParameters(sampler, samplerBaseline);
    }
    if (resolutionBaseline) {
      restoreNaiSamplerResolution(node, resolutionBaseline);
    }
    setBatchState(node, null);
    writeNaiNodeWidget(node, indexWidget, config.start_index ?? startIndex);
    writeNaiNodeWidget(node, runWidget, "");
    setUi?.({ running: false });
  }
}

export function attachNaiSerialBatchHook(node, host = {}) {
  if (!node) return null;
  const session = { cancelled: false };
  const t = host.t || createNaiTranslator(host.app || app);
  const cancel = () => {
    session.cancelled = true;
    if (node.__nai4aBatchRunning) {
      host.setUi?.({ running: true, error: t("将停止继续入队…") });
    }
  };
  const start = async (payload = {}) => {
    if (node.__nai4aBatchRunning) {
      cancel();
      return { started: false, reason: "already-running" };
    }
    session.cancelled = false;
    node.__nai4aBatchRunning = true;
    host.setUi?.({ running: true, error: "" });
    try {
      return await runNaiSerialBatch(
        {
          node,
          setStartIndex: host.setStartIndex,
          setUi: host.setUi,
          requestJson: host.requestJson,
          getSampler: host.getSampler,
          t,
          ...payload,
          isCancelled: () => session.cancelled,
        },
        {
          app: host.app || app,
          api: host.api || api,
          ...host.deps,
          ...payload.deps,
        },
      );
    } finally {
      node.__nai4aBatchRunning = false;
      setBatchState(node, null);
      host.setUi?.({ running: false });
    }
  };
  node.__nai4aCancelBatch = cancel;
  node.__nai4aStartBatch = start;
  return { cancel, session, start };
}
