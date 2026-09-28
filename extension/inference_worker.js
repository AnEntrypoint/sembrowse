const browserFetch = self.fetch.bind(self)
self.fetch = (input, init = {}) => browserFetch(input, { ...init, referrerPolicy: "no-referrer" })
// transformers.js decides how to load its ONNX runtime's WASM glue script
// by checking `typeof chrome<"u" && typeof chrome.runtime<"u" && typeof
// chrome.runtime.id=="string"` -- when that's false, it falls back to
// fetching the script as text and re-wrapping it in a `blob:` URL (to
// control the base URL relative imports resolve against), which MV3's
// manifest CSP has no way to allow (verified live: adding `blob:` to
// script-src makes Chrome refuse to load the manifest at all, not just a
// runtime CSP violation). A dedicated Worker spawned via `new Worker(...)`
// (this file) doesn't get `chrome.runtime` the way the extension pages
// that create it do, so this check fails here even though we're
// genuinely running inside the extension. Nothing else in the vendored
// bundle reads `chrome.*` beyond this one string check, so shimming just
// enough to satisfy it is safe and avoids needing the blob path at all.
if (typeof chrome === "undefined") self.chrome = {}
if (typeof chrome.runtime !== "object" || chrome.runtime === null) chrome.runtime = {}
if (typeof chrome.runtime.id !== "string") chrome.runtime.id = "sembrowse-local-worker"
let runtime
const getRuntime = () => {
  if (!runtime) {
    runtime = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Local model runtime did not initialize within 30 seconds")), 30000)
      import("./vendor/wllama/index.js").then(({ Wllama, LoggerWithoutDebug }) => {
        clearTimeout(timer)
        resolve({ Wllama, LoggerWithoutDebug })
      }, (error) => {
        clearTimeout(timer)
        reject(error)
      })
    }).catch((error) => {
      runtime = undefined
      throw error
    })
  }
  return runtime
}
const models = {
  "qwen3-0.6b": { url: "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/23749fefcc72300e3a2ad315e1317431b06b590a/Qwen3-0.6B-Q8_0.gguf" },
  "minicpm5-2b": { url: "https://huggingface.co/openbmb/MiniCPM5-2B-GGUF/resolve/2079a22f3beaa4e306449978533478fe0522f4b3/MiniCPM5-2B-Q4_K_M.gguf" },
  "qwen3.5-4b": { url: "https://huggingface.co/bartowski/Qwen_Qwen3.5-4B-GGUF/resolve/4168f45a16a1290d65a4ec0fa312ae917a4c15d6/Qwen_Qwen3.5-4B-Q4_K_M.gguf" },
  // Vision-capable, through the SAME wllama/GGUF runtime as every other
  // model here -- wllama's own `mmprojUrl` option loads llama.cpp's mtmd
  // (multimodal) support alongside the main GGUF, so there is no separate
  // ONNX/transformers.js runtime needed for vision at all (that stack, and
  // the blob-CSP workaround it required, is gone entirely).
  "minicpm-v-4.6": { url: "https://huggingface.co/openbmb/MiniCPM-V-4.6-gguf/resolve/afe9accb78d2995d214cd912920c9c92f4015faa/MiniCPM-V-4_6-Q4_K_M.gguf", mmprojUrl: "https://huggingface.co/openbmb/MiniCPM-V-4.6-gguf/resolve/afe9accb78d2995d214cd912920c9c92f4015faa/mmproj-model-f16.gguf" }
}
let engine
let selected
let loading
let loadingModelId = ""
let runtimeMode = ""
// Set once per load, from the loaded model's own mmprojUrl -- decide()
// reads this to know whether it's worth spending the (real, non-zero) cost
// of capturing and attaching a screenshot at all.
let visionCapable = false
const labelsFor = (count) => Array.from({ length: count }, (_, index) => String.fromCharCode(65 + index))
// `payload` legitimately carries its own `id` field for many decisions (the
// SELECTED CANDIDATE's id, e.g. `{ operation: "CLICK", id: target.id }`) --
// spreading payload AFTER a top-level `id` would let that candidate id
// silently overwrite the request-correlation id every single time, so any
// response whose candidate id differs from (or coincidentally collides
// with) the pending request's real id gets mis-tagged and is either
// dropped as unrecognized or resolves the WRONG pending call. Carry the
// correlation id under its own `reqId` key instead, appended last so
// nothing in payload can ever shadow it; `id` inside payload stays exactly
// what the caller (runner.js) reads back as the candidate id.
const send = (id, payload) => self.postMessage({ ...payload, reqId: id })
// A grammar/logit_bias mismatch (or a WebGPU compute stall) can make a
// single createChatCompletion call hang indefinitely with no partial output
// at all -- the caller's only backstop was the outer per-decide budget in
// runner.js, which then aborts the ENTIRE task on one stuck step instead of
// surfacing a fast, recoverable error. Bound every completion call here so a
// stall fails in COMPLETION_TIMEOUT_MS instead. 20s (this constant's
// original value, tuned against the small text-only wllama models and the
// 450M ONNX vision model) is too tight for MiniCPM-V-4.6's real forward
// pass -- verified live: a genuine, still-working decision on the actual
// loaded vision model got killed as "did not respond within 20s" on
// ordinary hardware, not a hang. A full image+text forward pass through a
// SigLIP2 vision encoder is legitimately heavier than either of those.
const COMPLETION_TIMEOUT_MS = 60000
const completionTimeout = (promise) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`Local model call did not respond within ${COMPLETION_TIMEOUT_MS / 1000}s`)), COMPLETION_TIMEOUT_MS))
])
// `real: true` marks an ACTUAL stage change (a new download percentage, a
// new named stage) -- `real: false` marks the interval ticker below just
// re-announcing the same still-current message with an updated elapsed
// counter. runner.js's stall-timeout only resets on `real` events; verified
// live this distinction matters: the ticker fires every 15s regardless of
// whether the underlying download is still moving at all, so treating it as
// proof of progress made a genuinely dead download (server dropped the
// connection, zero bytes arriving) look identical to a slow-but-healthy one
// and would never time out.
const reportProgress = (message, real = true) => self.postMessage({ type: "progress", message, real })
const supportsWebGPU = async () => {
  if (!navigator.gpu) return false
  try {
    return !!await Promise.race([navigator.gpu.requestAdapter(), new Promise((resolve) => setTimeout(() => resolve(null), 5000))])
  } catch {
    return false
  }
}
const waitAtStage = async (message, operation) => {
  let current = message
  let elapsed = 0
  reportProgress(current, true)
  const timer = setInterval(() => {
    elapsed += 15
    reportProgress(`${current} (${elapsed}s)`, false)
  }, 15000)
  try {
    return await operation((next) => {
      current = next
      elapsed = 0
      reportProgress(current, true)
    })
  } finally {
    clearInterval(timer)
  }
}
async function initializeModel() {
  const { Wllama, LoggerWithoutDebug } = await waitAtStage("Preparing local model runtime…", () => getRuntime())
  const loadedEngine = new Wllama({ default: new URL("./vendor/wllama/wasm/wllama.wasm", self.location.href).href }, { logger: LoggerWithoutDebug, suppressNativeLog: true, parallelDownloads: 4 })
  runtimeMode = await supportsWebGPU() ? "webgpu" : "compatibility"
  if (runtimeMode === "compatibility") {
    loadedEngine.setCompat({
      worker: new URL("./vendor/wllama/compat/wllama.js", self.location.href).href,
      wasm: new URL("./vendor/wllama/compat/wllama.wasm", self.location.href).href
    }, "always")
    reportProgress("WebGPU is unavailable; using the local compatibility runtime…")
  } else {
    reportProgress("WebGPU adapter is ready; using the local WebGPU runtime…")
  }
  let loaded = false
  try {
    await waitAtStage("Opening the browser-cached model…", (setStage) => loadedEngine.loadModelFromUrl(selected.mmprojUrl ? { url: selected.url, mmprojUrl: selected.mmprojUrl } : selected.url, {
      // A vision-capable model's own image tokens (a full SigLIP2 encoder
      // pass over the screenshot) eat real context budget alongside our text
      // prompt, and that text prompt itself grows across a run (goal +
      // accumulated recent-action history + page text + candidate list) --
      // verified live: an early step needed 2420 tokens, comfortably under
      // an initial 4096 bump, but by step 29 of the SAME run (longer history,
      // more candidates) a request came in at 5103 tokens and got rejected
      // by that same budget. 8192 gives real headroom above the worst case
      // seen so far, not just the first one. Text-only models keep the
      // smaller budget since they have no image tokens to spend it on.
      n_ctx: selected.mmprojUrl ? 8192 : 2048,
      n_batch: 512,
      n_gpu_layers: 999,
      // Vision-only mtmd knobs, real wllama loadModel options (verified live
      // via the vendored bundle's own field list, not guessed): capping
      // image_max_tokens keeps the adaptive SigLIP2 slicing's worst case
      // predictable within the n_ctx budget above instead of however large a
      // given screenshot's own slicing happens to land (already observed
      // 2420 and 5103 on two different real pages) -- 4096 leaves the same
      // order of headroom for goal/history/candidate text that the earlier,
      // unbounded runs needed. image_min_tokens sets a floor so a simple,
      // mostly-blank page doesn't get downsampled past the point small price
      // text stays legible. mmproj_offload puts the vision encoder itself on
      // the GPU rather than defaulting to CPU (the n_gpu_layers setting
      // above only ever covered the main LLM); flash_attn is a free speed
      // win when the backend supports it.
      ...(selected.mmprojUrl ? { image_min_tokens: 256, image_max_tokens: 4096, mmproj_offload: true, flash_attn: true } : {}),
      useCache: true,
      cache_prompt: false,
      progressCallback: ({ loaded, total }) => setStage(total && loaded >= total ? "Caching the downloaded model locally…" : total ? `Downloading model: ${Math.round(loaded / total * 100)}%` : `Downloading model: ${loaded} bytes`)
    }))
    const runtimeLabel = runtimeMode === "webgpu" ? "WebGPU" : "compatibility"
    await waitAtStage(`Warming the local ${runtimeLabel} model…`, () => loadedEngine.createChatCompletion({
      messages: [{ role: "system", content: "Reply with READY." }, { role: "user", content: "READY" }],
      max_tokens: 1,
      temperature: 0
    }))
    loaded = true
  } finally {
    if (!loaded) await loadedEngine.exit().catch(() => undefined)
  }
  engine = loadedEngine
  // Trust wllama's own report of what it actually loaded, not just our own
  // config -- confirms the mmproj really attached rather than silently
  // failing to load and leaving us thinking we have vision when we don't.
  visionCapable = !!selected.mmprojUrl && !!engine.supportInputModality?.("image")
  reportProgress(`Local ${runtimeMode === "webgpu" ? "WebGPU" : "compatibility"} model is ready.`)
}

