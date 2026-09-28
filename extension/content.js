if (!globalThis.__sembrowseLocalAttached) {
  globalThis.__sembrowseLocalAttached = true
  let snapshot

  const cssVisible = (element) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    // The standard "screen-reader-only" pattern (Amazon's own keyboard
    // skip-links -- "Search alt+/", "Cart shift+alt+C" -- are real
    // examples, verified live) clips the element visually via `clip` /
    // `clip-path` while leaving its LAYOUT BOX at full natural size, so
    // getBoundingClientRect() keeps reporting real, plausible dimensions --
    // a naive size-only check (the previous attempt here) never catches
    // it, because nothing about the size actually looks wrong. `clip` and
    // `clip-path` are the two CSS properties this specific hiding
    // technique depends on, so check those directly instead of guessing
    // from geometry.
    const clipped = (style.clipPath && style.clipPath !== "none") || (style.clip && style.clip !== "auto" && style.clip !== "none")
    return !element.disabled && style.display !== "none" && style.visibility === "visible" && Number(style.opacity) !== 0 && !clipped && rect.width > 0 && rect.height > 0
  }

  const onScreen = (rect) => !(rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth)

  // Purely "below the fold" (positive top, still within normal horizontal
  // bounds) -- scrollIntoView reveals a real link like this as-is. Negative
  // top/left is a different thing entirely: the classic keyboard skip-link
  // pattern (verified live -- Amazon's "Search alt+/", "Cart shift+alt+C")
  // permanently parks the element off in negative-coordinate space and only
  // moves it on screen on :focus, so scrolling toward it does not reveal a
  // usable control at all. Only the former should ever count as "just
  // needs scrolling".
  const belowFold = (rect) => rect.width > 0 && rect.height > 0 && rect.top >= innerHeight && rect.left > -rect.width && rect.left < innerWidth
  // A mirrored aboveFold() (content scrolled PAST, negative top, meant to
  // stay selectable the way belowFold does) was tried and reverted: the only
  // cheap way to tell it apart from the skip-link pattern was a
  // document-position guess (skip-links sit near DOM-top), and two
  // independent adversarial reviews confirmed live that guess misfires both
  // ways -- it wrongly excludes ordinary header/nav links (which also sit
  // near DOM-top) and wrongly re-admits a skip-link on any page with a
  // banner/promo strip pushing it past the threshold, reintroducing the
  // exact invisible-control bug this exclusion exists to prevent. Excluding
  // ALL negative-top elements is the safe default until there's a real
  // (e.g. focus-behavior-based) test for this, not a positional guess: a
  // false negative here costs some candidate recall, a false positive costs
  // a wasted or broken action.

  // Distinct from being merely off-screen (which scrollIntoView fixes): an
  // on-screen element with something else on top of it at its own visual
  // center -- a modal, a cookie banner, a sticky header -- is genuinely not
  // interactable right now no matter how "visible" its CSS says it is.
  const occluded = (element, rect) => {
    const x = Math.max(rect.left, 0) + Math.min(rect.width, innerWidth - Math.max(rect.left, 0)) / 2
    const y = Math.max(rect.top, 0) + Math.min(rect.height, innerHeight - Math.max(rect.top, 0)) / 2
    const top = document.elementFromPoint(x, y)
    return !(top === element || element.contains(top))
  }

  const visible = (element) => {
    if (!cssVisible(element)) return false
    const rect = element.getBoundingClientRect()
    if (!onScreen(rect)) return false
    return !occluded(element, rect)
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

  // A "+2 other colors/patterns"-style link (verified live on Amazon
  // search results) picks a different variant of the SAME item rather
  // than navigating to a distinct one -- never useful for a goal like
  // "find the cheapest X", and not distinguishable from a genuine product
  // link by price (this one carried no nearby price at all) or by mode
  // (it's a real, real-navigating <a href>). The only reliable signal is
  // its own label text.
  const isVariantExpander = (element) => /\bother\s+(colors?|patterns?|styles?|sizes?|options?)\b/i.test((element.innerText || element.textContent || "").trim())

  const selectable = (element) => {
    if (isVariantExpander(element)) return false
    if (visible(element)) return true
    if (!element.matches("a[href]")) return false
    if (!cssVisible(element)) return false
    const rect = element.getBoundingClientRect()
    // A real <a href> that merely needs scrollIntoView (below the fold) is
    // a fine candidate. Two other things that make visible() reject it are
    // not: on-screen but covered by something
    // else (a modal, an overlay -- scrolling never fixes that), and parked
    // off in negative-coordinate space by the keyboard skip-link pattern
    // (verified live: Amazon's "Search alt+/", "Cart shift+alt+C" -- these
    // move on screen only on :focus, so scrolling toward them reveals
    // nothing usable either).
    if (onScreen(rect) && occluded(element, rect)) return false
    if (!onScreen(rect) && !belowFold(rect)) return false
    return true
  }

  const relevance = (element, goal) => {
    const terms = String(goal || "").toLowerCase().match(/[a-z0-9]{3,}/g) || []
    const text = [element.textContent, element.getAttribute("aria-label"), element.getAttribute("title"), element.href].join(" ").toLowerCase()
    const navigationGoal = /\b(browse|go|navigate|open|visit)\b/.test(String(goal || "").toLowerCase())
    return terms.reduce((score, term) => score + (new RegExp(`\\b${term}\\b`).test(text) ? 1 : 0), 0) + (navigationGoal && element.matches("a[href]") ? 1 : 0)
  }

  const sample = (elements) => elements.length <= 16 ? elements : [...elements.slice(0, 12), ...elements.filter((element) => element.matches("a[href]")).slice(-4).filter((element) => !elements.slice(0, 12).includes(element))]

  // "Send visible text. Offscreen article bodies and footers do not fill
  // the model context" -- document.body.innerText pulls the whole page in
  // DOM order regardless of what's actually on screen, so a hidden nav
  // drawer, a long footer, or (concretely) a blocking modal's own message
  // could all be pushed out of the 512-char budget by boilerplate the user
  // never sees, starving the model of the one thing that actually explains
  // why nothing else on the page seems to work right now.
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
    let out = ""
    while (out.length < 1024 && walker.nextNode()) out += `${walker.currentNode.nodeValue.trim()} `
    out = out.trim()
    return out ? out.slice(0, 512) : document.body.innerText.slice(0, 512)
  }

  // A single-line <input> that's either explicitly type=search, carries an
  // explicit search signal, or is the only text-like field in a form with
  // no password field, submits on Enter by convention -- that's what a real
  // user does after typing a search query, and treating "type" and "submit"
  // as two independent decisions is exactly the kind of two-step plan a
  // small local model unreliably follows through on. Deliberately
  // <input>-only (never textarea/contenteditable): a multi-line field's
  // Enter conventionally means "newline", not "submit". A plain "only text
  // field in the form" rule with no other check also matched a single-field
  // login form, silently submitting a bare username with no password the
  // moment the model typed text into it -- excluding any form with a
  // password field closes that specific, high-severity case while keeping
  // this working for real search boxes that don't happen to mention
  // "search" anywhere in their own attributes (e.g. name="q" with no
  // placeholder or aria-label), which a stricter search-signal-only rule
  // would otherwise miss. A coupon or newsletter form (no password field,
  // no search signal) can still false-positive here; that residual risk is
  // a single wasted submit, not a credential leak.
  const isSearchLikeInput = (element) => {
    if (element.tagName !== "INPUT") return false
    if (element.type === "search") return true
    const ownSignal = [element.getAttribute("name"), element.getAttribute("id"), element.getAttribute("placeholder"), element.getAttribute("aria-label"), element.getAttribute("role")].join(" ").toLowerCase()
    if (/search/.test(ownSignal)) return true
    const form = element.form
    if (!form) return false
    if (form.getAttribute("role") === "search") return true
    if (form.querySelector("input[type=password]")) return false
    const textLike = "input:not([type]), input[type=text], input[type=search], input[type=email], input[type=tel], input[type=url], input[type=number]"
    return Array.from(form.querySelectorAll(textLike)).filter((el) => !el.disabled).length === 1
  }

  const githubAccounts = () => {
    const accounts = new Set()
    for (const link of document.links) {
      try {
        const destination = new URL(link.href, location.href)
        const parts = destination.hostname.toLowerCase() === "github.com" ? destination.pathname.split("/").filter(Boolean) : []
        if (parts.length) accounts.add(parts[0].toLowerCase())
      } catch {}
    }
    return [...accounts].slice(0, 8)
  }

  // Shared by choices() (every candidate, index-numbered) and the execute
  // path's staleness re-check (one already-known element) so a single
  // element's current description/fingerprint never requires re-scanning
  // and re-sorting the whole page's candidate set just to look at it again.
  const describeCandidate = (element, index) => {
    const label = `${element.tagName.toLowerCase()}: ${(element.innerText || element.value || element.getAttribute("aria-label") || "unnamed").trim().slice(0, 48)}${element.matches("a[href]") ? ` ${element.href}` : ""}`
    return {
      id: String(index + 1),
      mode: modeFor(element),
      description: label,
      options: element.matches("select") ? Array.from(element.options).slice(0, 16).map((option, optionIndex) => ({ index: optionIndex, description: option.text.trim().slice(0, 48) })) : [],
      fingerprint: actionFingerprint(element),
      element
    }
  }

  const choices = (goal) => sample(Array.from(document.querySelectorAll("button, a[href], input, textarea, select, [role=button], [role=combobox], [contenteditable=true]"))
    .filter((element) => !element.matches("input[type=hidden], input[type=file], input[type=password]"))
    .filter(selectable)
    .sort((left, right) => relevance(right, goal) - relevance(left, goal)))
    .map(describeCandidate)

  chrome.runtime.onMessage.addListener((message, _, sendResponse) => {
    if (message.type === "sembrowse-candidates") {
      const candidates = choices(message.goal)
      snapshot = { candidates, fingerprint: crypto.randomUUID() }
      sendResponse({
        candidates: candidates.map(({ id, mode, description, options }) => ({ id, mode, description, options })),
        state: { url: location.href, title: document.title, text: visibleText(), githubAccounts: githubAccounts(), scroll: { top: scrollY, height: document.documentElement.scrollHeight, viewport: innerHeight } },
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
      if (!selected || !selected.element.isConnected || !selectable(selected.element)) {
        sendResponse({ error: "The page changed before the local decision could run" })
        return
      }
      const current = describeCandidate(selected.element, 0)
      if (current.description !== selected.description || current.fingerprint !== selected.fingerprint) {
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
        if (isSearchLikeInput(selected.element)) {
          const enterInit = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }
          selected.element.dispatchEvent(new KeyboardEvent("keydown", enterInit))
          selected.element.dispatchEvent(new KeyboardEvent("keypress", enterInit))
          selected.element.dispatchEvent(new KeyboardEvent("keyup", enterInit))
          selected.element.form?.requestSubmit?.()
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
      selected.element.scrollIntoView({ block: "center", inline: "nearest" })
      if (selected.element.matches("a[href]")) {
        const destination = new URL(selected.element.href, location.href)
        if (destination.protocol === "https:" || destination.protocol === "http:") {
          sendResponse({ description: selected.description, changed: true, navigation: destination.href })
          return
        }
      }
      selected.element.click()
      sendResponse({ description: selected.description, changed: true })
    }
  })
}
