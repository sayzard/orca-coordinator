// Coordinator board panel. Narrow right-sidebar layout: decisions first, then progress,
// requests and settings. All data comes from the worker (`coord status`); no hooks, state in atoms.
// Strings come from ./i18n and follow Orca's UI language.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Card as UiCard,
  Checkbox,
  Collapsible,
  EmptyState,
  env,
  Grid,
  Heading,
  IconButton,
  Image,
  List,
  ListItem,
  Markdown,
  plugin,
  Progress,
  read,
  RelativeTime,
  Row,
  Select,
  set,
  Spinner,
  Stack,
  Tab,
  Tabs,
  Text,
  Textarea,
  update,
  type IconName,
  type PanelContext,
  type Tone
} from 'orca'
import type { ActionResult, Card, ProjectGroup, RepoRow, SessionRow, Snapshot } from './protocol'
import { has, pickLang, resultText, t, type Key, type Lang } from './i18n'

const PRIORITY_TONE: Record<string, 'danger' | 'warning' | 'accent' | 'neutral'> = {
  now: 'danger',
  menu: 'danger',
  permission: 'danger',
  reply: 'warning',
  today: 'warning',
  week: 'accent',
  undated: 'neutral'
}

const snapshot = atom<Snapshot | null>(null)
const loading = atom(false)
const tab = atom('board-tab', 'decisions', { persist: 'plugin' })
const showAll = atom(false)
const drafts = atom('drafts', {} as Record<string, string>, { persist: 'memory' })
const busy = atom({} as Record<string, boolean>)
const notes = atom({} as Record<string, ActionResult>)
const requestText = atom('request-draft', '', { persist: 'plugin' })
const requestProject = atom('auto')
const kanbanProject = atom('kanban-project', 'all', { persist: 'plugin' })
const expandedColumns = atom({} as Record<string, boolean>)
const repos = atom<RepoRow[] | null>(null)
const picked = atom<Record<string, boolean>>({})

function lang(): Lang {
  return pickLang(env.locale)
}

async function load(fresh = false) {
  set(loading, true)
  try {
    set(snapshot, await plugin.request('board.snapshot', { fresh }, { timeoutMs: 90_000 }))
  } catch (e: any) {
    set(snapshot, { ok: false, code: e?.code || 'error', message: String(e?.message || e), at: Date.now() })
  } finally {
    set(loading, false)
  }
}

async function act(key: string, run: () => Promise<ActionResult>) {
  update(busy, (b) => ({ ...b, [key]: true }))
  try {
    const r = await run()
    update(notes, (n) => ({ ...n, [key]: r }))
  } catch (e: any) {
    update(notes, (n) => ({ ...n, [key]: { ok: false, code: e?.code, message: String(e?.message || e) } }))
  } finally {
    update(busy, (b) => ({ ...b, [key]: false }))
  }
}

function Note({ id }: { id: string }) {
  const n = read(notes)[id]
  if (!n) return null
  return (
    <Text size="sm" tone={n.ok ? 'success' : 'danger'}>
      {resultText(lang(), n)}
    </Text>
  )
}

function draftFor(card: Card): string {
  const d = read(drafts)[card.id]
  return d !== undefined ? d : card.recommendation || ''
}

function setDraft(id: string, value: string) {
  update(drafts, (d) => ({ ...d, [id]: value }))
}

async function loadRepos() {
  const r = await plugin.request('projects.list', undefined, { timeoutMs: 60_000 })
  set(repos, r.repos)
  set(picked, Object.fromEntries(r.repos.map((x) => [x.id, x.managed])))
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('board.snapshot', (s) => set(snapshot, s)))
  void load()
  // Pulse the "needs you" mark only while it is on screen.
  const timer = setInterval(() => {
    const snap = read(snapshot)
    if (!read(ctx.visible) || !snap?.ok || (snap.status.counts.human === 0 && snap.status.counts.decisions === 0)) return
    update(pulse, (f) => (f + 1) % NEEDS_YOU_FRAMES)
  }, PULSE_MS)
  ;(timer as any).unref?.()
  ctx.signal.addEventListener('abort', () => clearInterval(timer))
}

