# Contributing

Thanks for your interest in improving the Orca Coordinator Board. Bug reports, ideas and pull
requests are all welcome.

## Before you start

- For anything larger than a small fix, open an issue first so we can agree on the approach.
- Be kind; this project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- Report security problems privately — see [SECURITY.md](SECURITY.md).

## Development setup

You need macOS, [Orca](https://github.com/stablyai/orca) 1.4.248+ with plugins turned on, and
Node.js 20+.

```bash
git clone https://github.com/<you>/orca-coordinator.git
cd orca-coordinator
npm test                                            # CLI tests, no Orca needed
orca plugin test plugin/coordinator-board --json    # plugin tests (Orca's test kit)
orca plugin check plugin/coordinator-board --json   # panel render scenarios
orca plugin dev watch plugin/coordinator-board --check --json   # live-reload while editing
```

Set `COORD_HOME` to a scratch folder when you run `coord` by hand so you don't touch your real
board state. `COORD_ORCA_BIN` points the CLI at a fake `orca` (see `tests/fixtures/`).

## Guidelines

- **Keep the CLI dependency-free.** `cli/` uses only Node built-ins; the plugin has no build step.
- **Logic lives in the CLI.** The plugin worker is a thin bridge; put behavior in `cli/lib/` and
  test it there.
- **Test what you change.** Add or update tests in `tests/` (CLI) or
  `plugin/coordinator-board/src/*.test.ts(x)` (plugin). Fixtures must not contain personal data —
  no real names, e-mail addresses, machine paths or project names.
- **Strings.** Code, comments and docs are in English. User-facing panel text goes in
  `plugin/coordinator-board/src/i18n.ts`; add every new key to the English table and, if you can,
  to the other languages.
- **Safety rules are features.** Don't weaken the delivery guards (stale/busy/menu checks) or let
  agents type into other agents' terminals; those protect users from misdelivered answers.
- Match the existing style: ES modules, 2-space indent, no semicolons, single quotes.

## Pull requests

1. Fork and create a branch from `main` (`feat/...`, `fix/...`, `docs/...`).
2. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages.
3. Make sure `npm test` passes; if you touched the plugin, run the plugin tests and check too.
4. Describe what changed, why, and how you verified it. Screenshots help for panel changes.
5. Update `CHANGELOG.md` under "Unreleased" for user-visible changes.
