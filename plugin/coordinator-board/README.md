# Coordinator Board (Orca plugin)

The right-sidebar Coordinator Board and the "Decisions N" status bar item. All data and logic live
in the repository's `coord` CLI (`../../cli/coord.mjs`); this plugin shows it and calls it.

- `src/worker.ts` reads `coord status` and updates the panel, the status bar and notifications
  (on agent status events and every 45 s). When you press [Send] on a card for a terminal session,
  it validates the answer with `coord decision prepare` and types it with
  `orca terminal send --wait-submit`.
- `src/panel.tsx` renders the Decisions · Progress · Requests · Settings tabs (components panel).
  Progress is a kanban whose columns sit side by side in a wide sidebar and wrap in a narrow one.
- `src/i18n.ts` holds the UI strings (English, Korean). The panel follows Orca's UI language.
- `test/fake-*.mjs` stand in for `coord` and `orca` in tests and in `orca plugin check`.

## Settings (Orca Settings → Coordinator Board)

| Key | Default | Meaning |
|---|---|---|
| `coordPath` | empty | Path to `coord`. Empty uses this repository's `cli/coord.mjs`, then `coord` on `PATH`. |
| `notify` | on | Desktop notification when a menu, permission prompt or "now" card appears. |
| `language` | auto | Language of the status bar and notifications (`auto`, `en`, `ko`). `auto` uses the board language set with `coord setup --language`. |

## Develop

```bash
orca plugin test . --json && orca plugin check . --json
orca plugin dev watch . --check --json     # live reload while editing
orca plugin install "$PWD" --json          # install (asks for approval)
```
