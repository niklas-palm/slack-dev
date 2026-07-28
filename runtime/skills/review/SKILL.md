---
name: review
description: Review a code change — a PR, a diff, a branch, or specific files — for real defects, then report them or fix them on the PR branch. Load whenever you're asked to review, critique, "look over", or check a change before it merges. Runs disciplined single-role passes and verifies findings by RUNNING the code, so you report real bugs instead of plausible guesses.
---

# Skill — review a change (single-role passes, verify by running)

You are one agent, so you can't fan out parallel reviewers. Do the next best thing: look at the same
change **once per role**, each pass hunting one class of problem. A pass looking for one thing finds
more than a pass looking for everything.

The failure mode to avoid is not missing bugs — it's **inventing them**. A confident list of plausible
nits wastes the reader's time and teaches them to ignore you. Every finding needs a reproduction.

## 1. Set up before you critique

- **Get the diff.** For a PR: `gh pr checkout <n>` then `git diff main...HEAD` (substitute the real
  default branch). For a branch or working tree: `git diff`. Know exactly which lines changed.
- **Establish the baseline.** Run the repo's own check command *before* you critique anything, so a
  failure you find is attributable to the change and not pre-existing. Find it in the repo's
  `AGENTS.md` / `CLAUDE.md` / `CONTRIBUTING.md` or the `scripts` block of `package.json` — commonly
  `npm run check`, `npm test`, `make test`, `pytest`.
- **Read the rules that govern the touched code** — the repo's durable instructions and whatever docs
  they point at. Many "bugs" are the code correctly following a documented decision. Know it first.

## 2. One focused pass per role

Pick the roles that fit the change; skip the ones that don't.

- **Correctness** — adversarial. Walk concrete inputs: empty, huge, unicode, boundary, concurrent,
  error paths. Don't speculate — **run** the case (a scratch script, the test suite, a REPL) and watch
  it pass or fail.
- **Robustness & resources** — failure modes, cleanup, leaks, timeouts, retries, unbounded growth.
  What happens when a dependency is slow, errors, or returns something unexpected?
- **Contract & conventions** — does it match the interfaces it implements and the surrounding code? A
  finding that would make the code *inconsistent with its siblings* is usually not a fix. Check a
  sibling before you report it.
- **Simplicity** — dead code, duplication, over-engineering, unclear names. Bias toward *removing*.
- **Docs consistency** — did the change falsify a claim in a README, an architecture doc, a comment,
  or a diagram? Scope this to the **whole repo, not the diff**: staleness lives in files the diff never
  touched. This is the most-skipped role and the one whose miss ships wrong docs.

## 3. Verify before you believe it

For each candidate: state the exact input or scenario, then **run it**. If you can't make it fail,
downgrade it or drop it. Prefer running the real code over reasoning about it.

## 4. Act

- **Reporting:** keep only verified findings, ranked by severity. For each: `file:line · the problem ·
  the exact failing input · suggested fix · severity`.
- **Fixing on a PR branch:** fix only high-confidence, behaviour-preserving findings; add a regression
  test for each real bug; re-run the checks. Then pass again — your fix is new code. Never push to the
  default branch. Skip subjective refactors that need product judgement, and say why.

## 5. Report

Lead with the verdict (✅ nothing actionable / 🔴 N issues), then findings, most severe first. If a full
set of passes found nothing real, **say that plainly** — don't manufacture nits to look thorough. Clean
up any scratch files you made.

- **On a PR:** submit a real GitHub review — a summary body plus inline comments anchored to the
  changed lines, `event: "COMMENT"` — see the **github** skill, step 5. You inform; a human approves.
- **In Slack:** post the verdict and findings to the thread with `reply_to_thread`. If the list is long,
  put the detail in an `upload_file` and summarise in the message.

## When to stop

Stop when a complete set of passes turns up nothing actionable — only "verified OK" and inherent
trade-offs. If findings stop shrinking, or a fix keeps re-breaking something, stop and hand back with
the current state and the open trade-off. Convergence is the goal, not perfection.
