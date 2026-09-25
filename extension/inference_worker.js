const browserFetch = self.fetch.bind(self)
self.fetch = (input, init = {}) => browserFetch(input, { ...init, referrerPolicy: "no-referrer" })
const { Wllama, LoggerWithoutDebug } = await import("./vendor/wllama/index.js")
const models = {
  "qwen3-0.6b": { url: "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/23749fefcc72300e3a2ad315e1317431b06b590a/Qwen3-0.6B-Q8_0.gguf", labelBase: 32 },
  "minicpm5-2b": { url: "https://huggingface.co/openbmb/MiniCPM5-2B-GGUF/resolve/2079a22f3beaa4e306449978533478fe0522f4b3/MiniCPM5-2B-Q4_K_M.gguf", labelBase: 54 }
}
let engine
let selected
const labelsFor = (count) => Array.from({ length: count }, (_, index) => String.fromCharCode(65 + index))
const send = (id, payload) => self.postMessage({ id, ...payload })
const softmax = (values) => {
  const maximum = Math.max(...values)
  const weights = values.map((value) => Math.exp(value - maximum))
  const total = weights.reduce((sum, value) => sum + value, 0)
  return weights.map((value) => value / total)
}

async function load(id, modelId) {
  if (engine) return send(id, { type: "ready" })
  selected = models[modelId]
  if (!selected) throw new Error("Choose a supported browser model")
  engine = new Wllama({ default: new URL("./vendor/wllama/wasm/wllama.wasm", self.location.href).href }, { logger: LoggerWithoutDebug, suppressNativeLog: true, parallelDownloads: 4 })
  self.postMessage({ type: "progress", message: "Downloading or opening the browser-cached model…" })
  await engine.loadModelFromUrl(selected.url, {
    n_ctx: 2048,
    n_batch: 512,
    n_gpu_layers: 999,
    cache_prompt: false,
    progressCallback: ({ loaded, total }) => self.postMessage({ type: "progress", message: total ? `Loading model ${(loaded / total * 100).toFixed(0)}%` : "Loading model" })
  })
  await engine.createChatCompletion({ messages: [{ role: "user", content: "Reply ready." }], max_tokens: 1, temperature: 0, cache_prompt: false, chat_template_kwargs: { enable_thinking: false } })
  send(id, { type: "ready" })
}

async function choose(id, state, goal, candidates) {
  if (!engine || !selected) throw new Error("Load a browser model first")
  if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > 16) throw new Error("The browser decision needs 2 to 16 visible actions")
  const labels = labelsFor(candidates.length)
  const options = candidates.map(({ description }, index) => `${labels[index]}. ${description}`).join("\n")
  const response = await engine.createChatCompletion({
    messages: [{ role: "system", content: "Choose one visible browser action that advances the user goal. Reply with exactly one allowed letter." }, { role: "user", content: `Goal:\n${goal}\n\nPage:\n${state.text}\n\nAllowed actions:\n${options}` }],
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
  if (logits.some((value) => !Number.isFinite(value))) throw new Error("The browser model did not provide all action logits")
  const probabilities = softmax(logits)
  const index = probabilities.indexOf(Math.max(...probabilities))
  send(id, { type: "decision", choice: candidates[index].id, probabilities: Object.fromEntries(candidates.map((candidate, position) => [candidate.id, probabilities[position]])) })
}

self.addEventListener("message", async ({ data }) => {
  try {
    if (data.type === "load") await load(data.id, data.modelId)
    if (data.type === "choose") await choose(data.id, data.state, data.goal, data.candidates)
  } catch (error) {
    send(data.id, { error: error?.message ?? String(error) })
  }
})
