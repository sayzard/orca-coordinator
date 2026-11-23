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

type Envelope = { ok: true; result: any } | { ok: false; error: { code: string; message: string; data?: any } }

function exec(file: string, args: string[], timeoutMs: number): Promise<Envelope> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: process.env }, (error, stdout, stderr) => {
      const text = String(stdout || '').trim()
      try {
        const parsed = JSON.parse(text)
        if (parsed && typeof parsed.ok === 'boolean') return resolve(parsed)
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

  /** UI language: the plugin's `language` setting, else the system locale. */
  async function lang(): Promise<Lang> {
    const setting = String((await orca.settings.get('language').catch(() => 'auto')) || 'auto')
    return setting === 'auto' ? pickLang(Intl.DateTimeFormat().resolvedOptions().locale) : pickLang(setting)
  }

  /** Success carries a message key the panel renders in its own language; errors carry Orca's code. */
  function result(env: Envelope, ok: (r: any) => { key: Key; params?: Record<string, string | number> }): ActionResult {
    if (!env.ok) return { ok: false, code: env.error.code, message: env.error.message }
    const { key, params } = ok(env.result)
    return { ok: true, key, params, message: t('en', key, params) }
  }

  function done(key: Key, params?: Record<string, string | number>): ActionResult {
    return { ok: true, key, params, message: t('en', key, params) }
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
    })
    return inflight
  }

  function schedule() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void refresh(), DEBOUNCE_MS)
  }

  orca.events.on('agent.status.changed', schedule)
  orca.events.on('workspace.created', schedule)
  orca.events.on('workspace.removed', schedule)
  const poll = setInterval(() => void refresh(), POLL_MS)
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

  orca.panels.handle('session.open', async ({ kind, handle, workspaceSelector }) => {
    const env = kind === 'terminal' && handle?.startsWith('term_')
      ? await orcaCli(['terminal', 'switch', '--terminal', handle, '--json'], 20_000)
      : await orcaCli(['worktree', 'activate', '--worktree', workspaceSelector, '--json'], 20_000)
    return result(env, () => ({ key: 'msg.opened' }))
  })

  orca.panels.handle('projects.list', async () => {
    const [repos, cfg] = await Promise.all([orcaCli(['repo', 'list', '--json'], 30_000), coord(['setup', '--show'])])
    if (!repos.ok) return { ok: false, repos: [], message: repos.error.message }
    const managed = new Set<string>(cfg.ok ? cfg.result.projects || [] : [])
    return {
      ok: true,
      repos: (repos.result.repos || []).map((r: any) => ({ id: r.id, name: r.displayName, kind: r.kind, managed: managed.has(r.id) }))
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

  // Keep the poll from holding the worker open past deactivate.
  ;(poll as any).unref?.()
}
