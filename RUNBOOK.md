# claude-soma-lite — operator runbook (v1)

This document is written **from the shipped code**, not from the design. Where the design spec
or `docs/ROADMAP.md` disagree with `bin/`, the code is what runs and the code is what is
described here. Discrepancies found while writing are called out inline.

---

## 0. Read this part before you run anything

`soma` turns one Claude Code session into an **orchestrator** that runs up to **ten parallel lead
sessions**. Each lead is a real, detached `claude` process. Each lead spawns a **team of agents
that write code in a real git worktree with permissions bypassed** (`--dangerously-skip-permissions`).
Nobody is watching the panes.

So four things are true at once, and you should hold all four:

1. **The money is real and the worst case is large.** `soma up` shows you the number and makes you
   type a word before the queue opens. See §5.
2. **The safety model is a set of deny rules over command strings.** It is genuinely load-bearing —
   58 rules, each individually pinned by a test — and it has a hard ceiling: a subprocess defeats
   it. §11 states exactly what is not guaranteed.
3. **The canary that is supposed to prove the safety model holds on *your* machine cannot run on
   this build.** Its evaluator ships; its live driver is a declared v1.x gap. So the nine
   invariants in §10 are yours to establish by hand, once, before you trust the fleet.
4. **v1 is a spine, not a product.** Several verbs refuse with a reason instead of acting, one
   important hook is not installed by anything, and a handful of `soma.json` keys are read by
   nothing. Every one of those is named here rather than left for you to find.

If you take one thing from this document, take §11.

> **If you read an earlier copy of this document, §11.9 has changed.** It used to open with an
> instruction to hand-edit `bin/lib/settings-gen.mjs` before your first run, because the lead's
> settings file — which every teammate inherits — took `Edit`, `Write` and `NotebookEdit` off the
> whole fleet. **That is fixed in the shipped tree; do not apply the edit, and if you already did,
> `git checkout` it.** §11.9 records what it was, so a fleet that once committed nothing has an
> explanation.

---

## 1. Requirements

| | need | why |
|---|---|---|
| **Node** | **24 or newer. Hard floor.** | `package.json` sets `engines.node: ">=24"`, `.nvmrc` says `24`. The watchdog is launched with `process.execPath`, so whichever node ran `soma up` is the one that supervises the fleet. |
| **tmux** | ≥ 3.2 | Every lead, and the watchdog, is a tmux session. No tmux → no fleet. |
| **git** | ≥ 2.31 | One worktree per task. |
| **`claude`** | on `PATH`, authenticated | `soma init` registers the MCP bus through it; leads are `claude` processes. |
| **`gh`** | authenticated | Teammates open the draft PR through `bin/soma-pr.mjs`. |
| **OS** | macOS or Linux. **Windows is WSL2 only.** | Native Windows has no tmux, therefore no supervisor, no wake and no split panes. `bin/lib/notify.mjs` has a WSL2 transport (`powershell.exe` toast) precisely because WSL2 *is* the Windows story. |

Zero runtime npm dependencies — there is nothing to `npm install`.

### The Node 24 floor fails quietly, so check it deliberately

`npm test` is `node --test "test/**/*.test.mjs"`. Node 20 does not expand that glob, so it prints:

```
Could not find '…/test/**/*.test.mjs'
```

and **no `ℹ pass` or `ℹ fail` line at all.** It exits 1, so `set -e` catches it — but a human or a
script scanning output for `fail 0` sees *nothing*, which reads like a clean run rather than a run
that never happened. Always confirm the node you are on:

```bash
node -v                  # must be v24.x or newer
npm test                 # expect: ℹ pass 902   ℹ fail 0
```

Verified on this build: **902 pass / 0 fail on Node v24.14.1.**

---

## 2. Install

```bash
cd <soma checkout>
nvm use                       # reads .nvmrc -> 24
npm test                      # 902 pass / 0 fail, on node 24
```

`package.json` declares `"bin": { "soma": "bin/soma.mjs" }` but the package is `private`. Either
put it on `PATH` (`npm link` in the checkout, or a shell alias) or invoke it directly:

```bash
node <soma>/bin/soma.mjs status
```

Every example below writes `soma`; substitute the long form if it is not on your `PATH`.

---

## 3. `SOMA_HOME` — the state root

Default `$HOME/.soma`. Override with `SOMA_HOME`.

> **A relative `SOMA_HOME` is refused outright.** Not resolved — refused, with the whole diagnosis
> in the message. A relative root resolves against *each process's own cwd*, so the watchdog, the
> gate hook and every `soma` command would agree on the spelling and silently disagree on the
> directory: heartbeats no reader looks at (every healthy lead reads as stalled), a
> `BUDGET_TRIPPED` flag the gate never finds, a `fleet.lock` that excludes nobody, and two
> orchestrators each holding "the" single-holder lease. Every path comes out absolute and
> plausible; nothing errors anywhere.
>
> **A leading `~` is expanded by your shell only when unquoted**, and is not absolute on its own.
> `SOMA_HOME=~/soma` works. `SOMA_HOME="~/soma"` and `SOMA_HOME='~/soma'` are refused. Spell the
> path out if you are unsure.

`/x/soma/` and `/x/soma` are normalised to the same root, so a trailing slash is harmless.

The tree `ensureTree()` guarantees:

```
$SOMA_HOME/
  soma.json              your config (optional; DEFAULTS apply without it)
  state/                 fleet.json, fleet.lock, orch.lease, QUEUE_PAUSED, seats.json, backpressure.json (written on an org spend cap or a rate-limit storm)
  events/                <stream>.ndjson — one per lead, plus orch.ndjson
  heartbeats/            <lead> — touched by the lead's PostToolUse hook
  leads/<id>/            meta.json, brief.md, mcp.json, settings.json, settings.launch.json,
                         BUDGET_TRIPPED, BUDGET_WARNED (BUDGET_WARNED.delivered once
                         the gate has handed the lead its 80% note).
                         meta.json is written by each spawn, before the launch: id, repo,
                         base_branch, base_sha (the commit the worktree was cut from;
                         null if a reused one's cut was never recorded), branch, worktree,
                         reused, session_uuid, tmux_target, spawned_at. A resume leaves it
                         alone. It has no RC URL (§9)
  logs/                  watchdog.log, <lead>.log (tmux pipe-pane transcripts)
  worktrees/<repo>/<id>/ the lead's checkout, on branch soma/<id>
  digests/               (v1.x composer not built — directory exists, stays empty)
```

**One more filesystem requirement:** the volume holding `$SOMA_HOME` must support `link(2)`. Every
`fleet.lock` acquisition publishes the lock with a hard link, so on exFAT/FAT and some FUSE or
cloud-sync mounts mutual exclusion cannot work at all. `soma up` and `soma init` probe this once at
startup and refuse with **exit 2** rather than printing the same diagnosis on every 30 s tick
forever.

---

## 4. `soma.json`

Optional. `loadConfig()` is `DEFAULTS` with your file layered over it, key by key, and unknown keys
are preserved. A file that does not parse is refused, never read as the defaults, and so are a
`seats` that is not an array and a `max_leads` that is not a non-negative integer (a numeric string
such as `"10"` is read as its number). `soma up` then exits 2 with a message naming the key, whether
or not a watchdog is already running; a watchdog already running logs `WATCHDOG_ERROR` on every tick
and acts on nothing until the file is fixed, exactly as it does for an unparseable file, and `up`'s
refusal beside it says so. Minimum useful file — **`repos` is the one you must fill in**, because a
task naming an unconfigured repo cannot spawn:

```json
{
  "repos": {
    "myapp": { "path": "/Users/me/code/myapp", "base_branch": "develop" }
  },
  "max_leads": 3,
  "teammate_mcp_allow": []
}
```

### The dials that change behaviour

| key | default | effect |
|---|---|---|
| `max_leads` | `10` | Concurrency cap. **This is the multiplier on your worst-case spend** (§5). Lowering it is the one lever that lowers exposure. Must be a non-negative integer; a numeric string such as `"10"` is read as its number. |
| `stagger_s` | `90` | Minimum seconds between admissions, so ten leads do not hit the API in the same second. At most one launch per tick regardless. |
| `tick_ms` | `30000` | Watchdog cadence. Floored at 1000. |
| `blocked_slot_minutes` | `120` | How long a lead that asked a question keeps its admission slot before the row flips to `blocked` and the slot frees. |
| `settle_minutes` | `30` | Quiet window before `FLEET_SETTLED`. |
| `budgets` | see below | Per-lead token/turn/wall caps by class. |
| `repos` | `{}` | `{ "<key>": { path, base_branch, verify_hint } }`. `base_branch` falls back to `develop`. A task without its own `verify_hint` takes the repo's at enqueue. |
| `lead_effort` | `'max'` | The lead's reasoning level: its `--effort` flag, and the level teammates inherit while `teammate_effort` is `inherit`. One of `low`, `medium`, `high`, `xhigh`, `max`; anything else reads as `max`. Takes effect at the next spawn or resume. |
| `teammate_mcp_allow` | `[]` | Hands specific MCP servers back to teammates. Read `README.md` for its two measured limits before using it. |
| `lead_branch_push` | `true` | Lets a lead push its own branch, `soma/<id>`, to `origin` with exactly `git push -u origin soma/<id>` (or `git push origin HEAD:soma/<id>`, `refs/heads/soma/<id>`), as a command of its own, from the root of its worktree. The gate still refuses the lead every other push (another branch or remote, a bare push, `--all`, `--mirror`, `--tags` and tag refspecs, any force or delete, and every chained, wrapped or global-option spelling) and every `git merge`; the worktree deny list still binds everyone. The spawner sets `SOMA_LEAD_BRANCH_PUSH=1` in the lead's environment only when this is exactly `true`, and the gate refuses the push when the variable is absent, so `false`, any other value, and a lead started before this key existed all keep "the lead never pushes". An edit takes effect at the lead's next spawn or resume. Not covered: git config set by an earlier command (`push.followTags`, `remote.origin.pushurl`, `url.<x>.pushInsteadOf`) can widen what the push sends or where it goes, and for a task id ending in `-d` or `-f` the deny list's force and delete rules refuse every spelling a lead may use (a teammate can still push it with the refspec quoted, `git push origin 'soma/<id>'`). |
| `seats` | `[]` | The account pool (design 2026-09-15 §2): `[{ "config_dir": "~/.claude-seat-b", "label": "seat-b" }]`, one entry per Claude Code config dir that holds a separate `claude auth login` and whose `projects/` is a symlink to the fleet's shared transcript tree. Empty = one account, no rotation. It must be an array: `{}`, a string, a number or `null` is refused (above). A malformed *entry* inside the array is not refused at load; doctor's `seats readable` row names it. An array, so an edit **replaces** the pool, and its ORDER is the priority order — every launch takes the first entry that is open and not `unverified`, so the account you watch goes LAST (§7 step 4). `~` expands against your home when the pool loads; a `config_dir` must be **absolute or `~`-prefixed** — a relative one is `resolve()`d against the cwd of whichever process read the pool, so a watchdog started from your home and a `soma` command run inside a repo name two different directories for the same entry, and the one that does not exist simply contributes nothing to the worktree MCP deny list without saying so; an empty `config_dir` is refused with a sentence; a missing `label` defaults to the dir's basename. `lib/seats.mjs` reads it; closures land in `state/seats.json` (`closed_until` is epoch ms, `0` = open) and are never shorter than five minutes nor longer than 32 days. A corrupt `state/seats.json` is never overwritten — fix or delete it by hand. |
| `resume_context_fraction` | `0.7` | Revival guard as a fraction of the context window, not an absolute. |
| `tested_claude` | `2.1.178`–`2.1.999` | **Enforced, and this row used to say it was not.** The watchdog reads `claude --version` once per process and closes admission fleet-wide while it sits outside this range, emitting `VERSION_GATE`. Measured: `2.1.220` in range; `2.1.177`, `2.2.0` and `3.0.0` all out. It fails **open** only when the version or a bound will not parse. **The first Claude Code minor bump stops your queue** — widen `max` or re-run bring-up. |

### Budget classes, as shipped

| class | `tokens_cap` | `turn_cap` | `wall_ms` |
|---|---|---|---|
| `research` | 5,000,000 | 600 | 2 h |
| `standard` | 20,000,000 | 600 | 8 h |
| `iterate` | 38,000,000 | 600 | 12 h |
| `review` | 25,000,000 | 600 | 10 h |
| `babysit` | 8,000,000 | 0 (disabled) | 0 (unbounded) |

`tokens_cap` meters **the lead and its whole team** (teammate turns go to their own transcripts).
A numeric string such as `"60000000"` is read as its number. Any other value that is not a
non-negative number loads as it is: the breaker refuses it for that class's leads alone
(`WATCHDOG_ERROR` each tick), and `soma up` refuses to project it.
`turn_cap` is calibrated per lead and is a backstop, not a budget. Warn at 80 %, hard trip at 100 %.
A warning logs `BUDGET` on the orchestrator's stream and writes `leads/<id>/BUDGET_WARNED`, once per
lead session and allowance; the PreToolUse gate attaches a one-time `soma:` note to the lead's next
allowed tool call and renames the flag to `BUDGET_WARNED.delivered`, and teammates never get it. Per
session, not per lead: the spend is the worktree's and carries across a revival, so a lead revived
onto a fresh session (a new session uuid, none of the old context) is warned again on the tick it
relaunches, while a resumed lead keeps its session and its note. Per allowance, because a cleared
trip is a new one (below). Every `BUDGET` names both: `session_uuid` and `grants`. A trip writes
`leads/<id>/BUDGET_TRIPPED`, which the PreToolUse gate reads to deny every tool except the soma bus —
so a tripped lead can still file `COMPLETED`, `ERROR` or a `NEEDS_INPUT` saying how much more it
needs and why, and nothing else.

**Clearing a trip: `soma clear-trip <lead>`**, or the orchestrator's `soma_clear_trip(lead)`. Both
go through one function (`wd/budget.clearTrip`), which removes the flag and raises the row's
`budget_grants` in one fleet transaction: each clear grants one more allowance of the lead's class,
and the meter judges every cap at (1 + grants) times the class's from its next tick. Each clear is
logged as `TRIP_CLEARED`, and the lead is told again at 80% of the new allowance. Both refuse a lead
that is not tripped, and a row the breaker does not meter (anything but `spawned` and `blocked`).
**`rm leads/<id>/BUDGET_TRIPPED` alone is not a clear**: the lead is still over its cap, so the next
tick trips it again, with a second `BUDGET` at 100 % and a second toast. One limit, stated plainly:
a wall-clock trip cleared long after it fired can still be past (1 + grants) × `wall_ms`, so the
next tick trips it again, and another clear adds another allowance.
A lead is priced at the class pinned at enqueue when soma.json defines it, else at the class its
newest `HARNESS` report reserves, else at `standard`; README's budget section has the exact rule
and when `HARNESS_DEFAULTED` fires. `soma_status` shows that class as `budget_class`, the clears as
`budget_grants`, and as `budget_pct` the share of the allowance, (1 + `budget_grants`) × its
`tokens_cap`, the lead and its team have spent (`budget_est_tokens`), for a spawned or blocked lead,
the only rows the breaker meters.

### Config keys that are declared and read by nothing

