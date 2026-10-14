#!/usr/bin/env node
/**
 * The watchdog tick — the loop that actually runs the fleet.
 *
 * Eight pure decision functions already exist (`wd/reconcile`, `wd/budget`, `wd/backpressure`'s
 * `detectStorm`, `wd/admission`, `wd/settle`, `wd/revive`, `wd/pane-state`, `wd/limit-state`);
 * none of them touches the world. `wd/backpressure` also carries the freeze file's reader and
 * writer, which do, under the fleet lock. Otherwise this file is the only place that does: every
 * 30 s it takes one checkpoint snapshot, asks those eight what should happen, and performs it. `tick(deps)` is effect-injected end to end and `realDeps()`
 * is the production wiring, so every decision above is testable without tmux, a transcript or a
 * clock.
 *
 * Phase 0, the pane census, is the newest and reads what each lead's PANE is running and showing
 * (`wd/pane-state.mjs`), beside what its `status` says. It exists because the two disagree in the
 * cases that cost days: a `done` row 38 hours deep in a permission dialog, and `blocked`/`done`
 * rows whose panes tmux-resurrect had replaced with bare `zsh` — invisible to reconcile (wrong
 * status) and to `liveSessions` (`pane_dead=0`) alike. It writes `pane_state` on the row, never
 * `status`; it announces `LEAD_BLOCKED_ON_PROMPT` and `LEAD_DEAD_SHELL` on entry, once; and it
 * never types into a pane — measured: Enter into that dialog APPROVES the pending command.
 *
 * Phase 1, the limits phase, is newer still and is the account-rotation design's one foothold in
 * the tick: it reads each spawned lead's transcript tail and, on a usage-limit hit, closes the
 * lead's seat and moves the lead to an open one (`limitsPhase`, `rotate`); on the org spend cap it
 * freezes admission through `state/backpressure.json`, whose only lift is `soma thaw`. It types
 * into no pane and holds no lease: BACKPRESSURE reaches the orchestrator by toast and by its next
 * `soma_inbox` drain.
 *
 * ## The one property this file exists to protect
 *
 * Almost everything here is a safety mechanism, and every safety mechanism in this system has
 * the same failure mode: **it goes inert and nothing says so.** A cap compared against the
 * wrong units, a flag written and displayed but never read, a `?.` on a dep the real wiring
 * forgot — each leaves a fleet that looks healthy, reports healthy, and has no governor at all.
 * So the rules below are not style:
 *
 * - **No optional chaining on a dep, ever, and the dep set is refused if it is incomplete.** A
 *   `deps.queuePaused?.()` reads as a working pause and is a no-op; `checkDeps` turns the same
 *   mistake into a message naming the missing name. This is `spawn.checkDeps`'s reasoning, and
 *   the reason a dep set is never completed from `realDeps()`: a test that forgot `spawnLead`
 *   would launch a real detached lead.
 * - **Never a ternary that can skip the call that carries the guard.** `cls ? checkBudget(…) :
 *   null` short-circuits exactly when `budgetClassFor` returns null — the real failure mode —
 *   so the guard inside `checkBudget` never runs and `verdict` is silently null: a breakerless
 *   lead. `checkBudget` is called unconditionally here, and a class that cannot be resolved is
 *   defaulted-and-announced or refused, never skipped.
 * - **Nothing is announced twice.** `drained` needs no quiet window, a tripped lead stays over
 *   cap forever, a given-up row stays `spawned` until the orchestrator folds it — so every
 *   emit here is idempotent against the durable log or against a flag file. An alarm that
 *   fires every 30 s is one an operator mutes, which is the same thing as no alarm.
 * - **A degraded reading is loud and local.** One lead whose transcript is mid-rotation must not
 *   cost the other nine their breaker, so per-lead work is wrapped and reported as
 *   WATCHDOG_ERROR against that lead. Reported, not swallowed.
 *
 * ## Two units traps this file is the last line of defence on
 *
 * `readDirUsage(cwd)` returns both `est_tokens` and `turns`, they sit on one object, and they
 * are **different subjects**. `est_tokens` is legitimately a directory sum — a lead's teammates
 * spend the operator's money, and a lead-only meter was blind to 60.3 % of the work in one real
 * directory. `turns` is the sum too, and `turn_cap` is calibrated **per lead**: measured 912
 * directory turns against the lead's own 169 on that same directory, 5.4x apart. Against the
 * sum, a 600 cap fires at ~111 lead turns — below the observed one-ticket median of 134. So the
 * reading handed to `checkBudget` is assembled here, field by field, from the two right places.
 *
 * `est_tokens` (cumulative SPEND) and `live_context` (current PROMPT SIZE) have exactly one
 * consumer each and are 200x apart on a real transcript (120,527,067 against 601,285). The
 * breaker reads the first through `readDirUsage`; the revival decision reads the second through
 * `readUsage(uuid)`, which is per-session because a revival is about one specific session.
 * `planRevival` refuses a `readDirUsage` aggregate by name; this file never offers it one.
 *
 * ## What is deliberately NOT here
 *
 * The `linger_minutes` / `stall_minutes` reapers, and the digest composer. They are named in the
 * design and are not among this tick's five duties; adding an unrequested killer of live tmux
 * sessions would be the worst possible way to widen this file's scope.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { appendEvent, readEvents } from './lib/events.mjs';
import * as fleetMod from './lib/fleet.mjs';
import { budgetClassFor } from './lib/harness.mjs';
import { notify } from './lib/notify.mjs';
import { p, worktreeDir } from './lib/paths.mjs';
import { queuePaused } from './lib/queue.mjs';
import * as seats from './lib/seats.mjs';
// This import is load-bearing, not decorative. `realDeps()` wires the *real*
// spawner, and dropping the import to leave `spawnLead` injection-only would hand production an
// `undefined` spawner — admission would silently no-op while every effect-injected test in
// `test/watchdog.tick.test.mjs` still passed, which is strictly worse than a load error.
import { LEAD_MODEL, resumeLead, spawnLead } from './lib/spawn.mjs';
import * as tmux from './lib/tmux.mjs';
import { modelDeviation, readDirUsage, readTailRows, readUsage } from './lib/tokens.mjs';
import { nextAdmission } from './lib/wd/admission.mjs';
import { MIN_EPOCH_MS, STORM_REASON, clearBackpressure, detectStorm, readBackpressure, writeBackpressure } from './lib/wd/backpressure.mjs';
import { checkBudget, tripPath, warnPath } from './lib/wd/budget.mjs';
import { classifyLimit } from './lib/wd/limit-state.mjs';
import { CAPTURE_TIMEOUT_MS, CENSUS_LINES, takeCensus } from './lib/wd/pane-state.mjs';
import { reconcile } from './lib/wd/reconcile.mjs';
import { planRevival } from './lib/wd/revive.mjs';
// Every rotation event this file writes goes through these builders. `rotationFailed` is
// consumed by the revert's `revertRotation`; it is imported here so the line is written once and
// the revert needs no import of its own.
import { backpressure, rotated, rotationFailed, rotationUnavailable, seatClosed, seatReopened } from './lib/wd/rotation-events.mjs';
import { settlement } from './lib/wd/settle.mjs';

/** The orchestrator-facing stream. Every event this tick writes goes here, with `lead` set. */
const ORCH = 'orch';

/** Design §11: BUDGET at 80 % of the token estimate, hard trip at 100 %. */
const WARN_PCT = 80;
const TRIP_PCT = 100;

/**
 * How much of a dead lead's final screen rides along in LEAD_DEAD.
 *
 * Bounded because `events.appendEvent` relies on one line being one `write(2)` inside the
 * kernel's ~4 KiB atomic-append window — that is what lets the log take appends with no lock.
 * A 40-line pane capture can be several KiB on its own, and a line that overruns the window can
 * interleave with another writer's. `logs/<id>.log` holds the full transcript; this is the
 * glance.
 */
const DEATH_SCENE_LINES = 12;
const DEATH_SCENE_CHARS = 800;

/**
 * The harness a lead that has declared nothing is priced at: no class pinned at enqueue, and no
 * HARNESS on its stream or its row. Every lead spends its first minutes like this, before its
 * step-1 report, and it is not announced (`budgetClassOf`, rule 3).
 */
const DEFAULT_HARNESS = 'H1';

/**
 * The class bound when something was declared and nothing declared can be priced, and the class
 * `HARNESS_DEFAULTED` names when it binds one (`budgetClassOf`, rule 4). The same class H1 reserves,
 * as shipped.
 */
const DEFAULT_CLASS = 'standard';

/** Floor and fallback for the loop's own cadence, so a bad `tick_ms` cannot spin the process. */
const MIN_TICK_MS = 1000;
const DEFAULT_TICK_MS = 30_000;

/**
 * Design §3.5 step 3: a lead rotated this many times inside `fleetMod.ROTATION_WINDOW_MS` is
 * thrashing — every seat it lands on rejects it — and is left to `autoContinueAtUsageLimit`
 * instead. The window is `fleet.mjs`'s, the same constant `writeFleet` prunes with, so the bound
 * and the prune cannot disagree about what "an hour" is.
 */
const MAX_ROTATIONS_PER_HOUR = 3;

/**
 * Trailing transcript rows the limits phase hands `classifyLimit`. The classifier reads the LAST
 * assistant row; the rows Claude Code appends after a limit hit (`system` notices, a
 * `turn_duration`, a `queue-operation`) sit between it and the end of the file, so the tail has to
 * reach past them. 40 is ten times the longest such run measured, and still a few KiB.
 */
const TAIL_ROWS = 40;

/**
 * Every dep `tick` requires, and the whole of its contract with `realDeps`.
 *
 * Exported so a test can assert the real wiring covers it. A name here that `realDeps` does not
 * wire is a duty that no-ops in production while every injected test passes — the failure the
 * `spawn.mjs` import's comment describes, generalised past `spawnLead`.
 */
export const REQUIRED_DEPS = Object.freeze([
  'loadConfig', 'readFleet', 'updateFleet', 'setTaskStatus',
  'aliveSessions', 'paneStates', 'readDirUsage', 'readUsage', 'budgetClassFor',
  'appendEvent', 'notify', 'tripBudget', 'warnBudget', 'tripped',
  'spawnLead', 'resumeLead', 'killSession', 'capturePane',
  'leadCwd', 'leadEvents', 'orchEvents', 'lastEventTs',
  'now', 'paneSignals', 'versionOk', 'queuePaused',
  'readBackpressure', 'writeBackpressure', 'clearBackpressure',
  // The limits phase. Eight names, every one an effect: a transcript read, the classifier, and
  // six seat-pool operations that read or write `state/seats.json` (`seatLoggedIn` reads a
  // seat's own `.claude.json`). The freeze file's three are on the line above.
  'readTail', 'classifyLimit', 'readSeatState', 'pickSeat', 'closeSeat', 'reopenSeats',
  'markSeatUnverified', 'seatLoggedIn',
]);

/**
 * Refuse an incomplete dep set instead of quietly completing it from `realDeps()`.
 *
 * The same refusal, for the same reason, as `spawn.checkDeps`: `{...realDeps(), ...deps}` would
 * let a test that stubs eight deps and forgets `spawnLead` start a real detached `claude` in a
 * real worktree — and would let `realDeps` itself lose a name without anything noticing, since
 * every test here injects its own.
 */
function checkDeps(deps) {
  const missing = REQUIRED_DEPS.filter((k) => typeof deps?.[k] !== 'function');
  if (missing.length) {
    throw new TypeError(
      `tick: these dependencies are missing or are not functions: ${missing.join(', ')}`
      + ' — pass a complete dep set. A tick that optional-chained them instead would skip'
      + ' whichever duty they belong to, silently, in production.',
    );
  }
}

/** The tmux session name for a lead. One spelling, shared by the kill and the liveness read. */
const sessionName = (id) => `lead-${id}`;

/**
 * A tmux session name soma will spell into its own argv. Mirrors `bus-tools`/`soma.mjs`'s
 * `TMUX_NAME_RE` rather than importing it (this file stays free of the bus). A recorded
 * `tmux_session` that fails it — a `%N` pane id, a trailing newline — is not used as a target.
 */
const TMUX_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The session the pane census reads for a row: what the checkpoint recorded, else the derived name. */
const censusName = (task) =>
  (typeof task?.tmux_session === 'string' && TMUX_NAME_RE.test(task.tmux_session) ? task.tmux_session : sessionName(task.id));

/** The two pane states that are alarms: announced on entry, once, and toasted. */
const PANE_ALARMS = new Set(['blocked_on_prompt', 'dead_shell']);

/**
 * When an event happened, in the same milliseconds `task.updated` is stamped in.
 *
 * A copy of `bus-tools.stampOf`'s rule, and it has to agree with it: `events.mjs` guarantees a
 * record's `ts` is exactly the numeric prefix of its own id, so a hand-written line with no `ts`
 * can still be placed in time. One that cannot be placed returns null and decides nothing.
 */
const stampOf = (event) => {
  if (Number.isFinite(event?.ts)) return event.ts;
  const parsed = Number.parseInt(String(event?.id ?? '').slice(0, 13), 10);
  return Number.isFinite(parsed) ? parsed : null;
};

/** The newest event in `rows` whose type is in `types`, or null. Ties go to the later row. */
function newestOf(rows, types) {
  let best = null;
  let bestAt = -Infinity;
  for (const e of Array.isArray(rows) ? rows : []) {
    if (!types.has(e?.type)) continue;
    const at = stampOf(e);
    if (at === null || at < bestAt) continue;
    best = { event: e, at };
    bestAt = at;
  }
  return best;
}

const NEEDS_INPUT = new Set(['NEEDS_INPUT']);
/** The three that mean a lead stopped needing anybody. Mirrors `bus-tools.TERMINAL_STATUS`. */
const TERMINAL_EVENTS = new Set(['COMPLETED', 'ERROR', 'GAVE_UP']);
/** A lead's own plan of record; the newest one that names a harness prices it (`budgetClassOf`). */
const HARNESS_EVENTS = new Set(['HARNESS']);

/**
 * The statuses in which a lead holds a live, answerable session — the rows the breaker owns.
 *
 * **`blocked` is in this set, and its absence is what let a lead run with no token cap, no turn
 * cap and no wall cap while its row and `soma_status` both looked healthy.** The chain, and
 * every step of it is this build's own code:
 *
 * 1. Phase 4 below writes `blocked` after `blocked_slot_minutes` and deliberately does **not**
 *    kill the session, because design §185 gives a blocked lead its admission slot back *"while
 *    staying alive and answerable"*.
 * 2. `soma_send` types into that live pane and changes no status. The lead resumes working, and
 *    its teammates with it.
 * 3. Nothing moves `blocked → spawned` except `soma_resume`, and `resumeLead` refuses while the
 *    pane is live. **So answering a blocked lead never restored metering.** The row stayed
 *    `blocked` until the lead reported terminal — precisely the window in which it does its
 *    heaviest work, right after being unblocked.
 * 4. With no BUDGET event and no `BUDGET_TRIPPED` file, the lead's PreToolUse gate never denies,
 *    so design §205's *"no lead ever runs breakerless"* was false for exactly these rows. And
 *    `countActive` counts only `spawned` — correctly, the slot release is the design — so the
 *    freed slot admits another lead and the fleet runs N metered beside M unmetered sessions.
 *
 * **Scoped on the status enum and NOT on tmux liveness, which was the other candidate.**
 * `aliveSessions()` may answer `null` — a wedged tmux server and a healthy idle one produce the
 * same empty output, and a listing in which no row parses names no session at all — and phase 2
 * already declines to read either as a dead fleet. A meter gated on the same predicate would
 * switch the whole fleet's breaker off on exactly the ticks when something else is already
 * wrong — trading a status-shaped hole for a liveness-shaped one of the same class, and a wider
 * one. Metering reads transcripts, not tmux; it needs no liveness answer, and a spend cap must
 * not acquire a dependence on one. (A trip on a row whose lead has since died costs nothing: the
 * flag only bites through that lead's own hook.)
 *
 * **Terminal rows are out, deliberately.** A `done`/`failed`/`skipped` lead has reported that it
 * stopped; its transcript is not growing, and `BUDGET_TRIPPED` written against it is a flag only
 * an explicit unlink clears. Their panes do linger — there is no `linger_minutes` reaper on this
 * build — but a finished lead's lingering pane is that reaper's business, and metering every
 * terminal row would grow per-tick I/O with the fleet's whole history, since v1 never removes a
 * task. `queued` rows have no session, and no worktree whose transcripts could be read.
 */
