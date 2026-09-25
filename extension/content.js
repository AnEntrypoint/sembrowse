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
      readOnly: element.readOnly,
      role: element.getAttribute("role"),
      ariaLabel: element.getAttribute("aria-label"),
      ariaExpanded: element.getAttribute("aria-expanded"),
      ariaSelected: element.getAttribute("aria-selected"),
      ariaControls: element.getAttribute("aria-controls"),
      options: element.matches("select") ? Array.from(element.options).map((option) => [option.text, option.value, option.selected, option.disabled]) : undefined,
      form: form && { action: form.action, method: form.method, target: form.target, enctype: form.enctype, noValidate: form.noValidate }
    })
  }

  const modeFor = (element) => {
    if (element.matches("select")) return "SELECT"
    if (element.matches("textarea, [contenteditable=true], input:not([type]), input[type=text], input[type=search], input[type=email], input[type=tel], input[type=url], input[type=number]")) return "TYPE_TEXT"
    return "CLICK"
  }

  const choices = () => Array.from(document.querySelectorAll("button, a[href], input, textarea, select, [role=button], [role=combobox], [contenteditable=true]"))
    .filter((element) => !element.matches("input[type=hidden], input[type=file], input[type=password]"))
    .filter(visible)
    .slice(0, 16)
    .map((element, index) => ({
      id: String(index + 1),
      mode: modeFor(element),
      description: `${element.tagName.toLowerCase()}: ${(element.innerText || element.value || element.getAttribute("aria-label") || "unnamed").trim().slice(0, 48)}`,
      options: element.matches("select") ? Array.from(element.options).slice(0, 16).map((option, optionIndex) => ({ index: optionIndex, description: option.text.trim().slice(0, 48) })) : [],
      fingerprint: actionFingerprint(element),
      element
    }))

  chrome.runtime.onMessage.addListener((message, _, sendResponse) => {
    const candidates = choices()
    if (message.type === "sembrowse-candidates") {
      snapshot = { candidates, fingerprint: crypto.randomUUID() }
      sendResponse({
        candidates: candidates.map(({ id, mode, description, options }) => ({ id, mode, description, options })),
        state: { url: location.href, title: document.title, text: document.body.innerText.slice(0, 512), scroll: { top: scrollY, height: document.documentElement.scrollHeight, viewport: innerHeight } },
        fingerprint: snapshot.fingerprint
      })
      return
    }
    if (message.type === "sembrowse-execute") {
      if (snapshot?.fingerprint !== message.fingerprint) {
        sendResponse({ error: "The page changed before the local decision could run" })
        return
      }
      if (message.operation === "SCROLL_UP" || message.operation === "SCROLL_DOWN") {
        scrollBy({ top: message.operation === "SCROLL_UP" ? -innerHeight * 0.8 : innerHeight * 0.8, behavior: "instant" })
        sendResponse({ description: message.operation, changed: true })
        return
      }
      if (message.operation === "WAIT") {
        sendResponse({ description: "waiting", changed: true })
        return
      }
      const selected = snapshot.candidates.find(({ id }) => id === message.id)
      if (!selected || !selected.element.isConnected || !visible(selected.element)) {
        sendResponse({ error: "The page changed before the local decision could run" })
        return
      }
      const current = choices().find(({ element }) => element === selected.element)
      if (!current || current.description !== selected.description || current.fingerprint !== selected.fingerprint) {
        sendResponse({ error: "The selected action changed before execution" })
        return
      }
      if (selected.mode !== message.operation) {
        sendResponse({ error: "The selected operation is incompatible with the observed target" })
        return
      }
      if (message.operation === "TYPE_TEXT") {
        const value = String(message.text || "")
        if (selected.element.readOnly) {
          sendResponse({ error: "The selected field became read-only" })
          return
        }
        if (!value) {
          sendResponse({ error: "The local model did not produce text" })
          return
        }
        selected.element.focus()
        if (selected.element.isContentEditable) selected.element.textContent = value
        else selected.element.value = value
        selected.element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }))
        selected.element.dispatchEvent(new Event("change", { bubbles: true }))
        if ((selected.element.isContentEditable ? selected.element.textContent : selected.element.value) !== value) {
          sendResponse({ error: "The selected field did not retain the generated text" })
          return
        }
        sendResponse({ description: selected.description, changed: true })
        return
      }
      if (message.operation === "SELECT") {
        const option = selected.element.options?.[message.optionIndex]
        if (!option || option.disabled) {
          sendResponse({ error: "The local model selected an unavailable option" })
          return
        }
        selected.element.selectedIndex = message.optionIndex
        selected.element.dispatchEvent(new Event("input", { bubbles: true }))
        selected.element.dispatchEvent(new Event("change", { bubbles: true }))
        if (selected.element.selectedIndex !== message.optionIndex) {
          sendResponse({ error: "The selected option did not remain selected" })
          return
        }
        sendResponse({ description: `${selected.description}: ${option.text}`, changed: true })
        return
      }
      selected.element.click()
      sendResponse({ description: selected.description, changed: true })
    }
  })
}