Present in `DEFAULTS`, accepted from your `soma.json`, and **wired to no behaviour in this build**:

- `env_allow` — deliberate, and `docs/ROADMAP.md` explains at length why the obvious
  implementation is the wrong one. Do not expect it to forward anything.
- `linger_minutes` (45) and `stall_minutes` (20) — the reapers that would read them are not in the
  tick. Terminal leads keep live panes; a stalled lead is not killed on a clock.
- `notify_policy` (`full`) — no reader. Notifications are per-event and can be chatty at ten leads.
- `team_size_max` (3) — referenced only in a comment. Nothing enforces it; the lead's playbook does.

> **Contradiction with `docs/ROADMAP.md`:** it states "`soma doctor` reports any
> declared-but-unimplemented config key instead. A visible dead key beats an invisible one."
> There is no such check in the shipped doctor — `CHECKS` has 48 entries and none of them is
> about dead config keys. The list above is that report.

---

## 5. The golden path: `init` → `doctor` → `up`

**Without `--canary`.** See §5.4 for why.

### 5.1 `soma init`

```bash
soma init
```

Does three things and names all of them:

1. Creates the state tree and probes the hard-link support of `state/`.
2. Copies `skills/soma-promote/` into `<claude config root>/skills/soma-promote` **and reads
   `SKILL.md` back** to confirm its frontmatter survived — a `cpSync` that succeeded is not
   evidence that `/soma:promote` exists.
3. Registers the MCP bus at **user scope**, `claude mcp add soma -s user -- <node> <soma>/bin/soma-bus.mjs`,
   then **reads it back** with `claude mcp get soma`. `claude mcp add` can exit 0 leaving nothing
   readable, so the exit code alone is not accepted. Registered with **no `SOMA_SESSION_ID` and no
   `SOMA_ROLE`**, so every session on the machine starts as a read-only *candidate* carrying
   `soma_adopt` and `soma_status`.

With `--inject-hook` it also registers the inject hook, which is opt-in (below).

Exit 2 if the skill or the bus could not be established (or, with `--inject-hook`, the hook).
Otherwise it prints the state root, the claude config root, the node it used, and:

```
soma initialized. Next: `soma doctor`, then `soma up`.
```

`soma init --seat <dir>` does the same skill install and bus registration into **another** config dir —
one seat of the account-rotation pool — with **this fleet's** `SOMA_HOME` and `SOMA_TMUX_SOCKET` pinned:
every `claude mcp …` call, the read-back included, runs with `CLAUDE_CONFIG_DIR=<dir>`. Spell `<dir>`
absolute or `~`-prefixed, exactly as it will appear in `soma.json.seats`; it must already exist and be
logged in (`mkdir <dir> && CLAUDE_CONFIG_DIR=<dir> claude auth login` — `claude auth login` is the login
subcommand on 2.1.273). On success it prints the `soma.json.seats` entry to add and points at
every `soma doctor` check with `seat` in its name. Exit 1 for a missing, empty or relative `<dir>`, 2 for one that is not
a directory and 2 for one that could not be stat'ed at all (EACCES on a parent) — which says so in
those words rather than telling you to `mkdir` a directory that already exists. Nothing is installed
or registered on any of those paths.

#### The inject hook is opt-in: `soma init --inject-hook`

`bin/hooks/orch-inject.mjs` is the pull you never have to ask for: it staples unread event headers
onto whatever the lease holder types next. Plain `soma init` does not register it, because a
user-scope `UserPromptSubmit` hook is a `node` spawn on every prompt of every session using that
config root (the orchestrator, every lead and teammate, every unrelated project), and every one but
the lease holder exits having injected nothing. So plain `init` reports it instead, in one of three
states read from `<claude config root>/settings.json`:

```
inject hook: registered — a UserPromptSubmit entry in <config root>/settings.json runs orch-inject.mjs, … It pins SOMA_HOME=<root>, this fleet's root.
inject hook: NOT installed — <config root>/settings.json registers no UserPromptSubmit hook running orch-inject.mjs, …
inject hook: NOT OBSERVED — <config root>/settings.json could not be read (…), …
```

`registered` names the state root the entry pins: this fleet's, another one, or none. `NOT OBSERVED`
is not "missing": an absent or unparseable file is not evidence either way.

To register it, from the shell that pins your fleet:

```bash
soma init --inject-hook
```

It appends one entry to `hooks.UserPromptSubmit`,
`SOMA_HOME='<root>' '<node>' '<soma>/bin/hooks/orch-inject.mjs'`, keeps every other key and entry
in order, and publishes the file tmp+rename. The two pins are the bus registration's: `SOMA_HOME`,
because your sessions do not export it and an unpinned hook silently reads the default root, and
the absolute `node`, because `node` off a session's PATH is whatever nvm last selected. It prints
one of three things:

- `inject hook: registered by soma init --inject-hook — …`: added.
- `inject hook: already registered — …`: a hook running `orch-inject.mjs` was already there, and
  the file was not rewritten. If that entry pins another state root, `init` also warns and exits
  **2**. If it pins none, `init` only warns: a session started from your wrapper carries the right
  root, but an unpinned hook is one shell away from reading `~/.soma`.
- `soma init: the inject hook was NOT registered: …`, exit **2**. A `settings.json` that cannot be
  read or parsed, or whose `hooks` or `hooks.UserPromptSubmit` has the wrong shape, is refused and
  left exactly as it was, and so is a symlink to a missing file. Only a missing file is created; a
  symlinked `settings.json` is written at its target, so the link survives.

`--inject-hook` with `--seat` is refused (exit 1) before anything is touched: a seat runs leads,
and the hook never injects into a lead.

**Without the hook or the `soma watch` Monitor (§6.1), an orchestrator that is not polling is blind
to a blocked lead.** A lead that asked a question sits there holding its slot for
`blocked_slot_minutes` (120 by default) and then goes `blocked`. If you walk away, nothing is going
to tap you on the shoulder except the desktop toast the watchdog and the bus fire on the events they
do emit. Arm the watcher, register the hook, or plan to come back and run `soma status` /
`soma digest`, or keep a promoted session and open every turn with `soma_inbox`.

### 5.2 `soma doctor`

```bash
soma doctor          # writes its report to stdout, so `soma doctor | tee` works
```

48 named checks plus one row per configured repo. Three outcomes per check — **`ok`, `FAIL`, and
`unobserved`** — and the third is not folded into either of the others. Grouped roughly:

- **Strands a run outright:** `node>=24`, `tmux>=3.2`, `git>=2.31`, `claude auth`,
  `claude cd-compound read runs`, `gh auth`, `workflows enabled`, `notifier`.
  The second `claude -p` reading was added after the stalled-lead incident: one haiku call (~8 s,
  ~$0.02) runs `cd <other dir> && grep -n x y.txt` under `--dangerously-skip-permissions` with a
  `Read()` deny in force, from a throwaway cwd with a throwaway `--settings` file. Claude Code
  **2.1.259** raised a bypass-immune permission prompt on exactly that shape — 79 unattended
  sessions sat on it for 214 hours — and `tested_claude` admitted the build because it passes patch
  releases by design. So the check runs the shape: **ok** = the tool result carried `1:x`;
  **FAIL** = the build asked (do not spawn leads on it, or arm the gate's lever — §9);
  **unobserved** = claude could not run, or the model dropped the `cd`. Measured: 2.1.263 → ok,
  2.1.259 → FAIL, on the real binaries.
- **The two roots:** `SOMA_HOME absolute`, `claude config root`, `.claude.json location`. The
  `claude config root` check exists because a *stale* `~/.claude/projects` throws no `ENOENT`,
  matches no session uuid, and reports **zero tokens for every lead** — which welds the budget
  breaker open with nothing in any log to say so.
- **The personal-MCP boundary:** `mcp enumeration readable`, `mcp deny drift`,
  `mcp deny mcp__claude_ai_*`, `mcp deny mcp__plugin_*`, `lead mcp single-server`,
  `no orch soma in user scope`.
- **The no-code boundary:** `lead settings readable`, `no edit ban in settings files`,
  `lead edit ban on argv`, `lead PreToolUse matcher '*'`, `worktree PreToolUse matcher '*'`,
  `lead PreToolUse command runs the gate`, `worktree PreToolUse command runs the gate`,
  `no inert Write() rule`, `guard file self-protect`, `every Bash rule keeps a wildcard`,
  `guard file matches the generator`, `worktree guard file readable`,
  `every worktree guard file carries rules`.
  The first two are a pair and they point in opposite directions, which is the point. A lead is
  banned from `Edit`/`Write`/`NotebookEdit` **on its argv**, where the ban binds one process;
  putting the same ban in a settings *file* binds every teammate too and leaves the fleet unable
  to write code (§11.9). So `lead edit ban on argv` asserts the ban is present where it belongs,
  and `no edit ban in settings files` asserts it is absent from both files that reach a teammate.
  **Neither observes a running lead** — `soma doctor` cannot see a live session's tool list, and
  the argv check says outright that it read `buildLeadArgv`, not a process. Proving the ban holds
  in a real session is a bring-up step (§10, `leadCannotWrite`).
- **Credential and protected-ref denies:** `credential-store command denies`,
  `credential-store Read() denies`, `protected-ref single-command paths`. These put **84 synthetic
  hostile command strings** and **23 ordinary control ones** through the real rules, plus 13
  `Read(...)` rules. **Nothing is executed** — they are strings put through the matcher. The control
  set is half the point: a rule broad enough to refuse `git push origin soma/fix-main-nav`
  dead-ends a task with a refusal that misdescribes itself as a policy hit, and that shipped for
  three rounds on this build while the positive assertions stayed green.
- **The rest:** `harness registry`, `gh pr create --draft`, `gh pr create draft negation`,
  `lead PATH node vs engines.node`, `CLAUDE_CODE_SESSION_ID`, `session id matches hook payload`,
  `budget flag path`, `state scratch files`, `lead auto-continue floor`, `seats readable`,
  `every seat logged in`, `seat projects is the shared tree`, `mcp enumeration covers every seat`,
  `seat pool state readable`, `repos readable`, then `repo <name> base reachable`.
- **The seat pool** — the ones the bullet above carries between `lead auto-continue floor` and
  `repos readable`, in the order the doctor prints them: `seats readable`, `every seat logged in`,
  `seat projects is the shared tree`, `mcp enumeration covers every seat`, `seat pool state readable`.
  Every one is three-state, and the first carries the read for the three after it: when
  `soma.json.seats` could not be read, `every seat logged in`, `seat projects is the shared tree` and
  `mcp enumeration covers every seat` are `unobserved`, and zero seats is `ok` with the count
  (rotation is off; leads run on the fleet's own config root). Within a check a FAIL beats an
  unobserved seat — one seat definitely wrong is a finding whether or not another could be read.
  `every seat logged in` is a file read — an `oauthAccount` object in `<seat>/.claude.json`,
  `unobserved` when that file cannot be read — never an API call, so it says a seat *looks* logged
  in, not that its token still works; the fix it names is `CLAUDE_CONFIG_DIR=<config_dir> claude auth
  login`. `seat projects is the shared tree` compares `realpath(<seat>/projects)` against the fleet's
  own and fails a seat provisioned without §7 step 2 — the seat that would resume nothing and meter
  zero for every lead rotated onto it, the same silent-zero failure `claude config root` exists for
  (`test/tokens.test.mjs`, *two seats whose projects/ share one realpath*, is the pin under it).
  `mcp enumeration covers every seat` is the widened secrets boundary: a personal MCP server
  registered only in a seat's `.claude.json` must still land in every worktree's deny list.
  `seat pool state readable` is the only voice the pool *state* has: **no file is `ok`** — no seat has
  been closed yet, which is where a seated fleet sits before its first rotation — rows are `ok` with
  the counts, and a file that exists and will not open is a **FAIL**, not `unobserved`, because the
  consequence is not in doubt. Read the next paragraph before you shrug at that FAIL.

  > **A corrupt `state/seats.json` stalls rotation in near-silence, and this check is the only thing
  > that keeps saying so.** `readSeatState` answers UNREADABLE, `pick()` answers `null`, no lead can
  > rotate, and the watchdog emits `ROTATION_UNAVAILABLE {why: 'seats_unreadable'}` **once per lead
  > per launch** — deduped off the durable event log against that lead's newest SPAWNED, REVIVED,
  > ROTATED or ROTATION_FAILED, so a fleet held for a week says it on the first tick and never
  > again, and a lead the watchdog revives is told once more and then goes quiet too
  > (`test/watchdog.tick.test.mjs`, *the ONCE is once per LAUNCH*). Neither is a reminder you can
  > wait for: the digest goes quiet and the fleet looks healthy
  > while every limit hit falls through to `autoContinueAtUsageLimit` instead of rotating. Repairing
  > the file by hand is the fix — the bytes are left exactly as they are so the faulty row can be
  > read. Deleting `state/seats.json` also clears it, and forgets every live closure, reopening
  > seats the fleet closed for a reason. `soma doctor` is how you find out you are in this state.

On a cold machine (no lead, no worktree yet) the rule-shaped checks judge **what `settings-gen`
would write right now** rather than reporting twelve `unobserved` lines — that is deliberate, since
a fresh install is exactly when a generator regression is cheapest to catch. Once a real worktree
exists, the live file wins, because a hand edit or a worktree written before a rule landed is a
real finding the generator cannot show.

**A generator change reaches a running lead only at its next launch.** `lead settings readable`,
`lead PreToolUse matcher '*'`, `lead PreToolUse command runs the gate` and `no edit ban in settings
files` judge the newest lead's `leads/<id>/settings.json` as its last spawn or resume wrote it, and
no check compares that file against the generator (`guard file matches the generator` is the
worktree file). So `autoContinueAtUsageLimit: true` — the auto-continue floor under account rotation
— is missing from every lead that was already running when it landed. **`lead auto-continue floor`
is the one check that reads that key**, and it FAILs on such a file while every other lead-settings
check goes on saying `ok` about the very same file. Cycle the lead (`soma kill` + `soma_resume`, §9)
to clear it; the FAIL stands until the lead is next resumed, revived or rotated.

**Read the summary word, and know what the exit code does and does not mean:**

| summary | exit | meaning |
|---|---|---|
| `doctor: PASS — all 48 checks hold on this machine` | 0 | every check was taken and held — **not reachable on this build**: two rows are always unobserved (below, and §10) |
| `doctor: INCOMPLETE — N of M checks hold, K unobserved` | **0** | nothing failed, but **K assertions did not run** |
| `doctor: FAIL — N of M checks failed` | 3 | at least one check was taken and did not hold |

> `soma doctor` **exits 0 on `INCOMPLETE`** — `runDoctor` returns `results.every(r => r.ok !== false)`.
> An unobserved check must not refuse a machine, but it is not a pass either. If you gate a script
> on `soma doctor`, gate it on the word, not only on `$?`.

**`PASS` is not reachable on this build.** Two rows are always unobserved: `workflows enabled`,
which doctor hard-wires to unobserved because no local file can answer it, and
`session id matches hook payload`, which reads `state/last-hook-payload.json`, a file nothing in
this build writes. So the best verdict is `doctor: INCOMPLETE — N of M checks hold, 2 unobserved`
from a Claude Code session's Bash tool (the orchestrator's, say), and `…, 3 unobserved` from a plain
shell, because `CLAUDE_CODE_SESSION_ID` is unobserved there too. Before the first lead and
worktree exist, `every worktree guard file carries rules`, `guard file matches the generator` and
`lead mcp single-server` are unobserved as well. Every other row can read `ok`. §10 *The rows
`soma doctor` cannot take* says how to confirm the three by hand.

**`soma up` runs this same doctor** before it projects any spend (§5.3 step 5), and refuses on
`FAIL` with **exit 3** unless you pass `--ignore-doctor`. `INCOMPLETE` does not stop it.

### 5.3 `soma up` — the spend gate

```bash
soma up
```

Order of operations, and every step can stop it:

1. `ensureTree()` and the hard-link probe → **exit 2** on failure.
2. **Already-live short-circuit.** If tmux reports `soma-watchdog` live, nothing is started and no
   new spend is authorised, but **`soma.json` and the pause flag are still read** — a live watchdog
   is *not* an open queue. Doctor is not run: nothing is opened. A `soma.json` the loader refuses
   (step 4) is **exit 2** here too: the refusal names the key and says that the running watchdog,
   which loads the same file at the start of every tick, is refusing it and admits nothing until it
   is fixed. Otherwise the pause flag is reported and it is exit 0 — **unless you passed
   `--canary`**: then the canary runs here too (§5.4), with no projection and no prompt, and
   anything but a pass is **exit 3**. The watchdog that was already running is left exactly as it
   is, and the refusal says so, then carries the same NOTE as §5.4:

   ```
   soma up: the canary did not report a pass (its verdict is on stderr above), and the watchdog that
   was already running is untouched: --canary checks a fleet, it does not stop one; `soma down` does.
   ```
3. **tmux could not be read → exit 3**, before anything is projected or asked: whether a watchdog
   is already running is unknown, and `up` will not start one beside one it cannot see. One
   exception: tmux's own words for *no server answers on this socket*, which is where every machine
   stands before its first `soma up`. Even then `up` first looks for a live tmux process for the
   socket (`/proc` on Linux, `ps` on macOS, matching a `tmux` that runs as you and whose own options
   say `-L <socket>`), because the two live states in §11.10 answer exactly the same way: a process
   found is **exit 3**, naming its pid and the recovery, and so is a process table that cannot be
   read. Only *none found* goes on, as a fresh start.
4. `loadConfig()` → **exit 2** if it throws: a `soma.json` that does not parse, or a value §4 says
   is refused. Nothing is projected, asked or started, and doctor does not run.
5. **Run doctor**: the same checks and report as `soma doctor` (§5.2), after a line saying so. It
   makes two billed `claude -p` calls and one `git fetch --dry-run` per configured repo, so it takes
   a little while. A `FAIL` → **exit 3**, with nothing projected, asked or started:

   ```
   soma up: doctor reported FAIL (its report is above), so the queue was not opened: nothing was
   projected or asked, and no watchdog was started. Fix what it reports (each FAIL row names what it
   read) and run `soma up` again, or pass --ignore-doctor to open it anyway: doctor still runs and
   prints every row, and the spend confirmation still follows.
   ```

   A doctor that throws, or answers anything but a verdict, is refused the same way, and the
   refusal says which. `INCOMPLETE` goes on: `PASS` is unreachable on this build (§5.2), so refusing
   it would refuse every machine. `--ignore-doctor` still runs doctor and prints every row; when
   doctor does not pass, `up` warns that the flag was passed and that it fixes nothing doctor
   found, then goes on to step 6. It is not a `--yes`: step 7 still needs the typed `yes`.
6. **Print the worst-case spend projection.**
7. **Ask, on the terminal.**
8. `--canary`, if you passed it (§5.4) → **exit 3** unless it reports a pass. This is where it runs
   on a fresh start; with a watchdog already live it runs at step 2 instead.
9. Start the watchdog in a detached tmux session under `env -i`.
10. **Read tmux back.** `tmux new-session` exits 0 for a command `env -i` cannot resolve, leaving a
   session whose pane died instantly — which reads as a running watchdog to anything that asks by
   name. Unreadable → **exit 3, UNVERIFIED**. Readable but absent → **exit 3, dead pane**.
11. Report the node, the log path, the state root, and the queue's actual pause state.

#### What the projection says, and the numbers

With shipped defaults (`max_leads: 10`), `soma up` prints exactly this after doctor's report
(step 5) and before asking anything:

```
Fleet worst case: 10 leads × 38,000,000 est_tokens (iterate, the largest budget class) = 380,000,000 est_tokens.
All-standard case: 10 × 20,000,000 = 200,000,000.
Budgets meter each lead AND its team, and are deliberately loose so a breaker never fires on
ordinary work. Lower max_leads to lower this.
```

Then:

```
Open the queue to 10 concurrent leads? Type "yes" to confirm:
```

**The two numbers are different questions and both are real.** `380,000,000` is the worst case —
ten leads all in the largest class. `200,000,000` is the all-standard case, the one you should
expect from an ordinary mixed backlog. For scale, `docs/ROADMAP.md` records the operator's own
measurement against their entire recorded Claude Code history: the all-standard run is **~19.5 %**
of it, the largest-class run **~37 %**.

**Why the gate exists, in the words of the decision behind it:** v1 caps each lead and caps the
number of leads, so worst-case exposure is the *product*. There is deliberately **no fleet-wide
token ceiling** — that is a v2 item — and the per-lead caps cannot substitute for one, because
every comparable session in the measured corpus exceeds the original caps, so any cap low enough to
bound total exposure guarantees no lead ever finishes. Faced with that, the operator chose to keep
`max_leads: 10` **plus a confirmation prompt** rather than invent a new mechanism. The prompt *is*
the ceiling. It is the only thing between a typo and a nine-figure token run.

**It is interactive-only, and there is deliberately no `--yes`.**

- No TTY on stdin, EOF, or the terminal going away mid-question → `confirm` returns **`null`**,
  which is *"there was nobody to ask"*, not a yes. `soma up` **refuses, exit 3**:
  > `soma up: there is no terminal here to confirm the worst-case spend on, and soma will not
  > assume a yes. Run soma up from an interactive shell. (Deliberately no --yes flag: a flag anyone
  > can add is the warning-that-scrolls-past this gate exists to prevent.)`
- Anything other than `y`/`yes` → `soma up: aborted — the queue was not opened and no watchdog was
  started.` **exit 1**. An empty line is not consent.

Which means: **`soma up` cannot be scripted, cron'd, or run from CI on this build.** That is the
design. If you need it in a wrapper, the wrapper needs a real terminal.

### 5.4 `soma up --canary` cannot pass on this build — do not plan around it

The flag is answered, and then it refuses. `bin/lib/canary.mjs` ships the **evaluation** only:
`evaluateCanary(probe)` is a pure predicate over a probe result with full unit coverage, and the
**live driver** that spawns the synthetic lead and produces that probe is a declared v1.x gap.
`probeCanary` *requires* a driver — a canary nobody drove must not look like a pass — so `soma up`
hands it one that says it is not built. The canary reports **ERROR**, nothing proven, on stderr, and
`up` refuses with **exit 3**. On a fresh start it reads as below; with a watchdog already running,
the refusal's first sentence is the one §5.3 step 2 quotes:

```
canary: ERROR — the canary did not run, so none of the 9 invariants was proven; the queue stays closed
  reason: the live driver threw before producing a probe: the live driver is not built on this build — canary.mjs ships the evaluation only (a declared v1.x gap)
  unproven: busMounted, teammateCanEdit, leadCannotWrite, teammateUserMcpDenied, somaPrDraft, slotFreedAfterComplete, rcUrl, oauthUnderEnvI, cdCompoundReadRuns
soma up: the canary did not report a pass, so the queue was not opened (its verdict is on stderr
above). NOTE, because it is the likeliest reason on this build: `canary.mjs` ships the EVALUATION
only and records the live driver as a declared v1.x gap, so the canary `soma up` runs has no driver
to observe anything with and can only report "unproven". Establish the nine invariants by hand (see
bin/lib/canary.mjs) and run `soma up` without --canary.
```

**The golden path is `init` → `doctor` → `up`, without `--canary`.** The design spec's first-run
golden path lists `soma up --canary` as an install step; that is a documentation path that cannot
be walked on this build, and `soma.mjs`'s own usage text says so under
`NOT IMPLEMENTED IN THIS BUILD (v1.x)`.

What you lose by skipping it is not nothing — it is the machine-specific proof of the nine runtime
invariants. §10 is how you establish them by hand instead.

---

## 6. Promote a session, enqueue, walk away

### 6.1 Promote

In any Claude Code session (**not** a lead and not a lead's teammate — `soma_adopt` refuses if
`SOMA_LEAD_NAME` is set, because that would make a lead its own orchestrator):

```
/soma:promote
```

Promotion is **one MCP tool call**, `soma_adopt`. No restart, no `claude mcp add`, no `/mcp`
reconnect: you are taking a **lease**, not starting a service. The watchdog and any live leads are
already running and keep running whoever holds it.

- `adopted: false` — read `holder_live` before concluding anything. `true` means the staleness
  check ran and said no (a lease whose pane is gone, or whose heartbeat is over 10 minutes old,
  would have been granted without force). `null` or absent means that check *could not run*, and
  the refusal proves only that a lease record exists. That is the difference between stealing from
  a live orchestrator and clearing a corpse.
- `adopted: true` — note `lease_seq` and `unread_count`. `degraded_wake: true` means this session is
  not in a pane on soma's own tmux server (it is outside tmux, or in another tmux server such as
  your everyday one), so pushes arrive as desktop toasts and on your next turn rather than as a
  live keystroke wake. Only a pane on soma's own server gets keystroke wakes.

**Arm the watcher.** Right after promotion the skill has the session arm `soma watch` under Claude
Code's Monitor tool, which turns every stdout line of a command into a wake. The orchestrator then
hears about a `NEEDS_INPUT`, a `COMPLETED`, a stopped watchdog or a lost lease with no keystroke and
no pane: the wake comes from the Monitor, not from tmux, so this works in the `degraded_wake` case
too:

```
Monitor({ command: "SOMA_HOME=<root> SOMA_TMUX_SOCKET=<socket> <node> <soma>/bin/soma.mjs watch", description: "soma fleet events", timeout_ms: 1800000 })
```

- **Take every value from the bus registration.** `claude mcp get soma` shows the entry
  `soma init` wrote: `<node>` is its `Command`, `<soma>/bin/soma-bus.mjs` its `Args` (`soma.mjs`
  sits beside it), and `<root>` and `<socket>` its two `Environment` lines. A session's Bash
  environment carries none of them, and an unpinned watcher reads `~/.soma`, where an empty fleet
  raises nothing. Not `SOMA_HOME=<root> soma watch`: a wrapper function such as the README's sets
  its own `SOMA_HOME`, which wins over the prefix, and Claude Code's Bash and Monitor shells load
  your shell functions, so that watcher would silently follow another root.
- **Re-arm it on every expiry.** A Monitor lives 30 minutes at most, and when it expires the wakes
  stop with nothing else to say so.
- **What it says.** One line per event that asks the orchestrator for a move (the wake table in
  `prompts/orchestrator.md`; `--all` for every event), in the bus's own words:
  `[soma] cr-1 NEEDS_INPUT. Call soma_inbox.` Who and what, never a payload. At most 20 such lines
  per poll, then one `…and N more` line. A freeze's `BACKPRESSURE` rings once, not on every re-emit:
  the watchdog repeats a storm's on every frozen tick, and a repeat (the same `reason` with the same
  `since`, or within 10 minutes of the last) stays in the mailbox. `[soma] health: …` lines report
  the watchdog going down or coming back and the lease being lost, stale or held by nobody, once
  each time the state changes.
- **What it never does.** It reads the `orch` cursor only to skip what `soma_inbox` already
  consumed, and writes nothing: no cursor, no event, no keystroke, no toast. `soma_inbox` still
  returns every event the watcher announced, and any number of watchers may run.

**Keep the lease warm.** It reads **stale after 10 minutes** without a heartbeat, and a stale lease
is adoptable by the next session *without* `force` — so a live-but-idle orchestrator loses the fleet
silently. Every orchestrator tool call stamps the heartbeat; open each turn with `soma_inbox` or
`soma_status`. From a shell, every mutating `soma` subcommand you run with `--as <session_id>`
stamps it too.

There is **no CLI lease handback in v1.** `soma_release` (MCP) hands the lease back;
`soma release <lead>` (CLI) is a different, unimplemented verb that un-holds one lead. Confusing
the two unmounts a working orchestrator.

### 6.2 Enqueue

From the orchestrator: `soma_enqueue([{id, repo, base_branch, brief, source:{kind, ref}}, …])`,
at most 200 per call. From a shell:

```bash
soma enqueue --file tasks.json
```

`tasks.json` is a **JSON array** (an object keyed by id is the likely mistake and is refused by
name). Each row needs at least `id`, matching `^[a-z][a-z0-9-]{0,63}$` — it becomes a directory
name, a tmux target and an event stream, so nothing else is admitted. Fields that survive into the
fleet row: `id`, `title`, `repo`, `source`, `brief`, `base_branch`, `budget_class`, `verify_hint`,
and `budget_override`, a copy of `budget_class` that pins the breaker to it. A class soma.json does
not define is refused at intake (below). One that reaches a row anyway, because soma.json could not
be read at enqueue or the class was removed from it since, is passed over and `HARNESS_DEFAULTED`
says so once: the lead is priced by its harness, or at `standard` before it declares one.

```json
[
  { "id": "task-42", "title": "fix the CSV export header", "repo": "myapp",
    "base_branch": "develop", "brief": "…what to do, in full…",
    "source": { "kind": "jira", "ref": "PROJ-42" } }
]
```

A bad row is **skipped rather than fatal** — one bad row should not cost the other twenty-nine — and
every drop is printed with its reason. This verb and `soma_enqueue` run one intake check,
`bus-tools.intake`, so a file loses exactly the rows the tool would refuse: the reserved id `orch`,
the orchestrator's own stream (`reserved-id`); a `brief` over 16,384 characters (`brief-too-long`);
a `repo` not in soma.json's `repos`, while it names any (`unknown-repo`); a `budget_class`
soma.json's `budgets` does not define (`unknown-budget-class`); a row that is not an object
(`not-an-object`). Then `fleet.enqueue` skips an invalid id (`invalid-id`) and one already in the
fleet or earlier in the file (`duplicate`). After an `unknown-repo` or `unknown-budget-class` the CLI
prints the names soma.json does define, one line each. If soma.json cannot be read it says so, and
the repo and class checks check nothing; the other three still hold. If rows were offered and
**none** was taken, `enqueue` exits **3**, because `queued 0` beside a zero exit is how a plan of
thirty duplicate ids reads as a success.

A task keeps its `verify_hint`, the command its lead's independent verifier runs. A task without one
takes `repos.<name>.verify_hint` from `soma.json` at enqueue, so a hint added there later does not
reach tasks already queued. The lead's standing brief names it on its `verify:` line and `soma_task`
returns it. With neither, the brief says `verify: (none configured)` and the lead agrees the gate
command with its verifier in step 0.

### 6.3 What happens then, without you

The watchdog tick (default 30 s) does seven things:

