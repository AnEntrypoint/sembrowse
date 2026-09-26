const browserFetch = self.fetch.bind(self)
self.fetch = (input, init = {}) => browserFetch(input, { ...init, referrerPolicy: "no-referrer" })
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
  "qwen3-0.6b": { url: "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/23749fefcc72300e3a2ad315e1317431b06b590a/Qwen3-0.6B-Q8_0.gguf", labelBase: 32 },
  "minicpm5-2b": { url: "https://huggingface.co/openbmb/MiniCPM5-2B-GGUF/resolve/2079a22f3beaa4e306449978533478fe0522f4b3/MiniCPM5-2B-Q4_K_M.gguf", labelBase: 54 }
}
let engine
let selected
let loading
let loadingModelId = ""
const labelsFor = (count) => Array.from({ length: count }, (_, index) => String.fromCharCode(65 + index))
const send = (id, payload) => self.postMessage({ id, ...payload })
const reportProgress = (message) => self.postMessage({ type: "progress", message })
const waitAtStage = async (message, operation) => {
  let current = message
  let elapsed = 0
  reportProgress(current)
  const timer = setInterval(() => {
    elapsed += 15
    reportProgress(`${current} (${elapsed}s)`)
  }, 15000)
  try {
    return await operation((next) => {
      current = next
      reportProgress(current)
    })
  } finally {
    clearInterval(timer)
  }
}
const softmax = (values) => {
  const maximum = Math.max(...values)
  const weights = values.map((value) => Math.exp(value - maximum))
  const total = weights.reduce((sum, value) => sum + value, 0)
  return weights.map((value) => value / total)
}

async function initializeModel() {
  const { Wllama, LoggerWithoutDebug } = await waitAtStage("Preparing local model runtime…", () => getRuntime())
  const loadedEngine = new Wllama({ default: new URL("./vendor/wllama/wasm/wllama.wasm", self.location.href).href }, { logger: LoggerWithoutDebug, suppressNativeLog: true, parallelDownloads: 4 })
  loadedEngine.setCompat({
    worker: new URL("./vendor/wllama/compat/wllama.js", self.location.href).href,
    wasm: new URL("./vendor/wllama/compat/wllama.wasm", self.location.href).href
  }, "always")
  let loaded = false
  try {
    await waitAtStage("Opening the browser-cached model…", (setStage) => loadedEngine.loadModelFromUrl(selected.url, {
      n_ctx: 2048,
      n_batch: 512,
      n_gpu_layers: 999,
      useCache: true,
      cache_prompt: false,
      progressCallback: ({ loaded, total }) => setStage(total && loaded >= total ? "Caching the downloaded model locally…" : total ? `Downloading model: ${Math.round(loaded / total * 100)}%` : `Downloading model: ${loaded} bytes`)
    }))
    await waitAtStage("Warming the local WebGPU model…", () => loadedEngine.createChatCompletion({
      messages: [{ role: "system", content: "Reply with READY." }, { role: "user", content: "READY" }],
      max_tokens: 1,
      temperature: 0
    }))
    loaded = true
  } finally {
    if (!loaded) await loadedEngine.exit().catch(() => undefined)
  }
  engine = loadedEngine
  reportProgress("Local WebGPU model is ready.")
}

async function load(id, modelId) {
  if (engine) return send(id, { type: "ready" })
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
  send(id, { type: "ready" })
}

async function chooseOne(goal, state, candidates, instruction, budget) {
  if (!engine || !selected) return { error: "Load a browser model first" }
  if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > 16) return { error: "The browser decision needs 2 to 16 compatible choices" }
  if (budget.calls >= budget.limit) return { error: "The local model-call budget is exhausted" }
  budget.calls += 1
  const labels = labelsFor(candidates.length)
  const options = candidates.map(({ description }, index) => `${labels[index]}. ${description}`).join("\n")
  const response = await engine.createChatCompletion({
    messages: [{ role: "system", content: "Choose exactly one allowed letter for the next browser step." }, { role: "user", content: `Goal:\n${goal}\n\nRecent actions:\n${state.history?.join("\n") || "none"}\n\nPage:\n${state.text}\n\n${instruction}\n${options}` }],
    max_tokens: 1,
    temperature: 1,
    top_k: 0,
    top_p: 1,
    logprobs: true,
    top_logprobs: 16,
    logit_bias: Object.fromEntries(labels.map((label, index) => [String(selected.labelBase + index), 100])),
    grammar: `root ::= ${labels.map((label) => `"${label}"`).join(" | ")}`,
    cache_prompt: false,
    chat_template_kwargs: { enable_thinking: false }
  })
  const top = response.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs ?? []
  const logits = labels.map((label) => Number(top.find((item) => item.token === label || item.bytes?.[0] === label.charCodeAt(0))?.logprob))
  if (logits.some((value) => !Number.isFinite(value))) return { error: "The browser model did not provide all action logits" }
  const probabilities = softmax(logits)
  const index = probabilities.indexOf(Math.max(...probabilities))
  return { candidate: candidates[index], probability: probabilities[index], probabilities: Object.fromEntries(candidates.map((candidate, position) => [candidate.id, probabilities[position]])) }
}

