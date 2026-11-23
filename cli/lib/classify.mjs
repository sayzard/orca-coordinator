// Turn-end classification with a model: does a finished turn need the person?
//   decision — the agent stopped and waits for a choice, approval, answer or action
//   offer    — the work is done; an optional follow-up is offered
//   none     — a report; nothing is asked
// Menus and permission prompts are structured signals and never reach the model. Each finished
// turn is classified once (cached by turn and text); the rule-based detectQuestion is the
// fallback while a result is pending or when no model is available. For a decision that a short
// reply settles, the classifier also proposes quick-reply buttons for the card.
//
// Two providers:
//   claude — a small model through the local `claude` CLI, under the person's own Claude account
//   jev    — TypeSafe AI's decision model; its API key comes from TYPESAFE_API_KEY (the board keeps
//            it in Orca's encrypted plugin secrets and passes it to coord)
// Off by default: the board's Settings tab or `coord setup --classifier claude|jev|off` sets it.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readJson, updateJson } from './store.mjs'
import { detectQuestion, effectiveAgent, replyOf, turnKey } from './lanes.mjs'

export const DEFAULT_MODEL = 'claude-haiku-5-5'
export const DEFAULT_JEV_MODEL = 'jev-1.14.0'
const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
const PER_REFRESH = 6
const TIMEOUT_MS = 30_000
const PENDING_MS = 90_000
const RETRY_AFTER_MS = 10 * 60_000
const CACHE = 'cache/turn-class.json'
const LABELS = new Set(['decision', 'offer', 'none'])
const MAX_OPTIONS = 4

// Synthetic examples only: real conversations never go into the repository.
export const SYSTEM_PROMPT = `You classify the end of an AI coding agent's final reply for a dashboard that shows which sessions need the person.

Labels:
- decision: the agent stopped and should not continue without the person: a choice, an approval, an answer, or an action only the person can take. Option lists left for the person and requests to run, approve or provide something count, with or without a question mark.
- offer: the work is done; the agent only offers an optional follow-up the person may ignore ("if you want I can…", "let me know if you need anything").
- none: a report or progress note; nothing is asked. Questions the agent answers itself do not count.

Test: if the person never replies, is the agent's work incomplete? Yes means decision.
Strict rules: label decision only when the reply itself asks the person something or hands them a choice or an action. Never infer a question from a status report, a list of remaining work, or a plan the agent says it will carry out; those are none.

Quick-reply buttons ("options"): only for decision, and only when a short reply fully settles it (yes/no, picking one of the options the reply lists, going with the agent's recommendation). Up to 4, the agent's recommendation first. "label" is 1-4 words in the reply's language; "reply" is the full message to send to the agent. Use [] when the person must type something specific (a name, a value, a password) or do something outside the chat.

Examples:
"Tests pass and the fix is committed.\\nShall I push it to main?" -> {"label":"decision","question":"Shall I push it to main?","options":[{"label":"Push","reply":"Yes, push it to main."},{"label":"Not yet","reply":"Don't push yet."}]}
"I made two layouts: A keeps the sidebar, B moves it to the top.\\nThe screenshots are in docs/shots/." -> {"label":"decision","question":"Which layout, A (sidebar) or B (top)?","options":[{"label":"A (sidebar)","reply":"Go with layout A."},{"label":"B (top)","reply":"Go with layout B."}]}
"서버 23에서 sudo -v를 입력해 주시면 1번부터 진행하겠습니다." -> {"label":"decision","question":"서버 23에서 sudo -v를 입력해 주시겠어요?","options":[]}
"결정이 필요한 것: 배포 시점\\n지금 배포하거나 금요일까지 미룰 수 있습니다. 저는 금요일을 추천합니다.\\n보고서는 docs/report.md에 있습니다." -> {"label":"decision","question":"배포를 지금 할까요, 금요일까지 미룰까요?","options":[{"label":"금요일에","reply":"추천대로 금요일까지 미뤄 주세요."},{"label":"지금 배포","reply":"지금 배포해 주세요."}]}
"새 프로젝트 이름을 알려 주시면 저장소를 만들겠습니다." -> {"label":"decision","question":"새 프로젝트 이름은 무엇으로 할까요?","options":[]}
"Migration is done and verified.\\nIf you want, I can also add a rollback script." -> {"label":"offer","question":"","options":[]}
"정리를 마쳤습니다. 추가로 필요한 것이 있으면 말씀해 주세요." -> {"label":"offer","question":"","options":[]}
"Deployed to staging.\\nRemaining: update the changelog and tag the release after QA." -> {"label":"none","question":"","options":[]}
"Why did the build fail? The cache key ignored the lockfile; I fixed the key and the build passes." -> {"label":"none","question":"","options":[]}
"다음으로 로그 수준을 낮추고 재시작하겠습니다." -> {"label":"none","question":"","options":[]}

Reply with JSON only: {"label":"decision|offer|none","question":"<for decision: the one sentence the person must answer, in the reply's language; else empty>","options":[{"label":"...","reply":"..."}]}`