0. **Pane census.** For every row that has a session — `done` and `blocked` rows included — it
   reads what the pane is *running* (`pane_current_command`: a live Claude Code reads its version
   string, a tmux-resurrect ghost reads `zsh`, a dead pane reads `env`) and, for a live claude,
   what the screen *shows*, and writes the verdict beside `status` as `pane_state`
   (`alive` / `blocked_on_prompt` / `dead_shell` / `dead_pane` / `absent` / `unobservable` /
   `unrecognised`). It never touches `status`. On ENTRY into the two alarm states it emits once
   and toasts: `LEAD_BLOCKED_ON_PROMPT` (a dialog only a human can answer — a permission or
   trust dialog, an AskUserQuestion the lead is asking you, or any dialog footer with no composer
   on screen; `kind` says which and the payload quotes it) and `LEAD_DEAD_SHELL`; leaving either emits
   `LEAD_PANE_RECOVERED`. `unobservable` (the screen could not be read) is **not a verdict**: it
   never alarms, never revives, and never overwrites a verdict already held. `soma status` shows
   the same reading in its `PANE` column (`working` / `idle` / `draft` / `prompt` / `shell` /
   `exited` / `gone` / `other`, `?` when tmux could not be read, `-` for a row with no session yet:
   a queued row, or a lead still starting (step 1); when no tmux server answers on soma's socket at
   all there are no panes to list, so a row with a session reads `gone`).
   `draft` is text sitting unsent in the composer (a long `soma send` can land there without its
   Enter firing, and the delivery is not fixed yet); the composer is located under
   the `──── lead-<id> ─` rule a `--name`d session draws, so it fires on this fleet's leads.
   **Never `soma send` into a `prompt` or `shell` pane** — measured: the Enter approves the
   dialog, and the shell executes the text — and since this change `soma send` / `soma_send`
   refuse to, without `--force` / `force:true`.
   Beside `PANE`, a `SEAT` column names the seat the lead runs under (`soma.json` `seats[].label`),
   `-` when the row records none. The header's `seats:` line is the pool in one of three states:
   `seat-a open · seat-b closed until 4:30pm (five_hour) · seat-c unverified (not logged in —
   CLAUDE_CONFIG_DIR=<dir> claude auth login)`, `none configured`, or `UNREADABLE (<why>)` when
   `state/seats.json` or `soma.json` could not be read — never "all open". `soma_status` carries
   the same as `seat` / `rotations_last_hour` per row and a `seats` object (labels only, no
   `config_dir`) per reply; `seats: null` means the bus has no reader wired.
1. **Liveness, reconcile, revival.** Reads panes, not session names — `remain-on-exit` keeps a dead
   lead's session alive on purpose, because that pane *is* the death scene. A dead lead gets its
   final screen captured, a `LEAD_DEAD` event, then resume-or-fresh-respawn, up to 3 attempts.
   The attempts are spaced out, so that you can read a death screen before the next attempt
   replaces it: the first revival is immediate, the second comes no sooner than 15 minutes after
   the first, and the third no sooner than an hour after the second, timed from the previous
   relaunch (the row's `revived_at`, written in the same transaction as `attempts`). While a lead
   waits, its row stays `spawned` and keeps its slot, nothing is logged, and `soma peek <lead>`
   shows the death screen; `LEAD_DEAD` and `REVIVED` come at the relaunch, as before. `GAVE_UP`
   after the third attempt is not delayed. A row last revived before `revived_at` existed is not
   held, and the revival it gets stamps it. A `revived_at` in the future (the clock stepped back)
   holds nothing: the lead is revived at once and stamped again from the corrected clock, so no
   dead lead waits longer than its step (15 minutes or an hour) from the tick that finds it dead.
   A `spawned` row whose pane the census read as a bare shell is dead here too (its `LEAD_DEAD`
   carries `pane_state: dead_shell`); a shell on any other row is surfaced and left standing —
   killing a finished lead's pane is the unbuilt `linger_minutes` reaper's job.
   If tmux cannot be read (the listing failed, or came back with no row soma can parse) it emits
   `TMUX_UNREADABLE` and **skips** reconcile and revival — one hiccup read as a dead fleet would
   kill and respawn ten live leads. When only the pane listing could not be read, `skipped` names
   `pane_census` alone and no `pane_state` is written that tick.
   A `spawned` row with no session is not always dead: it may be **starting**. Both spawn paths
   (admission here, and `soma_spawn`) flip the row to `spawned` and stamp `launching_at` on it in
   one write, then fetch, cut the worktree and write the lead's settings, and create the tmux
   session last. `soma_spawn` does all that outside the fleet lock, so a tick can land in the
   window. Reconcile leaves such a row alone until its mark is three and a half minutes old
   (`LAUNCH_GRACE_MS`: the 30 s repo-lock wait, one full two-minute git call for the fetch, and a
   minute for everything else). That is not the longest launch possible, because every git call in a
   launch gets its own two minutes. Past it the row is treated as dead, as every starting row was
   before the mark: usually a spawner that died, revived like any dead lead. A launch that is only
   slower than the bound is revived under its spawner, with its attempts spaced out like any dead
   lead's (above): the first revival is immediate, and each later one waits out its step. A
   `LEAD_DEAD` and a charged attempt come with each revival, none on a tick spent waiting, and
   `GAVE_UP` comes after the third. If its session appears between a tick's read and the revival's
   kill, that new session is killed and replaced. Two sessions never run at once: the spawner holds
   the repo lock across the launch and checks for the session again under it. Recording the session
   clears the mark, and so does a failed spawn's rollback.
   Meanwhile `soma status` shows the lead as LIVE `starting`, PANE `-`, and `soma_status` as
   `liveness: starting`.
2. **Budget breakers and model deviation**, over every `spawned` *and* `blocked` row.
3. **`NEEDS_INPUT` → `blocked`**, after `blocked_slot_minutes` of grace, which frees the slot.
4. **Backpressure.** A rate-limit storm freezes admission: two or more *distinct* leads whose own
   transcripts end on a live usage-limit hit in the same tick. The evidence is the limits phase's
   reading, the synthetic `rate_limit` row Claude Code itself writes when a seat refuses a request,
   so no lead can produce it by reading or quoting a 429 log. The pane does show a limit line
   (`You've hit your <limit name>`, with its reset time for a window) above an idle composer, but
   the account-rotation design names the row the reliable signal and that line corroboration, and
   no scraper pattern has been built or measured against it. The threshold is fixed at two, not a
   `soma.json` key: one lead's hit is its own seat's window, which rotation handles, and it takes
   two at once to make it the fleet's. Rotation keeps running under a freeze, and so does revival;
   only admission is held. A hit stops counting when its lead is relaunched (rotated, revived, reverted or
   spawned anew), when the lead resumes (a healthy row follows it), when its row stops being
   `spawned`, or when its own `resetsAt` passes, so a storm freeze never outlasts the resets of the
   hits that hold it.
   The freeze is a FILE: the tick writes `state/backpressure.json` (`{active, reason, since, until}`,
   tmp+rename under the fleet lock) and admission obeys the file, not only the in-memory verdict —
   so a freeze written by the limits phase (the org spend cap, `reason: org_level_disabled_until`)
   holds the queue with no storm in sight. `BACKPRESSURE` reaches the orchestrator as an event on
   its next `soma_inbox` drain plus, for the spend-cap emission, one desktop toast; the watchdog
   never types into the orchestrator's pane. The storm emission (`reason: storm`, with `evidence`
   naming the leads) is re-emitted every frozen tick (a storm's end has no event; the events carry
   the storm record's `since`, so they agree about when it began; under a spend-cap record or an
   unreadable file a storm writes none and each dates its own tick) and is silent on the desktop. Each
   writer owns its own `reason`: a storm clears its own record once fewer than two leads still hold
   a live hit, and never clears or relabels a spend-cap record; the spend cap keeps its own writer,
   and its record holds until `soma thaw` clears it (§9) — nothing inside the fleet lifts it. The
   org spend cap outranks a storm: a spend-cap hit replaces a live storm record and is announced at
   once, never the reverse. The
   pane half of the evidence is still a declared stub (`paneSignals` returns `[]`), so on this build
   only transcript evidence freezes. A corrupt `state/backpressure.json` reads as "not frozen", is
   reported once as `WATCHDOG_ERROR` with `where: backpressure_file`, and is never overwritten by
   the tick: fix or delete the file by hand.
5. **Admission.** At most one launch per tick, capped by `max_leads`, gated by `stagger_s`, vetoed
   by the pause flag and by a freeze.
6. **Settlement** → `FLEET_DRAINED` / `FLEET_SETTLED` plus one desktop toast, announced once per
   change rather than every 30 s.

A lead is pinned `--model opus --effort max` (and carries no `--disallowedTools`: since the
lead-permission change a lead's tool surface matches its teammates'), gets
its worktree at `$SOMA_HOME/worktrees/<repo>/<id>` on branch `soma/<id>`, and delivers a **draft
PR** through `bin/soma-pr.mjs` — the only PR path its team is allowed, and the one that forces
`--draft` into the `gh` argv whatever the caller passed. **Never a merge, never a ready-for-review.**

---

## 7. Every verb, and what it actually does

Confirmed against the `switch` in `bin/soma.mjs`. Nothing below is aspirational.

| verb | does |
|---|---|
| `soma` / `soma help` | usage (bare invocation exits **1**, `help` exits 0) |
| `soma init [--seat <dir> \| --inject-hook]` | state tree, `/soma-promote` skill, MCP bus — each read back — and the inject hook, reported three-state and registered only with `--inject-hook` (opt-in, refused with `--seat`; §5.1). `--seat <dir>` moves the skill install and the bus registration **into `<dir>`**, with this fleet's `SOMA_HOME` and socket pins — once per seat. It does **not** move the state tree: that is still created under this shell's `$SOMA_HOME`, exactly as a plain `init` does, so run it from a shell pinned to this fleet or you get a second state root *and* a seat pinned to it. See *Provisioning a seat* below |
| `soma doctor` | 48 checks + per-repo rows; stdout |
| `soma up [--canary] [--ignore-doctor]` | doctor → spend projection → confirm → start watchdog → verify |
| `soma down` | stop the watchdog. **Leads are NOT stopped** |
| `soma status` | state root, queue and backpressure (three-state each), lease, watchdog, the seat pool on one `seats:` line (three-state: UNREADABLE · none configured · one clause per seat, open · closed until its reset with the reason · unverified), one row per lead with its `SEAT` beside `PANE`, totals |
| `soma attach <lead>` | hand your terminal to the lead's pane |
| `soma peek <lead> [--lines N]` | read-only pane tail (default 60, max 2000) |
| `soma send <lead> "<msg>"` | type one line into the lead's composer and submit |
| `soma kill <lead> ["reason"]` | kill the session, mark the row `failed` |
| `soma resume <lead> [--force]` | restart a dead lead from its recorded claude session, on the seat `pick()` chooses — written to the row's `seat`; with no pool configured, this process's own `CLAUDE_CONFIG_DIR` and `seat: null`. The seat is picked **before** the kill, and every seat closed or unverified is a refusal (exit 3), not a launch on this shell's own account. A `soma.json` that `loadConfig()` refuses (§4) is refused before the kill too, with the loader's reason (exit 2) |
| `soma retry <lead>` | re-queue a `failed` or `skipped` row |
| `soma clear-trip <lead>` | clear a budget trip by granting one more allowance of the lead's class (§4, *Budget classes*), and log `TRIP_CLEARED`; **refuses a lead that is not tripped or not metered, exit 3** |
| `soma digest [--lines N]` | recent events, oldest first, **consuming nothing** |
| `soma watch [--interval N] [--all]` | the poller for Claude Code's Monitor tool: every N s (default 5, 1–300), one stdout line per event that needs the orchestrator (`--all`: every event) plus health lines; banner on stderr; reads the `orch` cursor and **writes nothing**. Runs until SIGINT/SIGTERM, then exit 0; a bad argument is exit 1. §6.1 |
| `soma enqueue --file <f>` | add tasks from a JSON array, refusing what `soma_enqueue` refuses (§6.2) |
| `soma thaw` | clear an org spend-cap freeze (`state/backpressure.json`) and print the record cleared; **refuses a live storm and an unreadable record, exit 3** — see §9 |
| `soma hold` / `release` / `gc` | **refuse with a reason, exit 3** — see §9 |

`--as <session_id>` on any mutating subcommand re-checks the orchestrator lease and **stamps its
heartbeat**. Without it, soma says `acting as operator (no --as, so the orchestrator lease was not
consulted)` and proceeds. There is no `inbox` subcommand.

> **`retry` works, despite the ROADMAP.** `docs/ROADMAP.md` lists `soma retry` under "Softer CLI
> subcommand bodies … their bodies are v1.x". The shipped arm has a real body: it refuses anything
> that is not `failed`/`skipped`, kills the lingering session, sets the row `queued` and logs
> `RETRIED`. What it does *not* do is force worktree recreation — the `-r2` path is the worktree
> layer's own behaviour on a dirty reuse. Same for **reconcile-driven revival**, which the ROADMAP
> once listed as v1.x and which the shipped tick fully wires (`resumeLead`/`spawnLead`, 3 attempts
> spaced out as §6.3 says).
>
> And **`thaw` is built**: the shipped arm lifts an org spend-cap freeze (it clears
> `state/backpressure.json`) and refuses a live storm — §9. `docs/ROADMAP.md` now records only the half
> that is still deferred: the per-fleet ignore list for a *false* storm freeze, which is still v1.x. A
> list of text to ignore needs matched text, so it waits on the pane scraper, which is still a stub;
> the transcript row a storm freezes on today is written by Claude Code itself, not by a lead, and
> stops counting at its own reset.

### Provisioning a seat

A **seat** is a Claude Code config dir with its own login, in the **same** Team or Enterprise
organisation as your first one, whose `projects/` is a symlink to one shared tree — so every seat can
`--resume` every lead and the token meter keeps reading one tree (`test/tokens.test.mjs`, *two seats
whose projects/ share one realpath*). Rotation does nothing until `soma.json.seats` names at least two.
The design is `docs/superpowers/specs/2026-09-15-account-rotation-design.md` §7; these are its five
steps, checked against the installed binary. `soma` here means whichever wrapper pins **this
fleet's** `SOMA_HOME` (README step 1). The login verb is `claude auth login`, read out of 2.1.276's
own command table — the build `claude` resolves to here, and the same reading the spec's §7 step 1
cites: the `auth` command group carries `login`, `logout` and `status`, and the only other `login`
subcommand in the binary belongs to the XAA IdP group, so the bare form is not a verb. A seat pins the
*same* state root as the fleet, inverting README step 1's one-config-root-per-state-root rule on
purpose: the pool is the reason.

1. **Log the new dir in.** A fresh dir inherits nothing — not the login, not the trust marks.
   ```bash
   mkdir ~/.claude-seat-b && CLAUDE_CONFIG_DIR=~/.claude-seat-b claude auth login
   ```
   Interactive, once per seat. Then read it back:
   ```bash
   CLAUDE_CONFIG_DIR=~/.claude-seat-b claude auth status --json
   ```
   `loggedIn` must be `true` and `orgId` must equal the first seat's. A seat in another organisation
   is outside the pool (spec §8; `docs/ROADMAP.md`) — no check catches it, this comparison is the gate.
