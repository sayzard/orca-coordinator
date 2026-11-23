# Writing "My decisions" cards

One card = one decision a person can read in a few seconds and answer with one button. Each session has
at most one open card; running `coord decision add` again for the same session updates that card.

Write card text in the board language (`language` in the mail's JSON line; English if absent).

## Raise / don't raise

| Raise | Don't raise |
|---|---|
| Whether to deploy, publish, or send externally | Progress reports ("tests 80% done") |
| Choices that cost money (paid APIs, large models running for a long time) | Facts the agent can check on its own |
| Product judgment: names, copy, thumbnails, design taste | Questions the person has already answered |
| Choosing between two designs (when the trade-off is real) | Questions already resolved |
| Requests too ambiguous in scope to assign | Permission and choice menus (the board already shows these as automatic cards) |

When unsure, ask: "If I had answered this yesterday, would my answer have changed the outcome?" If not,
handle it yourself.

## A good card

- `--question`: **one sentence** stating what needs deciding. Put background in `--reason`.
- `--recommend`: a **complete reply** the person can send as-is with [Send], addressed to the target
  session. Don't hide that it is a proposal, and don't write it as if the person already decided.
- `--reason`: one or two lines of rationale (including where the evidence is).
- `--option "Label=reply"`: only when the choices are clear; at most 4. Keep labels short; make replies
  complete sentences.
- `--needs-input`: if there is no basis for a recommendation, state what is needed and leave
  `--recommend` empty.
- `--priority`: `now` (blocked, nothing can proceed) / `today` / `week`. Default is normal.

Example:
```
coord decision add --session 7692f54c-... \
  --question "Raise payment-failure retries from 3 to 5?" \
  --recommend "Raise it to 5 with exponential backoff (max 30s), and add tests." \
  --reason "9 of the last 12 failures succeeded on the 4th or 5th attempt (logs/payments.log)" \
  --option "5 retries=Raise it to 5 and apply exponential backoff." \
  --option "Keep 3=Keep 3 retries and only add a failure alert." \
  --priority today --json
```

## What the board does (for reference)

- Every card shows its target session (project, workspace, title, status).
- When the person clicks [Send], the board checks whether the session has moved on since the card was
  created (fingerprint) and rejects the send if it has. Cards are therefore most accurate right after a
  digest; running another digest refreshes stale cards.
- Clicking [Ask coordinator] sends it to you as `[Coordinator Board · Delegated decision]` mail.
