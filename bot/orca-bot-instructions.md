# Orca Bot (manager) → coordinator handoff rules

Orca Bot is the **manager layer**. It finds and organizes work from outside (Slack, GitHub issues,
Linear, Gmail, calendar) and hands it to the coordinator **without assigning it**. The coordinator
decides which project, session, and model to use.

## What to put in the bot's SOUL.md

Orca rewrites `AGENTS.md`, `CLAUDE.md`, and `bot.json` in the bot folder (`~/.orca/bots/<bot-name>/`).
Put working rules under "How I work" in `SOUL.md`. Paste the block below as-is (replace `<bot-name>`
with the bot's name).

```markdown
## Coordinator handoff (Coordinator Board)

- Do not start workers yourself for coding, research, or fix requests; hand them to the coordinator.
  1. Write the request body to a file. Include three things: **what the work is**, **source links/locations** (issue URL, Slack thread, file path), and **what to delegate and the completion criteria**.
  2. `coord request --body-file <file> --source bot:<bot-name> [--project <repo name>] --json`
  3. Briefly reply with the resulting `id` (req_…) where the request came from.
- When asked about progress, summarize `coord status --json` and `coord request list --json`.
- Say that work needing a human decision is under "My decisions" on the Orca Coordinator Board. Never answer or approve on the person's behalf.
- Keep handling small lookups and diagnostics (checking config, querying status) directly.
```

## Automation examples

Triggers that have the bot collect work (swap in your real channels and repos):

```bash
# When a GitHub issue opens: the bot gathers context and hands it to the coordinator
orca automations create --bot <bot-name> --on "github.issue_opened in=<owner>/<repo>" \
  --name "Issue → coordinator" \
  --prompt "Read the new issue, check related PRs and commits, then hand it to the coordinator with coord request, following the coordinator handoff rules in SOUL.md."

# Every morning: triage the Slack support channel
orca automations create --bot <bot-name> --trigger daily --time 09:00 \
  --name "Morning support triage" \
  --prompt "Collect the last 24 hours of questions in #support, keep only the actionable ones, and hand each to the coordinator with its own coord request."
```

Run `orca automations trigger-options --bot <bot-name>` to see the available events.

## Bot command summary

| Purpose | Command |
|---|---|
| Hand off work | `coord request --body-file <file> --source bot:<bot-name> [--project <repo>] --json` |
| Overall status | `coord status --json` |
| Request progress | `coord request list --json` |
| Pending human decisions | `coord decision list --json` |
| Request a digest | `coord digest --json` |

If `coord` is not on PATH, run `node <repo>/cli/coord.mjs`.