function cardReason(card: Card): string {
  const key = (card as Card & { reasonKey?: string }).reasonKey
  return key && has(key) ? t(lang(), key as Key) : card.reason
}

function DecisionCard({ card }: { card: Card }) {
  const L = lang()
  const target = card.target
  const key = card.id
  const isBusy = Boolean(read(busy)[key])
  const tone = PRIORITY_TONE[card.priority] || 'neutral'
  const priorityKey = (has(`priority.${card.priority}`) ? `priority.${card.priority}` : 'priority.undated') as Key
  const draft = draftFor(card)
  const reason = cardReason(card)
  const openSession = () => act(key, () => plugin.request('session.open', { kind: target?.kind || 'terminal', handle: target?.handle || null, workspaceSelector: target?.workspaceSelector || '', path: target?.path || null }))
  return (
    <UiCard title={`${target?.project || '?'} · ${target?.workspace || ''}`} description={target ? `${target.title} · ${target.agent || target.kind} · ${target.state || ''}` : t(L, 'card.noSession')}>
      <Stack gap="sm">
        <Row gap="xs" wrap>
          <Badge tone={tone}>{t(L, priorityKey)}</Badge>
          {card.source === 'coordinator' ? <Badge tone="accent">{t(L, 'badge.coordinator')}</Badge> : <Badge>{t(L, 'badge.auto')}</Badge>}
          {card.askMessageId ? <Badge>{t(L, 'badge.worker')}</Badge> : target?.kind === 'chat' ? <Badge>{t(L, 'badge.chat')}</Badge> : null}
        </Row>
        <Markdown content={card.question} />
        {card.stale ? (
          <Callout tone="warning" title={t(L, 'stale.title')}>
            <Text size="sm">{t(L, 'stale.body')}</Text>
          </Callout>
        ) : null}
        {reason ? (
          <Text size="sm" muted>
            {reason}
          </Text>
        ) : null}
        {card.needsInput ? (
          <Callout tone="accent" title={t(L, 'needsInput.title')}>
            <Text size="sm">{card.needsInput}</Text>
          </Callout>
        ) : null}
        {card.canReply ? (
          <Stack gap="xs">
            {card.options.length ? (
              <Row gap="xs" wrap>
                {card.options.map((o, i) => (
                  <Button key={`opt:${card.id}:${i}`} size="xs" variant="outline" onPress={() => setDraft(card.id, o.reply)}>
                    {o.label}
                  </Button>
                ))}
              </Row>
            ) : null}
            <Textarea key={`reply:${card.id}`} label={t(L, 'reply.label', { title: target?.title || card.id })} labelHidden rows={3} value={draft} placeholder={t(L, 'reply.placeholder')} onChange={(v) => setDraft(card.id, v)} />
            <Row gap="xs" wrap>
              <Button
                key={`send:${card.id}`}
                tone="accent"
                icon="next"
                disabled={isBusy || !draft.trim() || card.stale}
                tooltip={t(L, 'send.tip', { project: target?.project || '', title: target?.title || '' })}
                onPress={() => act(key, () => plugin.request('decision.send', { id: card.id, text: draft, fingerprint: card.evidence?.fingerprint || null }, { timeoutMs: 90_000 }))}
              >
                {t(L, 'send')}
              </Button>
              <Button key={`coord:${card.id}`} variant="outline" icon="bot" disabled={isBusy || !draft.trim()} tooltip={t(L, 'coordinate.tip')} onPress={() => act(key, () => plugin.request('decision.coordinate', { id: card.id, text: draft }, { timeoutMs: 90_000 }))}>
                {t(L, 'coordinate')}
              </Button>
            </Row>
          </Stack>
        ) : (
          <Callout tone="danger" title={t(L, 'inSession.title')}>
            <Text size="sm">{t(L, 'inSession.body')}</Text>
          </Callout>
        )}
        <Row gap="xs" wrap>
          <Button size="xs" variant="ghost" icon="open-external" disabled={isBusy} onPress={openSession}>
            {t(L, 'open')}
          </Button>
          <Button size="xs" variant="ghost" icon="close" disabled={isBusy} onPress={() => act(key, () => plugin.request('decision.dismiss', { id: card.id }))}>
            {t(L, 'dismiss')}
          </Button>
          {isBusy ? <Spinner label={t(L, 'working')} labelHidden /> : null}
        </Row>
        {read(notes)[key] ? (
          <Text key={`note:${card.id}`} size="sm" tone={read(notes)[key].ok ? 'success' : 'danger'}>
            {resultText(L, read(notes)[key])}
          </Text>
        ) : null}
      </Stack>
    </UiCard>
  )
}

