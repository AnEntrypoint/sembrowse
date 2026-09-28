const goalOutput = document.querySelector("#goal")
const stop = document.querySelector("#stop")
const download = document.querySelector("#download")
const status = document.querySelector("#status")
const trace = document.querySelector("#trace")

const MAX_STEPS = 60
const MAX_MODEL_CALLS = 120
const HISTORY_LIMIT = 8
const LOAD_STALL_TIMEOUT_MS = 180000
const DECIDE_TIMEOUT_MS = 400000
const OBSERVE_TIMEOUT_MS = 15000
const WORKER_READY_TIMEOUT_MS = 30000
const SCREENSHOT_QUALITY = 92
const runtimeVersion = "wllama 3.6.1"
const pageOrigins = ["<all_urls>"]

const worker = new Worker(`inference_worker.js?v=${chrome.runtime.getManifest().version}`, { type: "module" })
const pending = new Map()
let evidence = null
let sequence = 0
let cancelled = false
let activeRun = ""
let workerFailure = ""
let resolveWorkerReady
let rejectWorkerReady
const workerReady = new Promise((resolve, reject) => {
  resolveWorkerReady = resolve
  rejectWorkerReady = reject
})
const workerReadyTimer = setTimeout(() => {
  workerFailure = "Local model worker did not become ready"
  rejectWorkerReady(new Error(workerFailure))
}, WORKER_READY_TIMEOUT_MS)

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const timed = (promise, milliseconds, message) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), milliseconds))])

const setStatus = (message) => {
  status.textContent = message
  if (evidence) evidence.events.push({ type: "status", message, at: new Date().toISOString() })
  if (activeRun) void chrome.storage.local.set({ lastTaskStatus: { message, updatedAt: Date.now() } })
}

const appendTrace = (message) => {
  const item = document.createElement("li")
  item.textContent = message
  trace.append(item)
  if (evidence) evidence.events.push({ type: "trace", message, at: new Date().toISOString() })
  trace.scrollTop = trace.scrollHeight
}

const downloadEvidence = () => {
  if (!evidence?.finishedAt) return
  const payload = { ...evidence, exportedAt: new Date().toISOString() }
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = `sembrowse-task-${evidence.id}.json`
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
download.addEventListener("click", downloadEvidence)

const request = async (type, payload = {}, timeout = 90000) => {
  if (workerFailure) throw new Error(workerFailure)
  await workerReady
  if (workerFailure) throw new Error(workerFailure)
  const id = String(++sequence)
  return new Promise((resolve, reject) => {
    let timer
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        pending.delete(id)
        const message = `Local model ${type} timed out`
        worker.terminate()
        workerFailure = message
        reject(new Error(message))
      }, timeout)
    }
    arm()
    pending.set(id, { resolve: (data) => { clearTimeout(timer); resolve(data) }, reject: (error) => { clearTimeout(timer); reject(error) }, arm })
    worker.postMessage({ ...payload, type, reqId: id })
  })
}

const failWorker = (message) => {
  clearTimeout(workerReadyTimer)
  workerFailure = message
  rejectWorkerReady(new Error(message))
  for (const [id, callback] of pending) {
    pending.delete(id)
    callback.reject(new Error(message))
  }
  setStatus(message)
}

worker.addEventListener("message", ({ data }) => {
  if (!data || typeof data !== "object") return
  if (data.type === "worker_ready") {
    clearTimeout(workerReadyTimer)
    resolveWorkerReady()
    return
  }
  if (data.type === "progress") {
    setStatus(data.message)
    if (data.real) for (const callback of pending.values()) callback.arm?.()
    return
  }
  const callback = pending.get(data.reqId)
  if (!callback) return
  pending.delete(data.reqId)
  if (data.error) callback.reject(new Error(data.error))
  else callback.resolve(data)
})
worker.addEventListener("error", (event) => failWorker(event.error?.message || event.message || "Local model worker failed to start"))
worker.addEventListener("messageerror", () => failWorker("Local model worker returned an unreadable response"))

const snapshotFor = async (tabId, windowId, needsScreenshot) => {
  await timed(chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }), OBSERVE_TIMEOUT_MS, "Page observation timed out")
  const [response, screenshot] = await Promise.all([
    timed(chrome.tabs.sendMessage(tabId, { type: "sembrowse-candidates" }), OBSERVE_TIMEOUT_MS, "Page observation was interrupted"),
    needsScreenshot ? chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: SCREENSHOT_QUALITY }).catch(() => null) : Promise.resolve(null)
  ])
  if (response?.state) {
    if (screenshot) response.state.screenshot = screenshot
    response.state.screenshotDegraded = needsScreenshot && !screenshot
  }
  return response
}

