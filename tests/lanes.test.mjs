import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { deriveSessions, detectQuestion, groupByProject, fingerprint, applyFinalReplies, turnKey } from '../cli/lib/lanes.mjs'

const ps = JSON.parse(readFileSync(new URL('./fixtures/worktree-ps.json', import.meta.url), 'utf8'))
const byId = (sessions) => Object.fromEntries(sessions.map((s) => [s.sessionId, s]))

test('detects English questions at the end of a reply', () => {
  assert.equal(detectQuestion('I listed two options.\nWhich one should I go with?'), 'Which one should I go with?')
  assert.equal(detectQuestion('Done.\nLet me know if you want the migration too.'), 'Let me know if you want the migration too.')
  assert.equal(detectQuestion('Fixed it. All tests pass.'), null)
})

// Korean request phrases are detected too (the board is used in Korean as well).
test('detects Korean questions at the end of a reply', () => {
  assert.equal(detectQuestion('정리했습니다.\n어느 쪽으로 진행할까요?'), '어느 쪽으로 진행할까요?')
  assert.equal(detectQuestion('Done.\nShall I open a PR'), 'Shall I open a PR')
  assert.equal(detectQuestion('배포 전에 승인해 주세요.'), '배포 전에 승인해 주세요.')
  assert.equal(detectQuestion('완료했습니다. 테스트 통과.'), null)
})

test('ignores questions inside code blocks and quotes', () => {
  assert.equal(detectQuestion('```\nconsole.log("why?")\n```\n완료했습니다.'), null)
  assert.equal(detectQuestion('> 원래 질문: 이렇게 할까요?\n반영했습니다.'), null)
})

const lines = (n) => Array.from({ length: n }, (_, i) => `note ${i + 1}`).join('\n')

test('a question high above the last lines is not a pending question', () => {
  assert.equal(detectQuestion(`이렇게 할까요?\n${lines(20)}`), null)
})

// Agents often follow the question with notes (report paths, files to look at).
test('a question followed by up to 19 lines of notes is still pending', () => {
  assert.equal(detectQuestion(`보고서를 정리했습니다.\n1번부터 시작할까요?\n${lines(19)}`), '1번부터 시작할까요?')
})

test('lanes from the captured worktree ps shapes', () => {
  const s = byId(deriveSessions(ps))
  assert.equal(s['sess-menu'].lane, 'human')
  assert.equal(s['sess-menu'].attention.kind, 'menu')
  assert.equal(s['sess-menu'].attention.canReply, false)
  assert.match(s['sess-menu'].attention.text, /Fix it\?/)
  assert.equal(s['sess-question'].lane, 'human')
  assert.equal(s['sess-question'].attention.canReply, true)
  assert.equal(s['sess-question'].attention.text, 'Which one should I go with?')
  assert.equal(s['sess-done-unread'].lane, 'review')
  assert.equal(s['sess-working'].lane, 'running')
  assert.equal(s['sess-idle'].lane, 'idle')
  assert.equal(s['sess-chat'].kind, 'chat')
  assert.equal(s['sess-chat'].lane, 'human')
  assert.equal(s['sess-menu'].kind, 'terminal')
  assert.equal(s['sess-menu'].handle, 'term_menu-0001')
})

test('a working agent whose last tool was AskUserQuestion is running, not waiting', () => {
  // Seen live: after the person answers a menu, toolName stays AskUserQuestion while it works.
  const clone = structuredClone(ps)
  const a = clone.worktrees[0].agents[0]
  Object.assign(a, { state: 'working', mainAgent: { state: 'working', stateStartedAt: 1795426900000 }, agentWait: null, programStatus: { state: 'done' }, toolName: 'AskUserQuestion' })
  const s = byId(deriveSessions(clone))
  assert.equal(s['sess-menu'].lane, 'running')
  assert.equal(s['sess-menu'].attention, null)
})

test('archived workspaces, unmanaged projects and the coordinator are left out', () => {
  const all = deriveSessions(ps, { excludeSessions: ['sess-coordinator'] })
  assert.ok(!all.some((x) => x.sessionId === 'sess-coordinator'))
  assert.equal(all.filter((x) => x.sessionId === 'sess-idle').length, 1) // the archived copy is skipped
  const alphaOnly = deriveSessions(ps, { projects: ['repo-alpha'] })
  assert.deepEqual([...new Set(alphaOnly.map((x) => x.project))], ['alpha'])
})

test('agent list kinds override the address heuristic', () => {
  const s = byId(deriveSessions(ps, { agentList: { agents: [{ orcaSessionId: 'sess-question', kind: 'chat' }] } }))
  assert.equal(s['sess-question'].kind, 'chat')
})

test('fingerprint changes when the session moves on', () => {
  const a = ps.worktrees[0].agents[2]
  const before = fingerprint(a)
  assert.equal(before, fingerprint({ ...a }))
  assert.notEqual(before, fingerprint({ ...a, lastAssistantMessage: a.lastAssistantMessage + ' more' }))
  assert.notEqual(before, fingerprint({ ...a, state: 'working' }))
})

test('projects are grouped with the ones needing the person first', () => {
  const groups = groupByProject(deriveSessions(ps, { excludeSessions: ['sess-coordinator'] }))
  assert.equal(groups[0].project, 'alpha')
  assert.equal(groups[0].counts.human, 2)
  assert.equal(groups[1].counts.running, 1)
})