2. **Share the transcript tree.** For the work fleet the shared tree is `~/.claude-work/projects`.
   ```bash
   rm -rf ~/.claude-seat-b/projects && ln -s ~/.claude-work/projects ~/.claude-seat-b/projects
   realpath ~/.claude-seat-b/projects
   ```
   The `realpath` must print the shared tree; that realpath is what `seat projects is the shared tree`
   compares. Skip this step and the seat resumes nothing (`No conversation found with session ID: …`)
   and meters zero for every lead moved onto it.
3. **Register the bus and the skill into the seat.**
   ```bash
   soma init --seat ~/.claude-seat-b
   ```
   Same `bus: registered at user scope … SOMA_HOME=…` line as a plain `init` — check the root is
   this fleet's, and check it before anything else: `--seat` changes where the skill and the bus
   go, not where the **state tree** goes, and the state tree is created under whatever `$SOMA_HOME`
   this shell has (`test/cli.test.mjs`, *init --seat creates THIS shell's state tree*). From the
   wrong shell this one command makes a second state root and pins the seat's bus to it, and the
   seat then looks provisioned. **This step and step 4 are independent acts, and
   nothing checks that you did this one**: a seat named in `soma.json` but never `init --seat`ed passes
   every seat check the doctor has, and a lead rotated onto it comes up with no soma bus and no
   `/soma-promote` — see *What no check covers* below.
4. **Name it in `soma.json`.** The order you write them in is the order they are spent in, so the
   new seat goes FIRST and the root you sit in goes last:
   ```json
   { "seats": [ { "config_dir": "~/.claude-seat-b", "label": "seat-b" },
                { "config_dir": "~/.claude-work",   "label": "seat-a" } ] }
   ```
   Your existing root goes in as a seat too: `pick()` chooses only among `seats`, so a root left out
   is never rotated *back* onto. **The array's order is the priority order**, not a tie-break: every
   launch — admission, rotation, revival, `soma_spawn`, `soma resume` — takes the first seat in it
   that is open and logged in, and reaches the next one only when everything above it is closed or
   `unverified`. POSITION is the whole of the decision, so copy the block above in the order it is
   written: the account you are happy to burn at the TOP, and the one you watch (the orchestrator
   shares its own, and rotation never moves the orchestrator) at the BOTTOM — which is how the
   example above now reads, `~/.claude-seat-b` spent first and `~/.claude-work` only when it is
   closed or `unverified`. Copied the other way round, with your own root on top, that one block
   produces exactly what this ordering exists to prevent — leads burning the account the
   orchestrator shares — and nothing says so at the time. Priority concentrates load instead of
   spreading it: the top seat hits its usage window sooner, and more often, than the ones below.
   `~` is expanded when the config loads; `""` is refused. `label` is optional — a missing one
   defaults to the dir's basename (`.claude-seat-b`), which is then what `soma status` and every
   event print, so name it.
5. **Doctor.**
   ```bash
   soma doctor
   ```
   The seat checks — `seats readable`, `every seat logged in`, `seat projects is the shared tree`,
   `mcp enumeration covers every seat`, `seat pool state readable` — must read **`ok`, not
   `unobserved`**. `seat pool state readable` says `ok` on a fleet that has never closed a seat: no
   `state/seats.json` yet is the normal state before the first rotation, not a missing file.

**What no check covers.** Step 3 and step 4 are separate, and only step 4 is observable from
`soma.json`: **no doctor check verifies a seat has the soma bus registered.** A seat can pass every
seat check the doctor has while `claude mcp list` under that root names no `soma` server, and the
first thing you learn is a rotated lead that cannot call `soma_task`, cannot post a writeback and
has no `/soma-promote` skill. Until a check exists, step 3 is the only guard — run it for every
seat, and read back the `bus: registered at user scope` line it prints. `docs/ROADMAP.md` records
it under *Declared out of scope*, with the two shapes a check could take. (The same gap from the
other side: the checks read `soma.json.seats`, so a config dir that is logged in, symlinked and
bus-registered but **not named in `soma.json`** is invisible to every one of them — `pick()` never
chooses it.)

What the watchdog then does with the pool is §3.5 of the spec: the tick's `limits` phase runs after
the pane census and before liveness, revival and admission, so a seat that closes in a tick is closed
to everything that launches in it; a closure is never shorter than five minutes; after a rotation the
phase waits for the resumed lead's first assistant row before judging that lead again (the stale-row
guard — until then the pre-rotation limit row is still the tail's newest); a lead is moved at most
three times an hour, then left to `autoContinueAtUsageLimit` with a `ROTATION_UNAVAILABLE {why:
"thrash"}`; a transcript tail with a torn line is judged `unobservable` — nothing is killed, and one
`WATCHDOG_ERROR {where: "limits"}` per lead per launch says so. Every launch site picks a seat —
admission, revival, rotation, `soma resume`, and the bus's `soma_spawn` / `soma_resume` — so a
`seat: null` row in `soma status` is one launched before the pool was configured, or with no pool.
The org spend cap is the one limit that does not rotate: it freezes admission through
`state/backpressure.json` until you run `soma thaw`. The only proof that a rotation works against
**your** organisation is the tenth bring-up invariant in §10.

### Exit codes

```
0  ok
1  usage, or you declined
2  this machine cannot run soma   (relative SOMA_HOME, no hard links, a soma.json §4 refuses)
3  soma refused                    (a fleet state, not an environment fault)
```

### Exit 3 on `kill` and `down` means "refused, nothing changed"

This is the single most important exit code in the tool, and it exists because
`tmux.killSession` is `run([...]).code === 0` and `tmux.defaultRun` **never throws**: a missing
binary, a wrong socket and a 5 s `SIGKILL` timeout all come back as `{code: 1}`. So a bare `false`
conflates *"there was no such session"* with *"tmux could not be reached at all"* — and read as the
first, the second is destructive in the one direction that matters. `soma.mjs` disambiguates with a
read-back through `liveSessions`, which answers `null` for "not measured", giving four outcomes:

| outcome | `kill` | `down` |
|---|---|---|
| `killed` — tmux exited 0 | row → `failed`, `KILLED` event, **exit 0** | `watchdog: stopped`, **exit 0** |
| `absent` — tmux read back, nothing by that name | row → `failed`, **exit 0** (`not found (tmux read back)`) | `no session named soma-watchdog was running`, **exit 0** — also when no tmux server answers on soma's socket, and the line then names the socket (below, and §11.10) |
| `live` — tmux answered, session still there | **row left untouched**, `KILL_REFUSED` event, **exit 3** | `the watchdog was NOT stopped`, **exit 3** |
| `unmeasured` — tmux would not answer, or answered a listing soma could not parse | **row left untouched**, `KILL_REFUSED` event, **exit 3** | `UNVERIFIED`, **exit 3** |

**When no tmux server answers on soma's socket** (every machine before its first `soma up`, and
after the fleet's last session has exited), tmux says so in one of two sentences: `error connecting
to <path> (No such file or directory)` or `no server running on <path>`. `down` and `status` read
them as an empty server, and `up` reads them only as leave to look for a live tmux process for the
socket before it starts one (§5.3 step 3). `down` prints `no session named soma-watchdog was running
(no tmux server answers on socket soma)` and exits 0, and `status` prints `watchdog: absent — no
tmux server answers on socket soma, …`. `kill` does not, so it still refuses with exit 3, and
neither does the watchdog, which skips the tick. Neither sentence proves that no server exists, and
on that reading `kill` would write a `failed` row over a live lead and the watchdog would read every
live lead as dead. §11.10 names the two states in which a live server gives those sentences, and
how to recover from each.

**Read exit 3 from `kill` as: the lead may still be running, and soma refused to write a `failed`
row over a possibly-live lead.** A `failed` row beside a live lead is the destructive case — you
believe the lead is dead and stop watching it while a real `claude` keeps burning tokens on its
worktree, and the checkpoint agrees with you.

**Read exit 3 from `down` as: the fleet may still be supervised.** That is the difference between a
stopped fleet and one you only believe is stopped. Run `soma status`, then `soma down` again.

`soma down` also prints, every time, because it is the thing operators get wrong about the verb:

> Running leads were NOT stopped: they keep going unsupervised (no revival, no budget metering, no
> reaping) until `soma up`. Stop one with `soma kill <lead>`.

### Reboot contract

**There is no autostart.** No launchd agent, no systemd-user unit, no logon task — that is a named
v2 item. After a reboot or a re-login:

```bash
soma up            # re-run doctor, re-confirm the spend, restart the watchdog
soma status
```

The tmux server dies with the session, so every lead pane is gone. `state/fleet.json`, the events,
the worktrees and the branches all survive. The pause flag survives too — **deliberately**, because
a paused queue must stay paused across a restart or the pause belongs to one watchdog process
rather than to the fleet. On the next tick, reconcile finds the `spawned`-but-absent rows and
revival takes over.

---

## 8. Watching and intervening

```bash
soma status                      # the one-shot table
soma digest --lines 80           # recent events, cursor untouched
soma watch                       # one line per event that needs the orchestrator, until Ctrl-C (§6.1)
soma peek task-42 --lines 120    # what that lead's pane says right now
soma send task-42 "use the staging bucket, not prod" --as $SID
soma attach task-42              # last resort: your terminal, its pane
soma kill task-42 "wrong approach"
soma resume task-42              # after a kill, or after a reboot
soma retry task-42               # put a failed/skipped row back on the queue
```

Five things worth knowing before you use them:

- **`soma watch` is written for a Monitor, not for you.** Its stdout carries wake lines and nothing
  else, and its banner goes to stderr. It reads the `orch` cursor and writes nothing, so it consumes
  no event and any number of watchers may run; from a terminal it is a live tail of what would wake
  the orchestrator. Its `[soma] health: …` lines read the watchdog the way `status` does: a
  listing without the `soma-watchdog` session, or tmux's own "no server", is down, and a tmux that
  cannot be read says nothing at all. The lease's pane is read the same way: tmux's "no server"
  means it is gone, and an unreadable tmux does not make the lease stale.
- **`status` reports `?`, not `dead`, when tmux cannot be read.** A 5 s timeout on a wedged server
  is byte-identical to a healthy server with nothing on it. No tmux server answering on soma's
  socket at all is a different answer, because tmux says so, and it reads as an empty server:
  `watchdog: absent — no tmux server answers on socket soma`, spawned rows `dead` (§7, *Exit 3 on
  `kill` and `down`*; §11.10). Same three-state discipline on the queue (`open` / `PAUSED` /
  `unreadable`) and the lease (holder / `none` / `UNREADABLE`) — an unreadable state root is *not*
  evidence that admission is open. And `open` is the flag's reading alone: it stands bare only
  beside a live watchdog, and otherwise reads
  ``open (no watchdog is running, so nothing is admitted until `soma up`)``, or says that whether
  anything is admitting work is unknown.
- **`starting` is not `dead`.** A lead whose spawn has claimed its row and not yet created its
  tmux session reads LIVE `starting`, PANE `-`: the session comes last, after a fetch that may take
  two minutes. Do not kill or resume it. If it still has no session three and a half minutes after
  the claim, it reads `dead` / `gone` and the watchdog treats it as dead, even when its launch is
  only slow (§6.3, step 1).
- **`attach`: press `Esc` before typing** if the lead is mid-turn, or your keystrokes interleave
  with its own output. Detach with `C-b d`. Attaching always works, even when the checkpoint is
  the thing that is broken.
- **`resume` refuses unless liveness reads *false*.** An *unmeasured* reading refuses exactly like
  a live one, because two claude sessions resumed onto one worktree edit the same files to two
  different plans. `--force` means "I know its session is gone" and nothing more. Resume always
  kills first — the spawner refuses a session name that is taken, and `remain-on-exit` means a dead
  lead's name is still taken.

Pausing the whole fleet is an orchestrator action, not a CLI one: `soma_queue pause`. Admission
stops on the next tick; running leads continue. The flag lives at `state/QUEUE_PAUSED`.

---

## 9. What refuses, and what to do instead

| verb | why it refuses | do instead |
|---|---|---|
| `soma hold <lead>` | Nothing in `bin/` reads `leads/<id>/HOLD`. Writing it would ship a pause that is written, displayed and **never obeyed**. | `soma_queue pause` to freeze the whole fleet; `soma kill <lead>` for one. |
| `soma release <lead>` | The other half of `hold`. **Not** `soma_release` — that MCP tool hands back the orchestrator lease. | see above |
| `soma gc` | No worktree/branch/log/digest sweep exists. | `git worktree remove` by hand. soma never touches `~/.claude/projects`, which `--resume` needs. |
| `soma thaw` | Refuses a **storm** record (`reason: storm`): a live storm is the watchdog's — it re-writes its record on every tick the storm holds and clears it itself once fewer than two leads still hold a live usage-limit hit, so a clear here would be undone within a tick and would hide the storm from `soma status` meanwhile. Refuses an **unreadable** record: it never overwrites bytes it cannot read. | An org spend-cap freeze (`reason: org_level_disabled_until`) is what `soma thaw` is for: it clears `state/backpressure.json`, prints the record it cleared, and admission resumes on the next tick unless a rate-limit storm still holds. Order of operations, because the tick reads transcript tails and not calendars: first move or kill every lead whose transcript still ends on the cap row — `soma send <lead> "continue"` once you believe the cap has lifted (a healthy reply proves it; a second cap row proves it has not) or `soma kill <lead>` — then `soma thaw`. A spend-cap record that comes back within a tick means a spawned lead's tail still reads the cap. `soma status` / `soma_status` show `backpressure` three-state (none / FROZEN with reason and since / unreadable); the lift has no event of its own — the record is what says it lifted. |
| `soma up --canary` | The flag is answered; the driver is a v1.x gap, so the canary can only report "unproven" (`canary: ERROR`) and `up` refuses with exit 3. | §5.4 and §10 |
| `soma_inbox` from the CLI | No `inbox` subcommand in v1. | `soma digest`, or `tail -n 40 "$SOMA_HOME/events/"*.ndjson` |

`hold`, `release` and `gc` refuse with **exit 3**, not 1 (so do `thaw`'s four refusals: an unreadable record, a storm record, a clear that throws, and `--as` without the lease) — they *are* refusals, and exit 1 made a real-but-unbuilt
verb indistinguishable from a typo to a script. They also do not print the usage line, because
"you typed it wrong" is the wrong message for a verb the ROADMAP, the design doc and the promote
skill all say exists.

Also declared and not built: the **digest composer** (`digests/` stays empty; `soma digest` is the
raw log), the **H5 babysitter teardown handoff**, the **Jira/GitHub writeback ledger** (writeback is
prompt discipline, not a tracked ledger), **RC URL capture on spawn** (each spawn does write
`leads/<id>/meta.json`, with the commit the worktree was cut from, and puts that `base_sha` on the
task row; the RC URL is the one field it lacks), and **watchdog episode semantics /
notification coalescing** (notifications are per-event and chatty at ten leads). The **Claude Code
version gate** is no longer on this list: it is wired and enforced, see §4.

### Two more gaps, declared here because this is where you would meet them

Found by the final whole-branch review and **declared rather than fixed** on this branch. Each is
recorded in `docs/ROADMAP.md` as v1.x.

| gap | what you actually see | what to do |
|---|---|---|
| **`serialize_with` does not exist.** The orchestrator prompt used to instruct it; `soma_enqueue`'s schema sets `additionalProperties:false` and omits it, and admission is pure FIFO. The instruction is removed as of this branch. | Two tickets touching one module get two leads and two draft PRs that fight. | Enqueue same-module tickets one at a time — the second after the first reports `COMPLETED`. The orchestrator prompt now says so. |
| **A Claude Code build that prompts under bypass** (the stalled-lead incident). Claude Code 2.1.259 raised a bypass-immune permission prompt on `cd <dir> && grep <relative file>` whenever a `Read()` deny existed — leads carry 13 — and `tested_claude` admits patch releases by design. 2.1.263 fixed it; the fleet cannot tell which build a lead runs from inside a hook. | A lead or teammate sits on `Do you want to proceed?` with nobody at the pane: measured 79 stalls summing 214 hours, the worst 40 hours, all on 2.1.259. `soma doctor`'s `claude cd-compound read runs` check is **FAIL** on such a build. | Cycle the leads onto a fixed build (`soma kill` + `soma_resume` relaunches `claude` from PATH). If the fleet must keep running on the asking build, arm the gate's emergency lever **per lead**: `touch "$SOMA_HOME/leads/<id>/CD_COMPOUND_ASKS"` — the PreToolUse gate then denies the asking shape with a reason that says what to type instead (one retry turn per matching call, ~14% of Bash calls on a 2.1.259-class build) — and `rm` the flag once the lead is on a fixed build. Unarmed it costs nothing and does nothing; never leave it armed on a build that does not ask. |

The `PostCompact` installer that headed this table has shipped, though not on `PostCompact`: every
lead's settings register `bin/hooks/lead-postcompact.mjs` on `SessionStart` with matcher `compact`.
Measured on Claude Code 2.1.296, `PostCompact` has no `additionalContext` channel: its
`hookSpecificOutput` fails validation (`hookSpecificOutput.hookEventName: expected one of …`), so the
hook reports FAILED; after an auto-compact nothing it prints reaches the model, and after a manual
`/compact` its output appears only as text inside `/compact`'s own command output.
`SessionStart(compact)` fires once per compaction, manual or auto, never on startup or resume; its
stdin carries `source: "compact"` and the unchanged `session_id`, and its `additionalContext` reaches
the model as a system reminder, the only channel that delivered in both modes. It speaks only to the
lead's own session id, because every teammate inherits the lead's `--settings`. A lead spawned or resumed before this change keeps its old settings
until its next spawn or resume: `soma_send` such a lead a pointer to `soma_task()`.

The **revival cooldown** is no longer on this list: it ships, and §6.3 gives the schedule. Nor is
**clearing a tripped budget**: `soma clear-trip` ships (§4, *Budget classes*).

---

## 10. Bring-up: what to establish by hand before you trust the fleet

The canary's live driver does not exist, so these are yours. Do them **once per machine and once
per Claude Code version** — every one depends on undocumented Claude Code behaviour that a version
bump can silently retire, and the whole safety model is downstream of all ten — the nine
`canary.mjs` names, and a tenth below that no canary can drive.

### The nine invariants (`bin/lib/canary.mjs`)

| invariant | what to observe — not infer |
|---|---|
| `busMounted` | a soma tool **called from inside** a spawned session and returning. Not that `settings.json` listed the server; not that the process is running. The bus only mounts if MCP `initialize` succeeded, and soma pins protocol `2024-11-05`. |
| `teammateCanEdit` | **a teammate performing a real Edit/Write on a real file in the worktree, and the change being on disk afterwards.** This is the half that must NOT be denied. Over-denying is as fatal as under-denying and it fails silently: the lead simply never ships. This invariant was measured to FAIL on every fleet until the fix in §11.9 landed; a live session then showed a teammate writing its file with the lead still refused. It is on this list because **one live observation is not a standing guarantee** — the propagation rules it depends on are undocumented Claude Code behaviour. |
| `leadCannotWrite` | the **lead itself** attempting Edit, Write *and* NotebookEdit — all three by name — and being denied each time. Verified live against Claude Code 2.1.220 including under `--dangerously-skip-permissions`. This is the entire no-code boundary, it is undocumented, and it is the single most important thing to re-prove after any Claude Code upgrade. |
| `teammateUserMcpDenied` | a teammate **cannot reach the operator's MCP servers** through any of four channels: top-level `mcpServers`, per-directory `projects[<dir>].mcpServers`, claude.ai **account connectors** (`mcp__claude_ai_*`), and user-scope **plugin** servers (`mcp__plugin_*`). Scopes 3 and 4 appear nowhere in `~/.claude.json` — they cannot be enumerated by name, only denied by prefix. |
| `somaPrDraft` | a PR the fleet opened is **actually a draft** on GitHub. |
| `slotFreedAfterComplete` | a completed lead's admission slot frees, so the next task is admitted. |
| `rcUrl` | the `--remote-control` URL is obtainable. |
| `oauthUnderEnvI` | **OAuth still works after `env -i`.** The spawner scrubs a lead's environment down to eight names — `HOME`, `PATH`, `SHELL`, `TERM`, `LANG`, `TMPDIR`, `CLAUDE_CONFIG_DIR`, `USER` — so your exported API keys are gone by construction. **This invariant FAILED on the first real fleet, and the eighth name is the fix.** Without `USER` the lead reports `Not logged in · Please run /login`: OAuth credentials live in the macOS keychain (no `.credentials.json` in either config root) and the lookup does not resolve without it. `LOGNAME` does not substitute. **It had to be added to TWO lists** — `spawn.ENV_ALLOW` *and* `soma.mjs`'s `WATCHDOG_ENV_ALLOW`, because `buildLeadEnv` copies out of the watchdog's own scrubbed env, so a name missing from the second is missing for every lead whatever the first says. Adding it to one and not the other produced leads that were still unauthenticated with nothing reporting why; `ENV_ALLOW ⊆ WATCHDOG_ENV_ALLOW` is now a test. Note the symptom this entry originally predicted — a trust prompt — is **not** what it looks like: the pane renders normally, the composer accepts input, and only a status line in the corner says the lead can never reach the API. Re-prove it after any Claude Code upgrade, and read the corner rather than the pane. |
| `cdCompoundReadRuns` | **`cd <other dir> && grep -n x y.txt` RUNS under `--dangerously-skip-permissions` with a `Read()` deny in force, and its result carries `1:x`.** Claude Code 2.1.259 raised a bypass-immune permission prompt on that shape (the stalled-lead incident: 79 stalls, 214 hours, nobody at the pane); 2.1.263 runs it. Three states, kept apart: RAN, ASKED (an `is_error` result naming approval, or a `permission_denied` event for the call), and NOT OBSERVED — which is the state you get if the probe `cd`s to the session's **own** cwd, because both haiku and sonnet silently delete such a `cd` even when told byte-for-byte not to. Always `cd` to a sibling. `soma doctor`'s `claude cd-compound read runs` takes the same reading with one haiku call, so you have it before any lead spawns on a new build; re-prove it after any upgrade. Measured on the real binaries: 2.1.263 → RAN, 2.1.259 → ASKED. |

### The tenth invariant: `crossSeatResume` — not in `canary.mjs`, and why

`canary.mjs` keeps nine names because a canary is a two-minute synthetic lead, and this invariant
cannot be provoked: it needs a **real** usage-limit hit under one seat and a **second, logged-in seat
in the same organisation** to land on. The suite reaches everything around it —
`test/watchdog.tick.test.mjs` proves the tick rotates on a fixture row and reverts on a rejected one,
`test/tokens.test.mjs` proves both seats read one file — but whether the second seat's server side
**accepts a conversation the first seat started** (signed `thinking` blocks; an unfinished tool-use
turn) is the first of the spec's §9 open risks, and only a real rotation retires it. Do not append a
fixture 429 row to a live lead's transcript to force one: that file is the lead's own history,
`--resume` replays it, and you would be proving something about a transcript no lead ever wrote.

| invariant | what to observe — not infer |
|---|---|
| `crossSeatResume` | **One lead's `<uuid>.jsonl` in the shared tree carries, in order, the limit row written under seat A, a resume that ran under seat B, and a real assistant turn — and the meter kept counting across it.** Provision two seats (§7), set `max_leads: 1`, spawn one real lead, and wait for a real `five_hour` or weekly hit on its seat. Then read three things, below: the events, the transcript tail, the meter. |

**(1) The events** — `soma digest`: `SEAT_CLOSED {seat: "seat-a", reason, resetsAt}` then
`ROTATED {lead, from: "seat-a", to: "seat-b", rateLimitType, resetsAt}` (the bus passes both through
unfolded and changes no row status on either — pinned in `test/bus-tools.orch.test.mjs`, *a ROTATED
and a SEAT_CLOSED come back from soma_inbox as stored, fold nothing, and flip no row*); `soma status`
shows the row's `SEAT` as `seat-b` and its `seats:` line reads `seat-b open · seat-a closed until
<reset> (<reason>)` — open seats first, whatever order `soma.json` lists them in, because the line
buckets open · closed · unverified; `state/seats.json` shows seat A with `closed_until` at least
five minutes ahead of the tick that closed it.

**(2) The transcript tail** — same file, same inode, readable under either root:
```bash
tail -n 60 ~/.claude-work/projects/<slug>/<uuid>.jsonl | node -e '
const rows = require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean);
for (const l of rows) { let r; try { r = JSON.parse(l); } catch { continue; }
  if (r.type === "assistant") console.log("assistant", r.isApiErrorMessage ? `API-ERROR error=${r.error} status=${r.apiErrorStatus}` : "ok", "model=" + (r.message?.model ?? "-"), r.quotaLimits ? `rateLimitType=${r.quotaLimits.rateLimitType} resetsAt=${r.quotaLimits.resetsAt}` : "");
  else if (r.type === "attachment" && r.attachment?.type === "session_context") console.log("attachment session_context");
  else if (r.type === "user") console.log("user"); }'
