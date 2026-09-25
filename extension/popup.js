const goal = document.querySelector("#goal")
const model = document.querySelector("#model")
const load = document.querySelector("#load")
const decide = document.querySelector("#decide")
const status = document.querySelector("#status")
const worker = new Worker("inference_worker.js", { type: "module" })
const pending = new Map()
let sequence = 0
let ready = false

chrome.storage.local.get({ goal: "", model: model.value }, (saved) => {
  goal.value = saved.goal
  model.value = saved.model
})

function request(type, payload = {}) {
  const id = String(++sequence)
  worker.postMessage({ id, type, ...payload })
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

worker.addEventListener("message", ({ data }) => {
  if (data.type === "progress") {
    status.textContent = data.message
    return
  }
  const callback = pending.get(data.id)
  if (!callback) return
  pending.delete(data.id)
  data.error ? callback.reject(new Error(data.error)) : callback.resolve(data)
})

load.addEventListener("click", async () => {
  if (!navigator.gpu) {
    status.textContent = "WebGPU is unavailable in this browser"
    return
  }
  load.disabled = true
  status.textContent = "Loading model into browser WebGPU…"
  try {
    await request("load", { modelId: model.value })
    chrome.storage.local.set({ model: model.value })
    ready = true
    model.disabled = true
    load.textContent = "Model ready"
    status.textContent = "Model is loaded locally in this browser"
  } catch (error) {
    status.textContent = error.message
    load.disabled = false
  }
})

decide.addEventListener("click", async () => {
  const requestGoal = goal.value.trim()
  if (!ready || !requestGoal) {
    status.textContent = ready ? "Enter a goal" : "Load a browser model first"
    return
  }
  chrome.storage.local.set({ goal: requestGoal })
  decide.disabled = true
  status.textContent = "Scoring visible actions locally…"
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] })
    const snapshot = await chrome.tabs.sendMessage(tab.id, { type: "sembrowse-candidates" })
    if (snapshot.error) throw new Error(snapshot.error)
    const result = await request("choose", { state: snapshot.state, goal: requestGoal, candidates: snapshot.candidates })
    const executed = await chrome.tabs.sendMessage(tab.id, { type: "sembrowse-execute", id: result.choice, fingerprint: snapshot.fingerprint })
    status.textContent = executed.error || `Selected: ${executed.description}`
  } catch (error) {
    status.textContent = error.message
  } finally {
    decide.disabled = false
  }
})