const hasPageAccess = () => chrome.permissions.contains({ origins: pageOrigins })
const isInjectablePage = (tab) => /^https?:\/\//i.test(tab?.url || "")

const waitForTabComplete = (tabId, timeout = 30000) => new Promise((resolve) => {
  let settled = false
  const finish = (loaded) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    chrome.tabs.onUpdated.removeListener(onUpdated)
    resolve(loaded)
  }
  const onUpdated = (updatedTabId, changeInfo) => {
    if (updatedTabId === tabId && changeInfo.status === "complete") finish(true)
  }
  const timer = setTimeout(() => finish(false), timeout)
  chrome.tabs.onUpdated.addListener(onUpdated)
  chrome.tabs.get(tabId).then((tab) => {
    if (tab.status === "complete") finish(true)
  }).catch(() => finish(false))
})

const settle = async (operation) => {
  if (operation === "TYPE_TEXT") return sleep(200)
  if (operation === "WAIT") return sleep(100)
  await Promise.race([new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))), sleep(50)])
}

const safeDestination = (raw) => {
  try {
    const destination = new URL(raw)
    return destination.protocol === "https:" || destination.protocol === "http:" ? destination : null
  } catch {
    return null
  }
}

const actionSummary = (result, executed) => {
  if (result.operation === "TYPE_TEXT") return `TYPE_TEXT "${result.text}"${result.submit ? " and pressed Enter" : " without submitting"}: ${executed.description}`
  return `${result.operation}: ${executed.description}`
}

stop.addEventListener("click", () => {
  cancelled = true
  setStatus("Stopping after the current local model call…")
})

async function observe(task, visionCapable) {
  try {
    setStatus("Observing the current page…")
    return { snapshot: await snapshotFor(task.tabId, task.windowId, visionCapable) }
  } catch {
    if (!await hasPageAccess()) return { halt: "Page access was revoked; restart from the Sembrowse popup" }
    const tab = await chrome.tabs.get(task.tabId).catch(() => null)
    if (!tab) return { halt: "Task tab was closed; task stopped" }
    if (tab.status === "complete" && !isInjectablePage(tab)) return { halt: "Page does not allow extension access; task stopped" }
    setStatus("Waiting for page navigation…")
    if (!await waitForTabComplete(task.tabId)) return { halt: "Page did not finish loading; task stopped" }
    return { retry: "page changed; re-observing" }
  }
}

async function navigateTo(tabId, destination, failure) {
  await chrome.tabs.update(tabId, { url: destination.href })
  return await waitForTabComplete(tabId) ? "" : failure
}