/** Identifies the prompt text: any change to it invalidates cached answers, with no version to bump. */
export const PROMPT_ID = createHash('sha1').update(SYSTEM_PROMPT).digest('hex').slice(0, 8)

// Jev answers typed questions with probabilities and writes no text: the label is a choice, each
// candidate button a yes/no question, and the card's question comes from the rules.
const JEV_LABEL = {
  type: 'choice',
  instructions:
    "What does the end of this AI coding agent's final reply need from the person? Judge only what the reply itself asks; never infer a question from a status report or from a plan the agent says it will carry out.",
  criteria: {
    decision:
      'The agent stopped and should not continue without the person: a choice, an approval, an answer, or an action only the person can take. Option lists left for the person count, with or without a question mark.',
    offer: 'The work is done; the agent only offers an optional follow-up the person may ignore.',
    none: 'A report or progress note; nothing is asked of the person. Questions the agent answers itself do not count.'
  }
}
const jevButton = (reply) => `If the person replied exactly "${reply}", would that be a sensible, complete answer to what the agent asks at the end of its reply?`
const JEV_THRESHOLD = 0.6
/** Identifies the Jev questions, like PROMPT_ID for the Claude prompt. */
export const JEV_ID = createHash('sha1').update(JSON.stringify([JEV_LABEL, jevButton('x'), JEV_THRESHOLD])).digest('hex').slice(0, 8)

/** The `claude` binary: COORD_CLAUDE_BIN, the configured path, a usual install place, else PATH. */
export function claudeBin(config = {}) {
  const candidates = [process.env.COORD_CLAUDE_BIN, config.classifier?.claudePath, join(homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].filter(Boolean)
  return candidates.find((p) => existsSync(p)) || 'claude'
}

/**
 * The classifier to use, or null when it is off. `ready` is false when this process cannot call
 * the provider (Jev without TYPESAFE_API_KEY): cached answers still apply, but no turn is sent.
 */
export function classifierSettings(config = {}, env = process.env) {
  const c = config.classifier || {}
  if (!c.enabled) return null
  const base = { perRefresh: c.perRefresh ?? PER_REFRESH, timeoutMs: c.timeoutMs ?? TIMEOUT_MS }
  if (c.provider === 'jev') {
    const key = env.TYPESAFE_API_KEY || null
    return { ...base, provider: 'jev', model: c.jevModel || DEFAULT_JEV_MODEL, promptId: JEV_ID, key, ready: Boolean(key) }
  }
  return { ...base, provider: 'claude', model: c.model || DEFAULT_MODEL, promptId: PROMPT_ID, bin: claudeBin(config), ready: true }
}

/** The last lines of a reply: what the model judges. */
export function replyTail(reply) {
  return reply.split('\n').filter((l) => l.trim()).slice(-40).join('\n').slice(-6000)
}

function lastLine(text) {
  return (text.split('\n').filter((l) => l.trim()).pop() || '').replace(/\*\*/g, '').trim().slice(0, 400)
}

/** Quick-reply buttons: short labels, full replies, at most MAX_OPTIONS. */
export function cleanOptions(list) {
  return (Array.isArray(list) ? list : [])
    .map((o) => ({ label: String(o?.label || '').trim().slice(0, 24), reply: String(o?.reply || '').trim().slice(0, 300) }))
    .filter((o) => o.label && o.reply)
    .slice(0, MAX_OPTIONS)
}

/** Parses the Claude model's answer; null when it is not one of the labels. */
export function parseClassification(text) {
  const m = /\{[\s\S]*\}/.exec(text || '')
  if (!m) return null
  try {
    const r = JSON.parse(m[0])
    if (!LABELS.has(r.label)) return null
    const decision = r.label === 'decision'
    return { label: r.label, question: decision ? String(r.question || '').trim().slice(0, 400) : '', options: decision ? cleanOptions(r.options) : [] }
  } catch {
    return null
  }
}

/**
 * Candidate buttons for Jev, which cannot write them: the options the reply lists ("1. …",
 * "A) …"), then yes / as recommended / no. Jev keeps the ones that would answer the question.
 */
export function candidateReplies(tail) {
  const ko = /[가-힣]/.test(tail)
  const listed = []
  const lines = tail
    .replace(/```[\s\S]*?```/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-25)
  for (const line of lines) {
    const m = /^(?:[-*•]\s*)?(?:\*\*)?(?:(\d{1,2})|([A-Ha-h]))[.)]\s*(?:\*\*)?\s*(.+)$/.exec(line)
    if (!m) continue
    const key = m[1] || m[2].toUpperCase()
    const text = m[3].replace(/\*\*/g, '').replace(/[:：]\s*$/, '').trim()
    if (!text) continue
    const short = text.length > 16 ? text.slice(0, 15) + '…' : text
    listed.push({ label: `${key}. ${short}`, reply: ko ? (m[1] ? `${key}번으로 진행해 주세요.` : `${key}안으로 진행해 주세요.`) : `Go with option ${key}.` })
  }
  const generic = ko
    ? [
        { label: '네, 진행', reply: '네, 진행해 주세요.' },
        { label: '추천대로', reply: '추천하신 대로 진행해 주세요.' },
        { label: '아니요', reply: '아니요, 진행하지 마세요.' }
      ]
    : [
        { label: 'Yes, go ahead', reply: 'Yes, go ahead.' },
        { label: 'As recommended', reply: 'Go with your recommendation.' },
        { label: 'No', reply: "No, don't." }
      ]
  const seen = new Set()
  return [...listed, ...generic].filter((o) => !seen.has(o.reply) && seen.add(o.reply)).slice(0, 10)
}

