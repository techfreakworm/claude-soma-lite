# Contributing to claude-soma-lite

Thanks for your interest. claude-soma-lite starts Claude Code sessions that run unattended, with
permission prompts bypassed, in other people's repositories. That shapes almost everything below:
a change is judged first on whether it keeps the guardrails honest, and only then on what it adds.

Please read [`RUNBOOK.md`](RUNBOOK.md) before you change behaviour, and §11 of it (*What is NOT
guaranteed*) before you touch anything safety-related. By taking part you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md). Security problems go through [`SECURITY.md`](SECURITY.md),
never a public issue.

## Development setup

You need **Node.js 24 or newer**. `package.json` sets `engines.node` to `>=24`, `.nvmrc` says `24`,
and `test/smoke.test.mjs` fails on anything older.

```bash
git clone https://github.com/techfreakworm/claude-soma-lite.git
cd claude-soma-lite
nvm use        # or any other way of getting Node 24+
node -v        # must print v24.x or newer
npm test
```

There is nothing to install. The project has **zero npm dependencies**, runtime or dev, and
`test/smoke.test.mjs` fails if `package.json` grows a `dependencies` or `devDependencies` field.
Everything is ES modules (`"type": "module"`) built on `node:` modules only. Please keep it that
way: a change that needs a package needs a very good reason, and an issue first.

### What `npm test` does

```json
"test": "node --test \"test/**/*.test.mjs\""
```

- It runs Node's built-in test runner (`node:test` with `node:assert/strict`) over every
  `test/**/*.test.mjs`. The suite has 1,300+ tests and takes seconds.
- Every test file gets a **throwaway state root**, however it is started: its first import is
  `test/soma-home.mjs`, which sets `SOMA_HOME` to a fresh temp directory and removes it when the
  process exits, or to `$SOMA_TEST_HOME` if you set it (useful when you want to inspect what a test
  left behind; that directory is never removed). An inherited `SOMA_HOME` is never used, so running
  one file with `node --test` is as safe as `npm test`. No test can touch a real fleet's `~/.soma`.
  A new test file needs the same first import, and `test/soma-home.test.mjs` fails without it.
- Tests that drive a real tmux use their own socket, never the `soma` socket a live fleet runs on.
  They skip themselves when tmux is not installed. The git-dependent tests skip when git is
  missing, and a few permission tests skip when run as root.
- On Node 20, the quoted glob matches nothing: the runner prints a *Could not find* line and no
  `pass` or `fail` totals at all. Silence there means the suite never ran, not that it passed.
  RUNBOOK §1 has the details.

**One test depends on your machine.** *the operator's live transcripts carry no usage field this
module does not know* reads (never writes) your most recent Claude Code transcripts and fails if
Claude Code has started writing a `message.usage` field that `bin/lib/tokens.mjs` does not
classify yet. It skips when there are no transcripts. If it is the only failure on your machine,
say so in your pull request: it means your Claude Code is newer than the token meter, which is
worth knowing, but it is not caused by your change.

## Repository layout

```
bin/
  soma.mjs              the `soma` CLI: every verb, its exit codes and its read-backs
  soma-bus.mjs          the MCP server ("the bus"): one stdio JSON-RPC process per session,
                        with a tool set per role (lead, candidate, orchestrator)
  soma-watchdog.mjs     the watchdog tick that runs the fleet, in its own tmux session
  soma-pr.mjs           the draft-only `gh pr create` wrapper, the team's only PR route
  hooks/                Claude Code hooks. The spawner registers lead-gate (PreToolUse) and
                        lead-stop (Stop). lead-postcompact (PostCompact) and orch-inject
                        (UserPromptSubmit) also ship, but nothing registers either one; they
                        need manual setup (RUNBOOK §9; the README shows the inject hook)
  lib/                  the modules: paths, config, fleet, events, lease, queue, filelock,
                        tmux, spawn, worktree, pretrust, settings-gen, tokens, notify,
                        doctor, canary, harness, standing, jsonrpc, bus-tools, seats,
                        seats-summary
  lib/wd/               the watchdog's pure decision functions: reconcile, revive, budget,
                        backpressure, admission, settle, pane-state, limit-state,
                        rotation-events
prompts/
  lead.md               the lead playbook, appended to every lead turn
  orchestrator.md       the orchestrator contract
  harnesses.json        the six loop harnesses (H1 to H6) a lead chooses from
skills/soma-promote/    the /soma-promote skill that `soma init` installs
test/                   the node:test suite, its fixtures, prose.mjs (helpers for pinning
                        rules written in prose) and soma-home.mjs (the throwaway state root
                        every test file imports first)
docs/                   ROADMAP and the design specs
research/               the research inputs behind v1
RUNBOOK.md              the operator runbook, written from the shipped code
```