async function run(task) {
  activeRun = task.id
  evidence = {
    schemaVersion: 2,
    id: task.id,
    goal: task.goal,
    modelId: task.modelId,
    runtimeVersion,
    extensionVersion: chrome.runtime.getManifest().version,
    tabId: task.tabId,
    windowId: task.windowId,
    startedAt: new Date().toISOString(),
    events: []
  }
  download.disabled = true
  goalOutput.textContent = task.goal
  setStatus("Loading local model…")
  const loadedModel = await request("load", { modelId: task.modelId }, LOAD_STALL_TIMEOUT_MS)
  evidence.runtimeMode = loadedModel.runtimeMode
  evidence.modelArtifact = loadedModel.artifact
  evidence.visionCapable = loadedModel.visionCapable
  const guard = createLoopGuard()
  const history = []
  const remember = (line) => {
    history.push(line)
    if (history.length > HISTORY_LIMIT) history.shift()
  }
  let modelCalls = 0

  for (let step = 1; step <= MAX_STEPS && !cancelled && activeRun === task.id; step += 1) {
    const observation = await observe(task, loadedModel.visionCapable)
    if (observation.halt) return setStatus(observation.halt)
    if (observation.retry) {
      appendTrace(`${step}. ${observation.retry}`)
      guard.markStale()
      continue
    }
    const snapshot = observation.snapshot
    if (!snapshot || typeof snapshot !== "object") {
      appendTrace(`${step}. page response unavailable; re-observing`)
      guard.markStale()
      continue
    }
    if (snapshot.error) return setStatus(snapshot.error)
    evidence.observedUrl = snapshot.state.url
    if (snapshot.state.screenshotDegraded) appendTrace(`${step}. screenshot unavailable this step; deciding from text only`)
    if (guard.observe(snapshot.state).blocked) return setStatus("Task blocked after three unchanged non-wait actions")
    if (modelCalls >= MAX_MODEL_CALLS) return setStatus(`Task stopped at the ${MAX_MODEL_CALLS} local model-call limit`)

    const candidates = guard.liveCandidates(snapshot.state.url, snapshot.candidates)
    setStatus("Choosing the next local browser action…")
    let decisionElapsed = 0
    const decisionTimer = setInterval(() => {
      decisionElapsed += 5
      setStatus(`Choosing the next local browser action… (${decisionElapsed}s)`)
    }, 5000)
    let result
    try {
      result = await request("decide", { state: { ...snapshot.state, history }, goal: task.goal, candidates, remainingCalls: MAX_MODEL_CALLS - modelCalls }, DECIDE_TIMEOUT_MS)
    } finally {
      clearInterval(decisionTimer)
    }
    if (cancelled || activeRun !== task.id) return
    modelCalls += result.calls || 0

    const selected = candidates.find((candidate) => candidate.id === result.id)
    if (selected) appendTrace(`${step}. selected ${result.operation}: ${selected.description}`)
    const action = { url: snapshot.state.url, operation: result.operation, key: selected?.key || "", detail: result.operation === "TYPE_TEXT" ? result.text : result.operation.startsWith("SCROLL") ? String(snapshot.state.scroll.top) : result.url || "" }

    if (result.operation === "DONE" || result.operation === "BLOCKED") {
      if (result.operation === "DONE") {
        evidence.completedUrl = snapshot.state.url
        evidence.completionVerified = true
        evidence.completionCheck = "model-completion"
      }
      appendTrace(`${step}. ${result.operation}`)
      return setStatus(result.operation === "DONE" ? "Task completed locally" : "Task blocked; review the visible page state")
    }

    if (result.operation === "NAVIGATE_URL") {
      const destination = safeDestination(result.url)
      if (!destination) return setStatus("Local model returned an unsafe navigation target")
      appendTrace(`${step}. navigate-url: ${destination.href}`)
      const failure = await navigateTo(task.tabId, destination, "Browser navigation did not complete")
      if (failure) return setStatus(failure)
      remember(`NAVIGATE_URL: ${destination.href}`)
    } else {
      let executed
      try {
        executed = await timed(chrome.tabs.sendMessage(task.tabId, { fingerprint: snapshot.fingerprint, ...result, type: "sembrowse-execute" }), OBSERVE_TIMEOUT_MS, "Action receiver was interrupted")
      } catch (error) {
        appendTrace(`${step}. stale action discarded: ${error.message}`)
        guard.markStale()
        await sleep(100)
        continue
      }
      if (!executed || typeof executed !== "object") {
        appendTrace(`${step}. action triggered navigation; re-observing`)
        guard.markStale()
        if (!await waitForTabComplete(task.tabId)) return setStatus("Page did not finish loading after the selected action")
        continue
      }
      if (executed.error) {
        if (/changed|interrupted/i.test(executed.error)) {
          appendTrace(`${step}. stale action discarded`)
          guard.markStale()
          continue
        }
        return setStatus(executed.error)
      }
      if (executed.navigation) {
        const destination = safeDestination(executed.navigation)
        if (!destination) return setStatus("Browser action returned an unsafe navigation target")
        const failure = await navigateTo(task.tabId, destination, "Browser navigation did not complete")
        if (failure) return setStatus(failure)
      }
      remember(actionSummary(result, executed))
      appendTrace(`${step}. ${actionSummary(result, executed)}`)
    }

    const verdict = guard.record(action)
    if (verdict.verdict === "stop") return setStatus(`Task stopped: ${verdict.reason}`)
    if (verdict.verdict === "warn") {
      remember(`Loop warning: your last ${verdict.period * 2} actions repeated a cycle of ${verdict.period} without progress. Do something different, or choose BLOCKED if the goal cannot be reached.`)
      appendTrace(`${step}. loop detected; warning the model`)
    }
    await settle(result.operation)
  }
  setStatus(cancelled ? "Task stopped" : `Task stopped after ${MAX_STEPS} actions`)
}

chrome.storage.local.get({ task: null }).then(({ task }) => {
  if (!task) {
    status.textContent = "Open this runner from the Sembrowse popup"
    stop.disabled = true
    return
  }
  run(task).catch((error) => {
    setStatus(error.message)
    if (evidence) evidence.error = error.message
  }).finally(async () => {
    if (evidence && !evidence.finishedAt) {
      evidence.finishedAt = new Date().toISOString()
      evidence.terminalStatus = status.textContent
    }
    if (evidence) await chrome.storage.local.set({ lastTaskEvidence: evidence })
    await chrome.storage.local.remove("task")
    stop.disabled = true
    download.disabled = !evidence?.finishedAt
  })
})
