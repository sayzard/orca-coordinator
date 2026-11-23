# Detection improvement round

A daily, time-boxed round that measures and improves how the board decides a finished turn
needs the person (`detectQuestion` in `cli/lib/lanes.mjs`). The Orca bot sends this file to the
coordinator as a request once a day; the coordinator assigns one worker to it.

## For the coordinator

- Grade **B** (the cause of each miss is unknown until measured). One worker; skip the round if
  the previous round's branch is still waiting for the person's decision.
- When the worker reports, check the numbers in its report against `node scripts/detection-eval.mjs eval`
  in its worktree, then post one decision card: merge `detection/round-<date>` into
  `feat/detection-eval`, or drop it. Put before/after holdout numbers in the card's reason.
- Never push and never merge into `main` yourself.

## For the worker (time box: about one hour)

Repository: this one. Rubric: [`docs/detection-rubric.md`](detection-rubric.md). The labeled
corpus is private and lives in `~/.orca-coordinator/eval/`; the script below reads and writes it.

1. **Start from the integration branch.** In your worktree run
   `git merge --ff-only feat/detection-eval`, then `git switch -c detection/round-<YYYYMMDD>`.
   If the fast-forward fails, stop and report: do not rebase or reset other branches.
2. **Refresh the corpus:** `node scripts/detection-eval.mjs build`. It adds new turn ends from
   Claude Code and Codex transcripts and the board's signals (dismissed cards, answered cards,
   replies to turns the board did not flag).
3. **Label new items** as an LLM judge, following the rubric:
   `node scripts/detection-eval.mjs queue --n 40 --split tune` and
   `node scripts/detection-eval.mjs queue --n 20 --split holdout`. Board-signal items come first.
   Write labels as JSONL with `"by": "llm:<your model>"` and import them with
   `node scripts/detection-eval.mjs label <file>`. Judge each item without running the detector.
4. **Baseline:** `node scripts/detection-eval.mjs eval --json`. Keep the numbers.
5. **Improve** using only the tune errors (`~/.orca-coordinator/eval/errors-tune.jsonl`). Group
   them into causes first (missing phrasing, question too far up, options without a question,
   questions the agent answers itself, …) and fix the largest causes that a rule can fix
   reliably. Keep changes in `cli/lib/lanes.mjs` unless a cause needs more; then propose it in the
   report instead of building it.
6. **Acceptance**, all required:
   - holdout decision recall does not drop and holdout `none` false-alarm rate does not rise;
   - each new rule has a test in `tests/lanes.test.mjs` with **synthetic** text, never corpus text;
   - `npm test` passes.
   Report the `offer` flagged rate but do not change how offers are treated: whether optional
   offers belong under "Needs you" is the person's decision and has not been made.
7. **Commit** on `detection/round-<YYYYMMDD>` only. Never push. Never touch `main`,
   `feat/detection-eval` or other branches.
8. **Report** with `worker_done`:
   - tune and holdout numbers before and after;
   - the changes, one line each, with the cause they address;
   - the remaining miss and false-alarm causes that rules cannot fix well, with counts (this
     decides whether a model-based check or an agent-side convention is worth building);
   - labels you were unsure about, by id only.

## Privacy

The corpus is real conversation text from many projects. Do not copy it into the repository,
commits, test fixtures, PR text or reports; describe causes in your own words and write synthetic
examples.
