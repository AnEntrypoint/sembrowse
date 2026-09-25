# Sembrowse

Sembrowse is a portable browser extension that runs SemIf-style constrained choice directly on the GPU available to the browser. It has no Python installation, service API, API key, hosted inference request, or native helper.

The extension packages the WebGPU-capable Wllama runtime and WebAssembly binary. A model is the only large asset not included in each release archive.

## Install

Download the Chromium or Firefox archive from a GitHub release, extract it, and load the extracted directory as an unpacked extension.

1. Open the extension popup on the page to control.
2. Select a model and select **Load model**.
3. Enter a goal and select **Choose and execute**.

The first model load downloads an exact pinned GGUF file to the browser cache after the explicit button press. The browser performs all subsequent token generation and SemIf decision scoring locally. Once the model is cached, no network access is needed for inference. Releases do not redistribute model weights.

WebGPU support is required. Chrome, Edge, and recent Firefox builds are the intended targets. The Qwen3 0.6B model is the smaller option; MiniCPM5 2B can make stronger choices on devices with sufficient graphics memory.

## What it does

For an explicit request on the active tab, Sembrowse collects up to 16 visible links and buttons. The local model receives the goal, compact page state, and labelled candidates. It uses constrained single-token log-probability readout to choose one candidate, then the content script validates that candidate's current fingerprint before executing the one selected action.

Page content never goes to a Sembrowse server because there is no Sembrowse server. The model download is the sole network boundary and is constrained to the selected pinned Hugging Face model asset.

## Releases

Every push creates or updates `snapshot-<commit-sha>` on GitHub Releases with Chromium and Firefox MV3 archives plus `SHA256SUMS`. CI syntax-checks the extension, creates the archives, and verifies that vendored runtime files are present in them.

## Model sources

- Qwen3 0.6B GGUF: [Qwen/Qwen3-0.6B-GGUF](https://huggingface.co/Qwen/Qwen3-0.6B-GGUF)
- MiniCPM5 2B GGUF: [openbmb/MiniCPM5-2B-GGUF](https://huggingface.co/openbmb/MiniCPM5-2B-GGUF)
