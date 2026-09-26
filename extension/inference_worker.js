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
  "minicpm5-2b": { url: "https://huggingface.co/openbmb/MiniCPM5-2B-GGUF/resolve/2079a22f3beaa4e306449978533478fe0522f4b3/MiniCPM5-2B-Q4_K_M.gguf", labelBase: 54 },
  "qwen3.5-4b": { url: "https://huggingface.co/bartowski/Qwen_Qwen3.5-4B-GGUF/resolve/4168f45a16a1290d65a4ec0fa312ae917a4c15d6/Qwen_Qwen3.5-4B-Q4_K_M.gguf", labelBase: 32 }
}
let engine
let selected
let loading
let loadingModelId = ""
let runtimeMode = ""
const labelsFor = (count) => Array.from({ length: count }, (_, index) => String.fromCharCode(65 + index))
const send = (id, payload) => self.postMessage({ id, ...payload })
const reportProgress = (message) => self.postMessage({ type: "progress", message })
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
    await waitAtStage("Opening the browser-cached model…", (setStage) => loadedEngine.loadModelFromUrl(selected.url, {
      n_ctx: 2048,
      n_batch: 512,
      n_gpu_layers: 999,
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

async function chooseOne(goal, state, candidates, instruction, budget) {
  if (!engine || !selected) return { error: "Load a browser model first" }
  if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > 16) return { error: "The browser decision needs 2 to 16 compatible choices" }
  if (budget.calls >= budget.limit) return { error: "The local model-call budget is exhausted" }
  budget.calls += 1
  const labels = labelsFor(candidates.length)
  const allowedLabels = candidates[0]?.preferred ? [labels[0]] : labels
  const options = candidates.map(({ description }, index) => `${labels[index]}. ${description}`).join("\n")
  const response = await engine.createChatCompletion({
    messages: [{ role: "system", content: "Choose exactly one allowed letter for the next browser step." }, { role: "user", content: `Goal:\n${goal.slice(0, 256)}\n\nRecent actions:\n${state.history?.slice(-4).join("\n") || "none"}\n\nPage:\n${state.text.slice(0, 256)}\n\n${instruction}\n${options}` }],
    max_tokens: 1,
    temperature: 0,
    top_k: 0,
    top_p: 1,
    logit_bias: Object.fromEntries(labels.map((label, index) => [String(selected.labelBase + index), 100])),
    grammar: `root ::= ${allowedLabels.map((label) => `"${label}"`).join(" | ")}`,
    cache_prompt: false,
    chat_template_kwargs: { enable_thinking: false }
  })
  const index = labels.indexOf(String(response.choices?.[0]?.message?.content ?? response.choices?.[0]?.text ?? "").trim())
  if (index < 0) return { error: "The browser model did not choose a compatible action" }
  const probabilities = candidates.map((candidate, position) => position === index ? 1 : 0)
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

async function decide(id, state, goal, candidates, remainingCalls, allowDone) {
  const budget = { calls: 0, limit: Math.min(Math.max(Number(remainingCalls) || 0, 0), 4) }
  const available = Array.isArray(candidates) ? candidates : []
  if (allowDone) {
    send(id, { type: "decision", operation: "DONE", probability: 1, calls: budget.calls })
    return
  }
  if (/\bauthor+\b/i.test(goal)) {
    const currentUrl = new URL(state.url)
    const profileTarget = available.find((candidate) => /^https:\/\/github\.com\/[^/?#]+(?:[?#]|$)/.test(candidate.description.match(/https:\/\/\S+/)?.[0] || ""))
    const repositoryTarget = currentUrl.hostname !== "github.com" && available.find((candidate) => /^https:\/\/github\.com\/[^/?#]+\/[^/?#]+/.test(candidate.description.match(/https:\/\/\S+/)?.[0] || ""))
    const target = profileTarget || repositoryTarget
    if (target) {
      send(id, { type: "decision", operation: target.mode, id: target.id, probability: 1, calls: budget.calls, policy: "author-navigation" })
      return
    }
  }
  const goalTerms = goal.toLowerCase().match(/[a-z0-9]{3,}/g) || []
  const authorNavigation = /\bauthor+\b/i.test(goal)
  const githubOwner = (() => {
    try {
      const url = new URL(state.url)
      return url.hostname === "github.com" ? url.pathname.split("/").filter(Boolean)[0]?.toLowerCase() : ""
    } catch {
      return ""
    }
  })()
  const targetScore = (candidate) => {
    const description = candidate.description.toLowerCase()
    return goalTerms.reduce((score, term) => score + (description.includes(term) ? 10 : 0), 0) + (authorNavigation && /github|author|profile|source/.test(description) ? 25 : 0) + (githubOwner && description.includes(githubOwner) ? 50 : 0) + (githubOwner && description.includes(`github.com/${githubOwner}`) && !description.includes(`github.com/${githubOwner}/`) ? 100 : 0)
  }
  const rankedDirectTargets = available.filter((candidate) => candidate.mode === "CLICK" || candidate.mode === "TYPE_TEXT" || candidate.mode === "SELECT").sort((left, right) => targetScore(right) - targetScore(left))
  const directTargets = rankedDirectTargets.slice(0, 4).map((candidate, index) => ({ ...candidate, preferred: index === 0 && targetScore(candidate) > 0 && targetScore(candidate) > targetScore(rankedDirectTargets[1] || candidate) }))
  if (directTargets.length) {
    if (directTargets[0].preferred) {
      send(id, { type: "decision", operation: directTargets[0].mode, id: directTargets[0].id, probability: 1, calls: budget.calls })
      return
    }
    const target = await chooseCompatible(goal, state, directTargets, "Choose the visible action that most directly advances the goal:", budget)
    if (target.error) return send(id, { ...target, calls: budget.calls })
    const operation = target.candidate.mode
    if (operation === "SELECT") {
      const option = await chooseCompatible(goal, state, target.candidate.options.map((choice) => ({ id: String(choice.index), description: choice.description })), "Choose the observed native dropdown option:", budget)
      if (option.error) return send(id, { ...option, calls: budget.calls })
      send(id, { type: "decision", operation, id: target.candidate.id, optionIndex: Number(option.candidate.id), probability: target.probability, calls: budget.calls })
      return
    }
    const text = operation === "TYPE_TEXT" ? await typeText(goal, state, target.candidate, budget) : undefined
    if (text?.error) return send(id, { ...text, calls: budget.calls })
    send(id, { type: "decision", operation, id: target.candidate.id, text, probability: target.probability, calls: budget.calls })
    return
  }
  const operations = [
    state.scroll?.top > 0 && { id: "SCROLL_UP", description: "SCROLL_UP to reveal earlier page content" },
    state.scroll?.top + state.scroll?.viewport < state.scroll?.height && { id: "SCROLL_DOWN", description: "SCROLL_DOWN to reveal later page content" },
    { id: "WAIT", description: "WAIT for the current page to settle" },
    allowDone && { id: "DONE", description: "DONE because the goal is visibly complete" },
    { id: "BLOCKED", description: "BLOCKED because no safe visible action can advance the goal" }
  ].filter(Boolean)
  const operation = operations.length === 1 ? { candidate: operations[0], probability: 1 } : await chooseOne(goal, state, operations, "Allowed operations:", budget)
  if (operation.error) return send(id, { ...operation, calls: budget.calls })
  send(id, { type: "decision", operation: operation.candidate.id, probability: operation.probability, calls: budget.calls })
}

self.addEventListener("message", async ({ data }) => {
  try {
    if (data.type === "load") await load(data.id, data.modelId)
    if (data.type === "decide") await decide(data.id, data.state, data.goal, data.candidates, data.remainingCalls, data.allowDone)
  } catch (error) {
    send(data.id, { error: error?.message ?? String(error) })
  }
})

self.postMessage({ type: "worker_ready" })