/** The Jev request for one reply, and the candidate buttons it asks about. */
export function jevRequest(reply, model) {
  const tail = replyTail(reply)
  const candidates = candidateReplies(tail)
  const questions = { label: JEV_LABEL }
  candidates.forEach((c, i) => (questions[`b${i}`] = { type: 'noul', instructions: jevButton(c.reply) }))
  return { body: { model, state: tail, questions }, candidates, tail }
}

/** Reads a Jev response: the top label and, for a decision, the buttons Jev finds fitting. */
export function parseJev(json, candidates, tail) {
  const answers = json?.answers || {}
  const label = answers.label?.choice
  if (!LABELS.has(label)) return null
  if (label !== 'decision') return { label, question: '', options: [] }
  const options = candidates
    .map((c, i) => ({ ...c, p: Number(answers[`b${i}`]?.noul ?? 0) }))
    .filter((c) => c.p >= JEV_THRESHOLD)
    .sort((a, b) => b.p - a.p)
    .slice(0, MAX_OPTIONS)
    .map(({ label: l, reply: r }) => ({ label: l, reply: r }))
  return { label, question: detectQuestion(tail) || lastLine(tail), options }
}

function runClaude({ bin, model, timeoutMs }, input) {
  return new Promise((resolve) => {
    const args = ['-p', '--model', model, '--no-session-persistence', '--output-format', 'json', '--setting-sources', '', '--strict-mcp-config', '--tools', '', '--system-prompt', SYSTEM_PROMPT]
    const child = execFile(bin, args, { cwd: homedir(), timeout: timeoutMs, maxBuffer: 4 << 20, env: process.env }, (error, stdout) => {
      try {
        const r = JSON.parse(stdout)
        resolve({ text: r.result || '', costUsd: r.total_cost_usd || 0, error: r.is_error ? r.result || 'error' : null })
      } catch {
        resolve({ text: '', error: String(error?.message || stdout || 'no output').slice(0, 200) })
      }
    })
    child.stdin.end(input)
  })
}

