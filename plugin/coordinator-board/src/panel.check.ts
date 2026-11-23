// `orca plugin check` renders the panel once per scenario with the real worker on a stand-in
// host; the worker reads a fake coord (test/fake-coord*.mjs) instead of the live board.
import { defineCheck } from 'orca/testing'
import { fileURLToPath } from 'node:url'

const fake = (name: string) => fileURLToPath(new URL(`../test/${name}`, import.meta.url))
const board = { coordPath: fake('fake-coord.mjs'), notify: false }

export default defineCheck({
  board: { settings: board },
  empty: { settings: { coordPath: fake('fake-coord-empty.mjs'), notify: false } },
  failing: { settings: { coordPath: fake('fake-coord-error.mjs'), notify: false } },
  progress: { settings: board, persisted: { plugin: { 'board-tab': 'progress' } } },
  'progress-by-project': { settings: board, persisted: { plugin: { 'board-tab': 'progress', 'progress-view': 'projects' } } },
  request: { settings: board, persisted: { plugin: { 'board-tab': 'request' } } },
  settings: { settings: board, persisted: { plugin: { 'board-tab': 'settings' } } }
})
