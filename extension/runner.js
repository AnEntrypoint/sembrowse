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
const MIN_CALLS_PER_DECISION = 3
const SETTLE_TYPING_MS = 500
const SETTLE_ACTION_MS = 250
const SETTLE_WAIT_MS = 100
const RETRY_DELAY_MS = 300
const DECIDE_FAILURE_LIMIT = 3
const CANDIDATE_OPERATIONS = new Set(["CLICK", "TYPE_TEXT", "SELECT"])
const STALLED_STATUS = "Task stopped: the page kept changing or refusing actions"
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
const timed = (promise, milliseconds, message) => {
  let timer
  const expiry = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds) })
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer))
}

const setStatus = (message) => {
  status.textContent = message
  if (evidence) evidence.events.push({ type: "status", message, at: new Date().toISOString() })
  if (activeRun) void chrome.storage.local.set({ lastTaskStatus: { message, updatedAt: Date.now() } })
}

const withoutQueries = (text) => text.replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, "$1")

const appendTrace = (message) => {
  const item = document.createElement("li")
  item.textContent = message
  trace.append(item)
  if (evidence) evidence.events.push({ type: "trace", message: withoutQueries(message), at: new Date().toISOString() })
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
  if (data.error) callback.reject(Object.assign(new Error(data.error), { calls: data.calls || 0 }))
  else callback.resolve(data)
})
worker.addEventListener("error", (event) => failWorker(event.error?.message || event.message || "Local model worker failed to start"))
worker.addEventListener("messageerror", () => failWorker("Local model worker returned an unreadable response"))

const captureIfActive = async (tabId, windowId) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  if (!tab?.active) return null
  return chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: SCREENSHOT_QUALITY }).catch(() => null)
}