### Some Markdown files are behaviour, not documentation

`prompts/lead.md`, `prompts/orchestrator.md` and `skills/soma-promote/SKILL.md` are what leads and
orchestrators actually read. Some of their rules are also enforced in `bin/`; others exist only
in the prose (for example, a lead never touching another task's worktree). Editing them changes
how the fleet behaves, so treat a change to them like a code change. `test/prompts.test.mjs` and `test/skill.test.mjs` pin
their rules section by section, using the helpers in `test/prose.mjs`, so that a rewrite cannot
quietly invert a rule while a whole-file word match stays green.

## How to propose a change

1. **Open an issue first** for anything bigger than a typo, and always for a change to a safety
   surface: the deny rules in `bin/lib/settings-gen.mjs`, the gate in `bin/hooks/lead-gate.mjs`,
   the environment allow-lists in `bin/lib/spawn.mjs` and `bin/soma.mjs`, the draft-only wrapper,
   the lease, budgets, or the `soma up` spend gate. Say what you saw, and how you measured it.
2. **Keep pull requests small and single-purpose.** One behaviour per pull request is far easier
   to review against the guardrails than a sweep.
3. **Pin it.** New behaviour comes with a test that fails without the change. Run the test against
   the unfixed code once to prove it can fail.
4. **Update the documents that state the claim.** If the change makes a sentence in `README.md`,
   `RUNBOOK.md`, a prompt or the skill untrue, fix the sentence in the same pull request.
5. **Do not try changes on a fleet in repositories you care about.** Use a throwaway repository,
   `max_leads: 1`, and stay at the terminal. That is the supervised use RUNBOOK §11.0 describes.
6. Fill in the pull request template, including the `npm test` summary lines.

## The safety-first culture, in practice

These habits run through the code and its history. Reviews will ask for them.

- **Measure, then write it down.** Comments and the RUNBOOK say *measured* or *verified* for a
  reason: many of the rules exist because an assumption about Claude Code turned out to be wrong.
  If a change rests on how Claude Code behaves, say which version you measured it on and how.
- **Three states, not two.** A check that could not observe something reports `unobserved`, never
  `ok` and never `FAIL`. A tmux read that timed out is not a dead fleet. Do not fold "could not
  tell" into either answer.
- **Read back, never assume.** `soma init` reads the MCP registration back after `claude mcp add`;
  `soma up` reads tmux back after starting the watchdog. An exit code of 0 is not evidence that
  something happened.
- **Over-denying is as fatal as under-denying.** A deny rule that also refuses
  `git push origin soma/<id>` dead-ends the task while every hostile-vector test stays green.
  Guardrail tests therefore pin both a hostile command that must be refused and an ordinary
  command that must still run.
- **A check that cannot fail is a defect.** Mutation runs were used throughout the build to find
  tests and doctor checks that stayed green when the behaviour they guard was broken.
- **Declare residuals instead of hiding them.** If you find a limit you will not fix, add it to
  RUNBOOK §11 with what you measured. A residual that is understated is worse than one that is
  overstated.
- **One spelling for each path, socket and flag.** A second spelling of the same path has already
  broken this project once, with both halves correct by their own lights.
- **The bring-up invariants are load-bearing.** RUNBOOK §10 lists the runtime invariants the safety
  model depends on, most of them undocumented Claude Code behaviour. If your change depends on
  one, name it in the pull request.

## Commit messages

Write the subject as `area: what changed`, in lower case, and use the body for why. The history
uses both conventional prefixes (`fix(spawn): …`, `docs(runbook): …`, `test(doctor): …`) and plain
module prefixes (`doctor: …`, `lead-gate: …`); either is fine. A subject that states the behaviour
beats one that names the file: *the lead's write ban rides argv, not a file every teammate
inherits* tells a reviewer far more than *update settings-gen*. If you measured something, put the
measurement in the body.

## Licence and sign-off

claude-soma-lite is released under the [MIT License](LICENSE). Contributions are accepted under the
MIT License, the same terms as the rest of the project, with no additional terms or conditions.

Sign-off is not required. You can sign off your commits with `git commit -s` if you like (it adds a
`Signed-off-by:` line for the [Developer Certificate of Origin](https://developercertificate.org/)),
but a pull request without one is fine, and you never need to amend or rebase to add it.
