// Board configuration: managed projects, the coordinator session, and the grade → model table.
import { readJson, updateJson } from './store.mjs'
import { repoRoot } from './paths.mjs'

export const GRADES = ['A', 'B', 'C', 'D', 'M']

export const GRADE_LABELS = {
  A: 'architecture decisions (strongest models)',
  B: 'needs design, unclear cause or high risk',
  C: 'defined scope and done criteria',
  D: 'research, summaries, cleanup',
  M: 'the coordinator session itself'
}

const LANGUAGE_NAMES = { en: 'English', ko: 'Korean', ja: 'Japanese', zh: 'Chinese', de: 'German', fr: 'French', es: 'Spanish' }

/** Human name of a language code, for prompts ("write the cards in Korean"). */
export function languageName(code) {
  return LANGUAGE_NAMES[code] || code || 'English'
}

/** Board language from COORD_LANG, the POSIX locale variables, or the system locale. */
export function detectLanguage(env = process.env) {
  const raw = env.COORD_LANG || env.LC_ALL || env.LC_MESSAGES || env.LANG || Intl.DateTimeFormat().resolvedOptions().locale || 'en'
  const code = String(raw).toLowerCase().split(/[_.@-]/)[0]
  return /^[a-z]{2}$/.test(code) && code !== 'c' ? code : 'en'
}

// Table adapted from paseo-coordinator-board (MIT, see THIRD_PARTY_NOTICES.md).
// Model ids verified on 2026-11-23 against Claude Code (`claude -p --model <id>`) and the Codex CLI
// model cache. Override them in ~/.orca-coordinator/config.json as providers ship new models.
export const DEFAULT_ROUTING = {
  A: [
    { agent: 'claude', model: 'claude-fable-5-2', effort: 'xhigh' },
    { agent: 'claude', model: 'claude-opus-5-5', effort: 'max' },
    { agent: 'codex', model: 'gpt-6.2-astra', effort: 'xhigh' }
  ],
  B: [
    { agent: 'claude', model: 'claude-fable-5-2', effort: 'high' },
    { agent: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' },
    { agent: 'codex', model: 'gpt-6.2-astra', effort: 'high' }
  ],
  C: [
    { agent: 'claude', model: 'claude-opus-5-5', effort: 'high' },
    { agent: 'codex', model: 'gpt-6.2-sol', effort: 'high' },
    { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high' }
  ],
  D: [
    { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
    { agent: 'codex', model: 'gpt-6-luna', effort: 'high' }
  ],
  M: [
    { agent: 'claude', model: 'claude-opus-5-5', effort: 'high' },
    { agent: 'codex', model: 'gpt-6.2-sol', effort: 'high' }
  ]
}

export const BOARD_TAB_TITLE = 'Coordinator Board'

export function defaultConfig() {
  return {
    version: 1,
    projects: [],
    coordinatorWorkspace: repoRoot(),
    coordinator: null,
    routing: structuredClone(DEFAULT_ROUTING),
    excludedAgents: ['gemini'],
    reservePercent: 15,
    language: detectLanguage(),
    usageCacheSeconds: 300,
    statusCacheSeconds: 5,
    // Turn-end classification with a model (cli/lib/classify.mjs). Off by default: it sends the end
    // of each finished reply to the provider. Set it in Settings or with `coord setup --classifier`.
    classifier: { enabled: false, provider: 'claude', model: 'claude-haiku-5-5', jevModel: 'jev-1.14.0' }
  }
}

export function loadConfig() {
  const stored = readJson('config.json', null)
  const base = defaultConfig()
  if (!stored) return base
  return { ...base, ...stored, routing: { ...base.routing, ...(stored.routing || {}) }, classifier: { ...base.classifier, ...(stored.classifier || {}) } }
}

export async function saveConfig(mutate) {
  return updateJson('config.json', defaultConfig(), async (current) => {
    const merged = { ...defaultConfig(), ...current }
    return (await mutate(merged)) ?? merged
  })
}