```
(`<slug>` is the lead's worktree path with every non-alphanumeric character replaced by `-`, after
symlink resolution — `slugForCwd` in `bin/lib/tokens.mjs`. Raise `-n` until the `API-ERROR` line is
in view.) It must **end** with these four kinds, in this order:
```
assistant API-ERROR error=rate_limit status=429 model=<synthetic> rateLimitType=five_hour resetsAt=<epoch seconds>
user
attachment session_context
assistant ok model=claude-opus-5
```
The first line is seat A's hit — the classifier's input, the shape of every row in
`test/fixtures/limit-rows.json` `rate_limit.five_hour`. `user` is the resume brief the spawner passes
(`RESUME_BRIEF`, `bin/lib/spawn.mjs`). The row kinds a `--resume` appends were measured on a `-p`
resume: `queue-operation` ×2, `user`, `attachment total_tokens_reminder`, `attachment
session_context`, `assistant` (thinking) + `assistant` (text), `attachment hook_success`, `system
stop_hook_summary`, `last-prompt`, `mode` — the script prints only the four kinds above, and a turn
that carried a thinking block shows as **two** `assistant ok` lines. `session_context` is re-emitted on
every prompt and carries the **login email**, the only thing in a transcript that names the account:
`grep -c '<seat B's login email>'` on the file reads 0 before the rotation and 1 after. The last
line is the proof — a real model (the fleet's pinned one, as the fixture's resume row `healthy[0]`
spells it), no `isApiErrorMessage`, `message.usage` present.

**(3) The meter** — the row's token figure in `soma status` went **up** across the rotation, never to 0.

Three readings, kept apart. **PROVEN**: (1), (2) and (3), and no `ROTATION_FAILED` on the following
tick. **FAILED**: `ROTATION_FAILED {lead, from: "seat-b", to: "seat-a", why}` in the digest — `from`
is the seat that rejected the lead, `to` the seat it was put back on — or the tail shows an
`assistant API-ERROR` whose `error` is not `rate_limit` after the `user` row: that is §9's first open
risk observed; the watchdog killed the lead and resumed it under seat A (closed, so it arms
auto-continue), and the design needs the finding before anyone raises `max_leads`. A last line whose
text is `Not logged in · Please run /login` means seat B was never logged in; `every seat logged in`
should have said so, and if it read `ok` the check is wrong. **NOT OBSERVED**: no limit hit yet;
`ROTATION_UNAVAILABLE {lead, why: "no_open_seat"}` (the pool was empty, so nothing about resume was
exercised); `why: "seats_unreadable"` (fix `state/seats.json` first — and note it is said **once per lead per
launch**, not once per tick, so `soma doctor`'s `seat pool state readable` is what will still be
telling you); `why: "thrash"`
(three rotations this hour — judge the `ROTATED` events before it, not this one); `WATCHDOG_ERROR
{where: "limits"}` (a torn line in the tail — the phase judged nothing that tick); `BACKPRESSURE
{reason: "org_level_disabled_until"}` (the org cap: nothing rotates, admission is frozen until
`soma thaw`); or a `seat: null` row. None of these is a pass. Re-prove after any Claude Code upgrade.

### The floor under the tenth: `autoContinueAtUsageLimit` is EVIDENCED, NOT OBSERVED

When rotation cannot run — no open seat, an unreadable pool, three rotations already this hour, or
the org cap — the feature's whole floor is that Claude Code resumes the lead by itself when its
window resets, armed off `autoContinueAtUsageLimit: true` in the lead's settings file. **Soma has
never observed that arming happen.** What is measured, and what is not:

- **Measured, and say which count you mean.** The key is a real settings key in every Claude Code
  binary on this machine (`~/.local/share/claude/versions/<v>`, Mach-O). Two different numbers get
  quoted for the same fact, so both are here: **occurrences** (`grep -ao autoContinueAtUsageLimit
  <bin> | wc -l`) read **19 / 19 / 20 / 20 / 20** on 2.1.263 / 269 / 274 / 275 / 276, of which four
  are `autoContinueAtUsageLimitToggleable`; **matching lines** (`grep -ac`) read **8 / 8 / 10 / 10 /
  10** on the same five, because a minified bundle has almost no newlines. Quote the method with the
  number or the next reader re-measures and thinks you were wrong.
- **Use `grep -a`.** Plain `grep` returns **exit 1 and no output** on these binaries — `file(1)`
  calls them `Mach-O 64-bit executable arm64` — and that is indistinguishable from "the key does not
  exist". Two-state reading of a three-state world, in one command. Every count above is `grep -a`.
- **What the binary actually does with it** (2.1.276, as observed in the bundle and described here
  in prose):
  - The key backs a boolean item in Claude Code's settings, labelled *Continue automatically at usage
    limit*. When the key is unset its value **defaults to true**, and the item is marked
    **consent-gated**: another part of the code that lists settings leaves consent-gated items out.
  - Whether the toggle is offered at all depends on the **source** of the setting's value: it is
    offered when the value is unset or comes from the user's own settings file. A value that arrived
    any other way (soma writes through `--settings`) is authoritative rather than user-editable.
  - Activation reads a **three-state answer to whether the key is present** in the stored settings:
    present, absent, or unknowable, the last when the read throws, with a timer that scans again
    later. Three states in Claude Code's own code, for the same reason this runbook keeps three.
  - And it sits behind a conjunction that includes a **billing-type gate**: an OAuth-scope check
    must pass, the account's billing type must not be usage-based, and further internal checks must
    pass.
