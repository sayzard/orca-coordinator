# Detection improvement round

A daily, time-boxed round that measures and improves how the board decides a finished turn
needs the person. Two detectors are in play:

- **the turn classifier** (`cli/lib/classify.mjs`): a small model reads the end of each finished
  turn's reply and labels it `decision`, `offer` or `none`; its prompt and synthetic examples are
  `SYSTEM_PROMPT`; cached answers are keyed by a hash of that text (`PROMPT_ID`);
- **the rules** (`detectQuestion` in `cli/lib/lanes.mjs`): the fallback while a model result is
  pending or when no model is available.

The Orca bot sends this file to the coordinator as a request once a day; the coordinator assigns
one worker to it.

## For the coordinator

- Grade **B** (the cause of each miss is unknown until measured). One worker; skip the round if
  the previous round's branch is still waiting for the person's decision.
- Assign it with `coord assign --project 886ed930-809d-4533-b59a-d60134ac7688 …` so the worker gets
  a **new worktree**. Never pass `--worktree` for the main checkout
  (`/Volumes/D/Projects/orca-coordinator`): the live board runs from it.
- When the worker reports, check the numbers in its report against
  `node scripts/detection-eval.mjs eval --model claude-haiku-5-5` in its worktree, then post one decision card: merge `detection/round-<date>` into
  `feat/detection-eval`, or drop it. Put before/after holdout numbers in the card's reason.
- Never push and never merge into `main` yourself.

## For the worker (time box: about one hour)

Repository: this one. Rubric: [`docs/detection-rubric.md`](detection-rubric.md). The labeled
corpus is private and lives in `~/.orca-coordinator/eval/`; the script below reads and writes it.

1. **Check where you are.** If `git rev-parse --show-toplevel` prints
   `/Volumes/D/Projects/orca-coordinator` (the main checkout the live board runs from), stop and
   report: the round must run in its own worktree.
   **Start from the integration branch.** In your worktree run
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
4. **Baseline:** `node scripts/detection-eval.mjs eval --model claude-haiku-5-5 --json`. It scores
   the rules and the classifier on both splits (model answers are cached per prompt version, so
   only new items cost calls). Keep the numbers.
5. **Improve the classifier first**, using only its tune errors
   (`~/.orca-coordinator/eval/errors-tune-claude-haiku-5-5.jsonl`). Group them into causes
   (invented questions from reports, offers read as decisions, option lists missed, …) and fix the
   largest ones in `SYSTEM_PROMPT`: sharper rules or new **synthetic** examples. Any change to
   the prompt text gets a new `PROMPT_ID`, so `eval --model` re-asks the model for every labeled
   item on the next run. Then, if time is left, improve the rules from `errors-tune.jsonl` the
   same way.
   Once a week (Mondays), also run `eval --model claude-sonnet-5-5` and report whether the
   difference would justify its cost. When `TYPESAFE_API_KEY` is set in your environment, also
   run `eval --model jev-1.14.0` and report Jev beside Haiku; without it, skip Jev (its key lives in
   the board's encrypted secrets, which workers cannot read).
   Check a sample of the quick-reply buttons too: a button must fully answer the question and
   never stand in for something the person has to type or do themselves.
6. **Acceptance**, all required:
   - for the classifier and for the rules: holdout decision recall does not drop and holdout
     `none` false-alarm rate does not rise;
   - each rule change has a test in `tests/lanes.test.mjs`, each prompt change keeps
     `tests/classify.test.mjs` passing; examples and tests use **synthetic** text, never corpus
     text;
   - `npm test` passes.
   Optional offers are kept out of "Needs you" (the person decided); report the `offer` flagged
   rate as a false alarm to keep low.
7. **Commit** on `detection/round-<YYYYMMDD>` only. Never push. Never touch `main`,
   `feat/detection-eval` or other branches.
8. **Report** with `worker_done`:
   - tune and holdout numbers before and after, and the classifier's false alarms separately for
     turns after 2026-11-24 (agents now ask blocking questions through AskUserQuestion menus,
     so the prose turns left are mostly offers and reports);
   - the changes, one line each, with the cause they address;
   - the remaining miss and false-alarm causes that neither the classifier nor the rules handle
     well, with counts;
   - labels you were unsure about, by id only.

## Privacy

The corpus is real conversation text from many projects. Do not copy it into the repository,
commits, test fixtures, PR text or reports; describe causes in your own words and write synthetic
examples.
