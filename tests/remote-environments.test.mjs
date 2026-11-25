// Worktrees on paired Orca servers: a local `worktree ps` names them only under
// hostScope.omittedHostSelectors, so the board asks each server and merges the results.
// Shapes follow a live capture (Orca on a paired Linux server), with names and text replaced.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.COORD_HOME = mkdtempSync(join(tmpdir(), 'coord-test-'))
const { omittedEnvironments, withRemoteWorktrees } = await import('../cli/lib/data.mjs')
const { deriveSessions, groupByProject } = await import('../cli/lib/lanes.mjs')
const { boardCards } = await import('../cli/lib/decisions.mjs')

const local = {
  worktrees: [{ worktreeId: 'repo-local::/work/app', repoId: 'repo-local', repo: 'app', displayName: 'app', path: '/work/app', address: { worktree: 'id:repo-local::/work/app' }, agents: [] }],
  hostScope: {
    hostIds: ['local', 'ssh:ssh-1'],
    omittedHostIds: ['runtime:env-gpu', 'runtime:env-down', 'ssh:ssh-2'],
    omittedHostSelectors: [
      { hostId: 'runtime:env-gpu', selector: '--environment gpu-box' },
      { hostId: 'runtime:env-down', selector: '--environment down-box' },
      { hostId: 'ssh:ssh-2', selector: null }
    ]
  }
}

function remoteWorktree({ state = 'working', lastAssistantMessage = 'Working on it.', paneKey = 'structured-agent-session-uuid-1:tab-1' } = {}) {
  return {
    worktreeId: 'repo-remote::/home/me/svc',
    repoId: 'repo-remote',
    hostId: 'local',
    repo: 'svc',
    displayName: 'svc',
    path: '/home/me/svc',
    isArchived: false,
    lastActivityAt: 1000,
    environment: { id: 'env-gpu', name: 'gpu-box' },
    address: { environment: 'env-gpu', worktree: 'id:repo-remote::/home/me/svc' },
    // No orcaSessionId, no address and no activity: what a paired server reports today.
    agents: [{ paneKey, state, agentType: 'antigravity', prompt: 'Fix the fare loader', conversationName: 'Fix the fare loader', lastAssistantMessage, mainAgent: { state, stateStartedAt: 900 }, stateStartedAt: 900, updatedAt: 1000, children: [] }]
  }
}

test('only --environment selectors are queried', () => {
  assert.deepEqual(omittedEnvironments(local), ['gpu-box', 'down-box'])
  assert.deepEqual(omittedEnvironments({ worktrees: [] }), [])
})

test('remote worktrees are merged; an unreachable server is left out', async () => {
  const asked = []
  const ps = await withRemoteWorktrees(local, async (name) => {
    asked.push(name)
    if (name === 'down-box') throw Object.assign(new Error('remote_runtime_unavailable'), { code: 'remote_runtime_unavailable' })
    return { worktrees: [remoteWorktree()] }
  })
  assert.deepEqual(asked, ['gpu-box', 'down-box'])
  assert.deepEqual(ps.worktrees.map((w) => w.repo), ['app', 'svc'])
  assert.equal(ps.hostScope, local.hostScope)
})

test('a remote session shows as running, keyed by server and pane', () => {
  const [s] = deriveSessions({ worktrees: [remoteWorktree()] })
  assert.equal(s.sessionId, 'remote:env-gpu:structured-agent-session-uuid-1:tab-1')
  assert.equal(s.lane, 'running')
  assert.equal(s.kind, 'chat')
  assert.equal(s.project, 'svc @ gpu-box')
  assert.equal(s.environment, 'gpu-box')
  assert.equal(s.environmentId, 'env-gpu')
  assert.equal(s.workspaceSelector, 'id:repo-remote::/home/me/svc')
  const [g] = groupByProject([s])
  assert.equal(g.counts.running, 1)
  // The same poll twice gives the same id (decisions and history are keyed by it).
  assert.equal(deriveSessions({ worktrees: [remoteWorktree()] })[0].sessionId, s.sessionId)
})

test('a remote question is answered in the session, not from the board', () => {
  const sessions = deriveSessions({ worktrees: [remoteWorktree({ state: 'done', lastAssistantMessage: 'Two fixes are possible.\nWhich one should I go with?' })] })
  assert.equal(sessions[0].lane, 'human')
  assert.equal(sessions[0].attention.canReply, false)
  const [card] = boardCards(sessions)
  assert.equal(card.canReply, false)
  assert.equal(card.target.environmentId, 'env-gpu')
})

test('a local agent without orcaSessionId is still skipped', () => {
  const w = remoteWorktree()
  delete w.environment
  assert.deepEqual(deriveSessions({ worktrees: [w] }), [])
})

// Orca stamps this machine's own worktrees (ssh hosts too) with environment { id: 'local' }.
test("environment 'local' is this machine: plain project name, replies allowed", () => {
  const w = { ...remoteWorktree({ state: 'done', lastAssistantMessage: 'Which one should I go with?' }), environment: { id: 'local', name: 'local' }, address: { environment: 'local', worktree: 'id:repo-remote::/home/me/svc' } }
  w.agents = w.agents.map((a) => ({ ...a, orcaSessionId: 'sess-local' }))
  const [s] = deriveSessions({ worktrees: [w] })
  assert.equal(s.sessionId, 'sess-local')
  assert.equal(s.project, 'svc')
  assert.equal(s.environment, null)
  assert.equal(s.attention.canReply, true)
  w.agents = w.agents.map(({ orcaSessionId, ...a }) => a)
  assert.deepEqual(deriveSessions({ worktrees: [w] }), [])
})
