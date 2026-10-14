#!/usr/bin/env node
/**
 * `soma` — the operator's whole interface to the fleet.
 *
 * A thin dispatcher over the twenty modules under `bin/lib/`. It owns no policy of its own;
 * what it owns is the *reporting contract*, and that is the reason this file is long for what
 * it does. Three rules run through every arm, and each one is a defect this build already paid
 * for somewhere else:
 *
 * 1. **Print what was resolved, not a verdict.** `soma doctor` names the config root it read
 *    rather than saying "ok", because an operator runs these commands when something is
 *    already wrong and "ok" is the one answer that cannot be acted on. So `status` names the
 *    state root every reading came from, `init` names all four roots it touched, and `up`
 *    names the node, the log and the tmux session it started.
 *
 * 2. **Never claim success that was not verified.** Six inert safety mechanisms were found on
 *    this build, every one of which looked healthy. A CLI arm that prints "started" because a
 *    spawn call returned is the same defect one layer out: `tmux new-session` exits 0 for a
 *    command `env -i` cannot resolve, and `claude mcp add` can exit 0 leaving nothing
 *    readable. Both are read back here, and the read-back has THREE outcomes — verified,
 *    refuted, and not measured — because collapsing the third into either of the others is how
 *    a wedged tmux makes ten working leads read as dead.
 *
 * 3. **A path, a socket and a flag get ONE spelling.** The tmux socket comes from
 *    `tmux.tmuxArgs`, the pause flag from `queue.queuePaused`, the state root from
 *    `paths.SOMA_HOME()`, the lead's session name from the checkpoint row. A second spelling
 *    of the wake path already shipped once on this build and had to be fixed: nothing errors,
 *    both halves are right by their own lights, and the switch simply does not connect.
 *
 * ---
 * **THE GUARDED DEPS HAVE NO DEFAULTS.** `spawn.checkDeps` and `soma-watchdog`'s `checkDeps`
 * both refuse an incomplete dep set rather than completing it from the real wiring, and this
 * file needs that refusal more than either: the deps it would silently supply start detached
 * tmux sessions, register an MCP server in the operator's own `~/.claude.json`, spawn real
 * `claude` processes, and block on a terminal. `{...realDeps(), ...deps}` — the sketch's shape —
 * makes a test that forgets one of them do the real thing. So `GUARDED_DEPS` is resolved
 * through `need()`, which throws naming the absentee, and the production entrypoint passes
 * `realDeps()` explicitly. One code path, no ambient fallback.
 *
 * **stdout is the report; stderr is the refusal.** Nothing here captures stderr, deliberately:
 * `config.loadConfig` writes its retired-key notice straight to `process.stderr` once per
 * process, and `doctor.formatDoctor` writes stdout so `soma doctor | tee` works. Capturing
 * either for reformatting would fold a warning the operator needs into soma's own stream. And
 * the process exits by setting `process.exitCode` rather than calling `process.exit`, which
 * truncates a piped stdout mid-write.
 *
 * **What is deliberately absent.** `hold`, `release` and `gc` are named in the ROADMAP, the
 * design doc and `skills/soma-promote/SKILL.md`, and they refuse here with a reason rather than
 * falling through to a usage line. (`thaw` is built: it lifts an org spend-cap freeze through
 * `wd/backpressure.mjs` and refuses a live storm — see its arm.) `hold` is the important one: nothing in `bin/` reads
 * `leads/<id>/HOLD`, so writing it would ship a pause that is written, displayed and never
 * obeyed — which is the exact defect `queue.mjs` exists because of. There is no `inbox`
 * subcommand, and SKILL.md correctly says so.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, linkSync, mkdirSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { intake } from './lib/bus-tools.mjs';
import { runCanary } from './lib/canary.mjs';
import { loadConfig } from './lib/config.mjs';
import { runDoctor } from './lib/doctor.mjs';
import { appendEvent, readEvents } from './lib/events.mjs';
import { enqueue as fleetEnqueue, launching, readFleet, setTaskStatus, updateFleet } from './lib/fleet.mjs';
import { inspectInject, installInjectHook } from './lib/inject-hook.mjs';
import { heartbeat, readLease } from './lib/lease.mjs';
import { SOMA_HOME, claudeConfigRoot, ensureTree, p } from './lib/paths.mjs';
import { queuePaused } from './lib/queue.mjs';
import { clock, seatsSummary } from './lib/seats-summary.mjs';
import { pick as pickSeat, resolveConfigDir } from './lib/seats.mjs';
import { resumeLead } from './lib/spawn.mjs';
import * as tmux from './lib/tmux.mjs';
import { projectFleetSpend, readUsage } from './lib/tokens.mjs';
import { INTERVAL_DEFAULT_S, INTERVAL_MAX_S, INTERVAL_MIN_S, runWatch } from './lib/watch.mjs';
import { STORM_REASON, clearBackpressure, readBackpressure } from './lib/wd/backpressure.mjs';
import { clearTrip } from './lib/wd/budget.mjs';
import { CENSUS_LINES, readPane, takeCensus } from './lib/wd/pane-state.mjs';

/** The watchdog's tmux session name. One spelling, shared by the start, the probe and the kill. */
const WATCHDOG = 'soma-watchdog';

/** The orchestrator's own event stream — `events.mjs`'s one reserved stream name. */
const ORCH_STREAM = 'orch';

/** A legal task id. Mirrors `fleet.ID_RE`: it reaches the filesystem and a tmux target. */
const LEAD_RE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * A tmux session name soma could have written. Mirrors `bus-tools`' guard on the same field
 * and for the same reason: `tmux_session` lives in a file an operator can edit, and a value
 * shaped like a pane (`%1`) is a different kind of target — `capturePane` and `sendKeys` pass
 * `%`-prefixed arguments straight through, so a row reading `%1` would peek at, or type into,
 * whoever is running this command.
 */
const TMUX_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** `capture-pane` has no scrollback here: this is the death scene, not archaeology. */
const PEEK_LINES = 60;
const PEEK_MAX = 2000;

/** How much of the event log `digest` shows by default. */
const DIGEST_LINES = 40;
const DIGEST_MAX = 2000;

/** One `send` becomes one argv to `send-keys`, so it is bounded like the bus bounds its own. */
const SEND_MAX = 2000;

/** Rows whose lead holds a live, answerable session — the only ones a LIVE reading applies to. */
const ANSWERABLE = new Set(['spawned', 'blocked']);

/**
 * Rows `retry` will re-queue: the two that mean "did not deliver".
 *
 * `done` is deliberately NOT here. ROADMAP's wording is "re-queue a FAILED row", and a done
 * task has a draft PR against its worktree — re-queueing it starts a second lead that will
 * open a second one, discarding the first without saying so. Re-running finished work is an
 * `enqueue` of a new id, which is visible.
 */
const RETRYABLE = new Set(['failed', 'skipped']);

/**
 * The environment the watchdog is started with, before `SOMA_HOME` is injected.
 *
 * `tmux.newSession` runs the command under `env -i`, so **what is not on this list does not
 * exist for the watchdog or for anything it spawns** — and the watchdog spawns every lead:
 * `spawn.buildLeadEnv` copies `spawn.ENV_ALLOW` out of the *watchdog's* `process.env`. Two
 * names on this list are therefore load-bearing rather than cosmetic, and the sketch had
 * neither, and a third was added after the first real fleet:
 *
 * - **`CLAUDE_CONFIG_DIR`** decides which `.claude.json` and which `projects/` tree claude
 *   uses. Dropped, the watchdog's budget meter reads transcripts under `~/.claude`, finds no
 *   matching session uuid, and reports zero tokens for every lead — so the breaker never trips
 *   and the fleet has no spend control, with nothing in any log to say so. And every lead it
 *   spawns loses its trust mark and stops on "Quick safety check" in a detached pane with
 *   nobody there to answer.
 * - **`SOMA_TMUX_SOCKET`** decides which tmux server soma talks to. A watchdog on a different
 *   socket from the CLI that started it is the same class of split as a forked state root:
 *   both processes are right by their own lights, and the watchdog supervises a server with
 *   nothing on it.
 *
 * - **`USER`**, without which every lead the watchdog spawns is **`Not logged in`**. OAuth
 *   credentials are in the macOS keychain and the lookup does not resolve without it. This
 *   list is why adding `USER` to `spawn.ENV_ALLOW` alone was not enough: the copy reads the
 *   watchdog's `process.env`, so a name absent HERE is absent for every lead no matter what
 *   `ENV_ALLOW` says. Measured on the first real fleet — the fix went into `ENV_ALLOW`, the
 *   leads came up unauthenticated anyway, and `ps eww` on the live pane showed no `USER`.
 *
 * `SHELL`, `TERM`, `LANG` and `TMPDIR` are the shape of a usable shell, matching
 * `spawn.ENV_ALLOW`. Nothing else is forwarded: the operator's exported API keys are exactly
 * what `env -i` is for.
 *
 * **The invariant this list owes `spawn.ENV_ALLOW`, now asserted rather than assumed:
 * `ENV_ALLOW ⊆ WATCHDOG_ENV_ALLOW`.** A name in `ENV_ALLOW` and not here is one the lead is
 * declared to receive and cannot, and nothing anywhere reports the gap — the lead just comes
 * up missing it. The comment above has always described the coupling; only the two lists
 * drifting was never caught. Exported for exactly that test.
 */
export const WATCHDOG_ENV_ALLOW = Object.freeze([
  'HOME', 'PATH', 'SHELL', 'TERM', 'LANG', 'TMPDIR', 'CLAUDE_CONFIG_DIR', 'SOMA_TMUX_SOCKET', 'USER',
]);

/**
 * Exit codes, because an operator scripts these and a shell only sees the number.
 *
 * `2` is reserved for "this machine cannot run soma" — a relative `$SOMA_HOME`, a state root
 * that cannot take a hard link, a `claude` that is not installed — as distinct from `3`, "soma
 * declined to do what you asked", which is a fleet state rather than an environment fault.
 */
const OK = 0;
const USAGE_CODE = 1;
const ENV = 2;
const REFUSED = 3;

/**
 * Deps with real side effects outside `$SOMA_HOME`: they start processes, talk to tmux, read the
 * machine's process table, write the operator's Claude Code config, or block on a terminal. See
 * the module header. (`serverProcesses` is here although it writes nothing: run for real by a test,
 * it reports the operator's own live fleet, and `up` would read that as a refusal.)
 */
export const GUARDED_DEPS = Object.freeze([
  'liveSessions', 'serverAbsent', 'serverProcesses', 'paneStates', 'newSession', 'killSession', 'sendKeys', 'capturePane', 'resumeLead',
  'exec', 'capture', 'doctor', 'canary', 'confirm', 'linkProbe', 'installSkill', 'installInjectHook',
]);

/**
 * The PANE column's words, one per fine pane state (`wd/pane-state.mjs`). Never `dead` and never
 * `yes`: those are the LIVE column's, and a `done` row reading `dead` in any column is a fault an
 * operator goes looking for. `?` is the listing that could not be read — the same third state the
 * LIVE column has — and `-` is a row with no session yet: one that never had one, or a lead still
 * starting (LIVE `starting`), whose missing pane is not `gone`.
 */
const PANE_TOKEN = new Map([
  ['working', 'working'], ['idle', 'idle'], ['idle_draft', 'draft'], ['blocked_on_prompt', 'prompt'],
  ['dead_shell', 'shell'], ['dead_pane', 'exited'], ['absent', 'gone'], ['unobservable', '?'], ['unrecognised', 'other'],
]);

/**
 * The `seats:` line of `status`, from `seats-summary`'s record. Three states in three arms:
 * UNREADABLE names the reason and denies the reassuring reading; "none configured" says where
 * leads run instead; otherwise one clause per seat — open, closed with its reset time and
 * reason, unverified with the login command, because no machine action can fix that one.
 * Buckets in the order open · closed · unverified, config order within each.
 */
const seatsLine = (s) => {
  // ONE spelling of the third state, because two arms reach it and the word `open` may appear
  // on it only inside those quotes (the `doesNotMatch(/\bopen\b(?!")/)` assertion holds it).
  const unreadable = (why) => `seats: UNREADABLE (${why}) — which seats are usable is unknown, so this is NOT "open". \`soma doctor\` runs the seat checks.`;
  if (!s || typeof s !== 'object' || s.unreadable === true) {
    return unreadable(nonEmpty(s?.why) ? s.why : 'unknown error');
  }
  // A `configured` that is not an integer is the count NOT MEASURED, which is a third state and
  // not the claim "none configured" makes — that one says where leads run INSTEAD, and an
  // unknown count is no evidence for it. `seatsSummary` only emits a non-integer count with
  // `unreadable: true` (the arm above), but `bus-tools.shapeSeats` can already emit
  // `{ configured: null, unreadable: false }`, so the collapse is one rewiring from reachable.
  if (!Number.isInteger(s.configured)) {
    return unreadable(nonEmpty(s.why) ? s.why : 'the configured seat count is unknown');
  }
  if (s.configured === 0) {
    return 'seats: none configured — leads run under this process\'s CLAUDE_CONFIG_DIR';
  }
  const clauses = [];
  for (const x of Array.isArray(s.open) ? s.open : []) clauses.push(`${x.label} open`);
  for (const x of Array.isArray(s.closed) ? s.closed : []) {
    clauses.push(`${x.label} closed until ${clock(x.closed_until)}${nonEmpty(x.closed_reason) ? ` (${x.closed_reason})` : ''}`);
  }
  for (const x of Array.isArray(s.unverified) ? s.unverified : []) {
    clauses.push(`${x.label} unverified (not logged in — CLAUDE_CONFIG_DIR=${x.config_dir} claude auth login)`);
  }
  return `seats: ${clauses.join(' · ')}`;
};

/**
 * Why `soma send` refuses to type (added after leads were found stalled on prompts nobody saw),
 * one sentence per reading — measured, not inferred: `send-keys -l` into a live permission dialog
 * is swallowed and the Enter selects the highlighted `1. Yes`; into a bare zsh pane the text
 * EXECUTES (`zsh: command not found: Operator:`); into a dead pane both calls exit 0. An unreadable
 * pane refuses too, the way `soma resume` refuses an unmeasured liveness: typing blind into a
 * dialog is the unrecoverable direction, a retry is not.
 */
/** The dialog kinds in an operator's words. `question` is the AskUserQuestion select list, measured live. */
const dialogWord = (kind) => (kind === 'permission' ? 'permission dialog'
  : kind === 'trust' ? 'trust dialog'
    : kind === 'question' ? 'question dialog (AskUserQuestion — the lead is asking YOU something)'
      : 'dialog of a kind soma cannot name (a dialog footer with no composer on screen)');

const SEND_REFUSALS = new Map([
  ['blocked_on_prompt', (id, r) => `soma send: refused — ${id}'s pane is showing a ${dialogWord(r.kind)}; typing into it would answer it blind —`
    + ' the literal is swallowed and Enter selects the highlighted option, which on a permission dialog is the "1. Yes" that approves'
    + ' the pending command (measured). Answer it at the pane (`soma attach'
    + ` ${id}\`, or Escape there to decline — that also stops the turn), or pass --force after looking.`],
  ['dead_shell', (id, r) => `soma send: refused — ${id}'s pane is a bare ${r.cmd ?? 'shell'} shell, not claude: the message would execute as a shell`
    + ` command. The lead is gone: \`soma kill ${id}\`, then \`soma retry\` or \`soma resume\`. --force types anyway.`],
  ['dead_pane', (id) => `soma send: refused — ${id}'s pane is dead (claude exited; tmux keeps the death scene): send-keys would report success`
    + ` into a corpse. \`soma resume ${id}\`; --force types anyway.`],
  ['absent', (id) => `soma send: refused — ${id} has no pane on the soma tmux server; nothing to type into. \`soma resume ${id}\` if it`
    + ' should be running; --force tries anyway.'],
  ['unobservable', (id, r) => `soma send: refused — ${id}'s pane could not be read (${r.why ?? 'unknown cause'}), so this cannot rule out a`
    + ' permission dialog and nothing was typed. Retry, or pass --force after looking at the pane.'],
]);

