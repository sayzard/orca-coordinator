# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Turn classification with a small model: each finished turn without a menu or permission prompt
  is classified once (cached) as a decision for the person, an optional offer, or a report, using
  Claude Haiku through the local `claude` CLI. Decisions become cards with the question to answer;
  offers and reports no longer show under "Needs you". The rules remain the fallback.
  `coord setup --classifier off|on|<model>` controls it. On a first set of 300 turns labeled by
  a model judge (not yet checked by a person) it found 97–98% of decisions where the rules found
  76–78%, at 91–97% precision (tune / holdout split).
- A way to measure and tune question detection on real turns:
  `scripts/detection-eval.mjs` builds a private corpus of finished turns (Claude Code and Codex
  transcripts plus board signals) under the coordinator home, hands out items to label, and
  reports decision recall, precision, offers flagged and false alarms on tune and holdout splits.
  Labels follow [docs/detection-rubric.md](docs/detection-rubric.md).
- The board records evidence while it is used (dismissed cards, answered cards, and replies to
  turns it did not flag) in `eval/signals.jsonl` under the coordinator home.
- [docs/detection-round.md](docs/detection-round.md): a daily improvement round the Orca bot
  hands to the coordinator.

### Fixed

- A long final reply ending with a question shows under "Needs you" again. `orca agent read` cuts
  long entries off ("… (truncated)"), and that partial reading replaced the full message Orca
  reported, so the question at the end was lost; cut-off readings are now ignored.
- A question is found within the last 20 lines of a reply (was 4), since agents often follow it
  with notes such as report paths and files to look at.
- Lines that flag a decision for the person count as a pending question too, e.g. a heading
  "결정이 필요한 것: …" or "Decision needed: …", but not "결정 불필요" or "no decision needed".
  Card text drops Markdown bold and heading marks.
- A session whose turn has ended while a subagent is still working stays under "Running": the
  agent carries on when the subagent reports back. Only a background shell on its own lets the
  finished turn count.
- A dismissed or answered card also takes its session out of "Needs you" in Progress and Kanban
  until the session moves on, and closing a coordinator card no longer brings back the automatic
  card for the same question.
- A session whose turn has ended while a background shell keeps running ("monitoring") is no
  longer shown as running: the board uses the main agent's state, so a question at the end of
  that turn appears under "Needs you".
- More ways of asking the person to decide are detected, e.g. Korean "정해/골라/알려/말씀해 …
  주시면 · 주세요 · 주십시오" and English "tell me whether…", "which would you prefer".
- Panel buttons ([Send], [Open session], [Dismiss] and others) no longer show "<action> answered
  with a non-JSON value" after they worked: worker results leave out empty fields instead of
  sending `undefined`, which the Orca host rejects, and coord error envelopes are coerced to
  strings.

## [0.3.4] - 2026-11-23

### Added

- Animated marks so running work and pending decisions stand out: a spinner before running
  sessions and a pulsing red dot before sessions that need you, in the header counts, the Progress
  list and the Kanban columns. Orca refuses animated images, so the dot cycles still frames
  (`scripts/make-lane-marks.py`) only while the panel is visible.

### Changed

- The kanban board moved to its own Kanban tab, next to Progress. Progress shows the per-project
  list again, and the project filter lives on the Kanban tab.

### Fixed

- [Open session] works for chats in folder workspaces, such as Orca Bot chats. The Orca CLI
  cannot activate folder workspaces, so the board opens them through the plugin host API, matched
  by folder path, and shows a clear message if that fails too.
- The board refreshes every 10 seconds while any session is running (45 seconds otherwise). Chat
  sessions send no agent status events, so a finished chat turn used to wait for the slow poll.
- A closed coordinator chat is detected: the board says so and offers to start a new one, requests
  are kept queued instead of being mailed to a chat nobody reads, and digests and delegated
  answers are refused with `coordinator_closed`.
- A chat session whose final reply ends with a question now shows up under "Needs you". Orca
  reports the first text block of a chat turn as its last message, so the board now reads the
  final reply from the transcript (`orca agent read`), once per turn and at most eight sessions
  per refresh, most recent first. Card fingerprints still use Orca's own value, so cards don't go
  stale when the reading arrives.

## [0.3.0] - 2026-11-23

### Added

- Kanban view in the Progress tab, as on the Paseo board: Running, To review, Needs you,
  Follow-up (answered decisions and where their session is now), Idle, Done (verified requests) and
  Unknown columns. Empty columns are hidden; columns sit side by side when the sidebar is wide and
  wrap when it is narrow; a project filter narrows every column. The per-project list stays as the
  "By project" view.

### Changed

- Temp files for mail bodies and worker specs (`~/.orca-coordinator/tmp/`) older than a day are
  removed automatically instead of piling up.

### Fixed

- The status bar and notifications follow the board language (`coord setup --language`) when the
  plugin's language setting is `auto`, instead of the system locale.

## [0.2.0] - 2026-11-23

First public release.

### Added

- `coord` CLI: status snapshot with session lanes, work requests, grade-based routing with usage
  reserve, worker assignment through `orca orchestration worker-start`, decision cards with
  guarded delivery, digests, history, and a `watch` view for a terminal.
- Coordinator skill: charter, intake/assignment/verification/digest procedures, grade criteria
  and card-writing guide.
- Orca plugin "Coordinator Board": Decisions, Progress, Requests and Settings tabs, status bar
  badge, desktop notifications for urgent cards, English and Korean UI.
- Orca Bot handoff rules and automation examples.
- Worker questions (`orca orchestration ask`) become cards answered through the coordinator.
- Closing a request releases its workers so they stop showing as "to review".
- Board mailbox terminal so processes without an Orca identity can send mail; attested callers
  fall back to their own identity.

[Unreleased]: https://github.com/sayzard/orca-coordinator/compare/v0.3.4...HEAD
[0.3.4]: https://github.com/sayzard/orca-coordinator/compare/v0.3.0...v0.3.4
[0.3.0]: https://github.com/sayzard/orca-coordinator/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/sayzard/orca-coordinator/releases/tag/v0.2.0
