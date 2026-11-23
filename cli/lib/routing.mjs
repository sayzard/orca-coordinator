// Picks agent/model/effort for a task grade from the routing table, skipping agents that are
// not installed, excluded, or below the usage reserve. Pure functions; I/O lives in commands.

const HOOK_AGENTS = new Set(['claude', 'codex'])

/** Remaining percent (0-100) for one agent/model from Orca's rateLimits, or null if unknown. */
export function remainingPercent(rateLimits, agent, model, now = Date.now()) {
  const entry = rateLimits?.[agent]
  if (!entry || entry.status !== 'ok') return null
  const windows = []
  for (const key of ['session', 'weekly', 'monthly']) if (entry[key]) windows.push(entry[key])
  // Fable has its own weekly window on Claude plans.
  if (agent === 'claude' && /fable/.test(model || '') && entry.fableWeekly) windows.push(entry.fableWeekly)
  const live = windows.filter((w) => typeof w.usedPercent === 'number' && !(w.resetsAt && w.resetsAt < now))
  if (live.length === 0) return null
  return Math.max(0, 100 - Math.max(...live.map((w) => w.usedPercent)))
}

/**
 * @param {object} p
 * @param {string} p.grade A-D or M
 * @param {object} p.routing grade → [{agent, model, effort}]
 * @param {Set<string>|null} p.installed installed agent ids (null = unknown, don't filter)
 * @param {string[]} p.excluded excluded agent ids
 * @param {object|null} p.rateLimits orca account list → result.rateLimits
 * @param {number} p.reservePercent skip candidates with less remaining than this
 * @param {boolean} p.needsHooks restrict to agents with native hooks (claude, codex)
 */
export function resolveRoute({ grade, routing, installed = null, excluded = [], rateLimits = null, reservePercent = 15, needsHooks = false, now = Date.now() }) {
  const table = routing?.[grade]
  if (!Array.isArray(table) || table.length === 0) {
    return { ok: false, error: `no_route: grade ${grade} has no candidates`, candidates: [] }
  }
  const candidates = table.map((c) => {
    const remaining = remainingPercent(rateLimits, c.agent, c.model, now)
    let skipped = null
    if (excluded.includes(c.agent)) skipped = 'excluded'
    else if (installed && !installed.has(c.agent)) skipped = 'not_installed'
    else if (needsHooks && !HOOK_AGENTS.has(c.agent)) skipped = 'no_hooks'
    else if (remaining !== null && remaining < reservePercent) skipped = `low_usage(${remaining}% left)`
    return { ...c, remaining, skipped }
  })
  const chosen = candidates.find((c) => !c.skipped)
  if (chosen) {
    return { ok: true, grade, choice: pick(chosen), reason: reasonFor(chosen, candidates), degraded: false, candidates }
  }
  // Every candidate is below the reserve: fall back to the one with most room left, flagged.
  const usable = candidates.filter((c) => c.skipped?.startsWith('low_usage'))
  if (usable.length) {
    const best = usable.reduce((a, b) => ((b.remaining ?? -1) > (a.remaining ?? -1) ? b : a))
    return { ok: true, grade, choice: pick(best), reason: `every candidate is under the ${reservePercent}% reserve -> ${best.agent}/${best.model} has the most left`, degraded: true, candidates }
  }
  return { ok: false, error: `no_route: no eligible agent for grade ${grade}`, candidates }
}

function pick(c) {
  return { agent: c.agent, model: c.model, effort: c.effort }
}

function reasonFor(chosen, candidates) {
  const skipped = candidates.filter((c) => c.skipped && candidates.indexOf(c) < candidates.indexOf(chosen))
  const room = chosen.remaining === null ? 'no usage data' : `${chosen.remaining}% usage left`
  if (skipped.length === 0) return `first choice in the routing table (${room})`
  return `${skipped.map((c) => `${c.agent}/${c.model}: ${c.skipped}`).join(', ')} -> ${chosen.agent}/${chosen.model} (${room})`
}

/** Compact usage summary for display. */
export function usageSummary(rateLimits, now = Date.now()) {
  const rows = []
  for (const [provider, entry] of Object.entries(rateLimits || {})) {
    if (!entry || typeof entry !== 'object' || !('status' in entry)) continue
    const windows = []
    for (const key of ['session', 'weekly', 'fableWeekly', 'monthly']) {
      const w = entry[key]
      if (w && typeof w.usedPercent === 'number' && !(w.resetsAt && w.resetsAt < now)) {
        windows.push({ id: key, usedPercent: w.usedPercent, resetsAt: w.resetsAt ?? null, resetDescription: w.resetDescription ?? null })
      }
    }
    rows.push({ provider, status: entry.status, plan: entry.planType ?? null, windows, error: entry.status === 'ok' ? null : entry.error ?? null })
  }
  return rows
}
