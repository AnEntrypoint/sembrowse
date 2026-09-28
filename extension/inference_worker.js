const browserFetch = self.fetch.bind(self)
self.fetch = (input, init = {}) => browserFetch(input, { ...init, referrerPolicy: "no-referrer" })

const COMPLETION_TIMEOUT_MS = 60000
const MAX_CALLS_PER_DECISION = 6
const MAX_CANDIDATE_OPTIONS = 20
const PROMPT_HISTORY_LINES = 6
const PROMPT_TEXT_CHARS = 1200
const PROMPT_URL_CHARS = 96
const PROMPT_LINE_CHARS = 240
const CANDIDATE_MODES = new Set(["CLICK", "TYPE_TEXT", "SELECT"])
const SUBMIT_OPTIONS = [
  { id: "SUBMIT", description: "SUBMIT: press Enter right after typing, for example in a search box" },
  { id: "KEEP", description: "KEEP: leave the text typed without submitting, for example one field of a longer form" }
]
const DONE_CHECK_OPTIONS = [
  { id: "YES", description: "Yes: the goal is already completely achieved on this page" },
  { id: "NO", description: "No: something more still has to be done to achieve the goal" }
]
const TYPE_TEXT_SYSTEM = [
  "You write the exact text a user types into a browser field to advance their goal.",
  "For a search box, write only the search keywords taken from the goal: leave out words like search, find, look up, and site names.",
  "If the goal supplies the value the field wants (an email address, a name, a number), write that value exactly.",
  "Never repeat the field's own label or placeholder. Output only the text, nothing else.",
  "Examples:",
  "Goal: find the best price on running shoes\nField label: Search the store\nText: running shoes",
  "Goal: sign up for updates using sam@mail.org\nField label: Email\nText: sam@mail.org"
].join("\n")

const models = {
  "qwen3-0.6b": { url: "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/23749fefcc72300e3a2ad315e1317431b06b590a/Qwen3-0.6B-Q8_0.gguf" },
  "minicpm5-2b": { url: "https://huggingface.co/openbmb/MiniCPM5-2B-GGUF/resolve/2079a22f3beaa4e306449978533478fe0522f4b3/MiniCPM5-2B-Q4_K_M.gguf" },
  "qwen3.5-4b": { url: "https://huggingface.co/bartowski/Qwen_Qwen3.5-4B-GGUF/resolve/4168f45a16a1290d65a4ec0fa312ae917a4c15d6/Qwen_Qwen3.5-4B-Q4_K_M.gguf" },
  "minicpm-v-4.6": { url: "https://huggingface.co/openbmb/MiniCPM-V-4.6-gguf/resolve/afe9accb78d2995d214cd912920c9c92f4015faa/MiniCPM-V-4_6-Q4_K_M.gguf", mmprojUrl: "https://huggingface.co/openbmb/MiniCPM-V-4.6-gguf/resolve/afe9accb78d2995d214cd912920c9c92f4015faa/mmproj-model-f16.gguf" }
}

let runtime
let engine
let selected
let loading
let loadingModelId = ""
let runtimeMode = ""
let visionCapable = false

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

const send = (reqId, payload) => self.postMessage({ ...payload, reqId })
const reportProgress = (message, real = true) => self.postMessage({ type: "progress", message, real })
const collapse = (text) => String(text ?? "").replace(/\s+/g, " ").trim()
const clip = (text, chars) => collapse(text).slice(0, chars)
const labelsFor = (count) => Array.from({ length: count }, (_, index) => String.fromCharCode(65 + index))

