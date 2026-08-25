const MODEL_HASH_LABELS = Object.freeze({
  "0ADF9AB7": "V5 Full",
  "657484A5": "V5 Full",
  DB276663: "V5 Curated",
  "4BDE2A90": "V4.5 Full",
  B9F340FD: "V4.5 Full",
  C02D4F98: "V4.5 Curated",
});

const MODEL_IDS = Object.freeze({
  "nai-diffusion-5-full": "V5 Full",
  "nai-diffusion-5-curated": "V5 Curated",
  "nai-diffusion-4-5-full": "V4.5 Full",
  "nai-diffusion-4-5-curated": "V4.5 Curated",
});

function firstString(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return firstString(value[0]);
  return null;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseJson(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

export function metadataValue(metadata, wantedKey) {
  if (!metadata || typeof metadata !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(metadata, wantedKey)) return metadata[wantedKey];
  const wanted = wantedKey.toLowerCase();
  const key = Object.keys(metadata).find((candidate) => candidate.toLowerCase() === wanted);
  return key === undefined ? undefined : metadata[key];
}

function metadataStrings(metadata, keys) {
  const values = [];
  const seen = new Set();
  for (const key of keys) {
    const value = firstString(metadataValue(metadata, key));
    if (!value?.trim() || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}

function looksLikeComfyGraph(value) {
  const parsed = parseJson(value);
  if (!parsed || Array.isArray(parsed)) return false;
  if (Array.isArray(parsed.nodes) && Array.isArray(parsed.links)) return true;
  return Object.values(parsed).some((entry) => (
    entry && typeof entry === "object" && typeof entry.class_type === "string"
  ));
}

export function sanitizeNaiRawMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const result = {};
  for (const [key, value] of Object.entries(metadata)) {
    const lower = key.toLowerCase();
    if (lower === "workflow" || lower === "prompt" || looksLikeComfyGraph(value)) continue;
    result[key] = value;
  }
  return result;
}

export function clampNaiCoordinate(value) {
  const number = finiteNumber(value);
  return number === null ? 0.5 : Math.max(0, Math.min(1, number));
}

export function buildNaiMetadataCharacters(positiveCaption, negativeCaption, v4Prompt) {
  const positive = Array.isArray(positiveCaption?.char_captions)
    ? positiveCaption.char_captions : [];
  const negative = Array.isArray(negativeCaption?.char_captions)
    ? negativeCaption.char_captions : [];
  const useCoords = v4Prompt?.use_coords === true;
  const useOrder = v4Prompt?.use_order === true;
  return Array.from({ length: Math.max(positive.length, negative.length) }, (_, index) => {
    const positiveEntry = positive[index];
    const negativeEntry = negative[index];
    const center = useCoords ? positiveEntry?.centers?.[0] : null;
    const hasPosition = finiteNumber(center?.x) !== null && finiteNumber(center?.y) !== null;
    return {
      id: `char-${index + 1}`,
      name: `角色 ${index + 1}`,
      enabled: true,
      positive: cleanText(positiveEntry?.char_caption),
      negative: cleanText(negativeEntry?.char_caption),
      mode: "sequence",
      use_position: hasPosition,
      x: hasPosition ? clampNaiCoordinate(center.x) : 0.5,
      y: hasPosition ? clampNaiCoordinate(center.y) : 0.5,
      use_order: useOrder,
    };
  });
}

function sourceHash(source) {
  return /\b([0-9a-f]{8})\b/i.exec(source)?.[1]?.toUpperCase() || "";
}

export function parseNaiModel(comment, metadata) {
  const source = cleanText(firstString(metadataValue(metadata, "Source")));
  const raw = cleanText(comment?.model ?? comment?.model_name) || source;
  const direct = MODEL_IDS[raw] || (Object.values(MODEL_IDS).includes(raw) ? raw : "");
  const hash = cleanText(comment?.model_hash).toUpperCase() || sourceHash(source);
  const label = direct || MODEL_HASH_LABELS[hash] || "";
  if (!raw && !hash) return null;
  return { label, raw, hash };
}

export function parseNaiGeneration(comment) {
  if (!comment || typeof comment !== "object" || Array.isArray(comment)) {
    return { parameters: {}, seed: null };
  }
  const parameters = {};
  const integerFields = [
    ["steps", comment.steps],
    ["width", comment.width],
    ["height", comment.height],
  ];
  for (const [key, value] of integerFields) {
    const number = finiteNumber(value);
    if (number !== null && (key === "steps" || number > 0)) parameters[key] = Math.trunc(number);
  }
  const cfg = finiteNumber(comment.scale ?? comment.cfg);
  const cfgRescale = finiteNumber(comment.cfg_rescale);
  const sampler = cleanText(comment.sampler);
  const scheduler = cleanText(comment.noise_schedule ?? comment.scheduler);
  if (cfg !== null) parameters.cfg = cfg;
  if (sampler) parameters.sampler = sampler;
  if (scheduler) parameters.scheduler = scheduler;
  if (cfgRescale !== null) parameters.cfg_rescale = cfgRescale;
  const seed = finiteNumber(comment.seed);
  return {
    parameters,
    seed: seed === null ? null : Math.max(0, Math.trunc(seed)),
  };
}

export function parseNovelAIMetadata(metadata) {
  const commentRaw = metadataValue(metadata, "Comment");
  const comment = parseJson(commentRaw) || {};
  const software = cleanText(firstString(metadataValue(metadata, "Software")));
  const source = cleanText(firstString(metadataValue(metadata, "Source")));
  const title = cleanText(firstString(metadataValue(metadata, "Title")));
  const isNovelAI = /^novelai\b/i.test(software)
    || /^novelai\b/i.test(source)
    || /^novelai generated image$/i.test(title)
    || Boolean(comment.v4_prompt)
    || comment.request_type === "PromptGenerateRequest";
  if (!isNovelAI) return null;

  const positiveCaption = comment?.v4_prompt?.caption;
  const negativeCaption = comment?.v4_negative_prompt?.caption;
  const prompt = cleanText(positiveCaption?.base_caption)
    || cleanText(comment.prompt)
    || cleanText(firstString(metadataValue(metadata, "Description")));
  const uc = cleanText(negativeCaption?.base_caption)
    || cleanText(comment.uc ?? comment.negative_prompt);
  const characters = buildNaiMetadataCharacters(
    positiveCaption,
    negativeCaption,
    comment?.v4_prompt,
  );
  const { parameters, seed } = parseNaiGeneration(comment);
  return {
    source_type: "novelai",
    source_label: "NovelAI",
    model: parseNaiModel(comment, metadata),
    parameters,
    seed,
    prompt,
    uc,
    characters,
  };
}

function documentPrompt(value, depth = 0) {
  if (depth > 4) return null;
  const parsed = parseJson(value);
  if (!parsed || Array.isArray(parsed)) return null;
  const positive = cleanText(parsed.positive ?? parsed.content ?? parsed.nai?.content);
  const negative = cleanText(parsed.negative ?? parsed.uc ?? parsed.nai?.negative);
  const tracks = Array.isArray(parsed.tracks) ? parsed.tracks : [];
  const trackText = tracks
    .filter((entry) => entry?.enabled !== false && typeof entry?.text === "string")
    .map((entry) => entry.text.trim())
    .filter(Boolean)
    .join(",\n");
  if (positive || negative || trackText) {
    return { prompt: positive || trackText, uc: negative };
  }
  for (const candidate of Object.values(parsed)) {
    if (typeof candidate !== "string" && (!candidate || typeof candidate !== "object")) continue;
    const nested = documentPrompt(candidate, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function parseA1111Prompt(metadata) {
  for (const raw of metadataStrings(metadata, ["parameters", "UserComment", "Comment"])) {
    const text = raw.replace(/\r\n?/g, "\n").trim();
    const negativeMarker = /\n\s*Negative prompt\s*:/i.exec(text);
    const settingsPattern = /\n\s*Steps\s*:/i;
    if (negativeMarker) {
      const prompt = text.slice(0, negativeMarker.index).trim();
      const remainder = text.slice(negativeMarker.index + negativeMarker[0].length);
      const settings = settingsPattern.exec(remainder);
      return { prompt, uc: (settings ? remainder.slice(0, settings.index) : remainder).trim() };
    }
    const settings = settingsPattern.exec(text);
    if (settings) return { prompt: text.slice(0, settings.index).trim(), uc: "" };
  }
  return null;
}

function findText(value, keys, depth = 0, seen = new Set()) {
  if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) return "";
  seen.add(value);
  for (const key of keys) {
    const actual = Object.keys(value).find((candidate) => candidate.toLowerCase() === key);
    const candidate = actual === undefined ? undefined : value[actual];
    if (typeof candidate === "string" && candidate.trim() && !looksLikeComfyGraph(candidate)) {
      return candidate.trim();
    }
  }
  for (const [key, candidate] of Object.entries(value)) {
    if (["workflow", "prompt"].includes(key.toLowerCase()) || looksLikeComfyGraph(candidate)) continue;
    const child = parseJson(candidate);
    if (!child) continue;
    const found = findText(child, keys, depth + 1, seen);
    if (found) return found;
  }
  return "";
}

export function parsePromptOnlyMetadata(metadata) {
  for (const raw of metadataStrings(metadata, [
    "pm4a_prompt_json", "Comment", "UserComment", "parameters",
  ])) {
    const document = documentPrompt(raw);
    if (document) return { source_type: "generic", source_label: "Prompt", ...document };
  }
  const a1111 = parseA1111Prompt(metadata);
  if (a1111?.prompt || a1111?.uc) {
    return { source_type: "generic", source_label: "A1111", ...a1111 };
  }
  const prompt = findText(metadata, [
    "positive", "description", "imagedescription", "caption", "base_caption", "text",
  ]);
  const uc = findText(metadata, [
    "negative", "negative_prompt", "negativeprompt", "uc", "undesired_content",
    "undesired content",
  ]);
  if (!prompt && !uc) return null;
  return { source_type: "generic", source_label: "Prompt", prompt, uc };
}

async function gunzipJson(bytes) {
  if (typeof DecompressionStream === "undefined") return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(new TextDecoder().decode(await new Response(stream).arrayBuffer()));
}

export async function extractNovelAIStealthMetadata(file) {
  const name = String(file?.name || "").toLowerCase();
  const isPng = file?.type === "image/png" || name.endsWith(".png");
  const isWebp = file?.type === "image/webp" || name.endsWith(".webp");
  if ((!isPng && !isWebp) || typeof createImageBitmap !== "function" || !globalThis.document) {
    return null;
  }
  if (isPng) {
    try {
      const header = new Uint8Array(await file.slice(0, 26).arrayBuffer());
      if (header.length < 26 || (header[25] !== 4 && header[25] !== 6)) return null;
    } catch (_) {
      return null;
    }
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const capacity = bitmap.width * bitmap.height;
    let position = 0;
    const readByte = () => {
      if (position + 8 > capacity) throw new Error("stealth metadata truncated");
      let value = 0;
      for (let bit = 0; bit < 8; bit += 1) {
        const x = Math.floor(position / bitmap.height);
        const y = position % bitmap.height;
        value = (value << 1) | (rgba[(y * bitmap.width + x) * 4 + 3] & 1);
        position += 1;
      }
      return value;
    };
    const readBytes = (length) => Uint8Array.from({ length }, readByte);
    const magic = new TextDecoder().decode(readBytes("stealth_pngcomp".length));
    if (magic !== "stealth_pngcomp") return null;
    const length = readBytes(4);
    const bitLength = length[0] * 0x1000000 + (length[1] << 16) + (length[2] << 8) + length[3];
    const byteLength = Math.floor(bitLength / 8);
    if (byteLength < 1 || byteLength > 16 * 1024 * 1024 || position + byteLength * 8 > capacity) {
      return null;
    }
    const metadata = await gunzipJson(readBytes(byteLength));
    if (!metadata || typeof metadata !== "object") return null;
    if (typeof metadata.Comment === "string") metadata.Comment = parseJson(metadata.Comment) || metadata.Comment;
    return metadata;
  } catch (_) {
    return null;
  } finally {
    bitmap?.close?.();
  }
}