const METERED = new Set(['spawned', 'blocked']);

/**
 * What the orchestrator stream already says, so nothing is announced twice.
 *
 * One read per tick, answering five "have I said this already" questions. `Set`s throughout,
 * never objects keyed by lead id: task ids are `^[a-z][a-z0-9-]{0,63}$`, so `constructor` is a
 * legal lead name and an object registry would report every lead as already-announced.
 *
 * **An unreadable stream answers "yes" to everything.** That is the safe direction and it is
 * chosen deliberately: the cost of forgetting is a toast storm, a re-triggered digest and a
 * re-announced deviation on every tick forever, while the cost of over-remembering is one
 * missing log line. `readEvents` already tolerates a torn tail and an absent file, so reaching
 * this catch means a broken state root, which is `soma doctor`'s business rather than a reason
 * to shout at the operator every 30 s.
 */
const ALWAYS = { has: () => true };
const NEVER_FRESH = { get: () => Infinity };
/** The blind stream's answer to "what was this lead's newest launch": nothing — so nothing is judged stale here, and nothing is reverted (see `revertRotation`). */
const NO_LAUNCH = { get: () => undefined };

function orchHistory(deps) {
  let rows;
  try {
    rows = deps.orchEvents();
  } catch {
    return {
      blind: true,
      budget: ALWAYS, deviation: ALWAYS, defaulted: ALWAYS, gaveUp: ALWAYS, versions: ALWAYS,
      unmeasured: ALWAYS,
      revivedAt: NEVER_FRESH, announcedAt: Infinity,
      backpressureUnreadable: true,
      launch: NO_LAUNCH, seatClosedAt: NEVER_FRESH, rotationUnavailableAt: NEVER_FRESH, limitsErrorAt: NEVER_FRESH,
      revertRefusedAt: NEVER_FRESH,
    };
  }
  const budget = new Set();
  const deviation = new Set();
  const defaulted = new Set();
  const gaveUp = new Set();
  const versions = new Set();
  const unmeasured = new Set();
  const revivedAt = new Map();
  let announcedAt = -Infinity;
  let backpressureUnreadable = false;
  // For the limits phase (design §3.8): each lead's newest launch — SPAWNED, REVIVED, ROTATED or
  // ROTATION_FAILED (four members since the revert joined the fold), with a ROTATED's or a
  // ROTATION_FAILED's `from`/`to` — which dates the process it is living (a rate_limit row older
  // than it is the killed process's, and the revert reads `from` off it); when each seat last
  // closed; when each lead was last told no seat was open; when a torn tail was last reported for
  // it. So ROTATION_UNAVAILABLE and the torn-tail WATCHDOG_ERROR are said once per lead per
  // closure or launch, not once per tick.
  const launch = new Map();
  const seatClosedAt = new Map();
  const rotationUnavailableAt = new Map();
  const limitsErrorAt = new Map();
  const newest = (map, key, at) => map.set(key, Math.max(map.get(key) ?? -Infinity, at));
  // The newest `WATCHDOG_ERROR {where:'revert'}` per lead: a refusal the revert (spec §3.5 step 5)
  // has already said. Deduped per rotation, not per lead — the revert compares it with the newest
  // launch's stamp, so a refusal older than the ROTATED belongs to an earlier one.
  const revertRefusedAt = new Map();
  for (const e of Array.isArray(rows) ? rows : []) {
    const lead = typeof e?.lead === 'string' && e.lead !== '' ? e.lead : null;
    const at = stampOf(e);
    switch (e?.type) {
      case 'BUDGET': if (lead) budget.add(lead); break;
      case 'MODEL_DEVIATION': if (lead) deviation.add(lead); break;
      case 'HARNESS_DEFAULTED': if (lead) defaulted.add(lead); break;
      case 'TURNS_UNMEASURED': if (lead) unmeasured.add(lead); break;
      case 'GAVE_UP': if (lead) gaveUp.add(lead); break;
      case 'VERSION_GATE': {
        const v = e?.payload?.version;
        if (typeof v === 'string' && v !== '') versions.add(v);
        break;
      }
      // A revival, a rotation and a REVERT all start a NEW process for the same row without
      // changing its status, so none of them can move `updated`; `revivedAt` is what dates the
      // current process (`releaseBlockedSlot`), and an admission SPAWNED does not move it — the
      // contract. `launch` keeps the newest of the four per lead, ties to the later row, with the
      // payload's `from`/`to` read defensively: `orchHistory` runs outside every phase's try, so a
      // fold that dereferenced a torn payload would turn one bad line into a tick that rejects
      // forever.
      //
      // ROTATION_FAILED belongs here by this arm's OWN criterion — it is a kill and a `--resume`,
      // the undo of a rotation — and its payload is shaped for it: `from` is the seat that rejected
      // the lead and `to` the seat the lead is now on, exactly as ROTATED's are. Two things follow,
      // and both are the point. `releaseBlockedSlot` stops flipping a reverted row to `blocked` on
      // a question the KILLED process asked (the staleness rule the ROTATED row of the
      // orchestrator prompt states, which had no counterpart for a revert). And `revertRotation`'s
      // own `launch.type !== 'ROTATED'` guard starts carrying a case of its own.
      //
      // WHICH case, corrected — an earlier commit message and this comment both used to say the
      // type clause was what stopped a revert repeating every 30 s when its `updateFleet` write
      // was lost. Measured by removing one clause at a time from `revertRotation` and running
      // `test/watchdog.tick.test.mjs` (165 green): drop `launch.type !== 'ROTATED'` and exactly ONE
      // test reddens — rv26, the landed-write case, where the ROTATION_FAILED's `to` IS the row's
      // seat so the next guard passes. Drop `launch.to !== task.seat` instead and rv25 (the
      // lost-write fixture) and rv6 redden. So the lost write is held by the SEAT clause, and the
      // type clause's own case is the revert running BACKWARDS onto the seat that just rejected
      // the lead. Two independent brakes, but not the two the first telling named.
      case 'SPAWNED':
      case 'REVIVED':
      case 'ROTATED':
      case 'ROTATION_FAILED': {
        if (!lead || at === null) break;
        if (e.type !== 'SPAWNED') newest(revivedAt, lead, at);
        const prev = launch.get(lead);
        if (prev === undefined || at >= prev.at) {
          launch.set(lead, { type: e.type, at, from: e?.payload?.from ?? null, to: e?.payload?.to ?? null });
        }
        break;
      }
      case 'SEAT_CLOSED': {
        const seat = e?.payload?.seat;
        if (typeof seat === 'string' && seat !== '' && at !== null) newest(seatClosedAt, seat, at);
        break;
      }
      case 'ROTATION_UNAVAILABLE':
        if (lead && at !== null) newest(rotationUnavailableAt, lead, at);
        break;
      case 'FLEET_DRAINED':
      case 'FLEET_SETTLED':
        if (at !== null && at > announcedAt) announcedAt = at;
        break;
      case 'WATCHDOG_ERROR': {
        // ONE label for every `where` this fold reads. The limits phase (`where: 'limits'`) and the
        // revert (`where: 'revert'`) add an `if` HERE; a second `case 'WATCHDOG_ERROR':` is dead code.
        const where = e?.payload?.where;
        // The tick's own "the freeze record could not be read". A lock timeout or a failed spawn
        // carries a different `where` and must not silence this one.
        if (where === 'backpressure_file') backpressureUnreadable = true;
        // The limits phase's own reports against a lead (a torn tail, a refused verdict), once per
        // lead per launch. The revert's own clause is the next line.
        if (where === 'limits' && lead && at !== null) newest(limitsErrorAt, lead, at);
        // The revert's refusals, once per rotation: `revertRotation` compares this with the
        // newest launch's stamp, so a refusal older than the ROTATED does not count.
        if (where === 'revert' && lead && at !== null) newest(revertRefusedAt, lead, at);
        break;
      }
      default: break;
    }
  }
  return { blind: false, budget, deviation, defaulted, gaveUp, versions, unmeasured, revivedAt, announcedAt, backpressureUnreadable, launch, seatClosedAt, rotationUnavailableAt, limitsErrorAt, revertRefusedAt };
}

/** A required non-negative finite number, tolerating the one string worth keeping. */
function reqNum(what, raw) {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    throw new TypeError(`${what} must be a non-negative finite number, got ${show(raw)}`);
  }
  return n;
}

/** A value for an error message: quoted if a string, named by type if not. */
const show = (v) =>
  typeof v === 'string' ? JSON.stringify(v) : v !== null && typeof v === 'object' ? (Array.isArray(v) ? 'array' : 'object') : String(v);

/** One line of text for whatever was thrown, without `e.message` on a `throw null`. */
const reason = (e) => {
  try {
    const m = e?.message;
    return typeof m === 'string' && m !== '' ? m : String(e);
  } catch {
    return 'unknown error';
  }
};

/**
 * The `standard` budget class off a config, or null.
 *
 * `Object.hasOwn`, never truthiness and never `in`, for `wd/budget.mjs`'s reason: a class
 * inherited from `Object.prototype` is a class nobody wrote in soma.json, and one resolving to
 * "no caps" is a lead running with no breaker.
 */
function fallbackClass(cfg) {
  const budgets = cfg?.budgets;
  if (budgets === null || typeof budgets !== 'object') return null;
  return Object.hasOwn(budgets, DEFAULT_CLASS) ? budgets[DEFAULT_CLASS] : null;
}

/** A name as a row or a payload declares one: a string with something in it, else null. */
const declaredName = (value) => (typeof value === 'string' && value !== '' ? value : null);

/**
 * The pin on a row as a HARNESS_DEFAULTED payload names it, cut to 32, or null when there is none.
 *
 * Any value but undefined, null and '' is a pin. `soma enqueue --file` stores what the file says,
 * so 42 or `{}` can arrive, and reading one as "nothing declared" priced that lead as H1 without a
 * word. A string keeps its spelling; anything else is named by `show`, which names an object by its
 * type and never calls `String()` on it: JSON can carry `{"toString": 1}`, `String()` of that
 * throws, and a throw in `meter` costs the lead its verdict for the tick.
 */
const pinName = (pin) => (pin === undefined || pin === null || pin === '' ? null : (typeof pin === 'string' ? pin : show(pin)).slice(0, 32));

/**
 * The class soma.json defines under exactly `name`, or null.
 *
 * Own key and record value, never truthiness and never `in`, for `fallbackClass`'s reason:
 * `constructor` resolves through `Object.prototype` to a function nobody wrote in soma.json. The
 * record check is `harness.readBudgets`'s, and it matters more here than in `fallbackClass`. A
 * pinned class that cannot be bound still has the lead's harness behind it, so it is passed over;
 * handed to `checkBudget` instead, it would be refused on every tick, and the lead would go
 * unmetered for as long as the row exists.
 */
function definedClass(cfg, name) {
  const budgets = cfg?.budgets;
  if (name === null || budgets === null || typeof budgets !== 'object' || Array.isArray(budgets) || !Object.hasOwn(budgets, name)) return null;
  const cls = budgets[name];
  return cls !== null && typeof cls === 'object' && !Array.isArray(cls) ? cls : null;
}

/**
 * The budget class that prices `task`, as `{cls, defaulted}`: `defaulted` is the HARNESS_DEFAULTED
 * payload when the fallback class was bound or a pin was passed over, and null when there is
 * nothing to announce.
 *
 * The first rule that prices the lead wins:
 *
 * 1. **The class the operator pinned at enqueue**, when soma.json defines it. Only a string pin
 *    can name a class: `Object.hasOwn(budgets, 42)` would find a class named "42", and `['babysit']`
 *    would find babysit. Read from `budget_override`, which only `fleet.enqueue` writes, and never
 *    from `budget_class`. The inbox fold keeps `budget_class` following the lead's newest harness,
 *    so on a row nobody pinned it is the harness's class restated. On a row folded before
 *    `budget_override` existed it is the class of the FIRST report: after the documented H1 -> H4
 *    degrade, a resolver reading it as a pin prices a review lead at standard.
 * 2. **The harness the lead declared**: the newest HARNESS on its OWN stream that names one, else
 *    the row's `harness`. The stream comes first because the row learns the harness only when the
 *    orchestrator drains its inbox, and until that drain this file priced every lead as H1: an
 *    iterate lead tripped at standard's cap with its reservation already on disk. A stream that
 *    cannot be read leaves the row's harness standing and is not reported here. For a `spawned`
 *    lead, phase 4 reads the same stream on the same tick and reports the failure. For a `blocked`
 *    lead nothing does: it is priced at its row's harness until a later tick reads the stream.
 * 3. **Nothing declared at all**: H1's class, and nothing is announced. Every lead spends its first
 *    minutes here, before its step-1 HARNESS, and an event on every spawn is an alarm an operator
 *    learns to mute.
 * 4. **Something declared, and nothing declared can be priced**: a harness the registry does not
 *    carry or soma.json cannot price, a pin no class can be bound from with no priceable harness
 *    behind it, or H1 itself unpriceable. The fallback class is bound, and the payload names what
 *    was declared with `budget_class: 'standard'`, each name cut to 32 characters because one event
 *    is one atomic append.
 *
 * A pin no class can be bound from (a string soma.json does not define, or not a string at all) on a
 * lead whose harness prices is passed over, and said: the payload carries `budget_class: null`,
 * because no fallback was bound and the lead's own harness prices it. An operator who pinned
 * babysit and is billed at review's cap is exactly the failure this resolver ends.
 * `soma_enqueue` refuses such a class at the door; one still reaches a row through
 * `soma enqueue --file`, which stores what the file says, or by being removed from soma.json after
 * the enqueue. A pin already announced under rule 4 is not announced again when a harness later
 * prices the lead: `HARNESS_DEFAULTED` is said once per lead.
 *
 * `cls` can still be null (rule 4 with no `standard` defined either), and the caller hands it to
 * `checkBudget` regardless, which refuses it out loud.
 */
function budgetClassOf(deps, cfg, task) {
  const pinned = definedClass(cfg, declaredName(task.budget_override));
  if (pinned !== null) return { cls: pinned, defaulted: null };
  const override = pinName(task.budget_override);

  let harness = declaredName(task.harness);
  try {
    const rows = deps.leadEvents(task.id);
    const newest = newestOf((Array.isArray(rows) ? rows : []).filter((e) => declaredName(e?.payload?.harness_id) !== null), HARNESS_EVENTS);
    if (newest !== null) harness = newest.event.payload.harness_id;
  } catch {
    // The row's harness stands; rule 2 above says why this is not reported.
  }

  // Rules 2 and 3. A pin that could not be bound is a declaration too, so a row carrying one never
  // reaches H1 silently. With a pin present here, `harness` is not null, and the pin it was priced
  // over is said with a null class.
  if (harness !== null || override === null) {
    const cls = deps.budgetClassFor(harness ?? DEFAULT_HARNESS);
    if (cls !== null && cls !== undefined) {
      return { cls, defaulted: override === null ? null : { harness: harness.slice(0, 32), budget_override: override, budget_class: null } };
    }
  }
  return {
    cls: fallbackClass(cfg),
    defaulted: { harness: harness === null ? null : harness.slice(0, 32), budget_override: override, budget_class: DEFAULT_CLASS },
  };
}