function DecisionsTab({ cards, hasCoordinator }: { cards: Card[]; hasCoordinator: boolean }) {
  const L = lang()
  const all = read(showAll)
  const visible = all ? cards : cards.slice(0, 5)
  const digestBusy = Boolean(read(busy).digest)
  return (
    <Stack gap="md">
      <Row justify="between" gap="xs">
        <Text size="sm" muted>
          {t(L, 'decisions.hint')}
        </Text>
        <Button size="xs" variant="outline" icon="refresh" disabled={digestBusy || !hasCoordinator} tooltip={t(L, hasCoordinator ? 'digest.tip.on' : 'digest.tip.off')} onPress={() => act('digest', () => plugin.request('digest.request'))}>
          {t(L, 'digest.button')}
        </Button>
      </Row>
      <Note id="digest" />
      {cards.length === 0 ? <EmptyState icon="check" title={t(L, 'empty.title')} description={t(L, 'empty.body')} /> : null}
      {visible.map((c) => (
        <DecisionCard card={c} />
      ))}
      {cards.length > 5 ? (
        <Button variant="ghost" size="sm" onPress={() => set(showAll, !all)}>
          {all ? t(L, 'less') : t(L, 'more', { n: cards.length - 5 })}
        </Button>
      ) : null}
    </Stack>
  )
}

function laneSummary(g: ProjectGroup, L: Lang): string {
  return ['human', 'running', 'review', 'idle']
    .filter((l) => g.counts[l])
    .map((l) => `${t(L, `lane.${l}` as Key)} ${g.counts[l]}`)
    .join(' · ')
}

/**
 * Animated marks for the two lanes that need attention. Running uses Orca's Spinner. Orca refuses
 * animated images, so "needs you" cycles still frames (assets/needs-you-N.png, made by
 * scripts/make-lane-marks.py) into a pulsing dot, only while the panel is visible.
 */
const LANE_MARK: Record<string, true> = { running: true, human: true }
const NEEDS_YOU_FRAMES = 3
const PULSE_MS = 350
const pulse = atom(0)

function LaneMark({ lane }: { lane: string }) {
  const label = t(lang(), `lane.${lane}` as Key)
  if (lane === 'running') return <Spinner label={label} labelHidden />
  if (lane === 'human') {
    // Image's smallest size is ~32px; a fixed 16px box keeps the dot level with the spinner.
    return (
      <Box width={16} height={16} shrink={false}>
        <Image src={`assets/needs-you-${read(pulse)}.png`} alt={label} size="full" fit="contain" />
      </Box>
    )
  }
  return null
}

/** A list row: animated mark for running / needs-you sessions, the regular icon otherwise. */
/** Called as a function (not a component) so its key stays on the ListItem in the parent's tree. */
function laneRow({ k, lane, icon, title, description, onPress }: { k: string; lane: string; icon: IconName; title: string; description: string; onPress?: () => void }) {
  if (!LANE_MARK[lane]) return <ListItem key={k} icon={icon} title={title} description={description} onPress={onPress} />
  return (
    <ListItem key={k} onPress={onPress}>
      <Row gap="sm" align="center">
        <LaneMark lane={lane} />
        <Stack gap="none">
          <Text truncate>{title}</Text>
          <Text size="xs" muted truncate>
            {description}
          </Text>
        </Stack>
      </Row>
    </ListItem>
  )
}

