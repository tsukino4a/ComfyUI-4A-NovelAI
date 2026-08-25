/**
 * Small, dependency-free helpers shared by the NovelAI frontend extensions.
 */

export const NAI4A_SAMPLER_RESOLUTION_EVENT = "nai4a_sampler_resolution_changed";
export const NAI4A_INTERNAL_INPUT_TYPE = "NAI4A_INTERNAL";

const EN = Object.freeze({
  "质量": "Quality",
  "角色": "Character",
  "动作": "Action",
  "场景": "Scene",
  "正面": "Pos",
  "负面": "Neg",
  "展开栏目": "Expand track",
  "收起栏目": "Collapse track",
  "展开角色": "Expand character",
  "收起角色": "Collapse character",
  "当前：随机；点击切换为顺序": "Random; click for sequence",
  "当前：顺序；点击切换为随机": "Sequence; click for random",
  "当前已停用；点击重新启用": "Disabled; click to enable",
  "当前已启用；点击停用": "Enabled; click to disable",
  "切换到正面提示词": "Switch to positive prompt",
  "切换到负面提示词": "Switch to negative prompt",
  "起始位置": "Start index",
  "任务数量": "Task count",
  "统计数量": "Count",
  "批量运行": "Run batch",
  "停止批量": "Stop batch",
  "将停止继续入队…": "Stopping further queueing…",
  "+ 新增栏目": "+ Add track",
  "+ 新增角色": "+ Add character",
  "角色提示词": "Character prompts",
  "编辑角色位置": "Edit positions",
  "使用自定义位置": "Use custom positions",
  "角色位置": "Character positions",
  "取消": "Cancel",
  "保存": "Save",
  "删除栏目": "Delete track",
  "删除角色": "Delete character",
  "上移栏目": "Move track up",
  "下移栏目": "Move track down",
  "上移角色": "Move character up",
  "下移角色": "Move character down",
  "未命名栏目": "Untitled track",
  "未命名角色": "Untitled character",
  "编辑栏目名称": "Rename track",
  "固定 NAI 文本，或粘贴 __文件夹路径__": "Fixed NAI text, or __folder/path__",
  "角色 NAI 正面提示词": "Character positive prompt",
  "角色 NAI 负面提示词": "Character negative prompt",
  "已由外部输入接管，运行时使用连线内容": "Controlled by a connected input",
  "画面比例": "Aspect ratio",
  "分辨率档位": "Resolution tier",
  "交换宽高（不重新计算）": "Swap width and height without recalculating",
  "普通": "Normal",
  "大图": "Large",
  "壁纸": "Wallpaper",
  "小图": "Small",
  "宽度": "Width",
  "高度": "Height",
  "当前比例": "Current",
  "自动应用采样数据": "Automatically apply sampling data",
  "采样数据仅临时覆盖相连的 NAI Sampler，任务结束后恢复": "Sampling data temporarily overrides the connected NAI Sampler and is restored afterwards",
  "连接动态栏目输入时不能使用 NAI 批量运行（后端预计算不支持）": "Batch mode cannot run while dynamic track inputs are connected",
  "本轮 NAI 提示词快照已失效，请重新准备批量运行": "The prepared NAI prompt snapshot is invalid; prepare the batch again",
  "工作流执行失败": "Workflow execution failed",
  "等待生图结果超时": "Timed out waiting for image generation",
  "ComfyUI 没有返回 prompt_id": "ComfyUI did not return prompt_id",
  "没有找到可循环的 NAI 文件夹通配符": "No sequential NAI folder wildcard was found",
  "完整图片元数据": "Full image metadata",
  "复制全部": "Copy all",
  "复制{title}": "Copy {title}",
  "已复制{title}": "Copied {title}",
  "选择 NAI 调度器": "Select NAI Scheduler",
  "选择 NAI 模型加载器": "Select NAI Model Loader",
  "选择 NAI 采样器": "Select NAI Sampler",
  "拖入图片读取元数据": "Drop an image to read metadata",
  "查看完整元数据": "View full metadata",
  "将含元数据的图片拖入此节点": "Drop an image with metadata onto this node",
  "重新拖入图片即可预览": "Drop the image again to preview",
  "生成参数": "Generation settings",
  "发送生成参数、分辨率和种子": "Send generation settings, resolution, and seed",
  "发送所有模型、生成参数、分辨率和种子": "Send model, generation settings, resolution, and seed",
  "正面提示词": "Positive prompt",
  "负面提示词": "Negative prompt",
  "发送正面提示词": "Send positive prompt",
  "发送负面提示词": "Send negative prompt",
  "追加这个角色": "Append this character",
  "显示角色正面提示词": "Show character positive prompt",
  "显示角色负面提示词": "Show character negative prompt",
  "发送所有提示词和角色（替换）": "Send all prompts and characters (replace)",
  "NovelAI 图片元数据": "NovelAI image metadata",
  "图片提示词元数据": "Image prompt metadata",
  "未知 NAI 模型": "Unknown NAI model",
  "使用模型": "Model used",
  "发送模型": "Send model",
  "复制模型信息": "Copy model info",
  "已复制模型信息": "Model info copied",
  "正在读取元数据…": "Reading metadata…",
  "元数据读取完成": "Metadata loaded",
  "等待 NovelAI 图片": "Waiting for a NovelAI image",
  "选择或拖入预览图": "Choose or drop a preview image",
  "预览文件不可用，请重新拖入图片": "Preview file unavailable; drop the image again",
  "图片上传成功，但返回的文件引用无效": "Image uploaded, but the returned file reference is invalid",
  "只支持 PNG、WebP 或 JPEG 图片": "Only PNG, WebP, and JPEG images are supported",
  "正在读取并应用 NAI 元数据…": "Reading and applying NAI metadata…",
  "已应用：{items}": "Applied: {items}",
  "已发送：{items}": "Sent: {items}",
  "没有可用的 NAI 元数据": "No usable NAI metadata",
  "已发送全部提示词和角色": "Sent all prompts and characters",
  "已发送正面和负面提示词": "Sent positive and negative prompts",
  "已追加角色 {index}": "Appended character {index}",
  "模型": "Model",
  "分辨率": "Resolution",
  "种子": "Seed",
  "追加角色": "Characters (append)",
  "步数": "Steps",
  "采样器": "Sampler",
  "调度器": "Scheduler",
  "CFG 重缩放": "CFG rescale",
  "角色 {index}": "Char {index}",
  "、": ", ",
  "仅支持 NovelAI 原图元数据": "Only original NovelAI image metadata is supported",
  "图片中没有识别到正面或负面提示词": "No positive or negative prompt was found in the image",
  "元数据内容无效": "Invalid metadata",
  "NAI 模型加载器尚未准备好": "The NAI Model Loader is not ready",
  "NAI 采样器没有 Seed 组件": "The NAI Sampler has no seed widget",
  "NAI 提示词调度器尚未准备好": "The NAI Prompt Scheduler is not ready",
  "工作流中没有 NAI 提示词调度器": "No NAI Prompt Scheduler was found in the workflow",
  "工作流中有多个 NAI 提示词调度器，请先选择目标": "Multiple NAI Prompt Schedulers were found; select a target first",
  "工作流中没有 NAI 采样器": "No NAI Sampler was found in the workflow",
  "工作流中有多个 NAI 采样器，请先选择目标": "Multiple NAI Samplers were found; select a target first",
  "工作流中没有 NAI 模型加载器": "No NAI Model Loader was found in the workflow",
  "工作流中有多个 NAI 模型加载器，请先选择目标": "Multiple NAI Model Loaders were found; select a target first",
  "未知": "Unknown",
  "Anlas {total}（订阅 {included} + 购买 {paid}）": "Anlas {total} (Subscription {included} + Purchased {paid})",
  "，约 {remaining} 张": ", approx. {remaining} images",
  "V5 免费余量 {percent}%{estimate}": "V5 free allowance {percent}%{estimate}",
  "正在读取账户…": "Reading account…",
  "尚未配置": "Not configured",
  "读取失败{detail}": "Failed to load{detail}",
  "配置 Token 后显示账户余额": "Configure Token to view account balance",
  "订阅 —  ·  购买 —": "Subscription —  ·  Purchased —",
  "V5 免费额度": "V5 free allowance",
  "账户已连接": "Account connected",
  "订阅 {included}  ·  购买 {paid}": "Subscription {included}  ·  Purchased {paid}",
  "V5 免费额度 · 约 {remaining} 张": "V5 free allowance · approx. {remaining} images",
  "Anlas 余额": "Anlas balance",
  "配置 Token": "Configure Token",
  "刷新": "Refresh",
  "Vibe 编码模型": "Vibe encode model",
  "编码并保存（预计 2 Anlas）": "Encode (2 Anlas)",
  "角色与风格": "Character & style",
  "风格": "Style",
  "Information Extracted：{value}": "Information Extracted: {value}",
  "预计消耗 2 Anlas，是否继续？": "This will use about 2 Anlas. Continue?",
  "正在执行 Vibe 编码…": "Encoding Vibe…",
  "当前 Information Extracted 已有对应编码": "An encoding already exists for this extraction value",
  "正在检查当前 Information Extracted 的 Vibe 编码…": "Checking Vibe encoding…",
  "没有匹配当前 Information Extracted 的 Vibe 编码。": "No encoding for this extraction value.",
  "没有匹配当前 Information Extracted 的编码，且该文件不包含可重新编码的原图。": "No matching encoding; the source image is unavailable.",
  "编码可用后才能启用": "Enable after encoding is available",
  "停用": "Disable",
  "启用": "Enable",
  "删除": "Delete",
  "Vibe 编码文件": "Vibe file",
  "拖入图片": "Drop image",
  "无法取得一次性授权": "Unable to obtain one-time authorization",
  "Vibe 编码失败": "Vibe encoding failed",
  "编码失败：{message}": "Encoding failed: {message}",
  "Vibe 编码检查失败：{message}": "Vibe check failed: {message}",
  "读取 Vibe 文件失败": "Failed to read Vibe files",
  "Vibe 文件读取失败": "Failed to read Vibe file",
  "Vibe 缓存检查失败": "Vibe cache check failed",
  ".naiv4vibe 只能拖入 Vibe 模式": ".naiv4vibe files can only be dropped in Vibe mode",
  "Vibe 最多支持 16 个资源": "Vibe supports up to 16 resources",
  "只支持图片或 .naiv4vibe 文件": "Only images and .naiv4vibe files are supported",
  "图片不能超过 32 MB": "Images must be 32 MB or smaller",
  "参考图片读取失败": "Failed to read reference image",
  "拖入的资产不是支持的图片": "The dropped asset is not a supported image",
  "文件": "File",
  "参考资源读取失败：{message}": "Failed to read references: {message}",
  "Token 只会发送到本机 ComfyUI 后端，并保存在 ComfyUI user 目录。": "The token is only sent to the local ComfyUI backend and stored in the ComfyUI user directory.",
  "粘贴 Persistent API Token": "Paste Persistent API Token",
  "保存到本机": "Save locally",
  "保存 NovelAI Token 失败：{message}": "Failed to save NovelAI Token: {message}",
  "清除 Token": "Clear Token",
  "查询订阅 / Anlas": "Check subscription / Anlas",
  "正在检查…": "Checking…",
  "Token 已配置": "Token configured",
  "Token 未配置": "Token not configured",
  "状态读取失败：{message}": "Failed to read status: {message}",
  "确定清除本机保存的 NovelAI Token？": "Clear the NovelAI Token saved on this computer?",
  "清除失败：{message}": "Failed to clear token: {message}",
  "账户信息不可用": "Account information unavailable",
  "账户查询失败：{message}": "Failed to query account: {message}",
  "NovelAI Token 与账户": "NovelAI Token & account",
  "账户": "Account",
  "Token 与 Anlas": "Token & Anlas",
  "Token 不会写入工作流、浏览器设置或日志。": "The token is never written to workflows, browser settings, or logs.",
  "NovelAI Token 无效或已经失效。": "The NovelAI Token is invalid or expired.",
  "无法读取 NovelAI 订阅与 Anlas 信息。": "Unable to read NovelAI subscription and Anlas information.",
});

