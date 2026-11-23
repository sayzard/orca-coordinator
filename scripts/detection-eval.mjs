#!/usr/bin/env node
// Measures how well the board's question detection (cli/lib/lanes.mjs detectQuestion) tells which
// finished turns need the person. See docs/detection-rubric.md for the labels.
//
// The corpus is private conversation text: it lives in <coordinator home>/eval/ and is never
// committed. Tests use synthetic text only.
//
//   node scripts/detection-eval.mjs build [--days 14]   collect turn ends (Claude Code, Codex, board signals)
//   node scripts/detection-eval.mjs queue [--n 40] [--split tune|holdout|all]   unlabeled items to label
//   node scripts/detection-eval.mjs label <file.jsonl>  import labels {id,label,line?,by,note?}
//   node scripts/detection-eval.mjs eval [--json] [--model <id>]   rules (and a model) per split; tune errors to a file
//   node scripts/detection-eval.mjs stats
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { detectQuestion } from '../cli/lib/lanes.mjs'
import { dataPath } from '../cli/lib/paths.mjs'
import { readSignals } from '../cli/lib/signals.mjs'
import { classifyText, classifierSettings } from '../cli/lib/classify.mjs'

export const LABELS = ['decision', 'offer', 'none']
const REPLY_CHARS = 4000
const NEXT_CHARS = 300

// Messages in a transcript that the person did not type.
const NOT_PERSON = /^(<|Caveat:|This session is being continued|Another Claude session|\[Coordinator Board|\[Request interrupted|\/[a-z]|You have \d+ orchestration message)/i

export function itemId(reply, next) {
  return createHash('sha1').update(`${reply.slice(-2000)}\u0000${next}`).digest('hex').slice(0, 16)
}

/** About 30 % of items, chosen by id, are held out: tune on the rest, report both. */
export function splitOf(id) {
  return parseInt(id.slice(0, 2), 16) < 77 ? 'holdout' : 'tune'
}

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '')

function isPersonMessage(m) {
  const c = m.message?.content
  if (m.isMeta || m.isSidechain || m.isCompactSummary) return false
  if (Array.isArray(c) && c.some((b) => b?.type === 'tool_result')) return false
  const t = textOf(c).trim()
  return Boolean(t) && !NOT_PERSON.test(t) && !t.includes('<command-name>') && !t.includes('<teammate-message')
}

/**
 * Turn ends in a Claude Code transcript: the last assistant text of a turn whose final message
 * stopped with end_turn, paired with the next message the person typed.
 * @param {Iterable<object>|AsyncIterable<object>} records parsed JSONL records
 */
export async function claudeTurnEnds(records) {
  const out = []
  let text = null
  let ended = false
  for await (const m of records) {
    if (!m || m.isSidechain) continue
    if (m.type === 'assistant') {
      const t = textOf(m.message?.content).trim()
      if (t) text = t
      const sr = m.message?.stop_reason
      if (sr) ended = sr === 'end_turn'
    } else if (m.type === 'user') {
      if (isPersonMessage(m)) {
        if (text && ended) out.push({ reply: text, next: textOf(m.message.content).trim(), at: Date.parse(m.timestamp) || null })
        text = null
        ended = false
      } else if (m.isCompactSummary) {
        text = null
        ended = false
      }
    }
  }
  return out
}

const codexText = (content) => (Array.isArray(content) ? content.filter((b) => b?.type === 'input_text').map((b) => b.text).join('\n') : String(content || ''))

/** Turn ends in a Codex rollout: task_complete's last_agent_message, paired with the next user message. */
export async function codexTurnEnds(records) {
  const out = []
  let pending = null
  for await (const m of records) {
    const p = m?.payload || {}
    if (m?.type === 'event_msg' && p.type === 'task_complete' && p.last_agent_message) {
      pending = { reply: String(p.last_agent_message), at: Number(p.completed_at) * 1000 || null }
    } else if (m?.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      const t = codexText(p.content).trim()
      if (!t || NOT_PERSON.test(t) || t.startsWith('<environment_context>') || t.startsWith('# AGENTS.md')) continue
      if (pending) out.push({ ...pending, next: t })
      pending = null
    }
  }
  return out
}

async function* jsonl(file) {
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    if (!line || line.length > 2_000_000) continue
    try {
      yield JSON.parse(line)
    } catch {}
  }
}

