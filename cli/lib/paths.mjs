// Where the coordinator keeps its state. COORD_HOME overrides it (tests use a temp dir).
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export function coordHome() {
  return process.env.COORD_HOME || join(homedir(), '.orca-coordinator')
}

export function dataPath(name) {
  return join(coordHome(), name)
}

/** Absolute path of cli/coord.mjs, used when the board terminal runs `coord watch`. */
export function coordScript() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'coord.mjs')
}

/** Repository root (one level above cli/). */
export function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..')
}