const snapshotFor = async (tabId, windowId, needsScreenshot) => {
  await timed(chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }), OBSERVE_TIMEOUT_MS, "Page observation timed out")
  const [response, screenshot] = await Promise.all([
    timed(chrome.tabs.sendMessage(tabId, { type: "sembrowse-candidates" }), OBSERVE_TIMEOUT_MS, "Page observation was interrupted"),
    needsScreenshot ? captureIfActive(tabId, windowId) : Promise.resolve(null)
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

const settle = async (tabId, operation) => {
  await sleep(operation === "TYPE_TEXT" ? SETTLE_TYPING_MS : operation === "WAIT" ? SETTLE_WAIT_MS : SETTLE_ACTION_MS)
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  if (tab?.status === "loading") await waitForTabComplete(tabId)
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
  } catch (error) {
    if (!await hasPageAccess()) return { halt: "Page access was revoked; restart from the Sembrowse popup" }
    const tab = await chrome.tabs.get(task.tabId).catch(() => null)
    if (!tab) return { halt: "Task tab was closed; task stopped" }
    if (tab.status === "complete" && !isInjectablePage(tab)) return { halt: "Page does not allow extension access; task stopped" }
    setStatus("Waiting for page navigation…")
    if (!await waitForTabComplete(task.tabId)) return { halt: "Page did not finish loading; task stopped" }
    return { retry: `page could not be observed (${error.message}); re-observing` }
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
  let lastLine = ""
  let lastRepeats = 1
  const remember = (line) => {
    if (history.length && lastLine === line) {
      lastRepeats += 1
      history[history.length - 1] = `${line} (x${lastRepeats})`
      return
    }
    lastLine = line
    lastRepeats = 1
    history.push(line)
    if (history.length > HISTORY_LIMIT) history.shift()
  }
  const stalled = async (step, message) => {
    appendTrace(`${step}. ${message}`)
    await sleep(RETRY_DELAY_MS)
    return guard.markStale()
  }
  const halted = () => cancelled || activeRun !== task.id
  const applyVerdict = (step, action) => {
    const verdict = guard.record(action)
    if (verdict.verdict === "stop") {
      setStatus(`Task stopped: ${verdict.reason}`)
      return true
    }
    if (verdict.verdict === "warn") {
      remember(`Loop warning: your last ${verdict.period * 2} actions repeated a cycle of ${verdict.period} without progress. Do something different, or choose BLOCKED if the goal cannot be reached.`)
      appendTrace(`${step}. loop detected; warning the model`)
    }
    return false
  }
  const pageMoved = async (fromUrl) => {
    const tab = await chrome.tabs.get(task.tabId).catch(() => null)
    return !!tab && tab.url !== fromUrl
  }
  let modelCalls = 0
  let decideFailures = 0

  for (let step = 1; step <= MAX_STEPS && !halted(); step += 1) {
    const observation = await observe(task, loadedModel.visionCapable)
    if (halted()) break
    if (observation.halt) return setStatus(observation.halt)
    const snapshot = observation.snapshot
    if (observation.retry || !snapshot || typeof snapshot !== "object") {
      if (await stalled(step, observation.retry || "page response unavailable; re-observing")) return setStatus(`${STALLED_STATUS} (last: ${observation.retry || "no page response"})`)
      continue
    }
    if (snapshot.error) return setStatus(snapshot.error)
    evidence.observedUrl = withoutQueries(snapshot.state.url)
    if (snapshot.state.screenshotDegraded) appendTrace(`${step}. screenshot unavailable this step; deciding from text only`)
    const seen = guard.observe(snapshot.state)
    if (seen.blocked) return setStatus(`Task blocked after ${UNCHANGED_LIMIT} unchanged non-wait actions`)
    if (seen.warn) remember(`Warning: your last ${UNCHANGED_WARNING} actions changed nothing on the page. Try something different, or choose BLOCKED if the goal cannot be reached.`)
    if (MAX_MODEL_CALLS - modelCalls < MIN_CALLS_PER_DECISION) return setStatus(`Task stopped at the ${MAX_MODEL_CALLS} local model-call limit`)

    const candidates = guard.liveCandidates(snapshot.state.url, snapshot.candidates)
    evidence.events.push({ type: "offered", step, candidates: candidates.map((candidate) => withoutQueries(candidate.description).slice(0, 90)), at: new Date().toISOString() })
    setStatus("Choosing the next local browser action…")
    let decisionElapsed = 0
    const decisionTimer = setInterval(() => {
      decisionElapsed += 5
      setStatus(`Choosing the next local browser action… (${decisionElapsed}s)`)
    }, 5000)
    let result
    try {
      result = await request("decide", { state: { ...snapshot.state, history }, goal: task.goal, candidates, remainingCalls: MAX_MODEL_CALLS - modelCalls }, DECIDE_TIMEOUT_MS)
      if (!result?.operation) throw Object.assign(new Error("The local model returned no operation"), { calls: result?.calls || 0 })
      if (CANDIDATE_OPERATIONS.has(result.operation) && !candidates.some((candidate) => candidate.id === result.id)) throw Object.assign(new Error("The local model chose an option that was not offered"), { calls: result.calls || 0 })
    } catch (error) {
      modelCalls += error.calls || 0
      decideFailures += 1
      if (workerFailure || decideFailures >= DECIDE_FAILURE_LIMIT) throw error
      remember(`Decision failed: ${error.message}`)
      appendTrace(`${step}. decision failed: ${error.message}; retrying`)
      guard.markStale()
      continue
    } finally {
      clearInterval(decisionTimer)
    }
    decideFailures = 0
    if (halted()) break
    modelCalls += result.calls || 0

    for (const note of result.notes || []) appendTrace(`${step}. ${note}`)
    const selected = candidates.find((candidate) => candidate.id === result.id)
    if (selected) appendTrace(`${step}. selected ${result.operation}: ${selected.description}`)
    const scrollTop = snapshot.state.scroll?.top ?? 0
    const action = { url: snapshot.state.url, operation: result.operation, key: selected?.key || "", detail: result.operation === "TYPE_TEXT" ? result.text : result.operation.startsWith("SCROLL") ? String(scrollTop) : result.url || "" }

    if (result.operation === "DONE" || result.operation === "BLOCKED") {
      if (result.operation === "DONE") {
        evidence.completedUrl = withoutQueries(snapshot.state.url)
        evidence.completionCheck = "model-completion"
      }
      appendTrace(`${step}. ${result.operation}`)
      return setStatus(result.operation === "DONE" ? "Task completed locally" : "Task blocked; review the visible page state")
    }

    if (result.operation === "NAVIGATE_URL") {
      const destination = safeDestination(result.url)
      if (!destination) {
        appendTrace(`${step}. rejected navigation target: ${result.url}`)
        return setStatus("Local model returned an unsafe navigation target")
      }
      appendTrace(`${step}. navigate-url: ${destination.href}`)
      const failure = await navigateTo(task.tabId, destination, "Browser navigation did not complete")
      if (failure) return setStatus(failure)
      remember(`NAVIGATE_URL: ${destination.href}`)
    } else {
      let executed
      try {
        executed = await timed(chrome.tabs.sendMessage(task.tabId, { fingerprint: snapshot.fingerprint, ...result, type: "sembrowse-execute" }), OBSERVE_TIMEOUT_MS, "Action receiver was interrupted")
      } catch (error) {
        if (await pageMoved(snapshot.state.url)) {
          remember(`${result.operation}: ${selected?.description ?? ""} (the page navigated)`)
          appendTrace(`${step}. action triggered navigation; re-observing`)
          if (applyVerdict(step, action)) return
          if (!await waitForTabComplete(task.tabId)) return setStatus("Page did not finish loading after the selected action")
          continue
        }
        remember(`${result.operation} discarded: ${error.message}`)
        if (await stalled(step, `stale action discarded: ${error.message}`)) return setStatus(STALLED_STATUS)
        continue
      }
      if (!executed || typeof executed !== "object") {
        remember(`${result.operation}: ${selected?.description ?? ""} (the page navigated)`)
        appendTrace(`${step}. action triggered navigation; re-observing`)
        if (applyVerdict(step, action)) return
        if (!await waitForTabComplete(task.tabId)) return setStatus("Page did not finish loading after the selected action")
        continue
      }
      if (executed.error) {
        if (/changed|interrupted/i.test(executed.error)) {
          remember(`${result.operation} discarded: the page changed before it ran`)
          if (await stalled(step, "stale action discarded")) return setStatus(STALLED_STATUS)
          continue
        }
        remember(`${result.operation} failed: ${executed.error}`)
        if (selected) guard.exclude(snapshot.state.url, selected.key)
        if (await stalled(step, `${result.operation} failed: ${executed.error}`)) return setStatus(STALLED_STATUS)
        continue
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

    if (applyVerdict(step, action)) return
    await settle(task.tabId, result.operation)
  }
  setStatus(halted() ? "Task stopped" : `Task stopped after ${MAX_STEPS} actions`)
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
    worker.terminate()
    try {
      if (evidence) await chrome.storage.local.set({ lastTaskEvidence: evidence })
    } catch (error) {
      status.textContent = `${status.textContent} (evidence not saved: ${error.message})`
    } finally {
      stop.disabled = true
      await chrome.storage.local.remove("task").catch(() => undefined)
      download.disabled = !evidence?.finishedAt
    }
  })
})