function recentFiles(root, since, depth = 4) {
  const out = []
  const walk = (dir, d) => {
    let names = []
    try {
      names = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of names) {
      const p = join(dir, e.name)
      if (e.isDirectory() && d > 0) walk(p, d - 1)
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          if (statSync(p).mtimeMs > since) out.push(p)
        } catch {}
      }
    }
  }
  walk(root, depth)
  return out
}

/** One corpus item. Text is cut to what the judge and the detector need. */
export function toItem(source, project, { reply, next, at }, extra = {}) {
  const r = reply.slice(-REPLY_CHARS)
  const n = (next || '').slice(0, NEXT_CHARS)
  const id = itemId(r, n)
  return { id, split: splitOf(id), source, project, at: at || null, reply: r, next: n, ...extra }
}

/** Board signals become items too; a signal is evidence for the judge, never a label. */
export function signalItems(signals) {
  return signals
    .filter((s) => s.reply)
    .map((s) => toItem('board', s.project || '', { reply: s.reply, next: s.next || '', at: s.at }, { signal: s.type, flaggedLine: s.line || null }))
}

const evalDir = () => dataPath('eval')
const file = (name) => join(evalDir(), name)

function readJsonl(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
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
}

/** Latest label per id; a person's label beats a model's. */
export function latestLabels(rows) {
  const map = new Map()
  for (const r of rows) {
    if (!r?.id || !LABELS.includes(r.label)) continue
    const cur = map.get(r.id)
    const person = String(r.by || '').startsWith('person')
    if (!cur || person || !String(cur.by || '').startsWith('person')) map.set(r.id, r)
  }
  return map
}

/**
 * Detection against labels. "flagged" means the board would show the turn under "Needs you".
 * decision: recall and precision. offer: only how often it is flagged (where offers belong is the
 * person's call). none: false-alarm rate.
 */
export function score(items, labels, detect = detectQuestion, classOf = null) {
  const c = { decision: { n: 0, flagged: 0 }, offer: { n: 0, flagged: 0 }, none: { n: 0, flagged: 0 } }
  const errors = []
  let agree = 0
  for (const it of items) {
    const l = labels.get(it.id)
    if (!l) continue
    if (classOf && classOf(it) === l.label) agree += 1
    const line = detect(it.reply, it)
    const flagged = Boolean(line)
    c[l.label].n += 1
    if (flagged) c[l.label].flagged += 1
    if ((l.label === 'decision' && !flagged) || (l.label === 'none' && flagged) || (l.label === 'offer' && flagged)) {
      errors.push({ id: it.id, label: l.label, kind: l.label === 'decision' ? 'missed' : 'flagged', detected: line, expectedLine: l.line || null })
    }
  }
  const flaggedAll = c.decision.flagged + c.offer.flagged + c.none.flagged
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null)
  return {
    labeled: c.decision.n + c.offer.n + c.none.n,
    counts: c,
    decisionRecall: pct(c.decision.flagged, c.decision.n),
    decisionPrecision: pct(c.decision.flagged, flaggedAll),
    offerFlaggedRate: pct(c.offer.flagged, c.offer.n),
    noneFalseAlarmRate: pct(c.none.flagged, c.none.n),
    ...(classOf ? { threeClassAgreement: pct(agree, c.decision.n + c.offer.n + c.none.n) } : {}),
    errors
  }
}