const EN_PATTERNS = Object.freeze([
  [/^角色 (\d+)$/, "Char $1"],
  [/^参考 (\d+)$/, "Reference $1"],
  [/^图片读取失败：(.*)$/, "Failed to read image: $1"],
  [/^图片元数据读取失败：(.*)$/, "Failed to read image metadata: $1"],
]);

function currentLocale(app) {
  let locale = "";
  try {
    locale = app?.extensionManager?.setting?.get?.("Comfy.Locale") || "";
  } catch (_) {
    locale = "";
  }
  if (!locale) {
    try {
      locale = app?.ui?.settings?.getSettingValue?.("Comfy.Locale") || "";
    } catch (_) {
      locale = "";
    }
  }
  return String(locale || globalThis.navigator?.language || "zh").toLowerCase();
}

export function createNaiTranslator(app) {
  return (message, values = {}) => {
    const source = String(message ?? "");
    const isChinese = currentLocale(app).startsWith("zh");
    let translated = isChinese ? source : (EN[source] || source);
    if (!isChinese && translated === source) {
      for (const [pattern, replacement] of EN_PATTERNS) {
        if (!pattern.test(source)) continue;
        translated = source.replace(pattern, replacement);
        break;
      }
    }
    return translated.replace(/\{(\w+)\}/g, (match, key) => (
      Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
    ));
  };
}