/**
 * The lead's OWN session reading out of a directory aggregate, or null.
 *
 * `readDirUsage` returns `sessions` newest-first with a `uuid` on each, so this needs no new
 * plumbing — and it is the *only* correct source for the lead's own turn count. `undefined` is
 * a real state (a lead that has not written a turn yet, or one just respawned onto a fresh
 * uuid) and reads as no measurement rather than as an error.
 */
function ownSession(dir, uuid) {
  if (typeof uuid !== 'string' || uuid === '') return null;
  const sessions = Array.isArray(dir?.sessions) ? dir.sessions : [];
  return sessions.find((s) => s?.uuid === uuid) ?? null;
}

/** Are this row's revival attempts exhausted? Asked through `planRevival`, which owns the 3. */
const exhausted = (attempts, cfg) => planRevival({ attempts }, null, cfg) === 'giveup';

/**
 * One 30 s tick: census the panes, read each lead's limit state (close, rotate, freeze),
 * reconcile, meter, release blocked slots, detect backpressure, admit, settle.
 *
 * Every effect goes through `deps`. Nothing here reads a clock, a file or tmux directly.
 */
export async function tick(deps) {
  checkDeps(deps);
  const cfg = deps.loadConfig();
  const fleet = deps.readFleet();
  // Named here rather than left to `reconcile`/`nextAdmission`/`settlement` — all three guard
  // it, but this function iterates `tasks` itself before any of them, and a native
  // `Cannot read properties of null (reading 'filter')` standing in for a guard is how the
  // toothless assertion in this module family happened.
  if (!Array.isArray(fleet?.tasks)) {
    throw new TypeError(`tick: fleet.tasks must be an array, got ${show(fleet?.tasks)}`);
  }
  const tasks = fleet.tasks;
  const now = reqNum('tick: now', deps.now());
  const history = orchHistory(deps);
  const say = (type, payload, lead = null) => deps.appendEvent(ORCH, { type, payload, lead });
  const fail = (where, e, lead = null) => say('WATCHDOG_ERROR', { where, error: reason(e) }, lead);

  // ── 0. pane census ────────────────────────────────────────────────────────────────────
  //
  // What each lead's PANE is doing, beside what its `status` says — over every row that has a
  // session (all but `queued`), because the two cases this exists for were a `done` row 38 hours
  // deep in a permission dialog and a `blocked` row whose pane was the bare `zsh` tmux-resurrect
  // restored after a reboot. Neither is `spawned`, so reconcile skips both by status, and
  // `liveSessions` reads a shell pane as alive anyway (`pane_dead=0`). The census is the only
  // read here that looks at what a pane is RUNNING.
  //
  // `null` from `paneStates` is the same answer as `null` from `aliveSessions` — tmux could not
  // be listed, or listed nothing soma could parse — and gets the same treatment: nothing is
  // written about any pane this tick, and it is announced. Phase 2 consumes the census (a
  // `spawned` row on a shell is dead to reconcile), and phase 1 kills only a pane the census read
  // as alive, which is why this runs first.
  const panes = deps.paneStates();
  const census = panes === null || panes === undefined
    ? null
    : takeCensus(
      tasks.filter((t) => typeof t?.id === 'string' && t.id !== '' && t.status !== 'queued').map((t) => ({ id: t.id, name: censusName(t) })),
      { panes, capture: (name, n) => deps.capturePane(name, n), now: () => deps.now(), lines: CENSUS_LINES, timeoutMs: CAPTURE_TIMEOUT_MS },
    );
  const deadShells = new Set();
  if (census !== null) {
    for (const t of tasks) {
      const read = census.get(t?.id);
      if (read === undefined) continue;
      // `read.name` is `censusName(t)`, and reconcile keys on `lead-<id>`; spawn records exactly that
      // name as `tmux_session`, so the two are one name. A row whose recorded session diverged would
      // already be dead to reconcile (its `lead-<id>` is not in the alive set) whatever is added here.
      if (read.coarse === 'dead_shell') deadShells.add(read.name);
      try {
        recordPane(deps, t, read, now);
      } catch (e) {
        fail('pane_census', e, t.id);
      }
    }
  }

  // ── 1. limits: classify, close, rotate or freeze, reopen ──────────────────────────────
  //
  // AFTER the census and BEFORE admission, and each half is the design (§4). The census is what
  // says which panes are alive to kill — `rotate()` refuses a pane it did not read as `alive`,
  // so a dead lead stays revival's, with revival's attempt accounting. Admission must see a seat
  // that closed THIS tick as closed, or the slot a limit-hit lead frees is refilled onto the
  // account that just refused it; and revival must too, or a dead lead is relaunched onto it.
  // Hence before phase 2 and not merely before phase 6. A rotation is a kill and a `--resume`,
  // i.e. a launch, and it counts against admission's one-per-tick rule as a revival does. The
  // freeze this phase writes is read back by phase 5, off the FILE, like any other freeze.
  const limits = limitsPhase(deps, cfg, tasks, history, now, census, fail);
  let launched = limits.launched;

  // ── 2. liveness, reconcile and revival ────────────────────────────────────────────────
  //
  // `aliveSessions` is a PANE predicate, not a session-name probe: `setRemainOnExit` keeps a
  // dead lead's session alive on purpose (that pane IS the death scene), so `hasSession` is
  // true for a dead lead and a reconciler built on it finds no dead leads ever.
  //
  // `null` means tmux could not be read — the listing failed, or came back with no row soma can
  // parse (#45) — which is NOT the same answer as "nothing is alive". A wedged tmux reports the
  // same empty output a healthy idle server does; read as liveness, one hiccup makes every
  // spawned row look dead in the same tick and this branch then kills and respawns ten LIVE
  // leads. One tick of revival latency is the cheap side of that trade, and it is announced so
  // the pause is not silent.
  const alive = deps.aliveSessions();
  const skipped = [];
  if (alive === null || alive === undefined) skipped.push('reconcile', 'revival');
  if (census === null) skipped.push('pane_census');
  if (skipped.length > 0) {
    say('TMUX_UNREADABLE', {
      skipped,
      why: alive === null || alive === undefined
        ? 'tmux list-panes failed, or answered a listing soma could not parse; a wedged server and an idle one are indistinguishable by output, a listing with no parsable row names no session, and treating either as a dead fleet would respawn over live work'
        : 'the pane listing failed, or answered one soma could not parse, while the liveness listing was read; no pane_state is written this tick, because an unlisted pane is not an absent one',
    });
  }
  if (alive !== null && alive !== undefined) {
    // A `spawned` row whose pane is a bare shell is DEAD to reconcile, though `liveSessions`
    // counts the shell's pane as live. The filter lives here rather than in `reconcile`, whose
    // contract (a Set of names in, ids out) is pinned and shared; with no census this tick the
    // set passes through untouched, so a tmux hiccup can never widen the dead set.
    const aliveForReconcile = deadShells.size === 0 ? alive : new Set([...alive].filter((name) => !deadShells.has(name)));
    // The tick's clock, so a row `soma_spawn` claimed and is still launching outside the fleet lock
    // (its session not created yet) is left alone rather than killed and spawned a second time.
    // Only until its mark is `LAUNCH_GRACE_MS` old: past that the row is revived like any dead lead,
    // usually a spawner that died (`LAUNCH_GRACE_MS` says what it costs a launch that is only slow).
    const { deadLeads } = reconcile(fleet, aliveForReconcile, now);
    // `reconcile`'s `updates` are deliberately NOT applied. They re-affirm `spawned`, which is
    // a no-op in meaning — but written through `setTaskStatus` they would stamp `updated` on
    // every tick, which resets the wall-clock cap measured against it below and makes the row
    // look newer than any terminal event still unread in the log, so the next inbox drain
    // declines its own flip. `updated` means "when this row's state last changed", full stop.
    for (const id of deadLeads) {
      const t = tasks.find((x) => x?.id === id);
      if (!t) continue;
      try {
        if (revive(deps, cfg, t, history, now, census?.get(id)?.coarse ?? null)) launched = true;
      } catch (e) {
        fail('revival', e, id);
      }
    }
  }

  // ── 3. budget breakers and model deviation ────────────────────────────────────────────
  //
  // Over every METERED row — `spawned` AND `blocked` — and not only the tmux-alive ones. Both
  // halves of that scope are load-bearing and both are argued at `METERED`: a `blocked` lead is
  // alive, answerable and doing its heaviest work, and a meter that asked tmux instead would go
  // inert on every tick the liveness read hiccuped.
  for (const t of tasks) {
    if (!METERED.has(t?.status)) continue;
    try {
      meter(deps, cfg, t, history, now);
    } catch (e) {
      // Reported, never swallowed: `checkBudget`'s own refusals (a class with no enforceable
      // cap, a hand-rolled usage reading) are the ones that must reach a human, and the other
      // nine leads still get their breaker.
      fail('budget', e, t.id);
    }
  }

  // ── 4. NEEDS_INPUT → blocked ──────────────────────────────────────────────────────────
  //
  // The bus's fold owns COMPLETED → done and ERROR/GAVE_UP → failed. This half is the
  // watchdog's because writing `blocked` frees the admission slot the instant it lands
  // (`countActive` counts only `spawned`) and the design gives a blocked lead
  // `blocked_slot_minutes` of grace first — a clock the bus does not have.
  const graceMs = reqNum('tick: cfg.blocked_slot_minutes', cfg?.blocked_slot_minutes) * 60_000;
  for (const t of tasks) {
    try {
      releaseBlockedSlot(deps, t, history, now, graceMs);
    } catch (e) {
      fail('blocked', e, t?.id ?? null);
    }
  }

  // ── 5. backpressure ───────────────────────────────────────────────────────────────────
  //
  // THE FILE IS THE GOVERNOR; the in-memory verdict is one of its writers. `state/backpressure.json`
  // is what `soma_status` and `soma status` render and what admission below obeys. Before this
  // block wrote it, a storm froze admission while status reported "not frozen" — a governor that
  // was written nowhere and displayed from a file nobody wrote.
  //
  // Two writers share the file: this branch (`STORM_REASON`) and the limits phase's spend cap
  // (`reason: 'org_level_disabled_until'`). One rule keeps them apart: a branch writes only its
  // own reason and clears only its own reason. So a storm ending cannot thaw a spend-cap freeze,
  // and a storm cannot relabel one — the foreign record and its `since` stand. The spend-cap
  // record is lifted by a human, through `soma thaw`; nothing in this tick clears it.
  //
  // Deliberately re-emitted on every frozen tick and deliberately silent on the desktop. A storm's
  // END has no event, so the repetition is what records the freeze's duration for the digest; and
  // a freeze already stalls the whole fleet, which the operator discovers from `soma_status` rather
  // than from a toast. `since` is carried from OUR OWN record, never re-stamped, so the repeated
  // events and the file agree about when the freeze began — with one exception, stated because a
  // digest reader would otherwise mis-read it: under a FOREIGN record (a spend-cap freeze) there is
  // no storm record to carry and nothing is written, so each re-emit stamps `now` and those events
  // date the tick rather than the storm. Pinned as such in `test/watchdog.tick.test.mjs`. Carrying
  // the foreign `since` instead would date a storm from a spend cap's start, which is a different
  // freeze; the alternative — remembering a storm's start across ticks — needs state this tick does
  // not have. Unreachable today (`paneSignals` is a stub) and the limits phase owns the branch
  // that makes it reachable, so the choice is left here where its cost is written down.
  const storm = detectStorm(deps.paneSignals());
  const before = deps.readBackpressure();
  if (before.unreadable === true && !history.backpressureUnreadable) {
    // The third state, said once. Read as "not frozen" — the tolerant direction, and the bus's —
    // but a record that will not parse is an outside edit (tmp+rename cannot tear one), which is
    // doctor's business. Once per log, like VERSION_GATE: the file does not heal by being read,
    // and it is left as it is — the bytes are the evidence. That holds under a storm too (below).
    say('WATCHDOG_ERROR', { where: 'backpressure_file', error: before.why ?? 'state/backpressure.json could not be read' });
  }
  const ours = before.active === true && before.reason === STORM_REASON;
  if (storm.frozen) {
    // Carried from our own record when it is a millisecond stamp, re-stamped otherwise: a
    // hand-edited `since` in seconds is the units bug, and carrying it would be a record every
    // reader renders as 1970 — and a value the builder and the writer both refuse.
    const since = ours && Number.isFinite(before.since) && before.since >= MIN_EPOCH_MS ? before.since : now;
    // Written unless a FOREIGN freeze holds the file or the file is UNREADABLE. Our own record is
    // re-written every frozen tick on purpose: a deleted file comes back, and the write is one
    // rename. An unreadable one is not "ours to overwrite": `active: false` there is the tolerant
    // reading, not a fact about what the bytes say.
    if (ours || (before.active !== true && before.unreadable !== true)) {
      try {
        deps.writeBackpressure({ active: true, reason: STORM_REASON, since, until: null });
      } catch (e) {
        // The visible half failed; the freeze did not (see `frozen` below). Reported, never swallowed.
        fail('backpressure', e);
      }
    }
    // The contract's three fields through rotation-events' builder, then `evidence` — the storm-only
    // superset the contract table names, which the builder itself drops.
    const event = backpressure({ reason: STORM_REASON, since, until: null });
    say(event.type, { ...event.payload, evidence: storm.evidence });
  } else if (ours) {
    try {
      deps.clearBackpressure();
    } catch (e) {
      fail('backpressure', e);
    }
  }
  // Read AGAIN, after this phase's own write and whatever the limits phase wrote: the answer
  // admission obeys is the file's, whoever wrote it. `storm.frozen` stays OR-ed in so a write that
  // failed still freezes this tick — the safe direction, and the one with an event to explain it.
  const frozen = storm.frozen || deps.readBackpressure().active === true;

  // ── 6. admission ──────────────────────────────────────────────────────────────────────
  //
  // At most one launch per tick, and a revival respawn or a rotation counts. All are sessions
  // hitting the API in the same second, which is what `stagger_s` exists to prevent — and none
  // can re-arm the stagger clock, because `setTaskStatus` stamps `last_spawn_at` only on a
  // genuine transition INTO `spawned`. `frozen` is phase 5's reading of the FILE, whoever wrote
  // it — this tick's storm, or phase 1's spend cap.
  if (!launched) {
    try {
      admitNext(deps, cfg, fleet, tasks, history, now, frozen);
    } catch (e) {
      fail('admission', e);
    }
  }

  // ── 7. settlement → the digest trigger ────────────────────────────────────────────────
  //
  // `lastEventTs` is handed over unvalidated on purpose. `settlement` validates it itself, by
  // name and eagerly (`settlement: lastEventTs must be a non-negative finite number`), so a
  // second check here would be a line no mutation could kill — it can only re-throw for inputs
  // the callee already refuses, and it would report the fault against the wrong module.
  const verdict = settlement(fleet, deps.lastEventTs(), now, cfg);
  if (verdict !== null) {
    // `drained` needs no quiet window by design, so an unguarded emit fires on EVERY tick
    // forever: a toast and a digest trigger every 30 s. An announcement is current until a row
    // changes — which is exactly when the fleet has taken on work the last digest did not
    // cover — so `updated` against the last announcement is the whole of the idempotence.
    const changedAt = tasks.reduce((max, t) => (Number.isFinite(t?.updated) && t.updated > max ? t.updated : max), -Infinity);
    if (changedAt > history.announcedAt) {
      say(verdict === 'drained' ? 'FLEET_DRAINED' : 'FLEET_SETTLED', { tasks: tasks.length, verdict });
      deps.notify('soma', `fleet ${verdict}: ${tasks.length} task${tasks.length === 1 ? '' : 's'}`);
    }
  }
}

