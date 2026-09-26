const goalOutput = document.querySelector("#goal")
const stop = document.querySelector("#stop")
const download = document.querySelector("#download")
const status = document.querySelector("#status")
const trace = document.querySelector("#trace")
const modelArtifacts = {
  "qwen3-0.6b": "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/23749fefcc72300e3a2ad315e1317431b06b590a/Qwen3-0.6B-Q8_0.gguf",
  "minicpm5-2b": "https://huggingface.co/openbmb/MiniCPM5-2B-GGUF/resolve/2079a22f3beaa4e306449978533478fe0522f4b3/MiniCPM5-2B-Q4_K_M.gguf",
  "qwen3.5-4b": "https://huggingface.co/bartowski/Qwen_Qwen3.5-4B-GGUF/resolve/4168f45a16a1290d65a4ec0fa312ae917a4c15d6/Qwen_Qwen3.5-4B-Q4_K_M.gguf"
}
const runtimeVersion = "wllama 3.6.1"
const worker = new Worker(`inference_worker.js?v=${chrome.runtime.getManifest().version}`, { type: "module" })
const pending = new Map()
let evidence = null
const setStatus = (message) => {
  status.textContent = message
  if (evidence) evidence.events.push({ type: "status", message, at: new Date().toISOString() })
  if (activeRun) {
    void chrome.storage.local.set({ lastTaskStatus: { message, updatedAt: Date.now() } })
  }
}
let resolveWorkerReady
let rejectWorkerReady
const workerReady = new Promise((resolve, reject) => {
  resolveWorkerReady = resolve
  rejectWorkerReady = reject
})
const workerReadyTimer = setTimeout(() => {
  const message = "Local model worker did not become ready"
  workerFailure = message
  rejectWorkerReady(new Error(message))
}, 30000)
let sequence = 0
let cancelled = false
let activeRun = ""
let workerFailure = ""
const pageOrigins = ["<all_urls>"]

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const timed = (promise, milliseconds, message) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), milliseconds))])
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
download.addEventListener("click", () => { void downloadEvidence() })
const request = async (type, payload = {}, timeout = 90000) => {
  if (workerFailure) return Promise.reject(new Error(workerFailure))
  await workerReady
  if (workerFailure) return Promise.reject(new Error(workerFailure))
  const id = String(++sequence)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Local model ${type} timed out`))
    }, timeout)
    pending.set(id, { resolve: (data) => { clearTimeout(timer); resolve(data) }, reject: (error) => { clearTimeout(timer); reject(error) } })
    worker.postMessage({ id, type, ...payload })
  })
}

const rejectPending = (message) => {
  workerFailure = message
  for (const [id, callback] of pending) {
    pending.delete(id)
    callback.reject(new Error(message))
  }
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
    return
  }
  const callback = pending.get(data.id)
  if (!callback) return
  pending.delete(data.id)
  data.error ? callback.reject(new Error(data.error)) : callback.resolve(data)
})

worker.addEventListener("error", (event) => {
  const message = event.error?.message || event.message || "Local model worker failed to start"
  clearTimeout(workerReadyTimer)
  workerFailure = message
  rejectWorkerReady(new Error(message))
  rejectPending(message)
  setStatus(message)
})

worker.addEventListener("messageerror", () => {
  const message = "Local model worker returned an unreadable response"
  clearTimeout(workerReadyTimer)
  workerFailure = message
  rejectWorkerReady(new Error(message))
  rejectPending(message)
  setStatus(message)
})

const snapshotFor = async (tabId, goal) => {
  await timed(chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }), 15000, "Page observation timed out")
  return timed(chrome.tabs.sendMessage(tabId, { type: "sembrowse-candidates", goal }), 15000, "Page observation was interrupted")
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

stop.addEventListener("click", () => {
  cancelled = true
  setStatus("Stopping after the current local model call…")
})

async function run(task) {
  activeRun = task.id
  evidence = {
    schemaVersion: 1,
    id: task.id,
    goal: task.goal,
    modelId: task.modelId,
    modelArtifact: modelArtifacts[task.modelId] || null,
    runtimeVersion,
    tabId: task.tabId,
    windowId: task.windowId,
    startedAt: new Date().toISOString(),
    events: []
  }
  download.disabled = true
  goalOutput.textContent = task.goal
  setStatus("Loading local model…")
  const loadedModel = await request("load", { modelId: task.modelId }, 600000)
  evidence.runtimeMode = loadedModel.runtimeMode
  let modelCalls = 0
  let unchanged = 0
  let previousState = ""
  let priorActionWasNonWait = false
  const history = []
  const navigationGoal = /\b(browse|go|navigate|open|visit)\b/i.test(task.goal)
  const authorGoal = /\bauthor+\b/i.test(task.goal)
  let initialPageUrl = ""
  let authorHandle = ""
  const canCompleteAt = (url) => {
    if (!navigationGoal || url === initialPageUrl) return false
    if (!authorGoal) return true
    try {
      const destination = new URL(url)
      return !!authorHandle && destination.hostname === "github.com" && destination.pathname === `/${authorHandle}`
    } catch {
      return false
    }
  }
  for (let step = 1; step <= 60 && !cancelled && activeRun === task.id; step += 1) {
    let snapshot
    try {
      setStatus("Observing the current page…")
      snapshot = await snapshotFor(task.tabId, task.goal)
    } catch (error) {
      if (!await hasPageAccess()) {
        setStatus("Page access was revoked; restart from the Sembrowse popup")
        return
      }
      const tab = await chrome.tabs.get(task.tabId).catch(() => null)
      if (!tab) {
        setStatus("Task tab was closed; task stopped")
        return
      }
      if (tab.status === "complete" && !isInjectablePage(tab)) {
        setStatus("Page does not allow extension access; task stopped")
        return
      }
      setStatus("Waiting for page navigation…")
      const loaded = await waitForTabComplete(task.tabId)
      if (!loaded) {
        setStatus("Page did not finish loading; task stopped")
        return
      }
      appendTrace(`${step}. page changed; re-observing`)
      continue
    }
    if (!snapshot || typeof snapshot !== "object") {
      appendTrace(`${step}. page response unavailable; re-observing`)
      priorActionWasNonWait = false
      continue
    }
    if (snapshot.error) {
      setStatus(snapshot.error)
      return
    }
    initialPageUrl ||= snapshot.state.url
    const stateKey = JSON.stringify({ url: snapshot.state.url, title: snapshot.state.title, text: snapshot.state.text, scroll: snapshot.state.scroll, candidates: snapshot.candidates.map(({ id, description, mode, options }) => ({ id, description, mode, options })) })
    unchanged = priorActionWasNonWait && stateKey === previousState ? unchanged + 1 : 0
    previousState = stateKey
    if (unchanged >= 3) {
      setStatus("Task blocked after three unchanged non-wait actions")
      return
    }
    if (modelCalls >= 120) {
      setStatus("Task stopped at the 120 local model-call limit")
      return
    }
    const candidateUrl = (candidate) => candidate.description.match(/https:\/\/\S+/)?.[0] || ""
    const githubPath = (candidate) => {
      try {
        const destination = new URL(candidateUrl(candidate))
        return destination.hostname === "github.com" ? destination.pathname.split("/").filter(Boolean) : []
      } catch {
        return []
      }
    }
    const profileCandidate = authorGoal && authorHandle && snapshot.candidates.find((candidate) => githubPath(candidate).join("/") === authorHandle)
    const repositoryCandidate = authorGoal && !authorHandle && new URL(snapshot.state.url).hostname !== "github.com" && snapshot.candidates.find((candidate) => githubPath(candidate).length >= 2)
    const clickCandidates = snapshot.candidates.filter((candidate) => candidate.mode === "CLICK")
    const singleClickGoal = /\b(click|browse|go|navigate|open|visit)\b/i.test(task.goal)
    let result
    if (canCompleteAt(snapshot.state.url)) result = { operation: "DONE", probability: 1, calls: 0, policy: authorGoal ? "author-profile-url" : "navigation-url-change" }
    else if (profileCandidate || repositoryCandidate) {
      const candidate = profileCandidate || repositoryCandidate
      result = { operation: candidate.mode, id: candidate.id, probability: 1, calls: 0, policy: "author-navigation" }
    } else if (singleClickGoal && clickCandidates.length === 1) {
      const candidate = clickCandidates[0]
      result = { operation: candidate.mode, id: candidate.id, probability: 1, calls: 0, policy: "single-visible-click" }
    } else {
      setStatus("Choosing the next local browser action…")
      let decisionElapsed = 0
      const decisionTimer = setInterval(() => {
        decisionElapsed += 5
        setStatus(`Choosing the next local browser action… (${decisionElapsed}s)`)
      }, 5000)
      try {
        result = await request("decide", { state: { ...snapshot.state, history }, goal: task.goal, candidates: snapshot.candidates, remainingCalls: 120 - modelCalls, allowDone: false }, 90000)
      } finally {
        clearInterval(decisionTimer)
      }
    }
    if (cancelled || activeRun !== task.id) return
    modelCalls += result.calls || 0
    if (result.policy) appendTrace(`${step}. ${result.policy}`)
    const selectedCandidate = snapshot.candidates.find((candidate) => candidate.id === result.id)
    if (selectedCandidate) appendTrace(`${step}. selected ${result.operation}: ${selectedCandidate.description}`)
    if (result.policy === "author-navigation" && selectedCandidate) {
      const path = githubPath(selectedCandidate)
      if (path.length >= 2) authorHandle = path[0]
    }
    if (result.operation === "DONE" && !canCompleteAt(snapshot.state.url)) {
      appendTrace(`${step}. rejected DONE: destination has not met the task completion check`)
      history.push("DONE rejected: the destination does not yet meet the task completion check")
      if (history.length > 6) history.shift()
      priorActionWasNonWait = false
      continue
    }
    if (result.operation === "DONE" || result.operation === "BLOCKED") {
      if (result.operation === "DONE") {
        evidence.completedUrl = snapshot.state.url
        evidence.completionVerified = true
        evidence.completionCheck = authorGoal ? "github-author-profile" : navigationGoal ? "navigation-url-change" : "model-completion"
      }
      appendTrace(`${step}. ${result.operation} (${(result.probability * 100).toFixed(0)}%)`)
      setStatus(result.operation === "DONE" ? "Task completed locally" : "Task blocked; review the visible page state")
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
    if (!executed || typeof executed !== "object") {
      appendTrace(`${step}. action triggered navigation; re-observing`)
      priorActionWasNonWait = false
      if (!await waitForTabComplete(task.tabId)) {
        setStatus("Page did not finish loading after the selected action")
        return
      }
      continue
    }
    if (executed.error) {
      if (/changed|interrupted/i.test(executed.error)) {
        appendTrace(`${step}. stale action discarded`)
        priorActionWasNonWait = false
        continue
      }
      setStatus(executed.error)
      return
    }
    if (executed.navigation) {
      let destination
      try {
        destination = new URL(executed.navigation)
      } catch {
        setStatus("Browser action returned an invalid navigation target")
        return
      }
      if (destination.protocol !== "https:" && destination.protocol !== "http:") {
        setStatus("Browser action returned an unsafe navigation target")
        return
      }
      if (authorGoal && authorHandle && destination.hostname === "github.com" && destination.pathname.split("/").filter(Boolean)[0] === authorHandle) {
        destination = new URL(`https://github.com/${authorHandle}`)
        appendTrace(`${step}. author profile destination: ${destination.href}`)
      }
      await chrome.tabs.update(task.tabId, { url: destination.href })
      if (!await waitForTabComplete(task.tabId)) {
        setStatus("Browser navigation did not complete")
        return
      }
    }
    history.push(`${result.operation}: ${executed.description}`)
    if (history.length > 6) history.shift()
    appendTrace(`${step}. ${result.operation}: ${executed.description} (${(result.probability * 100).toFixed(0)}%)`)
    priorActionWasNonWait = result.operation !== "WAIT"
    await settle(result.operation)
  }
  setStatus(cancelled ? "Task stopped" : "Task stopped after 60 actions")
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
