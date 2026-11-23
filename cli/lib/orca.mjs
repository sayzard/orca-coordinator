// Thin wrapper over the `orca` CLI. Every call passes --json and returns the parsed envelope's
// `result`, or throws an OrcaError carrying Orca's error code.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const APP_BIN = '/Applications/Orca.app/Contents/Resources/bin/orca'
const RETRYABLE = new Set(['runtime_unavailable', 'runtime_timeout'])

export class OrcaError extends Error {
  constructor(code, message, data) {
    super(`${code}: ${message}`)
    this.code = code
    this.data = data
  }
}

export function orcaBin() {
  if (process.env.COORD_ORCA_BIN) return process.env.COORD_ORCA_BIN
  if (process.env.ORCA_CLI_BIN_DIR && existsSync(join(process.env.ORCA_CLI_BIN_DIR, 'orca'))) {
    return join(process.env.ORCA_CLI_BIN_DIR, 'orca')
  }
  if (existsSync(APP_BIN)) return APP_BIN
  return 'orca'
}

function execOnce(args, timeoutMs, env) {
  return new Promise((resolve) => {
    execFile(orcaBin(), [...args, '--json'], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

function parseEnvelope(args, { error, stdout, stderr }) {
  const text = stdout.trim()
  let envelope = null
  if (text) {
    try {
      envelope = JSON.parse(text)
    } catch {
      // Some commands print one JSON object per line; keep the last one.
      const last = text.split('\n').filter(Boolean).pop()
      try {
        envelope = JSON.parse(last)
      } catch {}
    }
  }
  if (envelope && envelope.ok === true) return { ok: true, result: envelope.result ?? {} }
  if (envelope && envelope.ok === false) {
    const e = envelope.error || {}
    return { ok: false, error: new OrcaError(e.code || 'orca_error', e.message || 'unknown error', e.data) }
  }
  if (error && error.killed) return { ok: false, error: new OrcaError('runtime_timeout', `orca ${args[0]} timed out`) }
  return { ok: false, error: new OrcaError('orca_unparseable', (stderr || text || String(error)).slice(0, 500)) }
}

/**
 * Runs `orca <args> --json`.
 * opts.retry: retry transient runtime errors (only for reads, or writes that are idempotent).
 * opts.env: environment overrides (e.g. strip ORCA_TERMINAL_HANDLE).
 */
export async function orca(args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000
  const attempts = opts.retry ? 3 : 1
  const env = opts.env ? { ...process.env, ...opts.env } : process.env
  let last
  for (let i = 0; i < attempts; i++) {
    last = parseEnvelope(args, await execOnce(args, timeoutMs, env))
    if (last.ok) return last.result
    if (!RETRYABLE.has(last.error.code)) break
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)))
  }
  throw last.error
}

/** Like orca() but never throws: returns { ok, result | error }. */
export async function tryOrca(args, opts = {}) {
  try {
    return { ok: true, result: await orca(args, opts) }
  } catch (error) {
    return { ok: false, error }
  }
}