/**
 * Bring one dead lead back, or give up on it. Returns whether a session was launched.
 *
 * Ordering is the whole of the kill-before-respawn rule and every step of it is forced:
 *
 *   capture → LEAD_DEAD → attempts → killSession → respawn
 *
 * The kill destroys the pane, so the final screen must be read BEFORE it (`logs/<id>.log` is a
 * real file written by `pipe-pane` and survives; the live screen does not). The kill must come
 * AFTER LEAD_DEAD, or the record of why the lead died is gone. And the kill must come at all:
 * `spawnLead` refuses unconditionally while `lead-<id>` exists — which is correct, since
 * silently reusing a session name makes the pane, the log target, the heartbeat and the
 * liveness read ambiguous at once — and `remain-on-exit` means it exists for a *dead* lead too,
 * so without this kill every revival respawn is blocked permanently. `attempts` is stamped
 * before the launch so a launch that throws still counts toward the three.
 */
function revive(deps, cfg, task, history, now, paneState = null) {
  const id = task.id;
  const attempts = task.attempts == null ? 0 : task.attempts;

  // The whole reason `usage` is read per-session: `planRevival` judges `live_context`, which is
  // instantaneous and cannot be summed across a team. `readDirUsage` reports `est_tokens` for a
  // directory and deliberately DELETES `live_context`, so handing it here would look like a
  // good spend number while removing the field the decision turns on — and `est_tokens` is
  // cumulative, 200x larger on a real transcript, which crosses any context-sized threshold in
  // a handful of turns and made "resume first" dead policy.
  const usage = deps.readUsage(task.lead_session_uuid);
  let plan = planRevival(task, usage, cfg);
  // Resume-first needs a session to resume. A row with no recorded uuid has none — reachable
  // when a spawn died between the status claim and the uuid write — and `resumeLead` refuses it
  // outright, so all three attempts would burn on a guaranteed throw.
  if (plan === 'resume' && !(typeof task.lead_session_uuid === 'string' && task.lead_session_uuid !== '')) {
    plan = 'fresh';
  }

  if (plan === 'giveup') {
    // The row stays `spawned` until the orchestrator folds this GAVE_UP into `failed` (that is
    // `bus-tools`' transaction, and one row with two writers is how a field gets clobbered), so
    // without the dedupe this re-toasts every 30 s until the inbox is drained. The dead pane is
    // left standing on purpose: it is the post-mortem `soma peek` shows.
    if (!history.gaveUp.has(id)) {
      deps.appendEvent(ORCH, { type: 'GAVE_UP', payload: { attempts, reason: 'revival attempts exhausted' }, lead: id });
      deps.notify('soma', `${id} gave up after ${attempts} revival attempts`);
    }
    return false;
  }

  // Where the relaunch will go, decided BEFORE anything is spent. Onto an open seat, like every
  // launch (design §4); with every seat closed the row's OWN seat is used, closed as it is — the
  // process starts, hits the limit and arms auto-continue, which is the floor the design rests on,
  // and `seat` on the row stays true.
  //
  // First, not last, and that is a departure from the originally planned ordering with a measured
  // reason: the pick is a pure read, and it can THROW — `seats.pick` and `seatOfRow` both reach
  // `seats.loadSeats`, which refuses a malformed `soma.json` seat entry by name. Run after the
  // kill and the attempt charge, as first planned, that throw landed in `fail('revival', …)`
  // with the pane already destroyed and the attempt already spent, and three such ticks reached
  // GAVE_UP on a config typo. Run here it costs the lead nothing: no death scene, no LEAD_DEAD, no
  // attempt, no kill, and the next tick tries again with the pane still standing. The relaunch
  // below reads `soma.json` again and reaches `seats.loadSeats` through `launch` → `launchRoots`
  // → `seatRoots`, after the kill — which is why the pick reads the pool through `loadSeats`
  // itself, and why `seatsConfigured` counts a `seats` that is not an array as configured: a
  // `{}` read as "no seats" skipped the pick and threw only at that relaunch.
  const launch = seatForRevival(deps, cfg, task, now);

  const tail = String(deps.capturePane(sessionName(id), DEATH_SCENE_LINES) ?? '').slice(-DEATH_SCENE_CHARS);
  deps.appendEvent(ORCH, {
    type: 'LEAD_DEAD',
    payload: {
      attempts,
      plan,
      // Read and deliberately not acted on: `zero_tail_rows` counts trailing assistant rows
      // with no usage reading, which is what a session that died on an API or auth error leaves
      // behind. It moves no verdict (that is `revive.mjs`'s decision, fixed by design §10) but
      // it is precisely the annotation that tells an operator this lead died mid-call.
      zero_tail_rows: usage?.zero_tail_rows ?? null,
      live_context: usage?.live_context ?? null,
      // The census's word for the pane at this tick: `absent` for an ordinary death, `dead_pane`
      // for a claude that exited, `dead_shell` for a pane tmux-resurrect handed to a shell — so an
      // operator reading the log can tell a crash from a corpse-shell. `null` when there was no
      // census this tick.
      pane_state: paneState,
      tail,
    },
    lead: id,
  });

  const attempt = attempts + 1;
  deps.updateFleet((live) => {
    const r = (Array.isArray(live?.tasks) ? live.tasks : []).find((x) => x?.id === id);
    if (r) r.attempts = attempt;
    return true;
  });
  task.attempts = attempt;

  deps.killSession(sessionName(id));

  const res = plan === 'resume' ? deps.resumeLead(task, launch.opts) : deps.spawnLead(task, launch.opts);
  // A FRESH session mints a NEW uuid, so a row still naming the dead one meters a transcript
  // that will never grow again — the missing-uuid defect on the revival path. Written through
  // the transactional path, guarded like `soma_spawn`'s: a spawner that reported no uuid must
  // leave the field alone rather than clobber it, because a clobbered uuid is indistinguishable
  // from the missing one it would be trying to fix.
  recordSession(deps, task, res, { seat: launch.seat });
  deps.appendEvent(ORCH, {
    type: 'REVIVED',
    payload: { plan, attempt, session_uuid: task.lead_session_uuid },
    lead: id,
  });
  return true;
}

/**
 * Record one row's pane reading: write the pane fields on a COARSE transition, announce the two
 * alarm states on entry, announce leaving them, and treat `unobservable` as no reading at all.
 *
 * The transition test is against the persisted `pane_state`, and that field is the whole of the
 * dedupe — no new `orchHistory` case, because a row field survives a blind event stream and a
 * lost fleet write re-emits next tick (duplicate over lost, `events.mjs`'s own direction). Emit
 * first, write second, for the same reason.
 *
 * Written through `updateFleet` and NEVER through `setTaskStatus`, and `updated` is NOT stamped:
 * `updated` is the status-change clock the inbox fold (`decidesFateOf`) and the wall cap read, and
 * a pane reading is not a status change. `readFleet` preserves unknown row fields through a
 * read-modify-write (fleet.mjs:94) and this file is the fields' only writer.
 *
 * `unobservable` is a NON-verdict. It is recorded only when the row holds no verdict yet (so the
 * field exists and renders as unknown), and it never overwrites one: a tmux hiccup mid-dialog
 * must not emit a false RECOVERED and a false re-alarm 30 s later. `unrecognised` IS a reading —
 * the frame was seen and matched nothing — so it transitions like any other, and alarms nothing.
 *
 * The excerpt is the shell's screen or the dialog block, `.slice(-DEATH_SCENE_CHARS)` for the
 * same 4 KiB atomic-append reason as `LEAD_DEAD.tail`. It carries absolute paths (the command
 * behind the dialog's `│` bars), which is why it lives in the event and never in a status row.
 */
function recordPane(deps, task, read, now) {
  const id = task.id;
  if (typeof read.error === 'string' && read.error !== '') {
    deps.appendEvent(ORCH, { type: 'WATCHDOG_ERROR', payload: { where: 'pane_census', error: read.error }, lead: id });
  }
  const prev = typeof task.pane_state === 'string' && task.pane_state !== '' ? task.pane_state : null;
  const next = read.coarse;
  if (next === 'unobservable' && prev !== null) return;
  if (next === prev) return;

  if (prev !== null && PANE_ALARMS.has(prev)) {
    deps.appendEvent(ORCH, { type: 'LEAD_PANE_RECOVERED', payload: { from: prev, to: next }, lead: id });
  }
  if (next === 'blocked_on_prompt') {
    const excerpt = String(read.frame ?? '').slice(-DEATH_SCENE_CHARS);
    deps.appendEvent(ORCH, {
      type: 'LEAD_BLOCKED_ON_PROMPT',
      payload: {
        kind: read.kind,
        since: now,
        status: task.status ?? null,
        cmd: read.cmd,
        title: read.title,
        excerpt,
        why: 'the pane shows a dialog only a human can answer (kind names it: permission, trust, question = an AskUserQuestion the lead is asking you, or unknown). soma attach it, or press Escape at the pane to decline (that also stops the turn, so follow with an instruction). Do NOT soma_send it: the literal is swallowed and the Enter selects the highlighted option — on a permission dialog the "Yes" (measured)',
      },
      lead: id,
    });
    deps.notify('soma', `${id} is blocked on a ${read.kind ?? 'unknown'} prompt in its pane — only a human can answer it (soma attach ${id})`);
  } else if (next === 'dead_shell') {
    // The shell's screen, read now: the census never captures a shell pane on the hot path, and
    // this is the one moment the screen is worth an event. An excerpt that cannot be read must
    // not lose the alarm.
    let excerpt = '';
    try {
      excerpt = String(deps.capturePane(read.name, DEATH_SCENE_LINES) ?? '').slice(-DEATH_SCENE_CHARS);
    } catch {
      excerpt = '';
    }
    const revivable = task.status === 'spawned';
    deps.appendEvent(ORCH, {
      type: 'LEAD_DEAD_SHELL',
      payload: {
        cmd: read.cmd,
        pid: read.pid,
        since: now,
        status: task.status ?? null,
        revivable,
        excerpt,
        why: revivable
          ? 'the pane runs a shell, not claude, so reconcile reads this spawned row as dead this tick: expect LEAD_DEAD, a kill and a respawn. Anything soma_send types into it EXECUTES as a shell command'
          : `the pane runs a shell, not claude, and this row is ${task.status ?? 'in no recorded state'}, so nothing here kills it (the linger reaper's scope). If the work is unfinished: soma_kill it, then re-queue; soma_resume refuses while the pane is live. Anything soma_send types into it EXECUTES as a shell command`,
      },
      lead: id,
    });
    deps.notify('soma', `${id}'s pane is a bare ${read.cmd ?? 'shell'} — the lead is gone${revivable ? '; reviving' : ''}`);
  }

  deps.updateFleet((live) => {
    const r = (Array.isArray(live?.tasks) ? live.tasks : []).find((x) => x?.id === id);
    if (!r) return false;
    r.pane_state = next;
    r.pane_state_since = now;
    r.pane_cmd = read.cmd;
    r.pane_kind = read.kind;
    return true;
  });
  task.pane_state = next;
  task.pane_state_since = now;
  task.pane_cmd = read.cmd;
  task.pane_kind = read.kind;
}

/**
 * Write what a launch minted onto the row, through `updateFleet`.
 *
 * The same transaction shape `soma_spawn` uses (`bus-tools.mjs:1332`), and for the same reason:
 * this row is owned transactionally, and `updated` is deliberately NOT stamped — it is the clock
 * the terminal guard reads, and stamping it here would decline a terminal report filed at or
 * before this write *permanently*, leaving the row `spawned` and its slot held forever.
 *
 * It also clears the launch mark admission's claim wrote: the session now exists, so from this
 * write on the row's liveness is the session's. In the same write as the target, so no reader
 * finds a row that has lost its mark without yet naming its session. A row that carries no mark
 * (a revival, a rotation, a row from before the mark existed) is left exactly as it was.
 */
function recordSession(deps, task, res, extra = {}) {
  const uuid = typeof res?.session_uuid === 'string' && res.session_uuid !== '' ? res.session_uuid : null;
  const target = typeof res?.tmux_target === 'string' && res.tmux_target !== '' ? res.tmux_target : sessionName(task.id);
  // `seat` is written when the caller SAYS where the launch went — a label, or null for the
  // default env — and left alone otherwise; `rotations` likewise. `hasOwn`, so a caller passing
  // `{seat: undefined}` by mistake cannot erase a label the row already carries.
  const writeSeat = Object.hasOwn(extra, 'seat');
  const seat = writeSeat && typeof extra.seat === 'string' && extra.seat !== '' ? extra.seat : null;
  const rotations = Array.isArray(extra.rotations) ? extra.rotations : null;
  deps.updateFleet((live) => {
    const r = (Array.isArray(live?.tasks) ? live.tasks : []).find((x) => x?.id === task.id);
    if (!r) return false;
    if (uuid) r.lead_session_uuid = uuid;
    r.tmux_session = target;
    if (writeSeat) r.seat = seat;
    if (rotations !== null) r.rotations = rotations;
    if (r.launching_at != null) r.launching_at = null;
    return true;
  });
  // Mirrored onto the snapshot so the phases after this one read the row that was published,
  // not the one that was read at the top of the tick.
  if (uuid) task.lead_session_uuid = uuid;
  task.tmux_session = target;
  if (writeSeat) task.seat = seat;
  if (rotations !== null) task.rotations = rotations;
  if (task.launching_at != null) task.launching_at = null;
  return { uuid, target };
}

/**
 * When this lead's FIRST session started — the only clock the wall cap can be judged against.
 *
 * **`task.updated` cannot answer this question, and the two are not the same subject.**
 * `updated` means "when this row's status last changed" (`fleet.mjs:309`) and nothing more, so:
 *
 * - a `spawned → blocked → spawned` round trip re-stamps it, and a lead handed a fresh 8 h wall
 *   cap every time an operator answers it has no wall cap at all; and
 * - on a `blocked` row it is `asked.at`, the moment the lead put its question — which against
 *   the shipped `research` class (`wall_ms` 2 h) is already past the cap the instant phase 4
 *   flips the row, because the flip waits `blocked_slot_minutes` (120) first. Metering blocked
 *   rows off `updated` would convert a silent under-enforcement into a loud over-enforcement
 *   that trips working leads.
 *
 * That is the turn-count units trap in time units: one field, two subjects, and the second one
 * reads perfectly plausible. So the stamp is its own field, written once and moved by nothing —
 * not by a status change, not by an operator's answer, and not by a revival, because the wall
 * cap asks how long the operator has been paying for this task. `readFleet` preserves unknown
 * row fields through a read-modify-write by construction (`fleet.mjs:94`), and this file is the
 * field's only writer, so it cannot meet a two-writers clobber.
 *
 * **Adoption, for a row that predates the field or that `soma_spawn` created between two
 * ticks.** `updated` on a row that is *currently* `spawned` **is** the spawn stamp — that is
 * exactly what `setTaskStatus` guarantees on the transition into `spawned` — so such a row
 * adopts it and is correct from its first metered tick. A row first seen in any other state has
 * no honest start time anywhere on it, and adopting `updated` there would be the very units
 * error this field exists to end, so it adopts `now`: its wall cap starts over once rather than
 * tripping a lead that is answering a human. Bounded to one row, one time.
 *
 * Write-once inside the transaction as well as outside it, so two writers racing cannot move a
 * stamp that is already there.
 */