async function build({ days }) {
  mkdirSync(evalDir(), { recursive: true, mode: 0o700 })
  const since = Date.now() - days * 86400_000
  const existing = new Set(readJsonl(file('corpus.jsonl')).map((i) => i.id))
  const fresh = []
  const add = (item) => {
    if (!item.reply.trim() || existing.has(item.id)) return
    existing.add(item.id)
    fresh.push(item)
  }
  for (const f of recentFiles(join(homedir(), '.claude/projects'), since, 1)) {
    const project = f.split('/.claude/projects/')[1]?.split('/')[0] || ''
    for (const t of await claudeTurnEnds(jsonl(f))) add(toItem('claude', project, t))
  }
  for (const f of recentFiles(join(homedir(), '.codex/sessions'), since, 4)) {
    for (const t of await codexTurnEnds(jsonl(f))) add(toItem('codex', '', t))
  }
  for (const item of signalItems(readSignals())) add(item)
  if (fresh.length) appendFileSync(file('corpus.jsonl'), fresh.map((i) => JSON.stringify(i)).join('\n') + '\n', { mode: 0o600 })
  return { added: fresh.length, total: existing.size }
}

/** Unlabeled items for the judge: board signals first, then a stable shuffle. */
function queue({ n, split }) {
  const labels = latestLabels(readJsonl(file('labels.jsonl')))
  const todo = readJsonl(file('corpus.jsonl')).filter((i) => !labels.has(i.id) && (split === 'all' || i.split === split))
  todo.sort((a, b) => Number(Boolean(b.signal)) - Number(Boolean(a.signal)) || a.id.localeCompare(b.id))
  const picked = todo.slice(0, n).map((i) => ({ id: i.id, split: i.split, source: i.source, signal: i.signal || null, flaggedLine: i.flaggedLine || null, replyTail: i.reply.split('\n').filter((l) => l.trim()).slice(-40).join('\n'), next: i.next }))
  const out = file(`queue-${new Date().toISOString().slice(0, 10)}.jsonl`)
  writeFileSync(out, picked.map((i) => JSON.stringify(i)).join('\n') + (picked.length ? '\n' : ''), { mode: 0o600 })
  return { file: out, count: picked.length, remaining: Math.max(0, todo.length - picked.length) }
}

function label(path) {
  const rows = readJsonl(path).filter((r) => r.id && LABELS.includes(r.label))
  const known = new Set(readJsonl(file('corpus.jsonl')).map((i) => i.id))
  const good = rows.filter((r) => known.has(r.id)).map((r) => ({ id: r.id, label: r.label, line: r.line || null, by: r.by || 'unknown', note: r.note || null, at: Date.now() }))
  if (good.length) appendFileSync(file('labels.jsonl'), good.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 })
  return { imported: good.length, skipped: rows.length - good.length }
}

/** Model labels for the labeled items, cached per model and prompt version (only new items are sent). */
async function modelPredictions(items, model) {
  // `jev-…` models go to TypeSafe AI (TYPESAFE_API_KEY); anything else to the claude CLI.
  const jev = model.startsWith('jev')
  const settings = classifierSettings({ classifier: { enabled: true, provider: jev ? 'jev' : 'claude', ...(jev ? { jevModel: model } : { model }) } })
  if (!settings.ready) throw new Error('no_key: set TYPESAFE_API_KEY to evaluate Jev')
  const path = file(`model-${model}-p${settings.promptId}.jsonl`)
  const done = new Map(readJsonl(path).map((r) => [r.id, r]))
  const todo = items.filter((i) => !done.has(i.id))
  let next = 0
  const fresh = []
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < todo.length) {
        const it = todo[next++]
        const r = await classifyText(it.reply, settings)
        if (!r.error) fresh.push({ id: it.id, label: r.label, question: r.question, options: r.options || [] })
      }
    })
  )
  if (fresh.length) appendFileSync(path, fresh.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 })
  for (const r of fresh) done.set(r.id, r)
  return { predictions: done, failed: todo.length - fresh.length, promptId: settings.promptId }
}

