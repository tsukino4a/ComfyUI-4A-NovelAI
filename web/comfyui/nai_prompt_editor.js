/**
 * Native textarea editor with a separate highlighted preview while unfocused.
 */

export const NAI_PROMPT_BRACE_FACTOR = 1.05;
const NUMBER_OPEN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)::/;
const PAIR_CLOSE = Object.freeze({ "{": "}", "[": "]" });
const PAIR_OPEN = Object.freeze({ "}": "{", "]": "[" });
const SELECTION_PAIR_CLOSE = Object.freeze({ ...PAIR_CLOSE, ":": ":" });
const PROMPT_HISTORY_LIMIT = 100;

let stylesInjected = false;

function promptSnapshot(value, selectionStart, selectionEnd) {
  const text = String(value ?? "");
  const start = Math.max(0, Math.min(text.length, Number(selectionStart) || 0));
  const end = Math.max(start, Math.min(text.length, Number(selectionEnd) || start));
  return { value: text, selectionStart: start, selectionEnd: end };
}

function copyPromptSnapshot(snapshot) {
  return snapshot ? { ...snapshot } : null;
}

export function createNaiPromptHistory(initialValue = "", limit = PROMPT_HISTORY_LIMIT) {
  const maximum = Math.max(2, Number.parseInt(limit, 10) || PROMPT_HISTORY_LIMIT);
  const text = String(initialValue ?? "");
  let entries = [promptSnapshot(text, text.length, text.length)];
  let index = 0;
  const current = () => entries[index];
  return {
    current() {
      return copyPromptSnapshot(current());
    },
    capture(snapshot) {
      const next = promptSnapshot(
        snapshot?.value,
        snapshot?.selectionStart,
        snapshot?.selectionEnd,
      );
      if (next.value !== current().value) return false;
      entries[index] = next;
      return true;
    },
    push(snapshot) {
      const next = promptSnapshot(
        snapshot?.value,
        snapshot?.selectionStart,
        snapshot?.selectionEnd,
      );
      if (next.value === current().value) {
        entries[index] = next;
        return false;
      }
      entries.splice(index + 1);
      entries.push(next);
      if (entries.length > maximum) entries = entries.slice(-maximum);
      index = entries.length - 1;
      return true;
    },
    sync(value, { record = true } = {}) {
      const textValue = String(value ?? "");
      if (textValue === current().value) return copyPromptSnapshot(current());
      const next = promptSnapshot(textValue, textValue.length, textValue.length);
      if (record) this.push(next);
      else {
        entries = [next];
        index = 0;
      }
      return copyPromptSnapshot(current());
    },
    undo() {
      if (index <= 0) return null;
      index -= 1;
      return copyPromptSnapshot(current());
    },
    redo() {
      if (index >= entries.length - 1) return null;
      index += 1;
      return copyPromptSnapshot(current());
    },
  };
}

function promptHistoryAction(event) {
  if (!(event?.ctrlKey || event?.metaKey) || event?.altKey) return "";
  const key = String(event.key || "").toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && !event.shiftKey) return "redo";
  return "";
}

function isNaiPromptInput(target) {
  return target?.dataset?.nai4aPromptInput === "true"
    || target?.classList?.contains?.("nai4a-prompt-input")
    || Boolean(target?.closest?.(".nai4a-prompt-input"));
}

export function installNaiPromptUndoGuard(ChangeTracker) {
  const prototype = ChangeTracker?.prototype;
  if (!prototype || typeof prototype.undoRedo !== "function") return false;
  if (prototype.__nai4aPromptUndoGuard) return true;
  const original = prototype.undoRedo;
  prototype.undoRedo = async function (event) {
    if (promptHistoryAction(event) && isNaiPromptInput(event?.target)) return true;
    return original.apply(this, arguments);
  };
  prototype.__nai4aPromptUndoGuard = true;
  return true;
}

export function normalizeNaiPromptWeight(weight) {
  const value = Number(weight);
  if (!Number.isFinite(value)) return 1;
  return Math.round(value * 1e6) / 1e6;
}

export function naiPromptWeightTone(weight) {
  const value = normalizeNaiPromptWeight(weight);
  if (value < 1) return "low";
  if (value > 1) return "high";
  return "base";
}

export function naiPromptWeightLevel(weight) {
  const value = normalizeNaiPromptWeight(weight);
  const tone = naiPromptWeightTone(value);
  if (tone === "base") return 0;
  if (tone === "low") {
    const ratio = 1 / Math.max(value, 1e-6);
    return Math.min(8, Math.max(1, Math.round(Math.log(ratio) / Math.log(NAI_PROMPT_BRACE_FACTOR))));
  }
  return Math.min(8, Math.max(1, Math.round(Math.log(value) / Math.log(NAI_PROMPT_BRACE_FACTOR))));
}

