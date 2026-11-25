// Turns `orca worktree ps --json` (+ `orca agent list --json`) into session rows with a lane:
//   human   — needs the person (a question, a menu, a permission prompt)
//   running — working now
//   review  — finished with unread output: check the result
//   idle    — finished and already seen
//   unknown — Orca has no state for it
// Pure functions so they can be tested against captured fixtures.
import { createHash } from 'node:crypto'

const QUESTION_PATTERNS = [
  // Korean questions ("shall I…?", "which way…?").
  /할까요|하시겠|괜찮을까|좋을까요|어떨까요|어떻게\s*할|진행할까|어느\s*(쪽|것|안)으로|원하시(나요|는지|는\s*(쪽|것|방향))/,
  // Korean requests to decide, reply or act: "정해/골라/알려/말씀해/… 주세요 · 주시면 · 주십시오",
  // and things only the person can do ("실행해/입력해/넣어/눌러/허용해 주세요").
  /(정해|골라|알려|말씀해|선택해|결정해|확인해|승인해|답해|지정해|판단해|검토해|실행해|입력해|넣어|눌러|허용해|보내)\s*주(세요|시면|십시오|실래요|시겠어요|시겠습니까|시길)/,
  // "Say the word": '"시작"이라고 해 주세요'.
  /라고\s*(해|말씀해|입력해)\s*주(세요|십시오)/,
  /\b(shall i|should i|would you like|do you want|please confirm|let me know|tell me (which|whether|if)|which (one|option|would you)|can you confirm|okay to proceed|your call|up to you)\b/i
]

