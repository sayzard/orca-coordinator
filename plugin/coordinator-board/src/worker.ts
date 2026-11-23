// The board's worker: a thin bridge to the `coord` CLI (all board logic lives there) plus the
// status bar, desktop notifications and the one path the CLI deliberately lacks — typing the
// person's answer into a terminal session, only when the person pressed [Send].
import type { OrcaWorkerApi } from 'orca/worker'
import type { ActionResult, BoardStatus, Card, Snapshot } from './protocol'
import { pickLang, t, type Key, type Lang } from './i18n'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const APP_ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca'
const REPO_COORD = fileURLToPath(new URL('../../../cli/coord.mjs', import.meta.url))
const DEBOUNCE_MS = 3000
const POLL_MS = 45_000
// Chat sessions do not send agent status events, so poll faster while anything is running.
const FAST_POLL_MS = 10_000
let pollTimer: ReturnType<typeof setTimeout> | null = null

export function deactivate(): void {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
}

type Envelope = { ok: true; result: any } | { ok: false; error: { code: string; message: string } }

function exec(file: string, args: string[], timeoutMs: number): Promise<Envelope> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: process.env }, (error, stdout, stderr) => {
      const text = String(stdout || '').trim()
      try {
        const parsed = JSON.parse(text)
        if (parsed && parsed.ok === true) return resolve(parsed)
        // Failure fields reach the panel as-is, so make sure they are strings.
        if (parsed && parsed.ok === false) {
          const e = parsed.error || {}
          return resolve({ ok: false, error: { code: String(e.code || 'error'), message: String(e.message ?? '') } })
        }
      } catch {}
      const killed = (error as any)?.killed
      resolve({ ok: false, error: { code: killed ? 'timeout' : 'exec_failed', message: (String(stderr || '') || text || String(error)).slice(0, 400) } })
    })
  })
}

/** Runs the orca CLI; a .mjs override (tests) runs under this Node. */
function orcaCli(args: string[], timeoutMs: number): Promise<Envelope> {
  const bin = process.env.COORD_ORCA_BIN || APP_ORCA
  return /\.m?js$/.test(bin) ? exec(process.execPath, [bin, ...args], timeoutMs) : exec(bin, args, timeoutMs)
}