function SessionItem({ s }: { s: SessionRow }) {
  const L = lang()
  const icon = s.lane === 'human' ? 'warning' : s.lane === 'running' ? 'play' : s.lane === 'review' ? 'check' : 'pause'
  return (
    laneRow({
      k: `p:${s.sessionId}`,
      lane: s.lane,
      icon,
      title: s.title,
      description: `${t(L, `lane.${s.lane}` as Key)} · ${s.agent || s.kind} · ${s.workspace}`,
      onPress: () => void act(`open:${s.sessionId}`, () => plugin.request('session.open', { kind: s.kind, handle: s.handle, workspaceSelector: s.workspaceSelector, path: s.path || null }))
    })
  )
}

function ProjectList({ groups }: { groups: ProjectGroup[] }) {
  const L = lang()
  if (!groups.length) return <EmptyState icon="folder" title={t(L, 'progress.empty.title')} description={t(L, 'progress.empty.body')} />
  return (
    <Stack gap="sm">
      {groups.map((g) => (
        <Collapsible title={g.project} description={laneSummary(g, L) || t(L, 'progress.none')} defaultOpen={Boolean(g.counts.human || g.counts.running)}>
          <List label={g.project}>
            {g.sessions
              .filter((s) => s.lane !== 'idle' || g.sessions.length <= 6)
              .slice(0, 12)
              .map((s) => (
                <SessionItem s={s} />
              ))}
          </List>
        </Collapsible>
      ))}
    </Stack>
  )
}

// Kanban columns in the order the Paseo coordinator board uses; empty columns are hidden.
const KANBAN_ORDER = ['running', 'review', 'human', 'history', 'idle', 'done', 'unknown'] as const
type Column = (typeof KANBAN_ORDER)[number]
const COLUMN_TONE: Record<Column, Tone> = { running: 'accent', review: 'warning', human: 'danger', history: 'neutral', idle: 'neutral', done: 'success', unknown: 'neutral' }
const LANE_ICON: Record<string, IconName> = { human: 'warning', running: 'play', review: 'check', idle: 'pause', unknown: 'info' }
const COLUMN_LIMIT = 4

type KanbanItem = { key: string; title: string; description: string; icon: IconName; lane?: string; onPress?: () => void }

function openSession(s: SessionRow) {
  return act(`open:${s.sessionId}`, () => plugin.request('session.open', { kind: s.kind, handle: s.handle, workspaceSelector: s.workspaceSelector, path: s.path || null }))
}

/** Sessions by lane, plus answered decisions (follow-up) and verified requests (done). */
function kanbanColumns(snap: Extract<Snapshot, { ok: true }>, project: string, L: Lang): Record<Column, KanbanItem[]> {
  const cols = Object.fromEntries(KANBAN_ORDER.map((c) => [c, [] as KanbanItem[]])) as Record<Column, KanbanItem[]>
  const groups = snap.status.projects.filter((g) => project === 'all' || g.repoId === project)
  const projectName = project === 'all' ? null : groups[0]?.project ?? null
  const showProject = project === 'all'
  const sessions = new Map<string, SessionRow & { project: string }>()
  for (const g of groups) {
    for (const s of g.sessions) {
      sessions.set(s.sessionId, { ...s, project: g.project })
      const lane = (KANBAN_ORDER as readonly string[]).includes(s.lane) ? (s.lane as Column) : 'unknown'
      cols[lane].push({
        key: `s:${s.sessionId}`,
        title: s.title,
        description: [showProject ? g.project : null, s.agent || s.kind, s.workspace].filter(Boolean).join(' · '),
        icon: LANE_ICON[s.lane] || 'info',
        lane: s.lane,
        onPress: () => void openSession(s)
      })
    }
  }
  for (const h of snap.status.history) {
    if (h.type !== 'decision.answered') continue
    if (projectName && h.project !== projectName) continue
    if (!projectName && project !== 'all') continue
    const target = h.sessionId ? sessions.get(h.sessionId) : undefined
    const now = target ? t(L, 'kanban.now', { lane: t(L, `lane.${target.lane}` as Key) }) : null
    cols.history.push({
      key: `h:${h.at}:${h.sessionId || ''}`,
      title: h.question || h.title || '',
      description: [`→ ${(h.answer || '').slice(0, 60)}`, showProject ? h.project : null, now].filter(Boolean).join(' · '),
      icon: 'next',
      onPress: target ? () => void openSession(target) : undefined
    })
  }
  for (const r of snap.status.requests) {
    if (r.status !== 'done') continue
    const a = r.assignments?.length ? r.assignments[r.assignments.length - 1] : null
    const rp = r.project || a?.project || null
    if (project !== 'all' && rp !== projectName && rp !== project) continue
    cols.done.push({
      key: `r:${r.id}`,
      title: r.text.split('\n')[0].slice(0, 80),
      description: [r.note || null, showProject ? rp : null, a ? `${a.model} (${a.grade})` : null].filter(Boolean).join(' · '),
      icon: 'check'
    })
  }
  return cols
}