const chooseCompatible = (goal, state, candidates, instruction, budget) => candidates.length === 1 ? Promise.resolve({ candidate: candidates[0], probability: 1 }) : chooseOne(goal, state, candidates, instruction, budget)

async function typeText(goal, state, target, budget) {
  if (budget.calls >= budget.limit) return { error: "The local model-call budget is exhausted" }
  budget.calls += 1
  const response = await engine.createChatCompletion({
    messages: [{ role: "system", content: "Return only the short text that belongs in the selected browser field. Do not add quotes, labels, or explanation." }, { role: "user", content: `Goal:\n${goal}\n\nPage:\n${state.text}\n\nField:\n${target.description}` }],
    max_tokens: 64,
    temperature: 0,
    cache_prompt: false,
    chat_template_kwargs: { enable_thinking: false }
  })
  const text = response.choices?.[0]?.message?.content?.trim().replace(/^['"]|['"]$/g, "").slice(0, 256)
  return text || { error: "The local model did not generate field text" }
}

async function decide(id, state, goal, candidates, remainingCalls) {
  const budget = { calls: 0, limit: Math.min(Math.max(Number(remainingCalls) || 0, 0), 4) }
  const available = Array.isArray(candidates) ? candidates : []
  const operations = [
    available.some((candidate) => candidate.mode === "CLICK") && { id: "CLICK", description: "CLICK a visible button, link, checkbox, or control" },
    available.some((candidate) => candidate.mode === "TYPE_TEXT") && { id: "TYPE_TEXT", description: "TYPE_TEXT into a visible editable field" },
    available.some((candidate) => candidate.mode === "SELECT" && candidate.options.length) && { id: "SELECT", description: "SELECT an observed native dropdown option" },
    state.scroll?.top > 0 && { id: "SCROLL_UP", description: "SCROLL_UP to reveal earlier page content" },
    state.scroll?.top + state.scroll?.viewport < state.scroll?.height && { id: "SCROLL_DOWN", description: "SCROLL_DOWN to reveal later page content" },
    { id: "WAIT", description: "WAIT for the current page to settle" },
    { id: "DONE", description: "DONE because the goal is visibly complete" },
    { id: "BLOCKED", description: "BLOCKED because no safe visible action can advance the goal" }
  ].filter(Boolean)
  const operation = await chooseOne(goal, state, operations, "Allowed operations:", budget)
  if (operation.error) return send(id, { ...operation, calls: budget.calls })
  if (operation.candidate.id === "DONE" || operation.candidate.id === "BLOCKED" || operation.candidate.id === "WAIT" || operation.candidate.id.startsWith("SCROLL")) {
    send(id, { type: "decision", operation: operation.candidate.id, probability: operation.probability, calls: budget.calls })
    return
  }
  const targets = available.filter((candidate) => candidate.mode === operation.candidate.id)
  const target = await chooseCompatible(goal, state, targets, `Choose the compatible target for ${operation.candidate.id}:`, budget)
  if (target.error) return send(id, { ...target, calls: budget.calls })
  if (operation.candidate.id === "SELECT") {
    const option = await chooseCompatible(goal, state, target.candidate.options.map((choice) => ({ id: String(choice.index), description: choice.description })), "Choose the observed native dropdown option:", budget)
    if (option.error) return send(id, { ...option, calls: budget.calls })
    send(id, { type: "decision", operation: "SELECT", id: target.candidate.id, optionIndex: Number(option.candidate.id), probability: target.probability, calls: budget.calls })
    return
  }
  const text = operation.candidate.id === "TYPE_TEXT" ? await typeText(goal, state, target.candidate, budget) : undefined
  if (text?.error) return send(id, { ...text, calls: budget.calls })
  send(id, { type: "decision", operation: operation.candidate.id, id: target.candidate.id, text, probability: target.probability, calls: budget.calls })
}

self.addEventListener("message", async ({ data }) => {
  try {
    if (data.type === "load") await load(data.id, data.modelId)
    if (data.type === "decide") await decide(data.id, data.state, data.goal, data.candidates, data.remainingCalls)
  } catch (error) {
    send(data.id, { error: error?.message ?? String(error) })
  }
})