- **Not observed, and not observable from soma.** None of the consent gate, the key-presence read,
  or the billing/scope conjunction is readable from outside the binary, and none is something
  a soma test can drive. `soma doctor`'s `lead auto-continue floor` proves only that **soma wrote
  `true` into the file a running lead has** — the last link soma owns, and no further.
- **What would close it.** A live limit hit on a provisioned seat, with the pane showing
  `continuing automatically at <reset>` and the lead resuming with nobody there. Nothing short of
  that. Until then this is **evidenced, not observed** — write it that way in any report, and never
  as a pass.

### The rows `soma doctor` cannot take, and how to confirm them by hand

`soma doctor` cannot print `PASS` on this build (§5.2): two of its rows are always unobserved, and a
third is unobserved from a plain shell. Each asks a real question that no local file answers, so each
is a bring-up check like the rest of this section. Confirm them by hand:

- **`workflows enabled`** asks whether dynamic workflows are available to a **spawned** lead (design
  requirement 5; the lead playbook's Step 4 fans its reads out through them). Doctor hard-wires it
  to unobserved, because the answer depends on the account's plan and the Claude Code build, not on
  anything on disk. Check it once per account — each seat, if rotation is configured — and again
  after a Claude Code upgrade. With a throwaway task at `max_leads: 1`:

  ```bash
  soma send <lead> "Reply with one word, yes or no: is a tool named Workflow in your tool list?"
  soma peek <lead>
  ```

  `yes` means the row would hold.

- **`session id matches hook payload`** compares the `CLAUDE_CODE_SESSION_ID` a session's
  subprocesses see with the `session_id` Claude Code hands that same session's hooks. It matters
  because of the inject hook (`bin/hooks/orch-inject.mjs`, registered only by
  `soma init --inject-hook`; §5.1 says why it is opt-in): it treats a prompt as the lease holder's
  only when the hook payload's `session_id` equals the id the bus recorded in the lease from
  `CLAUDE_CODE_SESSION_ID`. If the two disagree, a promoted orchestrator silently never gets event
  headers. Doctor would read the payload from `state/last-hook-payload.json`, which nothing in this
  build writes. By hand, in a Claude Code session's Bash tool:

  ```bash
  echo "$CLAUDE_CODE_SESSION_ID"
  ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$CLAUDE_CODE_SESSION_ID".jsonl
  ```

  The first prints a uuid. The second must list exactly one file: the transcript of the session you
  are typing in. Hooks receive the session's `session_id` together with a `transcript_path` named
  after it, so one file means the two agree. If no file is listed, they do not: `ls` says *No such
  file or directory*, or, under zsh, the glob itself aborts with *no matches found*. End to end: with
  the inject hook wired, a promoted session that gets unread event headers on its next prompt has
  passed this comparison.

- **`CLAUDE_CODE_SESSION_ID`** is unobserved from a plain shell by design: only a Claude Code
  session's subprocesses carry it. Run `soma doctor` from a Claude Code session's Bash tool (the
  orchestrator's, say) and it is observed, and should read `ok`; the `echo` above printing a uuid is
  the same evidence.

### The measurement run that turns four estimates into numbers

`docs/ROADMAP.md` names this as a runbook procedure, not a config default, so it belongs here. The
budget caps are calibrated against 209 real sessions and **no session in that corpus is a soma
lead** — they are single sessions that did a ticket themselves, not planning-only leads with teams.
One run settles four figures:

1. **Start one real lead on one real ticket with a real team.** Set `max_leads: 1` first.
2. Report **both** its own transcript total **and** the total of every transcript in its slug
   directory. The ratio between them **is** the team multiplier — shipped as ~2.5× with a 1.5×–4×
   band from a single structural analogue. **If it is really 4×, `standard`'s `tokens_cap` should be
   32M rather than 20M.**
3. While you are there, **confirm the lead's slug directory contains exactly the lead and its
   teammates and nothing else** — the budget meter sums that whole directory.
4. **Let one lead reach compaction**, to establish the real context window the resume fraction is
   derived against. `resume_context_window: 1000000` was *inferred* from fable-5 (observed to
   833,935, never above 900k across 3,508 turns, never compacting) — but leads are pinned to `opus`
   now, and claude 2.1.x reports `contextWindow: 1000000` for claude-opus-5 outright, so for the
   model in the lead seat the figure is established rather than inferred.
5. **Have the watchdog kill one lead** and read its transcript tail. Revival decisions run on
   killed sessions, and only finished or abandoned ones were measured.

Do all of this at `max_leads: 1`. Raise it only after the numbers land.

---

## 11. What is NOT guaranteed

**A runbook that oversells is worse than none, because your trust is the only thing standing
between this and ten unsupervised agents in your repos.** Everything below is a *declared*
residual — measured during the build, written down deliberately, and shipped known. None of it is
speculation.

### 11.0 The verdict on all of it together: supervised first run, yes. Ten unsupervised agents, not yet.

Read this before the individual sections, because **the individual sections are what this one is
correcting for.** Every residual below was declared honestly on its own. Nobody had asked whether
the *union* still describes a system worth trusting, and the answer is narrower than the parts
suggest.

**Use it for a supervised first run** — you at the terminal, `soma status` and `soma digest` in
reach, a fleet small enough to read. That is what the residual set below is the right size for.
**Do not yet leave ten agents running unsupervised in your repos.** Three things make the composite
weaker than the list:

**(a) The residuals compose, and a list read line by line hides that.** Two examples, the first
still live:

- The single-holder lease is bounded in the design by two compensating controls after a
  `force: true` steal. One of those controls is the `UserPromptSubmit` inject hook — **which is
  opt-in** (`soma init --inject-hook`, §5.1), so a fleet that did not opt in runs without it. Two
  items that are each fine alone are jointly load-bearing, and the second one is missing unless the
  operator registered it.
- Backpressure was two independent gaps and only the first was ever declared: the *evidence
  scraper* was a known stub, and separately `state/backpressure.json` — the file `soma status`
  renders from — **had no writer at all**. Both are closed (§6 item 4): the tick writes the file
  under the fleet lock, admission reads it, `soma thaw` lifts a spend-cap record, and a storm now
  freezes on the limits phase's own transcript reading, so only the pane half of the scraper is
  still a stub. The comment declaring the first had said in as many words that everything
  downstream of it was complete, so the declaration of one gap actively asserted the other was
  fine — kept here as the pattern, not the instance.

A residual list that is honest line by line and silent about interaction is the same defect as a
rule stated as a conjunction and guarded by a disjunction: each half checks out, and the thing they
were supposed to hold together does not.

**(b) One layer credited below is not a layer you own.** See §11.8, rewritten.

**(c) One layer is monitored less than the text implies.** §11.4 and §11.3 both bound their
residual with "…and the PreToolUse gate covers the rest". `soma doctor` certifies that gate from
its **matcher alone** — it never reads the hook's command string — so a gate pointed at a
nonexistent script, or one whose command is `true`, still reports `PASS`. Treat a green doctor as
evidence the gate is *registered*, never as evidence it *runs*. §10's bring-up steps are the only
thing that observes it running.

**What would move this to "leave it running":** the two Criticals from the final review closed, the
inject hook registered on the orchestrator's config root (its installer has shipped:
`soma init --inject-hook`, §5.1), and a doctor check that reads a hook's command. None of those is
large; of the three, only the installer is done as you read this.

### 11.1 The enforcement gate reads command strings, so a subprocess defeats it

The PreToolUse gate sees the **command string**, and that is the ceiling for Claude Code's own
permission rules too. So `python -c 'open("x","w").write(...)'`, `node -e`, `eval`, and any
teammate-authored script reach the filesystem regardless of what the rules say. This was declared
out of scope from the start. **OS sandboxing — a read-only bind mount, seatbelt, or bubblewrap — is
the v2 answer**, and nothing at the command-string layer closes it. v1 narrows the reachable idioms
and declares the rest.

### 11.2 `xargs` whose paths arrive only on stdin is genuinely outside the gate

`xargs rm < list.txt` and `cat list.txt | xargs rm` **name no path in the command string at all**.
Measured ALLOW, and they deleted a real guard file. `ls .claude | xargs rm` *is* caught, but only
because `ls`'s own operand is the directory. This one is not a regex that needs tightening — it is
outside what a command-string gate can see.

### 11.3 The guard file holds all the deny rules and can still be erased

`<worktree>/.claude/settings.local.json` is **the only home of 95 machine-independent deny rules,
plus one `mcp__*` deny for every personal MCP server this machine has.** An emptied guard file
does not fail safe — it means *no restrictions at all* — and Claude Code re-reads it mid-session, so
one uncovered write idiom uncovers the rest. The rule protecting the file used to live *in* the file.

> **That number was wrong here until now, and in the direction that matters.** This section used to
> say "~58 … (`spawn.mjs` says 58, `lead-gate.mjs` says 59 — the two modules' counts differ by
> one)". Both modules were wrong and the disagreement was a distraction: neither figure was ever a
> count of a fixed set, both were snapshots taken before the credential-store family landed. The
> real count comes from calling the generator and counting the file it writes — 95 = 68 `Bash(…)`
> + 13 `Read(…)` + 13 `mcp__…` + `Edit(./.claude/**)`, with zero duplicates. So the sentence you
> use to size the damage of an erased guard file **understated it by 37 rules**, which is the whole
> credential family in §11.4. A residual that under-alarms is worse than one that over-alarms.
> `lead-gate.mjs`'s own `59` is a separate site and is not corrected by this branch.

**That is fixed in the direction that matters, and only that direction.** The gate hook's
registration now also lives **outside** the worktree, in `$SOMA_HOME/leads/<id>/settings.launch.json`
(what `--settings` points at), and hooks **merge** — a worktree-local file can only *add* a hook,
never remove a higher-scope one. Measured against every shape of the local file worth trying:
absent, a *different* `PreToolUse` hook, `{"hooks":{}}`, `{}`, zero bytes, and
`{"hooks":{"PreToolUse":[]}}` — in every case the higher-scope hook still fired and still denied.
Live A/B against a real split-pane teammate, claude 2.1.220: with the worktree guard file at **zero
bytes** for the whole run, the teammate's `cp ./.claude/settings.local.json <elsewhere>` was
**DENIED** by a hook whose only registration was outside the worktree, and the destination file was
never created.

**So the effect is recoverable rather than fatal — and it is not a substitute for noticing.** A
teammate can still remove its own deny rules for the rest of a session. The other half of the fix
is you: `soma doctor`'s `every worktree guard file carries rules` check exists for exactly this, and
also catches a `git clean -fdx` removing an ignored-by-design `.claude/`. **Run doctor after
anything unusual.**

### 11.4 Credential stores were reachable, and a deny list has the same ceiling here

During the build a review agent read the operator's live Claude OAuth tokens by running
`security find-generic-password`. Nothing in the guard file stopped it. v1 adds a **deny family** —
`Bash(...)` rules for the command form and 13 `Read(...)` rules for the file-at-rest form, each rule
**individually** pinned by a test (measured per rule, not asserted as a set) so a "tidy the deny
list" edit cannot silently remove one — plus a doctor assertion. But a denylist over command strings
has the same ceiling for `security` as it does for `python -c`. The `Read()` half carries real
weight because `Bash(cat*credentials*)` loses to `head`, `less` and `python` — for a credential file
at rest, the `Read()` rule is the half that holds.

**Two more ways past the `Bash(…)` half, both undeclared until now, both cheaper than writing a
subprocess.** Neither is theoretical and the first is a single keystroke:

1. **Case variation on a path.** Permission rules match case-**sensitively** against the command
   string; your root volume is case-**insensitive** APFS. So `cat ~/.AWS/credentials` and
   `strings ".../LOGIN DATA"` match no rule and are ALLOW, while the filesystem hands over exactly
   the same bytes. Re-measured for this section with synthetic files in a scratch directory — never
   a real credential, never a keychain read.
2. **Quote or backslash splitting inside a filename.** `cat ~/.ssh/id""_ed25519` names the same
   file to the kernel, because the shell strips the quoting before the syscall — but the string the
   rule is compared against still carries the `""`, so `Bash(*.ssh/id_*)` does not match.

**These are declared, not patched, and that is a decision rather than an omission.** Case is not
enumerable — `~/.aws/credentials` alone has 2^15 spellings — so adding `Bash(*.AWS/credentials*)`
would close one of them while making the rule set *look* more complete. Quote-splitting is the same
open set. Widening a rule on suspicion is how you get a deny list that reads as a boundary and is
not one. The fix that actually closes both is a predicate in the PreToolUse gate that lowercases
and unquotes the command string before comparing it against a credential-path set; that is recorded
in `docs/ROADMAP.md`.

**What this means for you today:** the named single-command paths are closed, and a teammate that
tries a *different spelling* of one of them is not stopped by these rules. The `Read()` half is
unaffected by (2) and its behaviour under (1) was not measured — do not assume either way.

### 11.5 `state/`, `events/`, `logs/`, `digests/` and `heartbeats/` are not write-protected

`leads/` **is** denied, by path prefix, to every session including teammates — it holds
`BUDGET_TRIPPED` and `settings.launch.json`, and a teammate that empties the launch file disarms
the gate for every teammate spawned after it. Measured before that rule existed: **all 12 vectors
ALLOWed as a teammate.** The **state root directory itself** is also denied as a write target
(exact match, never a prefix — `worktrees/` lives under it), because `chmod 000 $SOMA_HOME` disarms
the breaker by the identical mechanism.

**The other five subdirectories are declared residuals of that rule, not covered by it.** A lead or
teammate can write into `state/`, `events/`, `logs/`, `digests/` and `heartbeats/`. `worktrees/`
must stay writable — it is where every teammate does its work.

### 11.6 The lock has a measured, unclosable takeover race

Three independent measurements put the residual takeover race at **0.28, 0.74 and 1.63 violations
per thousand *provoked* takeovers**, depending on how aggressively it is provoked, and **zero
across tens of thousands of critical sections with no crashed holder**. It cannot be closed in pure
POSIX: there is no "unlink only if this inode", so taking over a dead holder's lock always leaves a
two-syscall window. Three attempts narrowed it; none closed it. Two ideas that look like fixes are
not — serialising takeovers behind a second lock reintroduces a smaller wedge via that lock's own
stale state, and a symlink lock does not help (a symlink makes *publication* atomic, which
`link(2)` already does; takeover is still `unlink` by name). Only `flock`/`fcntl` on a held
descriptor genuinely closes it, and there is no synchronous zero-dependency Node API for that.

### 11.7 There is no `linger_minutes` reaper, so terminal leads keep live panes

`linger_minutes` (45) and `stall_minutes` (20) are in `DEFAULTS` and **nothing reads them**. The
tick's own header says so: adding an unrequested killer of live tmux sessions would be the worst
possible way to widen its scope. Consequence: a `done` or `failed` lead's tmux session and pane keep
standing until you `soma kill` it or reboot. That is often *useful* — the dead pane is the
post-mortem `soma peek` shows — but at ten leads over a few days it accumulates, and there is no
`soma gc` either.

### 11.8 The model layer is not a layer you have. Do not count it.

**Count your layers as §11.1–§11.5 and nothing else.** This section used to be titled "a real
second layer today", and that framing has to go, for two reasons — the second of which was only
found at the end of the build.

