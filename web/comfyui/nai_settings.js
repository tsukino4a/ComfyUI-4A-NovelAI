import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { createNaiTranslator, withSyncedDomWidth } from "./nai_frontend_helpers.js";
import { NAI_SAMPLER_NODE_CLASS } from "./nai_sampler.js";

export const USAGE_NODE_CLASS = "NovelAI4AUsage";
const USAGE_WIDGET_MARGIN = 6;
const USAGE_WIDGET_HEIGHT = 104;
const USAGE_WIDGET_MIN_HEIGHT = 94;
const USAGE_NODE_HEIGHT = 106;
const accountViews = new Set();
let refreshTimer = 0;
const t = createNaiTranslator(app);

async function readJson(path, options) {
  const response = await api.fetchApi(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export function formatAccount(data) {
  const tier = String(data?.tier || t("未知"));
  const total = Number(data?.total_anlas);
  const included = Number(data?.subscription_anlas);
  const paid = Number(data?.paid_anlas);
  const parts = [tier];
  if (Number.isFinite(total)) {
    const includedText = Number.isFinite(included) ? included.toLocaleString() : "0";
    const paidText = Number.isFinite(paid) ? paid.toLocaleString() : "0";
    parts.push(t("Anlas {total}（订阅 {included} + 购买 {paid}）", {
      total: total.toLocaleString(),
      included: includedText,
      paid: paidText,
    }));
  }
  const usage = data?.opus_usage;
  const usagePercent = Number(usage?.percent ?? data?.usage_percent);
  if (Number.isFinite(usagePercent)) {
    const remaining = Number(usage?.remaining_images);
    const estimate = Number.isFinite(remaining)
      ? t("，约 {remaining} 张", { remaining: remaining.toLocaleString() }) : "";
    parts.push(t("V5 免费余量 {percent}%{estimate}", {
      percent: usagePercent.toFixed(1),
      estimate,
    }));
  }
  return parts.join(" · ");
}

async function refreshAccountViews(force = false) {
  if (!accountViews.size) return;
  for (const view of accountViews) renderUsageState(view, "loading");
  try {
    const token = await readJson("/novelai4a/token/status");
    if (!token.configured) {
      for (const view of accountViews) renderUsageState(view, "token");
      return;
    }
    const account = await readJson(`/novelai4a/account${force ? "?force=1" : ""}`);
    for (const view of accountViews) renderUsageAccount(view, account);
  } catch (error) {
    for (const view of accountViews) renderUsageState(view, "error", error.message);
  }
}

export function scheduleNaiAccountRefresh(force = false) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refreshAccountViews(force), force ? 0 : 500);
}

function isExecutedNaiSampler(event) {
  const nodeId = event?.detail?.node;
  if (nodeId === undefined || nodeId === null) return false;
  const graph = app.graph || app.canvas?.graph;
  const node = graph?.getNodeById?.(nodeId)
    || graph?._nodes?.find((candidate) => String(candidate?.id) === String(nodeId));
  return node?.comfyClass === NAI_SAMPLER_NODE_CLASS;
}