export const USAGE = `usage: soma <command> [args]

  init [--seat <dir> | --inject-hook]   create the state tree, install /soma-promote, register the bus;
                              --seat does the install and registration into another config dir (a rotation seat) with THIS fleet's pins;
                              --inject-hook also registers the opt-in inject hook (UserPromptSubmit) in this config root's settings.json
  doctor                      run every environment check and report what it observed
  up [--canary] [--ignore-doctor]   open the queue: run doctor first (a FAIL refuses, unless --ignore-doctor),
                              then show worst-case spend, confirm, start the watchdog
  down                        stop the watchdog (running leads are NOT stopped)
  status                      one row per lead, plus queue, lease and watchdog health
  attach <lead>               attach to a lead's tmux pane (detach with C-b d)
  peek <lead> [--lines N]     read-only tail of a lead's pane
  send <lead> "<message>" [--force]   type a message into a lead's composer and submit it (refused while the pane shows a dialog, a shell or nothing readable)
  kill <lead> ["<reason>"]    kill a lead's session and mark its row failed
  resume <lead> [--force]     restart a dead lead from its recorded claude session
  retry <lead>                put a finished row back on the queue
  clear-trip <lead>           clear a lead's budget trip by granting one more allowance of its budget class
  enqueue --file <tasks.json> add tasks from a JSON array
  digest [--lines N]          the fleet's recent events, oldest first, consuming nothing
  watch [--interval N] [--all]   one stdout line per fleet event that needs the orchestrator (for Claude Code's Monitor tool); reads the orch cursor, consumes nothing
  thaw                        lift an org spend-cap freeze: clear state/backpressure.json (refuses a live rate-limit storm)

Mutating commands take --as <session_id>: soma then re-checks the orchestrator lease and
stamps its heartbeat, so driving the fleet from a shell does not lose the lease to staleness.
Without --as they act as the operator and say so. There is no "inbox" subcommand.

NOT IMPLEMENTED IN THIS BUILD (v1.x) — named because the ROADMAP, the design doc and
skills/soma-promote/SKILL.md all mention them, so typing one must not read as a typo:

  hold <lead>                 nothing reads leads/<id>/HOLD yet — see \`soma hold\`
  release <lead>              the other half of hold — see \`soma release\`
  gc                          no worktree/branch/log sweep yet
  up --canary                 the FLAG is answered, but it can never pass here: canary.mjs ships
                              the EVALUATION only and records its live driver as a v1.x gap, so
                              runCanary reports "unproven" and up refuses. The golden path on
                              this build is init -> doctor -> up, WITHOUT --canary.

!! \`soma release <lead>\` IS NOT \`soma_release\`. The MCP tool \`soma_release\` hands the
   ORCHESTRATOR LEASE back to the fleet. This CLI verb un-holds ONE LEAD, and is unimplemented.
   There is no CLI lease handback in v1: the lease passes to the next session that adopts, or
   becomes adoptable on its own once your heartbeat is 10 minutes old. Confusing the two in
   fallback mode unmounts a working orchestrator.

exit: 0 ok | 1 usage or declined | 2 this machine cannot run soma | 3 soma refused`;

/* ------------------------------------------------------------------- small pure helpers */

/** One line, whitespace collapsed. `send-keys` types the literal text and submits separately. */
const oneLine = (v) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))
  .replace(/\s+/g, ' ').trim();

const nonEmpty = (v) => typeof v === 'string' && v !== '';

/** One line of text for whatever was thrown. Must never throw — see `doctor.reason`. */
const reason = (e) => {
  try {
    const m = e?.message;
    if (nonEmpty(m)) return m;
    const s = String(e);
    return s === '' ? 'unknown error' : s;
  } catch {
    return 'unknown error';
  }
};

/** An epoch-ms stamp as ISO text an operator can read, or a phrase when the record carries none. */
const whenMs = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : 'an unknown time');

/**
 * Value of `--flag`: `undefined` when absent, `null` when present with nothing usable after it.
 *
 * Three states rather than two so `--as` with no value is a refusal instead of an anonymous
 * act, and `--lines` with no value falls back to the default instead of `Number(undefined)`.
 */
const flagValue = (rest, name) => {
  const i = rest.indexOf(name);
  if (i === -1) return undefined;
  const v = rest[i + 1];
  return v === undefined || v.startsWith('--') ? null : v;
};

/** Flags that consume the token after them, so `positionals` can skip it. */
const VALUE_FLAGS = new Set(['--as', '--lines', '--file', '--seat']);

/** Everything that is not a flag or a flag's value, in order. */
const positionals = (rest) => {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      if (VALUE_FLAGS.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
};

/** A positive integer count, or `fallback`. Bounded, because it becomes a tmux argument. */
const count = (raw, fallback, max) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(n, max);
};

/** The tmux session for a row: what the checkpoint recorded, else the derived name. */
const sessionOf = (row) => (nonEmpty(row?.tmux_session) && TMUX_NAME_RE.test(row.tmux_session)
  ? row.tmux_session
  : `lead-${row?.id}`);

/**
 * A session target soma spells into its OWN tmux argv, exact-match forced.
 *
 * tmux resolves a bare `-t <name>` by exact match, then *unambiguous prefix*, then fnmatch —
 * so with leads `lead-cr-1` … `lead-cr-10`, a bare `-t lead-cr-1` attaches the operator to
 * `lead-cr-10` once cr-1 has died. Only used for `attach`, whose argv this file builds;
 * `tmux.mjs`'s own functions apply their own (differently shaped) targets and must be handed
 * the bare name, or the prefix arrives doubled and tmux reports "can't find pane".
 */
const exactSession = (name) => `=${name}`;

const iso = (ts) => {
  try {
    return new Date(Number(ts)).toISOString();
  } catch {
    return String(ts);
  }
};

/** A payload on one line, bounded. The full record is in `events/<stream>.ndjson`. */
const summarise = (payload) => {
  let s;
  try {
    s = payload === undefined ? '' : JSON.stringify(payload);
  } catch {
    s = '(unserialisable payload)';
  }
  s = oneLine(s ?? '');
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
};

/* ----------------------------------------------------------------- the real dep wiring */

/**
 * Can this state root take a hard link? Asked once, at startup.
 *
 * `filelock.mjs` publishes every lock with `link(2)`, because an `O_EXCL` create makes the
 * name and the contents appear at two different instants and the gap was a real steal window.
 * On exFAT/FAT and some FUSE or cloud-sync mounts `link(2)` is unsupported — and then *every*
 * `withFleetLock` acquisition throws the same diagnosis, for the deployment's lifetime. One
 * refusal an operator can act on beats the same sentence every 30 s forever.
 *
 * The two failures are reported separately because the remedies differ: a root that cannot be
 * written at all is a permissions problem, not a filesystem-capability one. The scratch name
 * carries the pid so two concurrent `soma up`s cannot collide, and both files are removed in a
 * `finally` — this must leave nothing behind.
 */
const probeHardLinks = () => {
  const dir = p('state');
  const a = join(dir, `.linkprobe.${process.pid}`);
  const b = `${a}.link`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(a, '');
  } catch (e) {
    return { ok: false, code: e.code ?? 'unknown', dir, stage: 'write' };
  }
  try {
    linkSync(a, b);
    return { ok: true, code: null, dir, stage: 'link' };
  } catch (e) {
    return { ok: false, code: e.code ?? 'unknown', dir, stage: 'link' };
  } finally {
    try { unlinkSync(b); } catch { /* it may never have been created */ }
    try { unlinkSync(a); } catch { /* nor this, on a read-only root */ }
  }
};

/**
 * Copy `skills/soma-promote/` into the user's skills directory, then read it back.
 *
 * Resolved through `claudeConfigRoot()` rather than `~/.claude`, because `CLAUDE_CONFIG_DIR`
 * moves it and a skill installed under the wrong root is a `/soma-promote` that does not
 * exist — silently, since nothing errors. The read-back is the point: `cpSync` succeeding is
 * not evidence that `SKILL.md` arrived with its frontmatter, and a skill claude cannot parse
 * is a promotion path that is missing exactly when the operator reaches for it.
 */
const installSkill = (cfgRoot) => {
  const src = fileURLToPath(new URL('../skills/soma-promote/', import.meta.url));
  const dest = join(cfgRoot, 'skills', 'soma-promote');
  try {
    mkdirSync(join(cfgRoot, 'skills'), { recursive: true });
    cpSync(src, dest, { recursive: true });
    const body = readFileSync(join(dest, 'SKILL.md'), 'utf8');
    if (!body.includes('name: soma-promote')) {
      return { ok: false, dest, error: 'the copied SKILL.md carries no `name: soma-promote` frontmatter, so claude will not register it' };
    }
    return { ok: true, dest };
  } catch (e) {
    return { ok: false, dest, error: reason(e) };
  }
};

/**
 * Run a command and report its output and exit code instead of throwing.
 *
 * Same mapping as `tmux.defaultRun`, for the same reason: a non-zero exit is ordinary control
 * flow here (`claude mcp get soma` on a machine where nothing is registered), and the caller
 * needs the reason rather than a stack.
 *
 * `{env}` is the subprocess environment; `init --seat` passes the caller's with
 * `CLAUDE_CONFIG_DIR` replaced, and every other caller omits it.
 */
const capture = (cmd, args, { env } = {}) => {
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, env });
    return { stdout, stderr: '', code: 0 };
  } catch (e) {
    const stderr = e.stderr?.toString() || (e.signal ? `killed by ${e.signal}` : reason(e));
    return { stdout: e.stdout?.toString() ?? '', stderr, code: e.status ?? 1 };
  }
};

/** A synchronous pause with no dependency and no busy-wait. */
const napMs = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch { /* SharedArrayBuffer unavailable: fall through and spin once */ }
};

/**
 * Ask the operator, synchronously. `true`, `false`, or **`null` — "there was nobody to ask"**.
 *
 * Three states for the reason `soma_adopt`'s `holder_live` has three: "the operator said no"
 * and "there is no terminal here" are different facts, and treating the second as a yes turns
 * the spend gate into a warning that scrolls past inside a script. `up` refuses on `null`.
 *
 * Read a byte at a time off fd 0 rather than through `readline`, because every arm of this
 * file is synchronous and an async prompt would make the whole dispatcher's ordering — show
 * the projection, *then* ask, *then* start anything — depend on a promise nobody awaits.
 * An empty line is not consent: the operator types the word.
 */
const confirm = (question) => {
  if (!process.stdin.isTTY) return null;
  try {
    process.stdout.write(question);
  } catch {
    return null;
  }
  const buf = Buffer.alloc(256);
  let seen = '';
  for (;;) {
    let n;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      // A non-blocking tty answers EAGAIN until a key arrives; anything else means the
      // terminal went away mid-question, which is "nobody to ask", not "yes".
      if (e.code === 'EAGAIN') { napMs(20); continue; }
      return null;
    }
    if (n === 0) break;                       // EOF: the pipe closed without an answer
    seen += buf.toString('utf8', 0, n);
    if (seen.includes('\n')) break;
  }
  const a = seen.trim().toLowerCase();
  return a === 'y' || a === 'yes';
};

/** The canary's live driver on this build: not built, and it says so rather than probing anything. */
const liveDriverNotBuilt = async () => {
  throw new Error('the live driver is not built on this build — canary.mjs ships the evaluation only (a declared v1.x gap)');
};

/**
 * The real wiring for every guarded dep.
 *
 * Every tmux and spawner call is wrapped in a fixed-arity arrow rather than passed by
 * reference, the same care `soma-bus.mjs` takes over `resumeLead`: these functions take an
 * optional second argument that is their *transport* or their *whole dep set*, and a caller
 * that forwarded an extra argument by accident would silently replace it.
 */