// Seen live: for a chat session Orca reported the first text block of the turn, so a question in
// the real final reply was missed and the session showed as idle instead of "Needs you".
test('a question in the final reply counts even when Orca reports an earlier text block', () => {
  const clone = structuredClone(ps)
  const chat = clone.worktrees[1].agents[2]
  Object.assign(chat, { state: 'done', lastAssistantMessage: 'Looking at the panel first.', activity: { ...chat.activity, unread: false } })
  assert.equal(byId(deriveSessions(clone))['sess-chat'].lane, 'idle')
  const finals = { 'sess-chat': { key: turnKey(chat), text: 'Done.\n\nShall I commit and push it?' } }
  const s = byId(deriveSessions(applyFinalReplies(clone, finals)))['sess-chat']
  assert.equal(s.lane, 'human')
  assert.equal(s.attention.text, 'Shall I commit and push it?')
  // The card fingerprint does not move when the transcript reading arrives.
  assert.equal(s.fingerprint, byId(deriveSessions(clone))['sess-chat'].fingerprint)
})

// Seen live: a long reply ending "1번부터 시작할까요? … 알려 주세요." showed as idle, because the
// transcript reading was cut off mid-reply and replaced the full message Orca reported.
test('a cut-off transcript reading does not hide the question at the end of the reply', () => {
  const clone = structuredClone(ps)
  const chat = clone.worktrees[1].agents[2]
  Object.assign(chat, { state: 'done', lastAssistantMessage: 'Long report.\n\nShall I start with step 1?\n\nThe report is in Reports/README.md.', activity: { ...chat.activity, unread: false } })
  const finals = { 'sess-chat': { key: turnKey(chat), text: 'Long report.\n\nThe remaining gap is the eye size, which you put on hold\n… (truncated)' } }
  const s = byId(deriveSessions(applyFinalReplies(clone, finals)))['sess-chat']
  assert.equal(s.lane, 'human')
  assert.equal(s.attention.text, 'Shall I start with step 1?')
})

test('a final reply from an earlier turn is ignored', () => {
  const clone = structuredClone(ps)
  const chat = clone.worktrees[1].agents[2]
  Object.assign(chat, { state: 'done', lastAssistantMessage: 'Looking at the panel first.', activity: { ...chat.activity, unread: false } })
  const finals = { 'sess-chat': { key: 'done:1', text: 'Shall I push?' } }
  assert.equal(byId(deriveSessions(applyFinalReplies(clone, finals)))['sess-chat'].lane, 'idle')
})

test('more ways of asking the person to decide are detected', () => {
  assert.equal(detectQuestion('Two options above.\nWhich would you prefer.'), 'Which would you prefer.')
  assert.equal(detectQuestion('Done.\nTell me whether to keep the old flag.'), 'Tell me whether to keep the old flag.')
  assert.equal(detectQuestion('정리했습니다.\n어느 쪽으로 할지 정해 주시면 이어서 작업하겠습니다.\n\n보고서는 Reports/README.md에 저장했습니다.'), '어느 쪽으로 할지 정해 주시면 이어서 작업하겠습니다.')
  assert.equal(detectQuestion('필요하면 말씀해 주세요'), '필요하면 말씀해 주세요')
  assert.equal(detectQuestion('테스트를 모두 통과했고 커밋했습니다.'), null)
})

// Seen live: a background shell kept the session "working" (monitoring) after the agent's turn
// ended with a question, so the board showed it as running instead of "Needs you".
test('a finished turn with a background shell still running counts as done', () => {
  const clone = structuredClone(ps)
  const a = clone.worktrees[1].agents[0]
  Object.assign(a, {
    state: 'working',
    stateStartedAt: 1795426800000,
    mainAgent: { state: 'done', stateStartedAt: 1795435535871 },
    programStatus: { state: 'done' },
    lastAssistantMessage: 'Two next steps.\n\nTell me whether to start with the generator or the layout copy, and I will continue.\n\nThe full report is in Reports/README.md.'
  })
  const s = byId(deriveSessions(clone))['sess-working']
  assert.equal(s.lane, 'human')
  assert.equal(s.background, true)
  assert.match(s.attention.text, /^Tell me whether/)
  assert.equal(turnKey(a), 'done:1795435535871')
})

// Seen live: the turn ended with "the analysis is running in the background" while a subagent
// worked on; the board showed it as idle, but the agent carries on when the subagent reports back.
test('a finished turn with a working subagent stays running', () => {
  const clone = structuredClone(ps)
  const a = clone.worktrees[1].agents[0]
  Object.assign(a, {
    state: 'working',
    stateStartedAt: 1795427463942,
    mainAgent: { state: 'done', stateStartedAt: 1795436202351 },
    programStatus: { state: 'working' },
    subagents: [{ id: 'a1', state: 'working', startedAt: 1795436182566, agentType: 'general-purpose', description: 'Face analysis' }],
    lastAssistantMessage: 'I handed the analysis to a background agent; I will summarize when it finishes.'
  })
  let s = byId(deriveSessions(clone))['sess-working']
  assert.equal(s.lane, 'running')
  assert.equal(s.background, false)
  // Once the subagent is done, the finished turn counts again (unread output: to review).
  a.subagents[0].state = 'done'
  s = byId(deriveSessions(clone))['sess-working']
  assert.equal(s.lane, a.activity?.unread ? 'review' : 'idle')
  assert.equal(s.background, true)
})