export function naiPromptWeightOpacity(weight) {
  const level = naiPromptWeightLevel(weight);
  if (!level) return 0;
  return Math.round(Math.min(1, 0.12 + (level * 0.11)) * 1000) / 1000;
}

function currentNumericWeight(stack) {
  return stack.length ? stack[stack.length - 1] : 1;
}

export function parseNaiPromptSegments(value) {
  const source = String(value ?? "");
  const segments = [];
  const numericStack = [];
  let braceWeight = 1;
  let index = 0;

  const weightNow = () => normalizeNaiPromptWeight(currentNumericWeight(numericStack) * braceWeight);

  const emit = (chunk, weight, kind) => {
    if (!chunk) return;
    const numericDepth = numericStack.length;
    const last = segments[segments.length - 1];
    if (
      last
      && last.kind === kind
      && last.weight === weight
      && last.numericDepth === numericDepth
    ) {
      last.text += chunk;
      return;
    }
    segments.push({ text: chunk, weight, kind, numericDepth });
  };

  while (index < source.length) {
    const slice = source.slice(index);
    const numbered = slice.match(NUMBER_OPEN);
    if (numbered) {
      const parsed = Number.parseFloat(numbered[0]);
      numericStack.push(Number.isFinite(parsed) ? parsed : 1);
      emit(numbered[0], weightNow(), "numeric-open");
      index += numbered[0].length;
      continue;
    }
    if (slice.startsWith("::")) {
      const weight = weightNow();
      const matched = numericStack.length > 0;
      emit("::", weight, matched ? "numeric-close" : "numeric");
      if (numericStack.length) numericStack.pop();
      index += 2;
      continue;
    }
    const ch = source[index];
    if (ch === "{") {
      braceWeight *= NAI_PROMPT_BRACE_FACTOR;
      emit(ch, weightNow(), "brace");
    } else if (ch === "}") {
      emit(ch, weightNow(), "brace");
      braceWeight /= NAI_PROMPT_BRACE_FACTOR;
    } else if (ch === "[") {
      braceWeight /= NAI_PROMPT_BRACE_FACTOR;
      emit(ch, weightNow(), "brace");
    } else if (ch === "]") {
      emit(ch, weightNow(), "brace");
      braceWeight *= NAI_PROMPT_BRACE_FACTOR;
    } else {
      emit(ch, weightNow(), "text");
    }
    index += 1;
  }
  return segments;
}

function naiPromptSegmentTone(segment) {
  if (segment.kind === "numeric-close") return "close";
  if (
    segment.numericDepth > 0
    && normalizeNaiPromptWeight(segment.weight) === 1
  ) {
    return "unity";
  }
  return naiPromptWeightTone(segment.weight);
}

export function applyNaiBracketPairing(state, key) {
  const value = String(state?.value ?? "");
  const start = Math.max(0, Number(state?.selectionStart) || 0);
  const end = Math.max(start, Number(state?.selectionEnd) || start);
  if (key === "Backspace") {
    if (start !== end) return null;
    const prev = value[start - 1];
    const next = value[start];
    if (!PAIR_CLOSE[prev] || PAIR_CLOSE[prev] !== next) return null;
    return {
      value: `${value.slice(0, start - 1)}${value.slice(start + 1)}`,
      selectionStart: start - 1,
      selectionEnd: start - 1,
    };
  }
  if (start !== end && SELECTION_PAIR_CLOSE[key]) {
    const close = SELECTION_PAIR_CLOSE[key];
    const selected = value.slice(start, end);
    return {
      value: `${value.slice(0, start)}${key}${selected}${close}${value.slice(end)}`,
      selectionStart: start + 1,
      selectionEnd: start + 1 + selected.length,
    };
  }
  if (PAIR_CLOSE[key]) {
    const close = PAIR_CLOSE[key];
    const selected = value.slice(start, end);
    return {
      value: `${value.slice(0, start)}${key}${selected}${close}${value.slice(end)}`,
      selectionStart: start + 1,
      selectionEnd: start + 1 + selected.length,
    };
  }
  if (PAIR_OPEN[key]) {
    if (start !== end) return null;
    if (value[start] !== key) return null;
    return {
      value,
      selectionStart: start + 1,
      selectionEnd: start + 1,
      skip: true,
    };
  }
  return null;
}

function renderNaiPromptPreview(preview, value, doc) {
  const nodes = [];
  for (const segment of parseNaiPromptSegments(value)) {
    const tone = naiPromptSegmentTone(segment);
    if (tone === "base") {
      nodes.push(doc.createTextNode(segment.text));
      continue;
    }
    const span = doc.createElement("span");
    span.textContent = segment.text;
    if (tone === "close" || tone === "unity") {
      span.style.backgroundColor = "#075314";
    } else {
      const color = tone === "high" ? [116, 39, 13] : [8, 67, 137];
      span.style.backgroundColor = `rgba(${color.join(",")},${naiPromptWeightOpacity(segment.weight)})`;
    }
    nodes.push(span);
  }
  preview.replaceChildren(...nodes);
}