async function load(id, modelId) {
  if (engine) return send(id, { type: "ready", runtimeMode })
  if (loading && loadingModelId !== modelId) return send(id, { error: "A different browser model is already loading" })
  if (!loading) {
    selected = models[modelId]
    if (!selected) return send(id, { error: "Choose a supported browser model" })
    loadingModelId = modelId
    loading = initializeModel().finally(() => {
      loading = undefined
      loadingModelId = ""
    })
  }
  await loading
  send(id, { type: "ready", runtimeMode })
}

// Base64-decodes a `data:image/...;base64,...` screenshot into the raw
// image-file bytes wllama's multimodal (mtmd) support expects -- it decodes
// actual image files itself (the same as if it were handed a real .jpg
// file), not pre-decoded pixel arrays, so no client-side image decoding is
// needed here at all (unlike the transformers.js path this replaced).
const screenshotBytes = (dataUrl) => {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// `image`, when present, is the raw screenshot bytes from screenshotBytes()
// -- wllama only treats a message's `content` as multimodal when it's an
// array, so a plain string here (the non-vision, or no-screenshot-this-step,
// case) is completely unaffected; this one function serves every model,
// vision-capable or not, unlike the separate chooseOne/chooseOneVL split
// the old transformers.js-based vision runtime needed.
// Measured live against real Amazon runs, both OFF by default -- a
// reasoning pre-pass plus temperature-sampled majority voting did not
// measurably reduce off-topic wandering (the exact failure this was meant
// to fix): across several live runs the model still wandered into the same
// non-goal-relevant area (Amazon's footer country/language settings) with
// or without either enabled. Worse, the added per-decision cost (up to 4x
// the model calls of a single greedy decode) meant one run burned through
// the entire 120-call task budget stuck in that exact loop and failed
// outright ("The local model-call budget is exhausted") -- a definitively
// worse outcome than plain greedy decoding, which always at least reached a
// real terminal state (DONE/BLOCKED) within budget. Kept as working,
// correctly-implemented code (not deleted) since a genuinely bigger/more
// capable model could still benefit from either; both gated to
// vision-capable calls only regardless, so flipping them back on never
// affects a text-only model's chooseOne call.
const ENABLE_VISION_REASONING_PREPASS = false
const ENABLE_VISION_SELF_CONSISTENCY = false

async function chooseOne(goal, state, candidates, instruction, budget, image) {
  if (!engine || !selected) return { error: "Load a browser model first" }
  if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > 16) return { error: "The browser decision needs 2 to 16 compatible choices" }
  if (budget.calls >= budget.limit) return { error: "The local model-call budget is exhausted" }
  budget.calls += 1
  // Small local models are prone to positional bias in constrained
  // letter-choice decoding: verified live over a real run, 60/60
  // createChatCompletion calls returned the literal letter "B" regardless
  // of the actual prompt content, deterministically re-selecting whichever
  // candidate happened to occupy that position and looping forever.
  // Shuffling which candidate occupies which letter on every call turns
  // that bias into "pick a random candidate" instead of "pick the same
  // wrong candidate every time" -- cheap, and the standard mitigation for
  // LLM option-position bias.
  const shuffledOrder = candidates.map((_, index) => index)
  for (let i = shuffledOrder.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffledOrder[i], shuffledOrder[j]] = [shuffledOrder[j], shuffledOrder[i]]
  }
  const shuffled = shuffledOrder.map((originalIndex) => candidates[originalIndex])
  const labels = labelsFor(shuffled.length)
  const allowedLabels = shuffled[0]?.preferred ? [labels[0]] : labels
  const options = shuffled.map(({ description }, index) => `${labels[index]}. ${description}`).join("\n")
  const userText = `Goal:\n${goal.slice(0, 256)}\n\nRecent actions:\n${state.history?.slice(-4).join("\n") || "none"}\n\nPage:\n${state.text.slice(0, 256)}\n\n${instruction}\n${options}`
  const userContent = image ? [{ type: "image", data: image }, { type: "text", text: userText }] : userText

  // A hard single-token constrained decode gives the model zero room to
  // reason -- verified live on the OLD transformers.js-based vision model
  // that this reliably produced shallow answers, but that test never ran
  // against MiniCPM-V-4.6's own real instruction-tuned Qwen3.5-0.8B
  // backbone. A short free-form reasoning completion first (still
  // budget-bounded, never exceeding decide()'s own per-call cap) costs one
  // extra real call but gives the model somewhere to actually think before
  // being forced to commit to one letter.
  let reasoning = ""
  if (ENABLE_VISION_REASONING_PREPASS && visionCapable && image && budget.calls < budget.limit) {
    budget.calls += 1
    // Optional: a failed reasoning pre-pass degrades to "no reasoning" and
    // falls through to the ordinary constrained decode below rather than
    // failing the whole decision over one extra, non-essential call.
    try {
      const reasoningResponse = await completionTimeout(engine.createChatCompletion({
        messages: [{ role: "system", content: "In one short sentence, reason about which lettered option below best advances the goal, then stop." }, { role: "user", content: userContent }],
        max_tokens: 40,
        temperature: 0,
        cache_prompt: true,
        chat_template_kwargs: { enable_thinking: false }
      }))
      reasoning = reasoningResponse.choices?.[0]?.message?.content?.trim().slice(0, 200) || ""
    } catch {
      reasoning = ""
    }
  }
  const finalContent = reasoning
    ? (Array.isArray(userContent) ? [...userContent, { type: "text", text: `Reasoning:\n${reasoning}` }] : `${userContent}\n\nReasoning:\n${reasoning}`)
    : userContent

  const grammar = `root ::= ${allowedLabels.map((label) => `"${label}"`).join(" | ")}`
  // `grammar` alone is the hard constraint here (verified live: every
  // decision across many real runs resolved to a valid, in-range letter
  // with no logit_bias at all) -- a previously-present logit_bias keyed
  // off a per-model `labelBase` (the model's own token-id for letter "A")
  // was dropped entirely rather than kept as an unverifiable guess: wllama
  // exposes no tokenize/logprobs API to confirm a given labelBase is
  // actually right for a given model's vocabulary, and a WRONG guess was
  // never actually catchable (grammar would just silently override it
  // either way) -- so it was pure unverified risk for no measured benefit.
  const askOnce = (temperature) => completionTimeout(engine.createChatCompletion({
    messages: [{ role: "system", content: "Choose exactly one allowed letter for the next browser step." }, { role: "user", content: finalContent }],
    max_tokens: 1,
    temperature,
    top_k: temperature > 0 ? 40 : 0,
    top_p: temperature > 0 ? 0.9 : 1,
    grammar,
    // Consecutive decide() calls within one task share a long common prefix
    // (the same system message, largely the same goal/page text) -- letting
    // llama.cpp's slot cache reuse that prefix's KV state instead of
    // recomputing it from scratch on every single-token completion is a
    // deterministic, output-preserving speedup at temperature 0.
    cache_prompt: true,
    chat_template_kwargs: { enable_thinking: false }
  })).then((response) => String(response.choices?.[0]?.message?.content ?? response.choices?.[0]?.text ?? "").trim())

  // Observed live run-to-run judgment variance on this model with pure
  // greedy single-sample decoding (one run correctly found the goal item,
  // the next wandered off-topic) -- cast one greedy vote (temperature 0,
  // the known-reliable baseline) plus additional temperature-sampled votes
  // for as long as decide()'s own budget has room, majority-voting the
  // result. Never spends more calls than the existing per-decide cap
  // already allowed; a non-vision call casts exactly the original single
  // greedy vote and behaves identically to before.
  const votes = {}
  const castVote = (label) => { if (label) votes[label] = (votes[label] || 0) + 1 }
  // Every completion below is handled, never left to propagate as an
  // uncaught rejection -- consistent with this file's own convention of
  // returning `{ error }` on failure rather than throwing: the base vote's
  // own failure is a genuine decision failure (nothing to fall back to, so
  // it propagates as `{ error }` below), while a failed EXTRA vote just
  // means fewer votes get counted, never failing a decision that already
  // has a valid base vote to fall back on.
  try {
    castVote(await askOnce(0))
  } catch (error) {
    return { error: error?.message ?? String(error) }
  }
  while (ENABLE_VISION_SELF_CONSISTENCY && visionCapable && image && allowedLabels.length > 1 && budget.calls < budget.limit) {
    budget.calls += 1
    try {
      castVote(await askOnce(0.8))
    } catch {
      break
    }
  }
  const chosenLabel = Object.entries(votes).sort((left, right) => right[1] - left[1])[0]?.[0]
  const shuffledIndex = labels.indexOf(chosenLabel || "")
  if (shuffledIndex < 0) return { error: "The browser model did not choose a compatible action" }
  const index = shuffledOrder[shuffledIndex]
  const probabilities = candidates.map((candidate, position) => position === index ? 1 : 0)
  return { candidate: candidates[index], probability: probabilities[index], probabilities: Object.fromEntries(candidates.map((candidate, position) => [candidate.id, probabilities[position]])) }
}

