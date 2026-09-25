if (!globalThis.__sembrowseLocalAttached) {
  globalThis.__sembrowseLocalAttached = true
  let snapshot

  const visible = (element) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    if (element.disabled || style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) return false
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return false
    const x = Math.max(rect.left, 0) + Math.min(rect.width, innerWidth - Math.max(rect.left, 0)) / 2
    const y = Math.max(rect.top, 0) + Math.min(rect.height, innerHeight - Math.max(rect.top, 0)) / 2
    const top = document.elementFromPoint(x, y)
    return top === element || element.contains(top)
  }

  const actionFingerprint = (element) => {
    const form = element.form
    return JSON.stringify({
      tag: element.tagName,
      href: element.getAttribute("href"),
      action: element.getAttribute("formaction"),
      method: element.getAttribute("formmethod"),
      target: element.getAttribute("formtarget") || element.getAttribute("target"),
      type: element.getAttribute("type"),
      value: element.getAttribute("value"),
      onclick: String(element.onclick),
      disabled: element.disabled,
      form: form && { action: form.action, method: form.method, target: form.target, enctype: form.enctype, noValidate: form.noValidate }
    })
  }

  const choices = () => Array.from(document.querySelectorAll("button, a[href], input[type=button], input[type=submit]"))
    .filter(visible)
    .slice(0, 32)
    .map((element, index) => ({
      id: String(index + 1),
      description: `${element.tagName.toLowerCase()}: ${(element.innerText || element.value || element.getAttribute("aria-label") || "unnamed").trim().slice(0, 48)}`,
      fingerprint: actionFingerprint(element),
      element
    }))

  chrome.runtime.onMessage.addListener((message, _, sendResponse) => {
    const candidates = choices()
    if (message.type === "sembrowse-candidates" && candidates.length < 2) {
      sendResponse({ error: "This page has fewer than two visible clickable actions" })
      return
    }
    if (message.type === "sembrowse-candidates") {
      snapshot = { candidates, fingerprint: crypto.randomUUID() }
      sendResponse({
        candidates: candidates.map(({ id, description }) => ({ id, description })),
        state: { url: location.href, title: document.title, text: document.body.innerText.slice(0, 512) },
        fingerprint: snapshot.fingerprint
      })
      return
    }
    if (message.type === "sembrowse-execute") {
      const selected = snapshot?.fingerprint === message.fingerprint && snapshot.candidates.find(({ id }) => id === message.id)
      if (!selected || !selected.element.isConnected || !visible(selected.element)) {
        sendResponse({ error: "The page changed before the local decision could run" })
        return
      }
      const current = choices().find(({ element }) => element === selected.element)
      if (!current || current.description !== selected.description || current.fingerprint !== selected.fingerprint) {
        sendResponse({ error: "The selected action changed before execution" })
        return
      }
      sendResponse({ description: selected.description })
      selected.element.click()
    }
  })
}
