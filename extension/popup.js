const endpoint = document.querySelector("#endpoint")
const goal = document.querySelector("#goal")
const status = document.querySelector("#status")

chrome.storage.local.get({ endpoint: endpoint.value, goal: "" }, ({ endpoint: saved, goal: savedGoal }) => {
  endpoint.value = saved
  goal.value = savedGoal
})

document.querySelector("#connect").addEventListener("click", async () => {
  const value = endpoint.value.replace(/\/$/, "")
  if (!/^http:\/\/127\.0\.0\.1(?::\d{1,5})?$/.test(value)) {
    status.textContent = "Use an http://127.0.0.1 loopback endpoint"
    return
  }
  chrome.storage.local.set({ endpoint: value })
  status.textContent = "Checking local service…"
  try {
    const response = await fetch(`${value}/health`, { cache: "no-store" })
    const body = await response.json()
    status.textContent = response.ok ? `Ready: ${body.model.source}` : body.error
  } catch {
    status.textContent = "Local service is unavailable"
  }
})

document.querySelector("#decide").addEventListener("click", async () => {
  const value = endpoint.value.replace(/\/$/, "")
  const requestGoal = goal.value.trim()
  if (!/^http:\/\/127\.0\.0\.1(?::\d{1,5})?$/.test(value) || !requestGoal) {
    status.textContent = "Enter a goal and use the loopback endpoint"
    return
  }
  chrome.storage.local.set({ endpoint: value, goal: requestGoal })
  status.textContent = "Choosing one visible action…"
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] })
    const snapshot = await chrome.tabs.sendMessage(tab.id, { type: "sembrowse-candidates" })
    if (snapshot.error) throw new Error(snapshot.error)
    const criteria = Object.fromEntries(snapshot.candidates.map(({ id, description }) => [id, description]))
    const response = await fetch(`${value}/v1/choose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: snapshot.state,
        questions: { action: { criteria, instructions: { goal: requestGoal, rule: "Choose one visible action that advances the goal" } } }
      })
    })
    const body = await response.json()
    if (!body.answers?.action) throw new Error(body.error || "No local decision returned")
    const result = await chrome.tabs.sendMessage(tab.id, { type: "sembrowse-execute", id: body.answers.action.choice, fingerprint: snapshot.fingerprint })
    status.textContent = result.error || `Selected: ${result.description}`
  } catch {
    status.textContent = "The selected tab could not run a local decision"
  }
})
