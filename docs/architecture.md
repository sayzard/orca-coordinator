# Architecture

This document explains how the pieces fit together and why some of the less obvious choices were
made. For the background behind the design, see [research.md](research.md).

## Pieces and who uses them

| Piece | Runs as | Talks to Orca through |
|---|---|---|
| `coord` CLI (`cli/`) | whoever calls it: you, the coordinator, a bot, the plugin worker | the `orca` CLI (`orca worktree ps`, `agent list`, `orchestration …`, `account list`) |
| Coordinator | an Orca chat session in this repository's folder workspace | `coord` and `orca orchestration` from its own shell |
| Coding workers | Orca supervised workers started with `orchestration worker-start` | mail back to the coordinator (`worker_done`, `ask`) |
| Plugin worker (`plugin/coordinator-board/src/worker.ts`) | a Node process Orca starts for the plugin | `coord` via `child_process`, plus Orca's plugin host API (status bar, notifications) |
| Plugin panel (`src/panel.tsx`) | an Orca components panel in the right sidebar | the plugin worker only (`plugin.request` / `orca.panels.handle`) |
| Orca Bot | an Orca bot with the handoff rules in its `SOUL.md` | `coord request` |

All board state lives in the CLI's store, so every caller sees the same thing:

```
~/.orca-coordinator/            (COORD_HOME)
  config.json       managed projects, coordinator session, routing table, language, reserve
  requests.json     work requests and their assignments (dispatch, model, worktree)
  decisions.json    decision cards written by the coordinator, plus dismissed auto cards
  history.jsonl     append-only log: requests, assignments, answers
  cache/            short-lived caches of Orca reads (worktree ps, agent list, usage)
```

Writes are atomic (temp file + rename) and serialized with a directory lock, because the panel
worker, the coordinator and a bot can write at the same time. Files are created with mode `0600`.

## Sessions and lanes

`coord status` joins `orca worktree ps --agent-wait --json` with `orca agent list --json` and
assigns every agent session a lane:

| Lane | When |
|---|---|
| `human` (Needs you) | a menu or permission prompt is open (`agentWait`, `programStatus.state: blocked`, or `waiting` on `AskUserQuestion`), or the last reply ends with a question |
| `running` | `state: working` (a stale `toolName` is ignored while working) |
| `review` (To review) | finished with unread output |
| `idle` | finished and seen, or its request was closed |

Each session gets a **fingerprint** — a hash of its state, state start time, last reply, menu text
and prompt. Cards store the fingerprint they were made from.

## Decision cards

- **Coordinator cards** (`coord decision add`): question, suggested reply, reason, options. One
  open card per session; adding again updates it.
- **Auto cards** (`auto:<sessionId>`): computed on the fly from the lane rules above, so the
  board is useful before any digest. Dismissing one hides it until the session's fingerprint
  changes.
- **Worker question cards** (`--dispatch … --ask-message …`): a supervised worker asked its
  coordinator with `orca orchestration ask`. These are always answered through the coordinator,
  which replies to the original message.

### Delivering an answer

Before anything is delivered, the guard checks that the card is open, the session still exists,
is not working, has the fingerprint the person saw, and is not showing a menu.

| Target | Path |
|---|---|
| Terminal session, person pressed [Send] | plugin worker → `coord decision prepare` (guard) → `orca terminal send --enter --wait-submit` → `coord decision mark-delivered` |
| Chat session | `coord decision answer --via mail` → orchestration mail to `orca_session_id:<id>` |
| [Ask coordinator], or a worker question | `coord decision answer --via coordinator` → "Delegated decision" mail to the coordinator |

The CLI deliberately has **no** command that types into a terminal. Only the plugin worker does,
and only in response to a button press, so agents cannot answer other agents' prompts as if they
were you.

## Mail identity

Orca orchestration mail needs a sender. Inside an Orca terminal or chat, the caller has one. The
plugin worker and other background processes do not (`no_active_sender_terminal`), so the board
keeps its own terminal tab titled `Coordinator Board` in the coordinator workspace and sends as
that pane (`--from <handle>`). That tab runs `coord watch`, which doubles as a text view of the
board. Its handle is cached and re-resolved by pane title when stale.

An agent or bot that Orca has attested may not speak for another pane (`consumer_fenced`); in
that case `coord` sends as the caller itself, and replies go back to it.

## Routing

`coord route` / `coord assign` walk the routing table for the grade and skip candidates that are
excluded, not installed (`orca agent installed`), lacking native hooks when `--needs-hooks` is
set, or below the usage reserve. Remaining usage is `100 − max(usedPercent)` over the provider's
live windows from `orca account list` (plus the Fable weekly window for Fable models). If every
candidate is low, the one with the most room is used and the result is flagged `degraded`.

`coord assign` runs `orca orchestration worker-start` from the caller's shell — the coordinator's —
so worker mail (`worker_done`, `ask`, `escalation`) returns to the coordinator. New work goes to a
new top-level worktree of the target repository, or to an existing workspace with `--worktree`.
Closing a request (`coord request set … --status done`) releases its workers and marks their
workspaces read.

## Plugin

- The worker refreshes on Orca events (`agent.status.changed`, `workspace.created/removed`,
  debounced) and every 45 seconds, posts the snapshot to open panels, updates the status bar and
  raises desktop notifications for new urgent cards.
- The Progress tab builds its kanban from the same snapshot: session lanes, `decision.answered`
  history entries (Follow-up, with the target session's current lane) and `done` requests (Done).
- The panel has no logic beyond rendering and calling the worker. Panel strings are in
  `src/i18n.ts` and follow Orca's UI language; worker text follows the `language` setting.
- Tests run the real worker and panel against Orca's test kit with fake `coord`/`orca` scripts in
  `plugin/coordinator-board/test/`.
