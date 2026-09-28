const SAME_PAGE_SIMILARITY = 0.8
const UNCHANGED_LIMIT = 4
const UNCHANGED_WARNING = 2
const STALE_LIMIT = 8
const DEAD_END_PICKS = 3
const CYCLE_MAX_PERIOD = 3
const CYCLE_REPEATS = 2
const MAX_CONSECUTIVE_WAITS = 5
const FIELD_OPERATIONS = new Set(["TYPE_TEXT", "SELECT"])

const wordSet = (text) => new Set(String(text ?? "").toLowerCase().match(/[a-z0-9]{2,}/g) || [])

const similarity = (left, right) => {
  if (!left.size && !right.size) return 1
  let shared = 0
  for (const word of left) if (right.has(word)) shared += 1
  return shared / (left.size + right.size - shared)
}

const repeatingCycle = (actions) => {
  for (let period = 2; period <= CYCLE_MAX_PERIOD; period += 1) {
    const span = period * CYCLE_REPEATS
    if (actions.length < span) continue
    const tail = actions.slice(-span)
    if (new Set(tail.slice(0, period)).size < 2) continue
    if (tail.every((action, index) => action === tail[index % period])) return period
  }
  return 0
}

const createLoopGuard = () => {
  const deadEnds = new Set()
  const pickCounts = new Map()
  const actions = []
  let previous = null
  let unchanged = 0
  let waits = 0
  let lastWasNonWait = false
  let warning = null
  let staleStreak = 0

  const observe = (state) => {
    const words = wordSet(state.text)
    const changed = !previous || previous.url !== state.url || similarity(previous.words, words) < SAME_PAGE_SIMILARITY
    previous = { url: state.url, words }
    if (changed) pickCounts.clear()
    unchanged = lastWasNonWait && !changed ? unchanged + 1 : 0
    return { changed, blocked: unchanged >= UNCHANGED_LIMIT, warn: unchanged === UNCHANGED_WARNING }
  }

  const liveCandidates = (url, candidates) => candidates.filter((candidate) => !deadEnds.has(`${url}#${candidate.key}`))

  const markStale = () => {
    lastWasNonWait = false
    staleStreak += 1
    return staleStreak >= STALE_LIMIT
  }

  const exclude = (url, key) => deadEnds.add(`${url}#${key}`)

  const record = ({ url, operation, key = "", detail = "" }) => {
    lastWasNonWait = !FIELD_OPERATIONS.has(operation) && operation !== "WAIT"
    staleStreak = 0
    waits = operation === "WAIT" ? waits + 1 : 0
    if (key) {
      const pick = `${url}#${key}`
      const count = (pickCounts.get(pick) || 0) + 1
      pickCounts.set(pick, count)
      if (count >= DEAD_END_PICKS) deadEnds.add(pick)
    }
    actions.push(`${url}#${operation}#${key}#${detail}`)
    if (waits >= MAX_CONSECUTIVE_WAITS) return { verdict: "stop", reason: "waited repeatedly without the page changing" }
    const period = repeatingCycle(actions)
    if (!period) {
      warning = null
      return { verdict: "ok" }
    }
    if (!warning) {
      warning = { at: actions.length, period }
      return { verdict: "warn", period }
    }
    if (actions.length - warning.at >= warning.period * CYCLE_REPEATS) return { verdict: "stop", reason: "repeating the same actions without progress" }
    return { verdict: "ok" }
  }

  return { observe, liveCandidates, markStale, exclude, record, deadEnds }
}
