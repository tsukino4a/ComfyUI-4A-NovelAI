# ComfyUI-4A-NovelAI

[中文说明](README.zh-CN.md)

Companion prompt library: [ComfyUI-4A-Prompt-Manager](https://github.com/tsukino4a/ComfyUI-4A-Prompt-Manager)

A standalone NovelAI image-generation plugin for ComfyUI, supporting NovelAI Diffusion V4.5 and later only. It provides native NAI prompt scheduling, multi-character prompting, text-to-image / image-to-image / inpainting, Vibe and Precise Reference resources, metadata reuse, account usage monitoring, and lossless saving of NovelAI's original PNG output.

**Current release: 1.0.0** — the first complete release of the independent 4A NovelAI generation workflow, with Chinese and English interfaces and optional integration with 4A Prompt Manager.

> This is an unofficial community extension and is not affiliated with NovelAI. Generation, Vibe encoding, and reference features may consume Anlas according to your NovelAI account and the active API rules. Use your own Persistent API Token.

<p align="center">
  <img src="docs/images/hero.png" alt="ComfyUI-4A-NovelAI overview" width="900">
</p>

## Highlights

### Native NAI Prompt Scheduler and multi-character prompting

The prompt editor preserves NovelAI's native `{}`, `[]`, and `N::text::` weighting. Select text and type `{`, `[`, or `:` to add the matching closer automatically; nested and numeric weights are colored directly in the Scheduler.

#### Positive / negative switching

Quality, character, action, scene, and character-card fields switch between positive and negative text in place. The two states use distinct colors, keeping both sides of the prompt compact without duplicating the entire layout.

#### Character positioning

Add multiple ordered character cards up to the selected model's limit. Positions can stay automatic or be arranged quickly on the image-ratio canvas; manual positions are stored as each character's normalized `x/y` coordinates.

#### Pixel-budget control

Choose Small, Normal, Large, or Wallpaper while preserving the current aspect ratio, or edit a custom width and height. The positioning canvas follows the same effective dimensions, so character placement matches the generated frame.

#### Fixed-prompt batch runs

Set a start index and task count, then queue the whole batch from the Scheduler to generate repeatedly with the current fixed prompts. Every job is added to the ComfyUI queue immediately; ComfyUI still runs them one by one. Random or sequential Wildcard switching needs 4APM; see the next section.

<p align="center">
  <img src="docs/images/scheduler.png" alt="NAI Prompt Scheduler" width="900">
</p>

### 4A Prompt Manager Wildcard integration

When [4A Prompt Manager](https://github.com/tsukino4a/ComfyUI-4A-Prompt-Manager) is installed beside this plugin, NAI Prompt Scheduler reads its folder-backed TXT / JSON-card library and native `nai` fields through a read-only integration. Tracks can use `__folder__` / `__path/file__` and switch prompts randomly or sequentially; sequential mode can count the leaf space and queue the whole batch at once. Only the basic `__wildcard__` form is supported; braces are never treated as random choices because they already have native meaning in NovelAI prompts.

The wildcard-selection seed is separate from the image seed on NAI Sampler. During Scheduler batches, sparse NAI card sampling settings can be applied temporarily and restored afterward. 4APM can also send native NAI prompts, character cards, and supported metadata fields to the standalone NAI nodes. Without 4APM, `__wildcard__` tokens are not expanded and a batch only repeats the current fixed prompts; all generation nodes still work normally.

<p align="center">
  <img src="docs/images/wildcards.png" alt="4A Prompt Manager Wildcard integration" width="860">
</p>

### One sampler for txt2img, img2img, and inpainting

NAI Sampler accepts separate positive, negative, character JSON, model, sampling, resolution, and optional reference inputs. It can use NovelAI's streaming endpoint for live progress previews and returns both a normal ComfyUI `IMAGE` and the untouched original PNG bytes as `NAI_RESULT`.

Connect NAI Image Input to switch modes from the image and mask contents, not from whether the mask socket is wired:

- No image: text-to-image using the Scheduler / Sampler dimensions.
- An image with an empty or unpainted mask: image-to-image. An empty mask can stay connected.
- An image and a painted mask: inpainting.

In those last two modes, NAI Image Input owns the generation size. It keeps the source aspect ratio and can scale to a Small / Normal / Large / Wallpaper pixel budget, upscale by 1.5 with the official Enhance rule (multiply each side, then round up to 64), or retain approximately the source pixel count. Upscale and the pixel-budget toggle are mutually exclusive. This prevents an unrelated Sampler size from unexpectedly stretching the input.

<p align="center">
  <img src="docs/images/image_modes.png" alt="NAI image generation modes" width="860">
</p>

### Vibe and Precise Reference cards

Drop images or `.naiv4vibe` files directly onto NAI Reference Resources. One multi-card interface manages either Vibe or Precise Reference resources; the two modes stay mutually exclusive. Precise Reference cards can target character, style, or character and style together.

Image Vibes reuse matching local encodings when available. A missing encoding is never purchased silently: encoding requires the explicit **Encode and save** action and confirmation. V5 currently ignores connected Reference resources silently, matching the intended V5 workflow; V4.5 uses the configured Vibe or Precise Reference cards.

<p align="center">
  <img src="docs/images/references.png" alt="Vibe and Precise Reference cards" width="860">
</p>

### NovelAI metadata inspection and one-click apply

NAI Meta Loader reproduces the 4APM metadata-card layout for NovelAI images: model, generation settings, positive and negative prompts, and one card per character. Individual actions can send a model, settings, prompt, or appended character; the combined prompt action replaces the complete prompt and character set.

NAI Meta Apply accepts original NovelAI images and independently toggles positive prompt, negative prompt, characters, character append mode, model and generation settings, and seed. Applying model and generation settings intentionally does not overwrite resolution. Applying only the positive prompt preserves the Scheduler's character, action, and scene fields. Non-NAI images can still be inspected for positive / negative text, but their models and generation settings are not interpreted as NovelAI settings.

<p align="center">
  <img src="docs/images/metadata.png" alt="NAI metadata tools" width="900">
</p>

### Local Token storage, usage monitoring, and original PNG saving

Configure the Persistent API Token from **Settings → 4A NovelAI → Account → Token & Anlas** or from NAI Usage Monitor. The Token is sent only to the local ComfyUI backend and stored outside workflows at:

```text
<ComfyUI user>/ComfyUI-4A-NovelAI/credentials.json
```

It is not written into workflows, generated-image metadata, browser settings, or plugin logs. NAI Usage Monitor displays the subscription tier, included and purchased Anlas, and the available V5 allowance. NAI Original Image Saver writes NovelAI's returned PNG directly to ComfyUI output without re-encoding, preserving the provider metadata.

<p align="center">
  <img src="docs/images/usage.png" alt="NAI usage monitor" width="720">
</p>

## Install

### ComfyUI-Manager

Search for **4A NovelAI** / `ComfyUI-4A-NovelAI` and install. Dependencies from `requirements.txt` / `install.py` are handled by Manager.

### Manual

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/tsukino4a/ComfyUI-4A-NovelAI.git ComfyUI-4A-NovelAI
cd ComfyUI-4A-NovelAI
python install.py
# or: pip install -r requirements.txt
```

Restart ComfyUI after installation. `msgpack` is a required dependency and is used to read official NovelAI Vibe files; requests, Pillow, NumPy, and PyTorch are supplied by ComfyUI.

## Quick start

1. Add **NAI Model Loader**, **NAI Prompt Scheduler**, **NAI Sampler**, and **NAI Original Image Saver**.
2. Connect the Scheduler's positive, negative, characters, width, and height outputs to NAI Sampler; connect the Model Loader and route `NAI_RESULT` to the original saver.
3. Configure your Token from NAI Usage Monitor or ComfyUI settings.
4. Enter fixed prompts in the Scheduler; with 4APM installed, `__wildcard__` references are also available. Add character cards as needed, then run NAI Sampler.
5. Optionally connect NAI Reference Resources or NAI Image Input. Use the Scheduler's **Batch Run** button to repeat the current fixed prompts; with 4APM installed, Wildcard tracks can also switch prompts randomly or sequentially.

## Nodes

| Node | Role |
|------|------|
| NAI Model Loader | Select V5 Full, V5 Curated, V4.5 Full, or V4.5 Curated |
| NAI Usage Monitor | Configure the Token and display subscription, Anlas, and V5 allowance |
| NAI Prompt Scheduler | Compose native NAI prompts, characters, coordinates, resolution, and fixed-prompt batches |
| NAI Reference Resources | Manage mutually exclusive Vibe or Precise Reference cards |
| NAI Image Input | Own the source image, mask, strength, noise, and resolution; an empty mask stays on img2img |
| NAI Sampler | Submit txt2img, img2img, or inpainting requests and return decoded plus original results |
| NAI Original Image Saver | Save the original NovelAI PNG without re-encoding |
| NAI Meta Loader | Inspect metadata and send individual or grouped values to NAI nodes |
| NAI Meta Apply | Apply selected NovelAI metadata fields from a dropped or selected image |

## Example workflow

Load [`example_workflows/01_basic_novelai_workflow.json`](example_workflows/01_basic_novelai_workflow.json) in ComfyUI for the basic Model Loader → Prompt Scheduler → Sampler → Original Image Saver setup. Select a model and configure your Token before queueing it; Reference Resources and Image Input can be added when needed.

## Resolution presets

| Tier | Portrait | Square | Landscape |
|------|----------|--------|-----------|
| Small | 512 × 768 | 640 × 640 | 768 × 512 |
| Normal | 832 × 1216 | 1024 × 1024 | 1216 × 832 |
| Large | 1024 × 1536 | 1472 × 1472 | 1536 × 1024 |
| Wallpaper | 1088 × 1920 | — | 1920 × 1088 |

Custom dimensions are limited to 64–2048 and use 64-pixel steps. Image Input always derives its effective size from the source aspect ratio rather than blindly copying the Sampler dimensions. Upscale 1.5 uses `ceil(side × 1.5 / 64) × 64`, then scales back if a side would exceed 2048.

## Compatibility and behavior boundaries

- Supported model selections: V5 Full, V5 Curated, V4.5 Full, and V4.5 Curated.
- V5 silently ignores connected Vibe / Precise Reference resources.
- V5 Curated inpainting follows the current NovelAI client route through V4.5 Curated inpainting and therefore keeps the six-character limit for that mode.
- Transient failures are retried only for single-image text generation within the Normal pixel budget with no more than 28 steps and no paid reference features. Large/Wallpaper, img2img, inpainting, more than four Vibes, Precise Reference, and Vibe encoding are sent only once.
- Without 4APM the Scheduler does not expand `__wildcard__`. With 4APM it uses only the plain `__wildcard__` form; NovelAI brace and bracket syntax always remains native prompt text.
- The interface and node definitions are localized in Chinese and English.

## Dependencies

- **Required:** [`msgpack`](https://pypi.org/project/msgpack/) for official NovelAI Vibe files
- requests, Pillow, NumPy, PyTorch, and aiohttp are provided by ComfyUI
- **Optional integration:** [ComfyUI-4A-Prompt-Manager](https://github.com/tsukino4a/ComfyUI-4A-Prompt-Manager) for its folder-backed Wildcard / JSON-card library and metadata bridge

## License

This project is released under the [MIT License](LICENSE).