const complete = async (request) => {
  const controller = new AbortController()
  let timer
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`Local model call did not respond within ${COMPLETION_TIMEOUT_MS / 1000}s`))
    }, COMPLETION_TIMEOUT_MS)
  })
  try {
    return await Promise.race([engine.createChatCompletion({ ...request, abortSignal: controller.signal }), expiry])
  } finally {
    clearTimeout(timer)
  }
}

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
  loadedEngine.setCompat({
    worker: new URL("./vendor/wllama/compat/wllama.js", self.location.href).href,
    wasm: new URL("./vendor/wllama/compat/wllama.wasm", self.location.href).href
  }, "always")
  runtimeMode = await supportsWebGPU() ? "webgpu" : "compatibility"
  reportProgress(runtimeMode === "webgpu" ? "WebGPU adapter is ready; using the local WebGPU runtime…" : "WebGPU is unavailable; using the local compatibility runtime…")
  let loaded = false
  try {
    await waitAtStage("Opening the browser-cached model…", (setStage) => loadedEngine.loadModelFromUrl(selected.mmprojUrl ? { url: selected.url, mmprojUrl: selected.mmprojUrl } : selected.url, {
      n_ctx: selected.mmprojUrl ? 8192 : 4096,
      n_batch: 512,
      n_gpu_layers: 999,
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
  visionCapable = !!selected.mmprojUrl && !!engine.supportInputModality?.("image")
  reportProgress(`Local ${runtimeMode === "webgpu" ? "WebGPU" : "compatibility"} model is ready.`)
}

const readyPayload = () => ({ type: "ready", runtimeMode, visionCapable, artifact: selected.url })

async function load(reqId, modelId) {
  if (!Object.hasOwn(models, modelId)) return send(reqId, { error: "Choose a supported browser model" })
  if (engine && selected !== models[modelId]) return send(reqId, { error: "A different browser model is already loaded" })
  if (engine) return send(reqId, readyPayload())
  if (loading && loadingModelId !== modelId) return send(reqId, { error: "A different browser model is already loading" })
  if (!loading) {
    selected = models[modelId]
    if (!selected) return send(reqId, { error: "Choose a supported browser model" })
    loadingModelId = modelId
    loading = initializeModel().finally(() => {
      loading = undefined
      loadingModelId = ""
    })
  }
  await loading
  send(reqId, readyPayload())
}

const screenshotBytes = (dataUrl) => {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

const shortenUrls = (text) => text.replace(/https?:\/\/\S+/gi, (url) => url.length > PROMPT_URL_CHARS ? `${url.slice(0, PROMPT_URL_CHARS)}…` : url)
const promptLine = (text) => clip(shortenUrls(collapse(text)), PROMPT_LINE_CHARS)

const scrollSummary = (scroll) => {
  if (!scroll) return "unknown"
  const above = scroll.top > 0
  const below = scroll.top + scroll.viewport < scroll.height - 2
  if (above && below) return "middle of the page, more content above and below"
  if (below) return "top of the page, more content below"
  if (above) return "bottom of the page, more content above"
  return "the whole page fits on screen"
}

const frameNotice = (state) => state.coveringFrames > 0 ? "\nNote: a full-page embedded frame covers this page; its controls cannot be seen or used from here." : ""

const describeState = (goal, state) => [
  `Goal:\n${clip(goal, 256)}`,
  `Page title: ${clip(state.title, 100)}\nPage URL: ${clip(state.url, 160)}\nView: ${scrollSummary(state.scroll)}${frameNotice(state)}`,
  `Visible text:\n${clip(state.text, PROMPT_TEXT_CHARS)}`,
  `Recent actions:\n${(Array.isArray(state.history) ? state.history : []).slice(-PROMPT_HISTORY_LINES).map(promptLine).join("\n") || "none"}`
].join("\n\n")

const withImage = (text, image) => image ? [{ type: "image", data: image }, { type: "text", text }] : text

async function chooseOne(context, options, instruction, budget, image, question) {
  if (!engine || !selected) return { error: "Load a browser model first" }
  if (options.length < 2 || options.length > 26) return { error: "The browser decision needs 2 to 26 compatible choices" }
  if (budget.calls >= budget.limit) return { error: "The local model-call budget is exhausted" }
  budget.calls += 1
  const order = options.map((_, index) => index)
  for (let index = order.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1))
    ;[order[index], order[other]] = [order[other], order[index]]
  }
  const labels = labelsFor(order.length)
  const listing = order.map((optionIndex, position) => `${labels[position]}. ${promptLine(options[optionIndex].description)}`).join("\n")
  const grammar = `root ::= ${labels.map((label) => `"${label}"`).join(" | ")}`
  try {
    const response = await complete({
      messages: [
        { role: "system", content: question ? "Answer with exactly one allowed letter." : "Choose exactly one allowed letter for the next browser step." },
        { role: "user", content: withImage(question ? `${context}\n\n${listing}\n\n${question}` : `${context}\n\n${instruction}\n${listing}`, image) }
      ],
      max_tokens: 1,
      temperature: 0,
      top_k: 0,
      top_p: 1,
      grammar,
      cache_prompt: true,
      chat_template_kwargs: { enable_thinking: false }
    })
    const label = String(response.choices?.[0]?.message?.content ?? response.choices?.[0]?.text ?? "").trim()
    const position = labels.indexOf(label)
    if (position < 0) return { error: "The browser model did not choose a compatible action" }
    return { option: options[order[position]] }
  } catch (error) {
    return { error: error?.message ?? String(error) }
  }
}

async function generateText(system, userText, maxTokens, budget, image) {
  if (budget.calls >= budget.limit) return { error: "The local model-call budget is exhausted" }
  budget.calls += 1
  try {
    const response = await complete({
      messages: [{ role: "system", content: system }, { role: "user", content: withImage(userText, image) }],
      max_tokens: maxTokens,
      temperature: 0,
      cache_prompt: true,
      chat_template_kwargs: { enable_thinking: false }
    })
    return { text: response.choices?.[0]?.message?.content?.trim() ?? "" }
  } catch (error) {
    return { error: error?.message ?? String(error) }
  }
}

const extractUrlText = (raw) => {
  const embedded = raw.match(/https?:\/\/[^\s<>`"'()]+/i)?.[0]
  return (embedded ?? raw.trim().replace(/^['"<`]+|['">`]+$/g, "")).replace(/[.,;]+$/, "")
}

const isPlausibleUrl = (raw) => {
  if (!raw) return null
  const text = extractUrlText(raw)
  if (!text || /\s/.test(text)) return null
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    if (url.username || url.password) return null
    if (!/^[a-z0-9.-]+$/i.test(url.hostname)) return null
    if (!/\.(?=[a-z0-9-]*[a-z])[a-z0-9-]{2,}$/i.test(url.hostname)) return null
    return url.href
  } catch {
    return null
  }
}

const fieldLabel = (option) => collapse(option.description.replace(/^[a-z]+:\s*/i, ""))

async function realizeTypeText(context, option, goal, budget, image) {
  const label = fieldLabel(option)
  const typed = await generateText(TYPE_TEXT_SYSTEM, `Goal: ${clip(goal, 256)}\nField label: ${clip(label, PROMPT_LINE_CHARS)}\nText:`, 64, budget)
  if (typed.error) return typed
  const text = collapse(typed.text).replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").slice(0, 256)
  if (!text) return { error: "The local model did not generate field text" }
  if (text.toLowerCase() === label.toLowerCase()) return { error: "The local model repeated the field label instead of text to type" }
  const submitChoice = await chooseOne(`${context}\n\nField:\n${promptLine(option.description)}\nText just typed into it: ${promptLine(text)}`, SUBMIT_OPTIONS, "After typing, choose what happens next:", budget, image)
  if (submitChoice.error) return submitChoice
  return { decision: { operation: "TYPE_TEXT", id: option.id, text, submit: submitChoice.option.id === "SUBMIT" } }
}

async function realizeSelect(context, option, budget, image) {
  if (!option.options?.length) return { error: "The dropdown has no options" }
  if (option.options.length === 1) return { decision: { operation: "SELECT", id: option.id, optionIndex: option.options[0].index } }
  const choice = await chooseOne(`${context}\n\nDropdown:\n${promptLine(option.description)}`, option.options.map(({ index, description }) => ({ id: String(index), description })), "Choose the observed native dropdown option:", budget, image)
  if (choice.error) return choice
  return { decision: { operation: "SELECT", id: option.id, optionIndex: Number(choice.option.id) } }
}

const compact = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")

const siteLabel = (hostname) => {
  const labels = hostname.replace(/^www./, "").split(".")
  return labels.length > 2 && labels[labels.length - 2].length <= 3 ? labels[labels.length - 3] : labels[labels.length - 2]
}

const namesKnownSite = (url, known) => compact(known).includes(compact(siteLabel(new URL(url).hostname)))

async function realizeNavigateUrl(goal, known, budget, image) {
  const generated = await generateText(
    "Reply with only the https:// homepage URL of the website named in the goal. If the goal names no website, reply NONE. No explanation, no quotes, no extra text.",
    `Goal:\n${clip(goal, 256)}`,
    32,
    budget,
    image
  )
  if (generated.error) return generated
  const url = isPlausibleUrl(generated.text)
  if (!url) return { error: "The local model did not return a valid URL" }
  if (!namesKnownSite(url, known)) return { error: "The generated address names a site that appears nowhere in the goal or on the page" }
  return { decision: { operation: "NAVIGATE_URL", url } }
}

const realize = (option, context, goal, known, budget, image) => {
  if (option.mode === "TYPE_TEXT") return realizeTypeText(context, option, goal, budget, image)
  if (option.mode === "SELECT") return realizeSelect(context, option, budget, image)
  if (option.mode === "NAVIGATE_URL") return realizeNavigateUrl(goal, known, budget, image)
  if (option.mode === "CLICK") return Promise.resolve({ decision: { operation: "CLICK", id: option.id } })
  return Promise.resolve({ decision: { operation: option.mode } })
}

const operationOptions = (scroll) => [
  { id: "__navigate_url__", mode: "NAVIGATE_URL", description: "NAVIGATE_URL: go straight to a website by its address instead of using anything on this page" },
  scroll && scroll.top + scroll.viewport < scroll.height - 2 && { id: "__scroll_down__", mode: "SCROLL_DOWN", description: "SCROLL_DOWN: look at more of the page below" },
  scroll && scroll.top > 0 && { id: "__scroll_up__", mode: "SCROLL_UP", description: "SCROLL_UP: look at more of the page above" },
  { id: "__wait__", mode: "WAIT", description: "WAIT: the page is still loading or updating" },
  { id: "__done__", mode: "DONE", description: "DONE: the goal is fully accomplished right now -- the answer is already on screen or the requested change is made, not merely progress toward it and not a list of several still-uncompared options" },
  { id: "__blocked__", mode: "BLOCKED", description: "BLOCKED: the goal cannot be advanced from this page (login wall, error page, nothing relevant to do)" }
].filter(Boolean)

const offeredCandidates = (candidates) => (Array.isArray(candidates) ? candidates : [])
  .filter((candidate) => candidate && CANDIDATE_MODES.has(candidate.mode) && typeof candidate.description === "string" && candidate.id != null)
  .slice(0, MAX_CANDIDATE_OPTIONS)

async function decide(reqId, state, goal, candidates, remainingCalls) {
  const budget = { calls: 0, limit: Math.min(Math.max(Number(remainingCalls) || 0, 0), MAX_CALLS_PER_DECISION) }
  try {
    await decideWithin(budget, reqId, state, goal, candidates)
  } catch (error) {
    send(reqId, { error: error?.message ?? String(error), calls: budget.calls })
  }
}

async function decideWithin(budget, reqId, state, goal, candidates) {
  const image = visionCapable && state.screenshot ? screenshotBytes(state.screenshot) : undefined
  const context = describeState(goal, state)
  const offered = offeredCandidates(candidates)
  const known = [goal, state.url, ...offered.map((candidate) => candidate.description)].join(" ")
  let options = [...offered, ...operationOptions(state.scroll)]
  let lastError = ""
  const notes = []
  while (options.length >= 2) {
    const chosen = await chooseOne(context, options, "Choose the next action that most directly advances the goal:", budget, image)
    if (chosen.error) return send(reqId, { error: lastError || chosen.error, calls: budget.calls })
    if (chosen.option.mode === "DONE") {
      const verdict = await chooseOne(context, DONE_CHECK_OPTIONS, "", budget, image, `Is the goal "${clip(goal, 256)}" completely achieved on this page right now?`)
      if (verdict.error) return send(reqId, { error: lastError || verdict.error, calls: budget.calls })
      if (verdict.option.id !== "YES") {
        notes.push("DONE was proposed but the completion check answered No")
        options = options.filter((option) => option !== chosen.option)
        continue
      }
    }
    const outcome = await realize(chosen.option, context, goal, known, budget, image)
    if (!outcome.error) return send(reqId, { type: "decision", ...outcome.decision, notes, calls: budget.calls })
    lastError = outcome.error
    notes.push(`${chosen.option.mode} discarded: ${outcome.error}`)
    options = options.filter((option) => option !== chosen.option)
  }
  send(reqId, { error: lastError || "No compatible action remained", calls: budget.calls })
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
