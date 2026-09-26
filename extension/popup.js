const goal = document.querySelector("#goal")
const model = document.querySelector("#model")
const decide = document.querySelector("#decide")
const status = document.querySelector("#status")

chrome.storage.local.get({ goal: "", model: model.value, lastTaskStatus: null }, (saved) => {
  goal.value = saved.goal
  model.value = saved.model
  if (saved.lastTaskStatus) status.textContent = saved.lastTaskStatus.message
})

decide.addEventListener("click", async () => {
  const taskGoal = goal.value.trim()
  if (!taskGoal) {
    status.textContent = "Enter a goal"
    return
  }
  decide.disabled = true
  status.textContent = "Checking page access…"
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const origins = ["<all_urls>"]
    const granted = await chrome.permissions.contains({ origins }) || await chrome.permissions.request({ origins })
  if (!granted) {
      status.textContent = "Page access is required to continue across navigation"
      decide.disabled = false
    return
  }
  status.textContent = "Opening the local model task…"
    const task = { id: crypto.randomUUID(), goal: taskGoal, modelId: model.value, tabId: tab.id, windowId: tab.windowId }
    await chrome.storage.local.set({ goal: taskGoal, model: model.value, task })
    await chrome.windows.create({ url: chrome.runtime.getURL("runner.html"), type: "popup", width: 380, height: 620, focused: true })
    status.textContent = "Continuous local task started"
  } catch (error) {
    status.textContent = error.message
    decide.disabled = false
  }
})