function injectUsageStyles() {
  if (document.getElementById("nai4a-usage-styles")) return;
  const style = document.createElement("style");
  style.id = "nai4a-usage-styles";
  style.textContent = `
    .nai4a-usage { width:100%; height:100%; padding:0; display:flex; flex-direction:column; gap:4px; box-sizing:border-box; color:#e7e9ec; font:11px/1.2 system-ui,sans-serif; }
    .nai4a-usage * { box-sizing:border-box; }
    .nai4a-usage-head, .nai4a-usage-line, .nai4a-usage-actions { display:flex; align-items:center; }
    .nai4a-usage-head { min-width:0; gap:5px; }
    .nai4a-usage-tier { padding:2px 7px; border:1px solid #58755e; border-radius:9px; color:#d9f2de; background:#273b2c; font-size:10px; font-weight:700; }
    .nai4a-usage-state { min-width:0; overflow:hidden; color:#aeb5bc; text-overflow:ellipsis; white-space:nowrap; }
    .nai4a-usage-dot { width:7px; height:7px; flex:0 0 7px; border-radius:50%; background:#58c875; box-shadow:0 0 6px rgba(88,200,117,.5); }
    .nai4a-usage.error .nai4a-usage-dot { background:#d96666; box-shadow:0 0 6px rgba(217,102,102,.45); }
    .nai4a-usage.loading .nai4a-usage-dot, .nai4a-usage.token .nai4a-usage-dot { background:#8a929a; box-shadow:none; }
    .nai4a-usage-card { padding:5px 7px; border:1px solid #4a4f55; border-radius:6px; background:#292c30; }
    .nai4a-usage-line { justify-content:space-between; gap:10px; }
    .nai4a-usage-free-line { margin-top:4px; }
    .nai4a-usage-label { color:#aeb5bc; }
    .nai4a-usage-value { color:#f3f5f7; font-size:14px; font-weight:750; font-variant-numeric:tabular-nums; }
    .nai4a-usage-split { margin-top:2px; color:#8f989f; font-size:9px; }
    .nai4a-usage-progress { height:4px; margin-top:4px; overflow:hidden; border-radius:4px; background:#17191b; }
    .nai4a-usage-progress > span { display:block; width:0; height:100%; border-radius:4px; background:linear-gradient(90deg,#4d8fca,#68c98e); transition:width .2s ease; }
    .nai4a-usage-actions { flex:0 0 auto; justify-content:flex-end; gap:4px; margin-left:auto; }
    .nai4a-usage button { height:22px; padding:1px 7px; border:1px solid #555b62; border-radius:5px; color:#e8eaed; background:#3a3e43; cursor:pointer; font:inherit; white-space:nowrap; }
    .nai4a-usage button:hover { filter:brightness(1.15); }
    .nai4a-usage-configure { border-color:#4f795d !important; background:#31503a !important; }
  `;
  document.head.appendChild(style);
}

function renderUsageState(view, state, message = "") {
  view.root.classList.remove("loading", "token", "error");
  view.root.classList.add(state);
  view.tier.textContent = state === "token" ? "Token" : "—";
  view.state.textContent = state === "loading"
    ? t("正在读取账户…")
    : state === "token"
      ? t("尚未配置")
      : t("读取失败{detail}", { detail: message ? ` · ${t(message)}` : "" });
  view.total.textContent = "—";
  view.split.textContent = state === "token"
    ? t("配置 Token 后显示账户余额") : t("订阅 —  ·  购买 —");
  view.freeValue.textContent = "—";
  view.freeDetail.textContent = t("V5 免费额度");
  view.progress.style.width = "0%";
}

function renderUsageAccount(view, account) {
  view.root.classList.remove("loading", "token", "error");
  const tier = String(account?.tier || t("未知"));
  const total = Number(account?.total_anlas);
  const included = Number(account?.subscription_anlas);
  const paid = Number(account?.paid_anlas);
  const usage = account?.opus_usage || {};
  const percent = Math.max(0, Math.min(100, Number(usage.percent ?? account?.usage_percent) || 0));
  const remaining = Number(usage.remaining_images);
  view.tier.textContent = tier;
  view.state.textContent = t("账户已连接");
  view.total.textContent = Number.isFinite(total) ? total.toLocaleString() : "—";
  view.split.textContent = t("订阅 {included}  ·  购买 {paid}", {
    included: Number.isFinite(included) ? included.toLocaleString() : "—",
    paid: Number.isFinite(paid) ? paid.toLocaleString() : "—",
  });
  view.freeValue.textContent = `${percent.toFixed(1)}%`;
  view.freeDetail.textContent = Number.isFinite(remaining)
    ? t("V5 免费额度 · 约 {remaining} 张", { remaining: remaining.toLocaleString() })
    : t("V5 免费额度");
  view.progress.style.width = `${percent}%`;
  view.root.title = formatAccount(account);
}

