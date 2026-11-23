// Plain-text rendering of a status snapshot, for `coord status` and the board terminal's `coord watch`.
import { LANE_LABELS, LANE_ORDER } from './lanes.mjs'

function ago(ms) {
  if (!ms) return ''
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function one(text, n = 90) {
  const t = (text || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

export function renderBoard(status) {
  const lines = []
  const c = status.counts
  lines.push(`■ Coordinator Board  decisions ${c.decisions} · running ${c.running} · to review ${c.review} · idle ${c.idle}  (${c.sessions} sessions)`)
  if (status.coordinator) lines.push(`  coordinator: ${status.coordinator.agent || ''}/${status.coordinator.model || ''} · ${status.coordinator.state}`)
  else lines.push('  coordinator: none -> coord coordinator start')
  lines.push('')
  lines.push('▶ My decisions')
  if (!status.decisions.length) lines.push('  (none)')
  for (const d of status.decisions.slice(0, 10)) {
    const t = d.target || {}
    const flag = d.stale ? ' [stale]' : d.canReply === false ? ' [answer in session]' : ''
    lines.push(`  • ${one(d.question, 100)}${flag}`)
    lines.push(`    ${t.project || '?'} · ${t.workspace || ''} · ${one(t.title, 40)} · ${t.state || ''}  (${d.id})`)
    if (d.recommendation) lines.push(`    suggested: ${one(d.recommendation, 100)}`)
  }
  lines.push('')
  lines.push('▶ Projects')
  for (const p of status.projects.slice(0, 15)) {
    const counts = LANE_ORDER.filter((l) => p.counts[l]).map((l) => `${LANE_LABELS[l]} ${p.counts[l]}`).join(' · ')
    lines.push(`  ${p.project.padEnd(18)} ${counts}`)
    for (const s of p.sessions.filter((s) => s.lane !== 'idle').slice(0, 4)) {
      lines.push(`     - [${LANE_LABELS[s.lane]}] ${one(s.title, 50)} · ${s.agent || s.kind} · ${ago(s.updatedAt)}`)
    }
  }
  if (status.usage?.length) {
    lines.push('')
    lines.push('▶ Usage')
    for (const u of status.usage) {
      if (u.status !== 'ok') continue
      lines.push(`  ${u.provider.padEnd(8)} ${u.windows.map((w) => `${w.id} ${100 - w.usedPercent}% left`).join(' · ')}`)
    }
  }
  const pending = (status.requests || []).filter((r) => r.status === 'queued' || r.status === 'sent')
  if (pending.length) {
    lines.push('')
    lines.push('▶ Pending requests')
    for (const r of pending.slice(0, 5)) lines.push(`  ${r.id} [${r.status}] ${one(r.text, 80)}`)
  }
  return lines.join('\n')
}
