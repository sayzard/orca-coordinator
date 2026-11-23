# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/sayzard/orca-coordinator/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/sayzard/orca-coordinator/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/sayzard/orca-coordinator/releases/tag/v0.2.0
