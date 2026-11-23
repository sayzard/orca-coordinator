// The board's own mailbox identity. Processes without an Orca terminal (the plugin worker, a
// launchd job) cannot send orchestration mail, so the board keeps one terminal tab titled
// "Coordinator Board" in the coordinator workspace and sends as that pane (`--from <handle>`).
// That tab runs `coord watch`, which doubles as a text view of the board.
import { orca } from './orca.mjs'
import { readJson, writeJson } from './store.mjs'
import { BOARD_TAB_TITLE } from './config.mjs'
import { coordScript } from './paths.mjs'

function workspaceSelector(config) {
  return `path:${config.coordinatorWorkspace}`
}

async function findBoardTerminal(config) {
  const r = await orca(['terminal', 'list', '--worktree', workspaceSelector(config)], { retry: true })
  const match = (r.terminals || []).find((t) => t.paneTitle === BOARD_TAB_TITLE)
  return match?.handle || null
}

/** Returns the board terminal handle, creating the tab when it is missing. */
export async function ensureBoardHandle(config, { create = true } = {}) {
  const cachedEntry = readJson('cache/board.json', null)
  if (cachedEntry?.handle) {
    const show = await orca(['terminal', 'show', '--terminal', cachedEntry.handle]).catch(() => null)
    const t = show?.terminal
    if (t && t.connected !== false && !t.orphaned && t.paneTitle === BOARD_TAB_TITLE) return cachedEntry.handle
  }
  let handle = await findBoardTerminal(config)
  if (!handle && create) {
    // Under the plugin worker, process.execPath is Electron; it only acts as Node with this variable.
    const node = process.versions.electron ? `env ELECTRON_RUN_AS_NODE=1 ${JSON.stringify(process.execPath)}` : JSON.stringify(process.execPath)
    const command = `${node} ${JSON.stringify(coordScript())} watch`
    const r = await orca(['terminal', 'create', '--worktree', workspaceSelector(config), '--title', BOARD_TAB_TITLE, '--command', command])
    handle = r.terminal?.handle || null
    if (handle) await orca(['terminal', 'set-pane-title', '--terminal', handle, '--title', BOARD_TAB_TITLE]).catch(() => null)
  }
  if (!handle) throw new Error('board_terminal_unavailable: could not find or create the Coordinator Board terminal')
  writeJson('cache/board.json', { handle, at: Date.now() })
  return handle
}

/**
 * Sends orchestration mail as the board, so replies collect in one mailbox and never interrupt
 * the person's own terminal. A caller Orca has attested (an agent or a bot chat) may not speak
 * for another pane (`consumer_fenced`); it then sends as itself, and replies go back to it.
 * Returns { messageId, sender: 'board' | 'self' }.
 */
export async function sendAsBoard(config, { to, type, subject, bodyFile }) {
  const base = ['orchestration', 'send', '--to', to, '--subject', subject, '--body-file', bodyFile]
  if (type) base.push('--type', type)
  let handle
  try {
    handle = await ensureBoardHandle(config)
  } catch (error) {
    return { ...(await orca(base, { timeoutMs: 45_000 })), sender: 'self' }
  }
  try {
    return { ...(await orca([...base, '--from', handle], { timeoutMs: 45_000 })), sender: 'board' }
  } catch (error) {
    if (error.code !== 'consumer_fenced') throw error
    return { ...(await orca(base, { timeoutMs: 45_000 })), sender: 'self' }
  }
}