**It is a property of the model in use, not of the harness.** For the strong models, the model
itself independently refuses many hostile shapes — commands the deny rules would also have caught,
and some they would not. That was observed during the build and it was real when observed. But
nothing in `bin/` depends on it, nothing tests it, and **a model swap changes your risk with no
code change anywhere.** There is no version of that which belongs in a safety argument.

**The observation used to be taken on the wrong population, and the model pin has since closed
that — read the remaining gap precisely.** Every probe that watched a model decline ran against a
strong model, and while leads were pinned to `fable` the model in the lead seat — the one holding a
worktree, a budget, and a team — was not the model any of those refusals were measured on, so the
layer's strength on the deployed configuration was *unknown* rather than weak-but-known. **Leads
are pinned to `opus` at effort max now** (§6), which is the same class of model those probes ran
against, so the population mismatch is gone in the direction that mattered. What remains is
narrower and worth stating rather than waving through: "a strong model" is not "this model, at this
effort, in this seat", and nothing here re-ran the probes against a real lead. Treat the layer as a
residual of *plausible* size instead of an unmeasured one — and never as a layer you are relying on.

Do not let "it refused when I tried it" become part of your safety model. If you tried it, you very
likely tried it in a strong-model session, and that is a different system from the one your leads
run in.

### 11.9 A settings file binds the fleet, argv binds one process — and that is why teammates can write

**This section changed, and if you acted on the previous version you need to undo it.** It used to
tell you to hand-edit `bin/lib/settings-gen.mjs` before your first run, and to expect one `soma
doctor` check to go red afterwards. **The edit is now in the shipped tree and `soma doctor` is green
on it.** If you applied it yourself, discard your local change (`git checkout bin/lib/`) — a second
copy of the same deletion is harmless, a half-applied one is not.

This is kept as a residual rather than deleted because the property it describes is **undocumented
Claude Code behaviour that a version bump can retire**, and because the symptom is silent: a fleet
that runs perfectly and commits nothing.

**What was wrong.** `settings-gen.writeLeadSettings` put `permissions.deny:
['Edit','Write','NotebookEdit']` in the lead's settings file to give the *lead* its no-code
property, on the stated understanding that the file is "scoped to the lead process". **It is not.**
In the claude 2.1.220 binary the teammate launcher's inherited-flag builder ends with `--settings
<the parent's own value>`, and four real split-pane teammates carried the same `--settings` path in
their own argv. Live, a teammate spawned from such a session reported:

> `Write, Edit, and NotebookEdit are all absent from this teammate's toolset.`
> `No such tool available: Write. Write exists but is not enabled in this context.`

Every teammate in every fleet lost all three write tools, and it read as a model limitation rather
than a settings bug — which is why it survived four reviews.

**Why the fix is a deletion and costs nothing.** The inheritance is **asymmetric**. Measured against
a parent carrying all five flags at once, a split-pane teammate inherited `--settings` and inherited
**none** of `--disallowedTools`, `--mcp-config`, `--strict-mcp-config`, `--setting-sources`. So:
**a `--settings` file binds the whole fleet; argv binds one process.** Anything that must reach the
lead and not its team belongs on argv. With the settings deny gone and only `--disallowedTools
Edit,Write,NotebookEdit` on the lead's argv, three measurements:

- the lead's session `init` tool list holds **none** of the three — the same 27-tool list the deny
  produced, so argv removes them from context rather than refusing at call time;
- the lead itself, asked to write a file, answered *"No such tool available: Write…"* and wrote
  nothing;
- the lead's in-process `Task`/workflow subagents got that same refusal, so argv holds the whole
  stated boundary — the lead session **including** its workflow agents, **excluding** its teammates.

In the same live session, the lead's teammate wrote its file. The gate hook's session-discriminated
`isLead` arm (`bin/hooks/lead-gate.mjs`) was a second, independent carrier of the lead's ban; both
carriers have since been retired outright — a lead's edit surface now matches a teammate's, and the
`--session-guard` flag that switched the arm on is emitted nowhere any more (old guard files still
carrying it are harmless: the gate ignores argv it does not know).

**What `soma doctor` now says about it, and what it refuses to say.** The old `lead edit ban
boundary` check asserted the defect — that the lead's settings file carried those three bare names —
so it was replaced by a pair pointing in opposite directions:

- **`no edit ban in settings files`** — neither the lead settings file nor the worktree guard file
  carries a bare `Edit`/`Write`/`NotebookEdit` deny. This is the regression guard: it is the only
  thing that would notice someone putting the line back, which would silently re-break every
  teammate.
- **`lead edit ban on argv`** — `spawn.buildLeadArgv()` still emits `--disallowedTools` carrying all
  three names.

**Neither is a statement about a running lead.** `soma doctor` cannot see a live session's tool
list; the argv check calls the generator and says so in its own output. The live proof is the
bring-up step `leadCannotWrite` in §10, and it is worth re-taking after any Claude Code upgrade.

Do not "fix" a lead you think is under-banned by widening the ban into a settings file, and do not
remove `--disallowedTools`: **a lead that can write code is a worse defect than the one this
closed.**

`teammateCanEdit` is the canary invariant that would have caught this, and the canary driver does
not exist on this build (§5.4) — which is why it reached you through a runbook section instead.

### 11.10 A live tmux server can say "no server", and `status` and `down` then believe it

`soma status` and `soma down` read tmux's two no-server sentences, `error connecting to <path> (No
such file or directory)` and `no server running on <path>`, as an empty server (§7): `status`
reports `watchdog: absent — no tmux server answers on socket soma` with every spawned lead `dead`,
and `down` reports that no watchdog was running and exits 0. Both sentences were measured on tmux
3.6a. Before the first `soma up`, and after the fleet's last session has exited, they are true. In
two states a LIVE server gives them too, and then both reports are wrong while the server, its
watchdog and its leads keep running:

- **Its socket file was deleted while it runs** — a `/tmp` cleaner is the usual way. Measured in a
  throwaway sandbox on tmux 3.6a, with stand-in sessions on a private socket rather than a real
  fleet: once the live server's socket file was removed, tmux printed `error connecting to <path>
  (No such file or directory)`, `soma status` reported the watchdog absent, and `soma down` exited
  0 saying none was running, while the server and its sessions stayed alive. A `new-session` on the
  same socket name (the call `soma up` makes to start its watchdog) then exited 0 and started a
  SECOND server on the same path: a different pid, the first one still alive, and the socket
  listing only the second one's sessions. Before any second server existed, `SIGUSR1` to the first
  server's process recreated its socket, and `soma status` read the watchdog live again (tmux(1)
  documents that signal for this). **Inferred, not reproduced on a fleet:** what a watchdog started
  in this state would do. It would see none of the first server's leads, read them as dead
  (`LEAD_DEAD`) and respawn them, leaving two leads on each worktree; `soma up` now refuses here
  instead (below). **Recovery, in this order:** send `SIGUSR1` to the orphaned server's process
  (`ps` lists it as `tmux -L <socket> …`, and `up`'s refusal names its pid), and run `soma up` only
  once `soma status` reads the fleet again.
- **It is wedged, and its accept queue has overflowed.** Measured on macOS, tmux 3.6a: a server
  stopped with `SIGSTOP`, 300 clients started against it and killed, and the next client printed
  `no server running on <path>` while the server was alive; a `new-session` then started a fresh
  server on the same path and left the stopped one orphaned. So `status` and `down` misreport as
  above; `soma up`, which would have started a second server and a second watchdog, now refuses
  (below). **Recovery:** `SIGUSR1` is no help here, because the socket file is still in place and
  the server is simply not accepting on it. `SIGCONT` resumes a stopped server. One that stays
  wedged has to be killed, which ends every session in it, leads included, and from there it is the
  reboot path (§7, *Reboot contract*).

Nothing is written on the wrong reading. `soma kill` does not take it (it refuses with exit 3, as
for any unreadable tmux), and the watchdog never does (it skips the tick). The damage is a report
that says the fleet is down when it is not. Answering it with `soma up` no longer starts a second
fleet. `up` refuses with exit 3 whenever tmux cannot be read, unless tmux says no server answers.
Then, before it starts one, it looks for a live tmux process for soma's socket: `/proc/<pid>/cmdline`
on Linux, `ps` on macOS, matching a `tmux` that runs as you and whose own options say `-L <socket>`.
It refuses again when it finds one, naming the pid and the recovery above, or when it cannot read
the process table. That is the check that tells a server that is really gone from these two
states, and it used to be yours: if a tmux process of yours for soma's socket is still alive, you
are in one of them. Measured: a server shows the argv of the client that started it, which for
the one `soma up` starts is `tmux -L soma -u new-session …`, on macOS (tmux 3.6a) and Linux
(tmux 3.4, WSL2), and still does after its socket file is deleted. What the check cannot see: a
server started with `-S <path>` instead of `-L`, or by a tmux build that rewrites its own argv.
What it over-sees: a tmux of yours with the same `-L` name under another `TMUX_TMPDIR`, which is a
different socket. That only makes `up` refuse. Another user's tmux does not count at all: a `-L`
socket lives in its own user's directory (`tmux-<uid>/`), so another user's `tmux -L soma` is never
your socket. Counted, it would make your `soma up` refuse on a shared machine for as long as theirs
runs, naming a pid you are not allowed to send `SIGUSR1` to.

### 11.11 A tmux lease can keep a pane its holder no longer has

**Inferred from reading the code, not reproduced.** When `beat()` cannot prove that the holder's
pane is on soma's tmux server, it offers the heartbeat no pane, so a `wake: tmux` lease keeps the
pane id it last recorded. That is the case once the holder has moved off soma's server: resumed in
another tmux server, or outside tmux (the second is unchanged from before). Pane ids are not reused
while a server lives, but they restart at `%0` when soma's server is recreated. A lead can then be
handed the recorded id, and a lead's wake would pass the pane gate into that lead's composer.

`beat()` leaves the transport alone on purpose: `lease.heartbeat` repairs a pane and leaves any
change of transport to `soma_adopt`. **Recovery:** run `/soma-promote` again where the holder now
is. `soma_adopt` re-proves the pane and rewrites the lease as `wake notify`. The window is narrower
than it was: before `beat()` proved the pane, a resume into another tmux server re-pointed the
lease at that server's pane id at once.

---

## 12. Troubleshooting

| symptom | most likely cause |
|---|---|
| `npm test` prints no `pass`/`fail` lines | Node < 24. The test glob matched nothing. §1 |
| `SOMA_HOME must be an absolute path` | relative value, or a quoted `~`. §3 |
| `does not support hard links (link(2) returned …)` | exFAT/FAT/FUSE/cloud-sync mount. Move `SOMA_HOME`. exit 2 |
| `soma up` exits 3, "doctor reported FAIL" | a doctor row did not hold, so nothing was projected, asked or started. Fix the `FAIL` rows (each names what it read) and run `soma up` again; `--ignore-doctor` goes on anyway and fixes nothing. §5.3 step 5 |
| `soma up` refuses with "no terminal here to confirm" | not a TTY. There is no `--yes`. §5.3 |
| `soma up` exits 3, "its pane is already dead" | the watchdog exited on startup. Read `$SOMA_HOME/logs/watchdog.log` |
| `soma up` exits 3, "whether a watchdog is already running is UNKNOWN" | tmux could not be read, so a running watchdog cannot be ruled out. `soma status`, `soma doctor`. §5.3, §11.10 |
| `soma up` exits 3, "a tmux process for that socket is still alive (pid …)" | no server answers, but its server process lives: socket file deleted, or wedged. Recover it first. §11.10 |
| `soma up --canary` never passes | expected on this build. §5.4 |
| every lead shows `0` tokens in `status` | wrong claude config root — a stale `~/.claude/projects` matches no uuid. The **budget breaker is welded open.** `soma doctor` → `claude config root` |
| `status` shows `LIVE ?` everywhere | tmux unreadable, not a dead fleet. Check the `soma` socket: `tmux -L soma ls` |
| `soma kill` exits 3 | the lead may still be running and the row was **left alone**. `soma status`, then kill again. §7 |
| `soma down` exits 3 | the watchdog may still be supervising. §7 |
| leads spawn but nothing is committed | `soma peek <lead>` first. If a teammate says it has no write tools, that is §11.9 and your tree is not the shipped one |
| a teammate says `No such tool available: Write` | §11.9 — a `permissions.deny` in a settings file that propagates down `--settings`, **not** a model limitation. Fixed in the shipped tree: check `git diff bin/lib/settings-gen.mjs`, and run `soma doctor` for `no edit ban in settings files` |
| a teammate's `git push` is refused | check the branch is `soma/<id>` — pushes to `main`/`develop` are denied by design, and so are force/delete on any branch |
| a lead's `git push` is refused | the lead may push only its own branch, spelled `git push -u origin soma/<id>` as a command of its own (nothing chained after it, no `2>&1`), from its worktree root. If the refusal names `lead_branch_push`, the fleet has turned that push off or the lead started before it existed: a teammate pushes, or set it to `true` and resume the lead. If it says the id ends in `-d` or `-f`, the deny list refuses every spelling a lead may use: a teammate pushes it with the refspec quoted, `git push origin 'soma/<id>'` |
| orchestrator never hears about a blocked lead | nothing wakes it. Arm `soma watch` under the Monitor tool, pinned the way §6.1 says, and re-arm it on every expiry; register the inject hook with `soma init --inject-hook` (§5.1). Meanwhile poll with `soma digest` / `soma_inbox` |
| `soma_spawn`/`soma_enqueue`/`soma_send` missing after promotion | mid-session role upgrade not honoured yet. Look again next turn; meanwhile drive the CLI with `--as`. Do **not** restart or re-register — the lease is already yours on disk. `SKILL.md` §6 |
| the lease was taken from under you | it reads stale after 10 min without a heartbeat. Open every turn with `soma_inbox` or `soma_status`. §6.1 |

---

## 13. Reference

- **Design spec** — `docs/superpowers/specs/2026-07-29-claude-soma-lite-design.md`
- **Deferred scope, with reasoning** — `docs/ROADMAP.md`
- **Promotion on-ramp** — `skills/soma-promote/SKILL.md`
- **Orchestrator contract** — `prompts/orchestrator.md`
- **Lead playbook** — `prompts/lead.md`; harness registry — `prompts/harnesses.json`
- **The nine invariants, in full** — `bin/lib/canary.mjs`
- **The 48 checks** — `bin/lib/doctor.mjs` (`CHECKS`)
- **Account rotation, design** — `docs/superpowers/specs/2026-09-15-account-rotation-design.md`
- **The seat pool** — `bin/lib/seats.mjs`, state in `state/seats.json`; **the limit classifier** — `bin/lib/wd/limit-state.mjs`; **the six rotation events** — `bin/lib/wd/rotation-events.mjs`; **the freeze record and storm detection** — `bin/lib/wd/backpressure.mjs`, `state/backpressure.json`, a spend-cap record lifted by `soma thaw` and a storm's by the watchdog
- **The tenth invariant** — §10 of this document, deliberately not `bin/lib/canary.mjs`
- **The deny rules** — `bin/lib/settings-gen.mjs` (`STANDING_DENIES`)
- **The gate's five bans and their evidence** — `bin/hooks/lead-gate.mjs`
