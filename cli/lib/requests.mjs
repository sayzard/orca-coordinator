// Work requests from the person or the Orca bot, handed to the coordinator, and the coordinator's
// assignments (orca orchestration worker-start) recorded against them.
import { readJson, updateJson, appendHistory, newId, tempFile } from './store.mjs'
import { orca } from './orca.mjs'
import { sendAsBoard } from './board.mjs'
import { coordinatorState } from './data.mjs'
import { resolveRoute } from './routing.mjs'

const EMPTY = { version: 1, requests: [] }

export function readRequests() {
  return { ...EMPTY, ...readJson('requests.json', EMPTY) }
}

function requestBody(req, config) {
  return [
    '[Coordinator Board · New request]',
    JSON.stringify({ requestId: req.id, source: req.source, project: req.project || null, language: config.language || 'en' }),
    '',
    req.text,
    '',
    '---',
    `To handle it: pick the project, grade it (A-D), then assign it with \`coord assign --request ${req.id} --grade <A-D> --project <repo> --title "<title>" --spec-file <file>\`.`,
    'If the project or scope is unclear, do not assign it: ask the person with a `coord decision add` card.'
  ].join('\n')
}

export async function createRequest({ text, source = 'human', project = null, config }) {
  if (!text?.trim()) throw new Error('text_required: the request is empty')
  const req = { id: newId('req'), text: text.trim().slice(0, 20000), source, project, status: 'queued', createdAt: Date.now(), assignments: [] }
  await updateJson('requests.json', EMPTY, (s) => ({ ...EMPTY, ...s, requests: [...(s.requests || []), req].slice(-200) }))
  appendHistory({ type: 'request.created', id: req.id, source, project, text: req.text.slice(0, 200) })
  return deliverRequest(req, config)
}

async function deliverRequest(req, config) {
  const state = await coordinatorState(config, { fresh: true })
  if (state === 'none' || state === 'closed') {
    const note =
      state === 'none'
        ? 'no coordinator yet, so it was only queued (run coord coordinator start, then coord request resend)'
        : 'the coordinator chat is closed, so it was only queued (run coord coordinator start, then coord request resend)'
    await setRequest(req.id, { deliveryError: note })
    return { ...req, status: 'queued', code: state === 'none' ? 'no_coordinator' : 'coordinator_closed', note }
  }
  try {
    const receipt = await sendAsBoard(config, {
      to: `orca_session_id:${config.coordinator.sessionId}`,
      type: 'dispatch',
      subject: `[Request] ${req.text.split('\n')[0].slice(0, 60)}`,
      bodyFile: tempFile('request', requestBody(req, config))
    })
    const sent = await setRequest(req.id, { status: 'sent', messageId: receipt.messageId, sender: receipt.sender, sentAt: Date.now(), deliveryError: null })
    return { ...sent, messageId: receipt.messageId }
  } catch (error) {
    await setRequest(req.id, { deliveryError: error.message })
    appendHistory({ type: 'request.undelivered', id: req.id, note: error.message })
    return { ...req, status: 'queued', error: `could not reach the coordinator: ${error.message} (coord request resend ${req.id})` }
  }
}

/** Re-sends a queued request to the coordinator. */
export async function resendRequest(id, config) {
  const req = readRequests().requests.find((r) => r.id === id)
  if (!req) throw new Error(`request_not_found: ${id}`)
  if (req.status !== 'queued') throw new Error(`not_queued: ${id} is ${req.status}`)
  return deliverRequest(req, config)
}

async function setRequest(id, patch) {
  let found = null
  await updateJson('requests.json', EMPTY, (s) => {
    const requests = (s.requests || []).map((r) => (r.id === id ? (found = { ...r, ...patch, updatedAt: Date.now() }) : r))
    return { ...EMPTY, ...s, requests }
  })
  if (!found) throw new Error(`request_not_found: ${id}`)
  return found
}

/**
 * Sets a request's status. Closing it (done/cancelled) releases its workers: workers started in a
 * new worktree stay open until released, and would otherwise sit on the board as "to review".
 */
export async function updateRequestStatus(id, status, note) {
  const r = await setRequest(id, { status, note: note || null })
  const released = []
  if (status === 'done' || status === 'cancelled') {
    for (const a of r.assignments || []) {
      if (a.dispatchId) {
        const res = await orca(['orchestration', 'worker-release', '--dispatch', a.dispatchId]).catch((e) => ({ error: e.code || e.message }))
        released.push({ dispatchId: a.dispatchId, result: res?.error ? `failed: ${res.error}` : res?.status || res?.outcome || 'released' })
      }
      if (a.worktree && a.worktree.includes('::')) await orca(['worktree', 'set', '--worktree', `id:${a.worktree}`, '--read']).catch(() => null)
    }
  }
  appendHistory({ type: 'request.status', id, status, note: note || null })
  return { ...r, released }
}

