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

test('a question high above the last lines is not a pending question', () => {
  assert.equal(detectQuestion('이렇게 할까요?\n1\n2\n3\n4\n5\n완료.'), null)
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
  Object.assign(a, { state: 'working', agentWait: null, programStatus: { state: 'done' }, toolName: 'AskUserQuestion' })
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

test('a final reply from an earlier turn is ignored', () => {
  const clone = structuredClone(ps)
  const chat = clone.worktrees[1].agents[2]
  Object.assign(chat, { state: 'done', lastAssistantMessage: 'Looking at the panel first.', activity: { ...chat.activity, unread: false } })
  const finals = { 'sess-chat': { key: 'done:1', text: 'Shall I push?' } }
  assert.equal(byId(deriveSessions(applyFinalReplies(clone, finals)))['sess-chat'].lane, 'idle')
})
