// Reads Orca state with small caches so the panel, the bot and the coordinator do not hammer the
// Orca runtime (it times out under heavy CLI load).
import { readJson, writeJson } from './store.mjs'
import { orca, tryOrca } from './orca.mjs'
import { usageSummary } from './routing.mjs'
import { needsFinalReply, turnKey } from './lanes.mjs'

async function cached(name, maxAgeMs, fetcher, { fresh = false } = {}) {
  const entry = readJson(`cache/${name}.json`, null)
  if (!fresh && entry && Date.now() - entry.at < maxAgeMs) return entry.value
  try {
    const value = await fetcher()
    writeJson(`cache/${name}.json`, { at: Date.now(), value })
    return value
  } catch (error) {
    if (entry) return entry.value // stale beats nothing when Orca is busy
    throw error
  }
}

const PS_ARGS = ['worktree', 'ps', '--agent-wait', '--limit', '500']
const REMOTE_PS_TIMEOUT_MS = 10_000

/**
 * Names of the paired Orca servers (`--environment <name>`) that a local `worktree ps` left out.
 * Orca lists only this machine and its ssh hosts; a paired runtime shows up just as a selector
 * under `hostScope.omittedHostSelectors`. Selectors that are not `--environment` (null for some
 * ssh hosts) cannot be queried and are skipped.
 */
export function omittedEnvironments(ps) {
  const names = []
  for (const h of ps?.hostScope?.omittedHostSelectors || []) {
    const m = /^--environment\s+(\S+)$/.exec(String(h?.selector || '').trim())
    if (m && !names.includes(m[1])) names.push(m[1])
  }
  return names
}

/**
 * Adds the worktrees of the paired servers to a local `worktree ps` result. Each server is asked
 * once, in parallel, without retries: an unreachable one (Orca answers at once with
 * `remote_runtime_unavailable`) is left out instead of holding up the board.
 * @param {object} ps local result
 * @param {(name: string) => Promise<object>} fetchRemote returns that server's `worktree ps` result
 */
export async function withRemoteWorktrees(ps, fetchRemote) {
  const names = omittedEnvironments(ps)
  if (!names.length) return ps
  const results = await Promise.allSettled(names.map((name) => fetchRemote(name)))
  const remote = results.flatMap((r) => (r.status === 'fulfilled' ? r.value?.worktrees || [] : []))
  return { ...ps, worktrees: [...(ps.worktrees || []), ...remote] }
}

export function readWorktrees(config, opts = {}) {
  return cached(
    'worktree-ps',
    (config.statusCacheSeconds ?? 5) * 1000,
    async () => {
      const local = await orca(PS_ARGS, { retry: true, timeoutMs: 45_000 })
      return withRemoteWorktrees(local, (name) => orca([...PS_ARGS, '--environment', name], { timeoutMs: REMOTE_PS_TIMEOUT_MS }))
    },
    opts
  )
}

export function readAgentList(config, opts = {}) {
  return cached('agent-list', (config.statusCacheSeconds ?? 5) * 1000, () => orca(['agent', 'list'], { retry: true }), opts)
}

/** Only rateLimits are kept: account rows carry e-mail addresses we have no reason to store. */
export async function readRateLimits(config, opts = {}) {
  return cached(
    'rate-limits',
    (config.usageCacheSeconds ?? 300) * 1000,
    async () => (await orca(['account', 'list'], { retry: true, timeoutMs: 45_000 })).rateLimits || {},
    opts
  )
}

export async function readInstalledAgents(config) {
  const value = await cached('agents-installed', 3600_000, async () => (await orca(['agent', 'installed'], { retry: true })).agents || [])
  return new Set(value.map((a) => a.id))
}

export async function readUsage(config, opts = {}) {
  const r = await tryOrcaSafe(() => readRateLimits(config, opts))
  return r.ok ? usageSummary(r.value) : []
}

async function tryOrcaSafe(fn) {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    return { ok: false, error }
  }
}

/** Last assistant text in an `orca agent read` result. */
export function lastAssistantText(read) {
  const entries = read?.entries || []
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.role === 'assistant' && (e.text || '').trim()) return e.text
  }
  return ''
}

const FINAL_READS_PER_CALL = 8

/**
 * Final replies of finished sessions, read once per turn with `orca agent read` and cached by
 * turn key. At most FINAL_READS_PER_CALL new reads per call keep the Orca runtime responsive;
 * the rest are read on the next refresh.
 */
export async function readFinalReplies(ps) {
  const cache = readJson('cache/final-replies.json', {})
  const live = new Set()
  const todo = []
  for (const ws of ps?.worktrees || []) {
    for (const a of ws.agents || []) {
      if (!needsFinalReply(a)) continue
      live.add(a.orcaSessionId)
      const key = turnKey(a)
      if (cache[a.orcaSessionId]?.key !== key) todo.push({ id: a.orcaSessionId, key, at: a.updatedAt || a.stateStartedAt || 0 })
    }
  }
  // Most recent first: those are the ones a person is waiting on.
  const batch = todo.sort((x, y) => y.at - x.at).slice(0, FINAL_READS_PER_CALL)
  const results = await Promise.all(
    batch.map(async ({ id, key }) => {
      const r = await tryOrca(['agent', 'read', id, '--limit', '6'], { timeoutMs: 15_000 })
      return r.ok ? { id, key, text: lastAssistantText(r.result).slice(-4000) } : null
    })
  )
  let changed = false
  for (const r of results) {
    if (!r) continue
    cache[r.id] = { key: r.key, text: r.text, at: Date.now() }
    changed = true
  }
  for (const id of Object.keys(cache)) {
    if (!live.has(id)) {
      delete cache[id]
      changed = true
    }
  }
  if (changed) writeJson('cache/final-replies.json', cache)
  return cache
}

/**
 * Whether the coordinator chat is still open. A closed chat drops out of `orca agent list`, and
 * mail sent to it is stored but nobody reads it.
 * Returns 'open', 'closed', or 'none' (no coordinator configured); 'unknown' when Orca can't say.
 */
export async function coordinatorState(config, { fresh = false } = {}) {
  const id = config.coordinator?.sessionId
  if (!id) return 'none'
  const list = await readAgentList(config, { fresh }).catch(() => null)
  if (!list) return 'unknown'
  return (list.agents || []).some((a) => a.orcaSessionId === id) ? 'open' : 'closed'
}

/** Throws a clear error unless the coordinator chat can receive mail. */
export async function requireCoordinator(config) {
  const state = await coordinatorState(config, { fresh: true })
  if (state === 'none') throw new Error('no_coordinator: start one first with coord coordinator start')
  if (state === 'closed') throw new Error('coordinator_closed: the coordinator chat is closed; start a new one with coord coordinator start')
}

export { tryOrca }
