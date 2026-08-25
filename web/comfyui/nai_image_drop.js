export const COMFY_ASSET_INFO_MIME = "application/x-comfy-asset-info";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

export function looksLikeImageFile(file) {
  return Boolean(file && (
    file.type?.startsWith("image/")
    || /\.(?:png|jpe?g|webp|gif|bmp|tiff?|avif)$/i.test(file.name || "")
  ));
}

function parseComfyAssetInfo(raw) {
  try {
    const value = JSON.parse(raw || "");
    return value && typeof value.filename === "string" ? value : null;
  } catch (_) {
    return null;
  }
}

export function hasSupportedImageTransfer(dataTransfer) {
  const files = Array.from(dataTransfer?.files || []);
  const items = Array.from(dataTransfer?.items || []);
  const types = Array.from(dataTransfer?.types || []);
  return files.some(looksLikeImageFile)
    || items.some((item) => item.kind === "file" && item.type?.startsWith("image/"))
    || types.includes("Files")
    || types.includes(COMFY_ASSET_INFO_MIME)
    || types.includes("text/uri-list");
}

async function responseBlobWithinLimit(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const blob = await response.blob();
    if (blob.size > MAX_IMAGE_BYTES) throw new Error("图片不能超过 32 MB");
    return blob;
  }

  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw new Error("图片不能超过 32 MB");
    }
    chunks.push(value);
  }
  return new Blob(chunks, { type: response.headers.get("Content-Type") || "" });
}

export async function fetchImageFile(url, fileName) {
  if (!looksLikeImageFile({ name: fileName })) {
    throw new Error("拖入的资产不是支持的图片");
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`图片读取失败：${response.status}`);

  const contentType = response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType
    && !contentType.startsWith("image/")
    && contentType !== "application/octet-stream") {
    throw new Error("拖入的资产不是支持的图片");
  }

  const contentLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
    throw new Error("图片不能超过 32 MB");
  }

  const blob = await responseBlobWithinLimit(response);
  const file = new File([blob], fileName || "asset.png", { type: blob.type });
  if (!looksLikeImageFile(file)) throw new Error("拖入的资产不是支持的图片");
  return file;
}

export async function imageFileFromTransfer(dataTransfer, { viewPath = "/view" } = {}) {
  const directFile = Array.from(dataTransfer?.files || []).find(looksLikeImageFile);
  const itemFile = directFile ? null : Array.from(dataTransfer?.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile?.())
    .find(looksLikeImageFile);
  const localFile = directFile || itemFile;
  if (localFile) return localFile;

  let fetchError = null;
  const asset = parseComfyAssetInfo(dataTransfer?.getData?.(COMFY_ASSET_INFO_MIME));
  if (asset?.filename) {
    const url = new URL(viewPath, location.href);
    url.searchParams.set("filename", asset.filename);
    url.searchParams.set("type", asset.type || "output");
    if (asset.subfolder) url.searchParams.set("subfolder", asset.subfolder);
    try {
      return await fetchImageFile(url, asset.filename);
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
        return await fetchImageFile(
          url,
          url.searchParams.get("filename") || url.pathname.split("/").pop(),
        );
      }
    } catch (error) {
      fetchError ||= error;
    }
  }

  if (fetchError) throw fetchError;
  return null;
}

export function normalizeStoredImageReference(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const filename = String(value.filename || value.name || "").trim();
  if (!filename) return null;
  const subfolder = String(value.subfolder || "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "");
  const requestedType = String(value.type || "").trim().toLowerCase();
  const type = ["input", "output", "temp"].includes(requestedType)
    ? requestedType
    : "input";
  return { filename, subfolder, type };
}

export function imageReferenceFromComboValue(value) {
  let raw = String(value || "").trim().replaceAll("\\", "/");
  if (!raw) return null;
  let type = "input";
  const annotated = /^(.*) \[(input|output|temp)\]$/i.exec(raw);
  if (annotated) {
    raw = annotated[1].trim();
    type = annotated[2].toLowerCase();
  }
  const slash = raw.lastIndexOf("/");
  return normalizeStoredImageReference({
    filename: slash < 0 ? raw : raw.slice(slash + 1),
    subfolder: slash < 0 ? "" : raw.slice(0, slash),
    type,
  });
}

export function imageReferenceLabel(value) {
  const reference = normalizeStoredImageReference(value);
  if (!reference) return "";
  return reference.subfolder
    ? `${reference.subfolder}/${reference.filename}`
    : reference.filename;
}

export function buildStoredImageUrl(value, viewPath = "/view") {
  const reference = normalizeStoredImageReference(value);
  if (!reference) return "";
  const query = new URLSearchParams({
    filename: reference.filename,
    subfolder: reference.subfolder,
    type: reference.type,
  });
  return `${viewPath}?${query.toString()}`;
}

export async function uploadInputImage(file, fetchApi) {
  const form = new FormData();
  form.append("image", file, file.name || "imported-image");
  form.append("type", "input");
  const response = await fetchApi("/upload/image", { method: "POST", body: form });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || `图片持久化失败：${response.status}`);
  }
  const reference = normalizeStoredImageReference(payload);
  if (!reference) throw new Error("图片上传成功，但返回的文件引用无效");
  return reference;
}

export function bindOfficialImageDrop(root, { app, node, onDrop }) {
  const setGlow = (active) => {
    if (active) app.dragOverNode = node;
    else if (app.dragOverNode?.id === node.id) app.dragOverNode = null;
    node.setDirtyCanvas?.(false, true);
    app.canvas?.setDirty?.(false, true);
  };
  const accept = (event) => {
    if (!hasSupportedImageTransfer(event?.dataTransfer)) return false;
    event.preventDefault();
    event.stopPropagation();
    setGlow(true);
    return true;
  };
  root.addEventListener("dragenter", accept);
  root.addEventListener("dragover", accept);
  root.addEventListener("dragleave", (event) => {
    if (!root.contains?.(event.relatedTarget)) setGlow(false);
  });
  root.addEventListener("drop", (event) => {
    if (!accept(event)) return undefined;
    setGlow(false);
    return onDrop(event.dataTransfer);
  });

  const originalOnDragDrop = node.onDragDrop;
  node.onDragDrop = function (event) {
    if (hasSupportedImageTransfer(event?.dataTransfer)) return onDrop(event.dataTransfer);
    return originalOnDragDrop?.apply(this, arguments) ?? false;
  };
  const originalOnDragOver = node.onDragOver;
  node.onDragOver = function (event) {
    if (hasSupportedImageTransfer(event?.dataTransfer)) return true;
    return originalOnDragOver?.apply(this, arguments) ?? false;
  };
}