export function setupUsageMonitorView(node) {
  if (!node || node.__nai4aAccountReady || typeof node.addDOMWidget !== "function") return;
  node.__nai4aAccountReady = true;
  injectUsageStyles();
  const root = document.createElement("div");
  root.className = "nai4a-usage";
  const head = document.createElement("div");
  head.className = "nai4a-usage-head";
  const dot = document.createElement("span");
  dot.className = "nai4a-usage-dot";
  const tier = document.createElement("span");
  tier.className = "nai4a-usage-tier";
  const state = document.createElement("span");
  state.className = "nai4a-usage-state";
  const card = document.createElement("div");
  card.className = "nai4a-usage-card";
  const anlasLine = document.createElement("div");
  anlasLine.className = "nai4a-usage-line";
  const anlasLabel = document.createElement("span");
  anlasLabel.className = "nai4a-usage-label";
  anlasLabel.textContent = t("Anlas 余额");
  const total = document.createElement("span");
  total.className = "nai4a-usage-value";
  anlasLine.append(anlasLabel, total);
  const split = document.createElement("div");
  split.className = "nai4a-usage-split";
  const freeLine = document.createElement("div");
  freeLine.className = "nai4a-usage-line nai4a-usage-free-line";
  const freeDetail = document.createElement("span");
  freeDetail.className = "nai4a-usage-label";
  const freeValue = document.createElement("span");
  freeValue.style.fontVariantNumeric = "tabular-nums";
  freeLine.append(freeDetail, freeValue);
  const progressTrack = document.createElement("div");
  progressTrack.className = "nai4a-usage-progress";
  const progress = document.createElement("span");
  progressTrack.appendChild(progress);
  card.append(anlasLine, split, freeLine, progressTrack);
  const actions = document.createElement("div");
  actions.className = "nai4a-usage-actions";
  const configure = document.createElement("button");
  configure.type = "button";
  configure.textContent = t("配置 Token");
  configure.className = "nai4a-usage-configure";
  configure.onclick = () => tokenDialog();
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.textContent = t("刷新");
  refresh.onclick = () => scheduleNaiAccountRefresh(true);
  actions.append(configure, refresh);
  head.append(dot, tier, state, actions);
  root.append(head, card);
  node.widgets_up = true;
  node.addDOMWidget("nai4a-account", "nai4a-account", root, withSyncedDomWidth({
    serialize: false,
    hideOnZoom: false,
    margin: USAGE_WIDGET_MARGIN,
    getHeight: () => USAGE_WIDGET_HEIGHT,
    getMinHeight: () => USAGE_WIDGET_MIN_HEIGHT,
    getMaxHeight: () => USAGE_WIDGET_HEIGHT,
  }));
  const setCompactSize = () => {
    node.setSize?.([
      Math.max(350, Number(node.size?.[0]) || 0),
      USAGE_NODE_HEIGHT,
    ]);
  };
  const originalConfigure = node.onConfigure;
  node.onConfigure = function () {
    const result = originalConfigure?.apply(this, arguments);
    requestAnimationFrame(() => {
      if (node.__nai4aAccountReady) setCompactSize();
    });
    return result;
  };
  const originalResize = node.onResize;
  node.onResize = function (size) {
    if (Array.isArray(size) && Number(size[1]) < USAGE_NODE_HEIGHT) {
      size[1] = USAGE_NODE_HEIGHT;
    }
    return originalResize?.apply(this, arguments);
  };
  const view = {
    node,
    root,
    tier,
    state,
    total,
    split,
    freeDetail,
    freeValue,
    progress,
  };
  accountViews.add(view);
  const originalRemoved = node.onRemoved?.bind(node);
  node.onRemoved = function () {
    accountViews.delete(view);
    root.remove();
    delete node.__nai4aAccountReady;
    return originalRemoved?.apply(this, arguments);
  };
  setCompactSize();
  renderUsageState(view, "loading");
  scheduleNaiAccountRefresh();
}

