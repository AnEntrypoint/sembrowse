const endpoint = document.querySelector("#endpoint")
const status = document.querySelector("#status")

chrome.storage.local.get({ endpoint: endpoint.value }, ({ endpoint: saved }) => {
  endpoint.value = saved
})

document.querySelector("#connect").addEventListener("click", async () => {
  const value = endpoint.value.replace(/\/$/, "")
  if (value !== "http://127.0.0.1:8787") {
    status.textContent = "This build permits only http://127.0.0.1:8787"
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
