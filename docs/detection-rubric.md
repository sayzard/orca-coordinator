# Labeling rubric: does this finished turn need the person?

The board shows a finished turn under **Needs you** when its final reply asks the person for
something. To measure and tune that detection (`cli/lib/lanes.mjs` `detectQuestion`), finished
turns are labeled with one of three labels. Judge the **end of the agent's final reply**: what
the agent is waiting for when it stops.

| Label | Meaning | Typical endings |
|---|---|---|
| `decision` | The agent stopped and does not go on without the person: a choice, an approval, an answer, an action only the person can take, or a go-ahead for a next step it announced but did not start. | "Shall I push?", "Which one: A or B?", "Tell me whether to keep the old flag.", "Run `sudo -v` in the terminal, then I continue.", a list of options with no recommendation taken, "Decision needed: …", "I'll start with step 2 now." (and the turn ends) |
| `offer` | The work is done; the agent adds an optional follow-up the person may take or ignore. Nothing is blocked. | "If you want, I can also add docs.", "Let me know if you need anything else.", "필요하면 말씀해 주세요.", "원하시면 …하겠습니다." |
| `none` | A report or progress note with nothing asked of the person. | "All tests pass.", "Pushed to main; CI passed.", explanations that contain a question the agent itself answers |

## Rules

1. **Judge the reply, use the next message as a hint only.** The person's next message (`next`)
   shows how they treated the turn, but people also start new work after a report. A short answer
   such as "ㅇㅇ", "1번", "push" after a question supports `decision`; a new unrelated request
   does not make the turn `none` or `decision` by itself.
2. **Blocking beats optional.** If the reply both offers extras and asks something blocking,
   label `decision`.
3. **A turn that stops right after announcing its next step is `decision`** (a "stalled" turn).
   The reply ends by saying what the agent is about to do ("I'll go ahead in this order and start
   with step 2 now", "다음으로 로그 수준을 낮추고 재시작하겠습니다"), the turn ended without
   starting it, and nothing is still running: the work waits until the person says "go ahead".
   This is rule 7's test, and it holds with or without "unless you object". It stays `none` when
   - the reply says it resumes on its own: a background job, a subagent, a worker or a scheduled
     run is still going and the agent carries on when it reports ("The build is running; I'll
     post the result when it finishes");
   - the work is listed for later, for someone else, or behind an event outside the chat
     ("Remaining: tag the release after QA", "I'll rebase once the PR is merged"), or is a
     standing promise ("From now on I'll batch the deploys");
   - the announced step was already done in the same turn (the reply goes on to report it).

   A step the agent makes depend on the person's wish ("If you want, I'll do X now") is still an
   `offer`. The label judges the reply text; on the live board a session whose background job is
   still running is kept out by its state, whatever the text says.
4. **Choices without a question mark count.** Option lists ("A / B / C", "1번 또는 2번") that
   the agent leaves for the person are `decision` even with no question sentence.
5. **Questions the agent answers itself** ("Why did it fail? Because …"), quoted questions, and
   questions inside code are not asks.
6. **Requests for the person to act** (approve in a browser, plug in a device, re-run a command
   with their credentials) are `decision`: the work waits on them.
7. When unsure between `decision` and `offer`, ask: *if the person never replies, is the agent's
   work incomplete?* Yes → `decision`; no → `offer`.

## Label record

One JSON object per line:

```json
{"id": "<item id>", "label": "decision", "line": "<the sentence that decides it, or empty>", "by": "llm:<model>", "note": "<optional, short>"}
```

`by` is `person` for labels the person gave; those win over model labels.

## Privacy

Items are real conversations. They stay in the coordinator home (`~/.orca-coordinator/eval/`).
Never copy their text into the repository, tests, commits or reports outside this machine;
write synthetic examples instead.
