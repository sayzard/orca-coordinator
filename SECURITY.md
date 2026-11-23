# Security Policy

## Supported versions

Only the latest release on `main` receives security fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Report them privately through
[GitHub Security Advisories](https://github.com/sayzard/orca-coordinator/security/advisories/new).
Include what you found, how to reproduce it and its impact. You can expect an acknowledgement
within a week.

## Security model

This project runs with your user account's access, so keep these properties in mind:

- The Orca plugin runs a **trusted worker** (a Node process) after you approve it. It reads agent
  and workspace status, and it types into a terminal session **only** when you press [Send] on a
  card.
- The `coord` CLI has no path for typing into terminals. Agents (the coordinator, workers, bots)
  can only send Orca orchestration mail, which keeps them from impersonating you at another
  agent's prompt.
- Conversation excerpts that the coordinator reads are treated as evidence, never as instructions
  (see the charter in `.claude/skills/orca-coordinator/SKILL.md`). Prompt injection through
  session content, tickets or mail is still a risk with any agent system; review what the
  coordinator does, and keep publishing, deploying, spending and permission grants as human
  decisions.
- State is stored in plain JSON under `~/.orca-coordinator/` with `0600` file permissions. It
  holds request text and decision answers but no credentials; usage data keeps only rate-limit
  numbers, not account details.