async function runJev({ key, timeoutMs }, body) {
  try {
    const res = await fetch(JEV_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
    const text = await res.text()
    if (!res.ok) return { error: `jev_http_${res.status}: ${text.slice(0, 200)}` }
    return { json: JSON.parse(text) }
  } catch (error) {
    return { error: `jev_unreachable: ${String(error?.message || error).slice(0, 200)}` }
  }
}

/**
 * Classifies one reply. `run` replaces the provider call in tests: for claude it returns
 * {text}, for jev {json}.
 * @returns {Promise<{label, question, options} | {error}>}
 */
export async function classifyText(reply, settings, run) {
  if (settings.provider === 'jev') {
    const { body, candidates, tail } = jevRequest(reply, settings.model)
    const out = await (run || runJev)(settings, body)
    if (out.error) return { error: out.error }
    return parseJev(out.json, candidates, tail) || { error: `unparseable: ${JSON.stringify(out.json).slice(0, 120)}` }
  }
  const out = await (run || runClaude)(settings, `Final reply (last lines):\n"""\n${replyTail(reply)}\n"""`)
  if (out.error) return { error: out.error }
  const parsed = parseClassification(out.text)
  return parsed ? { ...parsed, costUsd: out.costUsd || 0 } : { error: `unparseable: ${String(out.text).slice(0, 120)}` }
}

/** Menus and permission prompts are known without a model. */
function structuredWait(a) {
  return Boolean(a.agentWait || a.programStatus?.state === 'blocked' || a.state === 'blocked' || (a.state === 'waiting' && a.toolName === 'AskUserQuestion'))
}

/** Cache key: the turn, the text judged, the provider, model and prompt. A new final reply re-classifies. */
export function classKey(agent, settings) {
  const text = replyTail(replyOf(agent))
  return `${turnKey(agent)}|${createHash('sha1').update(text).digest('hex').slice(0, 10)}|${settings.provider}:${settings.model}|p${settings.promptId}`
}

/**
 * Classifies finished turns that have no structured signal, at most `perRefresh` per call, most
 * recent first, and returns the cache (sessionId -> {key, label, question, options}).
 * @param {object} ps worktree ps with final replies applied
 * @param {object} opts.projects managed repo ids (empty = all); opts.excludeSessions e.g. the coordinator
 */
export async function readTurnClasses(ps, config, { run, env, projects = [], excludeSessions = [] } = {}) {
  const settings = classifierSettings(config, env)
  if (!settings) return {}
  // Without a key here (Jev called from a terminal), use what the board already classified.
  if (!settings.ready) return readJson(CACHE, {})
  const now = Date.now()
  const cache = readJson(CACHE, {})
  const live = new Set()
  const todo = []
  for (const ws of ps?.worktrees || []) {
    if (ws.isArchived || (projects.length && !projects.includes(ws.repoId))) continue
    for (const raw of ws.agents || []) {
      const a = effectiveAgent(raw)
      if (!a.orcaSessionId || excludeSessions.includes(a.orcaSessionId) || (a.state !== 'done' && a.state !== 'waiting') || structuredWait(a) || !replyOf(a).trim()) continue
      live.add(a.orcaSessionId)
      const key = classKey(a, settings)
      const c = cache[a.orcaSessionId]
      if (c?.key === key && (c.label || (c.pendingAt && now - c.pendingAt < PENDING_MS) || (c.errorAt && now - c.errorAt < RETRY_AFTER_MS))) continue
      todo.push({ id: a.orcaSessionId, key, reply: replyOf(a), at: a.updatedAt || a.stateStartedAt || 0 })
    }
  }
  const batch = todo.sort((x, y) => y.at - x.at).slice(0, settings.perRefresh)
  if (batch.length) {
    await updateJson(CACHE, {}, (s) => {
      for (const t of batch) s[t.id] = { key: t.key, pendingAt: now }
      return s
    })
    const results = await Promise.all(batch.map(async (t) => ({ t, r: await classifyText(t.reply, settings, run) })))
    await updateJson(CACHE, {}, (s) => {
      for (const { t, r } of results) {
        s[t.id] = r.error
          ? { key: t.key, errorAt: Date.now(), error: r.error }
          : { key: t.key, label: r.label, question: r.question, options: r.options || [], provider: settings.provider, model: settings.model, at: Date.now() }
      }
      for (const id of Object.keys(s)) if (!live.has(id) && !batch.some((t) => t.id === id)) delete s[id]
      return s
    })
  }
  return readJson(CACHE, {})
}

/**
 * Puts each finished turn's classification on its agent as `turnClass`, when it is for this turn,
 * this text and the classifier now in use.
 */
export function applyTurnClasses(ps, classes = {}, settings = null) {
  if (!ps?.worktrees || !settings) return ps
  return {
    ...ps,
    worktrees: ps.worktrees.map((ws) => ({
      ...ws,
      agents: (ws.agents || []).map((a) => {
        const c = classes[a.orcaSessionId]
        if (!c?.label) return a
        const ea = effectiveAgent(a)
        return c.key === classKey({ ...ea, finalReply: a.finalReply }, settings) ? { ...a, turnClass: { label: c.label, question: c.question || '', options: c.options || [] } } : a
      })
    }))
  }
}