function startedAtOf(deps, task, now) {
  if (Number.isFinite(task.started_at)) return task.started_at;
  const adopted = task.status === 'spawned' && Number.isFinite(task.updated) ? task.updated : now;
  deps.updateFleet((live) => {
    const r = (Array.isArray(live?.tasks) ? live.tasks : []).find((x) => x?.id === task.id);
    if (!r || Number.isFinite(r.started_at)) return false;
    r.started_at = adopted;
    return true;
  });
  task.started_at = adopted;
  return adopted;
}

/**
 * The breaker and the deviation check for one live lead.
 *
 * Throws rather than shrugging: every refusal reachable from here (`checkBudget`'s missing-cap
 * class, its hand-rolled-usage guard, `tripPath`'s illegal id) means a lead whose breaker cannot
 * be judged, and the caller turns that into a WATCHDOG_ERROR naming this lead.
 */
function meter(deps, cfg, task, history, now) {
  const dir = deps.readDirUsage(deps.leadCwd(task));
  const own = ownSession(dir, task.lead_session_uuid);

  // THE UNITS. `est_tokens` is the DIRECTORY sum, because a lead's teammates spend the
  // operator's money and a lead-only meter was blind to 60.3 % of one real directory's work.
  // `turns` is the LEAD's own, because a lead's turns do not multiply when it delegates — its
  // teammates have their own — and `turn_cap` is calibrated against exactly that (912 directory
  // turns against the lead's own 169, 5.4x, on that same directory). `dir.est_tokens` and
  // `dir.turns` sit on one object and read like siblings of one measurement; they are two
  // different subjects and only one of them is what each cap was sized against.
  const usage = {
    est_tokens: reqNum('tick: readDirUsage().est_tokens', dir?.est_tokens),
    turns: own === null ? 0 : reqNum('tick: the lead session\'s own turns', own.turns),
  };

  // Never `cls ? checkBudget(…) : null`. That ternary short-circuits precisely when no class
  // resolves — the real failure mode, and what the original prototype-pollution bug produced —
  // so `checkBudget`'s own guard never runs and the verdict is silently null: a lead with no
  // breaker at all. `budgetClassOf` binds the fallback class instead, and this announces that, or
  // a pin it passed over, once per lead; if even `standard` is missing, `checkBudget` refuses out
  // loud.
  const { cls, defaulted } = budgetClassOf(deps, cfg, task);
  if (defaulted !== null && !history.defaulted.has(task.id)) {
    deps.appendEvent(ORCH, { type: 'HARNESS_DEFAULTED', payload: defaulted, lead: task.id });
  }
  const caps = { tokens_cap: cls?.tokens_cap ?? null, turn_cap: cls?.turn_cap ?? null, wall_ms: cls?.wall_ms ?? null };

  // `ownSession` returning null has TWO causes and they are not the same subject, which is how
  // one silent 0 came to stand for both. A row WITH a uuid whose session is not in the
  // directory yet is a real, benign state — a lead that has not written a turn — and reads as
  // 0. A row with NO uuid is the missing-uuid defect one layer down: `readDirUsage` is keyed on
  // the *cwd*, so the spend cap and the wall cap are both still measured and this lead is not
  // breakerless — but nothing can attribute a session to it, so its own turn count reads 0
  // forever and `turn_cap` is the one cap that silently stops existing. Said once per lead, off
  // the durable log, in the shape `HARNESS_DEFAULTED` already uses. The message claims only
  // what is true for every class (`turn_cap: 0` enforces nothing anyway), and hands over the
  // cap so an operator can see whether it mattered.
  if (own === null && !(typeof task.lead_session_uuid === 'string' && task.lead_session_uuid !== '')
      && !history.unmeasured.has(task.id)) {
    deps.appendEvent(ORCH, {
      type: 'TURNS_UNMEASURED',
      payload: {
        turn_cap: caps.turn_cap,
        why: 'this row carries no lead_session_uuid, so no transcript in its directory can be attributed to this lead and its own turn count reads 0; the directory spend cap and the wall cap are unaffected',
      },
      lead: task.id,
    });
  }

  // The clock is REQUIRED. Called the 2-arg way, `checkBudget` measured `null` at
  // 10x the wall cap — four of the five classes silently inert. `startedAt` is the row's own
  // first-spawn stamp — never `task.updated`, which is a different subject and restarts the cap
  // on every status change (see `startedAtOf`), and never `fleet.last_spawn_at`, which belongs
  // to whichever lead started most recently and would trip a one-minute-old lead because a
  // sibling started nine hours ago. It is deliberately NOT reset by a revival: the wall cap asks
  // how long the operator has been paying for this task.
  const verdict = checkBudget(usage, cls, { now, startedAt: startedAtOf(deps, task, now) });

  if (verdict === 'trip') {
    // Presence is the whole protocol for `BUDGET_TRIPPED`, so the flag file is also the
    // dedupe. A tripped lead stays over its cap forever; unguarded, this toasts every 30 s
    // for as long as the row exists, which is how a real alarm becomes one people mute.
    if (!deps.tripped(task.id)) {
      deps.tripBudget(task.id);
      deps.appendEvent(ORCH, { type: 'BUDGET', payload: { pct: TRIP_PCT, ...usage, ...caps }, lead: task.id });
      deps.notify('soma', `${task.id} budget tripped: it can report but not act`);
    }
  } else if (verdict === 'warn' && !history.budget.has(task.id)) {
    // No toast: `prompts/orchestrator.md` says a BUDGET at 80 % is usually nothing to do, and
    // the once-per-lead dedupe comes off the durable log. `BUDGET_WARNED` is not a dedupe: the
    // BUDGET event lands on the orchestrator's stream, which the lead never reads, so this flag is
    // the lead's copy — the PreToolUse gate hands the lead a note on its next allowed tool call
    // and renames the flag to `.delivered`. The flag goes FIRST because the logged BUDGET is the
    // dedupe: a write that throws here logs nothing, the throw becomes this lead's WATCHDOG_ERROR,
    // and the next tick tries both again. Logged first, a failed write would be deduped away and
    // the lead never told.
    deps.warnBudget(task.id);
    deps.appendEvent(ORCH, { type: 'BUDGET', payload: { pct: WARN_PCT, ...usage, ...caps }, lead: task.id });
  }

  // Deviation is judged on the LEAD's own session, never the directory's model union: nothing
  // pins a teammate's model, so against the union every lead with a haiku teammate reports
  // MODEL_DEVIATION. And it goes through `tokens.modelDeviation`, never a local regex — the pin
  // is an INFIX (`--model opus` resolves to `claude-opus-5`, so `startsWith` reports every
  // healthy lead as deviating, and `includes` matches across segment boundaries), and a
  // `<synthetic>` row is an auth or API failure rather than a deviation.
  const dev = modelDeviation(own, LEAD_MODEL);
  if (dev.deviated && !history.deviation.has(task.id)) {
    deps.appendEvent(ORCH, {
      type: 'MODEL_DEVIATION',
      payload: { pinned: dev.pinned, last_model: dev.last_model, unexpected: dev.unexpected, synthetic: dev.synthetic },
      lead: task.id,
    });
  }
}

/**
 * Flip a lead that has been waiting on a human past its grace to `blocked`, freeing its slot.
 *
 * Three guards, and each is a copy of one in the bus's fold, added there after a reviewer showed
 * the flip alone can close a LIVE lead:
 *
 * - **Only a `spawned` row.** A `queued` row was never spawned; leaving `done`/`failed`/`skipped`
 *   alone is what stops a stale line in a log from undoing an operator's `soma_kill`; and a row
 *   already `blocked` has nothing to do here. The bus's `FLIPPABLE` set is deliberately NOT
 *   copied: the only flip this function performs is `spawned → blocked`, so a set-membership
 *   test *after* an exact `!== 'spawned'` check is a guard that can never fire — an assertion
 *   about it would be satisfied by the line above it, which is the shape a fix round on this
 *   build shipped once already. The rule is stated here and enforced by the one check that can.
 * - **Only an event newer than the row's own last state change**, and newer than the last
 *   revival. Without the first, a re-delivered question decides a row twice; without the second,
 *   a revival respawn is blocked-flipped on its first tick by the question the *dead* lead
 *   asked, because a revival changes no status and so cannot move `updated`.
 * - **Not if the lead has since finished.** A COMPLETED newer than the question means the lead
 *   is not waiting on anybody, and the row belongs to the bus's fold.
 *
 * And the stamp: `updated` takes the EVENT's time, not the clock. `Date.now()` here puts the row
 * ~30 s ahead of the event that decided it, and then a COMPLETED filed *before* the flip can
 * never decide the row — `decidesFateOf` declines forever, so the slot is free but FLEET_DRAINED
 * and FLEET_SETTLED never fire and the fleet never reports finishing. Reachable whenever the
 * watchdog has lagged past a whole block-and-answer cycle.
 *
 * Not through `setTaskStatus`, which stamps `Date.now()` unconditionally — the same defect — and
 * on a genuine re-entry into `spawned` re-arms the 90 s stagger just as a slot opens.
 */
function releaseBlockedSlot(deps, task, history, now, graceMs) {
  if (task?.status !== 'spawned') return;
  const asked = newestOf(deps.leadEvents(task.id), NEEDS_INPUT);
  if (asked === null) return;
  const done = newestOf(deps.leadEvents(task.id), TERMINAL_EVENTS);
  if (done !== null && done.at > asked.at) return;
  const since = Math.max(
    Number.isFinite(task.updated) ? task.updated : -Infinity,
    history.revivedAt.get(task.id) ?? -Infinity,
  );
  if (asked.at < since) return;
  if (now - asked.at < graceMs) return;

  deps.updateFleet((live) => {
    const r = (Array.isArray(live?.tasks) ? live.tasks : []).find((x) => x?.id === task.id);
    if (!r || r.status !== 'spawned') return false;
    r.status = 'blocked';
    r.updated = asked.at;
    return true;
  });
  task.status = 'blocked';
  task.updated = asked.at;
  deps.appendEvent(ORCH, {
    type: 'BLOCKED',
    payload: { asked_at: asked.at, waited_ms: now - asked.at, grace_ms: graceMs },
    lead: task.id,
  });
}

/**
 * Admit at most one queued task: the version gate, the pause, then `nextAdmission`.
 *
 * The three vetoes sit here together because they answer the same question and an operator
 * reading `soma_status` expects them to. `nextAdmission` already takes the backpressure freeze;
 * the pause belongs beside it, and it is read with the same `=== true` predicate `soma_status`
 * renders — anything looser and the two would disagree about a switch the operator can see.
 */
function admitNext(deps, cfg, fleet, tasks, history, now, frozen) {
  const gate = deps.versionOk();
  if (gate?.ok !== true) {
    // The sketch had `if (deps.versionOk())` with no else: a version bump stalled the whole
    // queue and nothing anywhere said why. Announced once per version rather than once per
    // tick, because the version is what changed and is what the operator has to act on.
    const version = typeof gate?.version === 'string' && gate.version !== '' ? gate.version : 'unknown';
    if (!history.versions.has(version)) {
      deps.appendEvent(ORCH, {
        type: 'VERSION_GATE',
        payload: {
          version,
          tested_min: gate?.min ?? null,
          tested_max: gate?.max ?? null,
          // What the operator can DO, not `soma up --canary`: that cannot pass on this build (its
          // live driver is not built), so naming it sent the operator to a dead end.
          why: 'the nine runtime invariants rest on undocumented Claude Code behaviour and are only established for versions inside tested_claude; admission stays closed until this one is inside it — re-establish the invariants on it by hand (RUNBOOK §10) and widen tested_claude in soma.json, or run a Claude Code inside the range and restart the watchdog (soma down, then soma up)',
        },
        lead: null,
      });
    }
    return;
  }
  // OBEY THE PAUSE. `soma_queue pause` writes the switch and `soma_status` displays it; this is
  // the only consumer whose behaviour is supposed to change, and the sketch never read it — so
  // an operator paused the queue, status faithfully reported it paused, and admission kept
  // spawning. Written and displayed and never obeyed is worse than absent, because the status
  // output actively confirms the operator's false belief.
  if (deps.queuePaused() === true) return;

  const nextId = nextAdmission(fleet, cfg, now, frozen);
  if (nextId === null) return;
  const task = tasks.find((x) => x?.id === nextId);
  if (!task) return;

  // Onto an open seat (design §4). With seats configured and none open the task is HELD, not
  // launched onto the default env: the slot a limit-hit lead just freed would otherwise be
  // refilled onto the account that refused it. No seats configured is today's behaviour.
  //
  // Said ONCE per lead per launch, not silently. It was planned as silent, justified by "SEAT_CLOSED
  // already said why" — which is true of a CLOSED seat and false of an UNVERIFIED one: nothing
  // announces a seat leaving the pool for not being logged in, so an un-provisioned pool (a seat
  // added to soma.json without `claude auth login`, or flags left by an earlier run) stopped the
  // queue with no line anywhere and only `soma status` to show for it. MEASURED: two unverified
  // seats and one queued task produced zero events over three real ticks. Deduped exactly as
  // `rotate()`'s refusals are, off the durable log, so a fleet held for a week says it once and a
  // blind history says nothing at all.
  const seat = seatsConfigured(cfg) ? deps.pickSeat(now, cfg) : null;
  if (seatsConfigured(cfg) && seat === null) {
    if (!saidUnavailable(history, nextId, null)) deps.appendEvent(ORCH, rotationUnavailable({ lead: nextId, why: 'no_open_seat' }));
    return;
  }
  const launchOpts = seat === null ? {} : { configDir: seat.config_dir };

  // Claim first, spawn second — `soma_spawn`'s order, and for its reason: two admitters that
  // check capacity and then separately mark a row can each see a slot and both take it. This is
  // also what stamps `last_spawn_at`, the stagger clock, so nothing below touches that field.
  //
  // The claim carries the LAUNCH MARK, in the same transaction as the status (a nested
  // `setTaskStatus` shares this snapshot and publishes once): the session is the last thing the
  // spawn creates, after a fetch allowed two minutes, and until then a `spawned` row with no
  // session is a dead lead to both status reports. The mark is what says "starting" instead
  // (`fleet.launching`); `recordSession` clears it, and so does the rollback below. Stamped on a
  // fresh reading of the clock rather than the tick's `now`: a revival that threw after a long
  // fetch earlier in this tick leaves admission running minutes after `now`, and an old stamp
  // would spend the grace before this spawn had started.
  const launchAt = deps.now();
  deps.updateFleet((live) => {
    deps.setTaskStatus(nextId, 'spawned');
    const r = (Array.isArray(live?.tasks) ? live.tasks : []).find((x) => x?.id === nextId);
    if (r) r.launching_at = launchAt;
    return true;
  });
  task.status = 'spawned';
  task.launching_at = launchAt;

  let res;
  try {
    res = deps.spawnLead(task, launchOpts);
  } catch (e) {
    // Rolled back the way `soma_spawn` rolls back, with one addition it does not need: `admit`
    // always returns the OLDEST queued row, so a task that can never spawn — a repo missing
    // from soma.json, a worktree that cannot be cut — would sit at the head of the queue
    // refusing to move and every task behind it would never start. Counted, and given up on
    // after the same three attempts a revival gets.
    const attempt = (task.attempts == null ? 0 : task.attempts) + 1;
    // The launch is over, so its mark goes in the same write as the attempt: a row queued again or
    // failed carries no claim to be starting.
    deps.updateFleet((live) => {
      const r = (Array.isArray(live?.tasks) ? live.tasks : []).find((x) => x?.id === nextId);
      if (r) {
        r.attempts = attempt;
        r.launching_at = null;
      }
      return true;
    });
    task.attempts = attempt;
    task.launching_at = null;
    deps.appendEvent(ORCH, { type: 'WATCHDOG_ERROR', payload: { where: 'spawn', error: reason(e), attempt }, lead: nextId });
    if (exhausted(attempt, cfg)) {
      deps.setTaskStatus(nextId, 'failed');
      task.status = 'failed';
      if (!history.gaveUp.has(nextId)) {
        deps.appendEvent(ORCH, { type: 'GAVE_UP', payload: { attempts: attempt, reason: 'spawn failed on every attempt' }, lead: nextId });
        deps.notify('soma', `${nextId} could not be spawned after ${attempt} attempts`);
      }
    } else {
      deps.setTaskStatus(nextId, 'queued');
      task.status = 'queued';
    }
    return;
  }

  // WRITE THE UUID. `readUsage(null)` finds no transcript, reports no spend, and the cap never
  // fires — while the row looks complete, because `status` is `spawned` and every other field is
  // populated. A lead spawned by hand through the bus IS metered, because `soma_spawn` writes
  // the uuid; nothing put it back for one the watchdog admitted, and that asymmetry is invisible
  // from either side alone.
  const { uuid, target } = recordSession(deps, task, res, { seat: seat === null ? null : seat.label });
  deps.appendEvent(ORCH, {
    type: 'SPAWNED',
    payload: { session_uuid: uuid, tmux_target: target, cwd: typeof res?.cwd === 'string' ? res.cwd : null },
    lead: nextId,
  });
}