export default function activate(orca: OrcaWorkerApi): void {
  let last: Snapshot | null = null
  let inflight: Promise<Snapshot> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  async function coord(args: string[], timeoutMs = 60_000): Promise<Envelope> {
    const setting = String((await orca.settings.get('coordPath').catch(() => '')) || '').trim()
    if (setting && /\.m?js$/.test(setting)) return exec(process.execPath, [setting, ...args, '--json'], timeoutMs)
    if (setting) return exec(setting, [...args, '--json'], timeoutMs)
    if (existsSync(REPO_COORD)) return exec(process.execPath, [REPO_COORD, ...args, '--json'], timeoutMs)
    return exec('coord', [...args, '--json'], timeoutMs)
  }

  /** Worker text language: the plugin's `language` setting, else the board language, else the system locale. */
  async function lang(): Promise<Lang> {
    const setting = String((await orca.settings.get('language').catch(() => 'auto')) || 'auto')
    if (setting !== 'auto') return pickLang(setting)
    const board = last?.ok ? last.status.language : undefined
    return pickLang(board || Intl.DateTimeFormat().resolvedOptions().locale)
  }

  /** Success carries a message key the panel renders in its own language; errors carry Orca's code. */
  function result(env: Envelope, ok: (r: any) => { key: Key; params?: Record<string, string | number> }): ActionResult {
    if (!env.ok) return { ok: false, code: env.error.code, message: env.error.message }
    const { key, params } = ok(env.result)
    return done(key, params)
  }

  /** The host rejects `undefined` anywhere in a handler result ("non-JSON value"), so a missing
   * `params` is left out rather than sent as `params: undefined`. */
  function done(key: Key, params?: Record<string, string | number>): ActionResult {
    return { ok: true, key, ...(params ? { params } : {}), message: t('en', key, params) }
  }

  async function updateStatusBar(status: BoardStatus | null, error?: string) {
    const L = await lang()
    if (!status) {
      await orca.host.call('statusBar.update', { id: 'decisions', text: t(L, 'bar.unknown'), tone: 'danger', tooltip: t(L, 'bar.error', { error: error || '' }).slice(0, 300) }).catch(() => null)
      return
    }
    const n = status.counts.decisions
    const top = status.decisions.slice(0, 3).map((d) => `• ${d.question.slice(0, 70)}`).join('\n')
    await orca.host
      .call('statusBar.update', {
        id: 'decisions',
        text: t(L, 'bar.text', { n }),
        tone: n > 0 ? 'warning' : 'neutral',
        tooltip: n > 0 ? `${top}\n${t(L, 'bar.counts', { running: status.counts.running, review: status.counts.review })}` : t(L, 'bar.none', { running: status.counts.running })
      })
      .catch(() => null)
  }

  async function notifyNew(cards: Card[]) {
    if ((await orca.settings.get('notify').catch(() => true)) === false) return
    const seen = new Set(((await orca.storage.get('seenCards').catch(() => null)) as string[] | null) || [])
    const urgent = cards.filter((c) => ['now', 'menu', 'permission'].includes(c.priority))
    const fresh = urgent.filter((c) => !seen.has(`${c.id}:${c.evidence?.fingerprint || ''}`))
    const L = await lang()
    for (const c of fresh.slice(0, 3)) {
      await orca.host.call('notifications.show', { title: t(L, 'notify.title', { project: c.target?.project || '' }), body: c.question.slice(0, 180) }).catch(() => null)
    }
    const keys = cards.map((c) => `${c.id}:${c.evidence?.fingerprint || ''}`)
    await orca.storage.set('seenCards', keys.slice(-200)).catch(() => null)
  }

  async function refresh(fresh = false): Promise<Snapshot> {
    if (inflight) return inflight
    inflight = (async () => {
      const env = await coord(fresh ? ['status', '--fresh'] : ['status'])
      const snap: Snapshot = env.ok ? { ok: true, status: env.result as BoardStatus, at: Date.now() } : { ok: false, code: env.error.code, message: env.error.message, at: Date.now() }
      last = snap
      orca.panels.post('board.snapshot', snap)
      if (snap.ok) {
        await updateStatusBar(snap.status)
        await notifyNew(snap.status.decisions)
      } else {
        await updateStatusBar(null, snap.message)
      }
      return snap
    })().finally(() => {
      inflight = null
      schedulePoll()
    })
    return inflight
  }

  /** Next background refresh: sooner while sessions are running, so finished turns show up fast. */
  function schedulePoll() {
    if (pollTimer) clearTimeout(pollTimer)
    const running = last?.ok ? last.status.counts.running : 0
    pollTimer = setTimeout(() => void refresh(), running > 0 ? FAST_POLL_MS : POLL_MS)
    ;(pollTimer as any).unref?.()
  }

  function schedule() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void refresh(), DEBOUNCE_MS)
  }

  orca.events.on('agent.status.changed', schedule)
  orca.events.on('workspace.created', schedule)
  orca.events.on('workspace.removed', schedule)
  void refresh()

  orca.commands.register('coordinator-board.toggle', async () => {
    await orca.host.call('commands.run', { action: 'sidebar.right.toggle' })
    void refresh()
    return t(await lang(), 'msg.toggle')
  })
  orca.commands.register('coordinator-board.digest', async () => {
    const r = result(await coord(['digest']), () => ({ key: 'msg.digest' }))
    return r.ok && r.key ? t(await lang(), r.key as Key) : r.message
  })

  orca.panels.handle('board.snapshot', async ({ fresh }) => (fresh || !last || Date.now() - last.at > 10_000 ? refresh(Boolean(fresh)) : last))

  orca.panels.handle('decision.send', async ({ id, text, fingerprint }) => {
    if (!text.trim()) return { ok: false, code: 'text_required', message: 'The reply is empty.' }
    const card = last?.ok ? last.status.decisions.find((d) => d.id === id) : null
    const fp = fingerprint ? ['--fingerprint', fingerprint] : []
    if (card?.askMessageId) {
      // A worker's question: the coordinator owns the reply to it.
      const env = await coord(['decision', 'answer', id, '--text', text, '--via', 'coordinator'])
      void refresh(true)
      return result(env, () => ({ key: 'msg.askRelayed' }))
    }
    if (card?.target?.kind === 'chat') {
      const env = await coord(['decision', 'answer', id, '--text', text, '--via', 'mail', ...fp])
      void refresh(true)
      return result(env, () => ({ key: 'msg.mailed' }))
    }
    // Terminal session: validate with coord, type it as the person, then record the receipt.
    const prep = await coord(['decision', 'prepare', id, '--text', text, ...fp])
    if (!prep.ok) {
      void refresh(true)
      return { ok: false, code: prep.error.code, message: prep.error.message }
    }
    const { handle, message } = prep.result as { handle: string; message: string }
    const sent = await orcaCli(['terminal', 'send', '--terminal', handle, '--text', message, '--enter', '--wait-submit', '10', '--json'], 40_000)
    if (!sent.ok) {
      void refresh(true)
      if (sent.error.code === 'agent_prompt_blocked') return { ok: false, code: 'answer_in_session', message: 'A menu or permission prompt is open. Use [Open session] to answer it.' }
      return { ok: false, code: sent.error.code, message: sent.error.message }
    }
    const receipt = { requestId: sent.result?.send?.prompt?.requestId ?? null, stages: sent.result?.send?.prompt?.stages ?? [] }
    await coord(['decision', 'mark-delivered', id, '--text', text, '--receipt', JSON.stringify(receipt)])
    void refresh(true)
    const started = receipt.stages.includes('turn_started')
    return done(started ? 'msg.sentStarted' : 'msg.sentUnconfirmed')
  })

  orca.panels.handle('decision.coordinate', async ({ id, text }) => {
    const env = await coord(['decision', 'answer', id, '--text', text, '--via', 'coordinator'])
    void refresh(true)
    return result(env, () => ({ key: 'msg.coordinated' }))
  })

  orca.panels.handle('decision.dismiss', async ({ id }) => {
    const env = await coord(['decision', 'dismiss', id])
    void refresh(true)
    return result(env, () => ({ key: 'msg.dismissed' }))
  })

  orca.panels.handle('request.send', async ({ text, project }) => {
    const env = await coord(['request', 'create', text, '--source', 'human', ...(project ? ['--project', project] : [])])
    void refresh()
    return result(env, (r) => (r.status === 'sent' ? { key: 'msg.requestSent' } : { key: 'msg.requestQueued', params: { detail: r.note || r.error || '' } }))
  })

  orca.panels.handle('digest.request', async () => result(await coord(['digest']), () => ({ key: 'msg.digest' })))

  orca.panels.handle('session.open', async ({ kind, handle, workspaceSelector, path }) => {
    // A terminal session: switch straight to its pane.
    if (kind === 'terminal' && handle?.startsWith('term_')) {
      const env = await orcaCli(['terminal', 'switch', '--terminal', handle, '--json'], 20_000)
      if (env.ok) return done('msg.opened')
    }
    // Chats and folder workspaces: the CLI cannot activate folders, but the host API can open any
    // workspace in the desktop app. Find it by its folder path.
    if (path) {
      try {
        const { workspaces } = await orca.host.call('workspace.list', {})
        const match = workspaces.find((w) => w.path === path)
        if (match) {
          await orca.host.call('workspace.open', { workspaceId: match.id })
          return done('msg.opened')
        }
      } catch {}
    }
    const env = await orcaCli(['worktree', 'activate', '--worktree', workspaceSelector, '--json'], 20_000)
    return env.ok ? done('msg.opened') : { ok: false, code: 'open_failed', message: env.error.message }
  })

  orca.panels.handle('projects.list', async () => {
    const [repos, cfg] = await Promise.all([orcaCli(['repo', 'list', '--json'], 30_000), coord(['setup', '--show'])])
    if (!repos.ok) return { ok: false, repos: [], message: repos.error.message }
    const managed = new Set<string>(cfg.ok ? cfg.result.projects || [] : [])
    return {
      ok: true,
      repos: (repos.result.repos || []).map((r: any) => ({ id: String(r.id), name: String(r.displayName || r.id), kind: String(r.kind || ''), managed: managed.has(r.id) }))
    }
  })

  orca.panels.handle('projects.set', async ({ ids }) => {
    const env = await coord(['setup', '--projects', ids.join(',')])
    void refresh(true)
    return result(env, (r) => (r.projects.length ? { key: 'msg.projectsSaved', params: { n: r.projects.length } } : { key: 'msg.projectsAll' }))
  })

  orca.panels.handle('coordinator.start', async () => {
    const env = await coord(['coordinator', 'start'], 150_000)
    void refresh(true)
    return result(env, (r) => ({ key: 'msg.coordinatorStarted', params: { model: `${r.agent}/${r.model}` } }))
  })

}
