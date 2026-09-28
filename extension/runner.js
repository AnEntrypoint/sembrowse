const goalOutput = document.querySelector("#goal")
const stop = document.querySelector("#stop")
const download = document.querySelector("#download")
const status = document.querySelector("#status")
const trace = document.querySelector("#trace")
const modelArtifacts = {
  "qwen3-0.6b": "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/23749fefcc72300e3a2ad315e1317431b06b590a/Qwen3-0.6B-Q8_0.gguf",
  "minicpm5-2b": "https://huggingface.co/openbmb/MiniCPM5-2B-GGUF/resolve/2079a22f3beaa4e306449978533478fe0522f4b3/MiniCPM5-2B-Q4_K_M.gguf",
  "qwen3.5-4b": "https://huggingface.co/bartowski/Qwen_Qwen3.5-4B-GGUF/resolve/4168f45a16a1290d65a4ec0fa312ae917a4c15d6/Qwen_Qwen3.5-4B-Q4_K_M.gguf",
  "minicpm-v-4.6": "https://huggingface.co/openbmb/MiniCPM-V-4.6-gguf/resolve/afe9accb78d2995d214cd912920c9c92f4015faa/MiniCPM-V-4_6-Q4_K_M.gguf"
}
// Only these models were loaded with an mmproj alongside their GGUF
// (inference_worker.js's `visionCapable` flag) -- capturing a screenshot on
// every step for a text-only model would just be wasted work, since nothing
// in that model's runtime path ever reads it.
const visionModelIds = new Set(["minicpm-v-4.6"])
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
    let timer
    // A model download can run well past any FLAT overall deadline on a
    // slow connection -- verified live: a ~1.6GB model at ~830 KB/s needs
    // roughly half an hour, well past this call's old fixed 600000ms
    // budget, even though it was making perfectly healthy progress every
    // single second the whole time ("Local model load timed out" fired at
    // 25% with the download still actively advancing). Restarting the
    // clock on every progress event turns this into a STALL timeout
    // instead of a wall-clock one, so it only ever fires when the worker
    // has genuinely stopped making progress, never on a slow-but-steady
    // download of any size.
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        pending.delete(id)
        const message = `Local model ${type} timed out`
        // A stuck WebGPU/WASM completion call can block the worker's own
        // event loop synchronously, so a same-thread timer (inference_worker.js's
        // own completionTimeout) can never preempt it -- the timer callback
        // needs a free event loop to fire, and a blocked worker has none.
        // Worker.terminate() is a browser-level operation that stops the
        // thread regardless of what it is doing, so it is the only thing
        // that actually enforces this timeout rather than just declaring
        // the task failed while the stuck worker keeps burning GPU/CPU
        // unseen in the background.
        worker.terminate()
        workerFailure = message
        reject(new Error(message))
      }, timeout)
    }
    arm()
    pending.set(id, { resolve: (data) => { clearTimeout(timer); resolve(data) }, reject: (error) => { clearTimeout(timer); reject(error) }, arm })
    // See inference_worker.js's `send` for why this is `reqId`, not `id`:
    // `payload` (a "decide" call's candidates/state) must never be able to
    // collide with the request-correlation id.
    worker.postMessage({ ...payload, type, reqId: id })
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
    // Only a genuine stage change (`real: true` -- a new download
    // percentage, a new named stage) counts as proof of progress and resets
    // the stall timer -- inference_worker.js's own elapsed-time heartbeat
    // (`real: false`) fires every 15s purely to keep the visible status
    // line's counter ticking, whether or not the operation it's attached to
    // is actually still moving, so treating THAT as proof of life would let
    // a genuinely dead download (server dropped the connection, zero bytes
    // arriving) spin forever showing an ever-increasing elapsed count and
    // never time out.
    if (data.real) for (const callback of pending.values()) callback.arm?.()
    return
  }
  const callback = pending.get(data.reqId)
  if (!callback) return
  pending.delete(data.reqId)
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