function KanbanColumn({ col, items }: { col: Column; items: KanbanItem[] }) {
  const L = lang()
  const open = Boolean(read(expandedColumns)[col])
  const shown = open ? items : items.slice(0, COLUMN_LIMIT)
  const label = t(L, `lane.${col}` as Key)
  return (
    <Box key={`col:${col}`} border radius="md" padding="sm" gap="xs" background="muted">
      <Row justify="between" align="center">
        <Row gap="xs" align="center">
          <LaneMark lane={col} />
          <Text size="sm" weight="semibold">
            {label}
          </Text>
        </Row>
        <Badge tone={COLUMN_TONE[col]}>{String(items.length)}</Badge>
      </Row>
      <List label={label}>
        {shown.map((it) => (
          laneRow({ k: it.key, lane: it.lane || '', icon: it.icon, title: it.title, description: it.description, onPress: it.onPress })
        ))}
      </List>
      {items.length > COLUMN_LIMIT ? (
        <Button size="xs" variant="ghost" onPress={() => update(expandedColumns, (e) => ({ ...e, [col]: !open }))}>
          {open ? t(L, 'less') : t(L, 'kanban.more', { n: items.length - COLUMN_LIMIT })}
        </Button>
      ) : null}
    </Box>
  )
}

function ProgressTab({ snap }: { snap: Extract<Snapshot, { ok: true }> }) {
  return <ProjectList groups={snap.status.projects} />
}

function KanbanTab({ snap }: { snap: Extract<Snapshot, { ok: true }> }) {
  const L = lang()
  const groups = snap.status.projects
  const options = [{ value: 'all', label: t(L, 'progress.allProjects') }, ...groups.filter((g) => g.repoId).map((g) => ({ value: g.repoId, label: g.project }))]
  const chosen = read(kanbanProject)
  const project = options.some((o) => o.value === chosen) ? chosen : 'all'
  const cols = kanbanColumns(snap, project, L)
  const visible = KANBAN_ORDER.filter((c) => cols[c].length)
  return (
    <Stack gap="sm">
      <Select label={t(L, 'progress.project')} labelHidden value={project} options={options} onChange={(v) => set(kanbanProject, v)} />
      {visible.length === 0 ? (
        <EmptyState icon="folder" title={t(L, 'progress.empty.title')} description={t(L, 'progress.empty.body')} />
      ) : (
        <Grid minItemWidth="md" gap="sm">
          {visible.map((c) => (
            <KanbanColumn col={c} items={cols[c]} />
          ))}
        </Grid>
      )}
    </Stack>
  )
}