export const realDeps = () => ({
  liveSessions: () => tmux.liveSessions(),
  // Asked only about a `null` from `liveSessions`, by `status`, `down` and `up` — see `stopper`, and
  // `up`'s refusal for why it never acts on the answer alone.
  serverAbsent: () => tmux.serverAbsent(),
  // Asked only by `up`, and only when `serverAbsent` said "no server": is a tmux for soma's socket
  // still alive anyway? The socket is the module's own, so it is the one every other call talks to.
  serverProcesses: () => tmux.serverProcesses(),
  paneStates: () => tmux.paneStates(),
  newSession: (spec) => tmux.newSession(spec),
  killSession: (name) => tmux.killSession(name),
  sendKeys: (target, text) => tmux.sendKeys(target, text),
  capturePane: (target, lines) => tmux.capturePane(target, lines),
  // The options object THIRD, `undefined` second: the second position is the spawner's own dep
  // set, and `resumeLead(task, {configDir})` would silently replace it (soma-bus.mjs's warning).
  resumeLead: (task, opts = {}) => resumeLead(task, undefined, opts),
  // `stdio: 'inherit'` and no timeout: this is `tmux attach`, which is meant to block until
  // the operator detaches. It is the only arm that hands the terminal over.
  exec: (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' }),
  capture,
  doctor: () => runDoctor(),
  // The live driver is not built: `canary.mjs` ships the EVALUATION only and its header records
  // the driver as a declared v1.x gap. So `up` hands `runCanary` a driver that says exactly that,
  // the canary reports what is true — ERROR, nothing proven — on stderr, and `up` refuses on it
  // with exit 3. Not `runCanary()` with no driver at all: that is `probeCanary`'s TypeError for a
  // caller that forgot one, which is a wiring bug, and it reached the operator as a crash, exit 2.
  canary: () => runCanary(liveDriverNotBuilt),
  confirm,
  linkProbe: probeHardLinks,
  installSkill,
  // Writes the operator's own settings.json, and only `init --inject-hook` resolves it. Its one
  // argument is the whole option set, so a forwarded extra argument could only ever be dropped.
  installInjectHook: (opts) => installInjectHook(opts),
});

/* ------------------------------------------------------------------------- the dispatcher */

/**
 * Resolve a guarded dep or refuse by name.
 *
 * A TypeError rather than a printed refusal: a missing dep is a wiring bug in the caller, not
 * a fleet state, and the loud cheap version of it is a message naming the absentee.
 */
const need = (d, name, cmd) => {
  const fn = d?.[name];
  if (typeof fn !== 'function') {
    throw new TypeError(
      `soma ${cmd}: dependency "${name}" is missing or is not a function.`
      + ` The guarded deps (${GUARDED_DEPS.join(', ')}) have no defaults on purpose:`
      + ' completing them from the real wiring would let a caller that forgot one start a real'
      + ' tmux session, register an MCP server in the operator\'s own ~/.claude.json, spawn a'
      + ' real claude, or block on a terminal. Pass realDeps(), or the stub this arm needs.',
    );
  }
  return fn;
};

/**
 * `dispatch(argv, deps)` — the whole CLI. Returns the process exit code.
 *
 * `deps` is effect injection, not configuration: every arm's observable behaviour is a
 * function of what these report. The unguarded ones below are defaulted because their real
 * implementations read or write only under `$SOMA_HOME` (which the suite retargets to a
 * throwaway directory) or are pure.
 */
export async function dispatch(argv, deps = {}) {
  const d = {
    print: (s) => process.stdout.write(`${s}\n`),
    warn: (s) => process.stderr.write(`${s}\n`),
    loadConfig,
    readFleet,
    enqueue: fleetEnqueue,
    setTaskStatus,
    readUsage,
    readLease,
    heartbeat,
    appendEvent,
    readEvents,
    queuePaused,
    // Unguarded: it reads soma.json and state/seats.json under $SOMA_HOME and nothing else.
    seatsSummary,
    // The freeze record, through the module that owns it — the same reader `soma_status` wires, and
    // the same clearer `soma thaw` is for. Unguarded: both touch only state/ under $SOMA_HOME.
    backpressureState: readBackpressure,
    clearBackpressure,
    // The one guarded function that clears a budget trip, shared with the bus's `soma_clear_trip`.
    // Unguarded: it writes the checkpoint through the `updateFleet` it is handed and removes two
    // flags under `leads/<id>/`, all under $SOMA_HOME.
    clearTrip,
    projectFleetSpend,
    readFile: (f) => readFileSync(f, 'utf8'),
    // Unguarded on purpose, like `setTaskStatus` and `enqueue`: `pickSeat` reads soma.json and
    // state/seats.json and writes nothing; `updateFleet` writes the checkpoint under $SOMA_HOME
    // and nothing outside it. Neither can start a session or touch the operator's own config.
    pickSeat,
    updateFleet,
    env: process.env,
    ...deps,
  };
  const [cmd, ...rest] = Array.isArray(argv) ? argv : [];
  const N = (name) => need(d, name, cmd ?? '<no command>');

  /* --------------------------------------------------------------- shared arm helpers */

  /**
   * `ensureTree()`, turned into one stderr line and a non-zero exit.
   *
   * `paths.ensureTree` throws rather than exiting, because a library that killed the process
   * would be untestable and would take the test runner with it. Turning that throw into a
   * diagnosis is this file's job, and the message is printed verbatim: the relative-`SOMA_HOME`
   * refusal carries its whole explanation in the text because it is a backstop a correct
   * launch never reaches, so when it fires there is no second chance to explain itself.
   */
  const tree = () => {
    try {
      ensureTree();
      return null;
    } catch (e) {
      d.warn(`soma: ${reason(e)}`);
      return ENV;
    }
  };

  /** The hard-link preflight, or a refusal naming the volume that failed and why. */
  const links = () => {
    const r = N('linkProbe')();
    if (r?.ok === true) return null;
    const dir = r?.dir ?? '<the state directory>';
    const code = r?.code ?? 'unknown';
    if (r?.stage === 'write') {
      d.warn(`soma: the state directory ${dir} could not be written (${code}) — soma keeps the`
        + ' fleet checkpoint, its lock, the lease and every heartbeat there. Fix the permissions,'
        + ' or set SOMA_HOME to a writable absolute path.');
    } else {
      d.warn(`soma: ${dir} does not support hard links (link(2) returned ${code}). Every`
        + ' fleet.lock acquisition publishes the lock with link(2), so mutual exclusion cannot'
        + ' work on this volume and the watchdog would print this same diagnosis on every 30 s'
        + ' tick for the life of the deployment. exFAT/FAT and some FUSE or cloud-sync mounts do'
        + ' not support hard links — move SOMA_HOME off this volume.');
    }
    return ENV;
  };

  /** The checkpoint, or a refusal. A corrupt `fleet.json` is repairable and must stay loud. */
  const fleetOf = () => {
    try {
      const f = d.readFleet();
      return { fleet: { tasks: [], ...(f ?? {}) } };
    } catch (e) {
      d.warn(`soma: the fleet checkpoint could not be read: ${reason(e)}`);
      return { code: ENV };
    }
  };

  /** One row by id, or null. */
  const rowOf = (fleet, id) => (Array.isArray(fleet?.tasks) ? fleet.tasks.find((t) => t?.id === id) : undefined) ?? null;

  const badId = (id) => {
    if (!nonEmpty(id)) {
      d.warn(`soma ${cmd}: needs a task id, like "task-42" — lowercase letters, digits and dashes.`);
      return true;
    }
    if (!LEAD_RE.test(id)) {
      d.warn(`soma ${cmd}: ${JSON.stringify(id)} is not a task id. Ids are lowercase letters,`
        + ' digits and dashes, starting with a letter — they become directory names, a tmux'
        + ' target and an event stream, so nothing else is admitted.');
      return true;
    }
    return false;
  };

  /**
   * Who is acting, and whether they may.
   *
   * `skills/soma-promote/SKILL.md` §6 is the contract: mutating subcommands take
   * `--as <session_id>` and re-check the lease; a bare human invocation says "acting as
   * operator" instead of refusing. The heartbeat stamp is the part that is easy to miss and
   * costly to omit — the lease reads stale after 10 minutes without one, and a stale lease is
   * adoptable by the next session *without* force, so an orchestrator driving the fleet from a
   * shell would lose it silently while working.
   */
  const actor = () => {
    const as = flagValue(rest, '--as');
    if (as === undefined) {
      return { ok: true, as: null, note: 'acting as operator (no --as, so the orchestrator lease was not consulted)' };
    }
    if (as === null) {
      return { ok: false, message: `soma ${cmd}: --as needs a session id — the one in ${p('state', 'orch.lease')}. Omit --as entirely to act as the operator.` };
    }
    let lease;
    try {
      lease = d.readLease();
    } catch (e) {
      return { ok: false, message: `soma ${cmd}: the orchestrator lease could not be read (${reason(e)}), so --as ${as} cannot be checked.` };
    }
    if (!lease) {
      return { ok: false, message: `soma ${cmd}: --as ${as} was given, but this fleet has no orchestrator lease at all. Promote a session with /soma:promote, or omit --as to act as the operator.` };
    }
    if (lease.session_id !== as) {
      return { ok: false, message: `soma ${cmd}: ${as} does not hold the orchestrator lease — ${lease.session_id} does (seq ${lease.lease_seq ?? '?'}). A session that was demoted may not act on the fleet: re-adopt with soma_adopt, or omit --as to act as the operator.` };
    }
    return { ok: true, as, note: `acting as orchestrator ${as} (lease seq ${lease.lease_seq ?? '?'})` };
  };

  /** Append to the orchestrator's stream. Never throws: the arm's work already happened. */
  const logOrch = (event) => {
    try {
      d.appendEvent(ORCH_STREAM, event);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * The pause flag, read through its one home — and with THREE answers, not two.
   *
   * `null` means "the flag could not be read", and it is deliberately not folded into `false`:
   * "admission is open" is a claim about the fleet, and an unreadable state root is not evidence
   * for it. One helper rather than a copy per arm because rule 3 is this file's rule — `up`
   * reads this on BOTH its paths and `status` on its own, and a second spelling would let two
   * verbs disagree about the same file. `queue.queuePaused` is the only reader.
   */
  const pausedFlag = () => {
    try {
      return { paused: d.queuePaused() === true, why: null };
    } catch (e) {
      return { paused: null, why: reason(e) };
    }
  };

  /**
   * Stop a tmux session and report WHICH of four things happened — never a bare boolean.
   *
   * `tmux.killSession` is `run([...]).code === 0`, and `tmux.defaultRun` **never throws**: a
   * missing binary, a wrong `SOMA_TMUX_SOCKET` and its own 5 s `SIGKILL` timeout all map to
   * `{code: 1}`. So a `false` from `killSession` conflates *"there was no such session"* with
   * *"tmux could not be reached at all"* — and a `try/catch` wrapped around the call is
   * unreachable, because the third state is structurally impossible to observe from the boolean.
   *
   * Read as the first, the second is destructive in the one direction that matters. `kill` marks
   * a possibly-live lead `failed` and exits 0, so the operator believes the lead is dead and
   * stops watching it while a real `claude` keeps burning tokens on its worktree; `down` reports
   * the fleet stopped while the watchdog may still be spawning, reviving, metering and reaping.
   * That is rule 2 inverted, in the file whose header makes it a rule.
   *
   * So the `false` is disambiguated by the one primitive that can tell the two apart —
   * `liveSessions`, which answers `null` for "not measured". Nothing new is invented here: that
   * is the same third state `status`'s `?`, `up`'s UNVERIFIED refusal and `resume`'s "could not
   * be measured" already read off the same dep, and `send`'s three outcomes forty lines away.
   *
   *   `killed`      tmux exited 0 on kill-session: the session existed and is gone.
   *   `absent`      no kill was needed, and tmux was READ BACK and reports nothing by that
   *                 name — the state the caller asked for, verified rather than assumed. For a
   *                 caller that opts in (below), also: tmux could list nothing because, in its
   *                 own words, no server answers on the socket at all (`noServer: true`).
   *   `live`        the kill did not take: tmux answered and the session is STILL there.
   *   `unmeasured`  tmux would not answer, or answered a listing soma could not parse, so
   *                 NEITHER claim can be made. Without the opt-in, that includes "no server
   *                 answers on the socket".
   *
   * The opt-in is `serverAbsent`, and only `down` passes it. A machine that has never run `soma up`
   * has no tmux server, so no watchdog session, and `down` writes nothing on that reading: it
   * reports, and `soma down && …` must not break on the most ordinary machine there is. `kill`
   * stays out, because its answer to `absent` is a `failed` row — and tmux's no-server sentences
   * are also what a LIVE server answers once its socket file has been deleted, or, on macOS, once
   * a wedged server's accept queue has overflowed (`tmux.serverAbsent`; RUNBOOK §11.10). A
   * `failed` row over a live lead is exactly the destructive case above.
   *
   * Both deps are resolved before anything runs — and `down` resolves `serverAbsent` before it
   * calls this — for the reason every arm resolves early: `need`'s TypeError is a wiring bug in
   * the caller, and a caller that had already printed or written something would be reporting it
   * as a fleet state.
   */
  const stopper = ({ serverAbsent = null } = {}) => {
    const killSession = N('killSession');
    const liveSessions = N('liveSessions');
    return (name) => {
      let killed = false;
      let threw = null;
      try {
        killed = killSession(name) === true;
      } catch (e) {
        threw = e;
      }
      if (killed) return { state: 'killed', why: null };
      // Not an answer yet. A throw and a `false` carry the same amount of knowledge about the
      // SESSION — none — so both go on to ask the server what is actually there.
      const after = liveSessions();
      const why = threw ? `the kill-session call threw: ${reason(threw)}` : null;
      if (after === null) {
        // Asked only about a `null`, and only when the caller opted in: a listing tmux answered
        // is never second-guessed by the probe.
        if (serverAbsent !== null && serverAbsent() === true) return { state: 'absent', why, noServer: true };
        return { state: 'unmeasured', why: why ?? 'tmux could not be read back' };
      }
      if (after.has(name)) return { state: 'live', why };
      return { state: 'absent', why };
    };
  };

  /* ------------------------------------------------------------------------- the arms */

  switch (cmd) {
    case undefined:
    case '':
      d.print(USAGE);
      return USAGE_CODE;

    case 'help':
    case '--help':
    case '-h':
      d.print(USAGE);
      return OK;

    case 'status': {
      const got = fleetOf();
      if (got.code) return got.code;
      const { fleet } = got;
      const serverAbsent = N('serverAbsent');
      const listed = N('liveSessions')();
      // Three states, never two. `liveSessions` answers `null` when tmux could not be read — a
      // 5 s timeout on a wedged server is byte-identical to a healthy server with nothing on it,
      // and a listing with no row soma can parse names no session (#45) — and rendering that as
      // "dead" would report ten working leads as gone.
      //
      // ONE kind of `null` is asked about again, here, in `down` and in `up`: tmux's own words
      // for "no server answers on this socket" (`tmux.serverAbsent`), which is what a machine
      // that has never run `soma up` answers. `up` asks only to decide whether to look for a live
      // tmux process for the socket, and never starts a server on that answer alone. Here, no
      // server answering, no sessions to list — so that reading is an EMPTY server, not an
      // unmeasured one: the watchdog absent, a spawned row `dead`, every pane `gone`. Every other
      // `null` (a timeout, a missing binary, a permission error, a listing with no row soma can
      // parse) stays `?`. This report writes nothing on the answer, and reconcile never asks:
      // `tmux.serverAbsent` says why, and RUNBOOK §11.10 declares the two states in which a live
      // server gives the same answer.
      const noServer = listed === null && serverAbsent() === true;
      const live = noServer ? new Set() : listed;
      const liveOf = (name) => (live === null ? '?' : live.has(name) ? 'yes' : 'dead');
      // A lead's LIVE cell, which has a fourth word: `starting`, for a row a spawn has claimed and
      // not yet given its session. The claim comes first and the session last, after a fetch allowed
      // two minutes, and for that whole window the row read `spawned  dead  gone` — a dead lead, to an
      // operator deciding what to kill. `launching` is the predicate the watchdog's reconcile and
      // `soma_status` read too, so this cell judges a row by the rule that decides its revival. The
      // session beats the mark, and `?` beats both: an unread tmux is never a launch.
      const now = Date.now();
      const leadLiveOf = (t) => {
        const cell = liveOf(sessionOf(t));
        return cell === 'dead' && launching(t, now) ? 'starting' : cell;
      };

      // The pane census (added after leads were found stalled on prompts nobody saw), for every
      // row that has a session — `done` and `blocked` rows included, because that is where a
      // 38-hour permission dialog and two tmux-resurrect shells sat unseen. One listing, then one
      // screen capture per live non-shell pane (measured ~4 ms each). Resolved before anything is
      // printed, like every guarded dep in this arm.
      const paneStates = N('paneStates');
      const capturePane = N('capturePane');
      // No server answering, no panes to list: the census takes an empty listing instead of asking
      // tmux again, so the PANE column and the LIVE column describe one reading.
      const panes = noServer ? new Map() : paneStates();
      const withSession = fleet.tasks.filter((t) => nonEmpty(t?.id) && t.status !== 'queued');
      const census = panes === null || panes === undefined
        ? null
        : takeCensus(withSession.map((t) => ({ id: t.id, name: sessionOf(t) })),
          { panes, capture: (name, n) => capturePane(name, n), now: () => Date.now(), lines: CENSUS_LINES });
      const paneOf = (t, starting = false) => {
        if (t?.status === 'queued') return '-';
        if (census === null) return '?';
        const fine = census.get(t?.id)?.fine;
        // A lead still starting has no pane YET, which is `-` (a row that never had a session), not
        // `gone`. Only while the census agrees: a pane it already sees is shown as itself, because the
        // session can appear between the liveness read and this one.
        if (starting && fine === 'absent') return '-';
        return PANE_TOKEN.get(fine) ?? '?';
      };

      d.print(`state root: ${SOMA_HOME()}`);
      // Read once, above the queue line, because that line needs it too.
      const wd = liveOf(WATCHDOG);
      // Three states through the flag's one reader. An unreadable flag used to render as
      // `queue: open` — a two-state collapse in the file that insists on three everywhere else,
      // and the collapse fell on the side of the reassuring answer.
      //
      // And `open` is the FLAG's reading, which is not the whole answer to "is anything being
      // admitted?": admission is the watchdog's tick. A bare `open` before `soma up` had ever run
      // contradicted the help line that says `up` opens the queue — each right by its own lights —
      // so `open` stands alone only beside a live watchdog, and otherwise says what is, or is not
      // known to be, acting on it. PAUSED and unreadable describe the flag and are unchanged.
      const q = pausedFlag();
      const openNote = wd === 'yes'
        ? ''
        : wd === '?'
          ? ' (tmux could not be read, so whether any watchdog is admitting work is unknown)'
          : ' (no watchdog is running, so nothing is admitted until `soma up`)';
      d.print(`queue: ${q.paused === true
        ? 'PAUSED — admission is frozen (soma_queue resume re-opens it)'
        : q.paused === false
          ? `open${openNote}`
          : `unreadable — the pause flag under ${p('state')} could not be read (${q.why}), so this`
            + ' is NOT a claim that admission is open. `soma doctor` diagnoses the state root.'}`);

      // The freeze beside the pause, three-state through the one reader `soma_status` uses — the
      // record `wd/backpressure.mjs` writes under the fleet lock, or the fact that it could not be
      // read. "none" is a claim about the fleet, and an unreadable record is not evidence for it.
      let bp;
      try {
        bp = d.backpressureState() ?? { active: false };
      } catch (e) {
        bp = { active: false, unreadable: true, why: reason(e) };
      }
      d.print(bp.unreadable === true
        ? `backpressure: unreadable — state/backpressure.json under ${p('state')} could not be read (${bp.why ?? 'no reason given'}), so`
          + ' this is NOT a claim that admission is open. `soma doctor` diagnoses the state root; fix or delete the file by hand.'
        : bp.active === true
          ? `backpressure: FROZEN — admission is held (${bp.reason ?? 'no reason recorded'}, since ${whenMs(bp.since)},`
            // `until` is DESCRIPTIVE: nothing in `bin/` compares it to a clock, so a stated end that
            // has passed is not a freeze that lifted. Said here, because the reading an operator
            // would otherwise take from a past timestamp is the reassuring one — that it expired
            // itself — and the fleet would stay stalled while they waited for it to.
            + ` ${Number.isFinite(bp.until)
              ? `until ${whenMs(bp.until)}${bp.until < Date.now() ? ' — that end has PASSED, and nothing expires a record by its own clock' : ''}`
              : 'no known end'}). `
            + (bp.reason === STORM_REASON
              ? 'A storm clears itself once fewer than two leads still hold a live usage-limit hit.'
              : 'A spend-cap record holds until `soma thaw` clears it — nothing inside the fleet lifts it.')
          : 'backpressure: none');

      // ONE line, three states — and the third comes from a variable of its own rather than from
      // `lease` staying null. `readLease` THROWS on EACCES/EIO and returns `null` only for the
      // genuinely-released state, so a catch that left `lease` at `null` then fell into the
      // `=== null` arm and printed BOTH "unreadable lease" and "none — nothing is dispatching
      // work". Two lines that disagree are worse than one wrong line: the operator cannot tell
      // which to trust, and the false one is the actionable-looking one.
      let lease = null;
      let leaseErr = null;
      try {
        lease = d.readLease();
      } catch (e) {
        leaseErr = e;
      }
      if (leaseErr) {
        d.print(`orchestrator: UNREADABLE lease (${reason(leaseErr)}) — soma cannot tell whether a`
          + ' session holds it, so this is not "none". `soma doctor` diagnoses the state root.');
      } else if (lease) {
        const age = Number.isFinite(lease.heartbeat_at) ? `${Math.round((Date.now() - lease.heartbeat_at) / 1000)}s ago` : 'never stamped';
        d.print(`orchestrator: ${lease.session_id} (seq ${lease.lease_seq ?? '?'}, wake ${lease.wake ?? '?'}, heartbeat ${age})`);
      } else {
        d.print('orchestrator: none — no session holds the lease, so nothing is dispatching work');
      }

      // An absence for want of a server says so, naming the socket by its one spelling: on a
      // machine that runs two fleets, "no server on soma_pers" and "no server on soma" are
      // different facts.
      d.print(wd === 'yes'
        ? `watchdog: live (tmux session ${WATCHDOG})`
        : wd === '?'
          ? `watchdog: unverified — tmux could not be read, so its state is unknown here`
          : `watchdog: absent — ${noServer ? `no tmux server answers on socket ${tmux.socketName()}, so ` : ''}`
            + 'nothing spawns, revives, meters or drains without it. Run `soma up`.');

      // The seat pool (account rotation, spec §3.6): ONE line, three states, through the one
      // reader the bus also uses. The catch is the third state, not a fallback to "open".
      let seats;
      try {
        seats = d.seatsSummary();
      } catch (e) {
        seats = { unreadable: true, why: reason(e) };
      }
      d.print(seatsLine(seats));

      d.print('');
      // LIVE is as wide as its longest word, `starting`, so every column after it stays under its header.
      d.print(`${'LEAD'.padEnd(20)} ${'STATUS'.padEnd(8)} ${'LIVE'.padEnd(8)} ${'PANE'.padEnd(8)} ${'SEAT'.padEnd(10)} ${'TURNS'.padEnd(6)} ${'TOKENS'.padEnd(12)} MODEL`);
      const counts = Object.create(null);
      let onPrompt = 0;
      let onShell = 0;
      for (const t of fleet.tasks) {
        const status = String(t?.status ?? '?');
        counts[status] = (counts[status] ?? 0) + 1;
        const liveCol = ANSWERABLE.has(status) ? leadLiveOf(t) : '-';
        const paneCol = paneOf(t, liveCol === 'starting');
        if (paneCol === 'prompt') onPrompt += 1;
        if (paneCol === 'shell') onShell += 1;
        let u = {};
        if (nonEmpty(t?.lead_session_uuid)) {
          try {
            u = d.readUsage(t.lead_session_uuid) ?? {};
          } catch { u = {}; }
        }
        // The seat the lead runs under (its `soma.json` label); `-` for a row spawned before
        // seats existed, with none configured, or hand-edited to something that is not a string.
        const seatCol = nonEmpty(t?.seat) ? t.seat : '-';
        d.print(`${String(t?.id ?? '?').padEnd(20)} ${status.padEnd(8)} ${liveCol.padEnd(8)} ${paneCol.padEnd(8)} ${seatCol.padEnd(10)}`
          + ` ${String(u.turns ?? '-').padEnd(6)} ${String(u.est_tokens ?? '-').padEnd(12)} ${u.last_model ?? '-'}`);
      }
      if (fleet.tasks.length === 0) d.print('(no tasks — `soma enqueue --file <tasks.json>`)');
      d.print('');
      d.print(['queued', 'spawned', 'blocked', 'done', 'failed', 'skipped']
        .map((s) => `${s} ${counts[s] ?? 0}`).join(' · '));
      if (onPrompt > 0 || onShell > 0) {
        d.print(`panes needing a human: ${onPrompt} on a dialog (permission, trust or a question) · ${onShell} bare shell — \`soma attach <lead>\` to`
          + ' answer or `soma kill <lead>` to clear; never `soma send` them (the Enter answers the dialog blind, the shell executes the text).');
      }
      return OK;
    }

    case 'enqueue': {
      const file = flagValue(rest, '--file');
      if (file === undefined || file === null) {
        d.warn('soma enqueue: --file <tasks.json> is required — a JSON array of task objects,'
          + ' each with at least an id.');
        return USAGE_CODE;
      }
      let raw;
      try {
        raw = d.readFile(file);
      } catch (e) {
        d.warn(`soma enqueue: ${file} could not be read: ${reason(e)}`);
        return ENV;
      }
      let tasks;
      try {
        tasks = JSON.parse(raw);
      } catch (e) {
        d.warn(`soma enqueue: ${file} is not valid JSON: ${reason(e)}`);
        return USAGE_CODE;
      }
      // Refused here rather than in `fleet.enqueue`, whose TypeError would reach the operator
      // as a stack. An object of tasks keyed by id is the likely mistake, and it is worth naming.
      if (!Array.isArray(tasks)) {
        d.warn(`soma enqueue: ${file} must contain a JSON array of tasks, got`
          + ` ${tasks === null ? 'null' : typeof tasks}.`);
        return USAGE_CODE;
      }
      // soma.json is read once, for two uses. Its repo names and budget classes are what the
      // intake check below judges rows against, and the repo map goes with the tasks, because
      // `fleet.enqueue` never reads soma.json and a task with no `verify_hint` of its own takes
      // its repo's. A soma.json that will not load costs that fallback and those two checks, said
      // out loud; it does not hold up the queue, and a task's own hint never depended on it.
      let cfg = null;
      try {
        cfg = d.loadConfig();
      } catch (e) {
        d.warn(`soma enqueue: soma.json could not be read (${oneLine(reason(e))}), so no repo verify_hint was applied (tasks keep only their own) and no repo or budget_class was checked.`);
      }
      // The check `soma_enqueue` applies, from the same function, so the two doors into the queue
      // cannot disagree about a row: the reserved id `orch`, the brief cap, and a repo or a
      // budget_class soma.json does not define. A refused row never reaches `fleet.enqueue`, and
      // when every row was refused it is not called at all, so the checkpoint is not rewritten.
      const checked = intake(tasks, cfg);
      let r = null;
      if (checked.accepted.length) {
        try {
          r = d.enqueue(checked.accepted, { repos: cfg?.repos });
        } catch (e) {
          d.warn(`soma enqueue: ${reason(e)}`);
          return ENV;
        }
      }
      const queued = Array.isArray(r?.queued) ? r.queued : [];
      const skipped = [...(Array.isArray(r?.skipped) ? r.skipped : []), ...checked.rejected];
      d.print(`queued ${queued.length}${queued.length ? `: ${queued.join(', ')}` : ''}`);
      // The drops are reported, always: the intake check's, and `fleet.enqueue`'s invalid or
      // duplicate ids, each skipped rather than thrown on so one bad row does not cost the other
      // twenty-nine. "enqueued 30" when four were dropped is how a fleet quietly runs short.
      if (skipped.length) {
        d.print(`skipped ${skipped.length}:`);
        for (const s of skipped) d.print(`  ${s?.id ?? '(no id)'} — ${s?.reason ?? 'unknown'}`);
      }
      // The bus's hint, one line each, printed only beside a refusal it explains.
      if (checked.known_repos) d.print(`known repos: ${checked.known_repos.join(', ')}`);
      if (checked.known_budget_classes) d.print(`known budget classes: ${checked.known_budget_classes.join(', ')}`);
      // Rows were offered and none was taken: the fleet is unchanged, so the exit code says so.
      // `queued 0` beside a zero exit is how a plan of thirty duplicate ids reads as a success.
      if (queued.length === 0 && tasks.length > 0) {
        d.warn(`soma enqueue: nothing was queued — all ${tasks.length} row(s) in ${file} were skipped. The fleet is unchanged.`);
        return REFUSED;
      }
      return OK;
    }

    case 'up': {
      const t = tree();
      if (t) return t;
      const l = links();
      if (l) return l;

      // Resolved before anything is read or printed, as in every arm: both are asked only about a
      // `null` listing below, and a missing one is a wiring bug, never a fleet state.
      const serverAbsent = N('serverAbsent');
      const serverProcesses = N('serverProcesses');
      const live0 = N('liveSessions')();
      if (live0 !== null && live0.has(WATCHDOG)) {
        d.print(`watchdog: live already (tmux session ${WATCHDOG}) — nothing was started and no new`
          + ' spend was authorised.');
        // SOMA.JSON IS READ ON THIS PATH TOO, for the reason the pause flag is (below): a live
        // watchdog is not an open queue. It loads the same file at the top of every tick, so a file
        // the loader refuses — one that does not parse, a `seats` that is not an array — throws
        // there on every tick, which logs WATCHDOG_ERROR and admits nothing. This path used to
        // return without reading it and print "the queue is already open" over exactly that, while
        // a fresh `up` on the same file exits 2 naming the key (#53). Same loader, same exit.
        try {
          d.loadConfig();
        } catch (e) {
          d.warn(`soma up: ${reason(e)} — the watchdog already running loads this same soma.json at`
            + ' the start of every tick and is refusing it too, so it admits nothing (and revives and'
            + ' meters nothing) until the file is fixed: the queue is NOT open. Fix soma.json (`soma'
            + ' doctor` reads it too); the running watchdog takes the fix on its next tick, with no'
            + ' restart, and until then `soma digest` shows its WATCHDOG_ERROR on every one.');
          return ENV;
        }
        // THE PAUSE FLAG IS READ ON THIS PATH TOO, and that is what this line is for. A LIVE
        // WATCHDOG IS NOT AN OPEN QUEUE: the flag has one home (`queue.queuePaused`), it survives
        // `soma down` and back up on purpose — a paused queue must stay paused across a restart,
        // or the pause belongs to one watchdog process rather than to the fleet — and admission
        // vetoes on it every tick. This early return used to claim "the queue is already open"
        // without reading it, which made the operator's most likely `up` ("is the fleet
        // running?") the one invocation that lied. The check existed 90 lines below, on the
        // fresh-start path only; rule 3 says the flag gets one spelling, not one path.
        const q = pausedFlag();
        d.print(q.paused === true
          ? 'the queue is PAUSED — the watchdog is live, but admission stays frozen and nothing is'
            + ' being admitted. Clear it with `soma_queue resume` from the orchestrator.'
          : q.paused === false
            ? 'the queue is already open — the watchdog drains it on every tick.'
            : `the queue's pause flag could not be read (${q.why}), so whether admission is open is`
              + ' UNKNOWN here rather than open. `soma doctor` diagnoses the state root.');
        if (rest.includes('--canary')) {
          if ((await N('canary')()) !== true) {
            d.warn(canaryRefusal({ live: true }));
            return REFUSED;
          }
          d.print('canary: pass');
        }
        return OK;
      }

      // NOT MEASURED IS NOT "NOT RUNNING" (#66). The check above counts only a listing that HAS the
      // watchdog, so a `null` — tmux could not be read — used to fall through to here as if none ran:
      // the projection, the prompt, and on a yes a watchdog started beside one tmux could not show.
      // So a `null` refuses, before anything is projected or asked, with ONE exception: tmux's own
      // words for "no server answers on this socket" (`tmux.serverAbsent`), which is where every
      // machine stands before its first `up`.
      if (live0 === null) {
        const sock = tmux.socketName();
        if (serverAbsent() !== true) {
          d.warn(`soma up: tmux could not be read on socket ${sock}, so whether a watchdog is already`
            + ' running is UNKNOWN — and soma will not start one on that: a watchdog started beside one'
            + ' it cannot see supervises the same fleet twice. Nothing was projected, asked or started.'
            + ' `soma status` shows what tmux does answer (`?` where it could not be read), `soma doctor`'
            + ' checks that tmux is reachable at all, and RUNBOOK §11.10 covers a live server tmux cannot'
            + ' reach.');
          return REFUSED;
        }
        // Even that sentence is not proof. RUNBOOK §11.10 measured two LIVE servers that say it — one
        // whose socket file was deleted while it ran, one wedged until its accept queue overflowed —
        // and a `new-session` in either starts a SECOND server on the same path, beside the first and
        // its running leads. A process is what tells those from a server that is really gone, so look
        // for a live tmux for this socket before starting one: the check §11.10 used to leave to the
        // operator. Three answers, and only "none" goes on to the fresh start below.
        const pids = serverProcesses();
        if (pids === null) {
          d.warn(`soma up: no tmux server answers on socket ${sock}, and the process table could not be`
            + ' read, so soma cannot tell a server that is really gone from a live one that answers the'
            + ' same way — its socket file deleted, or wedged (RUNBOOK §11.10) — and it will not start'
            + ' a watchdog on that. Nothing was projected, asked or started. Look yourself for a live'
            + ` \`tmux -L ${sock}\` process run by your own user (\`ps -axo pid,user,command\`; another`
            + ' user\'s is another socket); `soma up` refuses this way until it can read the process table.');
          return REFUSED;
        }
        if (pids.length > 0) {
          d.warn(`soma up: no tmux server answers on socket ${sock}, but a tmux process for that socket is`
            + ` still alive (pid ${pids.join(', ')}), so this is not a machine with no server, and soma`
            + ' will not start one. RUNBOOK §11.10 measured two LIVE servers that answer exactly so: one'
            + ' whose socket file was deleted while it ran (a /tmp cleaner), and one wedged until its'
            + ' accept queue overflowed. A new server would sit beside the first, and its watchdog would'
            + ' find none of the first one\'s leads and respawn them onto the same worktrees. Recover the'
            + ' first: `kill -USR1 <pid>` makes a server whose socket file was deleted recreate it, and'
            + ' `kill -CONT <pid>` resumes a stopped one; then `soma status`, and `soma up` only if it'
            + ' reads no watchdog. Nothing was projected, asked or started.');
          return REFUSED;
        }
      }

      let cfg;
      try {
        cfg = d.loadConfig();
      } catch (e) {
        d.warn(`soma up: ${reason(e)}`);
        return ENV;
      }
      // Doctor is the preflight the design puts in front of the queue, and it runs here: after
      // `loadConfig`, so a refused soma.json keeps its exit 2 and its own sentence, and before
      // the projection, so nobody is asked to approve spend on a machine that failed a check.
      // Not on the already-live path above, which opens nothing and authorises no spend.
      // INCOMPLETE goes on: `runDoctor` resolves `true` for it, and PASS is unreachable on this
      // build (its doc, RUNBOOK §5.2), so refusing it would refuse every machine. A FAIL is 3,
      // the number `soma doctor` returns for the same verdict and the code `--canary` uses.
      // --ignore-doctor is not the `--yes` this arm refuses to have: doctor still runs and
      // prints every row, and the spend still needs the typed "yes". The dep is resolved before
      // the try, for the reason given at `start` below, and before the notice, so a missing dep
      // never announces a doctor run that cannot happen.
      const doctor = N('doctor');
      d.print('soma up: running `soma doctor` first. It makes two billed `claude -p` calls and one'
        + ' `git fetch --dry-run` per configured repo, so it takes a little while.');
      let ok;
      let threw = null;
      try {
        ok = await doctor();
      } catch (e) {
        threw = reason(e);
      }
      if (ok !== true) {
        const what = threw !== null
          ? `doctor could not finish (${threw}) and gave no verdict`
          : ok === false
            ? 'doctor reported FAIL (its report is above)'
            : `doctor answered ${ok === undefined ? 'nothing' : (summarise(ok) || typeof ok)} instead of a verdict`;
        if (!rest.includes('--ignore-doctor')) {
          d.warn(`soma up: ${what}, so the queue was not opened: nothing was projected or asked, and`
            + ' no watchdog was started. Fix what it reports (each FAIL row names what it read) and'
            + ' run `soma up` again, or pass --ignore-doctor to open it anyway: doctor still runs and'
            + ' prints every row, and the spend confirmation still follows.');
          return REFUSED;
        }
        d.warn(`soma up: ${what}. --ignore-doctor was passed, so up goes on to the spend`
          + ' confirmation anyway; the flag fixes nothing doctor found.');
      }
      // The operator's own decision, taken with this figure in front of them: they kept
      // `max_leads: 10` accepting ~200M est_tokens per fleet run. It is shown once, here,
      // before the queue opens — not as a warning that scrolls past — and the arithmetic lives
      // in `tokens.projectFleetSpend` so this arm only has to print it. It throws on a
      // `max_leads` or `tokens_cap` no enforcer would accept, and that refuses here: a
      // confirmation asked over a figure that is not the fleet's is the prompt that lies.
      let spend;
      try {
        spend = d.projectFleetSpend(cfg);
      } catch (e) {
        d.warn(`soma up: ${reason(e)}`);
        return ENV;
      }
      d.print(spend.message);
      const answer = N('confirm')(`Open the queue to ${spend.max_leads} concurrent leads? Type "yes" to confirm: `);
      if (answer === null) {
        d.warn('soma up: there is no terminal here to confirm the worst-case spend on, and soma'
          + ' will not assume a yes. Run `soma up` from an interactive shell. (Deliberately no'
          + ' --yes flag: a flag anyone can add is the warning-that-scrolls-past this gate exists'
          + ' to prevent.)');
        return REFUSED;
      }
      if (answer !== true) {
        d.print('soma up: aborted — the queue was not opened and no watchdog was started.');
        return USAGE_CODE;
      }

      // Before the watchdog, because the canary IS the gate that opens the queue: a fleet whose
      // nine runtime invariants have not been observed must not start draining work.
      if (rest.includes('--canary')) {
        if ((await N('canary')()) !== true) {
          d.warn(canaryRefusal());
          return REFUSED;
        }
        d.print('canary: pass');
      }

      const wdPath = fileURLToPath(new URL('./soma-watchdog.mjs', import.meta.url));
      const log = p('logs', 'watchdog.log');
      const env = watchdogEnv(d.env);
      // Resolved BEFORE the try, here and in every other arm: `need`'s TypeError is a wiring
      // bug in the caller, and a catch that turned it into "the watchdog could not be started"
      // would report an environment fault for a missing dependency — and, worse, would let a
      // test with an incomplete dep set pass while proving nothing.
      const start = N('newSession');
      try {
        start({
          name: WATCHDOG,
          cwd: process.cwd(),
          env,
          // `process.execPath`, not `'node'`: `engines.node` is >=24, this whole suite is
          // invisible on 20, and `node` off the forwarded PATH is whatever nvm last selected.
          // The interpreter that got here is the one that was checked.
          argv: [process.execPath, wdPath],
          logPath: log,
        });
      } catch (e) {
        d.warn(`soma up: the watchdog could not be started: ${reason(e)}`);
        return ENV;
      }

      // Verified, not assumed. `tmux new-session` exits 0 for a command `env -i` cannot
      // resolve, leaving a session whose pane died instantly — which reads as a running
      // watchdog to anything that asks by name.
      const live1 = N('liveSessions')();
      if (live1 === null) {
        d.warn(`soma up: tmux accepted the watchdog, but its state could not be read back, so`
          + ` this is UNVERIFIED — soma will not report a fleet as up on that. Check \`soma status\`;`
          + ` the watchdog's own transcript is ${log}.`);
        return REFUSED;
      }
      if (!live1.has(WATCHDOG)) {
        d.warn(`soma up: tmux accepted the watchdog but its pane is already dead — it exited on`
          + ` startup, so nothing is draining the queue. Its transcript is ${log}.`);
        return REFUSED;
      }
      d.print(`watchdog: live (tmux session ${WATCHDOG}, node ${process.execPath}, log ${log})`);
      d.print(`state root: ${env.SOMA_HOME}`);
      // The one claim `up` must not make loosely. A live watchdog is NOT an open queue: the
      // pause flag survives `soma down` and back up on purpose — a paused queue must stay
      // paused across a restart, or the pause is a property of one watchdog process rather than
      // of the fleet — and admission vetoes on it every tick. Printing "the queue is open" over
      // a set flag is the same defect as a status that reports `queue_paused: true` while
      // admission keeps spawning, with the sign flipped.
      const qNow = pausedFlag();
      d.print(qNow.paused === true
        ? 'the queue is PAUSED — the pause flag survived the restart, so the watchdog is live but'
          + ' admission stays frozen. Clear it with `soma_queue resume` from the orchestrator.'
        : qNow.paused === false
          ? 'the watchdog will drain the queue from its next tick; admission is staggered and capped'
            + ' by max_leads.'
          : `the queue's pause flag could not be read (${qNow.why}), so whether admission is frozen`
            + ' is UNKNOWN — the watchdog is live either way. `soma doctor` diagnoses the state root.');
      return OK;
    }

    case 'down': {
      // The one caller that opts into the no-server reading — `stopper` says why `kill` does not.
      const stop = stopper({ serverAbsent: N('serverAbsent') });
      const r = stop(WATCHDOG);
      // FOUR outcomes, and never a claim over the boolean alone — see `stopper`. A bare
      // `killSession(...) === true` reports a tmux that could not be reached as "no session was
      // running", which tells the operator the fleet is stopped while the watchdog may still be
      // supervising it. `down` is one of the two arms where that runs in the destructive
      // direction, and the third state is not visible from `false`.
      let code = OK;
      if (r.state === 'killed') {
        d.print(`watchdog: stopped (tmux session ${WATCHDOG}).`);
      } else if (r.state === 'absent') {
        // VERIFIED absent, not inferred from a `false`: tmux answered, and nothing by that name
        // is live — or it said, in its own words, that no server answers on the socket at all,
        // which is where every machine that has not run `soma up` stands. Zero here,
        // symmetrically with `up`'s already-running path — an already-stopped watchdog is the
        // state the operator asked for, and `soma down && …` must not break on a second run, nor
        // on a first run before any `up`.
        d.print(`watchdog: no session named ${WATCHDOG} was running (${r.noServer
          ? `no tmux server answers on socket ${tmux.socketName()}`
          : 'tmux was read back and reports none'}).`);
      } else if (r.state === 'live') {
        d.warn(`soma down: the watchdog was NOT stopped — tmux answered and still reports`
          + ` ${WATCHDOG} as live${r.why ? ` (${r.why})` : ''}. It is therefore still supervising:`
          + ' it spawns, revives, meters and reaps on every tick, so the fleet is NOT stopped.'
          + ' Run `soma down` again, and `soma status` to see whether it went.');
        code = REFUSED;
      } else {
        d.warn(`soma down: UNVERIFIED — ${r.why}, so soma cannot tell whether ${WATCHDOG} was`
          + ' stopped, was never running, or is still supervising the fleet — and it will not'
          + ' report a fleet as stopped on that. `soma doctor` checks whether tmux is reachable'
          + ' at all; `soma status` reports the watchdog once it is.');
        code = REFUSED;
      }
      // Said every time, because it is the thing an operator gets wrong about this verb: the
      // leads are separate tmux sessions and they keep running, unsupervised — no revival, no
      // budget metering, no reaping — until `soma up`.
      d.print('Running leads were NOT stopped: they keep going unsupervised (no revival, no'
        + ' budget metering, no reaping) until `soma up`. Stop one with `soma kill <lead>`.');
      return code;
    }

    case 'init': {
      /**
       * `--seat <dir>`: the same skill install and bus registration, into ANOTHER config root —
       * one seat of the account-rotation pool (design §3.7, §7 step 3). Three things move
       * together, or the seat is half-made with nothing erroring: the skill path; the
       * `CLAUDE_CONFIG_DIR` of every `claude mcp …` subprocess, because `claude mcp add -s user`
       * writes into the root it is RUN against; and the read-back, which must read the SEAT's
       * `.claude.json` or it verifies the fleet's registration and calls the seat done. What does
       * NOT move: the pins. Every seat carries THIS fleet's `SOMA_HOME` and socket — the
       * one-root-per-fleet pairing described below, deliberately inverted for a pool (design §2).
       *
       * The dir goes through `seats.resolveConfigDir` — the one `~` expander, the same call
       * `loadSeats` makes on soma.json — so what is initialised here is byte-for-byte the seat
       * soma.json will name. It must be SPELLED absolute or ~-prefixed: `resolveConfigDir` resolves
       * a relative spelling against the caller's cwd, and the caller that reads soma.json is the
       * watchdog, in whatever cwd `soma up` started it — two processes, two seats. And the
       * directory must already exist: a seat is a config dir that has been logged in (design §7
       * step 1), and creating one here would register a bus into an account that does not exist
       * yet — then read it back as success.
       */
      const seatFlag = flagValue(rest, '--seat');
      // `--inject-hook` writes the config root's own settings.json, and a seat's sessions are leads,
      // which the hook never injects into: the pair is refused before anything is touched.
      const injectHook = rest.includes('--inject-hook');
      if (injectHook && seatFlag !== undefined) {
        d.warn('soma init: --inject-hook does not go with --seat. A seat runs leads, and leads are never injected into'
          + ' (only the orchestrator lease holder gets events), so a seat would pay a node spawn per prompt for nothing.'
          + ' Run `soma init --inject-hook` without --seat, against the config root your orchestrator session uses.'
          + ' Nothing was done.');
        return USAGE_CODE;
      }
      if (seatFlag === null) {
        d.warn('soma init: --seat needs a directory, like `--seat ~/.claude-seat-b` — the config dir of the seat'
          + " (its own .claude.json, credentials and trust marks). Omit --seat to initialise the fleet's own root.");
        return USAGE_CODE;
      }
      let seat = null;
      if (seatFlag !== undefined) {
        try {
          seat = resolveConfigDir(seatFlag);
        } catch (e) {
          d.warn(`soma init: --seat ${JSON.stringify(seatFlag)} is not a config dir: ${reason(e)}`);
          return USAGE_CODE;
        }
        if (seatFlag !== '~' && !seatFlag.startsWith('~/') && !isAbsolute(seatFlag)) {
          d.warn(`soma init: --seat must be spelled absolute or ~-prefixed (got ${JSON.stringify(seatFlag)}), exactly as it will`
            + " appear in soma.json.seats: a relative spelling resolves against each process's own cwd — this shell's here,"
            + " the watchdog's wherever `soma up` started it — so the seat initialised would not be the seat soma.json names.");
          return USAGE_CODE;
        }
        /**
         * THREE states, the way doctor's own `dirState` keeps them: a directory, definitely not
         * one (ENOENT/ENOTDIR), or a stat that FAILED — EACCES on a parent, ELOOP, a name too
         * long — where nothing about the path was observed. All three refuse with ENV, because
         * registering a bus into a dir this shell cannot read is the same mistake either way,
         * but they do not share a sentence: `mkdir <seat> && … claude auth login` is the wrong
         * remedy for a directory that exists and cannot be searched, and it is the remedy an
         * operator would then run — creating a second seat beside the one they meant.
         */
        let isDir = false;
        let unstatable = null;
        try {
          isDir = statSync(seat).isDirectory();
        } catch (e) {
          if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') unstatable = `${e?.code ?? reason(e)} on ${seat}`;
        }
        if (unstatable !== null) {
          d.warn(`soma init: --seat ${seat} could not be stat'ed (${unstatable}), so whether it is a directory — let`
            + ' alone a logged-in seat — was NOT observed. Nothing was installed or registered. A path this shell'
            + ' cannot read is one `claude mcp add` could not write either: fix the permissions on it (or on a parent)'
            + ' and re-run. This is not the same as a missing seat, so do not `mkdir` it.');
          return ENV;
        }
        if (!isDir) {
          d.warn(`soma init: --seat ${seat} is not a directory. A seat is a config dir that has already been logged in`
            + ` (\`mkdir ${seat} && CLAUDE_CONFIG_DIR=${seat} claude auth login\`, design §7 step 1); creating it here would`
            + ' register a bus and install a skill into an account that does not exist yet, and read back as success.');
          return ENV;
        }
      }

      const t = tree();
      if (t) return t;
      const l = links();
      if (l) return l;

      let bad = false;
      const cfgRoot = seat ?? claudeConfigRoot(d.env);
      d.print(`state root: ${SOMA_HOME()}`);
      d.print(`claude config root: ${cfgRoot}${seat === null ? '' : " (--seat: a rotation seat, not the fleet's own root)"}`);
      d.print(`node: ${process.execPath}`);

      const skill = N('installSkill')(cfgRoot);
      if (skill?.ok === true) {
        d.print(`skill: /soma-promote installed at ${skill.dest}`);
      } else {
        d.warn(`soma init: the /soma-promote skill could not be installed at`
          + ` ${skill?.dest ?? `${cfgRoot}/skills/soma-promote`}: ${skill?.error ?? 'unknown error'}`
          + ' — without it /soma:promote does not exist on this machine and the feature is invisible.');
        bad = true;
      }

      const busPath = fileURLToPath(new URL('./soma-bus.mjs', import.meta.url));
      // Under --seat every `claude mcp …` call — remove, add AND the read-back — runs with the seat
      // as its config dir, and the rest of the environment is the caller's own, so PATH still finds
      // `claude` and USER still reaches the keychain. Without --seat the call shape is byte-identical
      // to before: two arguments, the CLI's own environment.
      const capture0 = N('capture');
      const run = seat === null ? capture0
        : (cmd, args) => capture0(cmd, args, { env: { ...d.env, CLAUDE_CONFIG_DIR: seat } });
      // Idempotent by construction: a re-run must not fail on "already exists". The remove's
      // own result is deliberately ignored — "there was nothing to remove" is the common case.
      run('claude', ['mcp', 'remove', 'soma', '-s', 'user']);
      /**
       * NO `-e SOMA_SESSION_ID=…`, and no `-e SOMA_ROLE=…` either.
       *
       * MEASURED: two sessions sharing one identity BOTH get `already_held: true`, and either
       * can `soma_release` the other's lease — a session that never held it unmounts the real
       * orchestrator. `bus-tools`' precedence contains the hazard today (`CLAUDE_CODE_SESSION_ID`
       * wins while present), but planting the variable is what makes it reachable.
       *
       * `SOMA_ROLE` is left unset because `soma-bus.mjs` documents exactly that — "soma init
       * registers the bus at user scope with no SOMA_ROLE, so every session starts as a
       * candidate" — and `roleOf` maps unset and `'candidate'` to the same role. The design doc
       * spells `-e SOMA_ROLE=candidate`; passing it would make the merged module's own comment
       * false for no behavioural gain, so the code that reads the variable wins.
       *
       * **`-e SOMA_HOME` IS passed, and it is the opposite case.** `SOMA_SESSION_ID` and
       * `SOMA_ROLE` are identities, and planting an identity is what makes two sessions
       * indistinguishable. `SOMA_HOME` is a *location*, and leaving it out does not leave the
       * bus undecided — it silently decides `~/.soma`.
       *
       * MEASURED on the first real fleet: with `env: {}` in the registration, a session
       * promoted from a work-profile Claude mounted a bus rooted at `~/.soma` while the live
       * fleet was in `~/.soma-work`. `soma_adopt` succeeded, `soma_status` reported an empty
       * fleet, and the running lead was invisible. Nothing errored, because a state root that
       * exists and is empty is indistinguishable from a fleet that has not started — and
       * `~/.soma` DID exist, left behind by this repo's own test fixtures.
       *
       * Pinning it here is also what completes the pairing the CLI already requires of the
       * operator: one `CLAUDE_CONFIG_DIR` per one `SOMA_HOME`. `claude mcp add -s user` writes
       * into the config root it is run against, so the work profile and the personal profile
       * each get a registration carrying their own root, and neither can overwrite the other.
       * `spawn.mjs` refuses to copy `SOMA_HOME` through `ENV_ALLOW` for the same reason stated
       * from the other side — "so the lead and the bus config cannot end up with two spellings
       * of one root". This is the third place that rule has to hold, and it was the one place
       * nothing enforced it.
       */
      /**
       * **`SOMA_TMUX_SOCKET` is pinned for the same reason `SOMA_HOME` is, and omitting it had
       * the same shape of consequence.**
       *
       * MEASURED: one operator running two fleets — work on the default socket, personal on
       * `soma_pers` — had `soma_pers` in the personal registration only because they added it by
       * hand. `init` never wrote it, so a re-run would have silently dropped it, and the personal
       * bus would then have sent wake keystrokes on socket `soma` **addressed by a pane id from
       * `soma_pers`**: a personal lead's NEEDS_INPUT typed into whatever `%0` happens to be on the
       * WORK server. `wake()` passes only `lease.tmux_pane` to `sendKeys`, never the lease's
       * recorded socket, so the bus's own environment is the only thing that decides the server.
       *
       * Like `SOMA_HOME` this is a LOCATION, not an identity: leaving it out does not leave the
       * bus undecided, it decides `soma`. And it is taken from `tmux.socketName()` rather than
       * re-read from the environment here, so the value written is the same one this process's
       * own tmux calls use.
       */
      const add = run('claude', ['mcp', 'add', 'soma', '-s', 'user',
        '-e', `SOMA_HOME=${SOMA_HOME()}`,
        '-e', `SOMA_TMUX_SOCKET=${tmux.socketName()}`,
        '--', process.execPath, busPath]);
      if (add?.code !== 0) {
        d.warn(`soma init: \`claude mcp add\` failed (${add?.code ?? '?'}): ${oneLine(add?.stderr || add?.stdout) || 'no output'}`
          + ' — no session will carry soma_adopt, so nothing can be promoted to orchestrator.');
        bad = true;
      } else {
        // Read back, because an exit code is not evidence the entry is there and readable.
        const get = run('claude', ['mcp', 'get', 'soma']);
        if (get?.code !== 0 || !/soma-bus\.mjs/.test(String(get?.stdout ?? ''))) {
          d.warn(`soma init: \`claude mcp add\` reported success, but \`claude mcp get soma\` cannot`
            + ` read the entry back (${get?.code ?? '?'}: ${oneLine(get?.stderr || get?.stdout) || 'no output'}).`
            + ' Treat the bus as NOT registered.');
          bad = true;
        } else {
          /**
           * The read-back above proves the ENTRY is there. It does not prove the entry carries
           * the state root, and the root is the whole reason `-e` is passed: a bus on the wrong
           * root adopts a lease over an empty tree and reports an empty fleet, silently.
           *
           * So this is checked separately, and it *declines* rather than passes when it cannot
           * see the answer — `claude mcp get`'s output format is not ours, and "the format
           * changed" must not read as "the root is wrong", nor the reverse.
           */
          const out = String(get?.stdout ?? '');
          const root = SOMA_HOME();
          const sock = tmux.socketName();
          // Checked separately from SOMA_HOME and reported on its own line, because the two fail
          // differently: a wrong root reports an empty fleet, a wrong socket types a wake into
          // another server's pane. Same three states, same reason — `claude mcp get`'s output
          // format is not soma's to pin, so "names no socket" declines rather than faults.
          if (out.includes(`SOMA_TMUX_SOCKET=${sock}`) || out.includes(sock)) {
            d.print(`bus: tmux socket pinned to ${sock}`);
          } else if (/SOMA_TMUX_SOCKET/.test(out)) {
            d.warn(`soma init: the bus carries a SOMA_TMUX_SOCKET that is not ${sock} — its wake`
              + " keystrokes would go to another tmux server, addressed by this fleet's pane ids."
              + ' Re-run `soma init` with the SOMA_TMUX_SOCKET you mean.');
            bad = true;
          } else {
            d.warn(`soma init: could not confirm from \`claude mcp get soma\` that the entry carries`
              + ` SOMA_TMUX_SOCKET=${sock}. NOT read as a failure — the output format is not soma's`
              + ' to pin. Verify by hand if you run more than one fleet: a bus on the wrong socket'
              + " sends this fleet's wakes to another server's panes.");
          }
          if (out.includes(root)) {
            d.print(`bus: registered at user scope, candidate role, SOMA_HOME=${root} — ${busPath}`);
          } else if (/SOMA_HOME/.test(out)) {
            d.warn(`soma init: the bus is registered but carries a SOMA_HOME that is not ${root}`
              + ' — a promoted session would drive a different state root than this CLI, and an empty'
              + ' root reports an empty fleet rather than an error. Re-run `soma init` with the'
              + ' SOMA_HOME you mean.');
            bad = true;
          } else {
            d.print(`bus: registered at user scope, candidate role — ${busPath}`);
            d.warn(`soma init: could not confirm from \`claude mcp get soma\` that the entry carries`
              + ` SOMA_HOME=${root} (its output names no SOMA_HOME at all). NOT read as a failure —`
              + ' the output format is not soma\'s to pin. Verify by hand before promoting a session:'
              + ' a bus on the wrong root reports an empty fleet, not an error.');
          }
        }
      }

      /**
       * The inject hook: installed only when asked, and otherwise **observed, not asserted.**
       *
       * Opt-in, because it is a node spawn on every prompt of every session in this config root
       * (`lib/inject-hook.mjs` says so, and why it pins SOMA_HOME and node). With `--inject-hook`
       * the installer's own reading is the report: added, already there and on which root, or
       * refused with the file untouched.
       *
       * Without it, this arm once printed `inject hook: NOT installed` unconditionally while an
       * operator's hand-wired hook was verified firing in both profiles. "The hook is not
       * registered" is a claim about the world, so it is read from the world — and it has THREE
       * answers: registered, not registered, and *could not tell*, which must not print as either:
       * an unreadable or absent settings.json is not evidence of absence.
       */
      const settingsPath = join(cfgRoot, 'settings.json');
      if (injectHook) {
        // A guarded dep resolved on this path only: plain init never asks for the one dep that
        // writes the operator's settings.json, so it cannot write it.
        const got = N('installInjectHook')({ settingsPath, root: SOMA_HOME() });
        if (got?.ok === true && got.action === 'added') {
          d.print(`inject hook: registered by soma init --inject-hook — a UserPromptSubmit entry in ${settingsPath} now runs`
            + ` orch-inject.mjs pinned to SOMA_HOME=${SOMA_HOME()}, so the lease holder's next prompt carries the fleet's`
            + ' unread event headers. It runs on every prompt of every session in this config root; every session but the'
            + ' lease holder exits without injecting anything.');
        } else if (got?.ok === true) {
          d.print(`inject hook: already registered — ${settingsPath} has a UserPromptSubmit entry running orch-inject.mjs,`
            + ' left exactly as it was.');
          if (got.pins === 'other') {
            d.warn(`soma init: that inject hook pins a SOMA_HOME that is not ${SOMA_HOME()}, so it reads another state root`
              + ` and this fleet's events never reach the lease holder through it. Fix the SOMA_HOME= in that entry of`
              + ` ${settingsPath}, or delete the entry and re-run \`soma init --inject-hook\`.`);
            bad = true;
          } else if (got.pins === 'none') {
            d.warn('soma init: that inject hook pins no SOMA_HOME, so it reads whichever root the session exports — the'
              + ' default ~/.soma when it exports none. NOT read as a failure: a session started from your soma wrapper'
              + ` carries this fleet's. To pin it, delete the entry from ${settingsPath} and re-run \`soma init --inject-hook\`.`);
          }
        } else {
          d.warn(`soma init: the inject hook was NOT registered: ${got?.error ?? 'unknown error'} — the lease holder gets no`
            + ' unread event headers until it is. Fix the file and re-run `soma init --inject-hook`; meanwhile drain events'
            + ' with `soma digest`, or soma_inbox once promoted.');
          bad = true;
        }
      } else {
        let seen = null;
        let injectDetail = '';
        try {
          seen = inspectInject(JSON.parse(d.readFile(settingsPath)), SOMA_HOME());
        } catch (e) {
          injectDetail = reason(e);
        }
        if (seen?.wired === true) {
          d.print(`inject hook: registered — a UserPromptSubmit entry in ${settingsPath} runs orch-inject.mjs, so the`
            + ' lease holder gets unread event headers without asking. '
            + (seen.pins === 'this'
              ? `It pins SOMA_HOME=${SOMA_HOME()}, this fleet's root.`
              : seen.pins === 'other'
                ? `It pins SOMA_HOME to a root that is not ${SOMA_HOME()}, so it reads another fleet's events: fix that entry,`
                  + ' or delete it and run `soma init --inject-hook`.'
                : 'It pins no SOMA_HOME, so it reads whichever root the session exports (the default ~/.soma when none):'
                  + ' delete it and run `soma init --inject-hook` to pin this one.'));
        } else if (seen !== null) {
          d.print(`inject hook: NOT installed — ${settingsPath} registers no UserPromptSubmit hook running orch-inject.mjs,`
            + ' so the lease holder gets no unread event headers: a lead can emit NEEDS_INPUT and wait indefinitely while'
            + ' the orchestrator looks idle. `soma init --inject-hook` registers it (opt-in: a node spawn per prompt in every'
            + ' session of this config root). Until then drain events with `soma digest` (or soma_inbox once promoted);'
            + ' see skills/soma-promote/SKILL.md §3.');
        } else {
          d.print(`inject hook: NOT OBSERVED — ${settingsPath} could not be read (${injectDetail}), so whether a`
            + ' UserPromptSubmit hook runs orch-inject.mjs is unknown. Read as neither installed nor missing.'
            + ' `soma init --inject-hook` registers it — it creates the file when there is none and never rewrites one it'
            + ' cannot read; until something does, drain events with `soma digest`.');
        }
      }

      if (bad) return ENV;
      if (seat !== null) {
        d.print(`seat initialized at ${seat}. Next: add { "config_dir": ${JSON.stringify(seat)}, "label": "<name>" } to`
          + ' soma.json.seats (label is optional — it defaults to the dir\'s basename), then `soma doctor` — every'
          + ' check with "seat" in its name must read ok, not unobserved.');
        return OK;
      }
      d.print('soma initialized. Next: `soma doctor`, then `soma up`.');
      return OK;
    }

    case 'doctor':
      // The verdict as an exit code, and nothing else printed here: `runDoctor` writes its own
      // report to stdout (so `soma doctor | tee` works) and this file captures neither stream.
      return (await N('doctor')()) === true ? OK : REFUSED;

    case 'attach': {
      const id = positionals(rest)[0];
      if (badId(id)) return USAGE_CODE;
      const got = fleetOf();
      // Not required to exist: attaching and typing is the intervention of last resort, and it
      // has to work when the checkpoint is the thing that is broken.
      const session = got.fleet ? sessionOf(rowOf(got.fleet, id) ?? { id }) : `lead-${id}`;
      const run = N('exec');
      d.print(`attaching to ${session} — detach with C-b d. Press Esc before typing if it is`
        + ' mid-turn, or the keystrokes interleave with its own output.');
      try {
        run('tmux', tmux.tmuxArgs(['attach', '-t', exactSession(session)]));
      } catch (e) {
        d.warn(`soma attach: ${session} could not be attached: ${reason(e)}`);
        return REFUSED;
      }
      return OK;
    }

    case 'peek': {
      const id = positionals(rest)[0];
      if (badId(id)) return USAGE_CODE;
      const got = fleetOf();
      const session = got.fleet ? sessionOf(rowOf(got.fleet, id) ?? { id }) : `lead-${id}`;
      const lines = count(flagValue(rest, '--lines'), PEEK_LINES, PEEK_MAX);
      const capturePane = N('capturePane');
      let text;
      try {
        // The bare session name: `tmux.capturePane` applies its own pane target, and a `=`
        // added here would arrive doubled — tmux answers "can't find pane" and the capture
        // comes back empty, which reads as a lead that printed nothing.
        text = capturePane(session, lines);
      } catch (e) {
        d.warn(`soma peek: ${session} could not be captured: ${reason(e)}`);
        return REFUSED;
      }
      if (String(text ?? '') === '') {
        // Not silence: an empty capture and a missing pane look the same from here, and printing
        // nothing at all would let the operator read either as "the lead is quiet".
        d.print(`(${session}: no output — an empty pane, or no such pane. \`soma status\` says which.)`);
        return OK;
      }
      d.print(String(text));
      return OK;
    }

    case 'send': {
      const [id, message] = positionals(rest);
      if (badId(id)) return USAGE_CODE;
      const act = actor();
      if (!act.ok) {
        d.warn(act.message);
        return REFUSED;
      }
      const got = fleetOf();
      if (got.code) return got.code;
      const row = rowOf(got.fleet, id);
      if (!row) {
        d.warn(`soma send: no task ${JSON.stringify(id)} in the fleet.`);
        return REFUSED;
      }
      const line = oneLine(message);
      if (line === '') {
        d.warn('soma send: needs a non-empty message — it is typed into the lead\'s composer and'
          + ' submitted. Quote it: soma send task-42 "use the staging bucket".');
        return USAGE_CODE;
      }
      const clamped = line.length > SEND_MAX;
      const text = clamped ? line.slice(0, SEND_MAX) : line;
      const session = sessionOf(row);
      // All three resolved before anything runs or prints, so a missing one is a TypeError naming
      // it rather than a refusal that looks like a fleet state.
      const sendKeys = N('sendKeys');
      const paneStates = N('paneStates');
      const capturePane = N('capturePane');

      // The pane gate (added after leads were found stalled on prompts nobody saw) — see
      // `SEND_REFUSALS`. Read live, right before the keystrokes, because a dialog appears within
      // seconds and the watchdog's recorded word is a tick old.
      const pane = readPane(session, { panes: paneStates, capture: (t, n) => capturePane(t, n) });
      const refusal = SEND_REFUSALS.get(pane.state);
      const forced = rest.includes('--force');
      if (refusal !== undefined && !forced) {
        d.warn(refusal(id, pane));
        return REFUSED;
      }
      d.print(act.note);
      if (act.as) d.heartbeat(act.as);

      let delivered = false;
      let threw = null;
      try {
        delivered = sendKeys(session, text) === true;
      } catch (e) {
        threw = e;
      }
      // Three outcomes, three different things known — the discipline `soma_send` states about
      // its own error strings. A failed CALL proves nothing about the lead, so it must not be
      // reported as "that pane is gone", which is a diagnosis stated as a fact.
      if (threw) {
        d.warn(`soma send: the send-keys call failed (${reason(threw)}), so nothing was typed into`
          + ` ${session} and this cannot tell whether ${id} is still there. Check \`soma status\`.`);
        return REFUSED;
      }
      if (!delivered) {
        d.warn(`soma send: not delivered — tmux would not type into ${session}: that pane is gone,`
          + ` or the soma tmux server is not running. ${id} is ${row.status ?? 'in no recorded state'}.`
          + ` Check \`soma status\`, and \`soma resume ${id}\` if it should be running.`);
        return REFUSED;
      }
      const paneNote = pane.fine !== null && pane.fine !== pane.state ? `${pane.state}/${pane.fine}` : pane.state;
      d.print(`delivered ${text.length} chars to ${session}${clamped ? ` (clamped from ${line.length})` : ''}`
        + `; pane read ${paneNote}${refusal !== undefined ? ' (forced past a refusal)' : ''}`);
      if (pane.state === 'unrecognised') {
        d.warn(`soma send: ${id}'s pane was read but its screen matched no known Claude Code state (unrecognised); typed anyway.`
          + ` \`soma peek ${id}\` shows what it is doing.`);
      }
      return OK;
    }

    case 'kill': {
      const [id, why] = positionals(rest);
      if (badId(id)) return USAGE_CODE;
      const act = actor();
      if (!act.ok) {
        d.warn(act.message);
        return REFUSED;
      }
      const got = fleetOf();
      if (got.code) return got.code;
      const row = rowOf(got.fleet, id);
      // Refused rather than passed to `setTaskStatus`, which throws on an unknown id: `soma
      // kill cr-99` must not report success having killed nothing.
      if (!row) {
        d.warn(`soma kill: no task ${JSON.stringify(id)} in the fleet.`);
        return REFUSED;
      }
      const session = sessionOf(row);
      const stop = stopper();
      d.print(act.note);
      if (act.as) d.heartbeat(act.as);

      // The kill first, because it is what the operator asked for; then the row, so a failed
      // row-write leaves a dead session the watchdog reconciles rather than a "failed" row
      // beside a live lead. FOUR outcomes, not a boolean — see `stopper`.
      const r = stop(session);
      // THE ROW IS ONLY WRITTEN ON AN OUTCOME THAT WAS VERIFIED, and this is the whole point of
      // the three states here. `failed` beside a lead that is actually still running is the
      // destructive direction: the operator believes the lead is dead and stops watching it while
      // a real `claude` keeps burning tokens on its worktree, and the checkpoint agrees with
      // them. On `live` NOTHING was stopped; on `unmeasured` nothing is KNOWN. Neither is
      // grounds for marking a lead failed, and neither is grounds for exit 0.
      if (r.state === 'live' || r.state === 'unmeasured') {
        const logged = logOrch({
          type: 'KILL_REFUSED',
          payload: { lead: id, outcome: r.state, detail: r.why, reason: oneLine(why) },
          lead: id,
        });
        d.warn(`soma kill: ${id} was NOT killed, and its row was left as`
          + ` ${row.status ?? 'it was'} rather than marked failed —`
          + (r.state === 'live'
            ? ` tmux answered and still reports ${session} as live${r.why ? ` (${r.why})` : ''},`
              + ` so the kill did not take and ${id} is still running.`
            : ` tmux could not be read (${r.why}), so soma cannot tell whether ${session} is gone`
              + ' or still running, and it will not mark a possibly-live lead failed on that.')
          + ` Check \`soma status\`, then \`soma kill ${id}\` again.`
          + ` (event ${logged ? 'logged' : 'NOT logged'})`);
        return REFUSED;
      }
      let statusErr = null;
      try {
        d.setTaskStatus(id, 'failed');
      } catch (e) {
        statusErr = e;
      }
      const logged = logOrch({ type: 'KILLED', payload: { lead: id, reason: oneLine(why) }, lead: id });
      // "not found" is a READ-BACK here, not the absence of a success: tmux was asked and
      // reports nothing by that name. Rendering the two identically is what made the whole
      // difference invisible.
      d.print(`kill ${id}: session ${r.state === 'killed' ? 'killed' : 'not found (tmux read back)'}, row`
        + ` ${statusErr ? 'NOT updated' : 'failed'}, event ${logged ? 'logged' : 'NOT logged'}`);
      if (statusErr) {
        // Which of the two verified outcomes got here matters to whoever reads this: "killed" and
        // "there was nothing to kill" leave the fleet in different states, and this arm now knows
        // the difference. Saying "the session was killed" on the absent path would be a small
        // instance of exactly the defect the read-back exists to remove.
        d.warn(`soma kill: ${r.state === 'killed' ? 'the session was killed' : 'tmux reports no session by that name'},`
          + ` but the task row could not be updated (${reason(statusErr)});`
          + ' the watchdog will reconcile it on its next tick.');
        return REFUSED;
      }
      return OK;
    }

    case 'resume': {
      const id = positionals(rest)[0];
      if (badId(id)) return USAGE_CODE;
      const act = actor();
      if (!act.ok) {
        d.warn(act.message);
        return REFUSED;
      }
      const got = fleetOf();
      if (got.code) return got.code;
      const row = rowOf(got.fleet, id);
      if (!row) {
        d.warn(`soma resume: no task ${JSON.stringify(id)} in the fleet.`);
        return REFUSED;
      }
      if (!nonEmpty(row.lead_session_uuid)) {
        d.warn(`soma resume: ${id} has no recorded claude session to resume. Put it back on the`
          + ` queue with \`soma retry ${id}\` and the watchdog will spawn it fresh.`);
        return REFUSED;
      }
      const session = sessionOf(row);
      const killSession = N('killSession');
      const resume = N('resumeLead');
      const live = N('liveSessions')();
      const alive = live === null ? null : live.has(session);
      // `--force` means "I know its session is gone" and nothing more. Two claude sessions
      // resumed onto one worktree edit the same files to two different plans, so an unmeasured
      // liveness reading refuses exactly like a live one does.
      if (alive !== false && rest.includes('--force') === false) {
        d.warn(`soma resume: ${alive === null ? `${id}'s liveness could not be measured (tmux unreadable)` : `${id} is still live`};`
          + ' resuming would put a second claude session on its worktree.'
          + ` \`soma kill ${id}\` first, or pass --force if you know its session is gone.`);
        return REFUSED;
      }
      // Onto an open seat (account rotation, design §4), picked BEFORE the kill: a refusal must
      // leave the dead pane standing — it is the death scene `soma peek` shows — and the row as it
      // was. No `seats` in soma.json is one account and no rotation: `{}` to the spawner, `seat:
      // null` on the row, today's launch. Every seat closed or unverified is a refusal, not a
      // launch on this shell's own account, which is a seat too and may be the one that just
      // closed; the watchdog holds silently in the same case, a hand-run resume gets a sentence.
      // A soma.json that will not load is refused HERE, before the kill, with the loader's reason
      // and `soma up`'s exit for it. It used to be read tolerantly as "the spawner's to refuse" —
      // and the spawner does read the same file and refuse it, but only after the kill below has
      // destroyed the death scene. A seats that is not an array is refused at load too, so that
      // was every resume on such a file.
      let cfg;
      try {
        cfg = d.loadConfig();
      } catch (e) {
        d.warn(`soma resume: ${reason(e)} — nothing was killed or resumed. Fix soma.json (\`soma doctor\` reads it too) and run this again.`);
        return ENV;
      }
      const seated = Array.isArray(cfg?.seats) && cfg.seats.length > 0;
      let seat = null;
      if (seated) {
        try {
          seat = d.pickSeat(Date.now(), cfg);
        } catch (e) {
          d.warn(`soma resume: soma.json.seats could not be read (${reason(e)}), so no seat can be picked. Fix it and run \`soma doctor\`.`);
          return REFUSED;
        }
        if (seat === null) {
          d.warn(`soma resume: every configured seat is closed or unverified (${cfg.seats.length} in soma.json), so ${id} would hit`
            + ' the same limit on its first turn. `soma status` shows each seat\'s reset time — retry after the earliest,'
            + ` or \`soma retry ${id}\` and let the watchdog place it.`);
          return REFUSED;
        }
      }
      const launchOpts = seat === null ? {} : { configDir: seat.config_dir };
      const seatLabel = seat === null ? null : seat.label;
      d.print(act.note);
      if (act.as) d.heartbeat(act.as);

      // KILL BEFORE RESPAWN, always — including under --force, where it is not the guard but
      // the mechanism. `setRemainOnExit` keeps a dead lead's pane and session alive on purpose
      // (that pane is the death scene the watchdog reads), and the spawner refuses to start a
      // lead whose session name is already taken. Resume-without-kill therefore fails silently
      // and forever on exactly the leads that need reviving.
      try {
        killSession(session);
      } catch { /* nothing to kill is the state we wanted */ }

      let out;
      try {
        out = resume(row, launchOpts);
      } catch (e) {
        d.warn(`soma resume: ${id} could not be resumed: ${reason(e)} — run \`soma doctor\` for the reason.`);
        return REFUSED;
      }
      try {
        d.setTaskStatus(id, 'spawned');
      } catch (e) {
        // A row that says `spawned` beside no session is worse than a stale failed one, so the
        // failure is reported rather than folded into a success line.
        d.warn(`soma resume: ${id} was resumed but its row could not be marked spawned`
          + ` (${reason(e)}); the watchdog will reconcile it.`);
        return REFUSED;
      }
      // The seat this launch went onto, through the store: the label the watchdog's limits phase
      // closes on this lead's next limit hit, or null for the shell's own account — written on
      // every resume, because a row still naming the seat the lead DIED on would close the wrong
      // account. After the status, for the status's own reason: a row that says `seat-b` beside a
      // resume that did not happen is worse than a stale one. `updated` is not touched.
      try {
        d.updateFleet((live) => {
          const r = (Array.isArray(live?.tasks) ? live.tasks : []).find((x) => x?.id === id);
          if (!r) return false;
          r.seat = seatLabel;
          return true;
        });
      } catch (e) {
        d.warn(`soma resume: ${id} was resumed${seatLabel === null ? '' : ` on ${seatLabel}`} but its row could not record the seat`
          + ` (${reason(e)}); until it does, a limit hit on this lead closes the seat the row still names.`);
        return REFUSED;
      }
      d.print(`resumed ${id} (claude session ${out?.session_uuid ?? row.lead_session_uuid}, tmux ${session}${seatLabel === null ? '' : `, seat ${seatLabel}`})`);
      return OK;
    }

    case 'retry': {
      const id = positionals(rest)[0];
      if (badId(id)) return USAGE_CODE;
      const act = actor();
      if (!act.ok) {
        d.warn(act.message);
        return REFUSED;
      }
      const got = fleetOf();
      if (got.code) return got.code;
      const row = rowOf(got.fleet, id);
      if (!row) {
        d.warn(`soma retry: no task ${JSON.stringify(id)} in the fleet.`);
        return REFUSED;
      }
      // A `spawned` or `blocked` lead still holds a live, answerable session, and re-queueing it
      // would put a second lead on its worktree beside the first; an already-`queued` row is a
      // no-op that would read as an action; a `done` row has a draft PR to lose.
      if (!RETRYABLE.has(row.status)) {
        d.warn(`soma retry: ${id} is ${row.status ?? 'in no recorded state'}, and retry only`
          + ' re-queues a failed or skipped row.'
          + (row.status === 'queued' ? ' It is already on the queue.'
            : row.status === 'done' ? ` It finished — re-running it would start a second lead on its worktree and open a second draft PR, silently. Enqueue a new task id instead.`
              : ` Re-queueing it now would put a second lead on its worktree. \`soma kill ${id}\` first if it should stop.`));
        return REFUSED;
      }
      const killSession = N('killSession');
      d.print(act.note);
      if (act.as) d.heartbeat(act.as);
      // Same ordering rule as `resume`, for the same reason: the old session lingers by design
      // and the spawner will not start a lead whose name is taken.
      try {
        killSession(sessionOf(row));
      } catch { /* nothing to kill is the state we wanted */ }
      try {
        d.setTaskStatus(id, 'queued');
      } catch (e) {
        d.warn(`soma retry: ${id} could not be re-queued: ${reason(e)}`);
        return REFUSED;
      }
      const logged = logOrch({ type: 'RETRIED', payload: { lead: id, from: row.status }, lead: id });
      d.print(`retry ${id}: re-queued from ${row.status}, event ${logged ? 'logged' : 'NOT logged'}.`
        + ' The watchdog admits it on a later tick — admission is staggered and capped by max_leads.');
      return OK;
    }

    case 'clear-trip': {
      // Clear a lead's budget trip. Removing `leads/<id>/BUDGET_TRIPPED` alone is undone within a
      // tick: the lead is still over its cap, so the meter trips it again, with a second BUDGET 100
      // and a second toast. So this goes through `wd/budget.clearTrip`, the one guarded function the
      // bus's `soma_clear_trip` calls too. In ONE fleet transaction it removes the flag, and an 80%
      // note left from the old allowance, and raises the row's `budget_grants`, so the meter judges
      // every cap at (1 + grants) times the class's from then on. Its refusals (an unknown lead, a
      // row the meter does not judge, a lead that is not tripped, a count that is not one) are
      // relayed as they are: they name no path. The event is logged AFTER the transaction, so a
      // refused or failed clear leaves no TRIP_CLEARED in the history.
      const id = positionals(rest)[0];
      if (badId(id)) return USAGE_CODE;
      const act = actor();
      if (!act.ok) {
        d.warn(act.message);
        return REFUSED;
      }
      d.print(act.note);
      if (act.as) d.heartbeat(act.as);
      let out;
      try {
        out = d.clearTrip(id, { updateFleet: d.updateFleet });
      } catch (e) {
        // "No allowance was granted" holds on every path here: the grant is published only when the
        // whole transaction is, and the meter re-trips a flag removed without one on its next tick.
        d.warn(`soma clear-trip: no allowance was granted to ${id}: ${reason(e)}`);
        return REFUSED;
      }
      // By whom, as `actor()` established it: the orchestrator only when `--as` proved the lease.
      const logged = logOrch({ type: 'TRIP_CLEARED', payload: { grants: out.grants, by: act.as ? 'orchestrator' : 'operator' }, lead: id });
      d.print(`clear-trip ${id}: trip cleared, budget_grants ${out.grants} (every cap is now ${out.grants + 1}x its class's),`
        + ` event ${logged ? 'logged' : 'NOT logged'}. The gate stops denying on ${id}'s next tool call, and the watchdog`
        + ' judges it against the new allowance from its next tick.');
      return OK;
    }

    case 'digest': {
      const lines = count(flagValue(rest, '--lines'), DIGEST_LINES, DIGEST_MAX);
      const got = fleetOf();
      if (got.code) return got.code;
      const ids = got.fleet.tasks.map((t) => t?.id).filter((id) => nonEmpty(id) && LEAD_RE.test(id));
      const streams = [ORCH_STREAM, ...ids];
      const all = [];
      for (const s of streams) {
        try {
          all.push(...d.readEvents(s));
        } catch (e) {
          d.warn(`soma digest: stream ${s} could not be read: ${reason(e)}`);
        }
      }
      // `(ts, id)` — and because a record's `ts` IS its id prefix, that is exactly id order,
      // which is append order. The newest event is therefore the last line an operator reads.
      all.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (all.length === 0) {
        d.print(`no events yet across ${streams.length} stream(s) under ${p('events')}.`);
        return OK;
      }
      const tail = all.slice(Math.max(0, all.length - lines));
      // Deliberately NOT `soma_inbox`: that advances the orch cursor, and an operator looking
      // at the log must not consume the orchestrator's mail. This reads the files directly, so
      // re-reading is free. The v1.x digest composer (a summariser) is a declared gap.
      d.print(`the last ${tail.length} of ${all.length} events across ${streams.length} stream(s),`
        + ' oldest first, cursor untouched (the v1.x digest composer is not built, so this is the raw log)');
      for (const e of tail) {
        d.print(`${iso(e.ts)}  ${String(e.type ?? '?').padEnd(18)} ${e.lead ?? '-'}  ${summarise(e.payload)}`);
      }
      return OK;
    }

    case 'watch': {
      // The keystroke-free poller (`lib/watch.mjs`): one stdout line per event that needs the
      // orchestrator, for Claude Code's Monitor tool. Like `digest`, it consumes nothing — no
      // sendKeys, no notify, no appendEvent, no writeCursor — so any number may run.
      let all = false;
      let interval = INTERVAL_DEFAULT_S;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--all') {
          all = true;
        } else if (rest[i] === '--interval') {
          const v = rest[++i];
          if (!/^\d+$/.test(v ?? '') || Number(v) < INTERVAL_MIN_S || Number(v) > INTERVAL_MAX_S) {
            d.warn(`soma watch: --interval takes a whole number of seconds from ${INTERVAL_MIN_S} to ${INTERVAL_MAX_S}`
              + ` (got ${v === undefined ? 'nothing' : JSON.stringify(v)}).`);
            return USAGE_CODE;
          }
          interval = Number(v);
        } else {
          d.warn(`soma watch: ${JSON.stringify(rest[i])} is not an argument it takes — only --interval <seconds> and --all.`);
          return USAGE_CODE;
        }
      }
      // The watchdog read exactly as `status` reads it: a `null` listing is unmeasured unless tmux
      // says, in its own words, that no server answers on the socket — then nothing runs there.
      const liveSessions = N('liveSessions');
      const serverAbsent = N('serverAbsent');
      const paneStates = N('paneStates');
      const watchdogState = () => {
        const listed = liveSessions();
        if (listed === null) return serverAbsent() === true ? 'absent' : 'unknown';
        return listed.has(WATCHDOG) ? 'live' : 'absent';
      };
      // The lease's pane, read in `status`'s three states. A listing decides. No listing because tmux
      // says no server answers on the socket means the pane cannot exist: `status` reads that as an
      // empty server, and the bus's `hasPane` as a dead server's pane. Any other missing listing is
      // no evidence the pane is gone.
      const hasPane = (pane) => {
        const panes = paneStates();
        if (panes === null || panes === undefined) return serverAbsent() !== true;
        for (const rec of panes.values()) if (rec?.panes?.some((x) => x?.pane_id === pane)) return true;
        return false;
      };
      // Monitor stops a command with SIGTERM when it expires, and Ctrl-C is SIGINT: either ends the
      // loop and the arm exits 0. A reader that went away ends it too, rather than an EPIPE crash.
      // The handlers come off afterwards, so nothing of this outlives the loop.
      const ac = d.signal === undefined ? new AbortController() : null;
      const stop = () => ac.abort();
      if (ac !== null) {
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
        process.stdout.on('error', stop);
      }
      try {
        await runWatch({
          all,
          intervalMs: interval * 1000,
          env: d.env,
          deps: {
            readFleet: d.readFleet, readLease: d.readLease, readEvents: d.readEvents, readCursor: d.readCursor, now: d.now,
            watchdogState, hasPane,
          },
          print: d.print,
          warn: d.warn,
          signal: ac === null ? d.signal : ac.signal,
          sleep: d.sleep,
        });
      } finally {
        if (ac !== null) {
          process.off('SIGINT', stop);
          process.off('SIGTERM', stop);
          process.stdout.off('error', stop);
        }
      }
      return OK;
    }

    /**
     * The declared v1.x gaps.
     *
     * Each refuses with the reason and the thing to do instead, and none of them prints USAGE:
     * a usage line reads as "you typed it wrong" for verbs the ROADMAP, the design doc and the
     * promote skill all say exist. `hold` is the one that matters most, and it is not laziness
     * that it is absent — writing `leads/<id>/HOLD` when nothing in `bin/` reads it would ship
     * a pause that is written, displayed and never obeyed.
     *
     * They exit `3`, not `1`. These ARE refusals — the legend reserves `3` for "soma refused"
     * and every other refusal in the file uses it — and `1` made `soma hold` and `soma
     * frobnicate` indistinguishable to a script, which undoes most of the point of refusing
     * with a reason rather than being absent.
     */
    case 'hold':
      d.warn('soma hold: not implemented in this build (v1.x). Nothing in bin/ reads'
        + ' leads/<id>/HOLD yet — the watchdog\'s stall strikes, revival and wall clock do not'
        + ' consult it — so writing that flag would hand you a pause that is written, displayed,'
        + ' and never obeyed. To freeze the whole fleet now: `soma_queue pause` from the'
        + ' orchestrator (admission stops on the next tick, running leads continue). To stop one'
        + ' lead: `soma kill <lead>`.');
      return REFUSED;

    case 'release':
      d.warn('soma release: not implemented in this build (v1.x) — it is the other half of'
        + ' `soma hold`, which is also absent (run `soma hold` for why).\n'
        + '  !! `soma release <lead>` IS NOT `soma_release`. The MCP tool `soma_release` hands'
        + ' the ORCHESTRATOR LEASE back to the fleet; this CLI verb un-holds ONE LEAD. There is'
        + ' no CLI lease handback in v1: the lease passes to the next session that adopts, or'
        + ' becomes adoptable once your heartbeat is 10 minutes old. Confusing the two in'
        + ' fallback mode unmounts a working orchestrator.');
      return REFUSED;

    case 'gc':
      d.warn('soma gc: not implemented in this build (v1.x). Nothing sweeps worktrees, branches,'
        + ' logs or digests yet, and no terminal task rows are collected. Remove a worktree by'
        + ' hand with `git worktree remove`; soma never touches ~/.claude/projects transcripts,'
        + ' which --resume needs.');
      return REFUSED;

    case 'thaw': {
      // Lift an org spend-cap freeze — the one freeze nothing inside the fleet lifts. The tick's
      // spend-cap branch never clears its own record: the cap is the organisation's, and whether it
      // has been raised or the month has turned is a fact only a human has. Three refusals, then the
      // one action. An unreadable record is not cleared blind (the bytes are the evidence — fix or
      // delete the file by hand); a live storm is the watchdog's to end (it re-writes its record on
      // every tick the storm holds, so a clear here would be undone within a tick and would
      // hide the storm from `soma status` meanwhile); an inactive record is nothing to do, said so.
      const act = actor();
      if (!act.ok) {
        d.warn(act.message);
        return REFUSED;
      }
      let rec;
      try {
        rec = d.backpressureState() ?? { active: false };
      } catch (e) {
        rec = { active: false, unreadable: true, why: reason(e) };
      }
      if (rec.unreadable === true) {
        d.warn(`soma thaw: state/backpressure.json under ${p('state')} could not be read (${rec.why ?? 'no reason given'}), so there`
          + ' is no record to clear, and nothing here overwrites bytes it cannot read. Inspect the file; fix or delete it'
          + ' by hand. `soma doctor` diagnoses the state root.');
        return REFUSED;
      }
      if (rec.active !== true) {
        d.print('backpressure: none — nothing to thaw. `soma status` shows the queue switch and the seat pool beside it.');
        return OK;
      }
      if (rec.reason === STORM_REASON) {
        d.warn('soma thaw: the freeze is a rate-limit STORM, and a live storm is the watchdog\'s: it re-writes this record'
          + ' on every tick the storm holds and clears it itself once fewer than two leads still hold a live usage-limit'
          + ' hit, so a clear here would be undone within a tick and would hide the storm from `soma status` meanwhile.'
          + ' Wait it out; `soma digest` carries the BACKPRESSURE events with the leads whose limit hits make up the storm.');
        return REFUSED;
      }
      d.print(act.note);
      if (act.as) d.heartbeat(act.as);
      try {
        d.clearBackpressure();
      } catch (e) {
        d.warn(`soma thaw: the record could not be cleared (${reason(e)}). Nothing changed.`);
        return REFUSED;
      }
      d.print(`thawed: cleared ${JSON.stringify({ reason: rec.reason ?? null, since: rec.since ?? null, until: rec.until ?? null })}`
        + ` (frozen since ${whenMs(rec.since)}). Admission resumes on the watchdog's next tick unless a rate-limit storm still holds (\`soma status\` names the reason). If a spend-cap record comes back`
        + ' within a tick, a spawned lead\'s transcript still ends on the spend-cap row: the tick reads tails, not calendars,'
        + ' so move or kill those leads first (RUNBOOK §9).');
      return OK;
    }

    default:
      // Stdout, not stderr, and this is deliberate: the unknown-verb path is the one place the
      // full usage is the *answer* rather than a footnote to a refusal, and a test that looks
      // for it here is what proves no implemented verb falls through to this arm.
      d.print(USAGE);
      d.warn(`soma: ${JSON.stringify(String(cmd))} is not a soma command.`);
      return USAGE_CODE;
  }
}

/**
 * Why `--canary` cannot open the queue, stated as what is known rather than as a guess.
 *
 * Two first clauses, because the arm refuses on two paths. On a fresh start nothing was opened.
 * With a watchdog ALREADY running, `--canary` checked that fleet without stopping it, and the
 * queue is whatever the watchdog and the pause flag (reported on the line above) make it — so
 * "the queue was not opened" would be false there, and that path says what was left alone and
 * what does stop a fleet.
 */
const canaryRefusal = ({ live = false } = {}) =>
  (live
    ? 'soma up: the canary did not report a pass (its verdict is on stderr above), and the watchdog'
      + ' that was already running is untouched: --canary checks a fleet, it does not stop one;'
      + ' `soma down` does.'
    : 'soma up: the canary did not report a pass, so the queue was not opened (its verdict is on'
      + ' stderr above).')
  + ' NOTE, because it is the likeliest reason on this build: `canary.mjs` ships'
  + ' the EVALUATION only and records the live driver as a declared v1.x gap, so the canary'
  + ' `soma up` runs has no driver to observe anything with and can only report "unproven".'
  + ' Establish the nine invariants by hand (see bin/lib/canary.mjs) and run `soma up` without'
  + ' --canary.';

/**
 * The watchdog's environment: the allowlist, scrubbed, plus an ABSOLUTE state root.
 *
 * `SOMA_HOME()` rather than `process.env.SOMA_HOME || ''` — the sketch — because the resolver
 * normalises `/x/soma/` and `/x/soma` onto one root and *refuses* a relative one outright. A
 * relative value forwarded verbatim makes ten state paths resolve against each process's own
 * cwd: heartbeats no reader looks at, a BUDGET_TRIPPED flag the gate never finds, a fleet.lock
 * taken on a different file so mutual exclusion stops existing, and an orchestrator lease two
 * sessions each believe they hold. Every path comes out absolute and plausible; nothing errors.
 *
 * Empty values are dropped rather than forwarded, matching `spawn.buildLeadEnv`: soma spells
 * "unset" as `''` and every soma reader uses `||`, so forwarding `CLAUDE_CONFIG_DIR=` would
 * make that true of soma and unverified of claude — and that is the one variable where the two
 * disagreeing is a silent hang.
 */
const watchdogEnv = (env) => {
  const out = {};
  for (const k of WATCHDOG_ENV_ALLOW) {
    const v = env?.[k];
    if (typeof v === 'string' && v !== '') out[k] = v;
  }
  out.SOMA_HOME = SOMA_HOME();
  return out;
};

// `pathToFileURL`, not a `file://` template: `process.argv[1]` arrives unresolved and a path
// needing percent-encoding (a checkout under `/Users/x/My Repos/`) would never match, leaving
// a CLI that exits 0 having done nothing at all. Same guard as `soma-watchdog.mjs`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  dispatch(process.argv.slice(2), realDeps()).then(
    (code) => {
      // `process.exitCode`, never `process.exit()`: exiting truncates a piped stdout mid-write,
      // and `soma doctor | tee` is what an operator does with these commands.
      process.exitCode = Number.isInteger(code) ? code : OK;
    },
    (e) => {
      process.stderr.write(`soma: ${reason(e)}\n`);
      process.exitCode = ENV;
    },
  );
}