async function evaluate({ model } = {}) {
  const items = readJsonl(file('corpus.jsonl'))
  const labels = latestLabels(readJsonl(file('labels.jsonl')))
  const strip = ({ errors, ...rest }) => rest
  const split = (name) => items.filter((i) => i.split === name)
  const tune = score(split('tune'), labels)
  const holdout = score(split('holdout'), labels)
  // Only tune errors are written out: tune on them, keep holdout as the honest check.
  writeFileSync(file('errors-tune.jsonl'), tune.errors.map((e) => JSON.stringify({ ...e, ...pick(items, e.id) })).join('\n') + (tune.errors.length ? '\n' : ''), { mode: 0o600 })
  const result = { at: new Date().toISOString(), corpus: items.length, rules: { tune: strip(tune), holdout: strip(holdout) }, tuneErrorsFile: file('errors-tune.jsonl') }
  if (model) {
    const { predictions, failed, promptId } = await modelPredictions(items.filter((i) => labels.has(i.id)), model)
    const detect = (_reply, it) => (predictions.get(it.id)?.label === 'decision' ? predictions.get(it.id).question || 'decision' : null)
    const classOf = (it) => predictions.get(it.id)?.label
    const mt = score(split('tune'), labels, detect, classOf)
    const mh = score(split('holdout'), labels, detect, classOf)
    writeFileSync(file(`errors-tune-${model}.jsonl`), mt.errors.map((e) => JSON.stringify({ ...e, predicted: classOf({ id: e.id }), ...pick(items, e.id) })).join('\n') + (mt.errors.length ? '\n' : ''), { mode: 0o600 })
    result.model = { id: model, promptId, failed, tune: strip(mt), holdout: strip(mh), tuneErrorsFile: file(`errors-tune-${model}.jsonl`) }
  }
  return result
}

function pick(items, id) {
  const it = items.find((i) => i.id === id)
  return it ? { replyTail: it.reply.split('\n').filter((l) => l.trim()).slice(-25).join('\n'), next: it.next } : {}
}

function stats() {
  const items = readJsonl(file('corpus.jsonl'))
  const labels = latestLabels(readJsonl(file('labels.jsonl')))
  const by = (f) => items.reduce((m, i) => ((m[f(i)] = (m[f(i)] || 0) + 1), m), {})
  const labelCounts = [...labels.values()].reduce((m, l) => ((m[l.label] = (m[l.label] || 0) + 1), m), {})
  return { corpus: items.length, bySource: by((i) => i.source), bySplit: by((i) => i.split), labeled: labels.size, labelCounts, signals: readSignals().length }
}

function text(r) {
  const fmt = (s) => `labeled ${s.labeled} · decision recall ${s.decisionRecall ?? '-'}% · precision ${s.decisionPrecision ?? '-'}% · offers flagged ${s.offerFlaggedRate ?? '-'}% · none false alarms ${s.noneFalseAlarmRate ?? '-'}%${s.threeClassAgreement != null ? ` · 3-class agreement ${s.threeClassAgreement}%` : ''}`
  const lines = [`corpus ${r.corpus}`, 'rules', `  tune:    ${fmt(r.rules.tune)}`, `  holdout: ${fmt(r.rules.holdout)}`]
  if (r.model) lines.push(`model ${r.model.id} (prompt ${r.model.promptId}${r.model.failed ? `, ${r.model.failed} failed` : ''})`, `  tune:    ${fmt(r.model.tune)}`, `  holdout: ${fmt(r.model.holdout)}`)
  lines.push(`tune errors: ${r.tuneErrorsFile}${r.model ? ` · ${r.model.tuneErrorsFile}` : ''}`)
  return lines.join('\n')
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { days: { type: 'string' }, n: { type: 'string' }, split: { type: 'string' }, json: { type: 'boolean' }, model: { type: 'string' } } })
  let result
  if (cmd === 'build') result = await build({ days: Number(values.days || 14) })
  else if (cmd === 'queue') result = queue({ n: Number(values.n || 40), split: values.split || 'tune' })
  else if (cmd === 'label') result = label(positionals[0])
  else if (cmd === 'eval') {
    result = await evaluate({ model: values.model })
    if (!values.json) return console.log(text(result))
  } else if (cmd === 'stats') result = stats()
  else {
    console.error('usage: detection-eval.mjs build|queue|label <file>|eval|stats')
    process.exit(2)
  }
  console.log(JSON.stringify(result, null, 2))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => (console.error(e.message), process.exit(1)))