export function withSyncedDomWidth(options = {}) {
  const previousAfterResize = options.afterResize;
  const previousOnDraw = options.onDraw;
  const sync = (widget, node) => {
    const target = widget?._node || widget?.node || node;
    const width = Number(target?.size?.[0]);
    if (widget && width > 0 && widget.width !== width) widget.width = width;
  };
  return {
    ...options,
    afterResize(node) {
      sync(this, node);
      return previousAfterResize?.call(this, node);
    },
    onDraw(widget) {
      sync(widget, widget?._node || widget?.node);
      return previousOnDraw?.(widget);
    },
  };
}

/**
 * Show or hide a widget without permanently converting it to an internal field.
 */
export function setNaiWidgetVisible(widget, visible) {
  if (!widget) return false;
  if (!widget.__nai4aVisibility) {
    widget.__nai4aVisibility = {
      type: widget.type,
      computeSize: widget.computeSize,
      computeLayoutSize: widget.computeLayoutSize,
    };
  }
  const original = widget.__nai4aVisibility;
  widget.hidden = !visible;
  widget.options = {
    ...(widget.options || {}),
    hidden: !visible,
    hideOnGraph: !visible,
  };
  if (visible) {
    if (original.type && original.type !== "hidden") widget.type = original.type;
    widget.computeSize = original.computeSize;
    widget.computeLayoutSize = original.computeLayoutSize;
  } else {
    if (widget.type && widget.type !== "hidden") original.type = widget.type;
    widget.type = "hidden";
    widget.computeSize = () => [0, 0];
    widget.computeLayoutSize = () => ({
      minHeight: 0,
      maxHeight: 0,
      minWidth: 0,
      maxWidth: 0,
    });
    widget.computedHeight = 0;
  }
  return true;
}

