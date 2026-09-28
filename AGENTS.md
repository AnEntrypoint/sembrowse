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

## Timeouts
- One completion 60s (20s killed genuine MiniCPM-V passes). decide 400s = 6 calls x 60s.
- Model load is a stall timeout reset only by real progress events (a 1.6GB download outlasts any flat deadline); the elapsed-seconds heartbeat is not progress.
- `worker.terminate()` is the only thing that preempts a stuck WebGPU call; a same-thread timer cannot fire while the worker is blocked.

## Message contracts
- Worker replies carry `reqId`, never `id`: a decision's own candidate `id` collided with request correlation. The execute message spreads `result` first and sets `type` last for the same reason.

## Candidate selection (content.js)
- Visible controls are ranked by on-screen area, capped at 20, presented in reading order; below-fold anchors only fill leftover slots. Goal-keyword ranking was dropped: on eBay it filled the list with category links and dropped every product card.
- Elements parked at negative top (keyboard skip-links) stay excluded. A document-position guess to re-admit scrolled-past content misfired both ways and was reverted.
- Password-like: type=password, current/new-password autocomplete, or name/id/placeholder/aria-label naming password/pwd/pin/passcode.

## Loop guard
- Unchanged page = same URL and word-set Jaccard >= 0.8 (byte equality never happens on busy commercial pages).
- Dead end = same URL#key picked 3 times without a material page change; scoped to the URL. Cycles of period 2-3 warn the model once, then stop. 5 consecutive WAITs stop.

## Release
- release.yml exits early when the tag exists, so every fix push must bump `extension/manifest.json` version or no artifact ships.
- manifest `key` pins extension id egaiolkjdgpkfeebpkokcnmejaigfppk so the OPFS model cache survives upgrades. Never regenerate.

## Live probing
- gm `cdp` verb drives real Chrome. content.js runs in any page by stubbing `chrome.runtime.onMessage.addListener` and calling the captured listener. Strict-CSP sites (github.com) forbid `new Function`; inline the source instead.
- amazon.com search returns 503 to this Chrome; ebay.com works.
- eBay results, 740 controls: candidate scan 487ms before, 93ms after.