// ══════════════════════════ the limits phase ══════════════════════════

/**
 * Are seats configured at all? `cfg.seats` absent (or null) and `[]` are no seats: today's
 * behaviour byte for byte. Any OTHER value counts as configured, a non-array included — that is
 * not "no seats", it is a pool `seats.loadSeats` refuses by name, and each caller has to reach
 * that refusal at its pick, before anything is spent. Read as "no seats", a `{}` sent revival
 * seat-blind into a spawner that reads the same value, throws, and does so after the kill.
 */
const seatsConfigured = (cfg) => cfg?.seats != null && (!Array.isArray(cfg.seats) || cfg.seats.length > 0);

/**
 * Phase 1. For every `spawned` row: read the transcript tail, classify it, act.
 *
 *   seat_window | seat_cap → close the row's seat and say SEAT_CLOSED (on a real change); rotate()
 *   spend_cap             → the freeze file and BACKPRESSURE, once per freeze
 *   unobservable, torn    → one WATCHDOG_ERROR per lead per launch (a torn tail hides the newest state)
 *   none | unobservable   → nothing: no pool call, no write, no event
 * then, with seats configured, reopen every closure that has expired and say SEAT_REOPENED once each.
 *
 * `unobservable` on a CLEAN tail is a non-verdict, as it is in the census: a lead that has not
 * written a row yet, a 2.1.220 row with no `quotaLimits` — each is the normal case for some lead
 * on some tick, and an event per tick per such lead is the alarm an operator mutes. A TORN tail
 * (`bad_lines > 0`) is different: the classifier refused to read past a line that would not parse,
 * so the lead is neither known healthy nor known limited, and one line says so (spec §5). `none`
 * is a healthy lead — and a rate_limit row FOLLOWED by a healthy row reads `none`, so a lead Claude
 * Code has already auto-resumed is never killed mid-work.
 *
 * **The stale-row guard.** After a rotation (or any resume — same uuid, same file) the resumed
 * process has written nothing yet, so the tail's newest assistant row is still the pre-rotation
 * `rate_limit` row and the classifier, which reads no timestamp, answers `seat_window` again. Acted
 * on, that would close the NEW seat with the OLD `resetsAt` and rotate a second time on a stale
 * row, until the thrash bound. So a verdict whose deciding row is OLDER than the lead's newest
 * launch (`history.launch`, folded from SPAWNED/REVIVED/ROTATED/ROTATION_FAILED) is skipped: the hit belongs to the
 * process that launch replaced. A row with no parseable timestamp cannot be shown stale and is acted
 * on — every row since 2.1.220 carries one — and a blind history judges nothing stale.
 *
 * Both reads are made for every spawned row, unconditionally — never `rows.length ?
 * classify(rows) : none`. The classifier owns the empty-tail answer, and a ternary here would be
 * the guard-skipping shape the module header forbids.
 *
 * Per-lead work is wrapped and reported as WATCHDOG_ERROR against that lead, the tick's rule: a
 * classifier refusal, a `resetsAt` that is not a number, a seat the pool cannot close, a builder
 * refusing a mis-shaped event — each costs one lead its rotation this tick, not the other nine
 * theirs. Returns whether a session was launched (a rotation is a launch). Whether admission is
 * frozen is NOT returned: phase 5 reads the FILE, which is the one switch `soma status` also reads.
 * `fail` is the tick's `fail(where, e, lead)` closure, threaded here so the revert's refusals
 * (`where: 'revert'`) are said through the one WATCHDOG_ERROR builder and not a literal.
 */
function limitsPhase(deps, cfg, tasks, history, now, census, fail) {
  let didLaunch = false;
  for (const t of tasks) {
    if (t?.status !== 'spawned') continue;
    try {
      const tail = deps.readTail(t.lead_session_uuid);
      const rows = tail.rows;
      const verdict = deps.classifyLimit(rows);
      const kind = verdict?.kind;
      const pane = census === null ? null : (census.get(t.id)?.coarse ?? null);
      if (kind === 'seat_window' || kind === 'seat_cap') {
        // The stale-row guard (doc above): a hit older than this lead's newest launch is the
        // replaced process's, and the resumed one has written nothing yet. `lastAt` is NaN for a
        // row with no parseable timestamp, and no comparison reads NaN as stale.
        const lastAt = lastAssistantAt(rows);
        if ((history.launch.get(t.id)?.at ?? -Infinity) > lastAt) continue;
        // The classifier's contract: `resetsAt` is finite epoch MILLISECONDS on both kinds (it is
        // the one place seconds become milliseconds). Refused by name rather than compared as NaN,
        // which `close()` would floor to five minutes and silently call a closure.
        const resetsAt = reqNum('tick: classifyLimit verdict.resetsAt', verdict.resetsAt);
        const closeReason = kind === 'seat_cap' ? 'seat_cap' : verdict.rateLimitType;
        closeSeatOf(deps, cfg, t, resetsAt, closeReason, now);
        if (!didLaunch && rotate(t, { deps, cfg, history, now, verdict, pane })) didLaunch = true;
      } else if (kind === 'spend_cap') {
        freeze(deps, verdict, now);
      } else if (kind === 'none') {
        // Spec §3.5 step 5: the tick after a rotation judges the resumed lead's first turn. `rows`
        // is the tail this row's verdict was read from; `pane` is the census read rotate() gates on.
        // A revert is a kill and a --resume — a launch — so it counts against the one-per-tick rule.
        if (!didLaunch && revertRotation(deps, cfg, t, rows, history, pane, fail)) didLaunch = true;
      } else if (kind === 'unobservable' && tail.bad_lines > 0) {
        tornTail(deps, history, t, verdict);
      }
    } catch (e) {
      deps.appendEvent(ORCH, { type: 'WATCHDOG_ERROR', payload: { where: 'limits', error: reason(e) }, lead: t.id });
    }
  }
  // With seats configured only: no seats is today's behaviour byte for byte — no pool read, no
  // lock taken every 30 s for a file that does not exist.
  if (seatsConfigured(cfg)) {
    try {
      reopenExpiredSeats(deps, cfg, now);
    } catch (e) {
      deps.appendEvent(ORCH, { type: 'WATCHDOG_ERROR', payload: { where: 'limits', error: reason(e) }, lead: null });
    }
    try {
      reverifySeats(deps, cfg);
    } catch (e) {
      deps.appendEvent(ORCH, { type: 'WATCHDOG_ERROR', payload: { where: 'limits', error: reason(e) }, lead: null });
    }
  }
  return { launched: didLaunch };
}

/**
 * A tail the classifier could not read past (spec §5): one WATCHDOG_ERROR per lead per launch,
 * naming the classifier's own `why`. Deduped off the durable log like ROTATION_UNAVAILABLE — a
 * lead mid-write tears its last line on most ticks — and re-armed by the lead's next launch,
 * because a new session's tail is a new fact. Any WATCHDOG_ERROR the limits phase already filed
 * against this lead since that launch stands in for it: they are one alarm class. A blind history
 * answers "already said", the safe direction.
 */
function tornTail(deps, history, task, verdict) {
  const said = history.limitsErrorAt.get(task.id);
  if (said !== undefined && said >= (history.launch.get(task.id)?.at ?? -Infinity)) return;
  deps.appendEvent(ORCH, { type: 'WATCHDOG_ERROR', payload: { where: 'limits', error: verdict.why }, lead: task.id });
}

/**
 * Reopen every closure that has passed and say SEAT_REOPENED once each. `seats.reopenExpired` is
 * idempotent and returns exactly what it reopened, so the once is the pool's. The event's `seat`
 * is the label soma.json gives the dir, resolved through `loadSeats` — the state row's own label
 * is a courtesy copy and may be null — and the dir's basename for a row soma.json no longer names,
 * so the event still says WHICH seat (the builder refuses an empty one).
 */
function reopenExpiredSeats(deps, cfg, now) {
  const reopened = deps.reopenSeats(now);
  if (!Array.isArray(reopened) || reopened.length === 0) return;
  const configured = seats.loadSeats(cfg);
  for (const row of reopened) {
    const dir = typeof row?.config_dir === 'string' ? row.config_dir : '';
    const label = configured.find((s) => s.config_dir === dir)?.label ?? basename(dir);
    deps.appendEvent(ORCH, seatReopened({ seat: label }));
  }
}

/**
 * Clear `unverified` on every configured seat that reads logged in again — the way back.
 *
 * `rotate()` marks a seat `unverified` when `seatLoggedIn` is not exactly `true`, which INCLUDES
 * `null`: `seats.loggedIn` answers null — could not observe — for a missing, unreadable or
 * malformed `.claude.json`, for a seat root that is a file (ENOTDIR), and for a read that lost a
 * race with `claude` rewriting the file. Refusing to resume into it is right; the flag is how
 * `pick` is told to stop offering it, and there is no other field for "skip this one".
 *
 * **But the flag was a one-way door.** `markUnverified(dir, false)` existed, and was tested, and
 * no caller anywhere in the product ever wrote it: one unreadable moment retired a seat for the
 * life of the fleet, and one across the whole pool stopped admission for good — silently, because
 * the hold below emits nothing and `soma status` is the only surface. MEASURED before this
 * function existed: two configured seats both flagged (both `.claude.json` files present, valid
 * and carrying `oauthAccount`), one queued task, three consecutive real ticks — zero events, zero
 * toasts, zero spawns, the row still `queued`, both flags still set.
 *
 * Three states, kept three: `true` clears the flag (the seat is usable again — the only writer of
 * `false` in the product), `false` leaves it (nobody is logged in; `claude auth login` is the fix
 * and `soma status` names it), `null` leaves it (still could not observe — nothing was learned, so
 * nothing is written). An unreadable pool needs no clause of its own and deliberately does not get
 * one: `readSeatState` answers `{ seats: [], unreadable: true }`, so there is nothing flagged to
 * read a login file for — a `state?.unreadable === true` early return here would be a guard no
 * input can reach, which is worse than absent.
 *
 * The flag is read off the POOL, never off `cfg.seats`, for the same reason: `unverified` lives in
 * `state/seats.json` and a config read would ask every seat on every tick.
 *
 * Cost on a healthy fleet: one lock-free `readSeatState`, no `.claude.json` read and no write,
 * because nothing is flagged. `markUnverified` is a no-op write when the flag already holds the
 * value, so a seat that is genuinely logged out costs one read per tick and no lock.
 */
function reverifySeats(deps, cfg) {
  const state = deps.readSeatState();
  const flagged = (Array.isArray(state?.seats) ? state.seats : [])
    .filter((s) => s?.unverified === true && typeof s.config_dir === 'string' && s.config_dir !== '');
  if (flagged.length === 0) return;
  // Only seats soma.json still names: a row for a dir it dropped is never picked, so clearing its
  // flag would buy nothing and cost a file read. `loadSeats` is reached only when something is
  // flagged, so a malformed seat entry cannot throw on a fleet with nothing to re-verify.
  const configured = new Set(seats.loadSeats(cfg).map((s) => s.config_dir));
  for (const row of flagged) {
    if (!configured.has(row.config_dir)) continue;
    if (deps.seatLoggedIn(row.config_dir) === true) deps.markSeatUnverified(row.config_dir, false);
  }
}

/**
 * When the tail's newest assistant row was written, epoch ms — `NaN` when it carries no parseable
 * `timestamp`, which no comparison reads as stale. Every row since 2.1.220 carries one.
 */
function lastAssistantAt(rows) {
  const list = Array.isArray(rows) ? rows : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    if (r !== null && typeof r === 'object' && !Array.isArray(r) && r.type === 'assistant') {
      return typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
    }
  }
  return NaN;
}

/**
 * Close the seat this row is on, and say so ONCE per real change.
 *
 * SEAT_CLOSED fires when the seat was open (or its closure had lapsed), and when a new verdict
 * EXTENDS a closure already in force — a seven_day hit on a five_hour-closed seat is news — and
 * not when the same rate_limit row is re-read on the next tick, which it will be until Claude
 * Code appends something after it. `resetsAt` in the event is what the API said; the pool applies
 * the five-minute floor and never shortens, so the effective `closed_until` is read back from what
 * `closeSeat` returns rather than assumed. The event is built by `seatClosed`, so a mis-shaped
 * payload is a TypeError this lead's catch reports, never a silently wrong line in the log.
 *
 * A row with no resolvable seat — spawned before this feature, `cfg.seats` empty, or a label
 * soma.json no longer names — closes nothing; `rotate()` still runs for it. One consequence to
 * know: such a lead may be rotated onto the very account it is on (the pool cannot know), hit the
 * limit again, and rotate properly next tick once `seat` is recorded. Bounded by the thrash rule,
 * and it happens once per legacy row.
 *
 * `closedBefore`'s `Number.isFinite(...) && ... > now` is a boundary re-validation and NOTHING
 * PINS IT, deliberately. Measured against the two real deps it cannot change an outcome:
 * `seats.readSeatState` refuses the whole file unless every `closed_until` is a finite number >= 0
 * (`bin/lib/seats.mjs:169`), so the finite check is never false; and `seats.close` floors every
 * closure at `now + MIN_CLOSE_MS` and never shortens one, so `closedAfter` is always greater than
 * a `closed_until` that has lapsed — which makes `> now` and `>= now`, and dropping the clause
 * altogether, all announce exactly the same closures. A test for it would be a test that cannot
 * fail. The clause stays because this function must not depend on another module's validation for
 * its own arithmetic, and it is written down here so the next reader does not mistake the absence
 * of a test for an oversight.
 */
function closeSeatOf(deps, cfg, task, resetsAt, closeReason, now) {
  const seat = seatOfRow(cfg, task);
  if (seat === null) return;
  // Built BEFORE the pool is written, so a mis-shaped payload — a classifier regression emitting
  // `resetsAt` in SECONDS is the live one, and `reqNum` passes it happily — throws before anything
  // is written rather than after. The old order floored the seat to `now + 5 min` and only then
  // refused the event, which was the safe direction but still a write nobody asked for.
  const event = seatClosed({ seat: seat.label, reason: closeReason, resetsAt });
  const state = deps.readSeatState();
  const before = seatIn(state, seat.config_dir);
  const closedBefore = before !== null && Number.isFinite(before.closed_until) && before.closed_until > now ? before.closed_until : null;
  const after = seatIn(deps.closeSeat(seat.config_dir, resetsAt, closeReason, now), seat.config_dir);
  const closedAfter = after !== null && Number.isFinite(after.closed_until) ? after.closed_until : resetsAt;
  // An UNREADABLE pool is a third answer, and it is neither "the seat was open" nor "this is news".
  // `seatIn` cannot tell them apart — it answers null for both — so `closedBefore` was null on
  // every tick and the once-per-change rule never engaged: MEASURED over three real ticks with a
  // corrupt `state/seats.json`, SEAT_CLOSED fired on all three, and because each one advances
  // `history.seatClosedAt` it re-armed `saidUnavailable` and the ROTATION_UNAVAILABLE refusal
  // repeated too. Nothing was written either way (`mutateSeats` hands an unreadable file back
  // unchanged), so the event would have announced a closure the pool does not hold. `rotate()`
  // names `seats_unreadable` once per closure; that is the line, and repairing the file is the fix.
  if (state?.unreadable === true) return;
  if (closedBefore === null || closedAfter > closedBefore) deps.appendEvent(ORCH, event);
}

