# Sembrowse notes

Popup -> runner.html (runner.js + loop_guard.js) -> inference_worker.js (Worker) -> content.js (injected per step). loop_guard.js is pure so it can be driven in Node with `vm`.

## Invariants
- The model is the only thing that selects an action. JS may filter, order, offer, or reject; it never picks. Author/GitHub routing, keyword `preferred` shortcuts, single-click shortcuts, forced DONE on URL change, variant-expander and search-box regexes were removed for this reason.
- Submitting after typing is a model decision (SUBMIT/KEEP question), not a regex. Password-like fields are excluded from candidates entirely.
- A failed follow-up (bad URL, empty text) excludes that option and re-asks inside the per-decision call budget instead of ending the run.

## Runtime
- Vision and WebGPU both come from wllama (`loadModelFromUrl({url, mmprojUrl})`, ggml-webgpu). No ONNX or transformers.js.
- Decoding is a GBNF grammar of allowed letters, `max_tokens: 1`, temperature 0. No logit_bias. Options are reshuffled every call: unshuffled, 60/60 calls returned "B".
- A reasoning pre-pass and temperature-sampled voting were built and measured: no less off-topic wandering, and one run spent all 120 calls looping. Removed.
- Context: n_ctx 8192 with image_max_tokens 4096 for vision (real prompts hit 2420 and 5103 tokens), 4096 for text-only models.
- Screenshot is `captureVisibleTab` jpeg quality 92; a failed capture degrades that step to text-only and traces it.
- Prompt carries goal, page title, URL, scroll position, 1200 chars of on-screen text, last 6 actions, every candidate (href truncated to 96 chars) plus NAVIGATE_URL, SCROLL_UP/DOWN when there is room, WAIT, DONE, BLOCKED.
- 26 letters is the ceiling: 20 candidates + 6 operations.

## Measured, no effect (real model, n=8 per cell, recorded Amazon/eBay states)
- A model-written plan ('Use search function. Check results.'), a 'Last action' progress line, and longer SCROLL_DOWN wording did not change choices; the plan nudged toward re-searching. Plan was removed. SCROLL_DOWN and price sort were chosen 0 times in 136 decisions on results pages, so the 0.8B model does not yet complete 'find the cheapest bicycle'.
- Live pushed-code runs (Amazon, 9-12 steps): goal typed correctly, bicycle results reached, then locale/overlay/nav controls chosen. The runner used to observe 200ms after Enter, before results loaded; settle() now waits for a loading tab.
- Runner traces `notes` from the worker (rejected DONE checks, discarded options) and records the offered candidates per step in evidence.

## Timeouts
- One completion 60s (20s killed genuine MiniCPM-V passes). decide 400s covers 6 calls x 60s = 360s.
- Model load is a stall timeout reset only by real progress events (a 1.6GB download outlasts any flat deadline); the elapsed-seconds heartbeat is not progress.
- `worker.terminate()` is the only thing that preempts a stuck WebGPU call; a same-thread timer cannot fire while the worker is blocked.

## Permissions and egress
- Manifest permissions are storage, scripting, activeTab plus host `<all_urls>`. `tabs` and `windows` were verified redundant in Chrome 153 (host access covers tab url/title, captureVisibleTab, executeScript; `windows` is not a real permission).
- wllama's constructor sets compat resources to a jsDelivr CDN URL; the worker always calls `setCompat` with the packaged local files so a WebGPU browser lacking JSPI/Memory64 cannot fetch remote code.
- Stored evidence strips URL query strings (`withoutQueries`); typed text stays in the trace.
- Screenshots are taken only when the task tab is the active tab in its window.

## Message contracts
- Worker replies carry `reqId`, never `id`: a decision's own candidate `id` collided with request correlation. The execute message spreads `result` first and sets `type` last for the same reason.

## Candidate selection (content.js)
- Half of the 20 slots go to the largest on-screen controls, half to the top-most (so header navigation survives), duplicate hrefs dropped, presented in reading order; below-fold anchors only fill leftover slots. Goal-keyword ranking was dropped: on eBay it filled the list with category links and dropped every product card. Shadow roots are searched; iframes are not (a full-page iframe sets `state.coveringFrames`, which the prompt reports).
- Occlusion is tested at each line box of a wrapped anchor, not the union centre (which landed on the parent and dropped Stack Overflow question titles). Fragment-only `href="#"` links are clicked, not navigated to. Typing uses the native value setter so React-controlled inputs commit.
- Elements parked at negative top (keyboard skip-links) stay excluded. A document-position guess to re-admit scrolled-past content misfired both ways and was reverted.
- Password-like: type=password, current/new-password autocomplete, or name/id/placeholder/aria-label naming password/pwd/pin/passcode.

## Loop guard
- Unchanged page = same URL and word-set Jaccard >= 0.8 (byte equality never happens on busy commercial pages).
- Dead end = same URL#key picked 3 times without a material page change, or an action that errors; scoped to the URL. Unchanged limit is 4 (warned at 2) so the dead-end exclusion gets one decision before the stop. 8 consecutive stale/failed steps stop the run; a worker error is retried up to 3 times. Cycles of period 2-3 warn the model once, then stop. 5 consecutive WAITs stop.

## Release
- release.yml exits early when the tag exists, so every fix push must bump `extension/manifest.json` version or no artifact ships.
- manifest `key` pins extension id egaiolkjdgpkfeebpkokcnmejaigfppk so the OPFS model cache survives upgrades. Never regenerate.

## Live probing
- gm `cdp` verb drives real Chrome. content.js runs in any page by stubbing `chrome.runtime.onMessage.addListener` and calling the captured listener. Strict-CSP sites (github.com) forbid `new Function`; inline the source instead.
- amazon.com search returns 503 to this Chrome; ebay.com works.
- eBay results, 740 controls: candidate scan 487ms before, 93ms after.
