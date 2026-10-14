# Changelog

All notable changes to claude-soma-lite are recorded here. The format follows
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and releases will follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once they are tagged.

No release has been tagged yet. `package.json` already says `0.1.0`, so everything below is
unreleased work that will ship as **0.1.0**. Because there is only one version so far, the entries
are grouped by the phase of work they came from, newest first. The dates are when the work landed
on `main`.

## [Unreleased]: to be released as 0.1.0

### Release preparation

#### Added

- **A licence.** claude-soma-lite is released under the MIT License (`LICENSE`). Contributions are
  accepted under the same terms (`CONTRIBUTING.md`). Signing off commits is optional.
- **A trademark notice.** The README and `THIRD_PARTY_NOTICES.md` say that claude-soma-lite is an
  independent project, not affiliated with Anthropic; that its name refers to the software it works
  with, descriptively and not as a claim of affiliation; and that it otherwise names Claude and
  Claude Code only to say what the tool works with, never as a logo.
- **Documents for a public repository:** a rewritten README, install guides for macOS, Linux and
  Windows (WSL2), `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue and pull request
  templates, and `THIRD_PARTY_NOTICES.md`, which credits loop-engineering.

### Phase 5: Account rotation (2026-09-15 to 2026-09-24)

The design was approved on 2026-09-15, and an eleven-task implementation plan (a working document
that is not published) on 2026-09-17. All eleven tasks were merged by 2026-09-20, and the
seat-order change followed on 2026-09-24. RUNBOOK §10 lists one invariant here, `crossSeatResume`,
that only a real usage-limit hit on a real second seat can prove.

#### Added

- **Seats.** A new `soma.json` key, `seats`, names extra Claude Code config directories in the
  same organisation. Each has its own login, and its `projects/` is a symlink to one shared
  transcript tree, so any seat can resume any lead and the token meter keeps reading one tree.
  Closures are recorded in `state/seats.json` under the fleet lock, and last between five minutes
  and 32 days. Rotation stays off until at least two seats are named (`bin/lib/seats.mjs`).
- **Limit classifier** (`bin/lib/wd/limit-state.mjs`). It reads the tail of a lead's transcript
  and answers `seat_window`, `seat_cap`, `spend_cap`, `none` or `unobservable`. Synthetic rows
  shaped like real limit rows are pinned as fixtures.
- **The watchdog's limits phase.** When a lead's seat hits a usage window, the watchdog closes the
  seat, kills the lead and resumes it (`claude --resume`) under an open seat. It reverts a
  rotation that the new seat rejects, reopens closures once they expire, and moves a lead at most
  three times an hour. An organisation spend cap freezes admission instead of rotating.
- **Six orchestrator events** for all of this, defined in one module
  (`bin/lib/wd/rotation-events.mjs`): `SEAT_CLOSED`, `SEAT_REOPENED`, `ROTATED`,
  `ROTATION_FAILED`, `ROTATION_UNAVAILABLE` and `BACKPRESSURE`.
- **A freeze you can see and lift.** `state/backpressure.json` now has a writer, admission obeys
  the file, and **`soma thaw`** clears an organisation spend-cap freeze. It refuses to clear a
  live rate-limit storm or a record it cannot read.
- **`soma init --seat <dir>`** installs the `/soma-promote` skill and registers the bus in a
  seat's config directory, with this fleet's state root and tmux socket pinned.
- **A seat on every launch.** Admission, revival, rotation, `soma resume`, `soma_spawn` and
  `soma_resume` all pick a seat and record it on the task row. `soma status` gains a `SEAT` column
  and a `seats:` line, and `soma_status` reports the same.
- **Six `soma doctor` checks**, taking it from 42 to 48: `lead auto-continue floor`,
  `seats readable`, `every seat logged in`, `seat projects is the shared tree`,
  `mcp enumeration covers every seat` and `seat pool state readable`.
- Every lead's settings carry `autoContinueAtUsageLimit: true`, the fallback when no seat can take
  a lead. RUNBOOK §10 explains why this is evidenced but not yet observed.
- RUNBOOK: how to provision a seat, and the tenth bring-up invariant.

#### Changed

- The worktree MCP deny list is enumerated from every seat's `.claude.json`, so a server
  registered only in one seat still cannot reach a teammate.
- A launch takes the first open seat in `soma.json` order instead of the least recently closed
  one. The order of `seats` is now its priority order (2026-09-24).

### Phase 4: Hardening against prompts nobody can answer (2026-09-07 to 2026-09-15)

On Claude Code 2.1.259, a `cd <dir> && grep <file>` compound raised a permission prompt that bypass
mode does not skip, whenever a `Read()` deny rule existed. Unattended sessions sat on it for hours
with nobody at the pane. Claude Code 2.1.263 no longer asks.

#### Added

- `soma doctor` check `claude cd-compound read runs`. It runs the asking shape once with a single
  haiku call, so a Claude Code build that asks fails in doctor before any lead spawns on it.
- An emergency lever per lead: with `$SOMA_HOME/leads/<id>/CD_COMPOUND_ASKS` present, the gate
  denies the asking shape with a reason that says what to type instead.
- **A pane census** in every watchdog tick. Each lead's pane is classified (`alive`,
  `blocked_on_prompt`, `dead_shell`, `dead_pane`, `absent`, `unobservable`, `unrecognised`), and
  entering an alarm state emits `LEAD_BLOCKED_ON_PROMPT` or `LEAD_DEAD_SHELL` with a desktop
  toast. Leaving one emits `LEAD_PANE_RECOVERED`. `soma status` gains a `PANE` column.
- An AskUserQuestion dialog in a lead's pane now reads as blocked, with `pane_kind: question`.
- Every lead gets the stateless sequential-thinking MCP server beside the soma bus, and the lead
  prompt makes using it mandatory before a hard call (2026-09-15).

#### Changed

- `soma send`, `soma_send` and the bus's wake read the pane first. They refuse to type into a
  dialog, a bare shell, a dead or missing pane, or a pane they cannot read, unless given `--force`
  or `force: true`. Measured: an Enter typed into a permission dialog approves the pending command.
- The lead prompt states the working directory as a fact and forbids `cd <worktree> &&`.
- Each worktree guard file gained 17 read-only `permissions.allow` entries (`grep`, `rg`, `cat`,
  `head`, `tail`, `wc`, `ls`, `sed -n` and read-only `git` subcommands), added to stop the prompt
  above. Measured later: they do not suppress it on 2.1.259. What they do is widen what a session
  may run without asking.
- A lead's launch settings register the gate hook once instead of twice. Claude Code already ran
  it only once, so this is cleanup.

### Phase 3: After the first real fleet (2026-07-31 to 2026-08-21)

#### Changed

- **A lead's tool and write surface now matches its teammates'** (2026-08-06). A lead may edit,
  write and commit in its own worktree. Only `git push` and `git merge` remain denied to the lead
  itself, and the shared worktree deny list still binds both roles. The `--session-guard` flag
  that switched the old ban on was retired.
- The lead model pin moved to `opus`, so leads now launch with `--model opus --effort max`
  (2026-08-17).
- `soma init` now reports whether the orchestrator inject hook is registered (registered, not
  registered, or could not tell) instead of always saying it is missing. It still does not
  install it.
- The lead prompt now says what the code enforces, and tells leads to keep deliverables in their
  worktree rather than in a temporary scratch directory.

#### Fixed

- **Every lead was `Not logged in`.** `USER` was missing from the environment allow-list, and the
  OAuth lookup in the macOS keychain does not resolve without it. It had to be added to both lists,
  the spawner's and the watchdog's, and a test now asserts that the first is a subset of the second.
- **No lead could report.** The guard file denied every user-scope MCP server by prefix, and that
  included soma's own bus, which the lead loads too. The lead gets its bus back; teammates still
  cannot take the orchestrator lease.
- `soma init` pins `SOMA_HOME` into the bus registration, so a promoted session drives the right
  fleet. It also pins `SOMA_TMUX_SOCKET`, so a promoted session's bus talks to its own fleet's
  tmux server.
- The lease heartbeat repairs a stale `tmux_pane`. Before, resuming the orchestrator into a new
  pane left every wake push going to a pane that no longer existed, silently.
- The token meter ignores `output_tokens_details`. It is a breakdown of `output_tokens`, and
  counting it would have inflated every projection by nearly half the output term.
- `soma doctor` no longer reports four FAIL rows on a healthy install. `no orch soma in user scope`,
  `guard file matches the generator`, `CLAUDE_CODE_SESSION_ID` and `budget flag path` were
  reclassified or re-measured, and each still fails on the defect it is there to catch.

#### Added

- A first-run guide in `README.md`, written from what went wrong on the first real fleet.

### Phase 2: The v1 build (2026-07-29 to 2026-07-31)

Built from a 27-task plan in about three days and merged on 2026-07-31.

#### Added

- **The `soma` CLI**: `init`, `doctor`, `up`, `down`, `status`, `attach`, `peek`, `send`, `kill`,
  `resume`, `retry`, `enqueue` and `digest`. `hold`, `release`, `gc` and `thaw` answer with a
  refusal and a reason. Exit codes: 0 ok, 1 usage or declined, 2 this machine cannot run soma,
  3 soma refused.
- **State under `SOMA_HOME`.** A relative path is refused. It holds an append-only NDJSON event log
  with read cursors, the `fleet.json` checkpoint and task state machine under a lock published
  with `link(2)`, and a single-holder orchestrator lease.
- **The MCP bus** (`bin/soma-bus.mjs`): newline-delimited JSON-RPC 2.0 over stdio, with separate
  tool sets for leads, candidates and the orchestrator. Promoting a session is one `soma_adopt`
  call, which takes a lease rather than restarting anything.
- **The lead spawner.** One git worktree per task on branch `soma/<id>`, cut from the fetched base.
  The worktree is pre-marked as trusted, the environment is scrubbed with `env -i`, model and
  effort are pinned, and each lead gets its own tmux session.
- **The watchdog** (`bin/soma-watchdog.mjs`), ticking every 30 seconds: reconcile against tmux,
  revive dead leads (up to three attempts), meter token budgets by class, admit queued tasks
  under `max_leads` and `stagger_s`, and announce settlement.
- **Guardrails.** The draft-only `soma-pr` wrapper. A worktree guard file that denies the
  operator's personal MCP servers, protected-branch and force pushes, and credential stores, and
  denies claude.ai connectors and plugin MCP servers by prefix. A PreToolUse gate (budget
  breaker, bus ownership, no writes into `.claude/` or `$SOMA_HOME/leads/`). A Stop-hook heartbeat.
  A PostCompact re-orientation hook and an orchestrator prompt-inject hook ship too, but nothing
  registers either one.
- The six loop harnesses (H1 to H6), the lead playbook, the orchestrator contract, the standing
  brief, and the `/soma-promote` skill.
- **`soma doctor`**, a preflight that names the silent-failure classes. Also the canary's
  invariant evaluation (its live driver is a declared gap, so `soma up --canary` cannot pass),
  and the spend gate in `soma up`: a worst-case token projection plus an interactive
  confirmation, with no `--yes`.
- Desktop notifications through `osascript` on macOS, `notify-send` on Linux, and a PowerShell
  toast on WSL2.
- `RUNBOOK.md` and `docs/ROADMAP.md`.

#### Fixed

These were found and fixed before the merge:

- The lead's write ban sat in a settings file that every teammate also inherits, so no teammate
  could write code. It moved onto the lead's command line. Phase 3 then lifted it.
- The final review's two Critical findings. Every mutating bus tool call re-checks the lease, so
  a demoted orchestrator can no longer act. The gate tells a lead from a teammate by session id.
- `soma doctor` reads a hook's command, not only its matcher.
- Both PreToolUse matchers were too narrow, so the gate now runs on every tool.

#### Security

- A deny family for credential stores, on both the `Bash(...)` and the `Read(...)` surface. It was
  added after a review agent read live OAuth tokens through the macOS keychain CLI during the
  build.
- Writes under `$SOMA_HOME/leads/`, and to the state root itself, are denied to every session.
- `gh api` writes to refs and file contents are denied, and git's global-option spellings of the
  lead's banned verbs are closed.
- The gate hook is also registered from outside the worktree it defends, so an emptied guard file
  no longer unregisters it.

### Phase 1: Design (2026-07-29)

- The design spec and a research corpus. A design panel of three candidate architectures, with a
  judge's verdict and a gap critique, chose the design; those working papers are not published.
- The operator's decisions D1 to D6, including `max_leads: 10` and the Node 24 floor.
- The 27-task v1 implementation plan, a working document that is not published.

[Unreleased]: https://github.com/techfreakworm/claude-soma-lite/commits/main