function replaceTextareaRange(
  input,
  start,
  end,
  text,
  selectStart,
  selectEnd,
  scope,
  doc,
) {
  input.focus?.();
  input.setSelectionRange?.(start, end);
  let applied = false;
  try {
    applied = text === ""
      ? Boolean(doc?.execCommand?.("delete"))
      : Boolean(doc?.execCommand?.("insertText", false, text));
  } catch (_) {
    applied = false;
  }
  if (!applied) {
    if (typeof input.setRangeText === "function") {
      input.setRangeText(text, start, end, "end");
    } else {
      const current = String(input.value || "");
      input.value = `${current.slice(0, start)}${text}${current.slice(end)}`;
    }
    const InputEvent = scope.InputEvent || scope.Event;
    input.dispatchEvent?.(new InputEvent("input", {
      bubbles: true,
      inputType: text === "" ? "deleteContentBackward" : "insertText",
      data: text === "" ? null : text,
    }));
  }
  if (selectStart == null) return;
  input.setSelectionRange?.(selectStart, selectEnd);
}

function injectEditorStyles(doc) {
  if (stylesInjected || !doc?.createElement) return;
  if (doc.getElementById?.("nai4a-prompt-editor-styles")) {
    stylesInjected = true;
    return;
  }
  stylesInjected = true;
  const style = doc.createElement("style");
  style.id = "nai4a-prompt-editor-styles";
  style.textContent = `
    .nai4a-prompt-editor { position:relative; width:100%; height:54px; min-height:54px; overflow:hidden; border:1px solid #4b4f55; border-radius:4px; background:#151719; resize:vertical; }
    .nai4a-prompt-editor .nai4a-prompt-input, .nai4a-prompt-editor .nai4a-prompt-preview { position:absolute; inset:0; width:100%; height:100%; margin:0; padding:5px 7px; overflow:auto; border:0 !important; border-radius:0; outline:0; color:#eee; background:transparent !important; box-sizing:border-box; font:inherit; font-variant-ligatures:none; line-height:inherit; letter-spacing:inherit; tab-size:4; white-space:pre-wrap; overflow-wrap:break-word; word-wrap:break-word; }
    .nai4a-prompt-editor .nai4a-prompt-input { caret-color:#eee; resize:none !important; }
    .nai4a-prompt-editor .nai4a-prompt-preview { pointer-events:none; }
    .nai4a-prompt-editor .nai4a-prompt-input::placeholder { color:#8a9098; -webkit-text-fill-color:#8a9098; opacity:1; }
    .nai4a-prompt-editor:not(.nai4a-editing) .nai4a-prompt-input { color:transparent; -webkit-text-fill-color:transparent; caret-color:transparent; }
    .nai4a-prompt-editor:not(.nai4a-editing) .nai4a-prompt-input::placeholder { color:transparent; -webkit-text-fill-color:transparent; }
    .nai4a-prompt-editor .nai4a-prompt-preview:empty::before { content:attr(data-placeholder); color:#8a9098; pointer-events:none; }
    .nai4a-prompt-editor.nai4a-linked, .nai4a-prompt-input.nai4a-linked { background:#2a3b2a !important; border-color:#2a3b2a !important; cursor:crosshair; }
  `;
  doc.head?.appendChild(style);
}

