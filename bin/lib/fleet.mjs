/**
 * `state/fleet.json` — the fleet checkpoint, its lock, and the task state machine.
 *
 * The NDJSON event log is the durable history; this file is the *checkpoint* every
 * process reads to answer "what exists and what is running right now" without
 * replaying it. That makes it the one piece of state written by more than one
 * process — the bus serving orchestrator tool calls and the detached watchdog on
 * its 30 s tick both read-modify-write it — so every mutation runs inside
 * `withFleetLock`, and every publish is tmp+rename so a concurrent reader sees the
 * old checkpoint or the new one, never half of either.
 *
 * Two invariants here are load-bearing for the fleet as a whole:
 *
 * - **A slot frees the moment a lead stops running.** `countActive` counts only
 *   `spawned`. done/failed/blocked/skipped are all "no longer occupying a lead
 *   slot" — with `max_leads: 10` (decision D3), counting a finished or blocked task
 *   as active would wedge the queue after the tenth task and tasks 11+ would never
 *   spawn. `blocked` is deliberately on that list: a lead waiting on a human is not
 *   burning a slot.
 * - **`ID_RE` is the path-traversal guard.** Task ids reach the filesystem as
 *   `leads/<id>/`, `logs/<id>.log`, `events/<id>.ndjson` and `worktrees/<repo>/<id>`,
 *   and reach a shell-adjacent surface as the tmux session name `lead-<id>`.
 *   `enqueue` is the only door into the fleet, so this is the one place that has to
 *   hold the line: an id that is not `^[a-z][a-z0-9-]{0,63}$` never gets in.
 *   Loosening it to admit `/`, `.` or whitespace hands whoever writes the task list
 *   a write outside the state root.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { createFileLock, refuseThenable } from './filelock.mjs';
import { p } from './paths.mjs';

/** The task lifecycle. `spawned` is the only one that occupies a lead slot. */
export const TASK_STATES = new Set(['queued', 'spawned', 'done', 'failed', 'blocked', 'skipped']);

/**
 * Legal task id. Lowercase so the same id means the same thing on macOS's
 * case-insensitive filesystem as on Linux's; no dot and no slash so it cannot climb
 * out of a directory; 64 chars so `worktrees/<repo>/<id>` stays inside PATH_MAX.
 * (JS `$` is end-of-input, not end-of-line, so `"cr-1\n"` is correctly rejected —
 * adding the `m` flag would open exactly that hole.)
 */
const ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

const fleetPath = () => p('state', 'fleet.json');
const lockPath = () => p('state', 'fleet.lock');
/** Wait this long for a live lock holder before giving up. */
const LOCK_TIMEOUT_MS = 5000;
/** Gap between acquisition attempts. Holds are microseconds, so this is generous. */
const LOCK_RETRY_MS = 10;

/**
 * Run `write`; if its parent dir is missing, create it and try exactly once more.
 *
 * Same self-heal as `events.mjs`, for the same reason: a state root that has not
 * been `ensureTree()`d yet — or was wiped out from under a running watchdog —
 * should cost one `mkdir`, not every tick from here on. Costs nothing on the hot
 * path: no probe, just the error the first write returns.
 */
function writeSelfHealing(fp, write) {
  try {
    write();
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    mkdirSync(dirname(fp), { recursive: true });
    write();
  }
}

/**
 * The checkpoint, or an empty fleet if it has never been written.
 *
 * Unlike the event log's reader this does not tolerate a corrupt file. A torn
 * checkpoint read as `{tasks: []}` would be *overwritten* by the next `enqueue`,
 * turning a recoverable file into a lost fleet; failing loudly leaves the bytes on
 * disk to be repaired or rebuilt from `events/`. tmp+rename means the only way to
 * get here is an outside edit.
 */