/** Worktree ids of finished requests: their leftover sessions are history, not "to review". */
export function closedWorktrees() {
  const ids = new Set()
  for (const r of readRequests().requests) {
    if (r.status !== 'done' && r.status !== 'cancelled') continue
    for (const a of r.assignments || []) if (a.worktree) ids.add(a.worktree)
  }
  return ids
}

async function resolveRepo(project) {
  const repos = (await orca(['repo', 'list'], { retry: true })).repos || []
  const key = String(project).replace(/^id:/, '')
  const repo = repos.find((r) => r.id === key) || repos.find((r) => r.displayName === key) || repos.find((r) => r.path === key)
  if (!repo) throw new Error(`project_not_found: ${project} is not in orca repo list`)
  return repo
}

/** First string value under a key matching keyRe (and valueRe), searching depth-first. */
export function deepFind(obj, keyRe, valueRe = null, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && keyRe.test(k) && (!valueRe || valueRe.test(v))) return v
  }
  for (const v of Object.values(obj)) {
    const found = deepFind(v, keyRe, valueRe, depth + 1)
    if (found) return found
  }
  return null
}

function slug(text) {
  const ascii = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return (ascii || 'task').slice(0, 32) + '-' + Date.now().toString(36).slice(-4)
}

const WORKER_PREAMBLE = (req, grade) =>
  [
    `[Coordinator Board assignment · request ${req?.id || '-'} · grade ${grade}]`,
    '- Only when a decision truly needs the person, ask the coordinator with `orca orchestration ask --question "<one-sentence question>" --options "<choice 1>,<choice 2>"` and end your turn. Do not ask what you can verify or decide yourself.',
    '- Do not publish, deploy, send anything externally, spend money or grant permissions; leave those as questions.',
    '- When done, report the result and the evidence (test output, changed files, PR link) with worker_done.',
    ''
  ].join('\n')

/**
 * Starts a supervised worker for a request. Runs in the coordinator's own shell so the worker's
 * mail (worker_done, ask) comes back to the coordinator.
 */
export async function assign({ requestId, grade, project, title, spec, worktree = null, needsHooks = false, dryRun = false, config, installed, rateLimits }) {
  const route = resolveRoute({ grade, routing: config.routing, installed, excluded: config.excludedAgents, rateLimits, reservePercent: config.reservePercent, needsHooks })
  if (!route.ok) throw new Error(route.error)
  const req = requestId ? readRequests().requests.find((r) => r.id === requestId) : null
  if (requestId && !req) throw new Error(`request_not_found: ${requestId}`)
  const fullSpec = WORKER_PREAMBLE(req, grade) + spec
  const args = ['orchestration', 'worker-start', '--environment', 'local', '--spec-file', tempFile('spec', fullSpec), '--agent', route.choice.agent, '--model', route.choice.model, '--effort', route.choice.effort, '--task-title', title.slice(0, 80)]
  let repo = null
  if (worktree) {
    args.push('--worktree', worktree)
  } else {
    if (!project) throw new Error('project_required: --project or --worktree is required')
    repo = await resolveRepo(project)
    if (repo.kind === 'folder') throw new Error(`folder_project: ${repo.displayName} is a folder project, so it cannot get a new worktree; pass --worktree <selector> to use an existing workspace`)
    args.push('--worktree', 'new-top-level', '--repo', `id:${repo.id}`, '--name', slug(title))
  }
  if (dryRun) return { dryRun: true, route, command: ['orca', ...args] }
  const result = await orca(args, { timeoutMs: 120_000 })
  const assignment = {
    at: Date.now(),
    grade,
    title,
    agent: route.choice.agent,
    model: route.choice.model,
    effort: route.choice.effort,
    reason: route.reason,
    project: repo?.displayName || project || null,
    dispatchId: deepFind(result, /^(dispatch_?id|dispatchId)$/i, /^ctx_/) || null,
    taskId: deepFind(result, /^(task_?id|taskId)$/i, /^task_/) || null,
    worktree: deepFind(result, /^(worktree_?id|worktreeId|workspace)$/i, /::/) || worktree || null
  }
  if (req) {
    await updateJson('requests.json', EMPTY, (s) => ({
      ...EMPTY,
      ...s,
      requests: (s.requests || []).map((r) => (r.id === req.id ? { ...r, status: 'assigned', assignments: [...(r.assignments || []), assignment], updatedAt: Date.now() } : r))
    }))
  }
  appendHistory({ type: 'request.assigned', id: req?.id || null, ...assignment })
  return { assignment, route, orca: result }
}
