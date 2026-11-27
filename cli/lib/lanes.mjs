// Turns `orca worktree ps --json` (+ `orca agent list --json`) into session rows with a lane:
//   human   — needs the person (a question, a menu, a permission prompt, or a turn that stopped
//             right after announcing its next step)
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

function replyLines(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('>'))
}

// A "stalled" turn: the reply's last sentence announces what the agent is about to do, and the
// turn ended there. Nothing happens until the person says "go ahead". Found by a first-person
// intent ("…하겠습니다", "I'll …") with a word that makes it the immediate next step ("이제",
// "다음으로", "…부터", "now", "next", "start with"). False alarms cost more than misses here, so
// anything that reads as waiting, later, conditional or a standing promise is left alone.
const KO_INTENT = /(겠습니다|겠어요|[할갈볼둘낼쓸]게요|(시작|진행|착수|확인|점검|수정|처리|작업|적용|실행|검토|정리|반영|구현|조사|분석|재시도)합니다|(넘어|들어|이어)갑니다)[.!…]*$/
const KO_NOW = /(^|[\s(])(이제|지금부터|지금\s*바로|바로|곧바로|곧장|이어서|먼저|우선(?![으순적])|다음(으로|은|\s*단계(로|는)))[\s,]|부터\s*(바로\s*)?[가-힣]*\s*(시작|진행|착수|확인|점검|수정|처리|작업|적용|살펴|고치|손대|해\s*보|하겠)|(이|위|아래|그)\s*(순서|계획|방향|방식)(대로|으로|로)\s/
const EN_INTENT = /\b(i['’]ll|i will|i['’]m going to|i am going to|i['’]m (now |next )?(starting|proceeding|moving on|going ahead|continuing|beginning)|let me (start|begin|proceed|go ahead|continue|move on))\b|^(next|now|first),? (up )?(is|i|i['’]ll)\b|^(starting|proceeding|moving on|going ahead|continuing) (with|to|on|now)\b/i
const EN_NOW = /\b(now|next|first|right away|immediately|straight away|go(ing)? ahead|start(ing)? (with|on|by|at|from)|begin(ning)? (with|by)|proceed(ing)?|moving on|continu(e|ing) (with|to|on))\b/i
// Waiting on something that reports back, a time, a condition, the person's wish, a refusal, or a
// promise about future turns: none of these is a step the agent stopped in front of.
const KO_NOT_NOW =
  /(?<![화장표측반전단평양정후])면[\s,]|대로\s|[가-힣]\s*(뒤|후|다음)(에|에는|엔)?[\s,]|때(는|엔|에|마다|까지|부터)?[\s,]|동안|까지[\s,]|기\s*전|(는|인|던)\s*중|중입니다|중이|기다리|대기|예약|알림|자동으로|배경에서|백그라운드|돌(고|리고|아가고)\s*있|에서는\s|내일|모레|나중|추후|이따|향후|앞으로|이후|다음\s*(주|달|번|회|에|부터|배포|릴리스|버전|세션|라운드|실행|작업\s*때)|[0-9]\s*(시|분|일|월)|:[0-9]{2}|요일|오전|오후|주말|항상|매번|않|안\s*하|말겠|못|(그대로|에만|남겨|놔|보류해|열어|켜|띄워)\s*두|원하|필요하|말씀|알려\s*주|하라고|요청|주시|드릴\s*수|수\s*있/
const EN_NOT_NOW =
  /\b(when|once|after|until|as soon as|if|whenever|while|before|tomorrow|tonight|later|next (week|time|round|session|release|run|month|sprint)|from now on|going forward|in (the )?future|won['’]t|will not|not going to|never|keep|leave|hold off|wait(ing)?|notif(y|ied|ies)|scheduled|running|in the background|in progress|let you know|report back|get back to you|can|could|would|should|might|may|at [0-9])\b/i
// The lines before the last one saying something is still going: the agent comes back by itself.
const STILL_RUNNING =
  /(돌(고|리고|아가고)\s*있|진행\s*중|실행\s*중|생성\s*중|(는|인)\s*중입니다|하는\s*중|기다리(고|는)|대기\s*중|백그라운드|배경에서|(에이전트|워커|작업자|세션)[^.]{0,20}띄웠|끝나면|끝나는\s*대로|나오면|오면\s|완료되면|알림(이|을|으로)\s*(오|받|이어)|\b(is|are|still) running\b|\bin the background\b|\bin progress\b|\bwaiting (for|on)\b|\b(when|once) (it|they|the [\w -]+?) (finish|complete|report|return|land|arrive|come)|\bscheduled\b|\bsubagents?\b|\bworkers?\b)/i
const STALL_CONTEXT_LINES = 6

/**
 * The sentence at the very end of `text` that announces a step the agent is about to take, when
 * nothing in the last lines says the work resumes by itself; else null.
 */
export function detectStall(text) {
  if (!text) return null
  const lines = replyLines(text)
  const last = (lines[lines.length - 1] || '').replace(/\*\*|`/g, '').replace(/^#+\s*/, '').replace(/^[-*•]\s+/, '')
  const sentence = (last.split(/(?<=[.!?…])\s+/).pop() || '').trim()
  if (!sentence || sentence.length > 300 || /[?:：]$/.test(sentence)) return null
  const ko = /[가-힣]/.test(sentence)
  const announces = ko ? KO_INTENT.test(sentence) && KO_NOW.test(sentence) && !KO_NOT_NOW.test(sentence) : EN_INTENT.test(sentence) && EN_NOW.test(sentence) && !EN_NOT_NOW.test(sentence)
  if (!announces || OFFER_SENTENCE.test(sentence)) return null
  const context = lines.slice(-STALL_CONTEXT_LINES).join(' ')
  return STILL_RUNNING.test(context) ? null : sentence.slice(0, 300)
}

/** The card for a stalled turn asks whether to proceed, with a one-tap go-ahead. */
export function stallCard(sentence) {
  const ko = /[가-힣]/.test(sentence)
  return {
    text: ko ? `진행할까요? “${sentence}”` : `Go ahead? “${sentence}”`,
    options: [ko ? { label: '진행', reply: '진행해 주세요.' } : { label: 'Go ahead', reply: 'Go ahead.' }]
  }
}

/**
 * Returns the last line near the end of `text` that reads as a question to the person, or null.
 * A stalled turn (see detectStall) counts too, phrased as asking to proceed, unless `stalled` is
 * false: the caller then handles stalls itself (a session with a background job is not stalled).
 */
export function detectQuestion(text, { stalled = true } = {}) {
  if (!text) return null
  // Skip quotes and polite closers ("if you want…") that are not pending questions.
  const lines = replyLines(text).filter((l) => !/^(만약|if you want|원하시면 언제든)/i.test(l))
  const tail = lines.slice(-QUESTION_TAIL_LINES)
  for (let i = tail.length - 1; i >= 0; i--) {
    // Markdown emphasis and heading marks are dropped from the card text.
    if (asksThePerson(tail[i])) return tail[i].replace(/\*\*/g, '').replace(/^#+\s*/, '').slice(0, 400)
  }
  const stall = stalled ? detectStall(text) : null
  return stall ? stallCard(stall).text : null
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
    const reply = replyOf(agent)
    // A go-ahead for an announced step is not needed while a background job will wake the agent.
    if (c?.label === 'decision') return c.stalled && agent.background ? null : { kind: 'question', text: c.question || detectQuestion(reply) || lastLine(reply), canReply: true, source: 'model', options: c.options || [], ...(c.stalled ? { stalled: true } : {}) }
    // A model's "offer" or "none" overrides the question rules, but not the stalled-turn rule:
    // that rule is narrow, and a turn it catches stays stuck until the person answers.
    const q = c ? null : detectQuestion(reply, { stalled: false })
    if (q) return { kind: 'question', text: q, canReply: true, source: 'rule' }
    const stall = agent.background ? null : detectStall(reply)
    if (stall) return { kind: 'question', canReply: true, source: 'rule', stalled: true, ...stallCard(stall) }
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
// Newer Orca builds report them under `children` (kind `agent`) instead of `subagents`.
function hasWorkingSubagent(agent) {
  if ((agent.subagents || []).some((s) => s?.state === 'working')) return true
  return (agent.children || []).some((c) => c?.kind === 'agent' && c.state === 'working' && c.membership !== 'gone')
}

// How much later than the wait began the terminal must show work, so a status read while the
// prompt was still opening is not taken for an answer.
const RESUME_MARGIN_MS = 5000

/**
 * Seen live (Orca 1.4.271): after the person approves a plan (ExitPlanMode) or a permission in the
 * terminal, Orca keeps the hook's wait (`state: waiting`, `agentWait`) until the agent's next hook,
 * which can be minutes away. The program status, read from the terminal, moves on first: a menu
 * or permission prompt shows there as `blocked`, so `working` observed after the wait began means
 * the prompt was answered and the agent is running.
 */
export function resumedAfterWait(agent) {
  const ps = agent.programStatus
  if (ps?.state !== 'working' || !ps.observedAt) return false
  if (!agent.agentWait && agent.state !== 'waiting' && agent.state !== 'blocked') return false
  const since = agent.agentWait?.since || agent.mainAgent?.stateStartedAt || agent.stateStartedAt || 0
  return ps.observedAt > since + RESUME_MARGIN_MS
}

/**
 * Orca keeps a session `working` ("monitoring") while a background shell runs, even after the
 * agent's turn has ended; `mainAgent.state` says whether the agent itself is done or waiting.
 * A session with a working subagent stays running: the main agent resumes when it reports back.
 */
export function effectiveAgent(agent) {
  if (resumedAfterWait(agent)) return { ...agent, state: 'working', agentWait: null, stateStartedAt: agent.programStatus.observedAt }
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
 * Orca reports no `orcaSessionId` for agents on a paired server; the pane key (which carries the
 * agent's session uuid) is stable across polls, so it identifies the session on that server.
 */
function remoteSessionId(env, agent) {
  return env && agent.paneKey ? `remote:${env.id}:${agent.paneKey}` : null
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
    // A worktree on a paired Orca server (see withRemoteWorktrees in data.mjs). This machine's own
    // worktrees, ssh hosts included, carry environment { id: 'local' }.
    const env = ws.environment?.id && ws.environment.id !== 'local' ? ws.environment : null
    for (const raw of ws.agents || []) {
      const sessionId = raw.orcaSessionId || remoteSessionId(env, raw)
      if (!sessionId || excludeSessions.includes(sessionId)) continue
      const agent = effectiveAgent(raw)
      const listed = kinds.get(agent.orcaSessionId)
      const handle = typeof agent.address === 'string' ? agent.address : null
      const kind = listed?.kind || (handle?.startsWith('term_') ? 'terminal' : 'chat')
      // Seen live: Orca keeps a terminal agent listed after its pane is closed, with no `term_`
      // address (and `orca agent show` lists no places). Nothing can be read or answered there.
      if (kind === 'terminal' && !handle?.startsWith('term_')) continue
      const found = attentionFor(agent)
      // Replies go to an Orca session id or a terminal handle on this machine; a session on a
      // paired server has neither, so it is answered in the session itself.
      const attention = found && env ? { ...found, canReply: false } : found
      const project = ws.repo || ws.displayName || ''
      sessions.push({
        sessionId,
        kind,
        agent: agent.agentType || listed?.agent || null,
        worktreeId: ws.worktreeId,
        repoId: ws.repoId,
        // The server name tells a remote project from a local one of the same name.
        project: env?.name ? `${project} @ ${env.name}` : project,
        environment: env ? env.name || env.id : null,
        environmentId: env ? env.id : null,
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
