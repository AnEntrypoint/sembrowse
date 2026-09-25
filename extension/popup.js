const goal = document.querySelector("#goal")
const model = document.querySelector("#model")
const load = document.querySelector("#load")
const decide = document.querySelector("#decide")
const stop = document.querySelector("#stop")
const status = document.querySelector("#status")
const trace = document.querySelector("#trace")
const worker = new Worker("inference_worker.js", { type: "module" })
const pending = new Map()
let sequence = 0
let ready = false
let running = false
let cancelled = false

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

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const appendTrace = (message) => {
  const item = document.createElement("li")
  item.textContent = message
  trace.append(item)
  trace.scrollTop = trace.scrollHeight
}
const snapshotFor = async (tabId) => {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] })
  return chrome.tabs.sendMessage(tabId, { type: "sembrowse-candidates" })
}

stop.addEventListener("click", () => {
  cancelled = true
  status.textContent = "Stopping after the current local action…"
})

decide.addEventListener("click", async () => {
  const requestGoal = goal.value.trim()
  if (running || !ready || !requestGoal) {
    status.textContent = ready ? "Enter a goal" : "Load a browser model first"
    return
  }
  chrome.storage.local.set({ goal: requestGoal })
  running = true
  cancelled = false
  decide.disabled = true
  stop.disabled = false
  trace.replaceChildren()
  status.textContent = "Running local browser task…"
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    let unchanged = 0
    let previousState = ""
    const history = []
    for (let step = 1; step <= 60 && !cancelled; step += 1) {
      const snapshot = await snapshotFor(tab.id)
      if (snapshot.error) {
        status.textContent = snapshot.error
        return
      }
      const stateKey = JSON.stringify({ url: snapshot.state.url, text: snapshot.state.text, scroll: snapshot.state.scroll, candidates: snapshot.candidates.map(({ id, description, mode }) => ({ id, description, mode })) })
      unchanged = stateKey === previousState ? unchanged + 1 : 0
      previousState = stateKey
      if (unchanged >= 3) {
        status.textContent = "Task blocked after three unchanged page states"
        return
      }
      const result = await request("decide", { state: { ...snapshot.state, history }, goal: requestGoal, candidates: snapshot.candidates })
      if (result.operation === "DONE" || result.operation === "BLOCKED") {
        appendTrace(`${step}. ${result.operation} (${(result.probability * 100).toFixed(0)}%)`)
        status.textContent = result.operation === "DONE" ? "Task completed locally" : "Task blocked; review the visible page state"
        return
      }
      const executed = await chrome.tabs.sendMessage(tab.id, { type: "sembrowse-execute", fingerprint: snapshot.fingerprint, ...result })
      if (executed.error) {
        if (/changed/i.test(executed.error)) {
          appendTrace(`${step}. stale decision discarded`)
          continue
        }
        status.textContent = executed.error
        return
      }
      history.push(`${result.operation}: ${executed.description}`)
      if (history.length > 6) history.shift()
      appendTrace(`${step}. ${result.operation}: ${executed.description} (${(result.probability * 100).toFixed(0)}%)`)
      await sleep(result.operation === "TYPE_TEXT" ? 200 : result.operation === "WAIT" ? 100 : 50)
    }
    status.textContent = cancelled ? "Task stopped" : "Task stopped after 60 actions"
  } catch (error) {
    status.textContent = error.message
  } finally {
    running = false
    stop.disabled = true
    decide.disabled = false
  }
})