/** One seat out of a `SeatState`, by config dir, or null. */
const seatIn = (state, dir) => (Array.isArray(state?.seats) ? state.seats.find((s) => s?.config_dir === dir) ?? null : null);

/**
 * The configured seat this row is on, or null: no `seat` on the row, no seats configured, or a
 * label soma.json no longer names. Through `seats.loadSeats`, which resolves `~`, so the dir
 * handed to the pool is the one `state/seats.json` is keyed by — pinned by the `~/seat-a` test.
 */
function seatOfRow(cfg, task) {
  const label = typeof task?.seat === 'string' && task.seat !== '' ? task.seat : null;
  if (label === null || !seatsConfigured(cfg)) return null;
  return seats.loadSeats(cfg).find((s) => s?.label === label) ?? null;
}

/**
 * Has ROTATION_UNAVAILABLE already been said for this lead in THIS closure?
 *
 * A closure begins when the lead's seat last closed or when the lead last got a session
 * (SPAWNED, REVIVED, ROTATED, ROTATION_FAILED — `history.launch`), whichever is later; anything said at or after
 * that stands. A lead with no seat has no closure to key on and is told once per session. A blind
 * history answers "yes" to everything, the safe direction the rest of `orchHistory` takes.
 */
function saidUnavailable(history, id, seat) {
  const said = history.rotationUnavailableAt.get(id);
  if (said === undefined) return false;
  const closure = Math.max(
    seat === null ? -Infinity : (history.seatClosedAt.get(seat) ?? -Infinity),
    history.launch.get(id)?.at ?? -Infinity,
  );
  return said >= closure;
}

/**
 * Move one limit-hit lead to an open seat: design §3.5 steps 1–4, in order, and nothing else.
 *
 * NOT through `revive()`, and this is the whole reason the function exists: a rotation is not a
 * death. It charges no `attempts`, captures no death scene, emits no LEAD_DEAD, and it resumes —
 * never spawns fresh — because the context is the thing being carried across. Returns whether a
 * session was launched.
 *
 * Step 0 is this tick's census: only a pane read as `alive` is killed. A dead pane is revival's
 * (with revival's accounting, and revival lands it on an open seat because this phase closed the
 * refusing one first), a dialog is a human's, and an unobservable or unrecognised pane is left
 * alone this tick — the kill fails closed. The seat is closed either way; the caller did that.
 *
 * Every refusal in steps 1–3 says ROTATION_UNAVAILABLE once per closure (`saidUnavailable`) and
 * leaves the lead where it is, for `autoContinueAtUsageLimit` to recover within its window. Every
 * event goes through the rotation-event builders: a mis-shaped payload is a TypeError the phase
 * reports against this lead, never a silently wrong line.
 */
function rotate(task, { deps, cfg, history, now, verdict, pane }) {
  const id = task.id;
  const from = typeof task.seat === 'string' && task.seat !== '' ? task.seat : null;
  const unavailable = (why) => {
    if (!saidUnavailable(history, id, from)) deps.appendEvent(ORCH, rotationUnavailable({ lead: id, why }));
    return false;
  };

  if (pane !== 'alive') return false;

  // 1. A target. An unreadable pool is named as such, not read as "no seat" — the operator's
  //    fix is different (repair state/seats.json, not wait for a reset).
  if (deps.readSeatState()?.unreadable === true) return unavailable('seats_unreadable');
  let target = deps.pickSeat(now, cfg);
  // 2. Logged in, checked BEFORE the kill: a resume into a dir that is not logged in loads the
  //    session, pollutes the transcript with a fake "Not logged in" turn and exits 1 (measured).
  //    `null` (unreadable .claude.json) is not `true`. Marked `unverified` so the pool stops
  //    offering it (`soma status` then names the `claude auth login` it needs); bounded, so a pool
  //    that ignores the mark is a loud error rather than a spin.
  for (let tries = 0; target !== null && deps.seatLoggedIn(target.config_dir) !== true; tries++) {
    if (tries > (Array.isArray(cfg?.seats) ? cfg.seats.length : 0)) {
      throw new TypeError(`rotate(${id}): pickSeat keeps offering ${target.config_dir} after markSeatUnverified — the pool is not honouring the flag, so no seat can be trusted`);
    }
    deps.markSeatUnverified(target.config_dir, true);
    target = deps.pickSeat(now, cfg);
  }
  if (target === null) return unavailable('no_open_seat');
  // 3. Thrash: three rotations in the last hour, and this one is refused.
  const recent = fleetMod.rotationsWithin(task.rotations, now);
  if (recent.length >= MAX_ROTATIONS_PER_HOUR) return unavailable('thrash');

  // 4. Kill, resume under the target's config dir, record, announce. The kill must come first:
  //    `resumeLead` refuses while `lead-<id>` exists, and `remain-on-exit` keeps it existing.
  deps.killSession(sessionName(id));
  const res = deps.resumeLead(task, { configDir: target.config_dir });
  recordSession(deps, task, res, { seat: target.label, rotations: [...recent, now] });
  deps.appendEvent(ORCH, rotated({ lead: id, from, to: target.label, rateLimitType: verdict.rateLimitType, resetsAt: verdict.resetsAt }));
  return true;
}

/**
 * The org spend cap: freeze admission through the file, and say so ONCE.
 *
 * Once, not every frozen tick as the storm is: the storm re-emits to record a freeze with no end
 * event, but this freeze has a durable start (`since` in the file) and lifts only by `soma thaw`
 * (`clearBackpressure`), which is a human's act — and BACKPRESSURE is URGENT in the bus, so a
 * repeat every 30 s for the days a monthly cap lasts would be a wake every 30 s for days. It
 * reaches the orchestrator by this toast and by its next `soma_inbox` drain; the watchdog types
 * into no pane. Already-active is read off the FILE, so a freeze written by an earlier tick, or
 * by hand, is not re-announced — and an active record of ANY reason stands: a storm's record is
 * the storm branch's to clear when the storm ends, and the cap row is re-read next tick. `until`
 * is null: the org cap carries no reset time (9 of 9 real rows), and `until` is descriptive in
 * any case — nothing expires a freeze by its own clock. Through `writeBackpressure`, which refuses
 * a seconds stamp, and the `backpressure` builder, which pins the payload.
 */
function freeze(deps, verdict, now) {
  if (deps.readBackpressure()?.active === true) return;
  const state = { active: true, reason: verdict.rateLimitType, since: now, until: null };
  deps.writeBackpressure(state);
  deps.appendEvent(ORCH, backpressure({ reason: state.reason, since: state.since, until: state.until }));
  deps.notify('soma', `fleet frozen: ${state.reason} — the organisation's spend cap hits every seat, so admission is closed until an operator lifts it (soma thaw)`);
}

/**
 * Where a revival's launch goes: `{ seat: label|null, opts: {configDir}|{} }`.
 *
 * No seats configured → today's behaviour exactly: `{}` hands the spawner its frozen module env,
 * and the row records `seat: null` — the truth, even for a row that still carries a label from a
 * soma.json that has since lost it. Seats configured → the first open seat in `soma.json` order;
 * with none open, the row's OWN seat, closed as it is, so the lead lands back on the account it
 * was on and `seat` stays true. A row that has no seat either way launches on the default env.
 */
function seatForRevival(deps, cfg, task, now) {
  if (!seatsConfigured(cfg)) return { seat: null, opts: {} };
  // The pool is read HERE, before the pick dep, so a `cfg.seats` the relaunch would refuse is
  // refused at the pick whatever that dep answers: `seats.pick` returns null for an unreadable
  // state/seats.json without reading `cfg.seats` at all, and a null pick on a row with no seat
  // label would otherwise carry a malformed pool past the kill.
  seats.loadSeats(cfg);
  const seat = deps.pickSeat(now, cfg) ?? seatOfRow(cfg, task);
  return seat === null ? { seat: null, opts: {} } : { seat: seat.label, opts: { configDir: seat.config_dir } };
}

// ── the revert (spec §3.5 step 5) ──────────────────────────────────────────────────────

/**
 * A transcript row that is an assistant turn. `readTailRows` pushes `null` for a line `JSON.parse`
 * rejected, which is why the object test is here and not decoration — the torn-row test pins it.
 *
 * The neighbouring `lastAssistantAt` adds `!Array.isArray(r)` and this deliberately does not.
 * MEASURED equivalent on every input either can receive: both are fed rows that came out of
 * `JSON.parse` of one line, and a JSON array cannot carry a named member
 * (`JSON.parse('[1,2]').type` is `undefined`), so the two agree everywhere. A clause no parser and
 * no writer can reach is a clause no test can pin, which is the thing this file is trying to have
 * less of.
 */
const isAssistant = (r) => r !== null && typeof r === 'object' && r.type === 'assistant';
/** The synthetic row a turn that ended on an API error leaves (measured: 200 of 200 carry it). */
const isApiError = (r) => isAssistant(r) && r.isApiErrorMessage === true;
/**
 * When a transcript row was written, epoch ms, or null when the row cannot be placed in time.
 *
 * `Date.parse` of a string, not a strict ISO shape. The strict check was considered and declined:
 * every row Claude Code has written since 2.1.220 carries a full ISO stamp, so it would move no
 * real input and would only turn shapes nothing writes into the loud third state. The `typeof`
 * clause is the half that earns its place — `Date.parse` COERCES, and MEASURED
 * `Date.parse(3000)` is the year 3000 and `Date.parse(2020)` is 1577836800000, so without it a
 * number reads as a confident, wrong, plausible-looking timestamp on either side of the boundary.
 */
const rowAt = (r) => {
  const t = typeof r?.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
  return Number.isFinite(t) ? t : null;
};

/**
 * The config dir behind a seat label, or the sentence saying why there is none.
 *
 * Through `seats.loadSeats`, never `cfg.seats.find(…).config_dir`: the pool is what resolves `~`
 * and refuses `''`, and a raw `~/seat-a` handed to `--resume` is a resume into a directory that
 * does not exist. `loadSeats` throws on a malformed `cfg.seats`; that is a reason, not a crash —
 * the caller turns it into one deduped line and leaves the lead alone.
 */
function seatDirFor(cfg, label) {
  let pool;
  try {
    pool = seats.loadSeats(cfg);
  } catch (e) {
    return { dir: null, error: reason(e) };
  }
  const seat = pool.find((s) => s?.label === label);
  return seat ? { dir: seat.config_dir, error: null } : { dir: null, error: `seat ${show(label)} is not in soma.json.seats` };
}

/**
 * Undo a rotation the new seat rejected. Returns whether a session was launched.
 *
 * Called from the `limits` phase's `none` arm with the same tail `classifyLimit` read, and only
 * there: a `seat_window` is `rotate()`'s, an `unobservable` tail is nobody's evidence. Every guard
 * below returns false without effects, and the order is deliberate — the cheap row facts first,
 * the census gate, the transcript, the seat lookup last, because the lookup is the one that can
 * be wrong in a way worth a line in the log.
 *
 * **The newest LAUNCH must be the rotation, and it must be the one the row is living.** A REVIVED,
 * SPAWNED or ROTATION_FAILED newer than the ROTATED means the row's session is no longer the
 * rotated one
 * (`revive()` relaunches through `seatForRevival`), so an error after it says nothing about the
 * seat the rotation chose — and a ROTATION_FAILED newer than it means this rotation has ALREADY
 * been undone. `launch.to !== task.seat` means the row moved since — the same rotation cannot be
 * undone onto a row that no longer names its target.
 *
 * **Which clause holds which case, measured rather than assumed.** Removing one clause at a time
 * and running `test/watchdog.tick.test.mjs`: without `launch.type !== 'ROTATED'` exactly one test
 * reddens, rv26 — the LANDED-write case, where the ROTATION_FAILED's `to` is the row's seat, the
 * seat guard passes, and the revert would run backwards onto the seat that just rejected the
 * lead. Without `launch.to !== task.seat`, rv25 (the LOST-write case) and rv6 redden. So the lost
 * row write — the thing an earlier commit message and the fold's own comment used to credit to
 * the type clause — is held by the SEAT clause. Both are load-bearing and neither is
 * belt-and-braces; the attribution was the part that was wrong. `history.launch` is the limits
 * phase's fold; `history.blind` is checked before it is read, so the blind object's `launch`
 * entry is never consulted here.
 *
 * **Only a pane the census read as alive is killed** — `rotate()`'s step 0, for the same reason: a
 * dead pane is revival's (with revival's attempt accounting), a dialog is a human's, and an
 * unobservable or unrecognised pane is left alone this tick. The kill fails closed.
 *
 * **Rows are placed in time, and the first post-rotation turn is what is judged.** The boundary
 * is the ROTATED's own stamp, appended after the resume launched, so a row the OLD process wrote
 * cannot land after it. A healthy assistant row after the boundary proves the rotation took, and
 * from then on an API error is what an API error is on any seat — moving a working lead back
 * onto a seat that is still closed because a 529 arrived three hours later would be a false
 * ROTATION_FAILED. A row with no readable timestamp is neither before nor after: it is refused,
 * once, rather than collapsed into "after" (a kill on a guess) or "before" (a real failure
 * hidden) — and that holds for the PROOF row as much as for the deciding one, because collapsing
 * an unplaceable healthy row into "before" is the reading that permits the kill.
 *
 * **The original seat is probed for a login BEFORE the kill** — `rotate()`'s step 2, for the same
 * measured reason: a resume into a dir that is not logged in loads the session, writes a fake
 * "Not logged in" turn and exits 1. `rotate()` answers that by picking another seat; a revert has
 * no other seat to pick — the original is the only place it goes — so the answer is to leave the
 * lead alive where it is and say so. `seatDirFor` cannot stand in for the probe: `loadSeats` reads
 * `soma.json` alone, so the `unverified` mark `state/seats.json` carries is invisible to it.
 *
 * **Fail closed for the kill, open for the lead** (spec §5): a blind stream, an unplaceable row,
 * an original seat gone from soma.json, an original seat nobody is logged in to — nothing is
 * killed, the lead keeps whatever it has, and one `WATCHDOG_ERROR {where:'revert'}` per rotation
 * says what could not be done. The blind case is silent, because `orchHistory`'s blind policy is
 * silence.
 *
 * **A refusal is said through `fail`, the tick's `fail(where, e, lead)` closure** — the one place
 * this file spells a WATCHDOG_ERROR record (`say('WATCHDOG_ERROR', { where, error: reason(e) },
 * lead)`) — threaded in through `limitsPhase` because this function is module-level and `fail`
 * is not. `reason` of a string is the string, so the sentence lands as `payload.error` as written.
 * No literal record is built here.
 *
 * `attempts` is revival's counter and this is not a revival; `rotations` counts rotations the
 * fleet CHOSE and this is the undo of one — counting it would halve the thrash bound for exactly
 * the seat that needs the retries. Neither is touched. `from: null` on the ROTATED is a row that
 * was spawned before seats existed (spec §3.6): its original seat is the frozen default env, and
 * `configDir: undefined` is `resumeLead`'s word for that.
 *
 * Effect order is `rotate()` step 4's: kill → resume → row → event. `resumeLead` refuses while
 * `lead-<id>` exists, so the kill is first; the event is last so a retry after a throw mid-way
 * cannot announce a revert that did not complete (the throw itself reaches the log through the
 * phase's per-lead WATCHDOG_ERROR, and the next tick's reconcile owns a session that is gone).
 * The event goes through `rotationFailed`, so a mis-shaped payload throws here rather than
 * landing in the log.
 */