function RequestTab({ snap }: { snap: Extract<Snapshot, { ok: true }> }) {
  const L = lang()
  const text = read(requestText)
  const project = read(requestProject)
  const b = Boolean(read(busy).request)
  const options = [{ value: 'auto', label: t(L, 'request.auto') }, ...snap.status.projects.filter((g) => g.repoId).map((g) => ({ value: g.repoId, label: g.project }))]
  const decided = snap.status.history.filter((h) => h.type === 'decision.answered')
  return (
    <Stack gap="md">
      <Stack gap="xs">
        <Heading level={3}>{t(L, 'request.heading')}</Heading>
        <Textarea label={t(L, 'request.label')} labelHidden rows={5} value={text} placeholder={t(L, 'request.placeholder')} onChange={(v) => set(requestText, v)} />
        <Select label={t(L, 'request.project')} value={project} options={options} onChange={(v) => set(requestProject, v)} />
        <Row gap="xs">
          <Button
            tone="accent"
            icon="next"
            disabled={b || !text.trim() || !snap.status.coordinator || snap.status.coordinator.state === 'closed'}
            tooltip={t(L, snap.status.coordinator ? 'request.tip' : 'digest.tip.off')}
            onPress={() =>
              act('request', async () => {
                const r = await plugin.request('request.send', { text, project: project === 'auto' ? null : project }, { timeoutMs: 60_000 })
                if (r.ok) set(requestText, '')
                return r
              })
            }
          >
            {t(L, 'request.send')}
          </Button>
          {b ? <Spinner label={t(L, 'sending')} labelHidden /> : null}
        </Row>
        <Note id="request" />
      </Stack>
      <Stack gap="xs">
        <Heading level={3}>{t(L, 'recent.requests')}</Heading>
        {snap.status.requests.length === 0 ? (
          <Text size="sm" muted>
            {t(L, 'none.yet')}
          </Text>
        ) : (
          <List label={t(L, 'recent.requests')}>
            {snap.status.requests.slice(0, 8).map((r) => {
              const a = r.assignments?.length ? r.assignments[r.assignments.length - 1] : null
              return <ListItem icon={r.status === 'assigned' || r.status === 'done' ? 'check' : 'more'} title={r.text.split('\n')[0].slice(0, 80)} description={`${r.status} · ${r.source}${a ? ` · ${a.agent}/${a.model} (${a.grade})` : ''}`} />
            })}
          </List>
        )}
      </Stack>
      <Stack gap="xs">
        <Heading level={3}>{t(L, 'recent.decisions')}</Heading>
        {decided.length === 0 ? (
          <Text size="sm" muted>
            {t(L, 'none.yet')}
          </Text>
        ) : (
          <List label={t(L, 'recent.decisions')}>
            {decided.slice(0, 8).map((h) => (
              <ListItem icon="check" title={(h.question || '').slice(0, 80)} description={`→ ${(h.answer || '').slice(0, 60)} · ${h.via || ''} · ${h.project || ''}`} />
            ))}
          </List>
        )}
      </Stack>
    </Stack>
  )
}

function SettingsTab({ snap }: { snap: Extract<Snapshot, { ok: true }> }) {
  const L = lang()
  const list = read(repos)
  const sel = read(picked)
  const b = Boolean(read(busy).projects)
  const coord = snap.status.coordinator
  const cb = Boolean(read(busy).coordinator)
  return (
    <Stack gap="md">
      <Stack gap="xs">
        <Heading level={3}>{t(L, 'settings.coordinator')}</Heading>
        {coord && coord.state !== 'closed' ? (
          <Text size="sm">
            {coord.agent}/{coord.model} · {coord.state}
          </Text>
        ) : coord ? (
          <Stack gap="xs">
            <Text size="sm" tone="danger">
              {t(L, 'coordClosed.title')}
            </Text>
            <Button tone="accent" icon="bot" disabled={cb} onPress={() => act('coordinator', () => plugin.request('coordinator.start', undefined, { timeoutMs: 120_000 }))}>
              {t(L, 'settings.restart')}
            </Button>
          </Stack>
        ) : (
          <Stack gap="xs">
            <Text size="sm" muted>
              {t(L, 'settings.noCoordinator')}
            </Text>
            <Button tone="accent" icon="bot" disabled={cb} onPress={() => act('coordinator', () => plugin.request('coordinator.start', undefined, { timeoutMs: 120_000 }))}>
              {t(L, 'settings.start')}
            </Button>
          </Stack>
        )}
        <Note id="coordinator" />
      </Stack>
      <Stack gap="xs">
        <Heading level={3}>{t(L, 'settings.usage')}</Heading>
        {snap.status.usage
          .filter((u) => u.status === 'ok')
          .map((u) => (
            <Stack gap="xs">
              {u.windows.map((w) => (
                <Progress
                  label={`${t(L, 'usage.window', { provider: u.provider, window: has(`window.${w.id}`) ? t(L, `window.${w.id}` as Key) : w.id, left: 100 - w.usedPercent })}${w.resetDescription ? ` (${w.resetDescription})` : ''}`}
                  value={100 - w.usedPercent}
                />
              ))}
            </Stack>
          ))}
      </Stack>
      <Stack gap="xs">
        <Row justify="between">
          <Heading level={3}>{t(L, 'settings.projects')}</Heading>
          <Button size="xs" variant="ghost" icon="refresh" onPress={() => void loadRepos()}>
            {t(L, 'settings.load')}
          </Button>
        </Row>
        <Text size="sm" muted>
          {t(L, 'settings.projectsHint')}
        </Text>
        {list === null ? (
          <Text size="sm" muted>
            {t(L, 'settings.pressLoad')}
          </Text>
        ) : (
          <Stack gap="xs">
            {list.map((r) => (
              <Checkbox label={r.name} description={r.kind === 'folder' ? t(L, 'settings.folder') : undefined} checked={Boolean(sel[r.id])} onChange={(v) => update(picked, (p) => ({ ...p, [r.id]: v }))} />
            ))}
            <Button tone="accent" disabled={b} onPress={() => act('projects', () => plugin.request('projects.set', { ids: Object.keys(sel).filter((k) => sel[k]) }))}>
              {t(L, 'save')}
            </Button>
          </Stack>
        )}
        <Note id="projects" />
      </Stack>
    </Stack>
  )
}

