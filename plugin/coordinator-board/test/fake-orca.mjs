// Stand-in for the orca CLI: terminal send answers like Orca does for an idle agent, or with
// agent_prompt_blocked when the handle names a menu session.
const args = process.argv.slice(2)
const handle = args[args.indexOf('--terminal') + 1]
if (args[0] === 'terminal' && args[1] === 'send' && handle === 'term_menu-0001') {
  console.log(JSON.stringify({ ok: false, error: { code: 'agent_prompt_blocked', message: 'blocked' } }))
} else if (args[0] === 'terminal' && args[1] === 'send') {
  console.log(JSON.stringify({ ok: true, result: { send: { accepted: true, prompt: { requestId: 'req-term-1', stages: ['input_accepted', 'turn_started'] } } } }))
} else if (args[0] === 'repo' && args[1] === 'list') {
  console.log(JSON.stringify({ ok: true, result: { repos: [{ id: 'repo-alpha', displayName: 'alpha', kind: 'git' }, { id: 'repo-beta', displayName: 'beta', kind: 'git' }] } }))
} else {
  console.log(JSON.stringify({ ok: true, result: {} }))
}