function revertRotation(deps, cfg, task, rows, history, pane, fail) {
  const id = task.id;
  // Three clauses in this function are kept and are MEASURED UNREACHABLE, marked so a later reader
  // does not mistake unpinned defence for an oversight, and does not read them as load-bearing:
  // this `status` test (the only caller filters `t?.status !== 'spawned'` before the dispatch),
  // `Array.isArray(rows)` below (`tokens.readTailRows` returns `rows: []` for every failure it
  // has, and `classifyLimit` answers `unobservable` — never `none` — for a non-array, so BOTH
  // contracts must break to reach it), and `last === null` below (severed alone it changes
  // nothing: `isApiError(null)` is already false through `isAssistant`'s null guard, which the
  // torn-row test pins). Every OTHER clause here is reachable and has a test that reddens for it.
  if (task.status !== 'spawned') return false;
  if (history.blind) return false;
  const launch = history.launch.get(id);
  if (launch === undefined || launch.type !== 'ROTATED') return false;
  if (typeof task.seat !== 'string' || launch.to !== task.seat) return false;

  const assistant = (Array.isArray(rows) ? rows : []).filter(isAssistant);
  const last = assistant.length > 0 ? assistant[assistant.length - 1] : null;
  if (last === null || !isApiError(last) || last.error === 'rate_limit') return false;
  if (pane !== 'alive') return false;

  // Once per rotation: a refusal stamped at or after the ROTATED has been said; an older one
  // belongs to an earlier rotation. Through the tick's `fail`, never a literal (doc above).
  const refuse = (error) => {
    if ((history.revertRefusedAt.get(id) ?? -Infinity) >= launch.at) return false;
    fail('revert', error, id);
    return false;
  };
  const at = rowAt(last);
  if (at === null) {
    return refuse(`the newest assistant row is an API error (${show(last.error)}) with no readable timestamp, so it cannot be placed before or after the rotation at ${launch.at}; nothing is killed and the lead stays on seat ${show(task.seat)}`);
  }
  if (at <= launch.at) return false;
  // The proof row, and the SAME third state the deciding row gets eight lines up. A healthy
  // assistant turn stamped after the boundary is the rotation having taken, and from there an API
  // error is what an API error is on any seat. A healthy row whose stamp will not parse is neither
  // before nor after: `?? -Infinity` would collapse it into "before", which hides the proof and
  // kills a lead that DID answer on the new seat; `?? Infinity` would collapse it into "after",
  // which hides a real failure. Refused instead, once per rotation — but a READABLE proof still
  // wins, so a tail that carries one stands the revert down quietly rather than spending the line.
  const healthy = assistant.filter((r) => !isApiError(r));
  if (healthy.some((r) => (rowAt(r) ?? -Infinity) > launch.at)) return false;
  if (healthy.some((r) => rowAt(r) === null)) {
    return refuse(`${id} has a healthy assistant row with no readable timestamp, so it cannot be placed before or after the rotation at ${launch.at} and whether the rotation produced a turn cannot be judged; nothing is killed and the lead stays on seat ${show(task.seat)}`);
  }

  const failedSeat = task.seat;
  const original = launch.from;
  const target = original === null ? { dir: undefined, error: null } : seatDirFor(cfg, original);
  if (target.error !== null) {
    return refuse(`cannot revert ${id} from seat ${show(failedSeat)} to its original seat: ${target.error}; nothing is killed and the lead stays where it is`);
  }
  // Logged in, checked BEFORE the kill — `rotate()` step 2's probe (doc above). Three answers and
  // only `true` proceeds: `seats.loggedIn` says `null` for a `.claude.json` it could not read, and
  // a kill on the strength of an unreadable file is the thing the probe exists to prevent. A
  // `dir` of `undefined` is the pre-seats row — the spawner's own frozen env, which is not a seat
  // and has no `.claude.json` of its own to ask about, so it is not asked.
  const loggedIn = target.dir === undefined ? true : deps.seatLoggedIn(target.dir);
  if (loggedIn !== true) {
    const said = loggedIn === false
      ? `nobody is logged in to ${show(target.dir)} (claude auth login there)`
      : `the login state of ${show(target.dir)} could not be read`;
    return refuse(`cannot revert ${id} from seat ${show(failedSeat)} to its original seat ${show(original)}: ${said}, and a resume into a dir that is not logged in loads the session, writes a fake "Not logged in" turn and exits 1; nothing is killed and the lead stays where it is`);
  }

  const why = typeof last.error === 'string' && last.error !== '' ? last.error : 'api_error';
  deps.killSession(sessionName(id));
  deps.resumeLead(task, { configDir: target.dir });
  deps.updateFleet((live) => {
    const r = (Array.isArray(live?.tasks) ? live.tasks : []).find((x) => x?.id === id);
    if (!r) return false;
    r.seat = original;
    return true;
  });
  task.seat = original;
  deps.appendEvent(ORCH, rotationFailed({ lead: id, from: failedSeat, to: original, why }));
  return true;
}

// ══════════════════════════ the real wiring ══════════════════════════

/** `a.b.c` as numbers, or null. Anything with fewer than three parts is not a version here. */
function parseVersion(raw) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(raw ?? ''));
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** -1, 0, 1. Component-wise, so `2.1.9` sorts below `2.1.10` rather than above it. */
const cmpVersion = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
};

/**
 * Is `version` inside `[min, max]`? `null` when the question cannot be asked.
 *
 * Exported for its own test. A bound that will not parse answers `null` rather than `false`, for
 * the reason below: an unaskable question must not close the queue.
 */
export function versionInRange(version, min, max) {
  const v = parseVersion(version);
  const lo = parseVersion(min);
  const hi = parseVersion(max);
  if (v === null || lo === null || hi === null) return null;
  return cmpVersion(v, lo) >= 0 && cmpVersion(v, hi) <= 0;
}

/**
 * The installed `claude` version, read once per process.
 *
 * Once, not per tick: a Claude Code upgrade under a running watchdog is an operator action that
 * warrants `soma down && soma up` anyway, and 2 880 subprocess spawns a day to re-read a
 * constant is not a trade worth making.
 */
let versionOnce;
function claudeVersion() {
  if (versionOnce !== undefined) return versionOnce;
  try {
    versionOnce = execFileSync('claude', ['--version'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
    }).trim();
  } catch {
    versionOnce = null;
  }
  return versionOnce;
}

/**
 * The canary's version gate: `{ok, version, min, max}`.
 *
 * The canary establishes its nine runtime invariants for ONE Claude Code version — every one of
 * them rests on undocumented behaviour, so a bump can silently retire any of them — and this is
 * the coarse standing check between bring-ups.
 *
 * **It fails OPEN when the version cannot be read, and that is a deliberate trade rather than an
 * oversight.** A closed gate stops the whole queue; making that the answer to "we could not run
 * `claude --version`" would stall a fleet over a PATH problem, silently, since the only signal
 * is an absence of spawns. A version soma could not read is `soma doctor`'s finding, and the
 * gate's real backstop is establishing the invariants by hand at bring-up (RUNBOOK §10; `soma up
 * --canary` would be it, but its live driver is not built). When the gate DOES close it says so,
 * once per version, which is the half the sketch left out entirely.
 */
function versionGate() {
  const version = claudeVersion();
  const tested = loadConfig()?.tested_claude;
  const min = tested?.min ?? null;
  const max = tested?.max ?? null;
  const inRange = versionInRange(version, min, max);
  return { ok: inRange !== false, version, min, max };
}

/**
 * Rate-limit evidence per lead — **a documented stub, and the one duty this tick cannot yet do.**
 *
 * `detectStorm` needs `{lead, paneHit, transcriptHit}` per live lead, which means matching real
 * strings in a real pane and a real transcript. Those strings are not established anywhere on
 * this build, and inventing them would be worse than returning nothing: `backpressure.mjs`'s
 * whole asymmetry is that a missed storm costs some retried requests while a FALSE freeze stalls
 * all ten leads and every queued task behind them. A pattern nobody measured is a false-freeze
 * generator.
 *
 * So STORM detection is inert in production until the scraper is built against measured strings,
 * and it is inert *visibly*: this function is named, commented and returns `[]`.
 *
 * What is NOT missing any more — and an earlier version of this comment denied it was missing at
 * all — is the layer downstream: a freeze is a FILE. The tick's backpressure phase writes
 * `state/backpressure.json` through `wd/backpressure.mjs` (all four fields, tmp+rename under the
 * fleet lock), `soma_status` and `soma status` render it three-state, admission obeys the file, and
 * `soma thaw` lifts a spend-cap record — which is how the limits phase's spend-cap freeze holds the
 * queue with no scraper at all. Measured: `detectStorm([])` → `{"frozen":false,"evidence":[]}`, so
 * with this stub the storm branch never writes; the spend-cap writer does not need it. Whoever
 * builds the scraper builds ONLY the scraper.
 */
const paneSignals = () => [];

/** Newest mtime across `events/*.ndjson` — "when did anything last happen", for settlement. */
function lastEventTs() {
  const dir = p('events');
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return 0;                                  // no events dir yet: nothing has ever happened
  }
  let newest = 0;
  for (const name of names) {
    if (!name.endsWith('.ndjson')) continue;
    try {
      const st = statSync(join(dir, name));
      if (st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs;
    } catch { /* vanished mid-scan */ }
  }
  return newest;
}

/**
 * The lead's own working directory — the slug directory its whole team's transcripts land in.
 *
 * Derived exactly as `resumeLead` derives it, from `paths.worktreeDir`, so the meter and the
 * relaunch cannot disagree about which directory is this lead's. A `spawned` row always has a
 * repo (`spawnLead` refuses one without), so a missing one is a broken checkpoint and is named:
 * the caller turns it into a WATCHDOG_ERROR against this lead rather than metering the wrong
 * directory or reporting a confident zero.
 */
function leadCwd(task) {
  const repo = task?.repo;
  if (typeof repo !== 'string' || repo === '') {
    throw new TypeError(`tick: task ${show(task?.id)} has no repo, so its transcript directory cannot be located (got ${show(repo)})`);
  }
  return worktreeDir(repo, task.id);
}

/**
 * Write the BUDGET_TRIPPED flag, creating `leads/<id>/` if the state root has been thinned.
 *
 * Self-healing for the reason `events.mjs` and `fleet.mjs` are: a breaker that failed to write
 * because a directory was missing is a breaker welded open, and it would fail silently — the
 * only symptom is a lead that keeps spending.
 */
function tripBudget(id) {
  writeFlag(tripPath(id));
}

/**
 * Write the BUDGET_WARNED flag the gate hands the lead as its 80% note, with the same self-heal:
 * a warning that failed on a missing directory would leave the lead untold just as silently.
 */
function warnBudget(id) {
  writeFlag(warnPath(id));
}

/** One breaker flag, stamped with the time: one write, and one mkdir first if `leads/<id>/` is gone. */
function writeFlag(fp) {
  const body = `${Date.now()}\n`;
  try {
    writeFileSync(fp, body);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, body);
  }
}

/** Every dep, wired to the real thing. Nothing here is a lambda that quietly does nothing. */
export function realDeps() {
  return {
    loadConfig,
    readFleet: fleetMod.readFleet,
    updateFleet: fleetMod.updateFleet,
    setTaskStatus: fleetMod.setTaskStatus,
    // The PANE predicate, and it may answer null. See `tmux.liveSessions`.
    aliveSessions: () => tmux.liveSessions(),
    // What each pane is RUNNING, for the census; null on the same terms. See `tmux.paneStates`.
    paneStates: () => tmux.paneStates(),
    readDirUsage: (cwd) => readDirUsage(cwd),
    readUsage: (uuid) => readUsage(uuid),
    budgetClassFor,
    appendEvent,
    notify,
    tripBudget,
    warnBudget,
    tripped: (id) => existsSync(tripPath(id)),
    // `undefined` for the spawner's own dep set so its default (`SPAWN_DEPS`/`RESUME_DEPS`) applies,
    // and the options object third: `resumeLead(task, {configDir})` would hand `{configDir}` over
    // as the WIRING and silently replace every real dep with nothing (soma-bus.mjs's own warning).
    spawnLead: (task, opts = {}) => spawnLead(task, undefined, opts),
    resumeLead: (task, opts = {}) => resumeLead(task, undefined, opts),
    killSession: (name) => tmux.killSession(name),
    capturePane: (target, lines) => tmux.capturePane(target, lines),
    leadCwd,
    leadEvents: (id) => readEvents(id),
    orchEvents: () => readEvents(ORCH),
    lastEventTs,
    now: () => Date.now(),
    paneSignals,
    versionOk: versionGate,
    queuePaused,
    // The freeze record, three ways. Wired as the module's own functions (not lambdas) so the smoke
    // test can assert the bus's reader and this writer are ONE module, not two spellings of one path.
    readBackpressure,
    writeBackpressure,
    clearBackpressure,
    // The limits phase. The tail reader is the meter's (`tokens.readTailRows` shares `readUsage`'s
    // locator and byte reader); the pool is `seats.mjs`. Fixed-arity arrows, because `pick` and
    // `close` take a clock a forwarded argument would replace.
    readTail: (uuid) => readTailRows(uuid, { last: TAIL_ROWS }),
    classifyLimit: (rows) => classifyLimit(rows),
    readSeatState: () => seats.readSeatState(),
    pickSeat: (now, cfg) => seats.pick(now, cfg),
    closeSeat: (dir, untilMs, why, now) => seats.close(dir, untilMs, why, now),
    reopenSeats: (now) => seats.reopenExpired(now),
    markSeatUnverified: (dir, flag) => seats.markUnverified(dir, flag),
    seatLoggedIn: (dir) => seats.loggedIn(dir),
  };
}

/**
 * The loop. One tick, then reschedule from a freshly read `tick_ms`.
 *
 * `setTimeout` rather than `setInterval`, so a slow tick delays the next one instead of stacking
 * on top of it — ten leads' transcripts and a tmux round trip can outlast 30 s on a loaded box.
 * `tick_ms` is re-read every time, because editing soma.json mid-run is the documented way to
 * dial a fleet down, and it is floored: a hand-edited `tick_ms: 0` would spin this process at
 * 100 % CPU, which is a worse fault than a slow tick.
 */
function nextDelay(deps) {
  try {
    const raw = deps.loadConfig()?.tick_ms;
    const ms = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof ms === 'number' && Number.isFinite(ms) && ms >= MIN_TICK_MS) return ms;
  } catch { /* an unparseable soma.json must not end the loop */ }
  return DEFAULT_TICK_MS;
}

export function runLoop(deps = realDeps()) {
  const loop = async () => {
    try {
      await tick(deps);
    } catch (e) {
      // The last resort, and it must not throw in turn: a state root that cannot be appended to
      // would otherwise take the loop down through its own error handler.
      try {
        deps.appendEvent(ORCH, { type: 'WATCHDOG_ERROR', payload: { where: 'tick', error: reason(e) }, lead: null });
      } catch { /* nothing left to report it to */ }
    }
    setTimeout(loop, nextDelay(deps));
  };
  loop();
}

// `pathToFileURL`, not a `file://` template: `process.argv[1]` arrives unresolved and a
// mismatch here would be silent in the worst direction — the watchdog started by `soma up`
// would exit immediately having ticked nothing, and `soma-watchdog` would look alive in tmux.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runLoop();