function tokenDialog(onSaved) {
  const dialog = document.createElement("dialog");
  dialog.style.cssText = "padding:18px;border-radius:8px;min-width:380px;";
  const form = document.createElement("form");
  form.method = "dialog";

  const title = document.createElement("h3");
  title.textContent = "NovelAI Persistent API Token";
  const help = document.createElement("p");
  help.textContent = t("Token 只会发送到本机 ComfyUI 后端，并保存在 ComfyUI user 目录。");
  help.style.maxWidth = "460px";
  const input = document.createElement("input");
  input.type = "password";
  input.autocomplete = "off";
  input.placeholder = t("粘贴 Persistent API Token");
  input.style.cssText = "box-sizing:border-box;width:100%;padding:8px;";
  const buttons = document.createElement("div");
  buttons.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:14px;";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = t("取消");
  cancel.onclick = () => dialog.close();
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = t("保存到本机");
  buttons.append(cancel, save);
  form.append(title, help, input, buttons);
  dialog.append(form);
  document.body.append(dialog);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      await readJson("/novelai4a/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: input.value }),
      });
      input.value = "";
      dialog.close();
      await onSaved?.();
      scheduleNaiAccountRefresh(true);
    } catch (error) {
      alert(t("保存 NovelAI Token 失败：{message}", { message: t(error.message) }));
    } finally {
      save.disabled = false;
    }
  });
  dialog.addEventListener("close", () => {
    input.value = "";
    dialog.remove();
  });
  dialog.showModal();
  input.focus();
}

function settingsControl() {
  const root = document.createElement("div");
  root.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;";
  const configure = document.createElement("button");
  configure.textContent = t("配置 Token");
  const clear = document.createElement("button");
  clear.textContent = t("清除 Token");
  const account = document.createElement("button");
  account.textContent = t("查询订阅 / Anlas");
  const status = document.createElement("span");
  status.textContent = t("正在检查…");

  async function refreshStatus() {
    try {
      const data = await readJson("/novelai4a/token/status");
      status.textContent = data.configured ? t("Token 已配置") : t("Token 未配置");
    } catch (error) {
      status.textContent = t("状态读取失败：{message}", { message: t(error.message) });
    }
  }

  configure.onclick = () => tokenDialog(refreshStatus);
  clear.onclick = async () => {
    if (!confirm(t("确定清除本机保存的 NovelAI Token？"))) return;
    try {
      await readJson("/novelai4a/token", { method: "DELETE" });
      await refreshStatus();
      scheduleNaiAccountRefresh();
    } catch (error) {
      alert(t("清除失败：{message}", { message: t(error.message) }));
    }
  };
  account.onclick = async () => {
    try {
      const data = await readJson("/novelai4a/account?force=1");
      alert(data ? formatAccount(data) : t("账户信息不可用"));
    } catch (error) {
      alert(t("账户查询失败：{message}", { message: t(error.message) }));
    }
  };
  root.append(configure, clear, account, status);
  void refreshStatus();
  return root;
}

app.registerExtension({
  name: "ComfyUI-4A-NovelAI.Settings",
  setup() {
    api.addEventListener("executed", (event) => {
      if (isExecutedNaiSampler(event)) scheduleNaiAccountRefresh();
    });
    app.ui?.settings?.addSetting({
      id: "NovelAI4A.TokenControl",
      name: t("NovelAI Token 与账户"),
      category: ["4A NovelAI", t("账户"), t("Token 与 Anlas")],
      tooltip: t("Token 不会写入工作流、浏览器设置或日志。"),
      type: settingsControl,
      defaultValue: false,
    });
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== USAGE_NODE_CLASS) return;
    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      originalCreated?.apply(this, arguments);
      setupUsageMonitorView(this);
    };
  },
});