/**
 * Hide a backend/internal widget in both legacy LiteGraph and Node 2.0.
 */
export function hideNaiInternalWidget(widget) {
  if (!widget) return false;
  widget.type = "hidden";
  widget.hidden = true;
  widget.serialize = widget.serialize !== false;
  widget.options = {
    ...(widget.options || {}),
    hidden: true,
    hideInPanel: true,
    advanced: true,
  };
  widget.draw = () => {};
  widget.computeSize = () => [0, 0];
  widget.computeLayoutSize = () => ({
    minHeight: 0,
    maxHeight: 0,
    minWidth: 0,
    maxWidth: 0,
  });
  widget.computedHeight = 0;
  widget.y = -100000;
  for (const element of [
    widget.element,
    widget.inputEl,
    widget.el,
    widget.container,
  ]) {
    if (!element?.style) continue;
    element.style.setProperty?.("display", "none", "important");
    element.style.setProperty?.("visibility", "hidden", "important");
    element.style.display = "none";
    element.style.visibility = "hidden";
    element.hidden = true;
  }
  return true;
}

export function writeNaiNodeWidget(node, widget, value, { callback = false } = {}) {
  if (!widget) return false;
  const changed = widget.value !== value;
  widget.value = value;
  if (widget.inputEl) widget.inputEl.value = value;
  if (Array.isArray(node?.widgets_values) && Array.isArray(node.widgets)) {
    const index = node.widgets.indexOf(widget);
    if (index >= 0) node.widgets_values[index] = value;
  }
  if (changed && callback) widget.callback?.(value, undefined, node, [0, 0], {});
  return changed;
}

export function graphNodes(graph) {
  return graph?._nodes || graph?.nodes || [];
}

export function naiNodeClass(node) {
  return String(node?.comfyClass || node?.type || "");
}

function graphLink(graph, linkId) {
  const links = graph?.links;
  const link = links instanceof Map ? links.get(linkId) : links?.[linkId];
  if (Array.isArray(link)) {
    return {
      id: link[0],
      origin_id: link[1],
      origin_slot: link[2],
      target_id: link[3],
      target_slot: link[4],
      type: link[5],
    };
  }
  return link || null;
}

function nodeById(graph, id) {
  return graph?.getNodeById?.(id)
    || graphNodes(graph).find((node) => String(node?.id) === String(id))
    || null;
}

export function connectedGraphNodes(start, direction = "downstream") {
  if (!start) return [];
  const graph = start.graph;
  const visited = new Set([String(start.id)]);
  const queue = [start];
  const found = [];
  while (queue.length) {
    const node = queue.shift();
    const linkIds = direction === "upstream"
      ? (node.inputs || []).map((input) => input?.link)
      : (node.outputs || []).flatMap((output) => output?.links || []);
    for (const linkId of linkIds) {
      if (linkId === null || linkId === undefined) continue;
      const link = graphLink(graph, linkId);
      const nextId = direction === "upstream" ? link?.origin_id : link?.target_id;
      const next = nodeById(graph, nextId);
      if (!next || visited.has(String(next.id))) continue;
      visited.add(String(next.id));
      found.push(next);
      queue.push(next);
    }
  }
  return found;
}

export async function nai4aRequestJson(path, body, fetcher = globalThis.fetch) {
  const response = await fetcher(path, {
    method: "POST",
    cache: "no-store",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  if (!raw.trim()) throw new Error(`HTTP ${response.status}: empty response`);
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    throw new Error(`HTTP ${response.status}: invalid JSON`);
  }
  if (!response.ok || data?.success === false) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }
  return data;
}
