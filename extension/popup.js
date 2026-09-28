const goal = document.querySelector("#goal")
const model = document.querySelector("#model")
const modelInfo = document.querySelector("#model-info")
const decide = document.querySelector("#decide")
const status = document.querySelector("#status")
const pageOrigins = ["<all_urls>"]
const modelProfiles = {
  "qwen3-0.6b": "Compact tier: 639 MB download. Best for smaller devices and quick local tasks.",
  "minicpm5-2b": "Desktop tier: 1.56 GB download. Reserve persistent storage and GPU memory before loading.",
  "qwen3.5-4b": "High-memory tier: 3.01 GB download. Reserve several gigabytes of browser storage and GPU memory before loading.",
  "minicpm-v-4.6": "Vision tier: ~1.6 GB download (model + mmproj). Sees a screenshot of the page alongside its text on every step, through the same local WebGPU runtime as every other model here."
}

const showModelInfo = () => {
  modelInfo.textContent = modelProfiles[model.value]
}

chrome.storage.local.get({ goal: "", model: model.value, lastTaskStatus: null }, (saved) => {
  goal.value = saved.goal
  model.value = saved.model
  showModelInfo()
  if (saved.lastTaskStatus) status.textContent = saved.lastTaskStatus.message
})

model.addEventListener("change", showModelInfo)

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
    const granted = await chrome.permissions.contains({ origins: pageOrigins }) || await chrome.permissions.request({ origins: pageOrigins })
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