const snapshotFor = async (tabId, goal, windowId, needsScreenshot) => {
  await timed(chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }), 15000, "Page observation timed out")
  const [response, screenshot] = await Promise.all([
    timed(chrome.tabs.sendMessage(tabId, { type: "sembrowse-candidates", goal }), 15000, "Page observation was interrupted"),
    // A capture failure (e.g. a chrome:// tab, or a capture mid-navigation)
    // should not fail the whole page observation itself -- decide() already
    // reports "needs a page screenshot for this step" as an ordinary result
    // error when state.screenshot ends up missing (this model has no
    // text-only path to fall back to; verified live, its processor crashes
    // without an image), so the step fails cleanly through the existing
    // error-handling path instead of throwing here.
    // MiniCPM-V-4.6's SigLIP2 encoder slices the screenshot into up to 9
    // tiles at 448px scale, 14x14-patch encoded (sourced live: OpenBMB's own
    // MiniCPM-V architecture docs) -- tile COUNT depends on the image's
    // pixel dimensions, which this capture doesn't control and the model's
    // own adaptive slicer already handles regardless of size, but JPEG
    // compression artifacts within each tile are squarely this capture's own
    // choice, and directly threaten legibility of small on-page text (a
    // price, in particular) that quality:70 was never re-examined against
    // when the vision model swapped. Bumped for a genuine quality reason,
    // not a guess -- the extra bytes cost a one-time local base64 decode,
    // never additional model-token budget (that's driven by pixel
    // dimensions/slicing, not compression level).
    needsScreenshot ? chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 92 }).catch(() => null) : Promise.resolve(null)
  ])
  if (screenshot) response.state.screenshot = screenshot
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
    extensionVersion: chrome.runtime.getManifest().version,
    tabId: task.tabId,
    windowId: task.windowId,
    startedAt: new Date().toISOString(),
    events: []
  }
  download.disabled = true
  goalOutput.textContent = task.goal
  const navigationGoal = /\b(browse|go|navigate|open|visit)\b/i.test(task.goal)
  const authorGoal = /\bauthor+\b/i.test(task.goal)
  let initialPageUrl = ""
  let authorHandle = ""
  const canCompleteAt = (url) => {
    if (!navigationGoal || url === initialPageUrl) return false
    if (!authorGoal) return true
    try {
      const destination = new URL(url)
      return !!authorHandle && destination.hostname.toLowerCase() === "github.com" && destination.pathname.replace(/\/+$/, "").toLowerCase() === `/${authorHandle.toLowerCase()}`
    } catch {
      return false
    }
  }
  const initialTab = await chrome.tabs.get(task.tabId).catch(() => null)
  if (authorGoal && initialTab) {
    const initialUrl = initialTab.pendingUrl || initialTab.url
    const directAuthor = (() => {
      try {
        const page = new URL(initialUrl)
        const githubPagesAuthor = page.hostname.match(/^([a-z0-9-]+)\.github\.io$/i)?.[1]?.toLowerCase()
        if (githubPagesAuthor) return { handle: githubPagesAuthor, source: "github-pages-author" }
        const githubPath = page.hostname.toLowerCase() === "github.com" ? page.pathname.split("/").filter(Boolean) : []
        if (githubPath.length >= 2) return { handle: githubPath[0].toLowerCase(), source: "github-repository-author" }
      } catch {
        return null
      }
      return null
    })()
    if (directAuthor) {
      initialPageUrl = initialUrl
      authorHandle = directAuthor.handle
      evidence.observedUrl = initialPageUrl
      evidence.executionMode = "deterministic-local-route"
      appendTrace(`1. ${directAuthor.source}: ${authorHandle}`)
      setStatus("Opening the author’s GitHub profile…")
      await chrome.tabs.update(task.tabId, { url: `https://github.com/${authorHandle}` })
      if (!await waitForTabComplete(task.tabId)) {
        setStatus("Author profile did not finish loading")
        return
      }
      const destination = await chrome.tabs.get(task.tabId).catch(() => null)
      if (destination && canCompleteAt(destination.url)) {
        evidence.completedUrl = destination.url
        evidence.completionVerified = true
        evidence.completionCheck = "github-author-profile"
        appendTrace("2. author-profile-url")
        appendTrace("2. DONE (100%)")
        setStatus("Task completed locally")
        return
      }
    }
  }
  setStatus("Loading local model…")
  // Short now that request() resets this on every REAL progress tick
  // instead of enforcing one flat deadline -- this only ever has to cover a
  // genuine stall between download percentage ticks, not the whole
  // download, so it no longer needs to scale with model size at all. 3
  // minutes gives real (if very slow) progress comfortable room while still
  // catching a genuinely dead connection well before a person would give up
  // watching it.
  const loadedModel = await request("load", { modelId: task.modelId }, 180000)
  evidence.runtimeMode = loadedModel.runtimeMode
  let modelCalls = 0
  let unchanged = 0
  let previousState = ""
  let priorActionWasNonWait = false
  let lastDeadEndKey = ""
  // A candidate whose click produces literally no observable change (a real,
  // visible <a href> intercepted by its own JS -- verified live: Amazon's
  // "why am I seeing this ad" sponsored-placement widget renders as a normal
  // product link but swallows the click into a feedback popover instead of
  // navigating) is a dead end, not merely unlucky -- re-offering it lets the
  // model reselect the same broken link every single step until the blanket
  // 3-strikes abort below fires, even though a dozen other genuine candidates
  // sit right next to it. Exclude it as soon as it demonstrates this, so the
  // model is only ever offered candidates that have not already been proven
  // dead this run.
  //
  // Keyed on the href inside the candidate's own description (falling back
  // to the full description for non-anchor candidates), never on its action
  // fingerprint -- verified live that exact widget also flips its own
  // aria-expanded between clicks, which changes the fingerprint every other
  // observation and made a fingerprint-keyed exclusion never actually match
  // the same link twice in a row. The href stays byte-identical regardless.
  //
  // Triggered by picking the SAME key two decisions in a row, never by the
  // surrounding page state being byte-identical -- verified live on the real
  // Amazon page that a dead click can still get re-selected two and three
  // times running even though this exclusion was already wired, because a
  // busy commercial page (rotating recommendation carousels, lazy-loaded
  // widgets, tracking pixels) rarely reproduces an EXACT match on the full
  // state key even when nothing that matters changed, so the unchanged-state
  // condition the exclusion originally rode on almost never actually fires
  // there. Repeating the identical selection needs no such coincidence.
  const deadEndKey = (candidate) => candidate.description.match(/https?:\/\/\S+/i)?.[0] || candidate.description
  const deadEnds = new Set()
  const history = []
  for (let step = 1; step <= 60 && !cancelled && activeRun === task.id; step += 1) {
    let snapshot
    try {
      setStatus("Observing the current page…")
      snapshot = await snapshotFor(task.tabId, task.goal, task.windowId, visionModelIds.has(task.modelId))
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
    evidence.observedUrl = snapshot.state.url
    const stateKey = JSON.stringify({ url: snapshot.state.url, title: snapshot.state.title, text: snapshot.state.text, scroll: snapshot.state.scroll, candidates: snapshot.candidates.map(({ id, description, mode, options }) => ({ id, description, mode, options })) })
    const wasUnchanged = priorActionWasNonWait && stateKey === previousState
    unchanged = wasUnchanged ? unchanged + 1 : 0
    previousState = stateKey
    if (unchanged >= 3) {
      setStatus("Task blocked after three unchanged non-wait actions")
      return
    }
    if (modelCalls >= 120) {
      setStatus("Task stopped at the 120 local model-call limit")
      return
    }
    const liveCandidates = deadEnds.size ? snapshot.candidates.filter((candidate) => !deadEnds.has(deadEndKey(candidate))) : snapshot.candidates
    const githubPath = (candidate) => {
      try {
        const destination = new URL(deadEndKey(candidate))
        return destination.hostname.toLowerCase() === "github.com" ? destination.pathname.split("/").filter(Boolean) : []
      } catch {
        return []
      }
    }
    const profileCandidate = authorGoal && authorHandle && liveCandidates.find((candidate) => githubPath(candidate).map((part) => part.toLowerCase()).join("/") === authorHandle.toLowerCase())
    const repositoryCandidate = authorGoal && !authorHandle && new URL(snapshot.state.url).hostname !== "github.com" && liveCandidates.find((candidate) => githubPath(candidate).length >= 2)
    const clickCandidates = liveCandidates.filter((candidate) => candidate.mode === "CLICK")
    const singleClickGoal = /\b(click|browse|go|navigate|open|visit)\b/i.test(task.goal)
    let githubPagesAuthor = ""
    if (authorGoal && !authorHandle) {
      try {
        githubPagesAuthor = new URL(snapshot.state.url).hostname.match(/^([a-z0-9-]+)\.github\.io$/i)?.[1]?.toLowerCase() || ""
      } catch {}
    }
    const githubLinkedAuthor = authorGoal && !authorHandle && Array.isArray(snapshot.state.githubAccounts) && snapshot.state.githubAccounts.length === 1 ? snapshot.state.githubAccounts[0] : ""
    const resolvedAuthor = githubPagesAuthor || githubLinkedAuthor
    if (resolvedAuthor) {
      authorHandle = resolvedAuthor
      appendTrace(`${step}. ${githubPagesAuthor ? "github-pages-author" : "github-linked-author"}: ${authorHandle}`)
      setStatus("Opening the author’s GitHub profile…")
      await chrome.tabs.update(task.tabId, { url: `https://github.com/${authorHandle}` })
      if (!await waitForTabComplete(task.tabId)) {
        setStatus("Author profile did not finish loading")
        return
      }
      priorActionWasNonWait = true
      continue
    }
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
        // Must stay comfortably above inference_worker.js's own
        // COMPLETION_TIMEOUT_MS (the inner per-completion budget) times the
        // worst case of two sequential completions in one decide() call (a
        // SELECT: choose the field, then choose its option) -- this used to
        // be the same 20000ms as that inner constant, so it always raced and
        // won BEFORE the inner timeout ever got a chance to fire on its own,
        // killing a genuinely still-working (if slow) vision-model decision
        // outright instead of ever surfacing the inner timeout's own error.
        result = await request("decide", { state: { ...snapshot.state, history }, goal: task.goal, candidates: liveCandidates, remainingCalls: 120 - modelCalls }, 150000)
      } catch (error) {
        // A worker-side { error } payload rejects this promise (see the
        // message-response dispatcher above) rather than resolving with an
        // `.error` field, unlike every other result branch here -- a comment
        // in snapshotFor() claims a screenshot-capture failure "fails
        // cleanly through the existing error-handling path", but verified
        // live that instead propagates all the way out of run()'s loop and
        // ends the whole task on what chrome.tabs.captureVisibleTab's own
        // MDN docs describe as an ordinary, transient, retryable condition
        // (mid-navigation, or the extension's per-second capture quota).
        // Re-observing costs one step; ending the entire task over a single
        // dropped screenshot does not match "transient".
        if (/needs a page screenshot/i.test(error.message)) {
          appendTrace(`${step}. screenshot capture failed; re-observing`)
          priorActionWasNonWait = false
          continue
        }
        throw error
      } finally {
        clearInterval(decisionTimer)
      }
    }
    if (cancelled || activeRun !== task.id) return
    modelCalls += result.calls || 0
    if (result.policy) appendTrace(`${step}. ${result.policy}`)
    const selectedCandidate = snapshot.candidates.find((candidate) => candidate.id === result.id)
    const selectedKey = selectedCandidate ? deadEndKey(selectedCandidate) : ""
    if (selectedKey && selectedKey === lastDeadEndKey) deadEnds.add(selectedKey)
    lastDeadEndKey = selectedKey
    if (selectedCandidate) appendTrace(`${step}. selected ${result.operation}: ${selectedCandidate.description}`)
    if (result.policy === "author-navigation" && selectedCandidate) {
      const path = githubPath(selectedCandidate)
      if (path.length >= 2) authorHandle = path[0]
    }
    if (result.operation === "NAVIGATE_URL") {
      let destination
      try {
        destination = new URL(result.url)
      } catch {
        setStatus("Local model returned an invalid navigation target")
        return
      }
      if (destination.protocol !== "https:" && destination.protocol !== "http:") {
        setStatus("Local model returned an unsafe navigation target")
        return
      }
      appendTrace(`${step}. navigate-url: ${destination.href}`)
      await chrome.tabs.update(task.tabId, { url: destination.href })
      if (!await waitForTabComplete(task.tabId)) {
        setStatus("Browser navigation did not complete")
        return
      }
      history.push(`NAVIGATE_URL: ${destination.href}`)
      if (history.length > 6) history.shift()
      priorActionWasNonWait = true
      continue
    }
    if (navigationGoal && result.operation === "DONE" && !canCompleteAt(snapshot.state.url)) {
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
      // `result` (the worker's decision) carries its own `type: "decision"`
      // field -- spreading it after the initial `type: "sembrowse-execute"`
      // silently overwrote that back to "decision" every time, so
      // content.js's `message.type === "sembrowse-execute"` check never
      // matched, sendResponse was never called, and every execute call
      // resolved `undefined` regardless of site or operation (verified
      // live: 100% of CLICK/TYPE_TEXT actions across every run). Exact same
      // object-spread-collision bug class as inference_worker.js's `send()`
      // (fixed via `reqId`), just the mirror-image direction here.
      executed = await timed(chrome.tabs.sendMessage(task.tabId, { fingerprint: snapshot.fingerprint, ...result, type: "sembrowse-execute" }), 15000, "Action receiver was interrupted")
    } catch (error) {
      appendTrace(`${step}. stale action discarded: ${error.message}`)
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