const chooseCompatible = (goal, state, candidates, instruction, budget, image) => candidates.length === 1
  ? Promise.resolve({ candidate: candidates[0], probability: 1 })
  : chooseOne(goal, state, candidates, instruction, budget, image)

async function typeText(goal, state, target, budget, image) {
  if (budget.calls >= budget.limit) return { error: "The local model-call budget is exhausted" }
  budget.calls += 1
  const userText = `Goal:\n${goal}\n\nPage:\n${state.text}\n\nField:\n${target.description}`
  const userContent = image ? [{ type: "image", data: image }, { type: "text", text: userText }] : userText
  const response = await completionTimeout(engine.createChatCompletion({
    messages: [{ role: "system", content: "Return only the short text that belongs in the selected browser field. Do not add quotes, labels, or explanation." }, { role: "user", content: userContent }],
    max_tokens: 64,
    temperature: 0,
    cache_prompt: true,
    chat_template_kwargs: { enable_thinking: false }
  }))
  const text = response.choices?.[0]?.message?.content?.trim().replace(/^['"]|['"]$/g, "").slice(0, 256)
  return text || { error: "The local model did not generate field text" }
}

// A model asked to name a destination URL can instead answer in prose (a
// refusal like "I'm sorry, but I can't directly browse to..." -- verified
// live) -- collapsing that response's whitespace to try to salvage a URL out
// of it, as this used to do, doesn't salvage anything: WHATWG URL hostnames
// forbid space/#/  / : / < / > etc but NOT apostrophes or commas, so a
// whitespace-stripped refusal sentence parses as a syntactically "valid"
// (if absurd) https:// hostname and was genuinely navigated to. A real
// hostname never contains whitespace in the first place, and never contains
// punctuation beyond letters/digits/hyphens/dots -- reject on both signals
// instead of trying to repair the text into something new URL() accepts.
const isPlausibleUrl = (raw) => {
  if (!raw || /\s/.test(raw)) return null
  const text = raw.replace(/^['"]|['"]$/g, "")
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    if (!/^[a-z0-9.-]+$/i.test(url.hostname)) return null
    // A bare word ("amazon") is a syntactically valid hostname under WHATWG
    // rules but never a real one for this feature's use (the homepage of a
    // named website always has a TLD) -- require an actual dotted label so a
    // one-word non-answer doesn't get treated as a plausible navigation
    // target.
    if (!/\.[a-z]{2,}$/i.test(url.hostname)) return null
    return url.href
  } catch {
    return null
  }
}

async function generateUrl(goal, budget, image) {
  if (budget.calls >= budget.limit) return { error: "The local model-call budget is exhausted" }
  budget.calls += 1
  const userText = `Goal:\n${goal.slice(0, 256)}`
  const userContent = image ? [{ type: "image", data: image }, { type: "text", text: userText }] : userText
  const response = await completionTimeout(engine.createChatCompletion({
    messages: [{ role: "system", content: "Reply with only the https:// homepage URL of the website named in the goal. No explanation, no quotes, no extra text." }, { role: "user", content: userContent }],
    max_tokens: 32,
    temperature: 0,
    cache_prompt: true,
    chat_template_kwargs: { enable_thinking: false }
  }))
  const raw = response.choices?.[0]?.message?.content?.trim()
  const url = isPlausibleUrl(raw)
  return url ? { url } : { error: "The local model did not return a valid URL" }
}

async function decide(id, state, goal, candidates, remainingCalls) {
  const budget = { calls: 0, limit: Math.min(Math.max(Number(remainingCalls) || 0, 0), 4) }
  const available = Array.isArray(candidates) ? candidates : []
  // Decoded once per decide() call (not once per completion inside it --
  // SELECT alone makes two), same reasoning as the old RawImage-decode
  // comment this replaced: no need to re-decode the same screenshot bytes
  // for every completion inside a single decide() call.
  const image = visionCapable && state.screenshot ? screenshotBytes(state.screenshot) : undefined
  const authorNavigation = /\bauthor+\b/i.test(goal)
  const navigationGoal = /\b(browse|go|navigate|open|visit)\b/i.test(goal)
  const goalTerms = goal.toLowerCase().match(/[a-z0-9]{3,}/g) || []
  if (authorNavigation) {
    const currentUrl = new URL(state.url)
    const profileTarget = available.find((candidate) => /^https:\/\/github\.com\/[^/?#]+(?:[?#]|$)/.test(candidate.description.match(/https:\/\/\S+/)?.[0] || ""))
    const repositoryTarget = currentUrl.hostname !== "github.com" && available.find((candidate) => /^https:\/\/github\.com\/[^/?#]+\/[^/?#]+/.test(candidate.description.match(/https:\/\/\S+/)?.[0] || ""))
    const target = profileTarget || repositoryTarget
    if (target) {
      send(id, { type: "decision", operation: target.mode, id: target.id, probability: 1, calls: budget.calls, policy: "author-navigation" })
      return
    }
  }
  const githubOwner = (() => {
    try {
      const url = new URL(state.url)
      return url.hostname === "github.com" ? url.pathname.split("/").filter(Boolean)[0]?.toLowerCase() : ""
    } catch {
      return ""
    }
  })()
  // The githubOwner bonuses below only make sense while authorNavigation is
  // the actual goal -- otherwise, on any github.com/<owner>/* page, every
  // repo link contains the owner's name and gets inflated for goals that
  // have nothing to do with the author (e.g. "browse to the google
  // homepage" from a profile page), flooding directTargets with noise the
  // model then has to needlessly disambiguate among.
  const targetScore = (candidate) => {
    const description = candidate.description.toLowerCase()
    return goalTerms.reduce((score, term) => score + (description.includes(term) ? 10 : 0), 0) + (authorNavigation && /github|author|profile|source/.test(description) ? 25 : 0) + (authorNavigation && githubOwner && description.includes(githubOwner) ? 50 : 0) + (authorNavigation && githubOwner && description.includes(`github.com/${githubOwner}`) && !description.includes(`github.com/${githubOwner}/`) ? 100 : 0)
  }
  const rankedDirectTargets = available.filter((candidate) => candidate.mode === "CLICK" || candidate.mode === "TYPE_TEXT" || candidate.mode === "SELECT").sort((left, right) => targetScore(right) - targetScore(left))
  // `preferred` below is a *keyword* match (goalTerms are plain substrings),
  // not a semantic one -- a goal like "browse to the google homepage" makes
  // "homepage" a goal term, which then matches an on-page "GitHub Homepage"
  // link that has nothing to do with the actual goal, deterministically
  // re-clicking it forever (verified live: ran to the 60-action cap without
  // ever making progress) since the model is never even consulted. Only
  // trust this shortcut when there is no navigateOption to weigh against --
  // for a navigation goal, always let the model choose between the
  // keyword-matched candidate and generating the real destination directly.
  const directTargets = rankedDirectTargets.slice(0, 4).map((candidate, index) => ({ ...candidate, preferred: index === 0 && !navigationGoal && targetScore(candidate) > 0 && targetScore(candidate) > targetScore(rankedDirectTargets[1] || candidate) }))
  // A navigation goal ("browse to X") is never limited to links already
  // visible on the current page -- give the model an explicit escape hatch
  // to generate the destination URL itself and navigate there directly,
  // the same way the author-navigation path already does deterministically
  // for GitHub profiles, just generalized and genuinely model-driven.
  const navigateOption = navigationGoal ? [{ id: "__navigate_url__", mode: "NAVIGATE_URL", description: "NAVIGATE_URL: go directly to the destination site named in the goal instead of clicking a visible link", preferred: false }] : []
  // DONE has to sit alongside every other candidate, not only in the
  // no-candidates fallback below -- a goal like "find the cheapest X" is
  // only ever satisfied by looking at the current screenshot and judging
  // whether the visible page already answers it, which can just as well be
  // true on a page that still has plenty of other clickable links (a
  // product page full of "related items"). Gating DONE behind "nothing else
  // to click" meant the model could never actually finish that class of
  // goal on its own -- the only way it ever completed before was a
  // deterministic JS-side shortcut that never looked at the page at all.
  // Worded to require a settled answer, not merely visible evidence a page
  // full of several still-uncompared candidates could also claim -- verified
  // live: on the initial phrasing ("the goal is already visibly satisfied")
  // the model called DONE straight off a search-results page listing several
  // priced bicycles side by side, never opening any of them. The goal isn't
  // actually answered until one specific item has been singled out as the
  // answer, which a multi-result listing page has not yet done.
  const doneOption = [{ id: "__done__", mode: "DONE", description: "DONE: you have already singled out one specific item as the answer (e.g. you are on that item's own page, or you have otherwise confirmed it) -- not merely looking at a list of several still-uncompared options", preferred: false }]
  const choicesForModel = [...directTargets, ...navigateOption, ...doneOption]
  // Branch on directTargets/navigateOption alone, never on
  // choicesForModel.length -- doneOption makes that always truthy now, and
  // gating on it here would make the SCROLL/WAIT/BLOCKED fallback below
  // unreachable (it would always look like there was "a choice to make").
  if (directTargets.length || navigateOption.length) {
    if (directTargets[0]?.preferred) {
      send(id, { type: "decision", operation: directTargets[0].mode, id: directTargets[0].id, probability: 1, calls: budget.calls })
      return
    }
    const target = await chooseCompatible(goal, state, choicesForModel, "Choose the visible action that most directly advances the goal:", budget, image)
    if (target.error) return send(id, { ...target, calls: budget.calls })
    const operation = target.candidate.mode
    if (operation === "DONE") {
      send(id, { type: "decision", operation: "DONE", probability: target.probability, calls: budget.calls, policy: "model-completion" })
      return
    }
    if (operation === "NAVIGATE_URL") {
      const destination = await generateUrl(goal, budget, image)
      if (destination.error) return send(id, { ...destination, calls: budget.calls })
      send(id, { type: "decision", operation: "NAVIGATE_URL", url: destination.url, probability: target.probability, calls: budget.calls, policy: "goal-navigate-url" })
      return
    }
    if (operation === "SELECT") {
      const option = await chooseCompatible(goal, state, target.candidate.options.map((choice) => ({ id: String(choice.index), description: choice.description })), "Choose the observed native dropdown option:", budget, image)
      if (option.error) return send(id, { ...option, calls: budget.calls })
      send(id, { type: "decision", operation, id: target.candidate.id, optionIndex: Number(option.candidate.id), probability: target.probability, calls: budget.calls })
      return
    }
    const text = operation === "TYPE_TEXT" ? await typeText(goal, state, target.candidate, budget, image) : undefined
    if (text?.error) return send(id, { ...text, calls: budget.calls })
    send(id, { type: "decision", operation, id: target.candidate.id, text, probability: target.probability, calls: budget.calls })
    return
  }
  const operations = [
    state.scroll?.top > 0 && { id: "SCROLL_UP", description: "SCROLL_UP to reveal earlier page content" },
    state.scroll?.top + state.scroll?.viewport < state.scroll?.height && { id: "SCROLL_DOWN", description: "SCROLL_DOWN to reveal later page content" },
    { id: "WAIT", description: "WAIT for the current page to settle" },
    { id: "DONE", description: "DONE because the goal is visibly complete" },
    { id: "BLOCKED", description: "BLOCKED because no safe visible action can advance the goal" }
  ].filter(Boolean)
  const operation = operations.length === 1 ? { candidate: operations[0], probability: 1 } : await chooseCompatible(goal, state, operations, "Allowed operations:", budget, image)
  if (operation.error) return send(id, { ...operation, calls: budget.calls })
  send(id, { type: "decision", operation: operation.candidate.id, probability: operation.probability, calls: budget.calls })
}

self.addEventListener("message", async ({ data }) => {
  try {
    if (data.type === "load") await load(data.reqId, data.modelId)
    if (data.type === "decide") await decide(data.reqId, data.state, data.goal, data.candidates, data.remainingCalls)
  } catch (error) {
    send(data.reqId, { error: error?.message ?? String(error) })
  }
})

self.postMessage({ type: "worker_ready" })
