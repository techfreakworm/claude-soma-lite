## What this changes

<!-- One or two sentences on the behaviour, not the edit. "soma resume refuses an unmeasured
liveness reading" beats "update soma.mjs". -->

## Why

<!-- The problem it fixes, or the issue it closes (Fixes #123). If you measured something,
say what you ran and what you saw. -->

## How it was checked

<!-- Paste the summary lines from `npm test` (the `ℹ tests`, `ℹ pass` and `ℹ fail` lines), plus
anything you ran by hand, such as `soma doctor` or a supervised run at max_leads: 1. -->

## Checklist

- [ ] `npm test` passes on Node 24 or newer. The one exception: if the only failure is *the
      operator's live transcripts carry no usage field this module does not know*, say so. That
      test reads your own recent Claude Code transcripts and fails when your Claude Code writes a
      usage field the token meter does not classify yet.
- [ ] No behaviour change, **or** the change is intended and described above.
- [ ] New behaviour is pinned by a test that fails without the change. For a guardrail change
      (deny rules, the PreToolUse gate, the environment allow-list, the draft-only PR wrapper,
      the lease), the tests cover both what must be refused and an ordinary command that must
      still run.
- [ ] Docs are updated wherever a documented claim changed: `README.md`, `RUNBOOK.md`, and the
      prompts or the skill if they state the rule.
- [ ] No new npm dependency (the project has none, and `test/smoke.test.mjs` enforces it).
- [ ] No private data in the diff, the commit messages or this description: no real home paths,
      hostnames, account or organisation names, repository names, emails, session ids, tokens
      or transcript excerpts.
