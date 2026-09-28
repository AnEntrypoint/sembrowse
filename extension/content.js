if (!globalThis.__sembrowseLocalAttached) {
  globalThis.__sembrowseLocalAttached = true
  let snapshot

  const MAX_CANDIDATES = 20
  const LABEL_CHARS = 96
  const TEXT_CHARS = 1200
  const candidateSelector = "button, a[href], input, textarea, select, summary, [role=button], [role=link], [role=menuitem], [role=tab], [role=option], [role=checkbox], [role=switch], [role=combobox], [contenteditable=true]"
  const excludedInputSelector = "input[type=hidden], input[type=file], input[type=password]"
  const textEntrySelector = "textarea, [contenteditable=true], input:not([type]), input[type=text], input[type=search], input[type=email], input[type=tel], input[type=url], input[type=number]"

  const collapse = (text) => String(text ?? "").replace(/\s+/g, " ").trim()

  const cssVisible = (element) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    const clipped = (style.clipPath && style.clipPath !== "none") || (style.clip && style.clip !== "auto" && style.clip !== "none")
    return !element.disabled && style.display !== "none" && style.visibility === "visible" && Number(style.opacity) !== 0 && !clipped && rect.width > 0 && rect.height > 0
  }

  const onScreen = (rect) => !(rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth)

  const belowFold = (rect) => rect.width > 0 && rect.height > 0 && rect.top >= innerHeight && rect.left > -rect.width && rect.left < innerWidth

  const occluded = (element, rect) => {
    const x = Math.max(rect.left, 0) + Math.min(rect.width, innerWidth - Math.max(rect.left, 0)) / 2
    const y = Math.max(rect.top, 0) + Math.min(rect.height, innerHeight - Math.max(rect.top, 0)) / 2
    const top = document.elementFromPoint(x, y)
    return !(top === element || element.contains(top))
  }

  const visible = (element) => {
    if (!cssVisible(element)) return false
    const rect = element.getBoundingClientRect()
    return onScreen(rect) && !occluded(element, rect)
  }

  const placementOf = (element) => {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    const inView = onScreen(rect)
    if (!inView && !(element.matches("a[href]") && belowFold(rect))) return null
    if (!cssVisible(element)) return null
    if (!inView) return "scroll"
    return occluded(element, rect) ? null : "visible"
  }

  const viewportArea = (rect) => Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0)) * Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0))

  const isPasswordLike = (input) => {
    if (input.type === "password") return true
    if (/(?:^|\s)(?:current|new)-password(?:\s|$)/i.test(input.getAttribute("autocomplete") || "")) return true
    const ownSignal = [input.getAttribute("name"), input.getAttribute("id"), input.getAttribute("placeholder"), input.getAttribute("aria-label")].join(" ").toLowerCase()
    return /passcode|password|\bpwd\b|\bpin\b/.test(ownSignal)
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
    if (element.matches(textEntrySelector)) return "TYPE_TEXT"
    return "CLICK"
  }

  const rawLabel = (element) => {
    if (element.matches("select")) return element.getAttribute("aria-label") || element.selectedOptions[0]?.text
    return element.innerText || element.value || element.getAttribute("aria-label") || element.labels?.[0]?.innerText || element.getAttribute("placeholder") || element.getAttribute("title") || element.querySelector("img[alt]")?.alt || element.getAttribute("name")
  }

  const labelOf = (element) => collapse(rawLabel(element)).slice(0, LABEL_CHARS) || "unnamed"

  const keyOf = (element) => element.matches("a[href]")
    ? element.href
    : [element.tagName, element.getAttribute("type"), element.getAttribute("name"), element.id, labelOf(element)].join("|")

  const describeCandidate = (element, index) => ({
    id: String(index + 1),
    mode: modeFor(element),
    description: `${element.tagName.toLowerCase()}: ${labelOf(element)}${element.matches("a[href]") ? ` ${element.href}` : ""}`,
    key: keyOf(element),
    options: element.matches("select") ? Array.from(element.options).slice(0, 16).map((option, optionIndex) => ({ index: optionIndex, description: collapse(option.text).slice(0, 48) })) : [],
    fingerprint: actionFingerprint(element),
    element
  })

  const collectCandidates = () => {
    const pool = Array.from(document.querySelectorAll(candidateSelector))
      .filter((element) => !element.matches(excludedInputSelector) && !(element.tagName === "INPUT" && isPasswordLike(element)))
    const inViewport = []
    const needsScroll = []
    for (const element of pool) {
      const placement = placementOf(element)
      if (placement === "visible") {
        const rect = element.getBoundingClientRect()
        inViewport.push({ element, area: viewportArea(rect), top: rect.top, left: rect.left })
      } else if (placement === "scroll") needsScroll.push(element)
    }
    const shown = inViewport
      .sort((left, right) => right.area - left.area)
      .slice(0, MAX_CANDIDATES)
      .sort((left, right) => left.top - right.top || left.left - right.left)
      .map(({ element }) => element)
    return [...shown, ...needsScroll].slice(0, MAX_CANDIDATES).map(describeCandidate)
  }

  const visibleText = () => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT
        const parent = node.parentElement
        if (!parent) return NodeFilter.FILTER_REJECT
        const style = getComputedStyle(parent)
        if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) return NodeFilter.FILTER_REJECT
        const rect = parent.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0 || !onScreen(rect)) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      }
    })
    let text = ""
    while (text.length < TEXT_CHARS * 1.5 && walker.nextNode()) text += `${collapse(walker.currentNode.nodeValue)} `
    return (collapse(text) || collapse(document.body.innerText)).slice(0, TEXT_CHARS)
  }

  const pressEnter = (element) => {
    const init = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }
    const keydownAccepted = element.dispatchEvent(new KeyboardEvent("keydown", init))
    const keypressAccepted = element.dispatchEvent(new KeyboardEvent("keypress", init))
    element.dispatchEvent(new KeyboardEvent("keyup", init))
    if (keydownAccepted && keypressAccepted) element.form?.requestSubmit?.()
  }

  const typeInto = (element, value, submit) => {
    if (element.readOnly) return { error: "The selected field became read-only" }
    if (!value) return { error: "The local model did not produce text" }
    element.focus()
    if (element.isContentEditable) element.textContent = value
    else element.value = value
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }))
    element.dispatchEvent(new Event("change", { bubbles: true }))
    if ((element.isContentEditable ? element.textContent : element.value) !== value) return { error: "The selected field did not retain the generated text" }
    if (submit) pressEnter(element)
    return { changed: true }
  }

  const chooseOption = (element, optionIndex) => {
    const option = element.options?.[optionIndex]
    if (!option || option.disabled) return { error: "The local model selected an unavailable option" }
    element.selectedIndex = optionIndex
    element.dispatchEvent(new Event("input", { bubbles: true }))
    element.dispatchEvent(new Event("change", { bubbles: true }))
    if (element.selectedIndex !== optionIndex) return { error: "The selected option did not remain selected" }
    return { changed: true, suffix: `: ${option.text}` }
  }

  const execute = (message) => {
    if (snapshot?.fingerprint !== message.fingerprint) return { error: "The page changed before the local decision could run" }
    if (message.operation === "SCROLL_UP" || message.operation === "SCROLL_DOWN") {
      scrollBy({ top: message.operation === "SCROLL_UP" ? -innerHeight * 0.8 : innerHeight * 0.8, behavior: "instant" })
      return { description: message.operation, changed: true }
    }
    if (message.operation === "WAIT") return { description: "waiting", changed: true }
    const selected = snapshot.candidates.find(({ id }) => id === message.id)
    if (!selected || !selected.element.isConnected || placementOf(selected.element) === null) return { error: "The page changed before the local decision could run" }
    const current = describeCandidate(selected.element, 0)
    if (current.description !== selected.description || current.fingerprint !== selected.fingerprint) return { error: "The selected action changed before execution" }
    if (selected.mode !== message.operation) return { error: "The selected operation is incompatible with the observed target" }
    if (message.operation === "TYPE_TEXT") {
      const typed = typeInto(selected.element, String(message.text || ""), message.submit === true)
      return typed.error ? typed : { description: selected.description, changed: true }
    }
    if (message.operation === "SELECT") {
      const chosen = chooseOption(selected.element, message.optionIndex)
      return chosen.error ? chosen : { description: `${selected.description}${chosen.suffix}`, changed: true }
    }
    selected.element.scrollIntoView({ block: "center", inline: "nearest" })
    if (selected.element.matches("a[href]")) {
      const destination = new URL(selected.element.href, location.href)
      if (destination.protocol === "https:" || destination.protocol === "http:") return { description: selected.description, changed: true, navigation: destination.href }
    }
    selected.element.click()
    return { description: selected.description, changed: true }
  }

  chrome.runtime.onMessage.addListener((message, _, sendResponse) => {
    if (message.type === "sembrowse-candidates") {
      const candidates = collectCandidates()
      snapshot = { candidates, fingerprint: crypto.randomUUID() }
      sendResponse({
        candidates: candidates.map(({ id, mode, description, key, options }) => ({ id, mode, description, key, options })),
        state: { url: location.href, title: document.title, text: visibleText(), scroll: { top: scrollY, height: document.documentElement.scrollHeight, viewport: innerHeight } },
        fingerprint: snapshot.fingerprint
      })
      return
    }
    if (message.type === "sembrowse-execute") {
      try {
        sendResponse(execute(message))
      } catch (error) {
        sendResponse({ error: error?.message ?? String(error) })
      }
    }
  })
}
