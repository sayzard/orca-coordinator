# Orca Coordinator Board

[![CI](https://github.com/sayzard/orca-coordinator/actions/workflows/ci.yml/badge.svg)](https://github.com/sayzard/orca-coordinator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A **coordinator layer** for the [Orca](https://github.com/stablyai/orca) agent IDE. When you run
five, ten or twenty coding agents at once, the agents work in parallel but you review in series:
you lose track of which window needs you and end up typing into the wrong one. The coordinator
board puts every decision that only you can make in one place, and lets an agent do the routing.

```
Orca Bot (manager) ── coord request ──┐
You (board panel) ────────────────────┼──▶ Coordinator (chat) ── worker-start (model by grade) ──▶ Coding workers
                                      │            │ coord decision add
                                      ▼            ▼
                          ~/.orca-coordinator (requests · decision cards · history)
                                      │
                      Orca right sidebar "Coordinator Board" · status bar "Decisions N"
```

It follows the three-layer pattern — **manager** agents bring work in from outside, a
**coordinator** decides where and with which model it runs, **coding** agents do it — and ports
the idea of the [Paseo coordinator board](https://github.com/devbrother2024/paseo-coordinator-board)
to Orca. Background and design notes: [docs/research.md](docs/research.md).

## Features

- **"My decisions" cards.** Sessions that need you show up as cards with the target project and
  session, a one-sentence question, a suggested reply, the reasoning and quick options.
  [Send] delivers the reply to that session; [Ask coordinator] hands it back to the coordinator.
- **Auto-detected cards.** Menus and permission prompts come from Orca's agent hooks; replies that
  end in a question are found by rules. Optionally (off by default), each finished turn is
  classified once by a small model (Claude Haiku through your local `claude` CLI) as a decision
  for you, an optional offer, or a plain report. See [Turn classification](#turn-classification).
- **Guarded delivery.** A reply is refused if the session moved on since the card was made, is
  busy, or shows a menu (answer those in the session), so answers never land in the wrong place.
- **Grade-based routing.** The coordinator grades work A–D and `coord assign` picks the agent,
  model and effort from a routing table, skipping providers that are low on usage
  (`orca account list`) or not installed.
- **Requests from people and bots.** One entry point, `coord request`, for you (panel or
  terminal) and for an Orca Bot that collects work from Slack, GitHub, Linear or e-mail.
- **Progress and kanban.** A per-project list of sessions, and a Kanban tab with Running /
  To review / Needs you / Follow-up / Idle / Done columns across projects and a project filter. Finished, verified workers
  are released so they stop asking for review.
- **English and Korean UI.** The panel follows Orca's UI language; cards are written in the board
  language you set.

## Components

| Path | What it is |
|---|---|
| [`cli/coord.mjs`](cli/coord.mjs) | The shared CLI. The person, the bot, the coordinator and the plugin all read and write the same state through it. Node ≥ 20, no dependencies. |
| [`.claude/skills/orca-coordinator/`](.claude/skills/orca-coordinator/SKILL.md) | The coordinator's charter and procedures, grade criteria and card-writing guide. |
| [`plugin/coordinator-board/`](plugin/coordinator-board) | Orca plugin: Decisions · Progress · Kanban · Requests · Settings panel, status bar badge, notifications. |
| [`bot/orca-bot-instructions.md`](bot/orca-bot-instructions.md) | Rules and automation examples for an Orca Bot that hands work to the coordinator. |
| [`docs/`](docs) | Architecture and background research. |

## Requirements

- macOS with [Orca](https://github.com/stablyai/orca) 1.4.248 or later (developed on 1.4.271), with
  plugins turned on (Settings → Plugins).
- Node.js 20 or later on `PATH`.
- At least one agent CLI signed in, e.g. Claude Code or Codex. Orchestration features must be
  available in your Orca build (`orca orchestration --help`).

## Install

```bash
git clone https://github.com/sayzard/orca-coordinator.git
cd orca-coordinator

# 1. Put coord on your PATH
ln -sf "$PWD/cli/coord.mjs" ~/.local/bin/coord

# 2. Add this folder to Orca as a folder workspace (the coordinator runs here)
orca repo add --path "$PWD" --kind folder --json

# 3. Install the plugin (Orca shows the access it asks for and needs your approval)
orca plugin install "$PWD/plugin/coordinator-board" --json

# 4. Choose the language cards should be written in, then start the coordinator
coord setup --language en          # or ko, ...
coord coordinator start            # a Claude Opus chat by default (routing grade M)
```

The plugin asks for: running its Node worker, reading agent and workspace status, opening
workspaces and toggling the sidebar (`workspace:write`), its own storage and settings, and desktop
notifications. It types into a terminal session only when you press [Send] on a card.

## Usage

**In Orca.** Open the Coordinator Board (bot icon) in the right sidebar.

- *Decisions* — answer cards; press [Request digest] to have the coordinator read every session
  and post only the real decisions.
- *Requests* — describe work under "Hand work to the coordinator"; it picks the project, grade and
  model and starts a worker in a new worktree.
- *Progress* — sessions per project by lane.
- *Kanban* — every session by lane, plus answered decisions (Follow-up) and verified requests
  (Done); filter by project.
- *Settings* — coordinator, usage, managed projects.

**From an Orca Bot.** Add the block in [`bot/orca-bot-instructions.md`](bot/orca-bot-instructions.md)
to the bot's `SOUL.md`; the bot then runs:

```bash
coord request --body-file request.md --source bot:<bot-name> --project <repo> --json
coord status --json
coord decision list --json
```

**From a terminal.** `coord status`, `coord watch`, `coord usage`, `coord route --grade B`,
`coord help`.

## Routing table

| Grade | Work | Candidates, in order |
|---|---|---|
| A | Architecture decisions | `claude-fable-5-2` xhigh → `claude-opus-5-5` max → `gpt-6.2-astra` xhigh |
| B | Needs design, unclear cause, high risk | `claude-fable-5-2` high → `claude-opus-5-5` xhigh → `gpt-6.2-astra` high |
| C | Defined scope and done criteria | `claude-opus-5-5` high → `gpt-6.2-sol` high → `claude-sonnet-5-5` high |
| D | Research, summaries, cleanup | `claude-sonnet-5-5` medium → `gpt-6-luna` high |
| M | The coordinator itself | `claude-opus-5-5` high → `gpt-6.2-sol` high |

Candidates below the usage reserve (15% by default) or not installed are skipped. Edit `routing`
in `~/.orca-coordinator/config.json` to use other models; see
[routing.md](.claude/skills/orca-coordinator/references/routing.md).

## Configuration

`~/.orca-coordinator/config.json` (created on first write; set `COORD_HOME` to move it):

| Key | Default | Set with |
|---|---|---|
| `projects` | `[]` (all projects) | `coord setup --projects a,b` / `--add` / `--remove`, or the Settings tab |
| `language` | from `COORD_LANG` / `LANG` | `coord setup --language ko` |
| `reservePercent` | `15` | `coord setup --reserve 20` |
| `excludedAgents` | `["gemini"]` | `coord setup --exclude gemini,cursor` |
| `routing` | table above | edit the file |
| `coordinator` | none | `coord coordinator start` / `set --session <id>` |
| `classifier` | `{ "enabled": false, "model": "claude-haiku-5-5" }` | Settings tab, or `coord setup --classifier on` / `off` / `<model>` |

### Turn classification

Off by default. Pick a classifier in the board's Settings tab (or
`coord setup --classifier claude|jev|off`). Then, when a session finishes a turn without a menu or
permission prompt, the end of its final reply (the last 40 lines) is judged once per turn —
including replies from other agents such as Codex:

| Classifier | How | Card text and buttons |
|---|---|---|
| **Claude Haiku** | Your local `claude` CLI, under your own Claude account | The model writes the question and up to four quick replies |
| **Jev** ([TypeSafe AI](https://docs.typesafe.ai)) | `POST api.typesafe.ai/v1/systemone` with your API key; a decision model that returns calibrated probabilities | The question comes from the rules; Jev picks which candidate replies fit: the options the reply lists ("1. …", "A) …") plus yes / as recommended / no |

Decisions become cards with the question to answer; when a short reply settles it, the card gets
quick-reply buttons that send at once. Optional offers and reports stay out of "Needs you". The
rules take over while a result is pending, when the provider is unavailable, and whenever the
classifier is off. Results are cached in `~/.orca-coordinator/cache/turn-class.json`.

The Jev key is entered in the Settings tab and kept in Orca's encrypted plugin secrets (the OS
keychain), never in the coordinator's files; the board passes it to `coord` as
`TYPESAFE_API_KEY`. `coord` run elsewhere (a terminal, the bot) without that variable uses the
results the board already cached and sends nothing.

`scripts/detection-eval.mjs` measures both on your own turns: it builds a private labeled corpus
under `~/.orca-coordinator/eval/` (never in the repository) and reports recall, precision,
offers flagged and false alarms on stable tune and holdout splits
(`node scripts/detection-eval.mjs eval --model claude-haiku-5-5`, or `--model jev-1.14.0` with
`TYPESAFE_API_KEY` set). Labels follow
[docs/detection-rubric.md](docs/detection-rubric.md);
[docs/detection-round.md](docs/detection-round.md) describes a daily improvement round.

Detection is most reliable when agents ask through a tool instead of prose. Optionally add this to
your global `~/.claude/CLAUDE.md` (and the same idea with `request_user_input` to
`~/.codex/AGENTS.md`):

```markdown
- When you cannot continue without the user's decision (a choice between options, an approval, or
  information only they have), ask with the AskUserQuestion tool (2-4 concrete options, your
  recommendation first) instead of ending the turn with a question in prose.
- Do not use it for optional follow-ups; mention those briefly in the reply instead.
- If AskUserQuestion is not available, end the reply with one line that starts with
  "Decision needed:" followed by the question.
```

The question then arrives as a menu, which the board shows at once (answer it in the session).

## Development

```bash
npm test                                          # CLI unit tests (Node test runner)
orca plugin test plugin/coordinator-board --json  # plugin worker and panel tests
orca plugin check plugin/coordinator-board --json # renders six panel scenarios
orca plugin dev watch plugin/coordinator-board --check --json   # live-reload the plugin
```

How the pieces talk to each other is described in [docs/architecture.md](docs/architecture.md).
Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Known limitations

- Menus and permission prompts cannot be answered from the board; Orca blocks outside input to
  them. Use [Open session].
- Pressing the status bar item toggles the right sidebar; Orca has no API to open a specific panel.
- Work is assigned on the local host only. Paired servers, PR merging from the board, follow-up
  questions and image attachments are not implemented yet.
- Replies from the coordinator to the board go to the board's mailbox terminal
  (`Coordinator Board` tab); it is recreated if closed.
- The default routing table names models available in late 2026; update it as providers ship new
  ones.

## Acknowledgements

- The three-layer idea and the Paseo plugin by 개발동생 (devbrother2024):
  [video](https://www.youtube.com/watch?v=e4F6vEOoSoo),
  [paseo-coordinator-board](https://github.com/devbrother2024/paseo-coordinator-board).
- [Orca](https://github.com/stablyai/orca) by Stably AI for the plugin and orchestration APIs.

The default routing table and the coordinator charter are adapted from paseo-coordinator-board
(MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

[MIT](LICENSE)
