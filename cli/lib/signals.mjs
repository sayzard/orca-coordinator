// Evidence for tuning question detection, collected while the board is used. Kept locally in
// eval/signals.jsonl under the coordinator home (private conversation text: never commit it).
//   dismissed           — the person dismissed a card: a possible false alarm
//   card_answered       — the person answered a card: the alarm was right
//   answered_unflagged  — a finished turn had no card, then the person replied: a possible miss
//   answered_flagged    — a turn with a card, then the person replied in the session
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dataPath } from './paths.mjs'
import { readJson, writeJson } from './store.mjs'

const SIGNALS = 'eval/signals.jsonl'
const WATCH = 'cache/turn-watch.json'
const MAX_BYTES = 4 * 1024 * 1024
const KEEP_LINES = 3000
const REPLY_CHARS = 3000

export function signalsPath() {
  return dataPath(SIGNALS)
}

/** Appends one signal; the file is cut back to its newest lines when it grows past MAX_BYTES. Best effort. */
export function recordSignal(event) {
  try {
    mkdirSync(dataPath('eval'), { recursive: true, mode: 0o700 })
    appendFileSync(signalsPath(), JSON.stringify({ at: Date.now(), ...event }) + '\n', { mode: 0o600 })
    if (statSync(signalsPath()).size > MAX_BYTES) {
      const lines = readFileSync(signalsPath(), 'utf8').trim().split('\n')
      writeFileSync(signalsPath(), lines.slice(-KEEP_LINES).join('\n') + '\n', { mode: 0o600 })
    }
  } catch {}
}

export function readSignals() {
  try {
    return readFileSync(signalsPath(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

const finished = (s) => s.state === 'done' || s.state === 'waiting'

function about(s) {
  return { sessionId: s.sessionId, kind: s.kind, agent: s.agent, project: s.project }
}

/**
 * Compares the sessions with the previous look. When a session that had finished a turn gets a
 * new prompt, the person (or someone for them) replied to that turn: record whether the board had
 * flagged it. Pure apart from the watch file and the signal log; never throws.
 */
export function watchTurns(sessions) {
  try {
    const watch = readJson(WATCH, {})
    const next = {}
    for (const s of sessions) {
      const prev = watch[s.sessionId]
      if (prev && finished(prev) && prev.reply && s.prompt && s.prompt !== prev.prompt) {
        recordSignal({ type: prev.lane === 'human' ? 'answered_flagged' : 'answered_unflagged', ...about(s), handled: Boolean(prev.handled), line: prev.line || null, reply: prev.reply, next: s.prompt.slice(0, 300) })
      }
      next[s.sessionId] = {
        state: s.state,
        lane: s.lane,
        prompt: s.prompt || '',
        handled: Boolean(s.handled),
        line: s.attention?.text || null,
        // Keep the finished turn's reply until the next turn ends.
        reply: finished(s) ? (s.replyTail || '').slice(-REPLY_CHARS) : prev?.reply || ''
      }
    }
    writeJson(WATCH, next)
  } catch {}
}

/** A card was dismissed or answered on the board. */
export function recordCardOutcome(type, card, session) {
  recordSignal({ type, ...(session ? about(session) : { sessionId: card?.sessionId || null }), line: card?.question || null, source: card?.source || null, reply: (session?.replyTail || '').slice(-REPLY_CHARS) })
}