export default function Panel() {
  const L = lang()
  const snap = read(snapshot)
  const isLoading = read(loading)
  const current = read(tab)
  if (!snap) return <Spinner label={t(L, 'loading')} />
  if (!snap.ok) {
    return (
      <Stack gap="md">
        <Callout tone="danger" title={t(L, 'error.title')}>
          <Text size="sm">
            [{snap.code}] {snap.message}
          </Text>
        </Callout>
        <Button icon="refresh" onPress={() => void load(true)}>
          {t(L, 'retry')}
        </Button>
      </Stack>
    )
  }
  const s = snap.status
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Stack gap="none">
          <Heading level={2}>{t(L, 'title')}</Heading>
          <Row gap="xs" align="center" wrap>
            {s.counts.running > 0 ? <LaneMark lane="running" /> : null}
            <Text size="xs" muted>
              {t(L, 'summary.running', { n: s.counts.running })}
            </Text>
            <Text size="xs" muted>
              ·
            </Text>
            {s.counts.decisions > 0 ? <LaneMark lane="human" /> : null}
            <Text size="xs" muted>
              {t(L, 'summary.decisions', { n: s.counts.decisions })} · {t(L, 'summary.review', { n: s.counts.review })} · <RelativeTime at={Math.min(s.generatedAt, Date.now() - 1000)} />
            </Text>
          </Row>
        </Stack>
        <IconButton icon="refresh" label={t(L, 'refresh')} disabled={isLoading} onPress={() => void load(true)} />
      </Row>
      {!s.coordinator ? (
        <Callout tone="warning" title={t(L, 'noCoordinator.title')}>
          <Text size="sm">{t(L, 'noCoordinator.body')}</Text>
        </Callout>
      ) : s.coordinator.state === 'closed' ? (
        <Callout tone="danger" title={t(L, 'coordClosed.title')}>
          <Text size="sm">{t(L, 'coordClosed.body')}</Text>
        </Callout>
      ) : null}
      <Tabs label={t(L, 'tabs.label')} value={current} onChange={(v) => set(tab, v)}>
        <Tab value="decisions" label={t(L, 'tab.decisions', { n: s.counts.decisions })}>
          <DecisionsTab cards={s.decisions} hasCoordinator={Boolean(s.coordinator) && s.coordinator?.state !== 'closed'} />
        </Tab>
        <Tab value="progress" label={t(L, 'tab.progress')}>
          <ProgressTab snap={snap} />
        </Tab>
        <Tab value="kanban" label={t(L, 'tab.kanban')}>
          <KanbanTab snap={snap} />
        </Tab>
        <Tab value="request" label={t(L, 'tab.requests')}>
          <RequestTab snap={snap} />
        </Tab>
        <Tab value="settings" label={t(L, 'tab.settings')}>
          <SettingsTab snap={snap} />
        </Tab>
      </Tabs>
    </Stack>
  )
}
