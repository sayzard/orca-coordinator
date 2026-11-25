import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { deriveSessions, detectQuestion, detectStall, groupByProject, fingerprint, applyFinalReplies, turnKey } from '../cli/lib/lanes.mjs'
import { autoCardFor } from '../cli/lib/decisions.mjs'

const ps = JSON.parse(readFileSync(new URL('./fixtures/worktree-ps.json', import.meta.url), 'utf8'))
const byId = (sessions) => Object.fromEntries(sessions.map((s) => [s.sessionId, s]))

test('detects English questions at the end of a reply', () => {
  assert.equal(detectQuestion('I listed two options.\nWhich one should I go with?'), 'Which one should I go with?')
  assert.equal(detectQuestion('Two drafts are ready.\nLet me know which one you prefer.'), 'Let me know which one you prefer.')
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

// Seen live: a reply flagged the decision as a section heading instead of asking a question.
test('a line flagging a decision for the person counts, unless it says none is needed', () => {
  assert.equal(detectQuestion('분석했습니다.\n\n**결정이 필요한 것: 배포 시점**\n배포 시점은 보류해 두신 결정입니다.\n\n보고서는 README.md입니다.'), '결정이 필요한 것: 배포 시점')
  assert.equal(detectQuestion('Analysis done.\n## Decision needed: release date\nThe report is in README.md.'), 'Decision needed: release date')
  assert.equal(detectQuestion('1. **바로 할 수 있는 것 (결정 불필요):** 로그 수준을 낮춥니다.'), null)
  assert.equal(detectQuestion('결정이 필요 없는 작업만 진행했습니다.'), null)
  assert.equal(detectQuestion('Applied the fix; no decision needed.'), null)
  // The question nearest the end still wins over the heading above it.
  assert.equal(detectQuestion('**결정이 필요한 것: 배포 시점**\n보류 중입니다.\n1번부터 시작할까요?\n보고서는 README.md입니다.'), '1번부터 시작할까요?')
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

test('a terminal agent whose pane is gone (no term_ address) is left out', () => {
  const clone = structuredClone(ps)
  const menu = clone.worktrees.flatMap((w) => w.agents || []).find((a) => a.orcaSessionId === 'sess-menu')
  menu.address = null
  const s = byId(deriveSessions(clone, { agentList: { agents: [{ orcaSessionId: 'sess-menu', kind: 'terminal' }] } }))
  assert.equal(s['sess-menu'], undefined)
  // A chat session has an orca_session_id: address and stays.
  assert.ok(s['sess-chat'])
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
  const finals = { 'sess-chat': { key: turnKey(chat), text: 'Long report.\n\nThe remaining work is in the second section, which\n… (truncated)' } }
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
  assert.equal(detectQuestion('테스트를 모두 통과했고 커밋했습니다.'), null)
})

// Detection round 2026-11-24: causes found in the labeled turns, with synthetic text.
// Optional follow-ups are offers; the person decided offers stay out of "Needs you".
test('an optional follow-up is not a pending question', () => {
  assert.equal(detectQuestion('Done.\nLet me know if you want the migration too.'), null)
  assert.equal(detectQuestion('Migration is done.\nIf you would like, I can also add a rollback script.'), null)
  assert.equal(detectQuestion('필요하면 말씀해 주세요'), null)
  assert.equal(detectQuestion('정리를 마쳤습니다.\n원하시면 요약본도 만들어 두겠습니다.'), null)
  assert.equal(detectQuestion('변경은 작업 폴더에만 있습니다. 병합이 필요하면 말씀해 주세요.'), null)
  assert.equal(detectQuestion('글자를 더 크게 하고 싶으면 알려 주세요.'), null)
  // A direct question or a request to choose still counts, with or without "if you want".
  assert.equal(detectQuestion('검증을 마쳤습니다.\n원하시면 지금 배포할까요?'), '원하시면 지금 배포할까요?')
  assert.equal(detectQuestion('두 안을 만들었습니다.\n어느 쪽을 원하시는지 알려 주세요.'), '어느 쪽을 원하시는지 알려 주세요.')
  assert.equal(detectQuestion('문서는 원하시면 나중에 고치겠습니다. 먼저 배포 시점을 정해 주세요.'), '문서는 원하시면 나중에 고치겠습니다. 먼저 배포 시점을 정해 주세요.')
})

test('a Korean question followed by notes on the same line is detected', () => {
  assert.equal(detectQuestion('시험은 모두 통과했습니다.\n설정 파일만 먼저 넣을까요? 나머지는 내일 봐도 됩니다.'), '설정 파일만 먼저 넣을까요? 나머지는 내일 봐도 됩니다.')
  assert.equal(detectQuestion('staging-2는 이제 꺼도 되는 장비인가요? 그렇다면 목록에서 빼겠습니다.'), 'staging-2는 이제 꺼도 되는 장비인가요? 그렇다면 목록에서 빼겠습니다.')
  // A question the agent answers itself is not an ask.
  assert.equal(detectQuestion('왜 빌드가 실패했을까요? 캐시 키가 잠금 파일을 무시했기 때문입니다. 키를 고쳤습니다.'), null)
})

test('requests for something only the person can do are detected', () => {
  assert.equal(detectQuestion('빌드를 올려 두었습니다.\n확인이 끝나면 `make release`를 실행해 주세요.'), '확인이 끝나면 `make release`를 실행해 주세요.')
  assert.equal(detectQuestion('이어서 하려면 배포 창에 관리자 암호를 넣어 주십시오.'), '이어서 하려면 배포 창에 관리자 암호를 넣어 주십시오.')
  assert.equal(detectQuestion('로그인 창에 인증 코드를 적고 확인 단추를 눌러 주세요.'), '로그인 창에 인증 코드를 적고 확인 단추를 눌러 주세요.')
  assert.equal(detectQuestion('이어 가려면 브라우저에서 카메라 사용을 허용해 주세요.'), '이어 가려면 브라우저에서 카메라 사용을 허용해 주세요.')
  assert.equal(detectQuestion('준비되면 "시작"이라고 해 주세요.'), '준비되면 "시작"이라고 해 주세요.')
  assert.equal(detectQuestion('로그 파일을 보내 주시면 원인을 찾아보겠습니다.'), '로그 파일을 보내 주시면 원인을 찾아보겠습니다.')
  assert.equal(detectQuestion('결과를 채널에 보냈습니다. 로그는 logs/에 넣어 두었습니다.'), null)
})

test('more lines that leave a choice with the person are detected', () => {
  assert.equal(detectQuestion('작업에 앞서 정해 주실 것이 두 가지 있습니다.\n캐시와 보관 기간입니다.'), '작업에 앞서 정해 주실 것이 두 가지 있습니다.')
  assert.equal(detectQuestion('자동으로는 고를 수 없어서, 표를 나눌지 한 장으로 둘지 정하셔야 합니다.'), '자동으로는 고를 수 없어서, 표를 나눌지 한 장으로 둘지 정하셔야 합니다.')
  assert.equal(detectQuestion('아직 남은 결정이 있습니다.\n보관 기간입니다.'), '아직 남은 결정이 있습니다.')
  assert.equal(detectQuestion('글꼴은 아래 셋 가운데 고르시면 됩니다.\n- 고딕\n- 명조\n- 둥근 글꼴'), '글꼴은 아래 셋 가운데 고르시면 됩니다.')
  assert.equal(detectQuestion('처리할 항목은 모두 끝났고 남은 결정도 없습니다.'), null)
  assert.equal(detectQuestion('번역 파일이 비어 있어 검사가 멈춥니다. 언어를 고르시면 다시 돕니다.'), null)
  assert.equal(detectQuestion('방침을 정하실 때까지는 기존 값을 그대로 씁니다.'), null)
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

// Seen live: newer Orca builds list the subagent under `children` with kind `agent`.
test('a working subagent reported under children keeps the session running', () => {
  const clone = structuredClone(ps)
  const a = clone.worktrees[1].agents[0]
  Object.assign(a, {
    state: 'working',
    mainAgent: { state: 'done', outcome: 'success', stateStartedAt: 1795436202351 },
    children: [{ id: 'c1', kind: 'agent', name: 'general-purpose', state: 'working', membership: 'live' }],
    lastAssistantMessage: 'I asked a reviewer for the direction; I will apply it when it answers.'
  })
  let s = byId(deriveSessions(clone))['sess-working']
  assert.equal(s.lane, 'running')
  a.children[0].state = 'done'
  s = byId(deriveSessions(clone))['sess-working']
  assert.notEqual(s.lane, 'running')
})

// Reported by the person: a turn ended with a plan and "I'll go in this order, starting with
// step 2 now", with nothing running. Nothing happens until the person says "go ahead", yet the
// board showed the session as idle.
test('a turn that stops right after announcing its next step is flagged as stalled', () => {
  assert.equal(detectStall('Plan:\n1. Move the parser into its own module\n2. Add the retry test\nI\'ll go in this order and start with step 1 now.'), "I'll go in this order and start with step 1 now.")
  assert.equal(detectStall('작업을 셋으로 나눴습니다.\n1. 파서 분리\n2. 캐시 비우기\n3. 문서 갱신\n위 차례대로 곧바로 착수하겠습니다. 2단계 캐시 비우기부터 시작합니다.'), '2단계 캐시 비우기부터 시작합니다.')
  assert.equal(detectStall('다음으로 로그 수준을 낮추고 재시작하겠습니다.'), '다음으로 로그 수준을 낮추고 재시작하겠습니다.')
  assert.equal(detectStall('빌드 캐시가 비어 있습니다. 설정 파일부터 점검합니다.'), '설정 파일부터 점검합니다.')
  assert.equal(detectStall("The schema is ready. Next, I'll add the retry test."), "Next, I'll add the retry test.")
  // "Unless you object" still stops the turn: the work waits for the person.
  assert.ok(detectStall("I'll proceed with the migration next unless you object."))
  // The card asks whether to proceed.
  assert.equal(detectQuestion('다음으로 로그 수준을 낮추고 재시작하겠습니다.'), '진행할까요? “다음으로 로그 수준을 낮추고 재시작하겠습니다.”')
  assert.equal(detectQuestion("The schema is ready. Next, I'll add the retry test."), "Go ahead? “Next, I'll add the retry test.”")
  // A real question near the end wins over the announcement.
  assert.equal(detectQuestion('배포를 오늘 할까요, 내일 할까요?\n답을 주시기 전에 먼저 릴리스 노트부터 다듬겠습니다.'), '배포를 오늘 할까요, 내일 할까요?')
})

test('work that resumes by itself, waits for later or is a promise is not a stalled turn', () => {
  // A job is still going and the agent carries on when it reports.
  assert.equal(detectStall('색인을 새로 만들고 있습니다. 작업이 완료되면 건수를 비교해 보고하겠습니다.'), null)
  assert.equal(detectStall("The import is running in the background. When it finishes I'll compare the row counts and report."), null)
  assert.equal(detectStall('렌더 작업이 백그라운드에서 실행 중입니다.\n다음으로 README를 고치겠습니다.'), null)
  assert.equal(detectStall("The reviewer subagent is still working.\nNext, I'll apply its notes."), null)
  // Remaining work for later, for someone else, or behind an outside event.
  assert.equal(detectStall('Deployed to staging.\nRemaining: update the changelog and tag the release after QA.'), null)
  assert.equal(detectStall('리뷰가 승인되면 배포 태그를 먼저 붙이겠습니다.'), null)
  assert.equal(detectStall("I'll rebase once the PR is merged."), null)
  assert.equal(detectStall('릴리스 태그는 내일 오전에 먼저 붙이겠습니다.'), null)
  // Standing promises, refusals and offers.
  assert.equal(detectStall('앞으로는 마이그레이션을 먼저 검증하겠습니다.'), null)
  assert.equal(detectStall("From now on I'll batch the deploys first."), null)
  assert.equal(detectStall('태그는 붙이지 않고 우선 초안으로만 남겨 두겠습니다.'), null)
  assert.equal(detectStall('원하시면 지금 바로 스키마를 옮기겠습니다.'), null)
  assert.equal(detectStall("If you want, I'll start with step 1 now."), null)
  // A report of what was done, including a step announced earlier in the same turn.
  assert.equal(detectStall('먼저 파서를 떼어 내겠습니다.\n파서를 떼어 냈고 단위 테스트 12개가 통과합니다.'), null)
  assert.equal(detectStall("First I'll split the parser.\nDone: the parser is split and all tests pass."), null)
  assert.equal(detectQuestion('일정은 문서 갱신을 우선으로 짜겠습니다.'), null)
})

test('a stalled turn shows under "Needs you" with a go-ahead button, unless something still runs', () => {
  const reply = '작업을 셋으로 나눴습니다.\n위 차례대로 곧바로 착수하겠습니다. 2단계 캐시 비우기부터 시작합니다.'
  const clone = structuredClone(ps)
  const a = clone.worktrees[1].agents[0]
  Object.assign(a, { state: 'done', stateStartedAt: 1795435535871, programStatus: { state: 'done' }, toolName: null, lastAssistantMessage: reply })
  let s = byId(deriveSessions(clone))['sess-working']
  assert.equal(s.lane, 'human')
  assert.equal(s.attention.text, '진행할까요? “2단계 캐시 비우기부터 시작합니다.”')
  assert.equal(s.attention.stalled, true)
  assert.deepEqual(autoCardFor(s).options, [{ label: '진행', reply: '진행해 주세요.', send: true }])
  assert.equal(autoCardFor(s).reasonKey, 'auto.stalled')
  // A background shell is still running: it wakes the agent, so the person is not needed.
  Object.assign(a, { state: 'working', mainAgent: { state: 'done', stateStartedAt: 1795435535871 } })
  s = byId(deriveSessions(clone))['sess-working']
  assert.equal(s.background, true)
  assert.equal(s.attention, null)
  assert.notEqual(s.lane, 'human')
  // The classifier's stalled decision is dropped the same way; its other decisions are not.
  a.turnClass = { label: 'decision', question: '진행할까요?', options: [{ label: '진행', reply: '진행해 주세요.' }], stalled: true }
  assert.equal(byId(deriveSessions(clone))['sess-working'].attention, null)
  a.turnClass = { label: 'decision', question: '어느 리전에 배포할까요?', options: [] }
  assert.equal(byId(deriveSessions(clone))['sess-working'].lane, 'human')
  // A working subagent keeps the session running.
  delete a.turnClass
  a.subagents = [{ id: 'a1', state: 'working' }]
  assert.equal(byId(deriveSessions(clone))['sess-working'].lane, 'running')
  // Remaining work for later is a report, with or without anything running.
  Object.assign(a, { state: 'done', mainAgent: undefined, subagents: [], lastAssistantMessage: 'Deployed to staging.\nRemaining: update the changelog and tag the release after QA.' })
  s = byId(deriveSessions(clone))['sess-working']
  assert.equal(s.attention, null)
  assert.notEqual(s.lane, 'human')
})
