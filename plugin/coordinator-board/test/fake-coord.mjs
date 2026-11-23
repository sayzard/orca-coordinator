// Stand-in for the coord CLI in plugin tests and `orca plugin check`. Mode comes from the file
// name: fake-coord.mjs (full board), fake-coord-empty.mjs, fake-coord-error.mjs.
import { readFileSync, appendFileSync } from 'node:fs'
import { basename } from 'node:path'

export function run(mode, argv) {
  const args = argv.filter((a) => a !== '--json')
  if (process.env.FAKE_COORD_LOG) appendFileSync(process.env.FAKE_COORD_LOG, JSON.stringify(args) + '\n')
  const ok = (result) => console.log(JSON.stringify({ ok: true, result }))
  if (mode === 'error') return console.log(JSON.stringify({ ok: false, error: { code: 'runtime_timeout', message: 'Timed out waiting for the Orca runtime to respond.' } }))
  const status = JSON.parse(readFileSync(new URL('./status.json', import.meta.url), 'utf8'))
  if (mode === 'ask') {
    const c = status.decisions.find((d) => d.source === 'coordinator')
    c.askMessageId = 'msg_ask1'
  }
  if (mode === 'empty') {
    status.decisions = []
    status.counts.decisions = 0
    status.coordinator = null
  }
  const [cmd, sub, id] = args
  if (cmd === 'status') return ok(status)
  if (cmd === 'decision' && sub === 'prepare') return ok({ id, handle: 'term_q-0003', sessionId: 'sess-question', message: '[Coordinator Board · alpha · Deployment strategy]\n' + args[args.indexOf('--text') + 1] })
  if (cmd === 'decision') return ok({ id, status: 'answered', via: 'mail', messageId: 'msg_fake' })
  if (cmd === 'request') return ok({ id: 'req_fake', status: 'sent', messageId: 'msg_fake' })
  if (cmd === 'digest') return ok({ messageId: 'msg_fake' })
  if (cmd === 'setup') return ok({ projects: sub === '--show' ? [] : ['repo-alpha'] })
  if (cmd === 'coordinator') return ok({ sessionId: 'sess-new', agent: 'claude', model: 'claude-opus-5-5' })
  return console.log(JSON.stringify({ ok: false, error: { code: 'usage', message: 'unknown' } }))
}

if (basename(process.argv[1] || '') === 'fake-coord.mjs') run('full', process.argv.slice(2))