export function readFleet() {
  let raw;
  try {
    raw = readFileSync(fleetPath(), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { tasks: [], last_spawn_at: null };
    throw e;
  }
  const fleet = JSON.parse(raw);
  if (!fleet || typeof fleet !== 'object' || !Array.isArray(fleet.tasks)) {
    throw new Error(`${fleetPath()} is not a fleet checkpoint (expected an object with a tasks array)`);
  }
  // Spread last so a checkpoint written by a newer soma keeps its unknown fields
  // through a read-modify-write cycle by an older one.
  return { last_spawn_at: null, ...fleet };
}

/** How long a rotation counts toward the watchdog's thrash bound (`MAX_ROTATIONS_PER_HOUR`). */
export const ROTATION_WINDOW_MS = 60 * 60 * 1000;

/**
 * The rotation stamps still inside the window: finite, and newer than `now − window`.
 *
 * A NaN or a string would never age out and would count toward the thrash bound forever, so
 * non-finite entries are dropped rather than kept. A stamp from a fast clock (in the future) is
 * KEPT: a skewed clock must not be a way past the bound. Exactly `now − window` is out. The
 * watchdog counts with this; the import-free bus mirrors the constant.
 */
export const rotationsWithin = (rotations, now = Date.now()) => (Array.isArray(rotations)
  ? rotations.filter((t) => Number.isFinite(t) && t > now - ROTATION_WINDOW_MS)
  : []);

/**
 * How long a launch mark keeps a `spawned` row with no session reading as STARTING rather than
 * dead. It covers, term by term —
 *
 * - 30 s: the wait for the repo lock (`worktree.mjs`'s `LOCK_TIMEOUT_MS`), when this spawn queues
 *   behind another spawn on the same repo that holds it across its own fetch;
 * - 120 s: ONE full git call, the fetch (`worktree.mjs`'s `GIT_TIMEOUT_MS`);
 * - 60 s: everything else — the rest of git, the guard file, the trust mark and its lock, the
 *   settings, and the tmux calls that create the session.
 *
 * It is not the longest launch possible: every git call is allowed its own `GIT_TIMEOUT_MS`, and a
 * launch makes several under the repo lock, `worktree add` (a whole checkout) among them.
 *
 * Both spawn paths claim the row (status `spawned`, `launching_at` stamped, in one transaction)
 * before the session exists, and the session is the LAST thing a spawn creates, so for the whole
 * launch the row looks exactly like a lead that died. The mark says otherwise, and this bounds how
 * long it is believed. Past it, a row that still has no session is treated as dead, as every
 * launching row was for its whole window before the mark. Usually that is a spawner that crashed
 * before recording a session: a lost mark costs one bound of revival latency and never holds a
 * slot. A launch that is only slower than the bound gets the same treatment — a `LEAD_DEAD` and a
 * charged revival attempt every tick until its session appears, `GAVE_UP` after three — and if its
 * session appears between a tick's liveness read and `revive`'s kill, that fresh session is killed
 * and a replacement spawned. Two sessions never run at once: the spawner holds the repo lock across
 * the worktree and the launch, and checks for the session again under it. A literal rather than a
 * sum of the two imports, because the bus imports this module statically and reaches `worktree.mjs`
 * only through its optional spawner import; the relation is pinned in `test/fleet.test.mjs` instead.
 */
export const LAUNCH_GRACE_MS = 30_000 + 120_000 + 60_000;

/**
 * Is this row a lead that is still being launched? `spawned`, carrying a finite `launching_at`, and
 * a mark less than `LAUNCH_GRACE_MS` away from `now`.
 *
 * ONE predicate, read by every reader that would otherwise call such a row dead — `reconcile` (which
 * then leaves it alone), `soma_status` and `soma status` (which then say `starting`) — so the reports
 * and the reviver judge a row by one rule and one bound. It answers only "launching?", never
 * "alive?": a reader asks it once it has found no session, and a live session beats the mark.
 *
 * Away in either direction, because a mark can sit in the future: a clock stepped back after the
 * claim, or a hand-edited stamp. Believed for ever, such a mark would keep the row out of reconcile's
 * reach until the clock caught up — a slot held by nothing. A small step still reads as starting; a
 * backward step larger than the bound falls back to the unmarked reading: a row with no session is dead.
 *
 * Only a claimed `spawned` row is ever launching: the resume paths and blocked -> spawned move a row
 * into `spawned` with its session already up, and they write no mark. No `now` (or a non-finite one)
 * is no grace at all, which is how `reconcile` keeps its old contract for a caller with no clock.
 */
export const launching = (row, now) => row?.status === 'spawned'
  && Number.isFinite(row.launching_at)
  && Number.isFinite(now)
  && Math.abs(now - row.launching_at) < LAUNCH_GRACE_MS;

/**
 * Publish `fleet` atomically.
 *
 * Call this under `withFleetLock` — via `updateFleet`, ideally. The rename only
 * buys atomicity for *readers*; what stops two writers from clobbering each other's
 * read-modify-write is the lock. The pid in the scratch name is belt-and-braces for
 * a caller that skips it anyway (and matches `events.writeCursor`).
 */
export function writeFleet(fleet, now = Date.now()) {
  // `rotations` is pruned to the window on EVERY publish, and only where the field exists: a
  // row from before seats never gains the key (an unknown-field round-trip is not this
  // writer's shape to change), and a row that has it never grows without bound. So an empty
  // list means "no rotation inside the window", never "never rotated" — the last rotation's
  // record is the ROTATED event, not this list.
  for (const t of Array.isArray(fleet?.tasks) ? fleet.tasks : []) {
    if (t && typeof t === 'object' && Array.isArray(t.rotations)) t.rotations = rotationsWithin(t.rotations, now);
  }
  const fp = fleetPath();
  const tmp = `${fp}.${process.pid}.tmp`;
  writeSelfHealing(tmp, () => writeFileSync(tmp, JSON.stringify(fleet, null, 2) + '\n'));
  renameSync(tmp, fp);
}

/**
 * The checkpoint mutex.
 *
 * `filelock.mjs` carries the idiom and the eight rules it rests on — `link(2)` to publish,
 * four owner states, a scratch name nobody can derive, an inode-compared release. Only what
 * is specific to *this* lock is configured here, and each field below is a decision:
 *
 * - **`lockFile` is a function, evaluated once per `withFleetLock` call.** `p()` reads
 *   `$SOMA_HOME` lazily and the tests retarget the state root between calls, so a path
 *   captured at module load would lock a directory the rest of the module has stopped using.
 *   (Once per call, not once per attempt: the retry loop reuses the path it resolved on entry,
 *   which is what keeps one acquisition from wandering between two roots mid-wait.)
 * - **`reentrant`, because `lease.mjs` composes fleet-lock-guarded operations.** A nested
 *   acquire would otherwise queue behind itself, burn the whole timeout and throw. There is
 *   one lock here, so the key is always `null`.
 * - **No `staleMs`, so no age-out — and this is PARKED, not reasoned.** An age-out is a licence
 *   to take a lock away from a *live* pid, so `Infinity` is the safer of two bad options rather
 *   than the right answer, and it is what this lock did before the shared extraction. Be clear
 *   about what it costs, because two tempting arguments for it are false and were measured so:
 *
 *   *"the recycled-pid wedge is `pretrust`'s problem, because its lock outlives a reboot and
 *   this one does not."* It does. `$SOMA_HOME` defaults to `$HOME/.soma` and nothing in this
 *   tree ever removes `state/`, so `fleet.lock` survives a reboot exactly as `.claude.json.lock`
 *   does. A reboot is only an amplifier anyway — pid reuse inside one boot is enough — but it is
 *   the case where the hazard becomes a certainty rather than a chance, because the low pids a
 *   killed watchdog may well have held are handed straight back to system daemons on the way up.
 *
 *   *"`takeOver` clears it the moment the holder is seen to be dead."* Only while the pid still
 *   *reads* dead. Defeating liveness-alone is the entire reason `LOCK_STALE_MS` exists twenty
 *   lines away in `pretrust.mjs`. Measured through this module's own public API: a lock naming a
 *   live-but-unrelated pid is refused at one minute, one hour, one day, thirty days and one
 *   year, and every later acquire fails identically until a person deletes the file.
 *
 *   So the cost of `Infinity` is a wedge only a human can clear, and the reason to accept it for
 *   now is that the alternative failure is worse: a stolen lock is a silent lost update, while a
 *   wedge is loud and recoverable. **The real answer is neither** — it is a per-caller age-out
 *   set *above this caller's maximum legitimate hold* rather than at infinity. A hold here is one
 *   read plus one rename on a 5 s budget, so anything from 60 s up is already absurdly generous
 *   and would bound the wedge. Deferred to its own round rather than smuggled into a refactor.
 * - **`retryMs` is 10 ms, against holds of ~300 µs**, so a waiter costs the holder nothing and
 *   the fleet checkpoint is never the thing a watchdog tick is waiting on.
 * - **The hard-link diagnosis names `SOMA_HOME`,** which is correct *for this lock* and is
 *   exactly why the wording belongs to the caller: `.claude.json.lock` is not under the state
 *   root, and an operator sent to move `$SOMA_HOME` over that one would move the wrong volume.
 */
const lock = createFileLock({
  api: 'withFleetLock',
  label: 'fleet.lock',
  lockFile: () => lockPath(),
  hardLinks: {
    requirement: 'SOMA_HOME must be on a filesystem that supports hard links',
    remedy: 'move SOMA_HOME off this volume',
  },
  timeoutMs: LOCK_TIMEOUT_MS,
  retryMs: LOCK_RETRY_MS,
  reentrant: true,
});

/**
 * Run `fn` with exclusive access to the checkpoint, and return what it returns.
 *
 * The lock is `state/fleet.lock`, holding the owner's pid, hard-linked into place from
 * a scratch file so its name and its contents appear in the same instant (see
 * `filelock.mjs` — an `O_EXCL` create does not, and the gap was a real steal window). A
 * lock whose owner is gone is taken over rather than waited on, because the common way
 * to lose a holder is `soma down` killing a tmux pane mid-write. Release is in a
 * `finally` and unlinks the lock *this* call published rather than whatever holds that
 * name by then, so a throwing `fn` cannot strand the fleet and a holder that lost a race
 * cannot delete its successor's lock on the way out.
 *
 * Re-entrant on purpose: `lease.mjs` composes fleet-lock-guarded operations, and a
 * nested acquire would otherwise queue behind itself, burn the whole timeout and
 * throw. Every acquisition here is synchronous, so within one process "we already
 * hold it" is exactly true — there is no await between acquire and release for
 * another caller to interleave into.
 *
 * Which is also why `fn` may not be async: release happens on the synchronous
 * return, so an async `fn` would unlock at its first await and run the rest of its
 * "protected" work outside the lock. Rejected rather than awaited, because awaiting
 * would make every caller of this synchronous API async.
 */
export const withFleetLock = (fn, opts) => lock.withLock(null, fn, opts);

/** The snapshot the innermost-to-outermost `updateFleet` nest is all sharing. */
let inFlight = null;

/**
 * Read-modify-write the checkpoint under the lock: `mutate` gets the current fleet,
 * mutates it in place, and its return value becomes the result.
 *
 * This is the only safe way to change fleet.json, and the reason it is exported:
 * `readFleet()` → mutate → `writeFleet()` outside the lock silently drops whatever
 * another process committed in between. A `mutate` that throws publishes nothing.
 *
 * Nested calls share one snapshot and publish once, at the outermost level. Giving
 * the inner call its own `readFleet()` would be the same lost update wearing the
 * lock's clothes: the inner publishes F2, the outer then publishes its stale F1 over
 * the top, and a `setTaskStatus` called from inside a mutation vanishes. Sharing the
 * object also means the outer sees the inner's writes — one all-or-nothing
 * transaction, which is what a caller composing two mutations means by it.
 */
export const updateFleet = (mutate) =>
  withFleetLock(() => {
    if (inFlight) return mutate(inFlight);
    inFlight = readFleet();
    try {
      // Refused before the publish, so an async `mutate` cannot commit half of
      // itself on the way to the TypeError.
      const result = refuseThenable('withFleetLock', mutate(inFlight));
      writeFleet(inFlight);
      return result;
    } finally {
      inFlight = null;
    }
  });

/**
 * The command a task's verifier runs: the task's own `verify_hint`, else its repo's in
 * `repos`, else null.
 *
 * Only a string with something besides whitespace in it counts, so the '' of an unfilled
 * template slot or a 42 in a hand-written plan cannot hide the repo's. The one that counts
 * is kept as given, not trimmed: the row records what was sent, and the brief flattens what
 * it renders. The repo has to be a string and an OWN key of a non-array map, because every
 * plain object answers to `constructor`, `toString` and `__proto__` and none of them is a
 * configured repo; and `?.`, because a hand-edited soma.json can hold `"r": null`.
 */
function verifyHintFor(task, repos) {
  const usable = (v) => typeof v === 'string' && v.trim() !== '';
  if (usable(task.verify_hint)) return task.verify_hint;
  const entry = repos !== null && typeof repos === 'object' && !Array.isArray(repos)
    && typeof task.repo === 'string' && Object.hasOwn(repos, task.repo)
    ? repos[task.repo]
    : null;
  return usable(entry?.verify_hint) ? entry.verify_hint : null;
}

/**
 * Add `tasks` to the queue; returns the ids that were queued plus, for each one that
 * was not, why.
 *
 * Invalid and duplicate ids are skipped rather than thrown on — one bad row in a
 * plan of thirty should not cost the other twenty-nine — but they are *reported*,
 * because "enqueued 30" when 4 were dropped is how a fleet quietly runs short. The
 * typeof guard before the regex is not redundant: `ID_RE.test(undefined)` tests the
 * string `"undefined"` and passes.
 *
 * `repos` is soma.json's `repos` map; this module never reads the config itself. A task
 * with no `verify_hint` of its own takes its repo's here, at enqueue, because the row is
 * what both the lead's standing brief and `soma_task` read: resolved once onto the row,
 * the two cannot disagree, and a resume, which rewrites the brief from the same row, gets
 * it too. The cost is that a repo hint added to soma.json later misses rows already queued.
 */
export function enqueue(tasks, { repos } = {}) {
  if (!Array.isArray(tasks)) throw new TypeError(`enqueue: tasks must be an array, got ${typeof tasks}`);
  return updateFleet((fleet) => {
    const have = new Set(fleet.tasks.map((t) => t.id));
    const queued = [];
    const skipped = [];
    for (const t of tasks) {
      const id = t?.id;
      if (typeof id !== 'string' || !ID_RE.test(id)) {
        skipped.push({ id: typeof id === 'string' ? id : null, reason: 'invalid-id' });
        continue;
      }
      if (have.has(id)) {
        skipped.push({ id, reason: 'duplicate' });
        continue;
      }
      const now = Date.now();
      // `?? null` rather than leaving fields undefined: JSON.stringify drops an
      // undefined value, so the record a caller holds would otherwise gain and lose
      // keys across a reload.
      fleet.tasks.push({
        id,
        title: t.title ?? null,
        repo: t.repo ?? null,
        source: t.source ?? {},
        brief: t.brief ?? '',
        status: 'queued',
        base_branch: t.base_branch ?? null,
        budget_class: t.budget_class ?? null,
        verify_hint: verifyHintFor(t, repos),
        // The same class again, as the operator's PIN, and this is its only writer. `budget_class`
        // is for display, and the inbox fold rewrites it to follow the lead's newest harness unless
        // this is set; the watchdog prices the lead at this class first. Two fields because one
        // could not tell a pin from a class the fold derived: after an H1 -> H4 supersede the row
        // read `budget_class: 'standard'` either way.
        budget_override: t.budget_class ?? null,
        lead_session_uuid: null,
        tmux_session: null,
        attempts: 0,
        base_sha: null,
        // The seat pool (account rotation, spec §3.6). No seat until a launch records one; no
        // rotations yet. `null`/`[]` rather than absent, for the reason two comments up: the
        // record a caller holds and the one on disk must have the same keys.
        seat: null,
        rotations: [],
        // No launch in flight. A spawn's claim stamps it and the write that records the session (or
        // the rollback) clears it; see `launching`. `null` rather than absent, as above.
        launching_at: null,
        created: now,
        updated: now,
      });
      have.add(id);
      queued.push(id);
    }
    return { queued, skipped };
  });
}

/**
 * Move one task to `status`.
 *
 * Both failures are loud. An unknown status is a typo that would otherwise make the
 * task invisible to `countActive` and `settlement` alike; an unknown id is a caller
 * bug, since v1 never removes a task from the fleet — and a silent no-op there is
 * how `soma_kill cr-99` reports success having killed nothing. The watchdog tick
 * already wraps itself in a try/catch that logs `WATCHDOG_ERROR`, so a throw here
 * costs one tick, not the loop.
 *
 * A genuine *transition* into `spawned` also stamps `last_spawn_at`, the clock
 * `wd/admission.mjs` gates the 90 s stagger on. This is the one moment in the system
 * that knows a lead just started, and it is already inside the lock — stamping it
 * anywhere else means an unlocked read-modify-write racing this one. The
 * `!wasSpawned` half matters just as much: an idempotent caller re-affirming the
 * status of a live lead (a reconciler, `soma up` re-attaching) would otherwise push
 * the clock to now on every 30 s tick, and a 90 s stagger that never elapses starves
 * admission for as long as one lead is running.
 */
export function setTaskStatus(id, status) {
  if (!TASK_STATES.has(status)) {
    throw new Error(`setTaskStatus(${id}): unknown status ${JSON.stringify(status)}`);
  }
  updateFleet((fleet) => {
    const t = fleet.tasks.find((x) => x.id === id);
    if (!t) throw new Error(`setTaskStatus: unknown task ${JSON.stringify(id)}`);
    const wasSpawned = t.status === 'spawned';
    t.status = status;
    t.updated = Date.now();
    if (status === 'spawned' && !wasSpawned) fleet.last_spawn_at = t.updated;
  });
}

/** Leads currently occupying a slot. Only `spawned` — see the module header. */
export const countActive = (fleet) => fleet.tasks.filter((t) => t.status === 'spawned').length;

/**
 * The next task to spawn — the oldest `queued` one — or null if the fleet is at
 * capacity or has nothing waiting. Enqueue order is priority order.
 *
 * `cfg.max_leads` is required rather than defaulted, and validated rather than
 * coerced. `n >= undefined` is false, so a cfg that lost the key would admit every
 * queued task at once; and `Number(null)`, `Number('')` and `Number([])` are all 0,
 * so blanket coercion turns the same misconfiguration into a fleet that silently
 * never spawns. A fractional cap is rejected too — `2.5` is not "two and a half
 * leads", it is a cap of 3 nobody wrote down. A hand-edited `"10"` in soma.json is
 * the one string worth keeping.
 */
export function admit(fleet, cfg) {
  const raw = cfg?.max_leads;
  const max = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (!Number.isInteger(max) || max < 0) {
    throw new TypeError(`admit: cfg.max_leads must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  if (countActive(fleet) >= max) return null;
  return fleet.tasks.find((t) => t.status === 'queued')?.id ?? null;
}
