# orca-coordinator

This repository is the source of the Orca coordinator board: the `coord` CLI, the Orca plugin and
the coordinator skill.

- **If you were started as the coordinator** (your first prompt begins with "You are the
  coordinator session of this Orca"): read `.claude/skills/orca-coordinator/SKILL.md` and follow
  its charter and procedures.
- **If you are developing it:** the CLI is in `cli/`, the plugin in `plugin/coordinator-board/`.
  Run `npm test` (CLI) and `orca plugin test plugin/coordinator-board --json` (plugin) before you
  finish. Code, comments and docs are in English; user-facing panel strings live in
  `plugin/coordinator-board/src/i18n.ts`.
