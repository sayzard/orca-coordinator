// Turn-end classification with a small model: does a finished turn need the person?
//   decision — the agent stopped and waits for a choice, approval, answer or action
//   offer    — the work is done; an optional follow-up is offered
//   none     — a report; nothing is asked
// Menus and permission prompts are structured signals and never reach the model. Each finished
// turn is classified once (cached by turn and text); the rule-based detectQuestion is the
// fallback while a result is pending or when no model is available.
//
// The reply's last lines are sent to the model through the local `claude` CLI, under the
// person's own Claude account. `coord setup --classifier off` turns it off.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readJson, updateJson } from './store.mjs'
import { effectiveAgent, replyOf, turnKey } from './lanes.mjs'

export const DEFAULT_MODEL = 'claude-haiku-5-5'
const PER_REFRESH = 6
const TIMEOUT_MS = 30_000
const PENDING_MS = 90_000
const RETRY_AFTER_MS = 10 * 60_000
const CACHE = 'cache/turn-class.json'
const LABELS = new Set(['decision', 'offer', 'none'])

// Synthetic examples only: real conversations never go into the repository.
export const SYSTEM_PROMPT = `You classify the end of an AI coding agent's final reply for a dashboard that shows which sessions need the person.

Labels:
- decision: the agent stopped and should not continue without the person: a choice, an approval, an answer, or an action only the person can take. Option lists left for the person and requests to run, approve or provide something count, with or without a question mark.
- offer: the work is done; the agent only offers an optional follow-up the person may ignore ("if you want I can…", "let me know if you need anything").
- none: a report or progress note; nothing is asked. Questions the agent answers itself do not count.

Test: if the person never replies, is the agent's work incomplete? Yes means decision.
Strict rules: label decision only when the reply itself asks the person something or hands them a choice or an action. Never infer a question from a status report, a list of remaining work, or a plan the agent says it will carry out; those are none.

Examples:
"Tests pass and the fix is committed.\\nShall I push it to main?" -> {"label":"decision","question":"Shall I push it to main?"}
"I made two layouts: A keeps the sidebar, B moves it to the top.\\nThe screenshots are in docs/shots/." -> {"label":"decision","question":"Which layout, A (sidebar) or B (top)?"}
"서버 23에서 sudo -v를 입력해 주시면 1번부터 진행하겠습니다." -> {"label":"decision","question":"서버 23에서 sudo -v를 입력해 주시겠어요?"}
"결정이 필요한 것: 배포 시점\\n지금 배포하거나 금요일까지 미룰 수 있습니다.\\n보고서는 docs/report.md에 있습니다." -> {"label":"decision","question":"배포를 지금 할까요, 금요일까지 미룰까요?"}
"Migration is done and verified.\\nIf you want, I can also add a rollback script." -> {"label":"offer","question":""}
"정리를 마쳤습니다. 추가로 필요한 것이 있으면 말씀해 주세요." -> {"label":"offer","question":""}
"Deployed to staging.\\nRemaining: update the changelog and tag the release after QA." -> {"label":"none","question":""}
"Why did the build fail? The cache key ignored the lockfile; I fixed the key and the build passes." -> {"label":"none","question":""}
"다음으로 로그 수준을 낮추고 재시작하겠습니다." -> {"label":"none","question":""}

Reply with JSON only: {"label":"decision|offer|none","question":"<for decision: the one sentence the person must answer, in the reply's language; else empty>"}`

/** Identifies the prompt text: any change to it invalidates cached answers, with no version to bump. */
export const PROMPT_ID = createHash('sha1').update(SYSTEM_PROMPT).digest('hex').slice(0, 8)

/** The `claude` binary: COORD_CLAUDE_BIN, the configured path, a usual install place, else PATH. */
export function claudeBin(config = {}) {
  const candidates = [process.env.COORD_CLAUDE_BIN, config.classifier?.claudePath, join(homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].filter(Boolean)
  return candidates.find((p) => existsSync(p)) || 'claude'
}

export function classifierSettings(config = {}) {
  const c = config.classifier || {}
  if (c.enabled === false) return null
  return { model: c.model || DEFAULT_MODEL, perRefresh: c.perRefresh ?? PER_REFRESH, timeoutMs: c.timeoutMs ?? TIMEOUT_MS, bin: claudeBin(config) }
}

/** The last lines of a reply: what the model judges. */
export function replyTail(reply) {
  return reply.split('\n').filter((l) => l.trim()).slice(-40).join('\n').slice(-6000)
}

/** Parses the model's answer; null when it is not one of the labels. */
export function parseClassification(text) {
  const m = /\{[\s\S]*\}/.exec(text || '')
  if (!m) return null
  try {
    const r = JSON.parse(m[0])
    if (!LABELS.has(r.label)) return null
    return { label: r.label, question: r.label === 'decision' ? String(r.question || '').trim().slice(0, 400) : '' }
  } catch {
    return null
  }
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

/**
 * Classifies one reply. `run` can be replaced in tests.
 * @returns {Promise<{label, question, costUsd} | {error}>}
 */
export async function classifyText(reply, settings, run = runClaude) {
  const out = await run(settings, `Final reply (last lines):\n"""\n${replyTail(reply)}\n"""`)
  if (out.error) return { error: out.error }
  const parsed = parseClassification(out.text)
  return parsed ? { ...parsed, costUsd: out.costUsd || 0 } : { error: `unparseable: ${String(out.text).slice(0, 120)}` }
}

/** Menus and permission prompts are known without a model. */
function structuredWait(a) {
  return Boolean(a.agentWait || a.programStatus?.state === 'blocked' || a.state === 'blocked' || (a.state === 'waiting' && a.toolName === 'AskUserQuestion'))
}

/** Cache key: the turn, the text judged, the prompt and the model. A new final reply re-classifies. */
export function classKey(agent, model) {
  const text = replyTail(replyOf(agent))
  return `${turnKey(agent)}|${createHash('sha1').update(text).digest('hex').slice(0, 10)}|p${PROMPT_ID}|${model}`
}

/**
 * Classifies finished turns that have no structured signal, at most `perRefresh` per call, most
 * recent first, and returns the cache (sessionId -> {key, label, question}).
 * @param {object} ps worktree ps with final replies applied
 * @param {object} opts.projects managed repo ids (empty = all); opts.excludeSessions e.g. the coordinator
 */
export async function readTurnClasses(ps, config, { run, projects = [], excludeSessions = [] } = {}) {
  const settings = classifierSettings(config)
  if (!settings) return {}
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
      const key = classKey(a, settings.model)
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
        s[t.id] = r.error ? { key: t.key, errorAt: Date.now(), error: r.error } : { key: t.key, label: r.label, question: r.question, model: settings.model, at: Date.now() }
      }
      for (const id of Object.keys(s)) if (!live.has(id) && !batch.some((t) => t.id === id)) delete s[id]
      return s
    })
  }
  return readJson(CACHE, {})
}

/** Puts each finished turn's classification on its agent as `turnClass`, when it is for this turn and text. */
export function applyTurnClasses(ps, classes = {}, model = DEFAULT_MODEL) {
  if (!ps?.worktrees) return ps
  return {
    ...ps,
    worktrees: ps.worktrees.map((ws) => ({
      ...ws,
      agents: (ws.agents || []).map((a) => {
        const c = classes[a.orcaSessionId]
        if (!c?.label) return a
        const ea = effectiveAgent(a)
        return c.key === classKey({ ...ea, finalReply: a.finalReply }, c.model || model) ? { ...a, turnClass: { label: c.label, question: c.question || '' } } : a
      })
    }))
  }
}
