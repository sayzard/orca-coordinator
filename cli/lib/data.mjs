// Reads Orca state with small caches so the panel, the bot and the coordinator do not hammer the
// Orca runtime (it times out under heavy CLI load).
import { readJson, writeJson } from './store.mjs'
import { orca, tryOrca } from './orca.mjs'
import { usageSummary } from './routing.mjs'

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

export function readWorktrees(config, opts = {}) {
  return cached('worktree-ps', (config.statusCacheSeconds ?? 5) * 1000, () => orca(['worktree', 'ps', '--agent-wait', '--limit', '500'], { retry: true, timeoutMs: 45_000 }), opts)
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

export { tryOrca }
