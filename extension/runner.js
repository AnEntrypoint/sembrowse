const goalOutput = document.querySelector("#goal")
const stop = document.querySelector("#stop")
const status = document.querySelector("#status")
const trace = document.querySelector("#trace")
const worker = new Worker("inference_worker.js", { type: "module" })
const pending = new Map()
let sequence = 0
let cancelled = false
let activeRun = ""

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const timed = (promise, milliseconds, message) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), milliseconds))])
const appendTrace = (message) => {
  const item = document.createElement("li")
  item.textContent = message
  trace.append(item)
  trace.scrollTop = trace.scrollHeight
}
const request = (type, payload = {}, timeout = 90000) => {
  const id = String(++sequence)
  worker.postMessage({ id, type, ...payload })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Local model ${type} timed out`))
    }, timeout)
    pending.set(id, { resolve: (data) => { clearTimeout(timer); resolve(data) }, reject: (error) => { clearTimeout(timer); reject(error) } })
  })
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

const snapshotFor = async (tabId) => {
  await timed(chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }), 15000, "Page observation timed out")
  return timed(chrome.tabs.sendMessage(tabId, { type: "sembrowse-candidates" }), 15000, "Page observation was interrupted")
}
const settle = async (operation) => {
  if (operation === "TYPE_TEXT") return sleep(200)
  if (operation === "WAIT") return sleep(100)
  await Promise.race([new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))), sleep(50)])
}

stop.addEventListener("click", () => {
  cancelled = true
  status.textContent = "Stopping after the current local model call…"
})

async function run(task) {
  activeRun = task.id
  goalOutput.textContent = task.goal
  status.textContent = "Loading local WebGPU model…"
  await request("load", { modelId: task.modelId }, 600000)
  let modelCalls = 0
  let unchanged = 0
  let previousState = ""
  let priorActionWasNonWait = false
  const history = []
  for (let step = 1; step <= 60 && !cancelled && activeRun === task.id; step += 1) {
    let snapshot
    try {
      snapshot = await snapshotFor(task.tabId)
    } catch (error) {
      appendTrace(`${step}. page changed; re-observing`)
      await sleep(100)
      continue
    }
    if (snapshot.error) {
      status.textContent = snapshot.error
      return
    }
    const stateKey = JSON.stringify({ url: snapshot.state.url, title: snapshot.state.title, text: snapshot.state.text, scroll: snapshot.state.scroll, candidates: snapshot.candidates.map(({ id, description, mode, options }) => ({ id, description, mode, options })) })
    unchanged = priorActionWasNonWait && stateKey === previousState ? unchanged + 1 : 0
    previousState = stateKey
    if (unchanged >= 3) {
      status.textContent = "Task blocked after three unchanged non-wait actions"
      return
    }
    if (modelCalls >= 120) {
      status.textContent = "Task stopped at the 120 local model-call limit"
      return
    }
    const result = await request("decide", { state: { ...snapshot.state, history }, goal: task.goal, candidates: snapshot.candidates, remainingCalls: 120 - modelCalls })
    if (cancelled || activeRun !== task.id) return
    modelCalls += result.calls || 0
    if (result.operation === "DONE" || result.operation === "BLOCKED") {
      appendTrace(`${step}. ${result.operation} (${(result.probability * 100).toFixed(0)}%)`)
      status.textContent = result.operation === "DONE" ? "Task completed locally" : "Task blocked; review the visible page state"
      return
    }
    let executed
    try {
      executed = await timed(chrome.tabs.sendMessage(task.tabId, { type: "sembrowse-execute", fingerprint: snapshot.fingerprint, ...result }), 15000, "Action receiver was interrupted")
    } catch (error) {
      appendTrace(`${step}. stale action discarded`)
      priorActionWasNonWait = false
      await sleep(100)
      continue
    }
    if (executed.error) {
      if (/changed|interrupted/i.test(executed.error)) {
        appendTrace(`${step}. stale action discarded`)
        priorActionWasNonWait = false
        continue
      }
      status.textContent = executed.error
      return
    }
    history.push(`${result.operation}: ${executed.description}`)
    if (history.length > 6) history.shift()
    appendTrace(`${step}. ${result.operation}: ${executed.description} (${(result.probability * 100).toFixed(0)}%)`)
    priorActionWasNonWait = result.operation !== "WAIT"
    await settle(result.operation)
  }
  status.textContent = cancelled ? "Task stopped" : "Task stopped after 60 actions"
}

chrome.storage.local.get({ task: null }).then(({ task }) => {
  if (!task) {
    status.textContent = "Open this runner from the Sembrowse popup"
    stop.disabled = true
    return
  }
  run(task).catch((error) => { status.textContent = error.message }).finally(async () => { await chrome.storage.local.remove("task"); stop.disabled = true })
})
