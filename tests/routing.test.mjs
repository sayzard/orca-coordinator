import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveRoute, remainingPercent, usageSummary } from '../cli/lib/routing.mjs'
import { DEFAULT_ROUTING } from '../cli/lib/config.mjs'

const rateLimits = JSON.parse(readFileSync(new URL('./fixtures/rate-limits.json', import.meta.url), 'utf8'))
const installed = new Set(['claude', 'codex', 'gemini'])

test('remaining percent uses the tightest live window', () => {
  assert.equal(remainingPercent(rateLimits, 'codex', 'gpt-6.2-sol'), 32)
  assert.equal(remainingPercent(rateLimits, 'claude', 'claude-opus-5-5'), 96)
})

test('fable models also count the fableWeekly window', () => {
  assert.equal(remainingPercent(rateLimits, 'claude', 'claude-fable-5-2'), 10)
})

test('unavailable providers report unknown, not zero', () => {
  assert.equal(remainingPercent(rateLimits, 'gemini', 'x'), null)
  assert.equal(remainingPercent(null, 'claude', 'x'), null)
})

test('expired windows are ignored', () => {
  const rl = { claude: { status: 'ok', weekly: { usedPercent: 99, resetsAt: 1 } } }
  assert.equal(remainingPercent(rl, 'claude', 'claude-opus-5-5', 1000), null)
})

test('grade A skips fable when its weekly window is under the reserve', () => {
  const r = resolveRoute({ grade: 'A', routing: DEFAULT_ROUTING, installed, rateLimits, reservePercent: 15 })
  assert.equal(r.ok, true)
  assert.deepEqual(r.choice, { agent: 'claude', model: 'claude-opus-5-5', effort: 'max' })
  assert.match(r.candidates[0].skipped, /low_usage/)
  assert.match(r.reason, /claude-fable-5-2/)
})

test('first candidate wins when it has room', () => {
  const r = resolveRoute({ grade: 'C', routing: DEFAULT_ROUTING, installed, rateLimits })
  assert.deepEqual(r.choice, { agent: 'claude', model: 'claude-opus-5-5', effort: 'high' })
  assert.equal(r.degraded, false)
})

test('excluded and not-installed agents are skipped', () => {
  const r = resolveRoute({ grade: 'D', routing: DEFAULT_ROUTING, installed: new Set(['codex']), rateLimits })
  assert.equal(r.choice.agent, 'codex')
  assert.equal(r.candidates[0].skipped, 'not_installed')
  const r2 = resolveRoute({ grade: 'D', routing: DEFAULT_ROUTING, installed, excluded: ['claude'], rateLimits })
  assert.equal(r2.choice.agent, 'codex')
  assert.equal(r2.candidates[0].skipped, 'excluded')
})

test('needsHooks keeps only claude and codex', () => {
  const routing = { C: [{ agent: 'gemini', model: 'g', effort: 'high' }, { agent: 'codex', model: 'gpt-6.2-sol', effort: 'high' }] }
  const r = resolveRoute({ grade: 'C', routing, installed, rateLimits, needsHooks: true })
  assert.equal(r.choice.agent, 'codex')
  assert.equal(r.candidates[0].skipped, 'no_hooks')
})

test('when every candidate is low, fall back to the most room and flag it', () => {
  const rl = { claude: { status: 'ok', weekly: { usedPercent: 95 } }, codex: { status: 'ok', weekly: { usedPercent: 90 } } }
  const r = resolveRoute({ grade: 'D', routing: DEFAULT_ROUTING, installed, rateLimits: rl, reservePercent: 15 })
  assert.equal(r.ok, true)
  assert.equal(r.degraded, true)
  assert.equal(r.choice.agent, 'codex')
})

test('unknown grade has no route', () => {
  const r = resolveRoute({ grade: 'Z', routing: DEFAULT_ROUTING })
  assert.equal(r.ok, false)
})

test('usage summary lists only providers with status', () => {
  const rows = usageSummary(rateLimits)
  assert.deepEqual(rows.map((r) => r.provider), ['claude', 'codex', 'gemini'])
  assert.equal(rows[2].error, 'Gemini CLI OAuth is disabled in settings')
})