// Lines that flag a decision for the person ("결정이 필요한 것: …", "정해 주실 것이 있습니다",
// "Decision needed: …"), unless they say none is needed ("결정 불필요", "no decision needed").
const DECISION_MARKER =
  /(결정|선택|판단|승인)(이|을|를)?\s*(필요|해\s*주셔야|하셔야)|결정할\s*(것|사항|부분)|결정\s*사항|남은\s*결정이\s*있|(정해\s*주|결정해\s*주|선택해\s*주|정하|골라\s*주|고르)(셔야|실\s*(것|일|부분|사항))|고르시면\s*(됩니다|[^.]*겠습니다)|\b(decisions? (needed|required)|needs? your (decision|input|approval)|for you to decide|you('ll| will)? need to decide)\b/i
const DECISION_NEGATED = /불필요|필요\s*(없|하지\s*않)|\bno decisions? (needed|required)\b|\bnot? need(ed)? to decide\b/i

// An optional follow-up ("원하시면 …하겠습니다", "필요하면 말씀해 주세요", "let me know if you want …")
// is an offer, not a pending question: the person decided offers stay out of "Needs you".
// A direct question in the same sentence ("원하시면 지금 배포할까요?") still counts.
const OFFER_SENTENCE = /(원하시면|필요하시?면|싶으시?면|있으시?면|실\s*거면|\bif you(?:'d| would)? (?:want|like|need|prefer)\b|\blet me know if\b|\btell me if you (?:want|need)\b)[^?]*$/i

// A Korean question with notes after it on the same line ("…넣을까요? 나머지는 내일 봐도 됩니다."),
// but not one the agent goes on to answer itself ("왜 실패했을까요? 캐시 키 때문입니다.").
const KOREAN_QUESTION = /[가-힣](까요|나요|가요)\?/
const SELF_ANSWERED = /^[\s\-*\d.)]*(왜|어째서)\s/

function asksThePerson(line) {
  // A question mark at the end of the line counts as written; the other patterns skip offers.
  if (/\?\s*$/.test(line)) return true
  const sentences = line.split(/(?<=[.!?])\s+/).filter((sentence) => !OFFER_SENTENCE.test(sentence))
  if (sentences.some((sentence) => KOREAN_QUESTION.test(sentence) && !SELF_ANSWERED.test(sentence))) return true
  const rest = sentences.join(' ')
  return QUESTION_PATTERNS.some((re) => re.test(rest)) || (DECISION_MARKER.test(rest) && !DECISION_NEGATED.test(rest))
}

// How far from the end of a reply a question still counts as pending. Agents often follow the
// question with notes (report paths, what to look at), so a few lines is not enough.
const QUESTION_TAIL_LINES = 20

/** Returns the last line near the end of `text` that reads as a question to the person, or null. */
export function detectQuestion(text) {
  if (!text) return null
  const withoutCode = text.replace(/```[\s\S]*?```/g, ' ')
  const lines = withoutCode
    .split('\n')
    .map((l) => l.trim())
    // Skip quotes and polite closers ("if you want…") that are not pending questions.
    .filter((l) => l && !l.startsWith('>') && !/^(만약|if you want|원하시면 언제든)/i.test(l))
  const tail = lines.slice(-QUESTION_TAIL_LINES)
  for (let i = tail.length - 1; i >= 0; i--) {
    // Markdown emphasis and heading marks are dropped from the card text.
    if (asksThePerson(tail[i])) return tail[i].replace(/\*\*/g, '').replace(/^#+\s*/, '').slice(0, 400)
  }
  return null
}

export function fingerprint(agent) {
  const parts = [
    agent.state ?? '',
    agent.stateStartedAt ?? '',
    agent.lastAssistantMessage ?? '',
    agent.programStatus?.message ?? '',
    agent.prompt ?? ''
  ]
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16)
}

function cleanMenuText(message) {
  return (message || '').replace(/^answer:\s*/i, '').trim().slice(0, 600)
}

/** The reply to judge: the transcript's final reply when known, else what Orca reported. */
export function replyOf(agent) {
  return agent.finalReply || agent.lastAssistantMessage || ''
}

function attentionFor(agent) {
  const ps = agent.programStatus || {}
  // toolName keeps the last tool after the person answers, so a working agent is never waiting.
  if (agent.state === 'working') return null
  const isMenu = agent.agentWait || ps.state === 'blocked' || (agent.state === 'waiting' && agent.toolName === 'AskUserQuestion')
  if (isMenu || agent.state === 'blocked') {
    const kind = ps.kind === 'question' || agent.toolName === 'AskUserQuestion' ? 'menu' : 'permission'
    const text = cleanMenuText(ps.message) || (kind === 'permission' ? 'A permission prompt is waiting.' : 'A menu is waiting for a choice.')
    return { kind, text, canReply: false }
  }
  // A model's reading of the finished turn (cli/lib/classify.mjs) beats the rules when present.
  const c = agent.turnClass
  if (agent.state === 'waiting') {
    const text = (c?.label === 'decision' && c.question) || detectQuestion(replyOf(agent)) || cleanMenuText(ps.message) || 'Waiting for input.'
    return { kind: 'question', text, canReply: true, source: c ? 'model' : 'rule', options: c?.label === 'decision' ? c.options || [] : [] }
  }
  if (agent.state === 'done') {
    if (c) return c.label === 'decision' ? { kind: 'question', text: c.question || detectQuestion(replyOf(agent)) || lastLine(replyOf(agent)), canReply: true, source: 'model', options: c.options || [] } : null
    const q = detectQuestion(replyOf(agent))
    if (q) return { kind: 'question', text: q, canReply: true, source: 'rule' }
  }
  return null
}

function lastLine(text) {
  return (text.split('\n').filter((l) => l.trim()).pop() || '').trim().slice(0, 400)
}

function laneFor(agent, attention) {
  if (attention) return 'human'
  if (agent.state === 'working') return 'running'
  if (agent.state === 'done') return agent.activity?.unread ? 'review' : 'idle'
  return 'unknown'
}

function trim(text, n) {
  if (!text) return ''
  return text.length > n ? text.slice(0, n) + '…' : text
}

/** A subagent still working: the main agent picks up its result and carries on by itself. */
function hasWorkingSubagent(agent) {
  return (agent.subagents || []).some((s) => s?.state === 'working')
}

/**
 * Orca keeps a session `working` ("monitoring") while a background shell runs, even after the
 * agent's turn has ended; `mainAgent.state` says whether the agent itself is done or waiting.
 * A session with a working subagent stays running: the main agent resumes when it reports back.
 */
export function effectiveAgent(agent) {
  const main = agent.mainAgent
  if (agent.state === 'working' && main && (main.state === 'done' || main.state === 'waiting') && !hasWorkingSubagent(agent)) {
    return { ...agent, state: main.state, stateStartedAt: main.stateStartedAt || agent.stateStartedAt, background: true }
  }
  return agent
}

/** Turn key for a session: its final reply only changes when a new turn starts. */
export function turnKey(agent) {
  const a = effectiveAgent(agent)
  return `${a.state || ''}:${a.stateStartedAt || a.updatedAt || ''}`
}

/** Sessions whose final reply should be read from the transcript (finished or waiting). */
export function needsFinalReply(agent) {
  const a = effectiveAgent(agent)
  return Boolean(a.orcaSessionId) && (a.state === 'done' || a.state === 'waiting')
}

// `orca agent read` cuts long entries (about 1,200 characters) and ends them with "… (truncated)".
// Such a reading holds only the start of the reply, never the question at its end.
const TRUNCATED_READ = /…\s*\(truncated\)\s*$/

/**
 * Orca's `lastAssistantMessage` can be the first text block of a turn (seen for chat sessions),
 * so a question at the end of the real final reply is missed. Replace it with the final reply
 * read from the transcript when that reading belongs to the same turn. It goes in `finalReply`, not
 * over `lastAssistantMessage`, so card fingerprints do not change when the reading arrives.
 * A cut-off reading is not used: `lastAssistantMessage` then has more of the reply's end.
 * @param {object} ps result of `orca worktree ps --json`
 * @param {Record<string, {key: string, text: string}>} finals sessionId -> final reply
 */
export function applyFinalReplies(ps, finals = {}) {
  if (!ps?.worktrees) return ps
  return {
    ...ps,
    worktrees: ps.worktrees.map((ws) => ({
      ...ws,
      agents: (ws.agents || []).map((a) => {
        const f = finals[a.orcaSessionId]
        return f && f.text && f.key === turnKey(a) && !TRUNCATED_READ.test(f.text) ? { ...a, finalReply: f.text } : a
      })
    }))
  }
}

/**
 * @param {object} ps result of `orca worktree ps --json`
 * @param {object} opts
 * @param {object} [opts.agentList] result of `orca agent list --json`
 * @param {string[]} [opts.projects] managed repo ids (empty = all)
 * @param {string[]} [opts.excludeSessions] orcaSessionIds to leave out (the coordinator)
 */
export function deriveSessions(ps, { agentList = null, projects = [], excludeSessions = [] } = {}) {
  const kinds = new Map()
  for (const a of agentList?.agents || []) if (a.orcaSessionId) kinds.set(a.orcaSessionId, a)
  const sessions = []
  for (const ws of ps?.worktrees || []) {
    if (ws.isArchived) continue
    if (projects.length && !projects.includes(ws.repoId)) continue
    for (const raw of ws.agents || []) {
      if (!raw.orcaSessionId || excludeSessions.includes(raw.orcaSessionId)) continue
      const agent = effectiveAgent(raw)
      const listed = kinds.get(agent.orcaSessionId)
      const handle = typeof agent.address === 'string' ? agent.address : null
      const kind = listed?.kind || (handle?.startsWith('term_') ? 'terminal' : 'chat')
      // Seen live: Orca keeps a terminal agent listed after its pane is closed, with no `term_`
      // address (and `orca agent show` lists no places). Nothing can be read or answered there.
      if (kind === 'terminal' && !handle?.startsWith('term_')) continue
      const attention = attentionFor(agent)
      sessions.push({
        sessionId: agent.orcaSessionId,
        kind,
        agent: agent.agentType || listed?.agent || null,
        worktreeId: ws.worktreeId,
        repoId: ws.repoId,
        project: ws.repo || ws.displayName || '',
        workspace: ws.displayName || (ws.branch || '').replace(/^refs\/heads\//, ''),
        workspaceSelector: ws.address?.worktree ? ws.address.worktree : `id:${ws.worktreeId}`,
        path: ws.path,
        paneKey: agent.paneKey || null,
        handle,
        title: agent.activity?.title || agent.conversationName || agent.taskTitle || agent.displayName || trim(agent.prompt, 60) || '(untitled)',
        state: agent.state || null,
        stateStartedAt: agent.stateStartedAt || null,
        toolName: agent.toolName || null,
        prompt: trim(agent.prompt, 600),
        lastAssistantMessage: trim(replyOf(agent), 2000),
        // The end of the reply, where questions are: evidence for tuning detection.
        replyTail: replyOf(agent).slice(-3000),
        unread: Boolean(agent.activity?.unread),
        updatedAt: agent.updatedAt || ws.lastActivityAt || null,
        attention,
        lane: laneFor(agent, attention),
        background: Boolean(agent.background),
        // decision | offer | none from the model, when the turn was classified.
        turnLabel: agent.turnClass?.label || null,
        fingerprint: fingerprint(agent)
      })
    }
  }
  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  return sessions
}

export const LANE_ORDER = ['human', 'running', 'review', 'idle', 'unknown']
export const LANE_LABELS = { human: 'Needs you', running: 'Running', review: 'To review', idle: 'Idle', unknown: 'Unknown' }

/** Groups sessions by project with lane counts. */
export function groupByProject(sessions) {
  const map = new Map()
  for (const s of sessions) {
    const key = s.repoId || s.project
    if (!map.has(key)) map.set(key, { repoId: s.repoId, project: s.project, counts: Object.fromEntries(LANE_ORDER.map((l) => [l, 0])), sessions: [] })
    const g = map.get(key)
    g.counts[s.lane] += 1
    g.sessions.push(s)
  }
  return [...map.values()].sort((a, b) => b.counts.human - a.counts.human || b.counts.running - a.counts.running || a.project.localeCompare(b.project))
}