export function createNaiPromptEditor(options = {}, scope = globalThis) {
  const doc = options.document || scope.document;
  injectEditorStyles(doc);
  const root = doc.createElement("div");
  root.className = "nai4a-prompt-editor";
  root.classList.add("nai4a-prompt-editor");
  const input = doc.createElement("textarea");
  input.className = "nai4a-prompt-input";
  input.classList.add("nai4a-prompt-input");
  input.dataset.nai4aPromptInput = "true";
  input.spellcheck = false;
  input.value = String(options.value ?? "");
  if (options.placeholder) input.placeholder = options.placeholder;
  const preview = doc.createElement("div");
  preview.className = "nai4a-prompt-preview";
  preview.classList.add("nai4a-prompt-preview");
  preview.setAttribute("aria-hidden", "true");
  preview.dataset.placeholder = options.placeholder || "";
  if (options.resizeKind) root.dataset.nai4aResizeKind = options.resizeKind;
  if (options.ownerId) root.dataset.nai4aOwnerId = options.ownerId;
  if (options.height) root.style.height = `${options.height}px`;
  let readOnly = Boolean(options.readOnly);
  let composing = false;
  let history = options.history || createNaiPromptHistory(input.value);
  const valueOf = () => String(input.value || "");
  const paintHighlights = () => renderNaiPromptPreview(preview, valueOf(), doc);
  const selectionOffsets = () => ({
    start: Number(input.selectionStart) || 0,
    end: Number(input.selectionEnd) || 0,
  });
  const setSelection = (start, end) => input.setSelectionRange?.(start, end);
  const snapshot = () => {
    const { start, end } = selectionOffsets();
    return promptSnapshot(valueOf(), start, end);
  };
  const showPreview = () => {
    paintHighlights();
    input.hidden = false;
    preview.hidden = false;
    root.classList.remove("nai4a-editing");
  };
  const beginEditing = () => {
    preview.hidden = true;
    input.hidden = false;
    root.classList.add("nai4a-editing");
  };
  const onInput = () => {
    paintHighlights();
    if (!composing) history.push(snapshot());
    options.onInput?.(valueOf(), input);
  };
  const onBeforeInput = () => history.capture(snapshot());
  const onCompositionStart = () => {
    history.capture(snapshot());
    composing = true;
  };
  const onCompositionEnd = () => {
    composing = false;
    history.push(snapshot());
  };
  const applyHistory = (next) => {
    if (!next) return false;
    input.value = next.value;
    setSelection(next.selectionStart, next.selectionEnd);
    paintHighlights();
    options.onInput?.(valueOf(), input);
    return true;
  };
  const onKeyDown = (event) => {
    if (readOnly || event.isComposing || event.key === "Process") return;
    const historyAction = promptHistoryAction(event);
    if (historyAction) {
      event.preventDefault?.();
      event.stopPropagation?.();
      event.stopImmediatePropagation?.();
      applyHistory(historyAction === "undo" ? history.undo() : history.redo());
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const { start, end } = selectionOffsets();
    const value = valueOf();
    const next = applyNaiBracketPairing({
      value,
      selectionStart: start,
      selectionEnd: end,
    }, event.key);
    if (!next) return;
    event.preventDefault();
    if (next.skip) {
      setSelection(next.selectionStart, next.selectionEnd);
      return;
    }
    if (event.key === "Backspace") {
      replaceTextareaRange(
        input,
        start - 1,
        end + 1,
        "",
        next.selectionStart,
        next.selectionEnd,
        scope,
        doc,
      );
      return;
    }
    const selected = value.slice(start, end);
    replaceTextareaRange(
      input,
      start,
      end,
      `${event.key}${selected}${SELECTION_PAIR_CLOSE[event.key]}`,
      next.selectionStart,
      next.selectionEnd,
      scope,
      doc,
    );
  };
  const onScroll = () => {
    preview.scrollTop = input.scrollTop;
    preview.scrollLeft = input.scrollLeft;
  };

  input.addEventListener("input", onInput);
  input.addEventListener("beforeinput", onBeforeInput);
  input.addEventListener("keydown", onKeyDown);
  input.addEventListener("compositionstart", onCompositionStart);
  input.addEventListener("compositionend", onCompositionEnd);
  input.addEventListener("pointerdown", beginEditing);
  input.addEventListener("focus", beginEditing);
  input.addEventListener("blur", showPreview);
  input.addEventListener("scroll", onScroll);
  root.append(input, preview);
  showPreview();

  const setReadOnly = (flag, title = "") => {
    readOnly = Boolean(flag);
    input.readOnly = readOnly;
    if (readOnly && !input.hidden) input.blur?.();
    input.title = title;
    preview.title = title;
    root.title = title;
    root.classList.toggle("nai4a-linked", readOnly);
    input.classList.toggle("nai4a-linked", readOnly);
  };
  setReadOnly(options.readOnly);

  return {
    root,
    input,
    textarea: input,
    preview,
    contentEditable: false,
    getValue: valueOf,
    sync: paintHighlights,
    setValue(next) {
      const value = String(next ?? "");
      if (valueOf() === value) return;
      input.value = value;
      paintHighlights();
    },
    setHistory(nextHistory, nextValue = valueOf()) {
      history = nextHistory || createNaiPromptHistory(nextValue);
      const state = history.sync(nextValue);
      input.value = state.value;
      setSelection(state.selectionStart, state.selectionEnd);
      paintHighlights();
    },
    setReadOnly,
    destroy() {
      input.removeEventListener("input", onInput);
      input.removeEventListener("beforeinput", onBeforeInput);
      input.removeEventListener("keydown", onKeyDown);
      input.removeEventListener("compositionstart", onCompositionStart);
      input.removeEventListener("compositionend", onCompositionEnd);
      input.removeEventListener("pointerdown", beginEditing);
      input.removeEventListener("focus", beginEditing);
      input.removeEventListener("blur", showPreview);
      input.removeEventListener("scroll", onScroll);
    },
  };
}
