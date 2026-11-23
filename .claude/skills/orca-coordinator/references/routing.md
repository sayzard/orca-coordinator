# Grades and model routing

## Grade criteria

| Grade | Kind of work | Examples |
|---|---|---|
| **A** | Work that sets structure. Decisions that are costly to reverse if wrong. Design spanning multiple modules or services | Data model redesign, choosing a sync architecture, new service boundaries |
| **B** | Work that needs design, has an unclear cause, or carries high risk | Investigating a bug that won't reproduce, changing payment or auth code, analyzing a performance bottleneck |
| **C** | Work with a defined change scope and completion criteria | Adding a specced feature, fixing a failing test, one unit of refactoring |
| **D** | Simple work: reviewing existing material and summarizing or tidying it | Summarizing logs, tidying docs, listing dependencies, fixing typos |

When unsure, go one grade higher. You can split one request into separate assignments, e.g.
"investigate (D/B) → implement (C)".

## Default routing table (`routing` in `~/.orca-coordinator/config.json`)

| Grade | Candidates (in order) |
|---|---|
| A | claude `claude-fable-5-2` xhigh → claude `claude-opus-5-5` max → codex `gpt-6.2-astra` xhigh |
| B | claude `claude-fable-5-2` high → claude `claude-opus-5-5` xhigh → codex `gpt-6.2-astra` high |
| C | claude `claude-opus-5-5` high → codex `gpt-6.2-sol` high → claude `claude-sonnet-5-5` high |
| D | claude `claude-sonnet-5-5` medium → codex `gpt-6-luna` high |
| M | (the coordinator itself) claude `claude-opus-5-5` high → codex `gpt-6.2-sol` high |

Model ids were verified against Claude Code and Codex CLI on 2026-11-23; adjust them in
`~/.orca-coordinator/config.json` as providers release new models.

## How `coord route` / `coord assign` choose

1. Walk the candidates in routing-table order.
2. Skip a candidate if it is in `excludedAgents` (default: gemini), is not installed
   (`orca agent installed`), is not claude/codex when `--needs-hooks` is set, or has remaining usage
   below `reservePercent` (default 15%).
3. Remaining usage = 100 − (the highest used percentage across the session, weekly, and monthly
   windows). Fable models also check the `fableWeekly` window. If usage data is unavailable (e.g. not
   signed in), the candidate is not skipped; its usage is reported as unknown.
4. Pick the first candidate left. If every candidate is below the reserve, pick the one with the most
   headroom and set `degraded: true`.

Routing picks among providers using the usage Orca reports for each signed-in provider
(`orca account list`); it does not pool multiple accounts of one provider.

## Changing it

- Reserve: `coord setup --reserve 20`
- Excluded agents: `coord setup --exclude gemini,cursor`
- The routing table itself: edit `routing` in `~/.orca-coordinator/config.json` (same shape as the
  table above)
