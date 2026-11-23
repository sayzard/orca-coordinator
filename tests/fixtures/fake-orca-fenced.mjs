#!/usr/bin/env node
// Fake orca for board identity tests. FAKE_FENCED=1 refuses --from like Orca does for an
// attested caller; FAKE_LOG records each call.
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2).filter((a) => a !== '--json')
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\n')
const ok = (result) => console.log(JSON.stringify({ ok: true, result }))
if (args[0] === 'terminal' && args[1] === 'show') ok({ terminal: { handle: 'term_board', connected: true, orphaned: false, paneTitle: 'Coordinator Board' } })
else if (args[0] === 'terminal' && args[1] === 'list') ok({ terminals: [{ handle: 'term_board', paneTitle: 'Coordinator Board' }] })
else if (args[0] === 'orchestration' && args[1] === 'send' && args.includes('--from') && process.env.FAKE_FENCED === '1') {
  console.log(JSON.stringify({ ok: false, error: { code: 'consumer_fenced', message: 'This terminal is attested as term_bot and cannot act as term_board.' } }))
} else if (args[0] === 'orchestration' && args[1] === 'send') ok({ messageId: args.includes('--from') ? 'msg_board' : 'msg_self' })
else ok({})
