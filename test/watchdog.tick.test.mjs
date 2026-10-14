import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyLimit as realClassify, MIN_CLOSE_MS } from '../bin/lib/wd/limit-state.mjs';
import * as fleetMod from '../bin/lib/fleet.mjs';

/**
 * The tick, from the outside.
 *
 * Every test here drives `tick(deps)` with a complete, recording dep set and then asserts on
 * what was *recorded* — which makes every one of them the shape the mutation harness's third
 * blind spot covers (a bare `await tick(deps)` statement that throws leaves every later
 * assertion in the test unexecuted). The corrected harness counts aborted tests as a second
 * kill channel; each guard below was checked against the mutation that should trip it.
 *
 * Two conventions worth knowing before reading:
 *
 * - **`readFleet()` hands back a COPY and `updateFleet` writes the store.** That is what
 *   `fleet.mjs` really does (`readFleet` parses the file fresh; `updateFleet` mutates one
 *   in-flight snapshot under the lock), and it is load-bearing here: a field the tick assigns
 *   to its own snapshot instead of writing through a transaction never reaches `c.store`, so
 *   the "same transactional path `soma_spawn` uses" requirement is measured rather than
 *   assumed.
 * - **`setTaskStatus` is faithful, including the `!wasSpawned` guard on `last_spawn_at`.**
 *   Faking it loosely would make the stagger tests meaningless.
 */
const load = (tag) => import('../bin/soma-watchdog.mjs?' + tag);

/** The tick's own source, for the two pins a behavioural test cannot carry — see the builder-seam test. */
const WD_SRC = readFileSync(new URL('../bin/soma-watchdog.mjs', import.meta.url), 'utf8');

/** The tick's clock (2012-11-13T22:13:20Z): a fixed instant almost three years before the limit fixture's rows. */
const NOW = 1_352_844_800_000;
const MIN = 60_000;

/** A budget class with every cap live, so a mutation cannot pass by hitting a 0-cap. */
const CLASS = { tokens_cap: 1_000_000, turn_cap: 600, wall_ms: 8 * 3600 * 1000 };

const cfgOf = (over = {}) => ({
  max_leads: 10,
  stagger_s: 90,
  tick_ms: 30_000,
  settle_minutes: 30,
  blocked_slot_minutes: 120,
  resume_context_fraction: 0.7,
  resume_context_window: 1_000_000,
  budgets: { standard: { ...CLASS } },
  ...over,
});

/** A fleet row with every field `enqueue` writes, so no test can lean on an absent one. */
const row = (over = {}) => ({
  id: 'a',
  title: null,
  repo: 'r',
  source: {},
  brief: 'do the thing',
  status: 'queued',
  base_branch: null,
  budget_class: null,
  budget_override: null,
  lead_session_uuid: null,
  tmux_session: null,
  attempts: 0,
  base_sha: null,
  seat: null,
  rotations: [],
  launching_at: null,
  created: NOW - 10 * MIN,
  updated: NOW - 10 * MIN,
  ...over,
});

/** One event as `events.mjs` stores it: `ts` is exactly the numeric prefix of `id`. */
const ev = (type, lead, ts, payload = {}) => ({ id: `${String(ts).padStart(13, '0')}-0000`, ts, type, payload, lead });

/** A `readUsage()` reading — every field the two consumers require is present. */
const usage = (over = {}) => ({
  turns: 0, last_model: null, est_tokens: 0, models: [], raw: {}, bad_lines: 0,
  unknown_usage_fields: [], live_context: 0, zero_tail_rows: 0, transcript: null, uuid: null, ...over,
});

/** A `readDirUsage()` aggregate. Note what it does NOT have: `live_context`. */
const dirUsage = (over = {}) => {
  const out = {
    turns: 0, last_model: null, est_tokens: 0, models: [], raw: {}, bad_lines: 0,
    unknown_usage_fields: [], dir: '/w/a', transcripts: 1, transcripts_skipped: 0, sessions: [], ...over,
  };
  delete out.live_context;
  return out;
};

/** A `tmux.paneStates()` record for a live Claude Code pane, as measured (2.1.263, title `✳ …`). */
const livePane = (over = {}) => ({
  dead: false, cmd: '2.1.263', pid: 53105, title: '✳ Claude Code', pane_id: '%3', active: true, panes: [], ...over,
});
/**
 * What tmux-resurrect leaves: `pane_dead=0`, `pane_current_command=zsh` — and the SAVED title,
 * restored with the session: a resurrected ghost `lead-task-1` carries `◐ lead-task-1`, a spinner
 * glyph on a shell (measured 2026-09-07). A shell fixture with an empty title would let a
 * "title first" reordering of the classifier read every resurrected ghost as a working lead.
 */
const shellPane = () => livePane({ cmd: 'zsh', pid: 7955, title: '◐ lead-task-1' });

const RULE = '─'.repeat(80);
/** frame 006: the idle composer, byte-for-byte on the lines the classifier reads. */
const IDLE_FRAME = [RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'].join('\n');
/** frame 138 (2.1.259): the permission dialog. No composer, no status line. */
const PROMPT_FRAME = [
  RULE, ' Bash command', '', '   │ cd /w/a && grep -n x somefile.txt', '   Run grep in specified directory', '',
  " │ grep on 'somefile.txt' after a cd would search a directory that cannot be",
  ' │ determined here, and a Read() deny rule is configured; only you can approve', ' │ running it anyway.', '',
  ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel · Tab to amend',
].join('\n');
/** An AskUserQuestion frame (2.1.263): the live dialog's layout with neutral words, descriptions shortened. */
const QUESTION_FRAME = ['│ May I update the README?', '', '❯ 1. Yes — update the README', '  2. Yes, but show me the diff first', '  3. Not yet — leave the README', '  4. Type something.', RULE, '  5. Chat about this', '', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel'].join('\n');
/** The dialog's every string, quoted in a transcript above a LIVE idle composer. */
const QUOTED_FRAME = ['⏺ The dialog read:', '', '  Do you want to proceed?', '  ❯ 1. Yes', '  Esc to cancel · Tab to amend', '', IDLE_FRAME].join('\n');
/** frame 079/080: what the shell shows once a `sendKeys`-shaped brief has been EXECUTED in it. */
const SHELL_FRAME = 'host% Operator: hello, this is your brief\nzsh: command not found: Operator:\nhost%';

/**
 * The recording harness. `over` replaces individual deps; `fleet` seeds the store.
 *
 * Nothing here is optional-chained on the way into `tick`, because the tick itself must not
 * optional-chain its deps: a phase whose dep is missing has to be a loud TypeError, never a
 * silently skipped duty.
 */
const ctx = (over = {}) => {
  const calls = {
    appendEvent: [], notify: [], spawnLead: [], resumeLead: [], killSession: [], capturePane: [],
    tripBudget: [], warnBudget: [], setTaskStatus: [], readUsage: [], readDirUsage: [], budgetClassFor: [],
    checkBudgetClocks: [], updateFleet: 0, aliveSessions: 0, paneStates: 0, queuePaused: 0, versionOk: 0,
    writeBackpressure: [], clearBackpressure: 0, readBackpressure: 0,
    // The limits phase, plus the options object each launch now carries.
    readTail: [], classifyLimit: [], closeSeat: [], markSeatUnverified: [], seatLoggedIn: [],
    spawnOpts: [], resumeOpts: [], readSeatState: 0, pickSeat: 0, reopenSeats: 0,
  };
  const order = [];
  const store = { last_spawn_at: null, tasks: [], ...(over.fleet ?? {}) };
  // `state/backpressure.json`, as an in-memory record: seeded by `over.backpressure`, replaced by a
  // write, left at `{active: false}` by a clear — exactly what `wd/backpressure.mjs` does on disk.
  let backpressure = over.backpressure === undefined ? { active: false } : over.backpressure;

  const setTaskStatus = (id, status) => {
    calls.setTaskStatus.push([id, status]);
    order.push(`setTaskStatus:${id}:${status}`);
    const t = store.tasks.find((x) => x?.id === id);
    if (!t) throw new Error(`setTaskStatus: unknown task ${JSON.stringify(id)}`);
    const wasSpawned = t.status === 'spawned';
    t.status = status;
    t.updated = NOW;                                    // fleet.mjs stamps Date.now(); NOW is the tick's clock
    if (status === 'spawned' && !wasSpawned) store.last_spawn_at = t.updated;
  };

  const deps = {
    loadConfig: () => (over.cfg ?? cfgOf()),
    readFleet: () => structuredClone(store),
    updateFleet: (mutate) => { calls.updateFleet += 1; order.push('updateFleet'); return mutate(store); },
    setTaskStatus,
    aliveSessions: () => { calls.aliveSessions += 1; return over.alive === undefined ? new Set() : over.alive; },
    // The pane census's listing, derived from `alive` unless a fixture hands one over: every
    // alive session is a live claude pane (`pane_current_command` is the VERSION STRING, never
    // `claude` — measured), and a null `alive` is a null listing, because both come from the same
    // server. `over.panes` replaces it wholesale for the shell / dialog / corpse cases.
    paneStates: () => {
      calls.paneStates += 1;
      if (over.panes !== undefined) return over.panes;
      if (over.alive === null) return null;
      return new Map([...(over.alive ?? new Set())].map((name) => [name, livePane()]));
    },
    readDirUsage: (cwd) => { calls.readDirUsage.push(cwd); order.push(`readDirUsage:${cwd}`); return (over.readDirUsage ?? (() => dirUsage()))(cwd); },
    readUsage: (uuid) => { calls.readUsage.push(uuid); order.push(`readUsage:${uuid}`); return (over.readUsage ?? (() => usage()))(uuid); },
    // Resolved through the config's own `budgets`, exactly as `harness.budgetClassFor` does —
    // so a fixture that retunes a cap in `cfgOf({budgets: …})` retunes the breaker under test
    // instead of quietly leaving a default class in place.
    budgetClassFor: (h) => {
      calls.budgetClassFor.push(h);
      const fromCfg = (hh) => ((over.cfg ?? cfgOf()).budgets?.standard ?? null);
      return (over.budgetClassFor ?? fromCfg)(h);
    },
    appendEvent: (stream, event) => {
      calls.appendEvent.push({ stream, ...event });
      order.push(`event:${event?.type}`);
      return { id: '1', ts: NOW };
    },
    notify: (title, body) => { calls.notify.push([title, body]); },
    tripBudget: (id) => { calls.tripBudget.push(id); order.push(`tripBudget:${id}`); },
    // The 80% flag the gate hands the lead. `over.warnBudget` runs after the call is recorded, so a
    // fixture can make the write throw and still see that it was attempted.
    warnBudget: (id) => { calls.warnBudget.push(id); order.push(`warnBudget:${id}`); (over.warnBudget ?? (() => {}))(id); },
    tripped: (id) => (over.tripped ?? (() => false))(id),
    // `opts` is the seat: `{configDir}` or `{}`. Recorded beside the id, so the existing
    // `deepEqual(calls.spawnLead, ['a'])` assertions keep their shape.
    spawnLead: (t, opts) => {
      calls.spawnLead.push(t.id);
      calls.spawnOpts.push(opts);
      order.push(`spawnLead:${t.id}`);
      return (over.spawnLead ?? ((task) => ({ lead: task.id, session_uuid: `u-${task.id}`, tmux_target: `lead-${task.id}`, cwd: `/w/${task.id}` })))(t, opts);
    },
    resumeLead: (t, opts) => {
      calls.resumeLead.push(t.id);
      calls.resumeOpts.push(opts);
      order.push(`resumeLead:${t.id}`);
      return (over.resumeLead ?? ((task) => ({ lead: task.id, session_uuid: task.lead_session_uuid })))(t, opts);
    },
    killSession: (name) => { calls.killSession.push(name); order.push(`killSession:${name}`); return true; },
    capturePane: (target, lines) => { calls.capturePane.push([target, lines]); order.push(`capturePane:${target}`); return (over.capturePane ?? (() => 'rate limit\nPane is dead'))(target); },
    leadCwd: (t) => `/w/${t.id}`,
    leadEvents: (id) => ((over.leadEvents ?? {})[id] ?? []),
    orchEvents: () => (over.orchEvents ?? []),
    lastEventTs: () => (over.lastEventTs === undefined ? NOW : over.lastEventTs),
    now: () => NOW,
    paneSignals: () => (over.paneSignals ?? []),
    versionOk: () => { calls.versionOk += 1; return over.versionOk === undefined ? { ok: true, version: '2.1.220' } : over.versionOk; },
    queuePaused: () => { calls.queuePaused += 1; return over.queuePaused === undefined ? false : over.queuePaused; },
    readBackpressure: () => { calls.readBackpressure += 1; return structuredClone(backpressure); },
    // Faithful to the real writer's refusals, the >= 1e12 units bound included: a stub that recorded
    // any shape could not fail the "all four fields" tests, and a tick that wrote three fields or a
    // seconds stamp would look correct here and throw in production.
    writeBackpressure: (state) => {
      if (state?.active !== true || typeof state?.reason !== 'string' || state.reason === ''
        || !Number.isFinite(state?.since) || state.since < 1e12
        || !(state?.until === null || (Number.isFinite(state?.until) && state.until >= 1e12))) {
        throw new TypeError(`writeBackpressure: off-shape record ${JSON.stringify(state)}`);
      }
      calls.writeBackpressure.push(state);
      order.push('writeBackpressure');
      backpressure = { active: true, reason: state.reason, since: state.since, until: state.until };
      return backpressure;
    },
    clearBackpressure: () => { calls.clearBackpressure += 1; order.push('clearBackpressure'); backpressure = { active: false }; return backpressure; },
    // The limits phase. The defaults are the quiet fleet: an empty tail, the REAL classifier over
    // it (`unobservable`, nothing torn), and a pool with no seats.
    readTail: (uuid) => { calls.readTail.push(uuid); order.push(`readTail:${uuid}`); return (over.readTail ?? (() => ({ rows: [], bad_lines: 0, transcript: null, uuid })))(uuid); },
    classifyLimit: (rows) => { calls.classifyLimit.push(rows); return (over.classifyLimit ?? realClassify)(rows); },
    readSeatState: () => { calls.readSeatState += 1; return (over.readSeatState ?? (() => ({ seats: [] })))(); },
    pickSeat: (now, cfg) => { calls.pickSeat += 1; order.push('pickSeat'); return (over.pickSeat ?? (() => null))(now, cfg); },
    closeSeat: (dir, untilMs, why, now) => { calls.closeSeat.push([dir, untilMs, why, now]); order.push(`closeSeat:${dir}`); return (over.closeSeat ?? (() => ({ seats: [] })))(dir, untilMs, why, now); },
    reopenSeats: (now) => { calls.reopenSeats += 1; return (over.reopenSeats ?? (() => []))(now); },
    markSeatUnverified: (dir, flag) => { calls.markSeatUnverified.push([dir, flag]); order.push(`markSeatUnverified:${dir}`); return (over.markSeatUnverified ?? (() => ({ seats: [] })))(dir, flag); },
    seatLoggedIn: (dir) => { calls.seatLoggedIn.push(dir); return (over.seatLoggedIn ?? (() => true))(dir); },
  };
  for (const [k, v] of Object.entries(over.deps ?? {})) deps[k] = v;
  return { deps, calls, order, store, task: (id = 'a') => store.tasks.find((t) => t?.id === id), backpressure: () => structuredClone(backpressure) };
};

/** Every event of `type` that was appended, in order. */
const eventsOf = (c, type) => c.calls.appendEvent.filter((e) => e.type === type);
/** The one event of `type`, refusing 0 or 2 — a "the event fired" check that counts. */
const oneEvent = (c, type) => {
  const found = eventsOf(c, type);
  assert.equal(found.length, 1, `expected exactly one ${type}, got ${found.length}: ${JSON.stringify(c.calls.appendEvent.map((e) => e.type))}`);
  return found[0];
};
/**
 * `before` ran, `after` ran, and `before` ran first.
 *
 * The naive `order.indexOf(a) < order.indexOf(b)` is TRUE when `a` never happened at all,
 * because `-1 < n` — a vacuously-green ordering assertion that a mutation deleting the step
 * passes. Both indices are refused before they are compared.
 */
const ranBefore = (order, before, after) => {
  const i = order.indexOf(before);
  const j = order.indexOf(after);
  assert.notEqual(i, -1, `${before} never ran (order: ${order.join(' ')})`);
  assert.notEqual(j, -1, `${after} never ran (order: ${order.join(' ')})`);
  assert.ok(i < j, `${before} must run before ${after} (order: ${order.join(' ')})`);
};

// ════════════════════════ The uuid on the row ════════════════════════

test('admission writes lead_session_uuid onto the ROW, in the same transaction as the status', async () => {
  const { tick } = await load('c20-' + Date.now());
  // THE FIXTURE IS THE POINT. The first sketch hand-wrote `lead_session_uuid: 'u'` on
  // its spawned row, so it supplied exactly what production never does and could not fail on
  // the field's absence. This row is `queued` with the field `null`, which is what
  // `fleet.enqueue` actually writes.
  const c = ctx({ fleet: { tasks: [row({ id: 'a', status: 'queued', lead_session_uuid: null })] } });
  await tick(c.deps);

  assert.deepEqual(c.calls.spawnLead, ['a']);
  assert.equal(c.task().status, 'spawned');
  // Read off `c.store`, which only a write through `updateFleet` can reach. A bare
  // `t.lead_session_uuid = res.session_uuid` on the tick's own snapshot leaves this null —
  // and then `readUsage(null)` finds no transcript, reports no spend, and the token cap never
  // fires while the row looks complete.
  assert.equal(c.task().lead_session_uuid, 'u-a');
  assert.equal(c.task().tmux_session, 'lead-a');
  // One transaction, not two: `soma_spawn` claims and records under the lock for the reason
  // its own comment gives, and a status without a uuid is the state this correction exists
  // to make unreachable.
  ranBefore(c.order, 'setTaskStatus:a:spawned', 'spawnLead:a');
  const spawned = oneEvent(c, 'SPAWNED');
  assert.equal(spawned.lead, 'a', 'the top-level lead field, not just payload.lead: foldEvents reads event.lead');
  assert.equal(spawned.payload.session_uuid, 'u-a');
});

test('a spawner that reports no uuid leaves the field alone rather than clobbering it with null', async () => {
  const { tick } = await load('c20b-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'queued', lead_session_uuid: 'kept' })] },
    spawnLead: () => ({ lead: 'a', tmux_target: 'lead-a', cwd: '/w/a' }),   // no session_uuid
  });
  await tick(c.deps);
  // `soma_spawn` guards its write the same way (`if (uuid) task.lead_session_uuid = uuid`).
  // A clobbered uuid is indistinguishable from the missing-uuid bug this is fixing.
  assert.equal(c.task().lead_session_uuid, 'kept');
  assert.equal(c.task().status, 'spawned');
});

test('recording a session does NOT stamp `updated`, so a terminal event is never stranded', async () => {
  const { tick } = await load('c20c-' + Date.now());
  const c = ctx({ fleet: { tasks: [row({ id: 'a', status: 'queued', lead_session_uuid: null })] } });
  await tick(c.deps);
  // `soma_spawn` leaves `updated` alone in exactly this write, and says why: it is the clock
  // `decidesFateOf` reads, the `spawned` transition already moved it, and stamping it a second
  // time here would decline a terminal report filed at or before this write PERMANENTLY —
  // the row stays `spawned` and its slot is held forever.
  assert.equal(c.task().updated, NOW, 'the status transition stamped it; the uuid write did not');
  // The uuid and the tmux target land in ONE `updateFleet`, so a reader can never see a row
  // carrying the target without the uuid the meter needs. Counted after the spawn: the claim before
  // it is a transaction of its own (the status and the launch mark).
  const spawnedAt = c.order.indexOf('spawnLead:a');
  assert.notEqual(spawnedAt, -1, `the lead was never spawned (order: ${c.order.join(' ')})`);
  assert.equal(c.order.slice(spawnedAt).filter((x) => x === 'updateFleet').length, 1);
  assert.equal(c.calls.updateFleet, 2, 'the claim and the record, and nothing else');
});

// ════════════════════════ The launch mark ════════════════════════

test('admission marks the launch in the claim\'s own transaction, and the write that records the session clears it', async () => {
  const { tick } = await load('l48a-' + Date.now());
  let seen = null;
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'queued' })] },
    // The row as any reader finds it while the spawner fetches, cuts the worktree and starts tmux.
    spawnLead: (task) => {
      seen = structuredClone(c.task('a'));
      return { lead: task.id, session_uuid: 'u-a', tmux_target: 'lead-a', cwd: '/w/a' };
    },
  });
  // Which transaction each status write ran inside, and what each transaction left behind.
  let depth = 0;
  const commits = [];
  const depths = [];
  const inner = c.deps.updateFleet;
  c.deps.updateFleet = (mutate) => {
    depth += 1;
    try {
      return inner(mutate);
    } finally {
      depth -= 1;
      commits.push(structuredClone(c.task('a')));
    }
  };
  const set = c.deps.setTaskStatus;
  c.deps.setTaskStatus = (id, st) => { depths.push([st, depth]); return set(id, st); };
  await tick(c.deps);

  assert.deepEqual(c.calls.spawnLead, ['a']);
  assert.equal(seen?.status, 'spawned', 'the spawner runs against a claimed row');
  assert.equal(seen?.launching_at, NOW, 'and the claim already carries the mark, on the watchdog\'s clock');
  // One transaction. A status write with the mark following separately leaves a moment in which the
  // row is spawned, unmarked and sessionless: a dead lead to every reader.
  assert.deepEqual(depths, [['spawned', 1]]);
  assert.equal(commits[0].status, 'spawned');
  assert.equal(commits[0].launching_at, NOW);
  // Cleared by the write that records the session, never before it: the row is marked right up to
  // the moment it names the session that replaces the mark.
  const recorded = commits.findIndex((x) => x.lead_session_uuid === 'u-a');
  assert.ok(recorded > 0, `the uuid is written by a transaction after the claim (commits: ${JSON.stringify(commits)})`);
  assert.equal(commits[recorded - 1].launching_at, NOW);
  assert.equal(commits[recorded].launching_at, null);
  assert.equal(c.task().launching_at, null);
  assert.equal(c.task().tmux_session, 'lead-a');
});

test('the claim stamps its mark from a fresh reading of the clock, not the tick\'s: a phase that ran long first must not spend the grace', async () => {
  const { tick } = await load('l48e-' + Date.now());
  // A clock that moves a minute per reading, so the tick's `now` (its first reading) and the one taken
  // at the claim differ. A revival that threw after a two-minute fetch is the real way this happens.
  const readings = [];
  let clock = NOW;
  let seen = null;
  let latest = null;
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'queued' })] },
    spawnLead: (task) => {
      seen = c.task('a').launching_at;
      latest = readings.at(-1);
      return { lead: task.id, session_uuid: 'u-a', tmux_target: 'lead-a', cwd: '/w/a' };
    },
    deps: { now: () => { clock += MIN; readings.push(clock); return clock; } },
  });
  await tick(c.deps);
  assert.deepEqual(c.calls.spawnLead, ['a']);
  assert.ok(Number.isFinite(seen) && seen > readings[0], `stamped after the tick's own now (${readings[0]}), got ${seen}`);
  assert.equal(seen, latest, 'the reading taken at the claim, the last one before the spawner ran');
});

test('a spawn that fails clears the mark in its rollback, whether the task is queued again or given up on', async () => {
  for (const [attempts, after] of [[0, 'queued'], [2, 'failed']]) {
    const { tick } = await load(`l48b-${attempts}-` + Date.now());
    let seen = null;
    const c = ctx({
      fleet: { tasks: [row({ id: 'a', status: 'queued', attempts })] },
      spawnLead: () => {
        seen = c.task('a').launching_at;
        throw new Error('fetch timed out');
      },
    });
    await tick(c.deps);
    assert.equal(seen, NOW, `${after}: the claim marked the row before the spawner ran`);
    assert.equal(c.task().status, after);
    assert.equal(c.task().attempts, attempts + 1);
    assert.equal(c.task().launching_at, null, `${after}: nothing is starting, so nothing may say so`);
  }
});

test('a spawned row with a fresh mark and no session is a lead still starting: no LEAD_DEAD, no kill, no respawn', async () => {
  const { tick } = await load('l48c-' + Date.now());
  // `soma_spawn` claimed this row thirty seconds ago and is still fetching, outside the fleet lock,
  // when the tick lands. Read as dead, the lead would be killed and spawned a second time under the
  // spawner that is still starting it, and charged a revival attempt for the privilege.
  const c = ctx({ fleet: { tasks: [row({ id: 'a', status: 'spawned', updated: NOW - 30_000, launching_at: NOW - 30_000 })] } });
  await tick(c.deps);
  assert.deepEqual(eventsOf(c, 'LEAD_DEAD'), []);
  assert.deepEqual(c.calls.killSession, []);
  assert.deepEqual(c.calls.spawnLead, []);
  assert.deepEqual(c.calls.resumeLead, []);
  assert.equal(c.task().attempts, 0);
  assert.equal(c.task().status, 'spawned');
  assert.equal(c.task().launching_at, NOW - 30_000, 'the mark is the spawner\'s to clear, not the tick\'s');
});

test('the same row with an expired mark IS revived: past the bound, a row whose spawner never recorded a session is treated as dead', async () => {
  const { tick } = await load('l48d-' + Date.now());
  const G = fleetMod.LAUNCH_GRACE_MS;
  const c = ctx({ fleet: { tasks: [row({ id: 'a', status: 'spawned', updated: NOW - 5 * MIN, launching_at: NOW - G })] } });
  await tick(c.deps);
  assert.equal(oneEvent(c, 'LEAD_DEAD').lead, 'a');
  assert.deepEqual(c.calls.killSession, ['lead-a']);
  assert.deepEqual(c.calls.spawnLead, ['a'], 'no uuid on the row, so the revival is fresh');
  assert.equal(c.task().attempts, 1);
  assert.equal(c.task().launching_at, null, 'the revival records a session, and recording clears the stale mark');
});

// ════════════════════════ The queue pause ════════════════════════

test('the queue pause vetoes admission, and the control proves the spawner was not simply broken', async () => {
  const { tick } = await load('c21-' + Date.now());
  const fleet = () => ({ tasks: [row({ id: 'a', status: 'queued' })] });
  // Paused: a queued row, a free slot, no storm, nothing else in the way.
  const paused = ctx({ fleet: fleet(), queuePaused: true });
  await tick(paused.deps);
  assert.deepEqual(paused.calls.spawnLead, [], 'a paused queue must not spawn');
  assert.equal(paused.task().status, 'queued');
  assert.ok(paused.calls.queuePaused > 0, 'the flag has to be READ, not merely written and displayed');
  // The control. Without it the test cannot tell a working pause from a spawner that never
  // fires for any reason — which is how a veto that is really a no-op passes.
  const open = ctx({ fleet: fleet(), queuePaused: false });
  await tick(open.deps);
  assert.deepEqual(open.calls.spawnLead, ['a'], 'the same fixture with the flag clear must spawn');
});

test('the pause is read with the same === true predicate soma_status renders', async () => {
  const { tick } = await load('c21b-' + Date.now());
  // `soma_status` shows `(await deps.queuePaused()) === true`. If the tick vetoed on
  // truthiness instead, a reader answering the string 'false' would freeze admission while
  // status rendered `queue_paused: false` — the same written-and-displayed-but-not-obeyed
  // defect, inverted and harder to see. `queue.mjs` answers a strict boolean so the two agree.
  const truthy = ctx({ fleet: { tasks: [row({ id: 'a', status: 'queued' })] }, queuePaused: 'false' });
  await tick(truthy.deps);
  assert.deepEqual(truthy.calls.spawnLead, ['a'], "a non-boolean is not a pause; the reader's type is what makes this safe");
});

// ════════════════════════ The breaker ════════════════════════

test('checkBudget is ALWAYS called — a null budget class defaults and announces, never short-circuits', async () => {
  const { tick } = await load('c3-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', harness: 'H1' })] },
    alive: new Set(['lead-a']),
    budgetClassFor: () => null,                                   // the prototype-pollution outcome
    readDirUsage: () => dirUsage({ est_tokens: 2_000_000, sessions: [usage({ uuid: 'u', turns: 3 })] }),
  });
  await tick(c.deps);
  // `cls ? checkBudget(...) : null` would leave `verdict` null here: no trip, no event, no
  // toast, and a lead running with no breaker in a fleet whose whole safety model is that
  // breaker. The class is bound to `standard` and the substitution is recorded.
  const defaulted = oneEvent(c, 'HARNESS_DEFAULTED');
  assert.equal(defaulted.lead, 'a');
  assert.equal(defaulted.payload.budget_class, 'standard');
  assert.deepEqual(c.calls.tripBudget, ['a'], 'the defaulted class must still trip at 2x its cap');
  assert.equal(oneEvent(c, 'BUDGET').payload.pct, 100);
  assert.equal(c.calls.notify.length, 1);
});

test('a class that cannot be defaulted either is a loud WATCHDOG_ERROR, never a silent null verdict', async () => {
  const { tick } = await load('c3b-' + Date.now());
  const c = ctx({
    cfg: cfgOf({ budgets: {} }),                                  // no standard to fall back to
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u' })] },
    alive: new Set(['lead-a']),
    budgetClassFor: () => null,
    readDirUsage: () => dirUsage({ est_tokens: 9e9, sessions: [usage({ uuid: 'u', turns: 3 })] }),
  });
  await tick(c.deps);
  // `checkBudget`'s own refusal reaches the log instead of being swallowed. It names this
  // lead, and the other nine are still metered — a throw that ended the tick would take
  // admission and settlement down with it.
  const err = oneEvent(c, 'WATCHDOG_ERROR');
  assert.equal(err.lead, 'a');
  // Matched on the WHOLE refusal, not on `/budget class/`. `checkBudget` has two refusals and
  // the other one — `no enforceable cap on this budget class (…)` — contains that phrase too,
  // so the loose pin is satisfied by a mutation that changes WHICH guard fired. The assertion
  // spy cannot see this: the decoy is in a sibling message rather than inside this subject.
  assert.match(err.payload.error, /checkBudget: budget class must be an object/);
  assert.doesNotMatch(err.payload.error, /no enforceable cap/);
  assert.deepEqual(c.calls.tripBudget, [], 'nothing is tripped on a verdict nobody could reach');
});

test('one unmeterable lead does not stop the other nine', async () => {
  const { tick } = await load('c3c-' + Date.now());
  const c = ctx({
    fleet: { tasks: [
      row({ id: 'a', status: 'spawned', lead_session_uuid: 'ua' }),
      row({ id: 'b', status: 'spawned', lead_session_uuid: 'ub' }),
    ] },
    alive: new Set(['lead-a', 'lead-b']),
    readDirUsage: (cwd) => {
      if (cwd === '/w/a') throw new Error('EIO reading a half-rotated transcript');
      return dirUsage({ est_tokens: 1_000_000, sessions: [usage({ uuid: 'ub', turns: 3 })] });
    },
  });
  await tick(c.deps);
  assert.equal(oneEvent(c, 'WATCHDOG_ERROR').lead, 'a');
  assert.deepEqual(c.calls.tripBudget, ['b'], "b's breaker still fires");
});

test('checkBudget receives a clock, so the four wall-capped classes are not silently inert', async () => {
  const { tick } = await load('c2-' + Date.now());
  const spawnedAt = NOW - 9 * 3600 * 1000;                        // 9h into an 8h wall cap
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', updated: spawnedAt })] },
    alive: new Set(['lead-a']),
    // Under every other cap: 1 token of 1,000,000 and 3 turns of 600. Only the wall can trip.
    readDirUsage: () => dirUsage({ est_tokens: 1, sessions: [usage({ uuid: 'u', turns: 3 })] }),
  });
  await tick(c.deps);
  // Called the 2-arg way, `checkBudget` measured `null` at 10x the cap. This assertion is
  // the whole of that fix: the trip can only come from the wall, so it can only come
  // from a clock having been passed.
  assert.deepEqual(c.calls.tripBudget, ['a']);
  assert.equal(oneEvent(c, 'BUDGET').payload.pct, 100);
});

test('the wall clock starts at the row\'s own spawn stamp, not at the fleet\'s', async () => {
  const { tick } = await load('c2b-' + Date.now());
  const c = ctx({
    fleet: {
      // `last_spawn_at` is the FLEET's stagger clock and belongs to whichever lead started
      // most recently; reading it as this lead's start would trip a lead that began minutes
      // ago because a sibling started nine hours back, and would never trip the sibling.
      last_spawn_at: NOW - 9 * 3600 * 1000,
      tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', updated: NOW - 1 * MIN })],
    },
    alive: new Set(['lead-a']),
    readDirUsage: () => dirUsage({ est_tokens: 1, sessions: [usage({ uuid: 'u', turns: 3 })] }),
  });
  await tick(c.deps);
  assert.deepEqual(c.calls.tripBudget, [], 'one minute old is not nine hours old');
  assert.deepEqual(eventsOf(c, 'BUDGET'), []);
});

// ════════════════════════ Per-lead turns ════════════════════════

test('turn_cap is judged on the LEAD\'s own turns, never the directory sum', async () => {
  const { tick } = await load('c14-' + Date.now());
  // The cheapest fixture that fails on exactly this mistake and nothing else: a lead plus two
  // teammates whose DIRECTORY sum (700) is over `turn_cap` while the lead's own count (200)
  // is not. Measured about five times apart on one real directory — against the directory
  // sum a 600 cap fires at roughly a hundred lead turns, below a typical ticket's own count.
  const c = ctx({
    cfg: cfgOf({ budgets: { standard: { tokens_cap: 1e12, turn_cap: 600, wall_ms: 0 } } }),
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'lead-uuid' })] },
    alive: new Set(['lead-a']),
    readDirUsage: () => dirUsage({
      turns: 700,                                                 // the trap: it sits right there and reads correct
      est_tokens: 1,
      sessions: [
        usage({ uuid: 'mate-2', turns: 300 }),
        usage({ uuid: 'lead-uuid', turns: 200 }),
        usage({ uuid: 'mate-1', turns: 200 }),
      ],
    }),
  });
  await tick(c.deps);
  assert.deepEqual(c.calls.tripBudget, [], 'a lead\'s teammates have their own turns; they do not multiply its');
  assert.deepEqual(eventsOf(c, 'BUDGET'), []);
});

test('the lead\'s own turns DO trip the cap, so the reader is not merely reporting zero', async () => {
  const { tick } = await load('c14b-' + Date.now());
  // The control for the test above. Without it, a tick that read `turns` as a constant 0
  // would pass that one — a backstop welded open looks exactly like one correctly ignoring
  // the directory sum.
  const c = ctx({
    cfg: cfgOf({ budgets: { standard: { tokens_cap: 1e12, turn_cap: 600, wall_ms: 0 } } }),
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'lead-uuid' })] },
    alive: new Set(['lead-a']),
    readDirUsage: () => dirUsage({
      turns: 10,                                                  // the directory sum is UNDER the cap here
      est_tokens: 1,
      sessions: [usage({ uuid: 'lead-uuid', turns: 600 }), usage({ uuid: 'mate-1', turns: 1 })],
    }),
  });
  await tick(c.deps);
  assert.deepEqual(c.calls.tripBudget, ['a']);
  assert.equal(oneEvent(c, 'BUDGET').payload.turns, 600);
});

test('a lead with no transcript yet reads as 0 turns, never the newest session\'s', async () => {
  const { tick } = await load('c14c-' + Date.now());
  const c = ctx({
    cfg: cfgOf({ budgets: { standard: { tokens_cap: 1e12, turn_cap: 600, wall_ms: 0 } } }),
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'not-in-dir' })] },
    alive: new Set(['lead-a']),
    // The directory holds a teammate 999 turns deep and nothing for this lead. `find` returning
    // undefined is a real state — a lead that has not written a turn, or one just respawned onto
    // a fresh uuid — and it must read as no measurement. Falling back to `sessions[0]` (the
    // newest transcript, which is the plausible-looking shortcut) prices the lead against
    // whichever teammate wrote most recently.
    readDirUsage: () => dirUsage({ turns: 999, est_tokens: 5, sessions: [usage({ uuid: 'someone-else', turns: 999 })] }),
  });
  await tick(c.deps);
  assert.deepEqual(eventsOf(c, 'WATCHDOG_ERROR'), [], "`find` returning undefined is a real state, not a crash");
  assert.deepEqual(c.calls.tripBudget, []);
  assert.deepEqual(eventsOf(c, 'BUDGET'), []);
  // And it is a real state rather than a defect, so it must stay SILENT. The row carries a
  // uuid; only the uuid-less row is announced (below), and an announcement fired on `own ===
  // null` alone would cry over every lead in its first thirty seconds.
  assert.deepEqual(eventsOf(c, 'TURNS_UNMEASURED'), []);
});

test('a null uuid matches no session, even one whose own uuid reads null', async () => {
  const { tick } = await load('c14e-' + Date.now());
  const c = ctx({
    cfg: cfgOf({ budgets: { standard: { tokens_cap: 1e12, turn_cap: 600, wall_ms: 0 } } }),
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: null })] },
    alive: new Set(['lead-a']),
    // `null === null` is true, so a `find` with no type guard in front of it pairs a row that
    // has no session with a reading that has no uuid — and prices the lead against it.
    readDirUsage: () => dirUsage({ turns: 999, est_tokens: 5, sessions: [usage({ uuid: null, turns: 999 })] }),
  });
  await tick(c.deps);
  assert.deepEqual(c.calls.tripBudget, []);
  assert.deepEqual(eventsOf(c, 'BUDGET'), []);
});

test('a spawned row whose uuid was never written still meters the directory, at 0 lead turns', async () => {
  const { tick } = await load('c14d-' + Date.now());
  // This is the uuid-on-the-row bug state seen from the other side, and it is the row shape the
  // meter has to survive: `status: 'spawned'`, every other field populated, `lead_session_uuid`
  // null. The spend cap must still bite (the directory is measurable without the uuid) and the
  // turn cap must read 0 rather than crashing or silently borrowing another session's count.
  const c = ctx({
    cfg: cfgOf({ budgets: { standard: { tokens_cap: 1000, turn_cap: 600, wall_ms: 0 } } }),
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: null })] },
    alive: new Set(['lead-a']),
    readDirUsage: () => dirUsage({ est_tokens: 1200, turns: 999, sessions: [usage({ uuid: 'someone', turns: 999 })] }),
  });
  await tick(c.deps);
  assert.deepEqual(eventsOf(c, 'WATCHDOG_ERROR'), []);
  assert.deepEqual(c.calls.tripBudget, ['a'], 'the directory spend is measurable without the uuid');
  assert.equal(oneEvent(c, 'BUDGET').payload.turns, 0, 'no uuid means no lead session, which is 0 turns — never 999');
});

// ══════════ Which rows the breaker owns, and the clock the wall cap runs on ══════════

test('a BLOCKED lead is still metered, because it stays alive and answerable', async () => {
  const { tick } = await load('cb1-' + Date.now());
  // THE CRITICAL THIS ROUND EXISTS FOR, and the chain is this build's own code. Phase 3 writes
  // `blocked` after `blocked_slot_minutes` and deliberately does not kill the session (design
  // §185: a blocked lead yields its slot "while staying alive and answerable"); `soma_send`
  // then types into that live pane and changes no status; and nothing moves `blocked →
  // spawned` while the pane lives, because `resumeLead` refuses it. Scoped to `spawned`, the
  // meter never read this lead's transcript again — measured with one fixture and one field
  // changed, `readDirUsage` was not called at all, so 50,000 est_tokens against a 1,000 cap and
  // 9,999 lead turns against a 600 cap produced no trip, no BUDGET event and no BUDGET_TRIPPED
  // file, which is the flag the lead's PreToolUse gate reads. Nothing pinned that scope: the
  // reviewer's mutation widening it to `blocked` SURVIVED, 0 assertions.
  const c = ctx({
    cfg: cfgOf({ budgets: { standard: { tokens_cap: 1000, turn_cap: 600, wall_ms: 0 } } }),
    fleet: { tasks: [row({ id: 'a', status: 'blocked', lead_session_uuid: 'u', updated: NOW - 5 * MIN })] },
    alive: new Set(['lead-a']),
    readDirUsage: () => dirUsage({ est_tokens: 50_000, sessions: [usage({ uuid: 'u', turns: 9999 })] }),
  });
  await tick(c.deps);
  assert.deepEqual(c.calls.readDirUsage, ['/w/a'], 'the transcript was not even read');
  assert.deepEqual(c.calls.tripBudget, ['a']);
  assert.equal(oneEvent(c, 'BUDGET').payload.pct, 100);
  assert.equal(oneEvent(c, 'BUDGET').payload.turns, 9999, 'and still the LEAD\'s own turns, not the directory\'s');
});

test('the breaker owns the live statuses and only those, whichever way the scope is wrong', async () => {
  const { tick } = await load('cb2-' + Date.now());
  // The scope's other edge, and it is not decoration: "meter every row" and "meter off tmux
  // liveness" both pass the test above. A `done`/`failed`/`skipped` lead has reported that it
  // stopped, its transcript is not growing, and a BUDGET_TRIPPED written against it is a flag
  // only an explicit unlink clears; its pane may well still be standing (there is no
  // `linger_minutes` reaper on this build) and that is the reaper's business, not the
  // breaker's. A `queued` row has no session and no worktree to read.
  const terminal = ctx({
    cfg: cfgOf({ budgets: { standard: { tokens_cap: 1000, turn_cap: 600, wall_ms: 0 } } }),
    fleet: {
      tasks: [
        row({ id: 'a', status: 'done', lead_session_uuid: 'u', updated: NOW - MIN }),
        row({ id: 'b', status: 'failed', lead_session_uuid: 'u', updated: NOW - MIN }),
        row({ id: 'c', status: 'skipped', lead_session_uuid: 'u', updated: NOW - MIN }),
      ],
    },
    // Every one of their panes is still alive, which is exactly the case a liveness-scoped
    // meter would pick up and this one must not.
    alive: new Set(['lead-a', 'lead-b', 'lead-c']),
    readDirUsage: () => dirUsage({ est_tokens: 50_000, sessions: [usage({ uuid: 'u', turns: 9999 })] }),
  });
  await tick(terminal.deps);
  assert.deepEqual(terminal.calls.readDirUsage, [], 'a lead that has reported terminal is not metered');

  // The control on the same fixture, and the reason the assertion above cannot pass vacuously.
  const live = ctx({
    cfg: cfgOf({ budgets: { standard: { tokens_cap: 1e12, turn_cap: 0, wall_ms: 0 } } }),
    fleet: {
      tasks: [
        row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', updated: NOW - MIN }),
        row({ id: 'b', status: 'blocked', lead_session_uuid: 'u', updated: NOW - MIN }),
      ],
    },
    alive: new Set(['lead-a', 'lead-b']),
    readDirUsage: () => dirUsage({ est_tokens: 1, sessions: [usage({ uuid: 'u', turns: 1 })] }),
  });
  await tick(live.deps);
  assert.deepEqual(live.calls.readDirUsage, ['/w/a', '/w/b'], 'both live statuses are read, in row order');
});

test('the wall cap runs from the FIRST spawn, so answering a blocked lead does not restart it', async () => {
  const { tick } = await load('m1a-' + Date.now());
  // The clock, and the reason the scope and the clock had to be fixed together. `updated` means
  // "when this row's status last changed" and nothing else (`fleet.mjs:309`), so a `spawned →
  // blocked → spawned` round trip re-stamps it and the lead is handed a fresh 8 h wall cap
  // every time an operator answers it. On a blocked row it is worse than useless: `updated` is
  // `asked.at`, and phase 3 waits `blocked_slot_minutes` (120) before writing `blocked`, so
  // against the shipped `research` class (`wall_ms` 2 h) reading it would trip a working lead on
  // the first tick after it blocks — a silent under-enforcement turned into a loud over-one.
  const mk = (over) => ctx({
    fleet: { tasks: [row({ id: 'a', status: 'blocked', lead_session_uuid: 'u', ...over })] },
    alive: new Set(['lead-a']),
    // Under every other cap: 1 token of 1,000,000 and 3 turns of 600. Only the wall can trip.
    readDirUsage: () => dirUsage({ est_tokens: 1, sessions: [usage({ uuid: 'u', turns: 3 })] }),
  });
  const old = mk({ started_at: NOW - 9 * 3600 * 1000, updated: NOW - MIN });
  await tick(old.deps);
  assert.deepEqual(old.calls.tripBudget, ['a'], 'nine hours of paid-for wall clock is nine hours');
  assert.equal(oneEvent(old, 'BUDGET').payload.pct, 100);

  // The mirror, and it is what stops `task.created`, `Math.min(started_at, updated)` and
  // "whichever is older" from passing the assertion above: a lead that started one minute ago
  // whose row last changed status nine hours back has elapsed nothing.
  const young = mk({ started_at: NOW - MIN, updated: NOW - 9 * 3600 * 1000, created: NOW - 10 * 3600 * 1000 });
  await tick(young.deps);
  assert.deepEqual(young.calls.tripBudget, []);
  assert.deepEqual(eventsOf(young, 'BUDGET'), []);
});

test('a row with no start stamp adopts its spawn stamp, through the store, and never moves it again', async () => {
  const { tick } = await load('m1b-' + Date.now());
  const spawnedAt = NOW - 3 * 3600 * 1000;
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', updated: spawnedAt })] },
    alive: new Set(['lead-a']),
    readDirUsage: () => dirUsage({ est_tokens: 1, sessions: [usage({ uuid: 'u', turns: 3 })] }),
  });
  await tick(c.deps);
  // `updated` on a row that is CURRENTLY `spawned` IS the spawn stamp — that is precisely what
  // `setTaskStatus` guarantees on the transition into `spawned` — so adopting it there is exact.
  // Asserted against `c.store`, which only a transactional write reaches: adopted onto the
  // tick's own snapshot instead, the next tick would adopt again from an `updated` that has
  // since moved, which is the bug wearing the fix's clothes.
  assert.equal(c.task().started_at, spawnedAt);

  // Now the row blocks, which re-stamps `updated`. The stamp must not follow it. (What that
  // buys is pinned by the test above; this one is about the field.)
  c.store.tasks[0].status = 'blocked';
  c.store.tasks[0].updated = NOW - MIN;
  await tick(c.deps);
  assert.equal(c.task().started_at, spawnedAt, 'write-once: a status change does not restart the wall clock');
});

test('the start stamp is re-checked INSIDE the transaction, so a concurrent write is not overwritten', async () => {
  const { tick } = await load('m1d-' + Date.now());
  const seeded = NOW - 6 * 3600 * 1000;
  // The same shape as the blocked flip's re-check, and for the same reason: the row the tick
  // adopted from is a `structuredClone` taken at the top of the tick, so a `soma_spawn` landing
  // in between would be clobbered by a write that only consulted the snapshot. Simulated by
  // having a dep the meter calls FIRST (`readDirUsage`) write the field into the live store.
  let c;
  c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', updated: NOW - MIN })] },
    alive: new Set(['lead-a']),
    readDirUsage: () => {
      c.store.tasks[0].started_at = seeded;
      return dirUsage({ est_tokens: 1, sessions: [usage({ uuid: 'u', turns: 3 })] });
    },
  });
  await tick(c.deps);
  assert.equal(c.task().started_at, seeded, 'the stamp already on the live row wins; write-once means once');
});

test('a spawned row whose `updated` will not read as a number degrades to now, not to no breaker', async () => {
  const { tick } = await load('m1e-' + Date.now());
  // A hand-edited or half-written checkpoint. Passing that straight through would reach
  // `checkBudget`'s own `reqNum('checkBudget: clock.startedAt', …)`, whose throw costs this lead
  // the token and turn caps too — the whole meter aborts — for a fault that only bears on the
  // wall. So the adoption refuses it locally and the other two caps survive.
  const c = ctx({
    cfg: cfgOf({ budgets: { standard: { tokens_cap: 1000, turn_cap: 600, wall_ms: 8 * 3600 * 1000 } } }),
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', updated: null })] },
    alive: new Set(['lead-a']),
    readDirUsage: () => dirUsage({ est_tokens: 5000, sessions: [usage({ uuid: 'u', turns: 3 })] }),
  });
  await tick(c.deps);
  assert.equal(c.task().started_at, NOW);
  assert.deepEqual(eventsOf(c, 'WATCHDOG_ERROR'), [], 'a torn stamp must not cost this lead its other two caps');
  assert.deepEqual(c.calls.tripBudget, ['a'], 'and the spend cap still bites: 5000 of 1000');
});

test('a row first metered in a non-spawned state starts its clock NOW, not at the question it asked', async () => {
  const { tick } = await load('m1c-' + Date.now());
  // The migration case: a checkpoint written before this field existed, first metered while
  // `blocked`. Its `updated` is `asked.at` and there is no honest start time anywhere else on
  // the row, so adopting `updated` would put every such row at least `blocked_slot_minutes`
  // into its wall cap on the tick this shipped — already over the `research` class's 2 h. The
  // honest answer is that the clock starts now: one row, one time, and it under-enforces in a
  // bounded way rather than tripping a lead that is answering a human.
  const c = ctx({
    cfg: cfgOf({ budgets: { standard: { tokens_cap: 1e12, turn_cap: 0, wall_ms: 2 * 3600 * 1000 } } }),
    fleet: { tasks: [row({ id: 'a', status: 'blocked', lead_session_uuid: 'u', updated: NOW - 3 * 3600 * 1000 })] },
    alive: new Set(['lead-a']),
    readDirUsage: () => dirUsage({ est_tokens: 1, sessions: [usage({ uuid: 'u', turns: 3 })] }),
  });
  await tick(c.deps);
  assert.equal(c.task().started_at, NOW);
  // Independent of the line above: a tick could stamp the row correctly and still hand
  // `checkBudget` the old field, which is the mutation this catches.
  assert.deepEqual(c.calls.tripBudget, [], 'the tick that started metering a lead must not be the tick that trips it');
});

test('a metered row with no uuid says its turn count is unmeasurable, once', async () => {
  const { tick } = await load('c20e-' + Date.now());
  // The uuid-on-the-row defect one layer down, which the widened scope makes reachable on a row
  // nobody is watching. `readDirUsage` is keyed on the CWD, so the spend cap and the wall cap
  // are both still measured and this lead is not breakerless — but no transcript in the
  // directory can be attributed to it, so its own turn count reads 0 and `turn_cap` is the one
  // cap that silently stops existing. `ownSession` returning null has two causes and only this
  // one is a defect; the other (a lead that has not written a turn yet) is pinned above and
  // must stay silent.
  const mk = (over = {}) => ctx({
    cfg: cfgOf({ budgets: { standard: { tokens_cap: 1000, turn_cap: 600, wall_ms: 0 } } }),
    fleet: { tasks: [row({ id: 'a', status: 'blocked', lead_session_uuid: null, updated: NOW - MIN })] },
    alive: new Set(['lead-a']),
    readDirUsage: () => dirUsage({ est_tokens: 1200, turns: 999, sessions: [usage({ uuid: 'someone', turns: 999 })] }),
    ...over,
  });
  const c = mk();
  await tick(c.deps);
  const said = oneEvent(c, 'TURNS_UNMEASURED');
  assert.equal(said.lead, 'a');
  assert.equal(said.payload.turn_cap, 600, 'the cap rides along, so an operator can see whether it mattered');
  assert.deepEqual(c.calls.tripBudget, ['a'], 'the directory spend is still measurable without a uuid');
  assert.equal(oneEvent(c, 'BUDGET').payload.turns, 0, 'never another session\'s 999');

  // Once per lead, off the durable log. A row stays in this state until someone repairs it, so
  // unguarded this is a line every 30 s forever — which is how a real signal becomes one people
  // mute, the same reasoning HARNESS_DEFAULTED and the warn already carry.
  const again = mk({ orchEvents: [ev('TURNS_UNMEASURED', 'a', NOW - MIN)] });
  await tick(again.deps);
  assert.deepEqual(eventsOf(again, 'TURNS_UNMEASURED'), []);
  assert.deepEqual(again.calls.tripBudget, ['a'], 'the dedupe is on the announcement, never on the breaker');
});

test('the fallback class is read with hasOwn, so no lead binds a breaker off Object.prototype', async () => {
  const { tick } = await load('c3d-' + Date.now());
  // `budgets` reaching here is a merged config, and `config.keysOf` drops `__proto__` — but the
  // house rule in `wd/budget.mjs` and `harness.mjs` is hasOwn regardless, because a class
  // resolving through a prototype is a class nobody wrote in soma.json, and this build has
  // already shipped one truthiness-indexed registry that produced a breakerless lead.
  const c = ctx({
    cfg: { ...cfgOf(), budgets: Object.create({ standard: { tokens_cap: 1, turn_cap: 0, wall_ms: 0 } }) },
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u' })] },
    alive: new Set(['lead-a']),
    budgetClassFor: () => null,
    readDirUsage: () => dirUsage({ est_tokens: 9e9, sessions: [usage({ uuid: 'u' })] }),
  });
  await tick(c.deps);
  assert.deepEqual(c.calls.tripBudget, [], 'an inherited class is not a class');
  assert.match(oneEvent(c, 'WATCHDOG_ERROR').payload.error, /budget class must be an object/);
});

test('tokens_cap IS the directory sum, because a lead\'s teammates spend the operator\'s money', async () => {
  const { tick } = await load('c6-' + Date.now());
  const c = ctx({
    cfg: cfgOf({ budgets: { standard: { tokens_cap: 1000, turn_cap: 0, wall_ms: 0 } } }),
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'lead-uuid' })] },
    alive: new Set(['lead-a']),
    // The lead's own session is a tenth of the cap; the directory is over it. A lead-only
    // meter is blind to more than half of the work done in one real directory.
    readDirUsage: () => dirUsage({ est_tokens: 1200, sessions: [usage({ uuid: 'lead-uuid', est_tokens: 100 })] }),
  });
  await tick(c.deps);
  assert.deepEqual(c.calls.tripBudget, ['a']);
  assert.equal(oneEvent(c, 'BUDGET').payload.est_tokens, 1200);
  assert.deepEqual(c.calls.readDirUsage, ['/w/a'], 'the meter reads the lead\'s worktree slug directory');
});

test('the breaker warns at 80% and does not trip', async () => {
  const { tick } = await load('warn-' + Date.now());
  const c = ctx({
    cfg: cfgOf({ budgets: { standard: { tokens_cap: 1000, turn_cap: 0, wall_ms: 0 } } }),
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u' })] },
    alive: new Set(['lead-a']),
    readDirUsage: () => dirUsage({ est_tokens: 850, sessions: [usage({ uuid: 'u' })] }),
  });
  await tick(c.deps);
  assert.equal(oneEvent(c, 'BUDGET').payload.pct, 80);
  assert.deepEqual(c.calls.tripBudget, [], 'a warning is not a trip');
  assert.deepEqual(c.calls.notify, [], 'the orchestrator prompt says a warning is usually nothing to do');
});

test('a tripped lead is not re-announced every 30 seconds', async () => {
  const { tick } = await load('idem-' + Date.now());
  const c = ctx({
    cfg: cfgOf({ budgets: { standard: { tokens_cap: 10, turn_cap: 0, wall_ms: 0 } } }),
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u' })] },
    alive: new Set(['lead-a']),
    readDirUsage: () => dirUsage({ est_tokens: 999, sessions: [usage({ uuid: 'u' })] }),
    tripped: () => true,                                          // BUDGET_TRIPPED already on disk
  });
  await tick(c.deps);
  // Presence is the protocol, so the flag file is the dedupe. Without this the operator gets
  // a desktop toast every tick for as long as the lead exists, which is how a real alarm
  // becomes one people mute.
  assert.deepEqual(eventsOf(c, 'BUDGET'), []);
  assert.deepEqual(c.calls.notify, []);
  assert.deepEqual(c.calls.tripBudget, []);
});

test('a lead already warned in the log is not warned again', async () => {
  const { tick } = await load('idem2-' + Date.now());
  const c = ctx({
    cfg: cfgOf({ budgets: { standard: { tokens_cap: 1000, turn_cap: 0, wall_ms: 0 } } }),
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u' })] },
    alive: new Set(['lead-a']),
    readDirUsage: () => dirUsage({ est_tokens: 850, sessions: [usage({ uuid: 'u' })] }),
    orchEvents: [ev('BUDGET', 'a', NOW - MIN, { pct: 80 })],
  });
  await tick(c.deps);
  assert.deepEqual(eventsOf(c, 'BUDGET'), []);
  assert.deepEqual(c.calls.warnBudget, [], 'the flag goes with the event: a lead warned once is not written a second note');
});

// ════════════════════ The 80% warning reaches the lead ════════════════════
//
// The BUDGET event lands on the orchestrator's stream, which the lead never reads. So at the 80%
// verdict the watchdog also writes `leads/<id>/BUDGET_WARNED`, and the PreToolUse gate hands the lead
// a note on its next allowed tool call (`bin/hooks/lead-gate.mjs`, job 5). The flag goes FIRST: the
// logged BUDGET is the once-per-lead dedupe, so a write that failed after it landed would never be
// retried and the lead would never be told.

test('at 80% the watchdog writes the lead its flag, then logs the BUDGET', async () => {
  const { tick } = await load('warnflag-' + Date.now());
  const c = ctx({
    cfg: cfgOf({ budgets: { standard: { tokens_cap: 1000, turn_cap: 0, wall_ms: 0 } } }),
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u' })] },
    alive: new Set(['lead-a']),
    readDirUsage: () => dirUsage({ est_tokens: 850, sessions: [usage({ uuid: 'u' })] }),
  });
  await tick(c.deps);
  assert.equal(oneEvent(c, 'BUDGET').payload.pct, 80);
  assert.deepEqual(c.calls.warnBudget, ['a'], 'the lead was not written its 80% flag');
  assert.deepEqual(c.calls.tripBudget, [], 'a warning is not a trip');
  ranBefore(c.order, 'warnBudget:a', 'event:BUDGET');
});

test('at 100% the watchdog trips the lead and writes no 80% flag', async () => {
  const { tick } = await load('tripnowarn-' + Date.now());
  const c = ctx({
    cfg: cfgOf({ budgets: { standard: { tokens_cap: 1000, turn_cap: 0, wall_ms: 0 } } }),
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u' })] },
    alive: new Set(['lead-a']),
    readDirUsage: () => dirUsage({ est_tokens: 1000, sessions: [usage({ uuid: 'u' })] }),
  });
  await tick(c.deps);
  assert.deepEqual(c.calls.tripBudget, ['a']);
  assert.equal(oneEvent(c, 'BUDGET').payload.pct, 100);
  assert.deepEqual(c.calls.warnBudget, [], "a trip is not a warning: the gate's deny tells a tripped lead");
});

test('an 80% flag that cannot be written is a WATCHDOG_ERROR and no BUDGET, so the next tick retries both', async () => {
  const { tick } = await load('warnfail-' + Date.now());
  const fixture = (over = {}) => ctx({
    cfg: cfgOf({ budgets: { standard: { tokens_cap: 1000, turn_cap: 0, wall_ms: 0 } } }),
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u' })] },
    alive: new Set(['lead-a']),
    readDirUsage: () => dirUsage({ est_tokens: 850, sessions: [usage({ uuid: 'u' })] }),
    ...over,
  });

  const failed = fixture({ warnBudget: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } });
  await tick(failed.deps);
  assert.deepEqual(failed.calls.warnBudget, ['a'], 'the write was not even attempted');
  const errs = eventsOf(failed, 'WATCHDOG_ERROR').filter((e) => e.payload?.where === 'budget');
  assert.equal(errs.length, 1, `expected one budget WATCHDOG_ERROR: ${JSON.stringify(failed.calls.appendEvent.map((e) => e.type))}`);
  assert.equal(errs[0].lead, 'a');
  assert.deepEqual(eventsOf(failed, 'BUDGET'), [], 'a BUDGET logged over a failed write would dedupe the warning away for good');

  // The next tick: the log still holds no BUDGET for this lead, so both are attempted again.
  const next = fixture();
  await tick(next.deps);
  assert.deepEqual(next.calls.warnBudget, ['a']);
  assert.equal(oneEvent(next, 'BUDGET').payload.pct, 80);
});

test('the real warnBudget writes the flag at warnPath, and heals a thinned state root to do it', async () => {
  // The writer's half of the path agreement that hooks.test.mjs measures from the reader's side
  // (the file at warnPath is the file the real gate claims). Real bytes under a throwaway
  // $SOMA_HOME with no `leads/` at all: the write creates the directory instead of leaving the lead
  // untold, the same self-heal `tripBudget` carries.
  const home = mkdtempSync(join(tmpdir(), 'soma-wd-warn-'));
  const savedHome = process.env.SOMA_HOME;
  process.env.SOMA_HOME = home;
  try {
    const real = (await load('real-warn-' + Date.now())).realDeps();
    const { warnPath } = await import('../bin/lib/wd/budget.mjs');
    assert.equal(warnPath('a'), join(home, 'leads', 'a', 'BUDGET_WARNED'));
    real.warnBudget('a');
    assert.match(readFileSync(warnPath('a'), 'utf8'), /^\d+\n$/, 'the flag was not written, or not where warnPath says');
  } finally {
    if (savedHome === undefined) delete process.env.SOMA_HOME;
    else process.env.SOMA_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// ════════════════════════ Which class prices a lead ════════════════════════
//
// The breaker priced every lead off `task.harness || 'H1'`, and `task.harness` reaches the row
// only when the orchestrator drains the lead's HARNESS through `soma_inbox`. So until that drain
// every lead was metered as H1, and a class the operator pinned at enqueue never reached the
// breaker at all. Each class below carries a token cap no other class has, so the `tokens_cap` in
// a BUDGET payload names the class that priced the lead.

/** Four classes with four different token caps: a BUDGET payload says which one was bound. */
const PRICED = {
  standard: { ...CLASS },                                             // 1,000,000
  iterate: { tokens_cap: 3_000_000, turn_cap: 600, wall_ms: 12 * 3600 * 1000 },
  review: { tokens_cap: 2_000_000, turn_cap: 600, wall_ms: 10 * 3600 * 1000 },
  babysit: { tokens_cap: 400_000, turn_cap: 0, wall_ms: 0 },
};

/** The class each harness reserves, as `prompts/harnesses.json` ships the table. */
const RESERVES = { H1: 'standard', H2: 'iterate', H3: 'iterate', H4: 'review', H5: 'babysit', H6: 'research' };

/**
 * A lead priced the way `harness.budgetClassFor` prices one: the class its harness reserves, read
 * off the fixture's own config, and null for a harness the table does not carry or a class the
 * config does not define (`research` is not configured here). `budgets` is used as given, so a
 * prototype on it survives.
 */
const priced = (over = {}, budgets = structuredClone(PRICED)) => {
  const cfg = cfgOf({ budgets });
  return ctx({
    cfg,
    alive: new Set(['lead-a']),
    budgetClassFor: (h) => (Object.hasOwn(RESERVES, h) && Object.hasOwn(cfg.budgets, RESERVES[h]) ? cfg.budgets[RESERVES[h]] : null),
    ...over,
  });
};

/** A worktree whose lead and team have spent `est` est_tokens, the lead three turns in. */
const spent = (est) => () => dirUsage({ est_tokens: est, sessions: [usage({ uuid: 'u', turns: 3 })] });

/** A HARNESS report as `soma_report` stores it on the lead's own stream. */
const declared = (id, ts, cls) => ev('HARNESS', 'a', ts, { harness_id: id, budget_class: cls, plan_summary: 'p' });

test('a class pinned at enqueue prices the lead from its first tick, before it declares a harness', async () => {
  const { tick } = await load('bc1-' + Date.now());
  const c = priced({
    // What `fleet.enqueue` writes for `budget_class: 'babysit'`. No HARNESS has been filed yet.
    fleet: { tasks: [row({ status: 'spawned', lead_session_uuid: 'u', budget_class: 'babysit', budget_override: 'babysit' })] },
    // Over babysit's 400,000 and half of standard's 1,000,000: only the pinned class trips this.
    readDirUsage: spent(500_000),
  });
  await tick(c.deps);
  assert.deepEqual(c.calls.tripBudget, ['a'], 'priced as H1, the pinned class never reaches the breaker');
  assert.equal(oneEvent(c, 'BUDGET').payload.tokens_cap, PRICED.babysit.tokens_cap);
  assert.deepEqual(eventsOf(c, 'HARNESS_DEFAULTED'), []);
});

test('the lead\'s own HARNESS report prices it at once, without waiting for the orchestrator\'s drain', async () => {
  const { tick } = await load('bc2-' + Date.now());
  const c = priced({
    fleet: { tasks: [row({ status: 'spawned', lead_session_uuid: 'u' })] },          // undrained: no harness on the row
    leadEvents: { a: [ev('STARTED', 'a', NOW - 9 * MIN), declared('H3', NOW - 8 * MIN, 'iterate')] },
    // 2.5x standard's cap and 83% of iterate's: H1 trips this lead, H3 only warns it.
    readDirUsage: spent(2_500_000),
  });
  await tick(c.deps);
  assert.deepEqual(c.calls.tripBudget, [], 'an iterate lead tripped at standard\'s cap because its report was still unread');
  const budget = oneEvent(c, 'BUDGET');
  assert.equal(budget.payload.pct, 80);
  assert.equal(budget.payload.tokens_cap, PRICED.iterate.tokens_cap);
  assert.ok(c.calls.budgetClassFor.includes('H3'), `budgetClassFor was asked for ${JSON.stringify(c.calls.budgetClassFor)}`);
  assert.deepEqual(eventsOf(c, 'HARNESS_DEFAULTED'), []);
});

test('the newest HARNESS on the lead\'s stream beats the stale harness its row still carries', async () => {
  const { tick } = await load('bc3-' + Date.now());
  // The documented H1 -> H4 degrade: the orchestrator drained the first report and not the second.
  const stream = { a: [declared('H1', NOW - 30 * MIN, 'standard'), declared('H4', NOW - 5 * MIN, 'review')] };
  const c = priced({
    fleet: { tasks: [row({ status: 'spawned', lead_session_uuid: 'u', harness: 'H1', budget_class: 'standard' })] },
    leadEvents: stream,
    // 1.8x standard's cap and 90% of review's.
    readDirUsage: spent(1_800_000),
  });
  await tick(c.deps);
  assert.deepEqual(c.calls.tripBudget, [], 'priced off the row, an H4 lead trips at H1\'s cap');
  assert.equal(oneEvent(c, 'BUDGET').payload.tokens_cap, PRICED.review.tokens_cap);

  // A row the fold wrote before `budget_override` existed: drained to H4, with the class of the
  // FIRST report, which that fold never updated. Nothing on such a row says whether an operator
  // chose `standard`, so a resolver that read `budget_class` as a pin would price this H4 lead
  // at H1's cap. Only `budget_override` is a pin, and this row has none.
  const legacy = priced({
    fleet: { tasks: [row({ status: 'spawned', lead_session_uuid: 'u', harness: 'H4', budget_class: 'standard' })] },
    leadEvents: stream,
    readDirUsage: spent(1_800_000),
  });
  await tick(legacy.deps);
  assert.deepEqual(legacy.calls.tripBudget, []);
  assert.equal(oneEvent(legacy, 'BUDGET').payload.tokens_cap, PRICED.review.tokens_cap);
});

test('a pinned class beats the harness the lead declared', async () => {
  const { tick } = await load('bc4-' + Date.now());
  const c = priced({
    fleet: { tasks: [row({ status: 'spawned', lead_session_uuid: 'u', harness: 'H4', budget_class: 'babysit', budget_override: 'babysit' })] },
    leadEvents: { a: [declared('H4', NOW - 5 * MIN, 'review')] },
    // Over babysit's 400,000 and a quarter of review's 2,000,000.
    readDirUsage: spent(500_000),
  });
  await tick(c.deps);
  assert.deepEqual(c.calls.tripBudget, ['a']);
  assert.equal(oneEvent(c, 'BUDGET').payload.tokens_cap, PRICED.babysit.tokens_cap);
  assert.deepEqual(eventsOf(c, 'HARNESS_DEFAULTED'), []);
});

/**
 * Pins no class can be bound from, each with the name a HARNESS_DEFAULTED payload gives it. The
 * strings: a name soma.json never wrote; three that resolve through Object.prototype, which a
 * truthiness or `in` lookup would bind; an own key whose value is not a record; and a record class
 * reachable only through the budgets' prototype. The rest are not strings at all, which
 * `soma enqueue --file` stores as the file says. Only a string can name a class:
 * `Object.hasOwn(budgets, 42)` would find a class named "42", and `['babysit']` would find babysit.
 */
const UNBOUND = [
  ['premium', 'premium'], ['constructor', 'constructor'], ['toString', 'toString'], ['__proto__', '__proto__'],
  ['flat', 'flat'], ['inherited', 'inherited'],
  [42, '42'], [true, 'true'], [{}, 'object'], [{ toString: 1 }, 'object'], [['babysit'], 'array'],
];

/** The budgets those pins are tried against: every trap above, beside the four real classes. */
const unboundBudgets = () => Object.assign(
  Object.create({ inherited: { tokens_cap: 1, turn_cap: 0, wall_ms: 0 } }),
  structuredClone(PRICED),
  { flat: 42, 42: { tokens_cap: 1, turn_cap: 0, wall_ms: 0 } },
);

test('a pin no class can be bound from is passed over for the harness, and said once', async () => {
  const { tick } = await load('bc5-' + Date.now());
  for (const [pin, name] of UNBOUND) {
    const mk = (extra = {}) => priced({
      fleet: { tasks: [row({ status: 'spawned', lead_session_uuid: 'u', budget_class: pin, budget_override: pin })] },
      leadEvents: { a: [declared('H4', NOW - 5 * MIN, 'review')] },
      readDirUsage: spent(1_800_000),
      ...extra,
    }, unboundBudgets());
    const c = mk();
    await tick(c.deps);
    assert.deepEqual(c.calls.tripBudget, [], name);
    assert.equal(oneEvent(c, 'BUDGET').payload.tokens_cap, PRICED.review.tokens_cap, `${name}: priced by its harness`);
    // A pin that silently stops binding is the very complaint this resolver answers: the operator
    // asked for a class, and the lead is metered at another. So it is said, with a null class,
    // because no fallback was bound: the lead's own harness prices it.
    const said = oneEvent(c, 'HARNESS_DEFAULTED');
    assert.equal(said.lead, 'a', name);
    assert.deepEqual(said.payload, { harness: 'H4', budget_override: name, budget_class: null }, name);
    assert.deepEqual(eventsOf(c, 'WATCHDOG_ERROR'), [], name);

    // Once per lead, off the durable log.
    const again = mk({ orchEvents: [ev('HARNESS_DEFAULTED', 'a', NOW - MIN, said.payload)] });
    await tick(again.deps);
    assert.deepEqual(eventsOf(again, 'HARNESS_DEFAULTED'), [], name);
    assert.equal(oneEvent(again, 'BUDGET').payload.tokens_cap, PRICED.review.tokens_cap, name);
  }
});

test('a passed-over pin names the harness that priced the lead as the lead spelled it, cut to 32', async () => {
  const { tick } = await load('bc5c-' + Date.now());
  // `harness.budgetClassFor` prices a leading id with prose after it, so a spelling a lead typed
  // can be long and still price the lead. One event is one atomic append, so it is cut.
  const spelling = `H4 ${'review loop, '.repeat(10)}`;
  const c = priced({
    fleet: { tasks: [row({ status: 'spawned', lead_session_uuid: 'u', budget_class: 'premium', budget_override: 'premium' })] },
    leadEvents: { a: [declared(spelling, NOW - 5 * MIN, 'review')] },
    readDirUsage: spent(1_800_000),
    budgetClassFor: (h) => (/^H4\b/.test(h) ? PRICED.review : null),
  });
  await tick(c.deps);
  assert.equal(oneEvent(c, 'BUDGET').payload.tokens_cap, PRICED.review.tokens_cap);
  assert.deepEqual(oneEvent(c, 'HARNESS_DEFAULTED').payload, { harness: spelling.slice(0, 32), budget_override: 'premium', budget_class: null });
});

test('a pin that is not a string is still a declaration: with no harness behind it, standard is bound and said', async () => {
  const { tick } = await load('bc5b-' + Date.now());
  for (const [pin, name] of UNBOUND.filter(([p]) => typeof p !== 'string')) {
    const c = priced({
      fleet: { tasks: [row({ status: 'spawned', lead_session_uuid: 'u', budget_class: pin, budget_override: pin })] },
      leadEvents: { a: [ev('STARTED', 'a', NOW - 9 * MIN)] },
      readDirUsage: spent(1_200_000),
    }, unboundBudgets());
    await tick(c.deps);
    // Read as "nothing declared", this lead took H1's class without a word, which is the silent
    // pricing the announcement exists to end.
    assert.deepEqual(c.calls.budgetClassFor, [], `${name}: a declared pin never takes the silent H1 path`);
    assert.deepEqual(oneEvent(c, 'HARNESS_DEFAULTED').payload, { harness: null, budget_override: name, budget_class: 'standard' }, name);
    assert.deepEqual(c.calls.tripBudget, ['a'], name);
    assert.equal(oneEvent(c, 'BUDGET').payload.tokens_cap, PRICED.standard.tokens_cap, name);
    assert.deepEqual(eventsOf(c, 'WATCHDOG_ERROR'), [], name);
  }
});

test('a lead that has declared nothing yet is priced as H1, and that is not announced', async () => {
  const { tick } = await load('bc6-' + Date.now());
  // `''` is no pin either: it names nothing, and `soma_enqueue` refuses it at the door.
  for (const pin of [null, '']) {
    const c = priced({
      fleet: { tasks: [row({ status: 'spawned', lead_session_uuid: 'u', budget_class: pin, budget_override: pin })] },
      leadEvents: { a: [ev('STARTED', 'a', NOW - 9 * MIN)] },
      readDirUsage: spent(1_200_000),
    });
    await tick(c.deps);
    // Every lead spends its first minutes here, before its step-1 HARNESS report. Announcing it
    // would announce every spawn, and an alarm that fires on every spawn is one an operator mutes.
    assert.deepEqual(c.calls.budgetClassFor, ['H1'], JSON.stringify(pin));
    assert.deepEqual(c.calls.tripBudget, ['a'], JSON.stringify(pin));
    assert.equal(oneEvent(c, 'BUDGET').payload.tokens_cap, PRICED.standard.tokens_cap, JSON.stringify(pin));
    assert.deepEqual(eventsOf(c, 'HARNESS_DEFAULTED'), [], JSON.stringify(pin));
  }
});

test('a declaration nothing can price binds standard and says so once, naming what was declared', async () => {
  const { tick } = await load('bc7-' + Date.now());
  const cases = [
    { name: 'a harness the registry does not carry, read off the stream before any drain',
      over: {}, stream: [declared('H9', NOW - 5 * MIN, 'standard')],
      payload: { harness: 'H9', budget_override: null, budget_class: 'standard' } },
    { name: 'a harness on the row whose class soma.json does not define',
      over: { harness: 'H6' }, stream: [],
      payload: { harness: 'H6', budget_override: null, budget_class: 'standard' } },
    { name: 'a pinned class soma.json does not define, with no harness declared behind it',
      over: { budget_class: 'premium', budget_override: 'premium' }, stream: [],
      payload: { harness: null, budget_override: 'premium', budget_class: 'standard' } },
    // Both cut to 32: one event is one atomic append, so nothing unbounded rides in a payload.
    { name: 'long spellings of both',
      over: { budget_class: 'p'.repeat(100), budget_override: 'p'.repeat(100) }, stream: [declared('X'.repeat(100), NOW - 5 * MIN, 'standard')],
      payload: { harness: 'X'.repeat(32), budget_override: 'p'.repeat(32), budget_class: 'standard' } },
  ];
  for (const { name, over, stream, payload } of cases) {
    const mk = (extra = {}) => priced({
      fleet: { tasks: [row({ status: 'spawned', lead_session_uuid: 'u', ...over })] },
      leadEvents: { a: stream },
      readDirUsage: spent(1_200_000),
      ...extra,
    });
    const c = mk();
    await tick(c.deps);
    const said = oneEvent(c, 'HARNESS_DEFAULTED');
    assert.equal(said.lead, 'a', name);
    assert.deepEqual(said.payload, payload, name);
    assert.deepEqual(c.calls.tripBudget, ['a'], `${name}: the fallback class still trips`);
    assert.equal(oneEvent(c, 'BUDGET').payload.tokens_cap, PRICED.standard.tokens_cap, name);

    // Once per lead, off the durable log; the breaker keeps running under it.
    const again = mk({ orchEvents: [ev('HARNESS_DEFAULTED', 'a', NOW - MIN, payload)] });
    await tick(again.deps);
    assert.deepEqual(eventsOf(again, 'HARNESS_DEFAULTED'), [], name);
    assert.deepEqual(again.calls.tripBudget, ['a'], `${name}: the dedupe is on the announcement, never on the breaker`);
  }
});

test('a lead stream that cannot be read costs the pricing its freshest input, never the lead its breaker', async () => {
  const { tick } = await load('bc8-' + Date.now());
  const c = priced({
    fleet: { tasks: [row({ status: 'spawned', lead_session_uuid: 'u', harness: 'H4', budget_class: 'review' })] },
    readDirUsage: spent(1_800_000),
    deps: { leadEvents: () => { throw new Error('EACCES reading the lead stream'); } },
  });
  await tick(c.deps);
  assert.equal(oneEvent(c, 'BUDGET').payload.tokens_cap, PRICED.review.tokens_cap, 'priced by the harness the row carries');
  assert.deepEqual(eventsOf(c, 'WATCHDOG_ERROR').filter((e) => e.payload?.where === 'budget'), []);
  assert.deepEqual(eventsOf(c, 'HARNESS_DEFAULTED'), []);
});

test('a HARNESS that names no harness declares nothing, so the one before it still prices the lead', async () => {
  const { tick } = await load('bc9-' + Date.now());
  // `soma_report` refuses such a report before it is stored, so only a hand-written line can be
  // one. It must not mask the real declaration filed before it.
  const c = priced({
    fleet: { tasks: [row({ status: 'spawned', lead_session_uuid: 'u' })] },
    leadEvents: { a: [declared('H4', NOW - 9 * MIN, 'review'), ev('HARNESS', 'a', NOW - 2 * MIN, {})] },
    readDirUsage: spent(1_800_000),
  });
  await tick(c.deps);
  assert.equal(oneEvent(c, 'BUDGET').payload.tokens_cap, PRICED.review.tokens_cap);
  assert.deepEqual(eventsOf(c, 'HARNESS_DEFAULTED'), []);
});

test('a row enqueued before the pin existed has no budget_override key at all, and that is no pin', async () => {
  const { tick } = await load('bc10-' + Date.now());
  // The shape every row on a fleet that predates this field has: the key ABSENT, not null, beside
  // a `budget_class` that may be an operator's choice or the old fold's copy of a first report.
  const legacy = (over) => {
    const r = row({ status: 'spawned', lead_session_uuid: 'u', budget_class: 'babysit', ...over });
    delete r.budget_override;
    assert.equal(Object.hasOwn(r, 'budget_override'), false, 'the fixture must be the key-absent shape');
    return r;
  };

  // With a declared harness: priced by it. Read as a pin, `babysit` would trip this lead at 400,000.
  const c = priced({ fleet: { tasks: [legacy()] }, leadEvents: { a: [declared('H4', NOW - 5 * MIN, 'review')] }, readDirUsage: spent(1_800_000) });
  await tick(c.deps);
  assert.deepEqual(c.calls.tripBudget, []);
  assert.equal(oneEvent(c, 'BUDGET').payload.tokens_cap, PRICED.review.tokens_cap);
  assert.deepEqual(eventsOf(c, 'HARNESS_DEFAULTED'), [], 'a missing field is not a pin that failed to bind');
  assert.deepEqual(eventsOf(c, 'WATCHDOG_ERROR'), []);

  // With nothing declared yet: H1's class, silently, like any unpinned lead in its first minutes.
  const early = priced({ fleet: { tasks: [legacy()] }, readDirUsage: spent(1_200_000) });
  await tick(early.deps);
  assert.deepEqual(early.calls.budgetClassFor, ['H1']);
  assert.equal(oneEvent(early, 'BUDGET').payload.tokens_cap, PRICED.standard.tokens_cap);
  assert.deepEqual(eventsOf(early, 'HARNESS_DEFAULTED'), []);
  assert.deepEqual(eventsOf(early, 'WATCHDOG_ERROR'), []);
});

// ════════════════════════ Model deviation ════════════════════════

test('deviation comes from modelDeviation() against the exported pin, and the pin is an INFIX', async () => {
  const { tick } = await load('c4-' + Date.now());
  const on = (lastModel, models) => ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u' })] },
    alive: new Set(['lead-a']),
    readDirUsage: () => dirUsage({ sessions: [usage({ uuid: 'u', last_model: lastModel, models })] }),
  });
  // `--model opus` resolves to `claude-opus-5`, so a `startsWith` or an anchored regex
  // would report every correctly-pinned lead in the fleet as deviating.
  const pinned = on('claude-opus-5', ['claude-opus-5']);
  await tick(pinned.deps);
  assert.deepEqual(eventsOf(pinned, 'MODEL_DEVIATION'), []);
  // A `<synthetic>` row is written when a turn never reached the API — an auth or API
  // failure, a different fault with a different fix. It is not deviation.
  const synth = on(null, ['<synthetic>']);
  await tick(synth.deps);
  assert.deepEqual(eventsOf(synth, 'MODEL_DEVIATION'), []);
  // A real fallback is. It has to be a CROSS-FAMILY id now that the pin is `opus`: an
  // Opus-5 -> Opus-4.5 fallback satisfies contiguous segment containment and is deliberately
  // invisible here (see the blind-spot note on `spawn.LEAD_MODEL`), so this drives the case
  // the detector really does own.
  const drifted = on('claude-sonnet-5', ['claude-opus-5', 'claude-sonnet-5']);
  await tick(drifted.deps);
  const dev = oneEvent(drifted, 'MODEL_DEVIATION');
  assert.equal(dev.lead, 'a');
  assert.equal(dev.payload.last_model, 'claude-sonnet-5');
  assert.equal(dev.payload.pinned, 'opus');
  // `unexpected` is the EVER state and `deviated` the NOW state: a lead that fell back for
  // thirty turns and reverted is a real defect invisible to `last_model` alone.
  assert.deepEqual(dev.payload.unexpected, ['claude-sonnet-5']);
});

test('the pin matches SEGMENTS, so a substring test would call a real fallback clean', async () => {
  const { tick } = await load('c4d-' + Date.now());
  // The distinguishing case between `modelDeviation` and the `!/opus/.test(...)` regex first
  // sketched. `/opus/` is a SUBSTRING test, so it is satisfied by any id containing the
  // letters — and a model whose segment merely starts with them reports as correctly pinned.
  // `matchesPin` requires contiguous SEGMENT containment, which is what makes `claude-opus-5`
  // (the infix the pin really resolves to) match while this does not.
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u' })] },
    alive: new Set(['lead-a']),
    readDirUsage: () => dirUsage({ sessions: [usage({ uuid: 'u', last_model: 'claude-opusd-9', models: ['claude-opusd-9'] })] }),
  });
  await tick(c.deps);
  assert.equal(oneEvent(c, 'MODEL_DEVIATION').payload.last_model, 'claude-opusd-9');
  // And the dated-suffix case the segment rule exists for still passes: `claude-haiku-4-5`
  // must accept `claude-haiku-4-5-20251001`, so the pin cannot simply be an equality test.
  const dated = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u' })] },
    alive: new Set(['lead-a']),
    readDirUsage: () => dirUsage({ sessions: [usage({ uuid: 'u', last_model: 'claude-opus-5-20251001', models: ['claude-opus-5-20251001'] })] }),
  });
  await tick(dated.deps);
  assert.deepEqual(eventsOf(dated, 'MODEL_DEVIATION'), []);
});

test('deviation is judged on the LEAD\'s session, not on the whole directory\'s model union', async () => {
  const { tick } = await load('c4b-' + Date.now());
  // Teammates are not pinned — `buildLeadEnv` pins the lead with `--effort max` and
  // `--model opus` and says nothing about a teammate's model. Judged against the
  // directory's union, every lead with a haiku teammate reports MODEL_DEVIATION, and an
  // alarm that fires on ordinary work is one nobody reads.
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'lead-uuid' })] },
    alive: new Set(['lead-a']),
    readDirUsage: () => dirUsage({
      models: ['claude-opus-5', 'claude-haiku-4-5'],
      last_model: 'claude-haiku-4-5',
      sessions: [
        usage({ uuid: 'mate', last_model: 'claude-haiku-4-5', models: ['claude-haiku-4-5'] }),
        usage({ uuid: 'lead-uuid', last_model: 'claude-opus-5', models: ['claude-opus-5'] }),
      ],
    }),
  });
  await tick(c.deps);
  assert.deepEqual(eventsOf(c, 'MODEL_DEVIATION'), []);
});

test('a deviation already in the log is not re-announced', async () => {
  const { tick } = await load('c4c-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u' })] },
    alive: new Set(['lead-a']),
    readDirUsage: () => dirUsage({ sessions: [usage({ uuid: 'u', last_model: 'claude-opus-5', models: ['claude-opus-5'] })] }),
    orchEvents: [ev('MODEL_DEVIATION', 'a', NOW - MIN)],
  });
  await tick(c.deps);
  assert.deepEqual(eventsOf(c, 'MODEL_DEVIATION'), []);
});

// ════════════════════════ Death and revival ════════════════════════

test('a dead lead is found by its PANE, not by its session name', async () => {
  const { tick } = await load('c7-' + Date.now());
  // `remain-on-exit` keeps a dead lead's session alive on purpose, so `aliveSessions` is a
  // pane predicate (`tmux.liveSessions`). Here the tick is simply handed the answer: what it
  // must not do is second-guess it with a session-name probe.
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', attempts: 0 })] },
    alive: new Set(),                                             // no live pane for lead-a
    readUsage: () => usage({ uuid: 'u', live_context: 10 }),
  });
  await tick(c.deps);
  assert.equal(oneEvent(c, 'LEAD_DEAD').lead, 'a');
  assert.deepEqual(c.calls.resumeLead, ['a'], 'resume-first, design §10');
});

test('revival captures the death scene, THEN emits LEAD_DEAD, THEN kills, THEN respawns', async () => {
  const { tick } = await load('c19-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', attempts: 1 })] },
    alive: new Set(),
    readUsage: () => usage({ uuid: 'u', live_context: 900_000, zero_tail_rows: 2 }),   // saturated -> fresh
  });
  await tick(c.deps);
  // The kill destroys the pane, so the final screen has to be read first — `logs/<id>.log`
  // survives, the live screen does not.
  ranBefore(c.order, 'capturePane:lead-a', 'killSession:lead-a');
  // And the kill must come after LEAD_DEAD, or the record of WHY the lead died is gone.
  ranBefore(c.order, 'event:LEAD_DEAD', 'killSession:lead-a');
  // `spawnLead` refuses unconditionally while the session exists, and that refusal is
  // correct — so without this kill every revival respawn is blocked permanently.
  ranBefore(c.order, 'killSession:lead-a', 'spawnLead:a');
  assert.deepEqual(c.calls.killSession, ['lead-a']);
  assert.deepEqual(c.calls.spawnLead, ['a'], 'saturated context is a FRESH session, not a resume');
  assert.deepEqual(c.calls.resumeLead, []);
  const dead = oneEvent(c, 'LEAD_DEAD');
  assert.equal(dead.payload.plan, 'fresh');
  // `zero_tail_rows` moves no verdict (that is `revive.mjs`'s decision) but it is exactly
  // the annotation that tells an operator this lead died mid-call rather than finishing.
  assert.equal(dead.payload.zero_tail_rows, 2);
  assert.match(dead.payload.tail, /Pane is dead/);
});

test('the death scene rides along BOUNDED, because one event is one atomic append', async () => {
  const { tick } = await load('c19b-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', attempts: 0 })] },
    alive: new Set(),
    capturePane: () => 'x'.repeat(5000),
  });
  await tick(c.deps);
  // `events.appendEvent` takes appends with no lock because one event is one `write(2)` inside
  // the kernel's ~4 KiB atomic window; a line that overruns it can interleave with another
  // writer's and forge or lose events. So both ends are bounded — the lines asked of tmux and
  // the characters kept — and `logs/<id>.log` holds the untruncated transcript.
  const tail = oneEvent(c, 'LEAD_DEAD').payload.tail;
  assert.ok(tail.length <= 800, `the tail is bounded, got ${tail.length} chars`);
  assert.equal(c.calls.capturePane[0][1], 12, 'and tmux is asked for a glance, not the scrollback');
});

test('the revival decision reads live_context from readUsage(uuid), never a directory aggregate', async () => {
  const { tick } = await load('c8-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'lead-uuid' })] },
    alive: new Set(),
    readUsage: () => usage({ uuid: 'lead-uuid', live_context: 800_000 }),
  });
  await tick(c.deps);
  // `readDirUsage` reports `est_tokens` and deliberately DELETES `live_context`, so handing it
  // to `planRevival` looks like a good spend number while silently removing the field the
  // decision turns on. `planRevival` refuses that shape BY NAME — so the pin is twofold: the
  // per-session reader was the one asked, for this uuid, and it was asked BEFORE any directory
  // read, which is what makes the revival decision's input unambiguous.
  assert.deepEqual(c.calls.readUsage, ['lead-uuid']);
  ranBefore(c.order, 'readUsage:lead-uuid', 'readDirUsage:/w/a');
  // And nothing was refused by name: had a directory aggregate reached `planRevival`, its
  // `usage.live_context is missing` throw would be sitting in the log instead of a revival.
  assert.deepEqual(eventsOf(c, 'WATCHDOG_ERROR'), []);
  assert.deepEqual(c.calls.spawnLead, ['a'], '800k of 700k is saturated: fresh, not resume');
});

test('est_tokens is never reused as a context proxy: a huge spend still resumes', async () => {
  const { tick } = await load('c5-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u' })] },
    alive: new Set(),
    // Numbers of the size a real transcript shows: ~120M cumulative against ~600k live.
    // A 200x gap. Judged on spend, this lead is refused a resume; judged on context —
    // which is the question — it is the best resume candidate in the fleet.
    readUsage: () => usage({ uuid: 'u', est_tokens: 120_000_000, live_context: 600_000 }),
  });
  await tick(c.deps);
  assert.deepEqual(c.calls.resumeLead, ['a']);
  assert.deepEqual(c.calls.spawnLead, []);
});

test('a fresh revival writes the NEW session uuid onto the row, or the breaker meters a dead session', async () => {
  const { tick } = await load('rev-uuid-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'old', attempts: 0 })] },
    alive: new Set(),
    readUsage: () => usage({ uuid: 'old', live_context: 900_000 }),
    spawnLead: () => ({ lead: 'a', session_uuid: 'brand-new', tmux_target: 'lead-a', cwd: '/w/a' }),
  });
  await tick(c.deps);
  // The uuid-on-the-row reasoning applies to this path too: a fresh session mints a NEW uuid, so
  // a row still naming the dead one meters a transcript that will never grow again.
  assert.equal(c.task().lead_session_uuid, 'brand-new');
  assert.equal(c.task().attempts, 1, 'the tick stamps attempts; revive.mjs only judges them');
  assert.equal(c.task().status, 'spawned', 'reconcile proposes no status transition');
  assert.equal(oneEvent(c, 'REVIVED').payload.plan, 'fresh');
});

test('a row with no recorded uuid is respawned fresh, because there is no session to resume', async () => {
  const { tick } = await load('rev-nouuid-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: null, attempts: 0 })] },
    alive: new Set(),
  });
  await tick(c.deps);
  // `planRevival` answers `resume` for an unsaturated lead and knows nothing about the uuid,
  // while `resumeLead` refuses a row without one — so a `soma_spawn` that died between the
  // status flip and the uuid write would burn all three attempts on a guaranteed throw and
  // then give up on a task that had never started.
  assert.deepEqual(c.calls.resumeLead, []);
  assert.deepEqual(c.calls.spawnLead, ['a']);
  assert.equal(oneEvent(c, 'LEAD_DEAD').payload.plan, 'fresh');
});

test('giveup is announced once, toasts once, and stops trying', async () => {
  const { tick } = await load('giveup-' + Date.now());
  const fleet = () => ({ tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', attempts: 3 })] });
  const first = ctx({ fleet: fleet(), alive: new Set() });
  await tick(first.deps);
  const gave = oneEvent(first, 'GAVE_UP');
  assert.equal(gave.lead, 'a', 'the top-level lead field: this is what soma_inbox folds to `failed`');
  assert.equal(gave.payload.attempts, 3);
  assert.equal(first.calls.notify.length, 1);
  assert.deepEqual(first.calls.spawnLead, []);
  assert.deepEqual(first.calls.resumeLead, []);
  assert.deepEqual(first.calls.killSession, [], 'the dead pane is the post-mortem; nothing needs it destroyed');
  // The row stays `spawned` until the orchestrator folds the GAVE_UP, so an unguarded
  // second tick would re-toast forever. The durable log is the dedupe.
  const again = ctx({ fleet: fleet(), alive: new Set(), orchEvents: [ev('GAVE_UP', 'a', NOW - MIN, { attempts: 3 })] });
  await tick(again.deps);
  assert.deepEqual(eventsOf(again, 'GAVE_UP'), []);
  assert.deepEqual(eventsOf(again, 'LEAD_DEAD'), [], 'nothing new happened, so nothing is said');
  assert.deepEqual(again.calls.notify, []);
});

test('a revival whose respawn throws is recorded and counted, not swallowed', async () => {
  const { tick } = await load('rev-throw-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', attempts: 0 })] },
    alive: new Set(),
    resumeLead: () => { throw new Error('tmux new-session failed (1): duplicate session'); },
  });
  await tick(c.deps);
  const err = oneEvent(c, 'WATCHDOG_ERROR');
  assert.equal(err.lead, 'a');
  assert.match(err.payload.error, /duplicate session/);
  assert.deepEqual(eventsOf(c, 'REVIVED'), []);
  // Counted, so three failing revivals reach `giveup` instead of retrying forever.
  assert.equal(c.task().attempts, 1);
});

test('liveness that could not be read skips reconcile and revival, and says so', async () => {
  const { tick } = await load('unknown-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u' })] },
    alive: null,                                                  // tmux.liveSessions could not read
  });
  await tick(c.deps);
  // A 5 s tmux timeout reports the same empty output a healthy idle server does. Read as
  // "nothing alive", one hiccup makes all ten spawned rows look dead in the same tick, and
  // the tick then kills and respawns ten LIVE leads. One tick of latency is the cheap side.
  assert.deepEqual(eventsOf(c, 'LEAD_DEAD'), []);
  assert.deepEqual(c.calls.killSession, []);
  assert.deepEqual(c.calls.spawnLead, [], 'nothing is revived, and nothing is admitted into a fleet we cannot see');
  const unreadable = oneEvent(c, 'TMUX_UNREADABLE');
  assert.equal(unreadable.payload.skipped.includes('revival'), true);
  assert.equal(unreadable.payload.skipped.includes('reconcile'), true);
  // The pane census reads the same server, so it is skipped in the same breath — and NOTHING is
  // written about any pane: an unlisted fleet is not an absent one.
  assert.equal(unreadable.payload.skipped.includes('pane_census'), true);
  assert.equal(c.task().pane_state, undefined);
  assert.deepEqual(c.calls.capturePane, []);
  // The breaker still runs: metering reads transcripts, not tmux, and a spend cap that
  // switched itself off whenever tmux hiccuped would be inert exactly when things are wrong.
  assert.deepEqual(c.calls.readDirUsage, ['/w/a']);
});

// ════════════════════════ The pane census ════════════════════════
//
// `status` is the lifecycle word and stays untouched. What the PANE shows is a second field,
// `pane_state`, written beside it — because the two disagree in exactly the cases that can cost
// days: a `done` row whose lead sat more than a day on a permission dialog, and `blocked` /
// `done` rows whose "leads" were the bare `zsh` panes tmux-resurrect recreated after a reboot.
// `liveSessions` reads a shell pane as alive (`pane_dead=0`), so reconcile never saw them.

test('a spawned lead whose pane is a bare shell is alarmed once and reconciled as DEAD, though liveSessions calls it alive', async () => {
  const { tick } = await load('shell-spawned-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', tmux_session: 'lead-a' })] },
    alive: new Set(['lead-a']),                          // pane_dead=0: the liveness read says alive
    panes: new Map([['lead-a', shellPane()]]),           // ...but the pane is running zsh
    readUsage: () => usage({ uuid: 'u', live_context: 10 }),
    capturePane: () => SHELL_FRAME,
  });
  await tick(c.deps);

  // The alarm: on ENTRY, with the shell's screen as the excerpt — where a symptom seen live,
  // `zsh: command not found: Operator:`, is visible — bounded like the death scene.
  const shell = oneEvent(c, 'LEAD_DEAD_SHELL');
  assert.equal(shell.lead, 'a');
  assert.equal(shell.payload.cmd, 'zsh');
  assert.equal(shell.payload.pid, 7955);
  assert.equal(shell.payload.since, NOW);
  assert.match(shell.payload.excerpt, /command not found: Operator/);
  assert.ok(shell.payload.excerpt.length <= 800);
  assert.equal(shell.payload.revivable, true, 'a spawned row is the one status reconcile revives');
  assert.equal(c.calls.notify.length, 1, 'the toast: a human is the only party who can see the pane');

  // Reconcile is handed `alive` MINUS the dead shells, so the existing revival path runs
  // unchanged: LEAD_DEAD (annotated with the census reading), kill, resume-first respawn.
  const dead = oneEvent(c, 'LEAD_DEAD');
  assert.equal(dead.payload.pane_state, 'dead_shell', 'an operator can tell a corpse-shell from a crash');
  assert.deepEqual(c.calls.killSession, ['lead-a']);
  assert.deepEqual(c.calls.resumeLead, ['a']);
  ranBefore(c.order, 'event:LEAD_DEAD_SHELL', 'event:LEAD_DEAD');

  // The row: pane fields written, `status` and `updated` NOT touched (the status-change clock the
  // inbox fold and the wall cap read), and nothing routed through setTaskStatus.
  assert.equal(c.task().pane_state, 'dead_shell');
  assert.equal(c.task().pane_state_since, NOW);
  assert.equal(c.task().pane_cmd, 'zsh');
  assert.equal(c.task().status, 'spawned');
  assert.equal(c.task().updated, NOW - 10 * MIN, '`updated` is the status-change clock and the census never stamps it');
  assert.deepEqual(c.calls.setTaskStatus, []);
});

test('a dead shell on a done or blocked row is surfaced and left standing: the reaper\'s scope, not revival\'s', async () => {
  const { tick } = await load('shell-done-' + Date.now());
  // Two rows a tmux-resurrect restore left as zsh, one `blocked` and one `done`. Reconcile skips
  // them by STATUS before liveness is read, and that is correct — killing a finished lead's pane
  // is the unbuilt `linger_minutes` reaper's job, and `soma_resume` refuses while a pane is live,
  // so the orchestrator must `soma_kill`.
  const c = ctx({
    fleet: { tasks: [
      row({ id: 'a', status: 'done', lead_session_uuid: 'u', tmux_session: 'lead-a', updated: NOW - 5 * MIN }),
      row({ id: 'b', status: 'blocked', lead_session_uuid: 'v', tmux_session: 'lead-b', updated: NOW - 6 * MIN }),
    ] },
    alive: new Set(['lead-a', 'lead-b']),
    panes: new Map([['lead-a', shellPane()], ['lead-b', shellPane()]]),
    capturePane: () => SHELL_FRAME,
  });
  await tick(c.deps);
  const shells = eventsOf(c, 'LEAD_DEAD_SHELL');
  assert.deepEqual(shells.map((e) => e.lead).sort(), ['a', 'b']);
  for (const e of shells) {
    assert.equal(e.payload.revivable, false);
    assert.match(e.payload.why, /soma_kill/, 'the move the orchestrator has: kill, then re-queue if the work is unfinished');
  }
  assert.equal(c.calls.notify.length, 2);
  assert.deepEqual(eventsOf(c, 'LEAD_DEAD'), []);
  assert.deepEqual(c.calls.killSession, [], 'not killed here: an unrequested killer of tmux sessions is the wrong way to widen this file');
  assert.deepEqual(c.calls.spawnLead, []);
  assert.deepEqual(c.calls.resumeLead, []);
  assert.equal(c.task('a').status, 'done');
  assert.equal(c.task('b').status, 'blocked');
  assert.equal(c.task('a').updated, NOW - 5 * MIN);
  assert.equal(c.task('a').pane_state, 'dead_shell');
  assert.equal(c.task('b').pane_state, 'dead_shell');
});

test('a lead blocked on a permission dialog is announced once with the dialog, and nothing is typed, killed or respawned', async () => {
  const { tick } = await load('prompt-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', tmux_session: 'lead-a' })] },
    alive: new Set(['lead-a']),
    // Measured at the dialog: the title keeps its `✳` — the idle glyph — and the pane
    // still runs claude. Only the frame tells.
    panes: new Map([['lead-a', livePane({ cmd: '2.1.259', title: '✳ Fix the flaky test' })]]),
    capturePane: () => PROMPT_FRAME,
  });
  await tick(c.deps);
  const blocked = oneEvent(c, 'LEAD_BLOCKED_ON_PROMPT');
  assert.equal(blocked.lead, 'a');
  assert.equal(blocked.payload.kind, 'permission');
  assert.equal(blocked.payload.since, NOW);
  // The row's status rides on the event: a digest has to tell a spawned row on a dialog from a
  // done row on one, and the orchestrator's move differs (see the done-row test below).
  assert.equal(blocked.payload.status, 'spawned');
  assert.equal(blocked.payload.cmd, '2.1.259');
  assert.equal(blocked.payload.title, '✳ Fix the flaky test');
  // The excerpt is what a human needs to decide: the command behind the `│` bars, bounded for
  // the 4 KiB atomic-append window like `LEAD_DEAD.tail`. Paths belong HERE, never in a status row.
  assert.match(blocked.payload.excerpt, /Do you want to proceed\?/);
  assert.match(blocked.payload.excerpt, /grep -n x somefile\.txt/);
  assert.ok(blocked.payload.excerpt.length <= 800);
  assert.equal(c.calls.notify.length, 1);
  assert.match(c.calls.notify[0][1], /prompt/i);
  // The census asked for the live frame, 40 lines, of the row's recorded session.
  assert.deepEqual(c.calls.capturePane, [['lead-a', 40]]);
  // Not a death, not a revival, not a status change, and no keystroke of any kind — measured:
  // Enter into this dialog APPROVES the pending command, Escape declines it AND stops the turn.
  assert.deepEqual(eventsOf(c, 'LEAD_DEAD'), []);
  assert.deepEqual(c.calls.killSession, []);
  assert.deepEqual(c.calls.spawnLead, []);
  assert.deepEqual(c.calls.resumeLead, []);
  assert.deepEqual(c.calls.setTaskStatus, []);
  assert.equal(c.task().status, 'spawned', 'a prompt-blocked lead still holds a live claude and its slot; `blocked` would free it');
  assert.equal(c.task().updated, NOW - 10 * MIN);
  assert.equal(c.task().pane_state, 'blocked_on_prompt');
  assert.equal(c.task().pane_kind, 'permission');
  assert.equal(c.task().pane_state_since, NOW);
});

test('a done row on a dialog is alarmed with status done and nothing is killed — on this build a done row keeps working', async () => {
  const { tick } = await load('prompt-done-' + Date.now());
  // Prompt-blocked leads have been seen on re-briefed `done` rows the operator was still working.
  // A `done` row on a dialog is a lingering WORKER on a dialog, not a corpse: surfaced, toasted,
  // and left to a human at the pane.
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'done', lead_session_uuid: 'u', tmux_session: 'lead-a', updated: NOW - 5 * MIN })] },
    alive: new Set(['lead-a']),
    panes: new Map([['lead-a', livePane({ cmd: '2.1.259', title: '✳ Review the release notes' })]]),
    capturePane: () => PROMPT_FRAME,
  });
  await tick(c.deps);
  const blocked = oneEvent(c, 'LEAD_BLOCKED_ON_PROMPT');
  assert.equal(blocked.payload.status, 'done', 'the status the digest keys on');
  // (the other toast on this one-row fleet is FLEET_DRAINED — not the census's.)
  assert.equal(c.calls.notify.filter(([, body]) => /prompt/i.test(body)).length, 1, 'toasted like any other: the day-long stall WAS a done row');
  assert.deepEqual(c.calls.killSession, [], 'the watchdog kills nothing here, and the orchestrator prompt no longer tells the model to');
  assert.deepEqual(c.calls.setTaskStatus, []);
  assert.equal(c.task().status, 'done');
  assert.equal(c.task().pane_state, 'blocked_on_prompt');
});

test('a lead on an AskUserQuestion dialog is announced as blocked_on_prompt/question — it read unrecognised on the live fleet', async () => {
  const { tick } = await load('askq-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', tmux_session: 'lead-a' })] },
    alive: new Set(['lead-a']),
    panes: new Map([['lead-a', livePane({ title: '✳ Claude Code' })]]),
    capturePane: () => QUESTION_FRAME,
  });
  await tick(c.deps);
  const blocked = oneEvent(c, 'LEAD_BLOCKED_ON_PROMPT');
  assert.equal(blocked.payload.kind, 'question');
  assert.match(blocked.payload.excerpt, /Enter to select/);
  assert.match(c.calls.notify[0][1], /question/i, 'the toast says the lead is ASKING — the human reads the question, not a command');
  assert.equal(c.task().pane_state, 'blocked_on_prompt');
  assert.equal(c.task().pane_kind, 'question');
  assert.deepEqual(c.calls.killSession, []);
  assert.deepEqual(c.calls.setTaskStatus, []);
});

test('the alarm is deduped off the persisted row, and leaving the state is announced as a quiet recovery', async () => {
  const { tick } = await load('dedupe-' + Date.now());
  const seen = { pane_state: 'blocked_on_prompt', pane_state_since: NOW - 5 * MIN, pane_kind: 'permission', pane_cmd: '2.1.259' };
  const still = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', tmux_session: 'lead-a', ...seen })] },
    alive: new Set(['lead-a']),
    panes: new Map([['lead-a', livePane({ cmd: '2.1.259' })]]),
    capturePane: () => PROMPT_FRAME,
  });
  await tick(still.deps);
  // Still blocked: nothing is said again. An alarm every 30 s is one an operator mutes, and the
  // dedupe is the persisted field rather than a new `orchHistory` case, so a lost fleet write
  // re-emits (duplicate over lost) while a present one stays silent.
  assert.deepEqual(eventsOf(still, 'LEAD_BLOCKED_ON_PROMPT'), []);
  assert.deepEqual(eventsOf(still, 'LEAD_PANE_RECOVERED'), []);
  assert.deepEqual(still.calls.notify, []);
  assert.equal(still.task().pane_state_since, NOW - 5 * MIN, 'the clock is when the state was ENTERED, not last seen');

  const answered = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', tmux_session: 'lead-a', ...seen })] },
    alive: new Set(['lead-a']),
    panes: new Map([['lead-a', livePane()]]),
    capturePane: () => IDLE_FRAME,
  });
  await tick(answered.deps);
  const rec = oneEvent(answered, 'LEAD_PANE_RECOVERED');
  assert.equal(rec.lead, 'a');
  assert.deepEqual(rec.payload, { from: 'blocked_on_prompt', to: 'alive' });
  assert.deepEqual(answered.calls.notify, [], 'a recovery is read, not toasted');
  assert.equal(answered.task().pane_state, 'alive');
  assert.equal(answered.task().pane_state_since, NOW);

  // A dead shell that an operator has since killed leaves the state too — to `absent`.
  const killed = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'done', tmux_session: 'lead-a', pane_state: 'dead_shell', pane_state_since: NOW - MIN, pane_cmd: 'zsh' })] },
    alive: new Set(),
    panes: new Map(),
  });
  await tick(killed.deps);
  assert.deepEqual(oneEvent(killed, 'LEAD_PANE_RECOVERED').payload, { from: 'dead_shell', to: 'absent' });
  assert.equal(killed.task().pane_state, 'absent');
});

test('an unobservable pane is not a verdict: it neither alarms, nor kills, nor clears a verdict already held', async () => {
  const { tick } = await load('unobs-' + Date.now());
  // (i) A live claude pane whose capture came back empty. The census must not read that as
  // blocked, as a shell, or as dead — a tmux hiccup has marked live leads dead in this project
  // before, and that failure is unrecoverable in the destructive direction.
  const blank = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', tmux_session: 'lead-a' })] },
    alive: new Set(['lead-a']),
    panes: new Map([['lead-a', livePane()]]),
    capturePane: () => '',
  });
  await tick(blank.deps);
  assert.deepEqual(eventsOf(blank, 'LEAD_BLOCKED_ON_PROMPT'), []);
  assert.deepEqual(eventsOf(blank, 'LEAD_DEAD_SHELL'), []);
  assert.deepEqual(eventsOf(blank, 'LEAD_DEAD'), []);
  assert.deepEqual(blank.calls.killSession, []);
  assert.deepEqual(blank.calls.spawnLead, []);
  assert.deepEqual(blank.calls.notify, []);
  assert.equal(blank.task().pane_state, 'unobservable', 'recorded as such when there is no earlier verdict to keep');
  assert.notEqual(blank.task().pane_state, 'dead_pane');
  assert.notEqual(blank.task().pane_state, 'alive');

  // (ii) A standing alarm survives a hiccup: no false RECOVERED, no re-alarm next tick.
  const held = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', tmux_session: 'lead-a', pane_state: 'blocked_on_prompt', pane_state_since: NOW - 3 * MIN, pane_kind: 'permission' })] },
    alive: new Set(['lead-a']),
    panes: new Map([['lead-a', livePane()]]),
    capturePane: () => '',
  });
  await tick(held.deps);
  assert.deepEqual(eventsOf(held, 'LEAD_PANE_RECOVERED'), []);
  assert.equal(held.task().pane_state, 'blocked_on_prompt');
  assert.equal(held.task().pane_state_since, NOW - 3 * MIN);

  // (iii) A capture that THROWS is reported against that lead — loud and local — and changes nothing.
  const threw = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', tmux_session: 'lead-a', pane_state: 'alive', pane_state_since: NOW - MIN })] },
    alive: new Set(['lead-a']),
    panes: new Map([['lead-a', livePane()]]),
    capturePane: () => { throw new Error('tmux killed by SIGKILL after 5000ms'); },
  });
  await tick(threw.deps);
  const err = oneEvent(threw, 'WATCHDOG_ERROR');
  assert.equal(err.lead, 'a');
  assert.equal(err.payload.where, 'pane_census');
  assert.match(err.payload.error, /SIGKILL/);
  assert.equal(threw.task().pane_state, 'alive');
  assert.deepEqual(eventsOf(threw, 'LEAD_DEAD'), []);
});

test('a transcript quoting the dialog above a live composer does not alarm', async () => {
  const { tick } = await load('quoted-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', tmux_session: 'lead-a' })] },
    alive: new Set(['lead-a']),
    panes: new Map([['lead-a', livePane()]]),
    capturePane: () => QUOTED_FRAME,
  });
  await tick(c.deps);
  assert.deepEqual(eventsOf(c, 'LEAD_BLOCKED_ON_PROMPT'), []);
  assert.deepEqual(c.calls.notify, []);
  assert.equal(c.task().pane_state, 'alive');
});

test('the census reads every row with a session under its recorded name, and never a queued one', async () => {
  const { tick } = await load('names-' + Date.now());
  const c = ctx({
    fleet: { tasks: [
      row({ id: 'q', status: 'queued' }),
      row({ id: 'a', status: 'done', tmux_session: 'lead-a-r2' }),         // a legitimate retry suffix
      row({ id: 'b', status: 'failed', tmux_session: '%1' }),              // not a session name: fall back
      row({ id: 'c', status: 'skipped', tmux_session: 'lead-c\n' }),       // nor is this
    ] },
    alive: new Set(['lead-a-r2', 'lead-b', 'lead-c']),
    panes: new Map([['lead-a-r2', livePane()], ['lead-b', shellPane()], ['lead-c', livePane()]]),
    capturePane: () => IDLE_FRAME,
    cfg: cfgOf({ max_leads: 0 }),                                            // so the queued row is not admitted mid-test
  });
  await tick(c.deps);
  // The census (40-line captures) reads only the live non-shell panes; the shell is classified
  // from the listing alone, and its ONE capture is the 12-line excerpt taken on entry for the
  // LEAD_DEAD_SHELL event — the death-scene glance, not a census read.
  assert.deepEqual(c.calls.capturePane.filter(([, n]) => n === 40).map(([name]) => name).sort(), ['lead-a-r2', 'lead-c']);
  assert.deepEqual(c.calls.capturePane.filter(([name]) => name === 'lead-b').map(([, n]) => n), [12]);
  assert.equal(c.task('a').pane_state, 'alive');
  assert.equal(c.task('b').pane_state, 'dead_shell');
  assert.equal(c.task('c').pane_state, 'alive');
  assert.equal(c.task('q').pane_state, undefined, 'a queued row has no session to read');
  assert.equal(oneEvent(c, 'LEAD_DEAD_SHELL').lead, 'b');
});

test('a pane listing that could not be read skips the census and says so, even when liveness could be read', async () => {
  const { tick } = await load('census-null-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', tmux_session: 'lead-a' })] },
    alive: new Set(['lead-a']),
    panes: null,
  });
  await tick(c.deps);
  const unreadable = oneEvent(c, 'TMUX_UNREADABLE');
  assert.deepEqual(unreadable.payload.skipped, ['pane_census']);
  assert.deepEqual(eventsOf(c, 'LEAD_DEAD'), [], 'liveness WAS read, so reconcile ran and found the lead alive');
  assert.equal(c.task().pane_state, undefined, 'an unlisted pane is not written as anything');
  assert.deepEqual(c.calls.capturePane, []);
});

test('one capture that hits the tmux timeout stops the tick\'s remaining captures; the rest read unobservable, never alive', async () => {
  const { tick } = await load('census-timeout-' + Date.now());
  // The clock advances 5 s on every capture, which is what a wedged server's SIGKILL looks like
  // from inside the tick. Without the trip, N leads would cost N x 5 s per tick.
  let slow = 0;
  const c = ctx({
    fleet: { tasks: [
      row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', tmux_session: 'lead-a' }),
      row({ id: 'b', status: 'spawned', lead_session_uuid: 'v', tmux_session: 'lead-b' }),
    ] },
    alive: new Set(['lead-a', 'lead-b']),
    panes: new Map([['lead-a', livePane()], ['lead-b', livePane()]]),
    capturePane: () => { slow += 5000; return IDLE_FRAME; },
    deps: { now: () => NOW + slow },
  });
  await tick(c.deps);
  assert.equal(c.calls.capturePane.length, 1, 'one slow capture, then none');
  assert.equal(c.task('a').pane_state, 'alive');
  assert.equal(c.task('b').pane_state, 'unobservable');
  const err = eventsOf(c, 'WATCHDOG_ERROR').find((e) => e.lead === 'b');
  assert.ok(err, 'the skipped lead is named');
  assert.equal(err.payload.where, 'pane_census');
  assert.match(err.payload.error, /skipped/);
  assert.deepEqual(eventsOf(c, 'LEAD_DEAD'), []);
});

test('LEAD_DEAD carries the census reading for an ordinary death, and null when there was no census', async () => {
  const { tick } = await load('dead-annot-' + Date.now());
  const gone = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u' })] },
    alive: new Set(),
  });
  await tick(gone.deps);
  assert.equal(oneEvent(gone, 'LEAD_DEAD').payload.pane_state, 'absent');
  assert.equal(gone.task().pane_state, 'absent');
  const unlisted = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u' })] },
    alive: new Set(),
    panes: null,
  });
  await tick(unlisted.deps);
  assert.equal(oneEvent(unlisted, 'LEAD_DEAD').payload.pane_state, null);
});

// ════════════════════════ NEEDS_INPUT -> blocked ════════════════════════

test('NEEDS_INPUT becomes blocked only after blocked_slot_minutes, and stamps the EVENT\'s time', async () => {
  const { tick } = await load('c1-' + Date.now());
  const asked = NOW - 130 * MIN;                                  // past the 120-minute grace
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', updated: NOW - 200 * MIN })] },
    alive: new Set(['lead-a']),
    leadEvents: { a: [ev('STARTED', 'a', NOW - 199 * MIN), ev('NEEDS_INPUT', 'a', asked)] },
  });
  await tick(c.deps);
  assert.equal(c.task().status, 'blocked');
  // The EVENT's time, not now. Stamping `Date.now()` here puts `updated` ~30 s ahead of the
  // event that decided it, and then a COMPLETED filed BEFORE the flip can never decide the row:
  // `decidesFateOf` declines forever, the slot is free but FLEET_DRAINED and FLEET_SETTLED
  // never fire, and the fleet never reports finishing. Reachable whenever the watchdog has
  // lagged past a whole block-and-answer cycle.
  assert.equal(c.task().updated, asked);
  assert.notEqual(c.task().updated, NOW, 'the clock is not the event');
  // Not through `setTaskStatus`: it stamps `Date.now()` unconditionally, which is the same
  // defect, and on a genuine re-entry into `spawned` it also re-arms the 90 s stagger.
  assert.deepEqual(c.calls.setTaskStatus, []);
  const blocked = oneEvent(c, 'BLOCKED');
  assert.equal(blocked.lead, 'a');
  assert.equal(blocked.payload.asked_at, asked);
});

test('the grace is blocked_slot_minutes MINUTES, and a lead inside it keeps its slot', async () => {
  const { tick } = await load('c1b-' + Date.now());
  const at = (askedAgoMin) => {
    const c = ctx({
      fleet: { tasks: [
        row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', updated: NOW - 200 * MIN }),
        row({ id: 'b', status: 'queued' }),
      ] },
      alive: new Set(['lead-a']),
      leadEvents: { a: [ev('NEEDS_INPUT', 'a', NOW - askedAgoMin * MIN)] },
      queuePaused: true,                                          // hold admission still; this test is about the flip
    });
    return c;
  };
  const inside = at(119);
  await tick(inside.deps);
  assert.equal(inside.task().status, 'spawned', 'a lead waiting on a human keeps its slot for the whole grace');
  assert.deepEqual(eventsOf(inside, 'BLOCKED'), []);
  const outside = at(120);
  await tick(outside.deps);
  assert.equal(outside.task().status, 'blocked', '120 minutes is minutes, not milliseconds');
});

test('the flip copies both of the bus fold\'s guards: only spawned rows, and only a newer event', async () => {
  const { tick } = await load('c10-' + Date.now());
  const asked = NOW - 130 * MIN;
  // (a) A `queued` row was never spawned; a `done`/`failed`/`skipped` one must not be
  // reopened by a stale line in a log — that is what stops a re-delivery undoing an
  // operator's `soma_kill`.
  for (const status of ['queued', 'done', 'failed', 'skipped', 'blocked']) {
    const c = ctx({
      fleet: { tasks: [row({ id: 'a', status, lead_session_uuid: 'u', updated: NOW - 200 * MIN })] },
      alive: new Set(['lead-a']),
      leadEvents: { a: [ev('NEEDS_INPUT', 'a', asked)] },
      queuePaused: true,          // else the `queued` row is admitted and this test measures admission
    });
    await tick(c.deps);
    assert.equal(c.task().status, status, `a ${status} row is not flipped`);
    assert.deepEqual(eventsOf(c, 'BLOCKED'), [], `a ${status} row emits no BLOCKED`);
  }
  // (b) A NEEDS_INPUT older than the row's own last state change belongs to a previous
  // session. Without this, a revival respawn is blocked-flipped on its first tick by the
  // question the *dead* lead asked.
  const stale = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', updated: NOW - 5 * MIN })] },
    alive: new Set(['lead-a']),
    leadEvents: { a: [ev('NEEDS_INPUT', 'a', asked)] },
  });
  await tick(stale.deps);
  assert.equal(stale.task().status, 'spawned');
  assert.deepEqual(eventsOf(stale, 'BLOCKED'), []);
});

test('the flip re-checks the row INSIDE the transaction, so a concurrent close is not overwritten', async () => {
  const { tick } = await load('c10f-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', updated: NOW - 200 * MIN })] },
    alive: new Set(['lead-a']),
    leadEvents: { a: [ev('NEEDS_INPUT', 'a', NOW - 130 * MIN)] },
  });
  // The decision above was taken against a LOCK-FREE snapshot, and between that read and this
  // write the orchestrator's `soma_inbox` can have folded a COMPLETED — or an operator can have
  // run `soma_kill`. Writing `blocked` over either is a second writer disagreeing with the
  // first about a row it does not own.
  const inner = c.deps.updateFleet;
  c.deps.updateFleet = (mutate) => {
    c.store.tasks[0].status = 'done';                 // the fold lands first
    c.store.tasks[0].updated = NOW - MIN;
    return inner(mutate);
  };
  await tick(c.deps);
  assert.equal(c.task().status, 'done', 'the fold wins; the flip declines rather than reopening a closed row');
  assert.equal(c.task().updated, NOW - MIN);
});

test('a blocked flip lets FLEET_SETTLED fire in the SAME tick', async () => {
  const { tick } = await load('c15d-' + Date.now());
  const asked = NOW - 130 * MIN;
  const c = ctx({
    fleet: { tasks: [
      row({ id: 'a', status: 'done', updated: NOW - 60 * MIN }),
      row({ id: 'b', status: 'spawned', lead_session_uuid: 'u', updated: NOW - 200 * MIN }),
    ] },
    alive: new Set(['lead-b']),
    leadEvents: { b: [ev('NEEDS_INPUT', 'b', asked)] },
    lastEventTs: NOW - 31 * MIN,
  });
  await tick(c.deps);
  // This is the event-time stamp's stated consequence, from the working side: the slot frees
  // either way, but FLEET_SETTLED is what makes a "7 done, 1 failed, 2 need you" fleet report at all.
  // The later phases have to read the row the flip published, not the one read at the top of
  // the tick, or the fleet goes quiet for a whole extra tick every time — and forever, if the
  // stamp is wrong.
  assert.equal(c.task('b').status, 'blocked');
  assert.equal(oneEvent(c, 'FLEET_SETTLED').payload.tasks, 2);
  assert.equal(c.calls.notify.length, 1);
});

test('blocked_slot_minutes is required, not defaulted, and the NEWEST question governs the grace', async () => {
  const { tick } = await load('c1c-' + Date.now());
  const c = ctx({
    cfg: cfgOf({ blocked_slot_minutes: undefined }),
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', updated: NOW - 200 * MIN })] },
    alive: new Set(['lead-a']),
    leadEvents: { a: [ev('NEEDS_INPUT', 'a', NOW - 130 * MIN)] },
  });
  // A renamed or dropped key silently substituting the shipped 120 is how a governor stops
  // being the operator's setting while still looking like one. Refused by name instead.
  await assert.rejects(() => tick(c.deps), /blocked_slot_minutes/);

  // Two questions: the older one is past the grace, the newer one is inside it. A lead that
  // asked again two minutes ago is waiting on a human right now, and taking the FIRST match
  // instead of the newest would release its slot on the strength of a question it has already
  // moved past.
  const twice = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', updated: NOW - 300 * MIN })] },
    alive: new Set(['lead-a']),
    leadEvents: { a: [ev('NEEDS_INPUT', 'a', NOW - 200 * MIN), ev('NEEDS_INPUT', 'a', NOW - 2 * MIN)] },
  });
  await tick(twice.deps);
  assert.equal(twice.task().status, 'spawned');
  assert.deepEqual(eventsOf(twice, 'BLOCKED'), []);
});

test('an event with no `ts` is still placed in time by its own id prefix', async () => {
  const { tick } = await load('c15c-' + Date.now());
  const asked = NOW - 130 * MIN;
  const handWritten = { id: `${String(asked).padStart(13, '0')}-0000`, type: 'NEEDS_INPUT', payload: {}, lead: 'a' };
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', updated: NOW - 200 * MIN })] },
    alive: new Set(['lead-a']),
    leadEvents: { a: [handWritten] },
  });
  await tick(c.deps);
  // `events.mjs` guarantees a record's `ts` IS the numeric prefix of its id, which is what lets
  // a line an operator rebuilt by hand still decide a row — and `bus-tools.stampOf` reads it
  // the same way, so the two must not disagree about which events can be placed.
  assert.equal(c.task().status, 'blocked');
  assert.equal(c.task().updated, asked, 'the stamp comes from the id, not from the clock');
});

test('a lead that answered its question and finished is not flipped to blocked', async () => {
  const { tick } = await load('c10b-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', updated: NOW - 200 * MIN })] },
    alive: new Set(['lead-a']),
    leadEvents: { a: [ev('NEEDS_INPUT', 'a', NOW - 130 * MIN), ev('COMPLETED', 'a', NOW - 100 * MIN, { pr_url: 'u' })] },
  });
  await tick(c.deps);
  // The COMPLETED is newer than the question, so the lead is not waiting on anybody — it is
  // finished, and the bus's fold owns that row. Writing `blocked` over it would be a second
  // writer disagreeing with the first about a live lead's state.
  assert.equal(c.task().status, 'spawned');
  assert.deepEqual(eventsOf(c, 'BLOCKED'), []);
});

test('a NEEDS_INPUT newer than the last REVIVED is honoured; an older one is not', async () => {
  const { tick } = await load('c10c-' + Date.now());
  const revived = NOW - 140 * MIN;
  const mk = (askedAt) => ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', updated: NOW - 300 * MIN })] },
    alive: new Set(['lead-a']),
    leadEvents: { a: [ev('NEEDS_INPUT', 'a', askedAt)] },
    orchEvents: [ev('REVIVED', 'a', revived, { plan: 'fresh' })],
  });
  // A revival does not change the row's status, so `updated` cannot record it — the durable
  // REVIVED event is what dates the current session. Without it, the question the dead lead
  // asked three hours ago blocks the fresh one instantly.
  const before = mk(revived - MIN);
  await tick(before.deps);
  assert.equal(before.task().status, 'spawned', 'a question the PREVIOUS session asked is not this one\'s');
  const after = mk(revived + MIN);
  await tick(after.deps);
  assert.equal(after.task().status, 'blocked');
});

// ════════════════════════ Account rotation: guards for the ROTATED fold ════════════════════════

/**
 * `orchHistory` folds ROTATED beside REVIVED — one arm, `case 'SPAWNED': case 'REVIVED':
 * case 'ROTATED'`, keyed on the row's top-level `lead` and `stampOf(e)` — so a NEEDS_INPUT the
 * pre-rotation process filed cannot flip the resumed lead to `blocked`. The positive pair (a
 * ROTATED dates the session like a REVIVED) is the arm's own test, written with it. These
 * five are the GUARDS on that arm, pinned before it exists: what a fold of a fleet-wide event
 * must not do. Green on `main`, where an unknown type falls to `default: break;`, and green
 * under the arm.
 *
 * The fixture is the REVIVED test above with the dating event swapped for a ROTATED: `updated`
 * 300 min old, the ROTATED 140 min old, the question 141 min old against a 120-min grace. With
 * no fold for THIS lead, `since = updated`, the question passes and the row flips to `blocked`;
 * only a fold that wrongly dates this lead from the row in question keeps it `spawned`.
 * (Keys `rot3`–`rot7`: `rot1`/`rot2`, the positive pair, live with the arm's own test.)
 */
const ROT_AT = NOW - 140 * MIN;
const ROT_PAYLOAD = { lead: 'a', from: 'seat-a', to: 'seat-b', rateLimitType: 'five_hour', resetsAt: NOW + 60 * MIN };
const rotGuardCtx = (askedAt, orchEvents) => ctx({
  fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', updated: NOW - 300 * MIN })] },
  alive: new Set(['lead-a']),
  leadEvents: { a: [ev('NEEDS_INPUT', 'a', askedAt)] },
  orchEvents,
});

test('a ROTATED for another lead dates nothing for this one', async () => {
  const { tick } = await load('rot3-' + Date.now());
  const c = rotGuardCtx(ROT_AT - MIN, [ev('ROTATED', 'b', ROT_AT, { ...ROT_PAYLOAD, lead: 'b' })]);
  await tick(c.deps);
  assert.equal(c.task().status, 'blocked');
});

test('a ROTATED with no lead and a null payload is skipped: the tick completes and the row is judged on its own events', async () => {
  const { tick } = await load('rot4-' + Date.now());
  const torn = { id: `${String(ROT_AT).padStart(13, '0')}-0000`, ts: ROT_AT, type: 'ROTATED', payload: null, lead: null };
  const c = rotGuardCtx(ROT_AT - MIN, [torn]);
  await tick(c.deps);
  assert.equal(c.task().status, 'blocked');
  assert.deepEqual(eventsOf(c, 'WATCHDOG_ERROR'), []);
});

test('a ROTATED that cannot be placed in time (no ts, unparseable id) dates nothing', async () => {
  const { tick } = await load('rot5-' + Date.now());
  const undated = { id: 'hand-written', type: 'ROTATED', payload: ROT_PAYLOAD, lead: 'a' };
  const c = rotGuardCtx(ROT_AT - MIN, [undated]);
  await tick(c.deps);
  assert.equal(c.task().status, 'blocked');
});

test('a ROTATED with a garbage payload is never thrown on: orchHistory runs outside every phase try, and the tick still runs its phases', async () => {
  const { tick } = await load('rot6-' + Date.now());
  // A fold that dereferenced the payload (`e.payload.lead.length`) would turn this one torn line
  // into a tick that rejects forever — `orchHistory` is called before `say`/`fail` exist. Whether
  // the row ends `blocked` (no fold: main) or `spawned` (the ROTATED arm dates it from the top-level
  // lead and stamp) is not this guard's question; that the tick got past `orchHistory` into its
  // census and filed no WATCHDOG_ERROR is.
  const c = rotGuardCtx(ROT_AT - MIN, [ev('ROTATED', 'a', ROT_AT, 'garbage')]);
  await tick(c.deps);
  assert.ok(c.calls.paneStates >= 1, 'phase 0 ran: the fold did not reject the tick');
  assert.deepEqual(eventsOf(c, 'WATCHDOG_ERROR'), []);
  // A guard, not the assertion: the two lines above carry this test (a fold that dereferences the payload reddens it there, with the TypeError); this one only forbids a third state — `failed`, or the row gone.
  assert.ok(['blocked', 'spawned'].includes(c.task().status), c.task().status);
});

test('the per-tick storm BACKPRESSURE stays silent on the desktop: URGENT lives in the bus, and the tick never calls wake()', async () => {
  const { tick } = await load('rot7-' + Date.now());
  // Phase 4's storm emission — `{ evidence }` before the backpressure writer, and
  // `{ reason: 'storm', since, until: null, evidence }` with it — is re-said every frozen tick;
  // routed through a toast it would ring every 30 s.
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u' })] },
    alive: new Set(['lead-a']),
    paneSignals: [{ lead: 'a', paneHit: true, transcriptHit: true }],
  });
  await tick(c.deps);
  assert.equal(oneEvent(c, 'BACKPRESSURE').payload.evidence.length, 1);
  assert.deepEqual(c.calls.notify, []);
});

test('reconcile\'s `updates` are never written, so a dead lead\'s `updated` does not creep', async () => {
  const { tick } = await load('c11b-' + Date.now());
  const before = NOW - 42 * MIN;
  const c = ctx({
    // A DEAD lead, which is the only case `reconcile` returns `updates` for. They re-affirm
    // `spawned` — a no-op in meaning — but written through `setTaskStatus` they stamp `updated`
    // on EVERY tick, which resets the wall-clock cap measured against it and makes the row look
    // newer than any terminal event still unread in the log, so the next drain declines its own
    // flip. `setTaskStatus`'s `!wasSpawned` guard protects `last_spawn_at`, not `updated`.
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', updated: before, attempts: 0 })] },
    alive: new Set(),
  });
  await tick(c.deps);
  assert.equal(c.task().updated, before, 'a revival is not a status change');
  assert.deepEqual(c.calls.setTaskStatus, []);
  assert.equal(c.task().status, 'spawned');
  assert.deepEqual(c.calls.resumeLead, ['a'], 'and the revival itself still happened');
});

test('nothing but a status change stamps `updated` for a live lead either', async () => {
  const { tick } = await load('c11-' + Date.now());
  const before = NOW - 42 * MIN;
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', updated: before })] },
    alive: new Set(['lead-a']),
    readDirUsage: () => dirUsage({ est_tokens: 5, sessions: [usage({ uuid: 'u', turns: 5 })] }),
  });
  await tick(c.deps);
  // `updated` means "when this row's state last changed" and nothing else. `reconcile`
  // returns `updates` that re-affirm `spawned` for each dead lead; applied through
  // `setTaskStatus` they would stamp `updated` every 30 s — which resets the wall-clock cap
  // this tick just measured against it, and makes the row look newer than any terminal event
  // still in the log, so the next drain declines its own flip.
  assert.equal(c.task().updated, before);
  assert.deepEqual(c.calls.setTaskStatus, []);
});

// ════════════════════════ backpressure and admission ════════════════════════

test('a corroborated storm freezes admission and records its evidence', async () => {
  const { tick } = await load('storm-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'queued' })] },
    paneSignals: [{ lead: 'x', paneHit: true, transcriptHit: true }],
  });
  await tick(c.deps);
  assert.deepEqual(eventsOf(c, 'BACKPRESSURE')[0].payload.evidence, [{ lead: 'x' }]);
  assert.deepEqual(c.calls.spawnLead, [], 'leads 3 through 10 never start while lead 2 is rate-limited');
  assert.equal(c.task().status, 'queued');
});

test('an uncorroborated pane hit is not a storm, and admission proceeds', async () => {
  const { tick } = await load('storm2-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'queued' })] },
    paneSignals: [{ lead: 'x', paneHit: true }],                  // one lead, pane only
  });
  await tick(c.deps);
  // A freeze stalls every lead until a human runs `soma thaw`, and a fleet may be working
  // tickets about HTTP 429 handling — so a lead reading 429 logs must not be able to
  // freeze the fleet on its own.
  assert.deepEqual(eventsOf(c, 'BACKPRESSURE'), []);
  assert.deepEqual(c.calls.spawnLead, ['a']);
});

test('admission respects the stagger and max_leads through nextAdmission', async () => {
  const { tick } = await load('adm-' + Date.now());
  const staggered = ctx({
    fleet: { last_spawn_at: NOW - 10_000, tasks: [row({ id: 'a', status: 'queued' })] },
  });
  await tick(staggered.deps);
  assert.deepEqual(staggered.calls.spawnLead, [], '10 s into a 90 s stagger');
  const full = ctx({
    cfg: cfgOf({ max_leads: 1 }),
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u' }), row({ id: 'b', status: 'queued' })] },
    alive: new Set(['lead-a']),
  });
  await tick(full.deps);
  assert.deepEqual(full.calls.spawnLead, [], 'at max_leads');
});

test('only one launch per tick: a revival respawn stands the admission down', async () => {
  const { tick } = await load('one-' + Date.now());
  const c = ctx({
    fleet: { tasks: [
      row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', attempts: 0 }),
      row({ id: 'b', status: 'queued' }),
    ] },
    alive: new Set(),                                             // a is dead -> revival
  });
  await tick(c.deps);
  // Both are launches that hit the API in the same second, which is exactly what
  // `stagger_s` exists to prevent — and a revival cannot re-arm the stagger clock, because
  // `setTaskStatus` only stamps `last_spawn_at` on a genuine transition INTO `spawned`.
  assert.deepEqual(c.calls.resumeLead, ['a']);
  assert.deepEqual(c.calls.spawnLead, [], 'b waits for the next tick');
  assert.equal(c.task('b').status, 'queued');
});

test('a failed admission spawn rolls the row back, and a poisoned head gives up rather than blocking the queue', async () => {
  const { tick } = await load('adm-fail-' + Date.now());
  const mk = (attempts) => ctx({
    fleet: { tasks: [row({ id: 'a', status: 'queued', attempts }), row({ id: 'b', status: 'queued' })] },
    spawnLead: () => { throw new Error('repo "r" is not configured in soma.json'); },
  });
  const first = mk(0);
  await tick(first.deps);
  // Requeued, exactly as `soma_spawn` does it: the task keeps its place and the stagger
  // holds, so a failing spawn is retried every 90 s rather than every 30.
  assert.equal(first.task('a').status, 'queued');
  assert.equal(first.task('a').attempts, 1);
  assert.equal(oneEvent(first, 'WATCHDOG_ERROR').lead, 'a');
  // `admit` always returns the OLDEST queued row, so a task that can never spawn would sit
  // at the head of the queue refusing to move and every task behind it would never start.
  const last = mk(2);
  await tick(last.deps);
  assert.equal(last.task('a').status, 'failed');
  assert.equal(oneEvent(last, 'GAVE_UP').lead, 'a');
  assert.equal(last.calls.notify.length, 1);
});

test('the version gate closes admission and says which version closed it', async () => {
  const { tick } = await load('ver-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'queued' })] },
    versionOk: { ok: false, version: '2.9.0', min: '2.1.178', max: '2.1.999' },
  });
  await tick(c.deps);
  assert.deepEqual(c.calls.spawnLead, []);
  // The sketch's `if (deps.versionOk())` had no else at all: a version bump stalled the
  // whole queue with nothing anywhere saying why.
  const gate = oneEvent(c, 'VERSION_GATE');
  assert.equal(gate.payload.version, '2.9.0');
  assert.equal(gate.payload.tested_max, '2.1.999');
  // And its reason names something the operator can DO. It said admission stays closed "until soma
  // up --canary re-proves them" — and on this build --canary cannot pass: its live driver is not built.
  assert.doesNotMatch(gate.payload.why, /--canary/, 'the gate must not send the operator to a check that cannot pass on this build');
  assert.match(gate.payload.why, /tested_claude/, 'the dial that re-opens it');
  // Announced once per version, not once per tick.
  const again = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'queued' })] },
    versionOk: { ok: false, version: '2.9.0', min: '2.1.178', max: '2.1.999' },
    orchEvents: [ev('VERSION_GATE', null, NOW - MIN, { version: '2.9.0' })],
  });
  await tick(again.deps);
  assert.deepEqual(eventsOf(again, 'VERSION_GATE'), []);
  assert.deepEqual(again.calls.spawnLead, [], 'the gate still holds; only the announcement is deduped');
});

// ════════════════════════ settlement ════════════════════════

test('a drained fleet is announced once, not every thirty seconds forever', async () => {
  const { tick } = await load('settle-' + Date.now());
  const tasks = () => [row({ id: 'a', status: 'done', updated: NOW - 5 * MIN }), row({ id: 'b', status: 'failed', updated: NOW - 6 * MIN })];
  const first = ctx({ fleet: { tasks: tasks() }, lastEventTs: NOW - MIN });
  await tick(first.deps);
  const drained = oneEvent(first, 'FLEET_DRAINED');
  assert.equal(drained.payload.tasks, 2);
  assert.equal(first.calls.notify.length, 1);
  // `drained` needs no quiet window by design, so an unguarded emit fires on EVERY tick: a
  // desktop toast and a digest trigger every 30 s for as long as the fleet exists.
  const again = ctx({
    fleet: { tasks: tasks() },
    lastEventTs: NOW - MIN,
    orchEvents: [ev('FLEET_DRAINED', null, NOW - 2 * MIN, { tasks: 2 })],
  });
  await tick(again.deps);
  assert.deepEqual(eventsOf(again, 'FLEET_DRAINED'), []);
  assert.deepEqual(again.calls.notify, []);
});

test('new work after an announcement makes the next settlement speak again', async () => {
  const { tick } = await load('settle2-' + Date.now());
  const c = ctx({
    // The announcement is stale the moment a row changes: this fleet drained, was announced,
    // then took on work that has since finished.
    fleet: { tasks: [row({ id: 'a', status: 'done', updated: NOW - 5 * MIN }), row({ id: 'b', status: 'done', updated: NOW - MIN })] },
    lastEventTs: NOW - MIN,
    orchEvents: [ev('FLEET_DRAINED', null, NOW - 3 * MIN, { tasks: 1 })],
  });
  await tick(c.deps);
  assert.equal(oneEvent(c, 'FLEET_DRAINED').payload.tasks, 2);
});

test('FLEET_SETTLED needs the quiet window; a blocked fleet inside it stays silent', async () => {
  const { tick } = await load('settle3-' + Date.now());
  const mk = (quietMin) => ctx({
    fleet: { tasks: [row({ id: 'a', status: 'done', updated: NOW - 40 * MIN }), row({ id: 'b', status: 'blocked', updated: NOW - 40 * MIN })] },
    lastEventTs: NOW - quietMin * MIN,
    alive: new Set(),
  });
  const early = mk(5);
  await tick(early.deps);
  assert.deepEqual(eventsOf(early, 'FLEET_SETTLED'), []);
  const late = mk(31);
  await tick(late.deps);
  // The 7-done-1-failed-2-need-you fleet will never drain on its own, and without this
  // verdict it sits silent forever.
  assert.equal(oneEvent(late, 'FLEET_SETTLED').payload.tasks, 2);
  assert.equal(late.calls.notify.length, 1);
});

test('an empty fleet has not drained, and nothing is announced at soma up', async () => {
  const { tick } = await load('settle4-' + Date.now());
  const c = ctx({ fleet: { tasks: [] }, lastEventTs: 0 });
  await tick(c.deps);
  assert.deepEqual(eventsOf(c, 'FLEET_DRAINED'), []);
  assert.deepEqual(eventsOf(c, 'FLEET_SETTLED'), []);
  assert.deepEqual(c.calls.notify, []);
});

// ════════════════════════ the dep set and the wiring ════════════════════════

test('a missing dep is refused by name, so no duty can be silently absent', async () => {
  const { tick } = await load('deps-' + Date.now());
  const complete = ctx().deps;
  // The failure this closes is the unwired spawner's, generalised: `realDeps()` handing the tick an
  // `undefined` spawner makes admission no-op in production while every test passes. A dep
  // set completed from the real wiring (`{...SPAWN_DEPS, ...deps}`) is worse than a refusal
  // here for the same reason `spawn.checkDeps` refuses one — a test that forgot `spawnLead`
  // would start a real detached claude.
  for (const name of Object.keys(complete)) {
    const partial = { ...complete };
    delete partial[name];
    await assert.rejects(() => tick(partial), (e) => {
      assert.match(e.message, new RegExp(`tick: these dependencies are missing or are not functions: .*\\b${name}\\b`));
      return true;
    }, `a tick missing ${name} must refuse`);
  }
  await assert.rejects(() => tick(undefined), /these dependencies are missing/);
  await assert.rejects(() => tick({ ...complete, queuePaused: true }), /queuePaused/);
});

test('REQUIRED_DEPS cannot be shortened at runtime, because a name dropped from it stops being checked', async () => {
  const mod = await load('frozen-' + Date.now());
  // Same reasoning as `tokens.KNOWN_USAGE_FIELDS`: this list IS the check, so one `.pop()`
  // anywhere in the process would silently stop a dep from ever being validated again — and the
  // duty behind it would no-op in production while every injected test still passed.
  assert.throws(() => mod.REQUIRED_DEPS.push('somethingElse'), TypeError);
  assert.throws(() => { mod.REQUIRED_DEPS[0] = 'x'; }, TypeError);
  assert.equal(mod.REQUIRED_DEPS.includes('queuePaused'), true);
  assert.equal(mod.REQUIRED_DEPS.includes('tripped'), true);
  // The 80% flag. Optional-chained, a tick would log the BUDGET and never write the one thing the
  // lead hears, and every injected test would still pass.
  assert.equal(mod.REQUIRED_DEPS.includes('warnBudget'), true);
  // The pane census's listing. A tick that optional-chained it would skip the census silently
  // and every dead shell in the fleet would stay invisible, exactly as before the census.
  assert.equal(mod.REQUIRED_DEPS.includes('paneStates'), true);
});

test('an unreadable event log suppresses announcements rather than repeating them forever', async () => {
  const { tick } = await load('blind-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'done', updated: NOW - 5 * MIN })] },
    lastEventTs: NOW - MIN,
    deps: { orchEvents: () => { throw new Error('EACCES reading the event stream'); } },
  });
  await tick(c.deps);
  // The safe direction, chosen deliberately: forgetting what has been said costs a toast
  // storm, a re-triggered digest and a re-announced deviation on every tick forever, while
  // over-remembering costs one log line. `readEvents` already tolerates a torn tail and an
  // absent file, so reaching this path means a broken state root — doctor's business.
  assert.deepEqual(eventsOf(c, 'FLEET_DRAINED'), []);
  assert.deepEqual(c.calls.notify, []);
});

test('a malformed checkpoint is named here rather than surfacing as a native TypeError', async () => {
  const { tick } = await load('badfleet-' + Date.now());
  for (const bad of [null, undefined, 'none', 42, {}, new Set()]) {
    const c = ctx();
    c.deps.readFleet = () => ({ tasks: bad, last_spawn_at: null });
    await assert.rejects(() => tick(c.deps), (e) => {
      assert.match(e.message, /tick: fleet\.tasks must be an array/);
      assert.doesNotMatch(e.message, /is not a function|Cannot read properties/);
      return true;
    });
  }
});

test('realDeps wires every dep the tick requires to a real function', async () => {
  const home = mkdtempSync(join(tmpdir(), 'soma-wd-'));
  process.env.SOMA_HOME = home;
  const mod = await load('real-' + Date.now());
  try {
    // The spawner import: the module-level `import { spawnLead } from './lib/spawn.mjs'` is
    // load-bearing rather than decorative, and this file cannot even be imported without it
    // — so the import is proved by the line above having succeeded. What is proved here is
    // the other half: every name the tick requires resolves to something callable, because
    // dropping one and leaving it injection-only makes that duty no-op in production while
    // every effect-injected test above still passes.
    const real = mod.realDeps();
    for (const name of mod.REQUIRED_DEPS) {
      assert.equal(typeof real[name], 'function', `realDeps must wire ${name}`);
    }
    assert.deepEqual(Object.keys(ctx().deps).sort(), [...mod.REQUIRED_DEPS].sort(),
      'the test harness and the real wiring cover the same dep set, or a fixture can hide a missing one');
    // The two that a stub would silently disarm: the pause has to reach `queue.mjs`'s file
    // and liveness has to be the pane predicate rather than a session-name probe.
    assert.equal(real.queuePaused(), false);
    const { setQueuePaused } = await import('../bin/lib/queue.mjs?wd-' + Date.now());
    setQueuePaused(true);
    assert.equal(real.queuePaused(), true, 'realDeps must read the same switch soma_queue writes');
    setQueuePaused(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the tick reads a fresh config every time, so an operator edit lands on the next tick', async () => {
  const { tick } = await load('cfg-' + Date.now());
  let reads = 0;
  const c = ctx({ fleet: { tasks: [row({ id: 'a', status: 'queued' })] } });
  const base = c.deps.loadConfig;
  c.deps.loadConfig = () => { reads += 1; return base(); };
  await tick(c.deps);
  await tick(c.deps);
  assert.equal(reads, 2, 'loadConfig is per tick: lowering max_leads mid-run is the documented way to dial a fleet down');
});

// ════════════════════════ backpressure: the record, and who obeys it ════════════════════════

test('the file freezes admission on its own: a spend-cap record holds the queue with no storm in sight', async () => {
  const { tick } = await load('bp-file-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'queued' })] },
    paneSignals: [],
    backpressure: { active: true, reason: 'org_level_disabled_until', since: NOW - MIN, until: null },
  });
  await tick(c.deps);
  // The seam: `admitNext(…, storm.frozen)` alone admits here. The other writer (the limits phase's
  // spend cap) freezes through the file and nothing else, so admission has to read the file.
  assert.deepEqual(c.calls.spawnLead, []);
  assert.equal(c.task().status, 'queued');
  // And the storm branch owns only its own reason: a foreign freeze is neither cleared nor relabelled.
  assert.equal(c.calls.clearBackpressure, 0);
  assert.deepEqual(c.calls.writeBackpressure, []);
  assert.deepEqual(c.backpressure(), { active: true, reason: 'org_level_disabled_until', since: NOW - MIN, until: null });
});

test('`until` is DESCRIPTIVE, never enforced: an active record whose until is in the PAST still freezes admission, and no clock lifts it', async () => {
  const { tick } = await load('bp-until-past-' + Date.now());
  // The contract, stated because the natural reading of the field is the wrong one: `until` is
  // what a record SAYS about when the freeze might end, and nothing anywhere expires a freeze by
  // it. A freeze is lifted by its own writer's branch (the storm branch clears `STORM_REASON`
  // when the storm ends) or by `soma thaw`, and by nothing else — so a spend-cap record with a
  // stale `until`, a hand-edited one, or one whose reset time the API guessed short must STILL
  // hold the queue. The alternative reads the whole fleet back into admission the moment a clock
  // passes, with no human having looked at the cap that closed it.
  const past = { active: true, reason: 'org_level_disabled_until', since: NOW - 2 * 60 * MIN, until: NOW - 60 * MIN };
  const c = ctx({ fleet: { tasks: [row({ id: 'a', status: 'queued' })] }, paneSignals: [], backpressure: past });
  await tick(c.deps);
  assert.deepEqual(c.calls.spawnLead, [], 'a past `until` is not an expiry: admission stays shut');
  // And nothing in the tick reacted to the lapsed clock: the record is byte-for-byte what it was,
  // neither cleared nor re-stamped, so `soma status` and the next tick read the same freeze.
  assert.deepEqual(c.backpressure(), past);
});

test('a cleared record admits again, and an inactive one is not re-cleared every tick', async () => {
  const { tick } = await load('bp-open-' + Date.now());
  const c = ctx({ fleet: { tasks: [row({ id: 'a', status: 'queued' })] }, backpressure: { active: false } });
  await tick(c.deps);
  assert.deepEqual(c.calls.spawnLead, ['a']);
  assert.equal(c.calls.clearBackpressure, 0, 'a clear is a lock and a rename; not every 30 s for nothing');
  assert.deepEqual(c.calls.writeBackpressure, []);
});

test('a corroborated storm writes the record with all four fields, and the event carries the same three plus its evidence', async () => {
  const { tick } = await load('bp-write-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'queued' })] },
    paneSignals: [{ lead: 'x', paneHit: true, transcriptHit: true }],
  });
  await tick(c.deps);
  assert.deepEqual(c.calls.writeBackpressure, [{ active: true, reason: 'storm', since: NOW, until: null }]);
  assert.deepEqual(c.backpressure(), { active: true, reason: 'storm', since: NOW, until: null });
  const event = oneEvent(c, 'BACKPRESSURE');
  // The contract's three fields — built through rotation-events' `backpressure()` — plus `evidence`,
  // the storm-only superset the contract table names (`+ evidence (storm only)`).
  assert.deepEqual(event.payload, { reason: 'storm', since: NOW, until: null, evidence: [{ lead: 'x' }] });
  assert.equal(event.lead, null, 'a fleet-level event: no lead');
  ranBefore(c.order, 'writeBackpressure', 'event:BACKPRESSURE');
  assert.deepEqual(c.calls.spawnLead, []);
});

test('a storm still frozen on the next tick keeps the since it started with — unless that since is in seconds', async () => {
  const { tick } = await load('bp-since-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'queued' })] },
    paneSignals: [{ lead: 'x', paneHit: true, transcriptHit: true }],
    backpressure: { active: true, reason: 'storm', since: NOW - 5 * MIN, until: null },
  });
  await tick(c.deps);
  // Re-written (a deleted record comes back) but not re-stamped: the repeated BACKPRESSURE events
  // are what record a freeze's duration, so they must agree with the file about when it began.
  assert.deepEqual(c.calls.writeBackpressure, [{ active: true, reason: 'storm', since: NOW - 5 * MIN, until: null }]);
  assert.equal(oneEvent(c, 'BACKPRESSURE').payload.since, NOW - 5 * MIN);
  // A hand-edited `since` in SECONDS (1440433800 is the fixture's resetsAt) is the units bug: carried,
  // it would be a record every reader renders as 1970 and a value the builder and the writer both
  // refuse — which would abort the tick. Re-stamped instead, and nothing is reported as an error.
  const seconds = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'queued' })] },
    paneSignals: [{ lead: 'x', paneHit: true, transcriptHit: true }],
    backpressure: { active: true, reason: 'storm', since: 1_440_433_800, until: null },
  });
  await tick(seconds.deps);
  assert.deepEqual(seconds.calls.writeBackpressure, [{ active: true, reason: 'storm', since: NOW, until: null }]);
  assert.deepEqual(eventsOf(seconds, 'WATCHDOG_ERROR'), [], 'refused nowhere: the guard is upstream of the writer');
});

test('a storm over a spend-cap freeze is announced but does not overwrite the record', async () => {
  const { tick } = await load('bp-foreign-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'queued' })] },
    paneSignals: [{ lead: 'x', paneHit: true, transcriptHit: true }],
    backpressure: { active: true, reason: 'org_level_disabled_until', since: NOW - MIN, until: null },
  });
  await tick(c.deps);
  assert.deepEqual(c.calls.writeBackpressure, [], 'the spend cap outranks a storm, and its since is not ours to move');
  assert.equal(oneEvent(c, 'BACKPRESSURE').payload.reason, 'storm');
  // The documented exception to "the events and the file agree about when the freeze began":
  // there is no storm record to carry here, so each re-emit stamps THIS TICK. Pinned rather than
  // left to the block's comment — carrying the foreign `since` would date a storm from a spend
  // cap's start, and account rotation (which makes this case reachable) must change it
  // deliberately if at all.
  assert.equal(oneEvent(c, 'BACKPRESSURE').payload.since, NOW, 'no record of ours to carry: the event dates the tick');
  assert.deepEqual(c.calls.spawnLead, []);
});

test('a storm that has ended clears its own record, silently, and admission resumes on the same tick', async () => {
  const { tick } = await load('bp-clear-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'queued' })] },
    paneSignals: [],
    backpressure: { active: true, reason: 'storm', since: NOW - 5 * MIN, until: null },
  });
  await tick(c.deps);
  assert.equal(c.calls.clearBackpressure, 1);
  assert.deepEqual(c.backpressure(), { active: false });
  assert.deepEqual(eventsOf(c, 'BACKPRESSURE'), [], 'a storm\'s end has no event; the silence is the record');
  assert.deepEqual(c.calls.spawnLead, ['a'], 'the clear lands before admission reads the file');
  ranBefore(c.order, 'clearBackpressure', 'spawnLead:a');
});

test('a corrupt record reads as not frozen and is reported once, against no lead', async () => {
  const { tick } = await load('bp-corrupt-' + Date.now());
  const torn = { active: false, unreadable: true, why: 'state/backpressure.json is not JSON' };
  const c = ctx({ fleet: { tasks: [row({ id: 'a', status: 'queued' })] }, backpressure: torn });
  await tick(c.deps);
  // Three states, and this is the third: not "frozen", not "open and fine" — open, AND said so.
  assert.deepEqual(c.calls.spawnLead, ['a'], 'the tolerant read: a file nobody can read must not freeze the fleet');
  const err = oneEvent(c, 'WATCHDOG_ERROR');
  assert.equal(err.lead, null);
  assert.deepEqual(err.payload, { where: 'backpressure_file', error: 'state/backpressure.json is not JSON' });
  assert.equal(c.calls.clearBackpressure, 0, 'not silently healed either: the bytes are the evidence');
  assert.deepEqual(c.calls.writeBackpressure, []);

  // Deduped off the durable log, like VERSION_GATE: the file does not heal by being read, and an
  // alarm every 30 s is one an operator mutes.
  const again = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'queued' })] },
    backpressure: torn,
    orchEvents: [ev('WATCHDOG_ERROR', null, NOW - MIN, { where: 'backpressure_file', error: 'state/backpressure.json is not JSON' })],
  });
  await tick(again.deps);
  assert.deepEqual(eventsOf(again, 'WATCHDOG_ERROR'), []);
  // A WATCHDOG_ERROR from some OTHER `where` is not this report and must not silence it.
  const other = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'queued' })] },
    backpressure: torn,
    orchEvents: [ev('WATCHDOG_ERROR', null, NOW - MIN, { where: 'backpressure', error: 'fleet.lock is still held by pid 7' })],
  });
  await tick(other.deps);
  assert.equal(eventsOf(other, 'WATCHDOG_ERROR').length, 1);
});

test('a storm over an unreadable record is announced and freezes this tick, but never overwrites the bytes', async () => {
  const { tick } = await load('bp-torn-storm-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'queued' })] },
    paneSignals: [{ lead: 'x', paneHit: true, transcriptHit: true }],
    backpressure: { active: false, unreadable: true, why: 'state/backpressure.json is not JSON' },
  });
  await tick(c.deps);
  assert.equal(oneEvent(c, 'BACKPRESSURE').payload.reason, 'storm');
  // The tolerant read says `active: false`, which is NOT a licence to write over it: a record that
  // will not parse is an outside edit, and what it said is doctor's and the operator's to read.
  assert.deepEqual(c.calls.writeBackpressure, [], 'the bytes are the evidence');
  assert.equal(oneEvent(c, 'WATCHDOG_ERROR').payload.where, 'backpressure_file');
  assert.deepEqual(c.calls.spawnLead, [], 'the in-memory verdict still freezes this tick');
});

test('a writer that cannot take the lock is reported, and the storm still freezes this tick', async () => {
  const { tick } = await load('bp-lockfail-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'queued' })] },
    paneSignals: [{ lead: 'x', paneHit: true, transcriptHit: true }],
    deps: { writeBackpressure: () => { throw new Error('fleet.lock: /s/state/fleet.lock is still held by pid 7 — gave up after 5000ms'); } },
  });
  await tick(c.deps);
  const err = oneEvent(c, 'WATCHDOG_ERROR');
  assert.equal(err.payload.where, 'backpressure');
  assert.match(err.payload.error, /fleet\.lock/);
  // Belt and braces, in the safe direction: the in-memory verdict is OR-ed into admission's answer,
  // so a freeze whose write failed is still a freeze — and the write failing is what is reported.
  assert.deepEqual(c.calls.spawnLead, []);
  assert.equal(eventsOf(c, 'BACKPRESSURE').length, 1, 'the event is the durable log of the freeze; the file is the status view');
});

test('the BACKPRESSURE payload is built by rotation-events\' builder, not hand-spelled at the call site', async () => {
  // Two source pins and a behavioural one, because the defect is a CALL THAT MUST NOT BE INLINED:
  // replacing `backpressure({…})` + `say(event.type, …)` with a hand-spelled
  // `say('BACKPRESSURE', { reason: STORM_REASON, since, until: null, evidence })` leaves the whole
  // suite green (measured, 1250/1250) — the payload is identical either way, the import at the top
  // goes dead, and nothing in this repo lints it (`package.json` has one script, `node --test`).
  // The builder is the ONE place the BACKPRESSURE payload shape is spelled, and the row in
  // `prompts/orchestrator.md` is written against it: a second spelling here is exactly the
  // two-writers-one-shape defect the freeze record itself exists to prevent, one layer up.
  // Comments stripped first, as `soma-bus.smoke.test.mjs` strips them for the CLAUDE_SESSION_ID
  // pin: prose diagnosing this very defect is exactly what a later reader needs kept, and a pin
  // that reddens on the description is a pin that gets the description deleted.
  const code = WD_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /backpressure\(\{ reason: STORM_REASON/,
    'the storm branch must build its event through rotation-events\' backpressure() builder');
  assert.doesNotMatch(code, /say\('BACKPRESSURE'/,
    'the event TYPE must come from the builder (say(event.type, …)), never re-spelled at the call site');
  // The control: an absence proves nothing unless the same shape is shown to fire where a literal
  // really does live. `say('WATCHDOG_ERROR', …)` is spelled exactly that way in the same phase, so
  // a typo in the pattern above would show up here as a green absence over a decoy.
  assert.match(code, /say\('WATCHDOG_ERROR'/,
    'the hand-spelled-say pattern must fire where an event type really is hand-spelled');

  // And the builder is REACHED, not merely mentioned. It validates its three fields, so a clock in
  // SECONDS — the units bug, at the one input the record's `since` comes from when no record of
  // ours stands — aborts the tick instead of announcing a freeze every reader renders as 1970.
  // A hand-spelled `say` announces it happily, which is the behavioural half of the same pin.
  const { tick } = await load('bp-builder-' + Date.now());
  const c = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'queued' })] },
    paneSignals: [{ lead: 'x', paneHit: true, transcriptHit: true }],
    deps: { now: () => 1_440_433_800 },
  });
  await assert.rejects(tick(c.deps), /BACKPRESSURE: since must be an epoch-ms number/);
  assert.deepEqual(eventsOf(c, 'BACKPRESSURE'), [],
    'and nothing is appended with a payload the builder refuses: it is built before it is said');
});

test('a tick blind to its own orch stream does not re-alarm about an unreadable record', async () => {
  const { tick } = await load('bp-blind-' + Date.now());
  const torn = { active: false, unreadable: true, why: 'state/backpressure.json is not JSON' };
  // The control first, and it is what makes the silence below a measurement rather than a fixture
  // that could not have reported anything anyway: with a readable (empty) stream the report fires.
  const seen = ctx({ fleet: { tasks: [row({ id: 'a', status: 'queued' })] }, backpressure: torn });
  await tick(seen.deps);
  assert.equal(oneEvent(seen, 'WATCHDOG_ERROR').payload.where, 'backpressure_file');

  // Blind: `orchEvents` throws, so `orchHistory` cannot tell whether this was already reported and
  // answers "yes" to every dedupe question — `backpressureUnreadable: true` is that answer for this
  // one. The wrong value costs a WATCHDOG_ERROR every 30 s forever, which is the alarm the dedupe
  // exists to prevent; the state is still visible where an operator looks (`soma status`,
  // `soma_status` both render `unreadable`). Measured: flipping it to `false` left this file 95/95.
  const blind = ctx({
    fleet: { tasks: [row({ id: 'a', status: 'queued' })] },
    backpressure: torn,
    deps: { orchEvents: () => { throw new Error('EACCES: events/orch.jsonl'); } },
  });
  await tick(blind.deps);
  assert.deepEqual(eventsOf(blind, 'WATCHDOG_ERROR'), [],
    'a tick that cannot read its own log must not re-announce what it may already have said');
});

// ─────────────────────────── the limits phase ───────────────────────────

test('REQUIRED_DEPS names the eight limits deps, so a fixture cannot hide a missing one', async () => {
  const mod = await load('lim-deps-' + Date.now());
  for (const name of ['readTail', 'classifyLimit', 'readSeatState', 'pickSeat', 'closeSeat', 'reopenSeats', 'markSeatUnverified', 'seatLoggedIn']) {
    assert.equal(mod.REQUIRED_DEPS.includes(name), true, name);
  }
});

// Every fixture row comes from the limit-row fixture, synthetic rows shaped like real ones — classifier
// fields only, no prompt or response text. `quotaLimits.resetsAt` is epoch SECONDS there, exactly
// as Claude Code writes it.
const FX = JSON.parse(readFileSync(new URL('./fixtures/limit-rows.json', import.meta.url), 'utf8'));
/** Event A (s10.jsonl:218, build 2.1.241): the 2015-08-24 five_hour row whose whole cycle the fixture carries. */
const FIVE_HOUR_ROW = FX.rate_limit.five_hour[0];
/** Its `resetsAt` in the unit the verdict carries: 1440433800 s → 1_440_433_800_000 ms = 2015-08-24T16:30Z. */
const RESETS_AT_MS = FIVE_HOUR_ROW.quotaLimits.resetsAt * 1000;
/** Event A's resume (s10.jsonl:225): an ordinary `claude-opus-5` row — the classifier's `none`. */
const HEALTHY_ROW = FX.healthy[0];
/** Event C (s01.jsonl:5141, build 2.1.220): an org monthly-cap row — no `quotaLimits` at all, so the real classifier reads it `unobservable`. */
const ORG_CAP_ROW = FX.rate_limit.absent[1];
/** `limit-state.test.mjs`'s `withQuota` idiom: a fixture row with its quotaLimits replaced — the ONLY way a shape the fixture lacks enters this file. */
const withQuota = (r, quotaLimits) => ({ ...r, quotaLimits });
/** The org cap as a 2.1.238+ build writes it — no window reset, the reason in overageDisabledReason: the real classifier's `spend_cap`. */
const SPEND_CAP_ROW = withQuota(FIVE_HOUR_ROW, { status: 'rejected', overageDisabledReason: 'org_level_disabled_until' });
/** A seat's own cap with no window reset: the real classifier's `seat_cap`, closing until the 1st after the row's own timestamp. */
const SEAT_CAP_ROW = withQuota(FIVE_HOUR_ROW, { status: 'rejected', overageDisabledReason: 'org_spend_cap_reached' });
/** 2015-09-01T00:00Z — `nextMonthStartMs(Date.parse(FIVE_HOUR_ROW.timestamp))`, the literal `limit-state.test.mjs` pins. */
const SEAT_CAP_RESETS_AT_MS = 1_441_065_600_000;
/** A row re-stamped onto the tick's clock, for the stale-row guard (the fixture's own stamps are three years after `NOW`). */
const stamped = (r, ms) => ({ ...r, timestamp: new Date(ms).toISOString() });
/** A `readTail` fixture: these rows, oldest first, from a transcript that exists, nothing torn. */
const tail = (...rows) => () => ({ rows, bad_lines: 0, transcript: '/t/u.jsonl', uuid: 'u' });

const SEATS = [{ config_dir: '/s/a', label: 'seat-a' }, { config_dir: '/s/b', label: 'seat-b' }];
/** The same two seats as an operator writes them — the shell never expands `~` inside JSON — and as `loadSeats` (the one expander) resolves them. */
const HOME_SEATS = [{ config_dir: '~/seat-a', label: 'seat-a' }, { config_dir: '~/seat-b', label: 'seat-b' }];
const RESOLVED = [{ config_dir: join(homedir(), 'seat-a'), label: 'seat-a' }, { config_dir: join(homedir(), 'seat-b'), label: 'seat-b' }];

/**
 * An in-memory seat pool with the contract's shapes, spread into `ctx()` as `...pool.over`:
 * `pickSeat` is the FIRST open seat in the order THIS array was seeded in; `closeSeat` floors at
 * five minutes and never shortens; `reopenSeats` returns what it reopened; `markSeatUnverified`
 * takes a seat out of `pickSeat`. `loggedIn(dir)` answers `seatLoggedIn`; `unreadable` is a pool
 * whose file cannot be read.
 *
 * Seeded order is the real `pick`'s order only BECAUSE every fixture here seeds the pool in
 * `soma.json` order. It is not the same rule. `pick` iterates `loadSeats(cfg)` and looks each seat
 * up in `state/seats.json` by `config_dir`, so the CONFIG decides and a state row the config does
 * not name can never be returned; this double iterates its own rows and does not consult `cfg` at
 * all — it cannot, because two fixtures ("the row's seat is resolved through loadSeats…" and
 * "rotate resumes onto the RESOLVED dir of a ~-prefixed target") deliberately hand a `~`-spelled
 * cfg to a pool seeded with the RESOLVED dirs, and re-implementing `resolveConfigDir` in test code
 * is the duplication that module exists to prevent.
 *
 * MEASURED rather than asserted, with the double instrumented to compare the two orders on every
 * call: 52 `pickSeat` calls across this file, and the pool's row order agrees with the cfg's on
 * all 52 (the two `~` fixtures are the only ones where the dirs are not even the same strings).
 * So a fixture seeded OUT of config order would make the double and the product disagree with
 * nothing red. The ordering itself is pinned in `test/seats.test.mjs`, never here; what this file
 * pins is the phase's behaviour GIVEN a seat, and a double that still claimed the LRU contract is
 * how the next watchdog test gets written against semantics the product no longer has.
 */
const seatPool = (seats, { loggedIn = () => true, unreadable = false } = {}) => {
  const state = { seats: seats.map((s) => ({ closed_until: 0, closed_reason: null, unverified: false, ...s })) };
  const at = (dir) => state.seats.find((s) => s.config_dir === dir);
  const snapshot = () => (unreadable ? { seats: [], unreadable: true } : structuredClone(state));
  const over = {
    readSeatState: snapshot,
    pickSeat: (now) => {
      if (unreadable) return null;
      const open = state.seats.find((s) => s.closed_until <= now && !s.unverified);
      return open ? structuredClone(open) : null;
    },
    closeSeat: (dir, untilMs, why, now) => {
      const s = at(dir);
      const effective = Math.max(untilMs, now + 5 * MIN);
      if (s && effective > s.closed_until) { s.closed_until = effective; s.closed_reason = why; }
      return snapshot();
    },
    reopenSeats: (now) => {
      const out = [];
      for (const s of state.seats) {
        if (s.closed_until !== 0 && s.closed_until <= now) { s.closed_until = 0; s.closed_reason = null; out.push(structuredClone(s)); }
      }
      return out;
    },
    markSeatUnverified: (dir, flag) => { const s = at(dir); if (s) s.unverified = flag; return snapshot(); },
    seatLoggedIn: (dir) => loggedIn(dir),
  };
  return { state, over };
};

/**
 * One limit-hit lead `a` on `seat-a`, alive, its pane the idle composer a limit hit leaves
 * (measured: the pane returns to the ordinary `❯` composer, so the census reads `alive`), its
 * tail `rows`, and a seat pool. `over` layers on top — a `fleet` there replaces the row, a
 * `backpressure` there seeds the in-memory freeze record.
 */
const limited = (rows, seatsCfg, pool, over = {}) => ctx({
  cfg: cfgOf({ seats: seatsCfg }),
  fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', seat: 'seat-a' })] },
  alive: new Set(['lead-a']),
  capturePane: () => IDLE_FRAME,
  readTail: tail(...rows),
  ...pool.over,
  ...over,
});

test('the limits phase runs AFTER the census and BEFORE admission: a seat that closes mid-tick is not admitted onto', async () => {
  const { tick } = await load('lim-order-' + Date.now());
  const mk = (rows) => limited(rows, [SEATS[0]], seatPool([SEATS[0]]), {         // ONE seat: closing it leaves none
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', seat: 'seat-a' }), row({ id: 'b', status: 'queued' })] },
  });
  const c = mk([FIVE_HOUR_ROW]);
  await tick(c.deps);
  assert.deepEqual(c.calls.closeSeat, [['/s/a', RESETS_AT_MS, 'five_hour', NOW]], 'the verdict closes the seat, in MILLISECONDS');
  assert.deepEqual(c.calls.spawnLead, [], 'the freed slot is not refilled onto the seat that just closed');
  assert.equal(c.task('b').status, 'queued');
  assert.deepEqual(c.calls.killSession, [], 'and with no other seat nothing is killed');
  ranBefore(c.order, 'closeSeat:/s/a', 'pickSeat');
  // The control: the same fixture with a healthy tail admits b onto the open seat — so the hold
  // above is the phase order, not a broken spawner.
  const open = mk([HEALTHY_ROW]);
  await tick(open.deps);
  assert.deepEqual(open.calls.spawnLead, ['b']);
  assert.deepEqual(open.calls.spawnOpts, [{ configDir: '/s/a' }], 'admission launches onto the picked seat');
  assert.equal(open.task('b').seat, 'seat-a', 'and records it on the row, through the store');
});

test('only spawned rows are classified: a blocked, done or failed row with a limit in its tail is left alone; a spawned one is read', async () => {
  const { tick } = await load('lim-spawned-' + Date.now());
  for (const status of ['blocked', 'done', 'failed']) {
    const c = limited([FIVE_HOUR_ROW], SEATS, seatPool(SEATS), {
      fleet: { tasks: [row({ id: 'a', status, lead_session_uuid: 'u', seat: 'seat-a', updated: NOW - MIN })] },
    });
    await tick(c.deps);
    assert.deepEqual(c.calls.readTail, [], status);
    assert.deepEqual(c.calls.closeSeat, [], status);
    assert.deepEqual(c.calls.killSession, [], status);
  }
  // The control, so the three above are not vacuous: the same row `spawned` is read and its seat closed.
  const spawned = limited([FIVE_HOUR_ROW], SEATS, seatPool(SEATS));
  await tick(spawned.deps);
  assert.deepEqual(spawned.calls.readTail, ['u']);
  assert.equal(spawned.calls.closeSeat.length, 1);
});

test('unobservable and none touch nothing: no pool call, no write, no kill, no event', async () => {
  const { tick } = await load('lim-nothing-' + Date.now());
  const NEW_TYPES = ['SEAT_CLOSED', 'SEAT_REOPENED', 'ROTATED', 'ROTATION_FAILED', 'ROTATION_UNAVAILABLE', 'BACKPRESSURE', 'WATCHDOG_ERROR'];
  // Three real readings: an empty tail (a lead that has not written a row), a 2.1.220 rate_limit
  // row with no quotaLimits (the classifier: unobservable, not a guessed window), and a hit followed by a
  // healthy row (none: the lead already resumed). None of them is torn, so none is an alarm.
  for (const [name, rows] of [['unobservable (an empty tail)', []], ['unobservable (a 2.1.220 row with no quotaLimits)', [ORG_CAP_ROW]], ['none', [FIVE_HOUR_ROW, HEALTHY_ROW]]]) {
    const c = limited(rows, SEATS, seatPool(SEATS));
    await tick(c.deps);
    assert.deepEqual(c.calls.readTail, ['u'], `${name}: the tail IS read`);
    assert.equal(c.calls.classifyLimit.length, 1, `${name}: and classified`);
    assert.deepEqual(c.calls.closeSeat, [], name);
    assert.deepEqual(c.calls.markSeatUnverified, [], name);
    assert.deepEqual(c.calls.writeBackpressure, [], name);
    assert.deepEqual(c.calls.killSession, [], name);
    assert.deepEqual(c.calls.resumeLead, [], name);
    assert.equal(c.calls.pickSeat, 0, `${name}: the pool is not even asked`);
    assert.deepEqual(c.calls.appendEvent.filter((e) => NEW_TYPES.includes(e.type)), [], name);
    assert.equal(c.task().seat, 'seat-a', `${name}: the row is as it was`);
    assert.deepEqual(c.task().rotations, [], name);
  }
});

test('the verdict comes from classifyLimit over readTail\'s rows: a classifier reading the same row as none closes nothing', async () => {
  const { tick } = await load('lim-seam-' + Date.now());
  const c = limited([FIVE_HOUR_ROW], SEATS, seatPool(SEATS), { classifyLimit: () => ({ kind: 'none' }) });
  await tick(c.deps);
  assert.deepEqual(c.calls.readTail, ['u']);
  assert.deepEqual(c.calls.classifyLimit, [[FIVE_HOUR_ROW]], 'the rows readTail returned, handed over whole');
  assert.deepEqual(c.calls.killSession, []);
  assert.deepEqual(c.calls.closeSeat, []);
});

test('the row\'s seat is resolved through loadSeats: a ~-prefixed config_dir closes the RESOLVED dir, which is what state/seats.json is keyed by', async () => {
  const { tick } = await load('lim-tilde-' + Date.now());
  // A phase reading `cfg.seats` directly would hand the pool `~/seat-a`, which matches no row, and
  // every closure would silently land nowhere. (The rotation half — the target is what `pick()`
  // returned, already resolved — belongs to `rotate()`'s own tests.)
  const c = limited([FIVE_HOUR_ROW], HOME_SEATS, seatPool(RESOLVED));
  await tick(c.deps);
  assert.deepEqual(c.calls.closeSeat.map((x) => x[0]), [join(homedir(), 'seat-a')], 'the raw ~/seat-a never reaches the pool');
});

test('seat_window: close the seat, kill, and resume under the picked seat — attempts untouched', async () => {
  const { tick } = await load('lim-rotate-' + Date.now());
  const pool = seatPool(SEATS);
  const c = limited([HEALTHY_ROW, FIVE_HOUR_ROW], SEATS, pool, {              // the LAST assistant row decides
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', seat: 'seat-a', attempts: 2 })] },
  });
  await tick(c.deps);
  assert.deepEqual(c.calls.closeSeat, [['/s/a', RESETS_AT_MS, 'five_hour', NOW]]);
  assert.deepEqual(c.calls.killSession, ['lead-a']);
  assert.deepEqual(c.calls.resumeLead, ['a']);
  assert.deepEqual(c.calls.resumeOpts, [{ configDir: '/s/b' }], 'resumed under the OTHER seat\'s config dir');
  assert.deepEqual(c.calls.spawnLead, [], 'a rotation is a resume, never a fresh session');
  // `attempts` is revival's counter and a rotation is not a revival: 2 before, 2 after — not 3,
  // and not reset to 0.
  assert.equal(c.task().attempts, 2);
  ranBefore(c.order, 'closeSeat:/s/a', 'killSession:lead-a');
  ranBefore(c.order, 'killSession:lead-a', 'resumeLead:a');
  ranBefore(c.order, 'event:SEAT_CLOSED', 'event:ROTATED');
  const closed = oneEvent(c, 'SEAT_CLOSED');
  assert.deepEqual(closed.payload, { seat: 'seat-a', reason: 'five_hour', resetsAt: RESETS_AT_MS });
  assert.equal(closed.lead, null, 'SEAT_CLOSED is the seat\'s, not a lead\'s: top-level lead null (the builder\'s contract)');
  const rotatedEvent = oneEvent(c, 'ROTATED');
  assert.equal(rotatedEvent.lead, 'a', 'the top-level lead field: foldEvents reads event.lead');
  assert.deepEqual(rotatedEvent.payload, { lead: 'a', from: 'seat-a', to: 'seat-b', rateLimitType: 'five_hour', resetsAt: RESETS_AT_MS });
  assert.equal(pool.state.seats[0].closed_until, RESETS_AT_MS, 'the pool holds the closure');
});

test('rotation never routes through revive(): no attempt charged, no LEAD_DEAD, no REVIVED, and revive\'s first read is never made', async () => {
  const { tick } = await load('lim-norevive-' + Date.now());
  const c = limited([FIVE_HOUR_ROW], SEATS, seatPool(SEATS), {
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', seat: 'seat-a', attempts: 1 })] },
    // `revive()` reads `readUsage(uuid)` before anything else. A rotation routed through it trips
    // this and lands as a WATCHDOG_ERROR instead of a ROTATED.
    readUsage: () => { throw new Error('rotate() must not route through revive()'); },
  });
  await tick(c.deps);
  assert.deepEqual(eventsOf(c, 'WATCHDOG_ERROR'), []);
  assert.deepEqual(eventsOf(c, 'LEAD_DEAD'), []);
  assert.deepEqual(eventsOf(c, 'REVIVED'), []);
  assert.deepEqual(c.calls.readUsage, [], 'revive\'s read was never made');
  assert.deepEqual(c.calls.resumeLead, ['a']);
  assert.equal(c.task().attempts, 1);
  assert.equal(oneEvent(c, 'ROTATED').payload.to, 'seat-b');
});

test('row.seat and row.rotations are written through the store, and rotations are pruned to the last hour', async () => {
  const { tick } = await load('lim-row-' + Date.now());
  const c = limited([FIVE_HOUR_ROW], SEATS, seatPool(SEATS), {
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', seat: 'seat-a', rotations: [NOW - 61 * MIN, NOW - 30 * MIN] })] },
  });
  await tick(c.deps);
  assert.equal(c.task().seat, 'seat-b');
  assert.deepEqual(c.task().rotations, [NOW - 30 * MIN, NOW], 'the 61-minute-old one is gone (fleet.rotationsWithin); this one is appended');
  assert.equal(c.task().lead_session_uuid, 'u', 'a resume keeps the uuid');
  assert.equal(c.task().tmux_session, 'lead-a');
});

test('a limit-hit row with no seat (spawned before seats existed) closes nothing, rotates onto an open seat and gains one', async () => {
  const { tick } = await load('lim-legacy-' + Date.now());
  const c = limited([FIVE_HOUR_ROW], SEATS, seatPool(SEATS), { fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u' })] } });
  await tick(c.deps);
  assert.deepEqual(c.calls.closeSeat, []);
  assert.deepEqual(eventsOf(c, 'SEAT_CLOSED'), []);
  assert.deepEqual(c.calls.resumeOpts, [{ configDir: '/s/a' }]);
  assert.equal(oneEvent(c, 'ROTATED').payload.from, null);
  assert.equal(c.task().seat, 'seat-a');
});

test('seat_cap closes the seat as seat_cap until the 1st after the row\'s own timestamp and rotates like a window — through the REAL classifier', async () => {
  const { tick } = await load('lim-cap-' + Date.now());
  const c = limited([SEAT_CAP_ROW], SEATS, seatPool(SEATS));
  await tick(c.deps);
  // 2015-09-01T00:00Z: the boundary after the row's own 2015-08-24 stamp, not after the tick's 2012 clock.
  assert.deepEqual(c.calls.closeSeat, [['/s/a', SEAT_CAP_RESETS_AT_MS, 'seat_cap', NOW]]);
  assert.deepEqual(oneEvent(c, 'SEAT_CLOSED').payload, { seat: 'seat-a', reason: 'seat_cap', resetsAt: SEAT_CAP_RESETS_AT_MS });
  assert.deepEqual(c.calls.resumeOpts, [{ configDir: '/s/b' }]);
  assert.equal(oneEvent(c, 'ROTATED').payload.rateLimitType, 'org_spend_cap_reached');
});

test('rotate kills only a pane the census read as alive: a dialog, an unrecognised frame or no census keeps the session', async () => {
  const { tick } = await load('lim-pane-' + Date.now());
  const cases = [
    ['blocked_on_prompt', { panes: new Map([['lead-a', livePane()]]), capturePane: () => PROMPT_FRAME }],
    ['unrecognised', { panes: new Map([['lead-a', livePane()]]), capturePane: () => 'nothing the classifier knows' }],
    ['no census', { alive: null }],
  ];
  for (const [name, over] of cases) {
    const c = limited([FIVE_HOUR_ROW], SEATS, seatPool(SEATS), over);
    await tick(c.deps);
    assert.deepEqual(c.calls.killSession, [], name);
    assert.deepEqual(c.calls.resumeLead, [], name);
    assert.equal(c.calls.closeSeat.length, 1, `${name}: the seat still closes`);
    assert.deepEqual(eventsOf(c, 'ROTATION_UNAVAILABLE'), [], `${name}: not a refusal to announce — the pane is another mechanism's, or a hiccup's`);
  }
  // The control: the idle composer the measured limit hit leaves reads `alive`, and IS rotated.
  const alive = limited([FIVE_HOUR_ROW], SEATS, seatPool(SEATS));
  await tick(alive.deps);
  assert.deepEqual(alive.calls.killSession, ['lead-a']);
});

test('a rotation is the tick\'s one launch: admission stands down', async () => {
  const { tick } = await load('lim-one-' + Date.now());
  const c = limited([FIVE_HOUR_ROW], SEATS, seatPool(SEATS), {
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', seat: 'seat-a' }), row({ id: 'b', status: 'queued' })] },
  });
  await tick(c.deps);
  assert.deepEqual(c.calls.resumeLead, ['a']);
  assert.deepEqual(c.calls.spawnLead, [], 'b waits for the next tick, as it does behind a revival');
  assert.equal(c.task('b').status, 'queued');
});

test('an unreadable seat pool is named ONCE and never announces a closure it does not hold, however many ticks read the same row', async () => {
  const { tick } = await load('lim-unreadable-' + Date.now());
  const pool = seatPool(SEATS, { unreadable: true });                         // ONE pool across the ticks, as on disk
  const mk = (orchEvents) => limited([FIVE_HOUR_ROW], SEATS, pool, { orchEvents });
  const c = mk([]);
  await tick(c.deps);
  assert.deepEqual(c.calls.killSession, []);
  assert.deepEqual(c.calls.resumeLead, []);
  const said = oneEvent(c, 'ROTATION_UNAVAILABLE');
  assert.deepEqual(said.payload, { lead: 'a', why: 'seats_unreadable' });
  assert.equal(said.lead, 'a');
  assert.equal(c.calls.closeSeat.length, 1, 'the closure is still handed to the pool — it decides what an unreadable file lets it write');
  // THE DEFECT THIS PINS, and why this test now runs THREE ticks where it ran one. `seatIn`
  // answers null both for "the pool says this seat is open" and for "the pool could not be read",
  // so `closedBefore` was null on every tick and the once-per-real-change rule never engaged:
  // MEASURED against the real seats.mjs with a corrupt state/seats.json, tick 1
  // [SEAT_CLOSED, ROTATION_UNAVAILABLE/seats_unreadable], tick 2 [SEAT_CLOSED], tick 3 [SEAT_CLOSED,
  // ROTATION_UNAVAILABLE] — every 30 s, indefinitely. Each re-fired SEAT_CLOSED also advances
  // `history.seatClosedAt`, which re-arms `saidUnavailable`, so the refusal repeated with it. The
  // pool wrote nothing on any of those ticks (`mutateSeats` hands an unreadable file back
  // unchanged), so the event announced a closure that does not exist.
  assert.deepEqual(eventsOf(c, 'SEAT_CLOSED'), [], 'a closure the pool could not record is not announced');
  let log = c.calls.appendEvent.map((e) => ev(e.type, e.lead, NOW, e.payload));
  for (const tickNo of [2, 3]) {
    const again = mk(log);
    await tick(again.deps);
    assert.deepEqual(eventsOf(again, 'SEAT_CLOSED'), [], `tick ${tickNo}: still nothing to announce`);
    assert.deepEqual(eventsOf(again, 'ROTATION_UNAVAILABLE'), [], `tick ${tickNo}: the refusal is said once per closure, not once per tick`);
    log = [...log, ...again.calls.appendEvent.map((e) => ev(e.type, e.lead, NOW, e.payload))];
  }
  // The control: the same fixture with a READABLE pool does announce the closure, so the silence
  // above is the unreadable state and not a broken closer.
  const readable = limited([FIVE_HOUR_ROW], SEATS, seatPool(SEATS));
  await tick(readable.deps);
  assert.equal(oneEvent(readable, 'SEAT_CLOSED').payload.seat, 'seat-a');
});

test('the ONCE is once per LAUNCH: a revived lead is told again, and a lead nobody restarts is not', async () => {
  const { tick } = await load('lim-unreadable-revive-' + Date.now());
  // `saidUnavailable` keys the refusal on max(seatClosedAt[seat], launch[id].at), and `launch`
  // advances on SPAWNED, REVIVED, ROTATED and ROTATION_FAILED alike (the fold at :375-389). So
  // "exactly ONCE per lead and then goes quiet for ever" — the sentence the RUNBOOK and doctor's
  // `seat pool state readable` both carried — was true only of a fleet nobody restarts.
  // Measured as an A/B on ONE fixture: same refusal in the log, same unreadable pool, and
  // only the REVIVED's stamp moves. An unreadable pool emits no SEAT_CLOSED (the test above), so
  // the launch is the whole closure key here and nothing else can be doing the work. The two arms
  // guard each other: a fixture that stopped producing a limit verdict at all would make the
  // silent arm pass for the wrong reason, and the arm below — same fixture, one stamp later —
  // is what refuses that reading.
  const said = ev('ROTATION_UNAVAILABLE', 'a', NOW - 2000, { lead: 'a', why: 'seats_unreadable' });
  const run = async (revivedAt) => {
    const c = limited([FIVE_HOUR_ROW], SEATS, seatPool(SEATS, { unreadable: true }),
      { orchEvents: [said, ev('REVIVED', 'a', revivedAt, {})] });
    await tick(c.deps);
    return eventsOf(c, 'ROTATION_UNAVAILABLE');
  };
  assert.deepEqual(await run(NOW - 3000), [],
    'a revival OLDER than the refusal is still the same launch — saying it again would be once per tick');
  const again = await run(NOW - 1000);
  assert.equal(again.length, 1,
    'a lead REVIVED after the refusal is a NEW launch, and the refusal is said again — "never again" is only true of a fleet nobody restarts');
  assert.deepEqual(again[0].payload, { lead: 'a', why: 'seats_unreadable' },
    'the repeat must be the same refusal, not some other event of the same type');
});

test('a verdict whose resetsAt is not a number is refused by name against THAT lead; the other lead still rotates', async () => {
  const { tick } = await load('lim-badreset-' + Date.now());
  const c = limited([FIVE_HOUR_ROW], SEATS, seatPool(SEATS), {
    fleet: { tasks: [
      row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', seat: 'seat-a' }),
      row({ id: 'c', status: 'spawned', lead_session_uuid: 'w', seat: 'seat-a' }),
    ] },
    alive: new Set(['lead-a', 'lead-c']),
    readTail: (uuid) => ({ rows: [{ ...FIVE_HOUR_ROW, bad: uuid === 'u' }], bad_lines: 0, transcript: '/t/x.jsonl', uuid }),
    classifyLimit: (rows) => (rows[0].bad ? { kind: 'seat_window', rateLimitType: 'five_hour', resetsAt: 'soon' } : realClassify(rows)),
  });
  await tick(c.deps);
  const err = oneEvent(c, 'WATCHDOG_ERROR');
  assert.equal(err.lead, 'a');
  assert.equal(err.payload.where, 'limits');
  assert.match(err.payload.error, /verdict\.resetsAt must be a non-negative finite number/);
  assert.deepEqual(c.calls.closeSeat.map((x) => x[0]), ['/s/a'], 'closed once, by c');
  assert.deepEqual(c.calls.killSession, ['lead-c']);
  assert.equal(c.task('a').seat, 'seat-a', 'a is left exactly where it was');
});

test('rotate resumes onto the RESOLVED dir of a ~-prefixed target: what pick() returned, never soma.json\'s raw spelling', async () => {
  const { tick } = await load('lim-tilde-rotate-' + Date.now());
  const c = limited([FIVE_HOUR_ROW], HOME_SEATS, seatPool(RESOLVED));
  await tick(c.deps);
  assert.deepEqual(c.calls.resumeOpts, [{ configDir: join(homedir(), 'seat-b') }], 'the spawner gets the dir the pool holds — loadSeats resolved it, the phase never re-spells it');
  assert.equal(c.task().seat, 'seat-b');
});

test('no open seat: nothing is killed, and ROTATION_UNAVAILABLE is said once per closure, not once per tick', async () => {
  const { tick } = await load('lim-once-' + Date.now());
  const pool = seatPool([SEATS[0]]);                                        // ONE pool across the ticks, as on disk
  const mk = (orchEvents) => limited([FIVE_HOUR_ROW], [SEATS[0]], pool, { orchEvents });
  const first = mk([]);
  await tick(first.deps);
  assert.deepEqual(first.calls.killSession, []);
  assert.deepEqual(first.calls.resumeLead, []);
  const said = oneEvent(first, 'ROTATION_UNAVAILABLE');
  assert.deepEqual(said.payload, { lead: 'a', why: 'no_open_seat' });
  assert.equal(said.lead, 'a');
  // Tick two reads the same rate_limit row (Claude Code appends nothing after it) and the log now
  // holds tick one's SEAT_CLOSED and ROTATION_UNAVAILABLE: silence.
  const logged = first.calls.appendEvent.map((e) => ev(e.type, e.lead, NOW, e.payload));
  const second = mk(logged);
  await tick(second.deps);
  assert.deepEqual(eventsOf(second, 'ROTATION_UNAVAILABLE'), []);
  assert.deepEqual(eventsOf(second, 'SEAT_CLOSED'), [], 'the closure is not re-announced either');
  assert.equal(second.calls.closeSeat.length, 1, 'though the pool is still told, idempotently');
  // A NEW closure — the seat reopened and closed again, later — re-arms it.
  const reclosed = mk([
    ...logged,
    ev('SEAT_REOPENED', null, NOW + 6 * 3600_000, { seat: 'seat-a' }),
    ev('SEAT_CLOSED', null, NOW + 7 * 3600_000, { seat: 'seat-a', reason: 'five_hour', resetsAt: RESETS_AT_MS }),
  ]);
  await tick(reclosed.deps);
  assert.equal(eventsOf(reclosed, 'ROTATION_UNAVAILABLE').length, 1);
});

test('ROTATED moves revivedAt: a question the pre-rotation session asked cannot flip the rotated lead to blocked', async () => {
  const { tick } = await load('lim-fold-' + Date.now());
  const rotatedAt = NOW - 140 * MIN;
  const mk = (askedAt) => ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', updated: NOW - 300 * MIN })] },
    alive: new Set(['lead-a']),
    leadEvents: { a: [ev('NEEDS_INPUT', 'a', askedAt)] },
    orchEvents: [ev('ROTATED', 'a', rotatedAt, { lead: 'a', from: 'seat-a', to: 'seat-b', rateLimitType: 'five_hour', resetsAt: RESETS_AT_MS })],
  });
  const before = mk(rotatedAt - MIN);
  await tick(before.deps);
  assert.equal(before.task().status, 'spawned', 'a question the PREVIOUS session asked is not this one\'s');
  const after = mk(rotatedAt + MIN);
  await tick(after.deps);
  assert.equal(after.task().status, 'blocked');
});

test('a rate_limit row older than the lead\'s newest launch is stale: the resumed process has not written yet, so nothing closes and nothing is killed', async () => {
  const { tick } = await load('lim-stale-' + Date.now());
  const rowAt = NOW - 10 * MIN;
  // `a` was rotated from seat-a onto seat-b; its tail's newest assistant row is the five_hour hit,
  // re-stamped onto the tick's clock so the ROTATED can be placed before or after it.
  const mk = (launchAt) => limited([stamped(FIVE_HOUR_ROW, rowAt)], SEATS, seatPool(SEATS), {
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', seat: 'seat-b', rotations: [launchAt] })] },
    orchEvents: [ev('ROTATED', 'a', launchAt, { lead: 'a', from: 'seat-a', to: 'seat-b', rateLimitType: 'five_hour', resetsAt: RESETS_AT_MS })],
  });
  // The ROTATED is NEWER than the row: the hit belongs to the process the rotation killed, and the
  // resumed one has not written yet. Acting would close seat-b with seat-a's resetsAt and rotate
  // a second time on a stale row — the thrash this guard exists to prevent.
  const stale = mk(rowAt + 5 * MIN);
  await tick(stale.deps);
  assert.deepEqual(stale.calls.closeSeat, [], 'seat-b is not the seat that refused this row');
  assert.deepEqual(stale.calls.killSession, []);
  assert.deepEqual(stale.calls.resumeLead, []);
  assert.deepEqual(eventsOf(stale, 'SEAT_CLOSED'), []);
  assert.deepEqual(eventsOf(stale, 'ROTATED'), []);
  assert.deepEqual(eventsOf(stale, 'ROTATION_UNAVAILABLE'), []);
  // The control: the same row NEWER than the ROTATED is the resumed process's own hit on seat-b,
  // and it is acted on — seat-b closes, and the lead rotates onto seat-a.
  const fresh = mk(rowAt - 5 * MIN);
  await tick(fresh.deps);
  assert.deepEqual(fresh.calls.closeSeat, [['/s/b', RESETS_AT_MS, 'five_hour', NOW]]);
  assert.deepEqual(fresh.calls.killSession, ['lead-a']);
  assert.deepEqual(fresh.calls.resumeOpts, [{ configDir: '/s/a' }]);
});

test('a target that is not logged in is marked unverified and skipped for the next open seat; null (unreadable) is skipped too', async () => {
  const { tick } = await load('lim-login-' + Date.now());
  const THREE = [...SEATS, { config_dir: '/s/c', label: 'seat-c' }];
  const mk = (answers) => limited([FIVE_HOUR_ROW], THREE, seatPool(THREE, { loggedIn: (dir) => answers[dir] }));
  const c = mk({ '/s/b': false, '/s/c': true });
  await tick(c.deps);
  assert.deepEqual(c.calls.markSeatUnverified, [['/s/b', true]], 'the seat that is not logged in is marked, before any kill');
  assert.deepEqual(c.calls.resumeOpts, [{ configDir: '/s/c' }]);
  assert.equal(oneEvent(c, 'ROTATED').payload.to, 'seat-c');
  ranBefore(c.order, 'markSeatUnverified:/s/b', 'killSession:lead-a');
  // `null` — the seat's .claude.json could not be read — is not `true`, and a kill on the strength
  // of an unreadable file is what §3.5 step 2 exists to prevent.
  const unreadable = mk({ '/s/b': null, '/s/c': true });
  await tick(unreadable.deps);
  assert.deepEqual(unreadable.calls.markSeatUnverified, [['/s/b', true]]);
  assert.deepEqual(unreadable.calls.resumeOpts, [{ configDir: '/s/c' }]);
  // Nobody logged in: no kill, and the lead is left to auto-continue.
  const nobody = mk({ '/s/b': false, '/s/c': false });
  await tick(nobody.deps);
  assert.deepEqual(nobody.calls.killSession, []);
  assert.deepEqual(nobody.calls.resumeLead, []);
  assert.deepEqual(nobody.calls.markSeatUnverified, [['/s/b', true], ['/s/c', true]]);
  assert.deepEqual(oneEvent(nobody, 'ROTATION_UNAVAILABLE').payload, { lead: 'a', why: 'no_open_seat' });
});

test('three rotations inside an hour is thrash: nothing is killed and ROTATION_UNAVAILABLE says so; with one aged out the lead rotates', async () => {
  const { tick } = await load('lim-thrash-' + Date.now());
  const mk = (rotations) => limited([FIVE_HOUR_ROW], SEATS, seatPool(SEATS), {
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', seat: 'seat-a', rotations })] },
  });
  const thrashing = mk([NOW - 50 * MIN, NOW - 30 * MIN, NOW - 10 * MIN]);
  await tick(thrashing.deps);
  assert.deepEqual(thrashing.calls.killSession, []);
  assert.deepEqual(thrashing.calls.resumeLead, []);
  assert.deepEqual(oneEvent(thrashing, 'ROTATION_UNAVAILABLE').payload, { lead: 'a', why: 'thrash' });
  assert.deepEqual(thrashing.task().rotations, [NOW - 50 * MIN, NOW - 30 * MIN, NOW - 10 * MIN], 'a refused rotation is not counted');
  assert.equal(thrashing.calls.closeSeat.length, 1, 'the seat still closes: the limit is real even when the remedy is refused');
  // The bound is a WINDOW (`fleet.ROTATION_WINDOW_MS`): the oldest of the three has aged out, so
  // this is the third in an hour, not a fourth.
  const aged = mk([NOW - 61 * MIN, NOW - 30 * MIN, NOW - 10 * MIN]);
  await tick(aged.deps);
  assert.deepEqual(aged.calls.killSession, ['lead-a']);
  assert.deepEqual(aged.task().rotations, [NOW - 30 * MIN, NOW - 10 * MIN, NOW]);
});

test('spend_cap through the REAL classifier: the freeze file gets all four fields, BACKPRESSURE fires once, nothing is killed or closed, and admission is shut this tick', async () => {
  const { tick } = await load('lim-freeze-' + Date.now());
  // `SPEND_CAP_ROW` is Event A with the quotaLimits a 2.1.238+ build writes for the org cap: no
  // window reset, `overageDisabledReason: org_level_disabled_until` (the withQuota idiom) — so
  // the tick→classifier→freeze chain runs on the real classifier, not a handed-over verdict.
  // `backpressure` seeds the in-memory record for tick two.
  const mk = (backpressure) => limited([SPEND_CAP_ROW], SEATS, seatPool(SEATS), {
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', seat: 'seat-a' }), row({ id: 'b', status: 'queued' })] },
    ...(backpressure === undefined ? {} : { backpressure }),
  });
  const c = mk();
  await tick(c.deps);
  assert.deepEqual(c.calls.writeBackpressure, [{ active: true, reason: 'org_level_disabled_until', since: NOW, until: null }]);
  assert.deepEqual(c.backpressure(), { active: true, reason: 'org_level_disabled_until', since: NOW, until: null }, 'the record as the real writer shapes it');
  const said = oneEvent(c, 'BACKPRESSURE');
  assert.deepEqual(said.payload, { reason: 'org_level_disabled_until', since: NOW, until: null });
  assert.equal(said.lead, null);
  assert.equal(c.calls.notify.length, 1, 'the one freeze no machine action lifts is toasted');
  assert.deepEqual(c.calls.killSession, []);
  assert.deepEqual(c.calls.resumeLead, []);
  assert.deepEqual(c.calls.closeSeat, [], 'the org cap is every seat\'s: nothing to rotate to, so no seat is closed');
  assert.deepEqual(c.calls.spawnLead, [], 'admission is frozen in the SAME tick — phase 5 reads the file this phase wrote');
  assert.equal(c.task('b').status, 'queued');
  // Tick two: the file already says frozen, so nothing is written or said again — its `since` is
  // the freeze's start and stays put — and admission stays shut off the FILE. And nothing inside
  // the tick clears a spend-cap record: `soma thaw` does.
  const again = mk(c.backpressure());
  await tick(again.deps);
  assert.deepEqual(again.calls.writeBackpressure, []);
  assert.deepEqual(eventsOf(again, 'BACKPRESSURE'), []);
  assert.deepEqual(again.calls.notify, []);
  assert.deepEqual(again.calls.spawnLead, []);
  assert.equal(again.calls.clearBackpressure, 0, 'a spend-cap record is nobody\'s to clear inside the tick — `soma thaw` is');
});

test('seats whose closure has expired are reopened after the closures, each announced once with soma.json\'s label', async () => {
  const { tick } = await load('lim-reopen-' + Date.now());
  // The state row's label is a courtesy copy and may be null (seats.mjs writes null for a dir soma.json
  // did not name at first close); the event's `seat` is resolved through the config.
  const pool = seatPool([{ ...SEATS[0], label: null, closed_until: NOW - MIN, closed_reason: 'five_hour' }, SEATS[1]]);
  const c = limited([HEALTHY_ROW], SEATS, pool);
  await tick(c.deps);
  const reopened = oneEvent(c, 'SEAT_REOPENED');
  assert.deepEqual(reopened.payload, { seat: 'seat-a' });
  assert.equal(reopened.lead, null);
  assert.equal(pool.state.seats[0].closed_until, 0);
  // Idempotent on the pool's side, so the next tick has nothing to say.
  const again = limited([HEALTHY_ROW], SEATS, pool);
  await tick(again.deps);
  assert.deepEqual(eventsOf(again, 'SEAT_REOPENED'), []);
  // A seat closed THIS tick is not reopened this tick: the pool's five-minute floor keeps a past
  // `resetsAt` (measured non-monotonic) from closing and reopening in one breath.
  const fresh = seatPool([SEATS[0]]);
  const past = limited([FIVE_HOUR_ROW], [SEATS[0]], fresh, { classifyLimit: () => ({ kind: 'seat_window', rateLimitType: 'five_hour', resetsAt: NOW - 1 }) });
  await tick(past.deps);
  assert.deepEqual(eventsOf(past, 'SEAT_REOPENED'), []);
  assert.equal(fresh.state.seats[0].closed_until, NOW + 5 * MIN);
  // A reopened dir soma.json no longer names falls back to its basename, so the event still says WHICH.
  const orphan = seatPool([{ config_dir: '/s/zombie', label: null, closed_until: NOW - MIN, closed_reason: 'five_hour' }, ...SEATS]);
  const z = limited([HEALTHY_ROW], SEATS, orphan);
  await tick(z.deps);
  assert.deepEqual(oneEvent(z, 'SEAT_REOPENED').payload, { seat: 'zombie' });
});

test('a torn tail is said once per lead per launch: WATCHDOG_ERROR where limits, nothing killed or closed, silent until the lead gets a new session', async () => {
  const { tick } = await load('lim-torn-' + Date.now());
  // What readTailRows hands over for a file whose last line would not parse: the rate_limit row,
  // then `null` in the torn line's place, `bad_lines: 1`.
  const torn = () => ({ rows: [FIVE_HOUR_ROW, null], bad_lines: 1, transcript: '/t/u.jsonl', uuid: 'u' });
  const spawnedAt = ev('SPAWNED', 'a', NOW - 60 * MIN, { session_uuid: 'u', tmux_target: 'lead-a', cwd: '/w/a' });
  const mk = (orchEvents) => limited([], SEATS, seatPool(SEATS), { readTail: torn, orchEvents });
  const first = mk([spawnedAt]);
  await tick(first.deps);
  // The REAL classifier: a non-object entry NEWER than the last assistant row hides the newest state,
  // so the rate_limit row before it is NOT acted on — the torn line may be the healthy row
  // that makes the answer none, and a kill on that guess lands mid-turn. Spec §5: nothing is killed,
  // the lead keeps running, one event says what could not be read.
  assert.deepEqual(first.calls.closeSeat, []);
  assert.deepEqual(first.calls.killSession, []);
  const err = oneEvent(first, 'WATCHDOG_ERROR');
  assert.equal(err.lead, 'a');
  assert.equal(err.payload.where, 'limits');
  assert.match(err.payload.error, /row 1 after the last assistant row is not an object/);
  // Tick two: the tail is still torn (a lead mid-write, or a damaged file) and the log holds the
  // report: silence — deduped like ROTATION_UNAVAILABLE, off the durable log.
  const second = mk([spawnedAt, ev('WATCHDOG_ERROR', 'a', NOW - 2 * MIN, { where: 'limits', error: 'said' })]);
  await tick(second.deps);
  assert.deepEqual(eventsOf(second, 'WATCHDOG_ERROR'), []);
  // A NEW session for the lead (a REVIVED after the report) re-arms it: this process's tail is a new fact.
  const relaunched = mk([spawnedAt, ev('WATCHDOG_ERROR', 'a', NOW - 2 * MIN, { where: 'limits', error: 'said' }), ev('REVIVED', 'a', NOW - MIN, { plan: 'resume', attempt: 1, session_uuid: 'u' })]);
  await tick(relaunched.deps);
  assert.equal(eventsOf(relaunched, 'WATCHDOG_ERROR').length, 1, 'a new session is a new fact about the tail');
  // An EMPTY tail is not a torn one: a lead that has not written a row yet says nothing.
  const empty = limited([], SEATS, seatPool(SEATS), { orchEvents: [spawnedAt] });
  await tick(empty.deps);
  assert.deepEqual(eventsOf(empty, 'WATCHDOG_ERROR'), []);
});

test('a revival launches onto an open seat and records it; with every seat closed it falls back to the row\'s own seat; with no seats configured the row reads null', async () => {
  const { tick } = await load('lim-revive-' + Date.now());
  const c = limited([], SEATS, seatPool(SEATS), {
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', seat: 'seat-a', attempts: 0 })] },
    alive: new Set(),                                                         // dead -> revival
  });
  await tick(c.deps);
  assert.deepEqual(c.calls.resumeLead, ['a']);
  assert.deepEqual(c.calls.resumeOpts, [{ configDir: '/s/a' }], 'the first open seat in config order');
  assert.equal(c.task().seat, 'seat-a');
  const closed = seatPool(SEATS.map((s) => ({ ...s, closed_until: NOW + 60 * MIN, closed_reason: 'five_hour' })));
  const held = limited([], SEATS, closed, {
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', seat: 'seat-b', attempts: 0 })] },
    alive: new Set(),
  });
  await tick(held.deps);
  assert.deepEqual(held.calls.resumeOpts, [{ configDir: '/s/b' }], 'its own seat, closed as it is: the process arms auto-continue there');
  assert.equal(held.task().seat, 'seat-b');
  // No seats configured: today's behaviour — an empty options object — and the row records the
  // TRUTH, `seat: null`, even when it still carried a label from a soma.json that has since lost it.
  const legacy = ctx({ fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', seat: 'seat-a', attempts: 0 })] }, alive: new Set() });
  await tick(legacy.deps);
  assert.deepEqual(legacy.calls.resumeOpts, [{}]);
  assert.equal(legacy.task().seat, null);
});

test('a seat closed this tick is closed to the revival that follows it in the same tick', async () => {
  const { tick } = await load('lim-order2-' + Date.now());
  // `dead` died on seat-b and `a` hit its limit on seat-a in the same tick. The limits phase runs
  // first, so seat-a is closed by the time revival picks — and the revival lands on seat-b, not
  // on the account that just refused a. Both are launches; neither is admission.
  const both = limited([FIVE_HOUR_ROW], SEATS, seatPool(SEATS), {
    fleet: { tasks: [
      row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', seat: 'seat-a' }),
      row({ id: 'dead', status: 'spawned', lead_session_uuid: 'v', seat: 'seat-b', attempts: 0 }),
    ] },
    readTail: (uuid) => (uuid === 'u' ? tail(FIVE_HOUR_ROW)() : tail()()),
  });
  await tick(both.deps);
  assert.deepEqual(both.calls.resumeLead, ['a', 'dead'], 'the rotation, then the revival');
  assert.deepEqual(both.calls.resumeOpts, [{ configDir: '/s/b' }, { configDir: '/s/b' }], 'the revival never picks the seat that closed this tick');
  assert.equal(both.task('dead').seat, 'seat-b');
  assert.equal(both.task('dead').attempts, 1, 'the revival charged its attempt');
  assert.equal(both.task('a').attempts, 0, 'the rotation did not');
});

test('a dead pane on a limit-hit lead is revival\'s, not rotate()\'s: one kill, one resume onto an open seat, attempts charged, the seat still closed', async () => {
  const { tick } = await load('lim-deadpane-' + Date.now());
  // The measured "not logged in" shape and an ordinary crash both end here: claude exited, tmux
  // keeps the pane (`dead_pane`), and the transcript's newest row is the limit hit. Two mechanisms
  // could claim the lead; this pins the hand-off rather than inferring it from the pane gate.
  const c = limited([FIVE_HOUR_ROW], SEATS, seatPool(SEATS), {
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', seat: 'seat-a', attempts: 0 })] },
    alive: new Set(),                                                         // no live pane: dead to reconcile
    panes: new Map([['lead-a', livePane({ dead: true })]]),                   // the census reads `dead_pane`
  });
  await tick(c.deps);
  assert.equal(c.calls.closeSeat.length, 1, 'the limit is real: the seat closes');
  assert.deepEqual(eventsOf(c, 'ROTATED'), [], 'rotate() refused a pane the census did not read as alive');
  assert.deepEqual(eventsOf(c, 'ROTATION_UNAVAILABLE'), [], 'and did not call it a refusal: the pane is revival\'s');
  assert.equal(oneEvent(c, 'LEAD_DEAD').payload.pane_state, 'dead_pane');
  assert.deepEqual(c.calls.killSession, ['lead-a'], 'ONE kill — revival\'s');
  assert.deepEqual(c.calls.resumeLead, ['a'], 'ONE resume — revival\'s');
  assert.deepEqual(c.calls.resumeOpts, [{ configDir: '/s/b' }], 'onto the seat still open, because the closure landed first');
  assert.equal(c.task().attempts, 1, 'revival charged its attempt; a rotation would not have');
  assert.equal(oneEvent(c, 'REVIVED').payload.plan, 'resume');
  ranBefore(c.order, 'closeSeat:/s/a', 'killSession:lead-a');
});

test('every rotation event this phase writes is built by rotation-events\' builders, never a literal at the call site', async () => {
  // Measured on the full suite: replacing `seatClosed({…})` with the hand-spelled
  // `{ type: 'SEAT_CLOSED', payload: {…}, lead: null }` it expands to leaves 1292/1292 GREEN — the
  // record is identical either way, the import goes dead, and nothing in this repo lints it
  // (`package.json` has one script, `node --test`). That is the defect already found on
  // BACKPRESSURE, four types wider, so it gets the same two pins: the source,
  // and a behaviour only the builder has. Comments are stripped first, as the BACKPRESSURE pin
  // strips them: prose diagnosing this very defect is what a later reader needs kept.
  const code = WD_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const [type, builder] of [['SEAT_CLOSED', 'seatClosed'], ['SEAT_REOPENED', 'seatReopened'], ['ROTATED', 'rotated'], ['ROTATION_UNAVAILABLE', 'rotationUnavailable']]) {
    assert.match(code, new RegExp(`\\b${builder}\\(\\{`), `${type} must be built by ${builder}()`);
    assert.doesNotMatch(code, new RegExp(`type: '${type}'`), `${type} must never be spelled at a call site`);
  }
  // The control: an absence proves nothing unless the same pattern is shown to fire where a
  // literal really does live. WATCHDOG_ERROR is the tick's own type and IS spelled exactly so.
  assert.match(code, /type: 'WATCHDOG_ERROR'/);

  // And the builder is REACHED, not merely mentioned: it refuses a `resetsAt` in SECONDS, which
  // `reqNum` passes happily (it asks only for a non-negative finite number). A hand-spelled
  // literal announces a closure every reader renders as 1970 and rotates on the same bad verdict.
  const { tick } = await load('lim-builder-' + Date.now());
  const c = limited([FIVE_HOUR_ROW], SEATS, seatPool(SEATS), {
    classifyLimit: () => ({ kind: 'seat_window', rateLimitType: 'five_hour', resetsAt: FIVE_HOUR_ROW.quotaLimits.resetsAt }),   // SECONDS
  });
  await tick(c.deps);
  assert.deepEqual(eventsOf(c, 'SEAT_CLOSED'), [], 'a seconds stamp is refused, not announced');
  assert.match(oneEvent(c, 'WATCHDOG_ERROR').payload.error, /SEAT_CLOSED: resetsAt must be an epoch-ms number/);
  assert.deepEqual(c.calls.killSession, [], 'and the refusal costs this lead its rotation rather than rotating on a bad verdict');
  // And it is refused BEFORE the pool is written. The event used to be built after `closeSeat`
  // returned, so a seconds stamp floored the seat to `now + 5 min` — a real closure, under the
  // fleet lock — and only then threw. Safe direction, but a write nobody asked for.
  assert.deepEqual(c.calls.closeSeat, [], 'nothing reaches the pool on a verdict the builder refuses');
});

test('realDeps wires the REAL tail reader and the REAL classifier, not stubs that would leave the phase inert', async () => {
  // `typeof === 'function'` — all the test above can ask — cannot tell a wired reader from a stub,
  // and a stub at either of these two is the whole feature going inert in production while every
  // injected test here passes. Measured: replacing `readTail` with a lambda returning an empty
  // tail, or `classifyLimit` with one answering `none`, leaves this file 125/125 green without
  // these two probes. That is the unwired-spawner failure at the deps that decide whether any rotation
  // ever fires, so both are exercised against real bytes and a real fixture row.
  const home = mkdtempSync(join(tmpdir(), 'soma-wd-tail-'));
  const savedHome = process.env.SOMA_HOME;
  const savedCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.SOMA_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = home;
  try {
    const real = (await load('real-tail-' + Date.now())).realDeps();
    const dir = join(home, 'projects', 'p');
    mkdirSync(dir, { recursive: true });
    const rows = [];
    for (let i = 0; i < 50; i++) rows.push(JSON.stringify({ type: 'assistant', i, timestamp: new Date(NOW + i).toISOString() }));
    writeFileSync(join(dir, 'u-real.jsonl'), rows.join('\n') + '\n');
    const read = real.readTail('u-real');
    assert.equal(read.rows.length, 40, 'TAIL_ROWS reaches the reader: 40 of the 50 rows — not all of them, and not a lambda that dropped the option');
    assert.deepEqual(read.rows.at(-1), JSON.parse(rows.at(-1)), 'oldest first, so the LAST element is the newest row — the one the classifier decides on');
    assert.equal(read.transcript, join(dir, 'u-real.jsonl'), 'located through the meter\'s own findTranscript, under the same projects root');
    // The classifier, over the fixture the phase's own tests use, including the one seconds→ms
    // conversion: a stub answering `none` would close no seat on any fleet, ever.
    assert.deepEqual(real.classifyLimit([FIVE_HOUR_ROW]), { kind: 'seat_window', rateLimitType: 'five_hour', resetsAt: RESETS_AT_MS });
    assert.equal(real.classifyLimit([]).kind, 'unobservable', 'and an empty tail is a non-verdict, not `none`');
  } finally {
    if (savedHome === undefined) delete process.env.SOMA_HOME; else process.env.SOMA_HOME = savedHome;
    if (savedCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedCfg;
    rmSync(home, { recursive: true, force: true });
  }
});

test('realDeps reaches the REAL seat pool: the six deps that carry a decision are wired, not merely named', async () => {
  // Sibling of the pin above, for the other half of the phase's real deps — and the same failure
  // it closes. `REQUIRED_DEPS names the eight limits deps` and `realDeps wires every dep the tick
  // requires to a real function` can only ask that a KEY exists and is callable, so both catch a
  // DELETED name and neither catches a WRONG one. MEASURED against the whole suite AS IT STOOD
  // WHEN THIS PIN WAS WRITTEN — 1311 tests then, a dated reading and not the current baseline;
  // the suite has grown since — each of these five wirings left it pass / fail 0:
  //
  //     markSeatUnverified: () => {}
  //     markSeatUnverified: (dir) => seats.markUnverified(dir, true)
  //     seatLoggedIn:       () => false
  //     readSeatState:      () => ({ seats: [] })
  //     pickSeat:           () => null
  //     closeSeat:          (dir, untilMs, why, now) => seats.close(dir, now, why, untilMs)
  //     reopenSeats:        () => []
  //
  // The second is the one to fear, and the argument it drops is new: driven end to end through the
  // real `seats.mjs` with two flagged seats whose `.claude.json` files are valid and carry
  // `oauthAccount`, the shipped wiring clears both flags and spawns the queued task on tick one,
  // while the dropped argument leaves both seats `unverified` and the task `queued` after three
  // ticks — the one-way door of the `unverified` flag, reinstated in full with nothing red. So all
  // six are exercised against real bytes: a real `soma.json`, a real `state/seats.json` and real
  // `.claude.json` files under a throwaway `$SOMA_HOME`. The two WRITERS are pinned by what
  // reaches disk AND by what they hand back, because `closeSeatOf` and `reopenExpiredSeats` both
  // decide on the return value; and the reader is driven through all THREE of its states, since
  // `{ seats: [] }` (no file yet) and `{ seats: [], unreadable: true }` (repair the file) are the
  // same two-state/three-state trap one level up.
  const home = mkdtempSync(join(tmpdir(), 'soma-wd-seats-'));
  const savedHome = process.env.SOMA_HOME;
  process.env.SOMA_HOME = home;
  try {
    mkdirSync(join(home, 'state'), { recursive: true });
    const seatA = join(home, 'seat-a');
    const seatB = join(home, 'seat-b');
    const seatC = join(home, 'seat-c');                            // never created: `loggedIn`'s third state
    mkdirSync(seatA, { recursive: true });
    mkdirSync(seatB, { recursive: true });
    // `oauthAccount` is the mark `claude auth login` leaves; a `.claude.json` that parses without
    // one is a seat nobody is logged in to, and an absent dir is could-not-observe.
    writeFileSync(join(seatA, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@seat.test' } }));
    writeFileSync(join(seatB, '.claude.json'), JSON.stringify({ numStartups: 3 }));
    const cfg = { seats: [{ config_dir: seatA, label: 'seat-a' }, { config_dir: seatB, label: 'seat-b' }] };
    writeFileSync(join(home, 'soma.json'), JSON.stringify(cfg));
    const closedUntil = NOW + 60 * MIN;
    const rowA = { config_dir: seatA, label: 'seat-a', closed_until: closedUntil, closed_reason: 'five_hour', unverified: false };
    const rowB = { config_dir: seatB, label: 'seat-b', closed_until: 0, closed_reason: null, unverified: true };
    writeFileSync(join(home, 'state', 'seats.json'), JSON.stringify({ seats: [rowA, rowB] }));

    const real = (await load('real-seats-' + Date.now())).realDeps();
    const poolRow = (dir) => real.readSeatState().seats.find((s) => s.config_dir === dir) ?? null;

    // The reader. `{ seats: [] }` is indistinguishable from "every seat is open, nothing is
    // closed": `closeSeatOf` would announce every closure as news on every tick, and `rotate`
    // would never see the `unreadable` state it refuses on.
    assert.deepEqual(real.readSeatState(), { seats: [rowA, rowB] },
      'readSeatState hands back the rows state/seats.json really holds, not an empty pool');

    // The picker, from both sides of a real closure — a `() => null` stub passes the first half
    // alone and a `() => SEAT` stub the second.
    assert.equal(real.pickSeat(closedUntil - 1, cfg), null,
      'seat-a is closed and seat-b is unverified, so the real pool offers nothing');
    assert.deepEqual(real.pickSeat(closedUntil + 1, cfg), rowA,
      'and once the closure has passed it answers with the real row');
    assert.equal(real.pickSeat.length, 2,
      'pickSeat takes (now, cfg) — a dropped parameter would silently decide against its own clock');

    // The flag, BOTH directions, because only one of them is new. `(dir) => markUnverified(dir, true)`
    // passes the `true` half and fails here: `reverifySeats` would write `true` where it read
    // "logged in again", and a flagged seat could never come back however often it verified.
    real.markSeatUnverified(seatB, false);
    assert.equal(poolRow(seatB)?.unverified, false,
      'false CLEARS the flag on disk — the only way a seat ever returns to the pool');
    real.markSeatUnverified(seatA, true);
    assert.equal(poolRow(seatA)?.unverified, true,
      'and true sets it — the skip `rotate` needs when a target is not logged in');
    assert.equal(real.markSeatUnverified.length, 2,
      'markSeatUnverified takes (dir, flag) — a wiring that drops the flag hard-wires one direction');

    // The login probe. Three states through the real file reader, because `rotate` skips on
    // anything but `true` and `reverifySeats` clears on nothing but `true`.
    assert.equal(real.seatLoggedIn(seatA), true, 'an oauthAccount is somebody logged in');
    assert.equal(real.seatLoggedIn(seatB), false, 'a .claude.json that parses without one is nobody');
    assert.equal(real.seatLoggedIn(seatC), null, 'and an absent config dir is could-not-observe, never false');
    assert.equal(real.seatLoggedIn.length, 1, 'seatLoggedIn takes (dir)');

    // The two WRITERS. Everything above reads; these are the deps that change the pool, and
    // neither had a single behavioural assertion anywhere in the suite. MEASURED, each of these
    // left the whole suite at 1312 pass / fail 0:
    //
    //     closeSeat:   () => ({ seats: [] })
    //     closeSeat:   (dir, untilMs, why, now) => seats.close(dir, now, why, untilMs)
    //     closeSeat:   (dir, untilMs, why, now) => { seats.close(dir, untilMs, why, now); }
    //     reopenSeats: () => []
    //     reopenSeats: (now) => { seats.reopenExpired(now); return seats.readSeatState().seats; }
    //
    // The second is the one to fear: the two arguments it exchanges are both clocks, so nothing
    // throws, a closure is still written and `SEAT_CLOSED` still announces it — the seat is
    // simply closed to the wrong instant, measured off the reset the API named instead of off the
    // tick. Every line the operator reads says the rotation worked. The third is quieter still:
    // `closeSeatOf` reads the effective closure back out of what this dep RETURNS (`:1483`),
    // precisely because the pool floors and never shortens, so a swallowed return makes the
    // once-per-real-change rule decide on a `resetsAt` that was never written. The fifth turns
    // "what I reopened" into "every row there is", and `reopenExpiredSeats` emits one
    // SEAT_REOPENED per returned row — a toast for every seat on every tick, for ever.
    const seatInPool = (state, dir) => (Array.isArray(state?.seats) ? state.seats.find((s) => s?.config_dir === dir) ?? null : null);

    // A closure whose `untilMs` is honoured verbatim — above the floor, below the ceiling — which
    // is what makes the swap visible: exchanging the clocks lands on `untilMs + MIN_CLOSE_MS`.
    const t1 = NOW + 10 * MIN;
    const untilB = NOW + 180 * MIN;
    const afterB = real.closeSeat(seatB, untilB, 'seat_cap', t1);
    assert.equal(poolRow(seatB)?.closed_until, untilB,
      'closeSeat(dir, untilMs, why, now) closes THAT seat until THAT instant — its two clocks are not interchangeable');
    assert.equal(poolRow(seatB)?.closed_reason, 'seat_cap',
      'and records the reason it was handed, the only thing that tells a five-hour window from a spend cap in the pool');
    assert.equal(seatInPool(afterB, seatB)?.closed_until, untilB,
      'and RETURNS the pool as it now reads: closeSeatOf reads the effective closure out of this value (:1483) rather than believing resetsAt');
    assert.deepEqual([poolRow(seatA)?.closed_until, poolRow(seatA)?.closed_reason], [NOW + 60 * MIN, 'five_hour'],
      'the seat that was NOT named keeps its own closure — a dep that closes the wrong seat leaves the rate-limited one open to rotate onto');
    assert.equal(real.closeSeat.length, 4,
      'closeSeat takes (dir, untilMs, why, now) — the fixed arity realDeps documents, because a forwarded argument would replace the clock');

    // The clock argument, made load-bearing: a `resetsAt` already in the past — real rows can be
    // non-monotonic, and the fixture's are — is floored at `now + MIN_CLOSE_MS`, and here and
    // only here the FOURTH argument decides the answer. seat-c has no row yet, so this is also
    // the pool's create-on-first-close; and the floor is aimed at seat-a's own closure, so that
    // two seats lapse on the same tick below.
    const lapse = NOW + 60 * MIN;
    real.closeSeat(seatC, NOW - 60 * MIN, 'five_hour', lapse - MIN_CLOSE_MS);
    assert.equal(poolRow(seatC)?.closed_until, lapse,
      'a stale resetsAt is floored against the clock this dep is HANDED — a dropped or stale fourth argument floors against a different one');

    // The reopener, from both sides of a real expiry and then twice at the same clock. It is the
    // only source of SEAT_REOPENED and `reopenExpiredSeats` emits one event per row it returns,
    // so the contract is exactly-what-I-reopened: not the pool, not a count, not a boolean. TWO
    // seats lapse on this tick and a third does not, because with only one lapsing row "the rows
    // that lapsed", "the FIRST row that lapsed" and "the last one" are the same answer.
    assert.deepEqual(real.reopenSeats(lapse - 1), [],
      'one ms before a closure lapses nothing is reopened — reopenSeats decides on the clock it is handed, not on wall time');
    const reopened = real.reopenSeats(lapse);
    assert.deepEqual(reopened.map((r) => r?.config_dir), [seatA, seatC],
      'and with exactly the rows that lapsed, ALL of them, in pool order — seat-b is not due for another two hours');
    assert.deepEqual(reopened.map((r) => [r?.closed_until, r?.closed_reason]), [[0, null], [0, null]],
      'each row as it NOW reads, open — the event says a seat came back, so it must not carry the closed copy');
    assert.deepEqual([poolRow(seatA)?.closed_until, poolRow(seatC)?.closed_until, poolRow(seatB)?.closed_until, poolRow(seatA)?.unverified],
      [0, 0, untilB, true],
      'the pool on disk agrees, the closure that had not passed is untouched, and `unverified` SURVIVES a reopen — no clock clears "nobody is logged in"');
    assert.deepEqual(real.reopenSeats(lapse), [],
      'the second call at the same clock reopens nothing — that idempotence is what makes SEAT_REOPENED once per real reopen');
    assert.equal(real.reopenSeats.length, 1, 'reopenSeats takes (now)');

    // The reader's THIRD state, and the one every seated fleet is in before anything writes the
    // pool: ENOENT is `{ seats: [] }` — readable, EMPTY, normal (`seats.mjs:156`) — and it is not
    // `unreadable`. MEASURED: a wiring that relabels an empty pool `{ seats: [], unreadable: true }`
    // left the whole suite at 1312 pass / fail 0 with both other states asserted, because the
    // fixture never built this one. In production that wiring answers `seats_unreadable` on a
    // brand-new seated fleet and never rotates at all, while telling the operator to repair a file
    // that does not exist yet. Two-state thinking over a three-state world is this module's
    // characteristic defect, so the fixture reaches all three.
    rmSync(join(home, 'state', 'seats.json'));
    assert.deepEqual(real.readSeatState(), { seats: [] },
      'no state/seats.json YET is a READABLE EMPTY pool, never an unreadable one — a fresh seated fleet must still rotate');

    // The reader's UNREADABLE state — the half the rows cannot show. On a READABLE pool
    // `readSeatState` answers `{ seats }` with no `unreadable` key at all (`seats.mjs:180`), so
    // every assertion above is byte-identical under
    //
    //     readSeatState: () => ({ seats: seats.readSeatState().seats })
    //
    // MEASURED: whole suite 1312 pass / fail 0. What that wiring drops is not rows, it is the flag
    // TWO product guards read — `rotate` (`:1559`, `?.unreadable === true` -> `seats_unreadable`)
    // and `closeSeatOf`'s early return (`:1493`), the fix for a SEAT_CLOSED repeated every tick.
    // Driven end to end with a corrupt state/seats.json, the stripped wiring re-opens that defect
    // verbatim: `SEAT_CLOSED:seat-a` on every tick for ever against a pool that holds nothing
    // (`mutateSeats` writes nothing when the file is unreadable), and the operator is told
    // `no_open_seat` — wait for a reset — when the fix is to repair the file. Pinning the guard at
    // its source cannot catch a dep starved of its input, so the fixture reaches all three states.
    writeFileSync(join(home, 'state', 'seats.json'), '{ "seats": [ torn');
    assert.deepEqual(real.readSeatState(), { seats: [], unreadable: true },
      'and an UNREADABLE pool arrives as { seats: [], unreadable: true } — the flag is what the dep carries, not just the rows');
  } finally {
    if (savedHome === undefined) delete process.env.SOMA_HOME; else process.env.SOMA_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('a rotations array carrying non-finite stamps is pruned rather than believed: three of them are not three rotations this hour', async () => {
  const { tick } = await load('lim-nonfinite-' + Date.now());
  // `fleet.rotationsWithin`'s `Number.isFinite(t)` guard, exercised at last. Its own fixture's only
  // non-finite entry is `NaN`, and `NaN > x` is false with or WITHOUT the guard, so the guard has
  // never been asserted by anything. These three are: a numeric STRING coerces and compares
  // greater, and `Infinity > x` is true, so without the guard a checkpoint carrying them — a hand
  // repair of fleet.json, which the RUNBOOK invites — reads as a thrashing lead and refuses that
  // lead every rotation forever, with nothing that can ever age out.
  const c = limited([FIVE_HOUR_ROW], SEATS, seatPool(SEATS), {
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', seat: 'seat-a', rotations: ['9999999999999', Infinity, '9999999999998'] })] },
  });
  await tick(c.deps);
  assert.deepEqual(c.calls.killSession, ['lead-a'], 'not thrash: no FINITE rotation happened in the last hour');
  assert.deepEqual(c.task().rotations, [NOW], 'and the garbage is pruned off the row by this write, not carried forward');
});

test('an OVER-LONG row in the tail is a torn tail, not a missing row: the REAL reader and classifier over a 17 MB line leave a recovered lead alone', async () => {
  // THE DEFECT THIS PINS, end to end through the two real deps. `streamLines` counted a line it
  // refused to buffer and never handed it to the fold, so `readTailRows` returned no `null` in its
  // place: the row simply vanished. MEASURED at the production defaults over
  // [Event A's five_hour row, a HEALTHY row carrying a 17 MB blob]: `rows=1 bad_lines=1`, the
  // real classifier answered `{kind:'seat_window', resetsAt:1440433800000}`, and this phase closed
  // the seat and killed+resumed a lead that had ALREADY RECOVERED. One `Read` of a large file puts
  // a row that size in a transcript.
  const home = mkdtempSync(join(tmpdir(), 'soma-wd-fat-'));
  const savedHome = process.env.SOMA_HOME;
  const savedCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.SOMA_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = home;
  try {
    const { tick, realDeps } = await load('lim-fat-' + Date.now());
    const readTail = realDeps().readTail;                                     // the REAL reader, at TAIL_ROWS and the real 16 MB ceiling
    const dir = join(home, 'projects', 'p');
    mkdirSync(dir, { recursive: true });
    const write = (...rows) => writeFileSync(join(dir, 'u.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const run = async () => {
      const c = limited([], SEATS, seatPool(SEATS), { readTail });            // `readTail` reads the file, not the fixture
      await tick(c.deps);
      return c;
    };

    write(FIVE_HOUR_ROW, { ...HEALTHY_ROW, blob: 'x'.repeat(17 * 1024 * 1024) });
    const fat = await run();
    assert.deepEqual(fat.calls.killSession, [], 'a lead whose newest row could not be read is not killed on the row before it');
    assert.deepEqual(fat.calls.closeSeat, [], 'and no seat is closed on a verdict the tail cannot support');
    assert.deepEqual(eventsOf(fat, 'ROTATED'), []);
    const err = oneEvent(fat, 'WATCHDOG_ERROR');
    assert.equal(err.payload.where, 'limits');
    assert.match(err.payload.error, /not an object \(null\)/, 'the torn-tail line: the drop is REPORTED, not silently absent');

    // The control that makes the assertion above mean something: the same two rows with a small
    // blob read `none` (the lead recovered), and the rate_limit row ALONE is rotated. So the fat
    // case is neither "nothing ever happens here" nor "the classifier cannot see the hit".
    write(FIVE_HOUR_ROW, HEALTHY_ROW);
    const small = await run();
    assert.deepEqual(small.calls.killSession, []);
    assert.deepEqual(eventsOf(small, 'WATCHDOG_ERROR'), [], 'a clean tail that reads `none` is silent');
    write(FIVE_HOUR_ROW);
    const hit = await run();
    assert.deepEqual(hit.calls.killSession, ['lead-a'], 'the same fixture DOES rotate when the tail really is a limit hit');
    assert.equal(oneEvent(hit, 'ROTATED').payload.to, 'seat-b');
  } finally {
    if (savedHome === undefined) delete process.env.SOMA_HOME; else process.env.SOMA_HOME = savedHome;
    if (savedCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedCfg;
    rmSync(home, { recursive: true, force: true });
  }
});

test('an unverified seat that reads logged in again is put back in the pool — and it is the only caller in the product that clears the flag', async () => {
  const { tick } = await load('lim-reverify-' + Date.now());
  // THE DEFECT THIS PINS. `rotate()` marks a seat `unverified` whenever `seatLoggedIn` is not
  // exactly `true` — which includes `null`, "could not observe": a momentary unreadable
  // `.claude.json`, a seat root that is a file, a read that lost a race with `claude` rewriting
  // it. Nothing ever wrote the flag back. `markUnverified(dir, false)` existed and was tested in
  // seats.test.mjs, and `grep -rn markSeatUnverified bin/` found exactly one writer, always
  // `true`. MEASURED against the REAL seats.mjs in an isolated SOMA_HOME: two configured seats
  // both flagged, both `.claude.json` files present and carrying `oauthAccount`, one queued task,
  // three consecutive real ticks — ZERO events, zero toasts, zero spawns, the row still `queued`
  // and both flags still set. A transient unreadable file across the pool retired the fleet.
  const flagged = (over) => seatPool(SEATS.map((s) => ({ ...s, unverified: true })), over);
  const back = flagged({ loggedIn: () => true });
  const c = limited([HEALTHY_ROW], SEATS, back, {
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', seat: 'seat-a' }), row({ id: 'b', status: 'queued' })] },
  });
  await tick(c.deps);
  assert.deepEqual(c.calls.markSeatUnverified, [['/s/a', false], ['/s/b', false]], 'both seats are handed back to the pool');
  assert.deepEqual(back.state.seats.map((s) => s.unverified), [false, false]);
  // The limits phase runs before admission, so the queue moves in the SAME tick the flags clear.
  assert.deepEqual(c.calls.spawnLead, ['b'], 'the stall is over');
  assert.deepEqual(c.calls.spawnOpts, [{ configDir: '/s/a' }]);

  // Three states, kept three. A definite `false` — nobody is logged in — leaves the flag where it
  // is: `claude auth login` is the fix and no clock or tick performs it. `null` leaves it too:
  // nothing was learned, so nothing is written, and the seat stays out of the pool (fail closed).
  for (const [name, answer] of [['false', () => false], ['null', () => null]]) {
    const held = flagged({ loggedIn: answer });
    const stays = limited([HEALTHY_ROW], SEATS, held, { fleet: { tasks: [row({ id: 'b', status: 'queued' })] } });
    await tick(stays.deps);
    assert.deepEqual(stays.calls.markSeatUnverified, [], `loggedIn ${name}: nothing is written`);
    assert.deepEqual(held.state.seats.map((s) => s.unverified), [true, true], `loggedIn ${name}: the seats stay out of the pool`);
    assert.deepEqual(stays.calls.spawnLead, [], `loggedIn ${name}: and the queue stays held`);
  }

  // A pool with nothing flagged costs one lock-free read and not one `.claude.json` read — the
  // healthy fleet's price for this pass.
  const clean = limited([HEALTHY_ROW], SEATS, seatPool(SEATS));
  await tick(clean.deps);
  assert.deepEqual(clean.calls.seatLoggedIn, [], 'no seat is flagged, so no login file is read');
  assert.deepEqual(clean.calls.markSeatUnverified, []);

  // An UNREADABLE pool is left alone, and with no clause of its own: it answers `{seats: [],
  // unreadable: true}`, so there is nothing flagged to read a login file for. The third state is
  // asserted rather than reasoned about — a `state?.unreadable === true` early return in
  // `reverifySeats` would be a guard no input can reach, and this is the case that says why.
  const dark = limited([HEALTHY_ROW], SEATS, seatPool(SEATS.map((s) => ({ ...s, unverified: true })), { unreadable: true, loggedIn: () => true }));
  await tick(dark.deps);
  assert.deepEqual(dark.calls.seatLoggedIn, []);
  assert.deepEqual(dark.calls.markSeatUnverified, []);

  // A flagged row for a dir soma.json no longer names is never picked, so it is never re-verified.
  const orphan = seatPool([{ config_dir: '/s/zombie', label: null, unverified: true }, ...SEATS], { loggedIn: () => true });
  const z = limited([HEALTHY_ROW], SEATS, orphan);
  await tick(z.deps);
  assert.deepEqual(z.calls.seatLoggedIn, [], 'a dir that left soma.json is not a seat to re-verify');
  assert.equal(orphan.state.seats[0].unverified, true);
});

test('admission held because no seat is open says so ONCE per lead per launch, rather than stopping the queue in silence', async () => {
  const { tick } = await load('lim-hold-' + Date.now());
  // This was first held silently, justified by "SEAT_CLOSED already said why". True of a CLOSED
  // seat; false of an UNVERIFIED one, which nothing announces at all — so an un-provisioned pool
  // (a seat in soma.json nobody ran `claude auth login` for) stopped the queue with no line
  // anywhere, and `soma status` was the only surface. MEASURED: zero events over three real ticks.
  //
  // The UNREADABLE arm is here for a claim rather than a defect: `seats.pick`'s JSDoc said each of
  // its three `null`s "is reported as its own ROTATION_UNAVAILABLE reason rather than one", which
  // is true of `rotate()` (`:1595` asks `readSeatState().unreadable` first) and false HERE —
  // admission has no unreadable check, so a pool it cannot read is `no_open_seat`, the same
  // sentence as a pool whose every seat is shut. `wd/rotation-events.mjs`'s `UNAVAILABLE_WHY`
  // already documented that; the pick comment did not, and nothing failed when it disagreed.
  const shut = (over) => seatPool(SEATS.map((s) => ({ ...s, ...over })), { loggedIn: () => false });
  for (const [name, pool] of [['closed', shut({ closed_until: NOW + 60 * MIN, closed_reason: 'five_hour' })], ['unverified', shut({ unverified: true })], ['unreadable', seatPool(SEATS, { unreadable: true, loggedIn: () => false })]]) {
    const mk = (orchEvents) => limited([HEALTHY_ROW], SEATS, pool, {
      fleet: { tasks: [row({ id: 'b', status: 'queued' })] }, orchEvents,
    });
    const first = mk([]);
    await tick(first.deps);
    assert.deepEqual(first.calls.spawnLead, [], `${name}: the queue is held`);
    assert.equal(first.task('b').status, 'queued', name);
    const said = oneEvent(first, 'ROTATION_UNAVAILABLE');
    assert.deepEqual(said.payload, { lead: 'b', why: 'no_open_seat' }, name);
    assert.equal(said.lead, 'b', name);
    if (name === 'unverified') assert.deepEqual(eventsOf(first, 'SEAT_CLOSED'), [], 'and nothing else says why: an unverified seat emits no SEAT_CLOSED, ever');
    // `deepEqual` on the payload, not a `match`: what this arm rules out is the OTHER reason this
    // event can carry, and `seats_unreadable` here would be a different sentence to the operator.
    // Tick two, with tick one's line in the durable log: silence. A fleet held for a week says it
    // once, which is the rule every other refusal in this phase keeps.
    const second = mk(first.calls.appendEvent.map((e) => ev(e.type, e.lead, NOW, e.payload)));
    await tick(second.deps);
    assert.deepEqual(eventsOf(second, 'ROTATION_UNAVAILABLE'), [], `${name}: not once per tick`);
  }
  // The control: an open seat admits and says nothing.
  const open = limited([HEALTHY_ROW], SEATS, seatPool(SEATS), { fleet: { tasks: [row({ id: 'b', status: 'queued' })] } });
  await tick(open.deps);
  assert.deepEqual(open.calls.spawnLead, ['b']);
  assert.deepEqual(eventsOf(open, 'ROTATION_UNAVAILABLE'), []);
  // And a fleet with NO seats is today's behaviour byte for byte: admitted, pool never asked, silent.
  const blind = ctx({ fleet: { tasks: [row({ id: 'b', status: 'queued' })] } });
  await tick(blind.deps);
  assert.deepEqual(blind.calls.spawnLead, ['b']);
  assert.equal(blind.calls.pickSeat, 0);
  assert.deepEqual(eventsOf(blind, 'ROTATION_UNAVAILABLE'), []);
});

test('a revival picks its seat BEFORE the kill and before the attempt: a malformed soma.json seat entry costs the lead nothing', async () => {
  const { tick } = await load('lim-revive-order-' + Date.now());
  // `seats.pick` and `seatOfRow` both reach `seats.loadSeats`, which refuses a malformed
  // `soma.json` seat entry by name (`cfg.seats[0] must be an object …`). The pick first sat
  // after the kill and after the attempt charge, so that throw landed in `fail('revival', …)`
  // with the pane already destroyed and the attempt already spent — and three ticks of one config
  // typo reach GAVE_UP on a lead that was only ever waiting to be relaunched. The pick is a pure
  // read; nothing is spent until it has answered.
  const boom = new TypeError('seats: cfg.seats[0] must be an object { config_dir, label }, got string');
  const c = limited([], SEATS, seatPool(SEATS), {
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', seat: 'seat-a', attempts: 1 })] },
    alive: new Set(),                                                         // dead -> revival
    pickSeat: () => { throw boom; },
  });
  await tick(c.deps);
  assert.deepEqual(c.calls.killSession, [], 'the dead pane is still standing: it is the death scene soma peek shows');
  assert.equal(c.task().attempts, 1, 'and the attempt was not spent on a launch that never happened');
  assert.deepEqual(c.calls.resumeLead, []);
  assert.deepEqual(c.calls.spawnLead, []);
  assert.deepEqual(eventsOf(c, 'LEAD_DEAD'), [], 'no death scene was captured either');
  const err = oneEvent(c, 'WATCHDOG_ERROR');
  assert.equal(err.payload.where, 'revival');
  assert.equal(err.lead, 'a');
  assert.match(err.payload.error, /cfg\.seats\[0\] must be an object/, 'reported by name, for soma doctor to act on');
  // The control: the same fixture with a pool that answers does kill, charge and relaunch — so the
  // three assertions above are the refusal and not a revival that never runs here.
  const ok = limited([], SEATS, seatPool(SEATS), {
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', seat: 'seat-a', attempts: 1 })] },
    alive: new Set(),
  });
  await tick(ok.deps);
  assert.deepEqual(ok.calls.killSession, ['lead-a']);
  assert.equal(ok.task().attempts, 2);
  assert.deepEqual(ok.calls.resumeOpts, [{ configDir: '/s/a' }]);
  ranBefore(ok.order, 'pickSeat', 'killSession:lead-a');
});

test('a revival refuses a seats that is not an array at the pick, even when the pick answers null: no death scene, no attempt, no kill', async () => {
  const { tick } = await load('lim-revive-nonarray-' + Date.now());
  // `seatsConfigured` read a non-array `seats` as "no seats", so revival skipped the pick and
  // launched seat-blind — into a spawner that reads the same soma.json, reaches `seats.loadSeats`
  // through `launchRoots` → `seatRoots`, and throws AFTER the death scene, the attempt and the
  // kill. Three ticks of one typo reached GAVE_UP. The row carries no seat label and the pick
  // answers null without reading `cfg.seats` (the harness default, and what `seats.pick` does for
  // an unreadable state/seats.json), so the refusal has to be the watchdog's own read of the pool:
  // a fix that relied on the pick dep throwing would still kill this lead.
  for (const seatsCfg of [{}, 'a', 5, true]) {
    const name = `seats ${JSON.stringify(seatsCfg)}`;
    const c = ctx({
      cfg: cfgOf({ seats: seatsCfg }),
      fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', attempts: 1 })] },
      alive: new Set(),                                                       // dead -> revival
    });
    await tick(c.deps);
    assert.deepEqual(eventsOf(c, 'LEAD_DEAD'), [], `${name}: no death scene was captured`);
    assert.equal(c.task().attempts, 1, `${name}: the attempt was not spent`);
    assert.deepEqual(c.calls.killSession, [], `${name}: the dead pane is still standing`);
    assert.deepEqual(c.calls.spawnLead, [], name);
    assert.deepEqual(c.calls.resumeLead, [], name);
    const err = oneEvent(c, 'WATCHDOG_ERROR');
    assert.equal(err.payload.where, 'revival', name);
    assert.equal(err.lead, 'a', name);
    assert.match(err.payload.error, /cfg\.seats must be an array/, `${name}: reported by name, for the operator to fix`);
  }
  // The control: the same dead row with `seats: []` — no rotation — is killed, charged and
  // relaunched, so the assertions above are the refusal and not a revival that never runs here.
  const ok = ctx({
    cfg: cfgOf({ seats: [] }),
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', attempts: 1 })] },
    alive: new Set(),
  });
  await tick(ok.deps);
  assert.deepEqual(ok.calls.killSession, ['lead-a']);
  assert.equal(ok.task().attempts, 2);
  assert.equal(eventsOf(ok, 'LEAD_DEAD').length, 1);
});

test('admission with a seats that is not an array claims nothing: the pool is asked before the row is spawned', async () => {
  const { tick } = await load('adm-nonarray-' + Date.now());
  const { loadSeats } = await import('../bin/lib/seats.mjs');
  // The pick as `seats.pick` makes it on a readable state file: through `loadSeats`, which refuses
  // a non-array by name. Read as "no seats", `{}` let admission claim the row and launch into a
  // spawner that throws on the same value — an attempt charged per tick until GAVE_UP failed the task.
  const c = ctx({
    cfg: cfgOf({ seats: {} }),
    fleet: { tasks: [row({ id: 'b', status: 'queued' })] },
    pickSeat: (now, cfg) => { loadSeats(cfg); return null; },
  });
  await tick(c.deps);
  assert.deepEqual(c.calls.spawnLead, [], 'nothing was launched');
  assert.deepEqual(c.calls.setTaskStatus, [], 'the row was never claimed');
  assert.equal(c.task('b').status, 'queued');
  assert.equal(c.task('b').attempts, 0, 'and no attempt was charged');
  const err = oneEvent(c, 'WATCHDOG_ERROR');
  assert.equal(err.payload.where, 'admission');
  assert.match(err.payload.error, /cfg\.seats must be an array/);
});

test('cfg.seats [] — the value production actually passes — is no seats at all: no pool read, no reopen, no lock, today\'s launch', async () => {
  const { tick } = await load('lim-empty-' + Date.now());
  // A soma.json with no `seats` key — every config written before seats existed — makes
  // `loadConfig()` hand every tick `seats: []` out of DEFAULTS (`bin/lib/config.mjs`). `[]` is
  // therefore the PRODUCTION value of the predicate the whole "no seats = today's behaviour byte
  // for byte" claim rests on, and
  // every test used either "no seats key" or "two seats" — never `[]`. Two mutations that left
  // the FULL 1296-test suite green die here: `seatsConfigured` without its `&& length > 0` half
  // (`Array.isArray([])` is true, so admission asks the pool, gets null and stops admitting
  // ENTIRELY on a live-shaped fleet), and `reopenExpiredSeats`' guard replaced by `if (true)`
  // (a seat-less fleet then calls `seats.reopenExpired` every 30 s — `mutateSeats` →
  // `withFleetLock` → a fleet lock and a `state/seats.json` created for a fleet with no seats).
  const empty = (over = {}) => ctx({
    cfg: cfgOf({ seats: [] }),
    alive: new Set(['lead-a']),
    capturePane: () => IDLE_FRAME,
    ...over,
  });
  const c = empty({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u' }), row({ id: 'b', status: 'queued' })] },
    readTail: tail(HEALTHY_ROW),
  });
  await tick(c.deps);
  assert.deepEqual(c.calls.spawnLead, ['b'], '`[]` is not "configured, and all of them closed": the queue moves');
  assert.deepEqual(c.calls.spawnOpts, [{}], 'on the spawner\'s own env, exactly as before seats existed');
  assert.equal(c.task('b').seat, null);
  assert.equal(c.calls.pickSeat, 0, 'the pool is never asked');
  assert.equal(c.calls.reopenSeats, 0, 'and state/seats.json is neither read nor created, so no fleet lock is taken for it');

  // And the live-fleet property the merge decision rests on, at `[]` rather than at "no key": a
  // limit-hit lead on a seat-less fleet is not killed, nothing is closed, no attempt is charged,
  // and it is told once that there is nowhere to go.
  const hit = empty({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', attempts: 0 })] },
    readTail: tail(FIVE_HOUR_ROW),
  });
  await tick(hit.deps);
  assert.deepEqual(hit.calls.killSession, []);
  assert.deepEqual(hit.calls.resumeLead, []);
  assert.deepEqual(hit.calls.closeSeat, []);
  assert.equal(hit.calls.reopenSeats, 0);
  assert.deepEqual(oneEvent(hit, 'ROTATION_UNAVAILABLE').payload, { lead: 'a', why: 'no_open_seat' });
  assert.deepEqual([hit.task().seat, hit.task().attempts, hit.task().status], [null, 0, 'spawned'], 'the row is as it was');
});

test('a SPAWNED does not move revivedAt: only a REVIVED or a ROTATED dates the process a question has to be newer than', async () => {
  const { tick } = await load('lim-spawnfold-' + Date.now());
  // The merged `case 'SPAWNED': case 'REVIVED': case 'ROTATED'` arm is account rotation's, and
  // `if (e.type !== 'SPAWNED')` is its one behavioural distinction — the arm's contract. The
  // ROTATED half was pinned and the SPAWNED half was not: deleting the condition left the full
  // suite green. `revivedAt` is what dates the current process for `releaseBlockedSlot`, and an
  // admission SPAWNED is the START of the process the question was asked BY, not a new one that
  // supersedes it — so a SPAWNED that moved it would leave a lead that really is waiting on a
  // human sitting in `spawned`, holding a slot, for ever.
  const askedAt = NOW - 141 * MIN;                                            // past the 120-minute grace
  const launchAt = NOW - 140 * MIN;                                           // and NEWER than the question
  const payloads = {
    SPAWNED: { session_uuid: 'u', tmux_target: 'lead-a', cwd: '/w/a' },
    REVIVED: { plan: 'resume', attempt: 1, session_uuid: 'u' },
    ROTATED: { lead: 'a', from: 'seat-a', to: 'seat-b', rateLimitType: 'five_hour', resetsAt: RESETS_AT_MS },
  };
  const mk = (type) => ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', updated: NOW - 300 * MIN })] },
    alive: new Set(['lead-a']),
    leadEvents: { a: [ev('NEEDS_INPUT', 'a', askedAt)] },
    orchEvents: [ev(type, 'a', launchAt, payloads[type])],
  });
  const spawned = mk('SPAWNED');
  await tick(spawned.deps);
  assert.equal(spawned.task().status, 'blocked', 'the question still decides the row: a SPAWNED is not a newer process');
  assert.equal(oneEvent(spawned, 'BLOCKED').payload.asked_at, askedAt);
  // The two that DO move it, as controls — the same fixture, the same clock, one event type apart.
  for (const type of ['REVIVED', 'ROTATED']) {
    const c = mk(type);
    await tick(c.deps);
    assert.equal(c.task().status, 'spawned', `${type}: a question the PREVIOUS process asked is not this one's`);
    assert.deepEqual(eventsOf(c, 'BLOCKED'), [], type);
  }
});

/**
 * The rows Claude Code appends AFTER a limit hit, which sit between the deciding assistant row and
 * the end of the file — what `TAIL_ROWS` exists to reach past. Shapes MEASURED over real
 * transcripts: `queue-operation` carries a `timestamp`; `mode`, `last-prompt`,
 * `permission-mode` and six other types carry NONE.
 * Only the fields the guard reads are reproduced here; no content.
 */
const QUEUE_OP = (ms) => ({ type: 'queue-operation', operation: 'enqueue', sessionId: 's', timestamp: new Date(ms).toISOString() });
const MODE_ROW = { type: 'mode', mode: 'normal', sessionId: 's' };

test('the stale-row guard dates the tail by its last ASSISTANT row: the rows Claude Code appends after a hit are not a new hit', async () => {
  const { tick } = await load('lim-lastasst-' + Date.now());
  // The classifier reads the last ASSISTANT row; the guard has to date the same row, or the two
  // disagree about which row decided and a post-rotation stale hit rotates the lead a second time,
  // up to the thrash bound — the very failure the guard exists for. Dropping `r.type ===
  // 'assistant'` left the full suite green. Both reachable shapes are here: a trailing row with a
  // timestamp NEWER than the launch (the guard would read the tail as fresh), and a trailing row
  // with NO timestamp at all — `Date.parse(undefined)` is not even reached, `typeof r.timestamp
  // === 'string'` fails and the answer is NaN, which no comparison reads as stale, so the guard
  // would never skip anything again.
  const rowAt = NOW - 10 * MIN;
  const launchAt = rowAt + 5 * MIN;                                           // the rotation came AFTER the hit
  const mk = (...after) => limited([stamped(FIVE_HOUR_ROW, rowAt), ...after], SEATS, seatPool(SEATS), {
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', seat: 'seat-b', rotations: [launchAt] })] },
    orchEvents: [ev('ROTATED', 'a', launchAt, { lead: 'a', from: 'seat-a', to: 'seat-b', rateLimitType: 'five_hour', resetsAt: RESETS_AT_MS })],
  });
  for (const [name, trailing] of [
    ['a queue-operation stamped after the rotation', QUEUE_OP(launchAt + MIN)],
    ['a mode row, which carries no timestamp at all', MODE_ROW],
  ]) {
    const c = mk(trailing);
    await tick(c.deps);
    assert.deepEqual(c.calls.closeSeat, [], `${name}: the hit is still the pre-rotation process's`);
    assert.deepEqual(c.calls.killSession, [], name);
    assert.deepEqual(c.calls.resumeLead, [], name);
    assert.deepEqual(eventsOf(c, 'ROTATED'), [], name);
  }
  // The control: an ASSISTANT row stamped after the rotation IS this process's own newest state —
  // and it reads `none`, because a healthy row after a rate_limit row is a lead that recovered.
  const recovered = mk({ ...HEALTHY_ROW, timestamp: new Date(launchAt + MIN).toISOString() });
  await tick(recovered.deps);
  assert.deepEqual(recovered.calls.closeSeat, []);
  // …and the same tail with the hit LAST and newer than the launch does rotate, so the skips above
  // are the guard and not an inert fixture.
  const fresh = limited([stamped(FIVE_HOUR_ROW, launchAt + MIN)], SEATS, seatPool(SEATS), {
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', seat: 'seat-b', rotations: [launchAt] })] },
    orchEvents: [ev('ROTATED', 'a', launchAt, { lead: 'a', from: 'seat-a', to: 'seat-b', rateLimitType: 'five_hour', resetsAt: RESETS_AT_MS })],
  });
  await tick(fresh.deps);
  assert.deepEqual(fresh.calls.killSession, ['lead-a']);
});

test('SEAT_CLOSED is decided by the closure the pool actually holds, read back — not by the resetsAt the API said', async () => {
  const { tick } = await load('lim-readback-' + Date.now());
  // The JSDoc says the effective `closed_until` is read back from what `closeSeat` returns
  // "rather than assumed", and nothing held it: `const closedAfter = resetsAt;` left the full
  // suite green. The two differ exactly where the pool's five-minute floor bites — and `resetsAt`
  // was MEASURED non-monotonic (most rows at the true reset, the rest spread over later
  // values), which is why the floor exists. Here a closure in force until NOW+2min
  // meets a verdict whose reset is NOW+1min: the pool extends the closure to NOW+5min, which is
  // news; the raw `resetsAt` is EARLIER than the closure already in force, so an assumed value
  // says nothing happened and the operator never learns the seat is shut for another five minutes.
  const pool = seatPool([{ ...SEATS[0], closed_until: NOW + 2 * MIN, closed_reason: 'five_hour' }, SEATS[1]]);
  const c = limited([FIVE_HOUR_ROW], SEATS, pool, {
    classifyLimit: () => ({ kind: 'seat_window', rateLimitType: 'five_hour', resetsAt: NOW + MIN }),
  });
  await tick(c.deps);
  assert.deepEqual(oneEvent(c, 'SEAT_CLOSED').payload, { seat: 'seat-a', reason: 'five_hour', resetsAt: NOW + MIN },
    'announced, and the payload still says what the API said — the readback decides WHETHER, not WHAT');
  assert.equal(pool.state.seats[0].closed_until, NOW + 5 * MIN, 'the floor is what made it news');
  // The control: the same verdict on the next tick, with the closure now in force until NOW+5min,
  // is not news — the pool returns the same value it already held.
  const again = limited([FIVE_HOUR_ROW], SEATS, pool, {
    classifyLimit: () => ({ kind: 'seat_window', rateLimitType: 'five_hour', resetsAt: NOW + MIN }),
  });
  await tick(again.deps);
  assert.deepEqual(eventsOf(again, 'SEAT_CLOSED'), []);
});

test('a row whose seat is not a usable label rotates FROM nowhere nameable, rather than losing its ROTATED to the builder', async () => {
  const { tick } = await load('lim-fromguard-' + Date.now());
  // `fleet.json` is hand-repairable (the RUNBOOK says so) and `readFleet` preserves what it does
  // not know, so `seat` can be anything. `rotated()`'s `from` is `strOrNull`: it refuses `''` and
  // it refuses a number. Without `rotate()`'s own `typeof === 'string' && !== ''` guard the
  // builder throws AFTER the kill, the resume and the row write — so the lead really has moved
  // seats and no ROTATED says so, which leaves `history.launch` blind, which disarms the
  // stale-row guard, which rotates it again on the next tick up to the thrash bound.
  for (const bad of ['', 0, ['seat-a'], { label: 'seat-a' }]) {
    const c = limited([FIVE_HOUR_ROW], SEATS, seatPool(SEATS), {
      fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', seat: bad })] },
    });
    await tick(c.deps);
    const name = JSON.stringify(bad);
    assert.deepEqual(eventsOf(c, 'WATCHDOG_ERROR'), [], `${name}: the rotation is announced, not refused`);
    assert.equal(oneEvent(c, 'ROTATED').payload.from, null, `${name}: from nowhere nameable`);
    assert.deepEqual(c.calls.closeSeat, [], `${name}: and nothing is closed — there is no seat to close`);
    assert.equal(c.task().seat, 'seat-a', `${name}: the row gains the seat it landed on`);
  }
});

test('a reopen that answers with no array is a silent skip, and a cfg.seats that is not an array is one named error, never a tick-ending throw', async () => {
  const { tick } = await load('lim-guards-' + Date.now());
  // Two guards nothing could fail. `reopenSeats` is an injected dep and `for (const row of
  // undefined)` is a TypeError that costs the whole reopen pass — and, being reported against
  // `lead: null`, one an operator cannot attribute to anything.
  for (const answer of [undefined, null, 'ok', {}]) {
    const c = limited([HEALTHY_ROW], SEATS, seatPool(SEATS), { reopenSeats: () => answer });
    await tick(c.deps);
    assert.deepEqual(eventsOf(c, 'WATCHDOG_ERROR'), [], `reopenSeats -> ${JSON.stringify(answer) ?? 'undefined'}`);
    assert.deepEqual(eventsOf(c, 'SEAT_REOPENED'), []);
  }
  // A hand-written `"seats": "seat-a"` no longer reaches a tick from soma.json: `loadConfig`
  // refuses a non-array `seats` (`config.mjs` `validated`), and the tick ends at its first line.
  // An INJECTED one still can, and it is not "no seats" — that reading is what sent a dead lead
  // seat-blind past the kill into a spawner that refuses the same value. It is a pool
  // `seats.loadSeats` refuses by name, so the limit-hit lead's close throws before anything is
  // closed or killed, and the phase files that sentence against the lead, once, without ending the tick.
  const typo = ctx({
    cfg: cfgOf({ seats: 'seat-a' }),
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', seat: 'seat-a' })] },
    alive: new Set(['lead-a']),
    capturePane: () => IDLE_FRAME,
    readTail: tail(FIVE_HOUR_ROW),
  });
  await tick(typo.deps);
  const err = oneEvent(typo, 'WATCHDOG_ERROR');
  assert.equal(err.payload.where, 'limits');
  assert.equal(err.lead, 'a');
  assert.match(err.payload.error, /cfg\.seats must be an array, got string/, 'named, so the operator can fix it');
  assert.deepEqual(typo.calls.closeSeat, [], 'and it closes nothing, because there is no readable pool to close in');
  assert.deepEqual(typo.calls.killSession, [], 'nor kills the lead it could not place');
});

// ═══════════════ The revert — ROTATION_FAILED restores the original seat ═══════════════

/**
 * A row out of the limit-row fixture (`FX` above), classifier fields only, re-stamped onto the
 * tick's clock: the revert places rows in time against the ROTATED event, and the fixture's own
 * stamps are three years after `NOW`. The provenance keys (`_source`, `_build`, `_text`) are dropped — a
 * transcript row does not carry them — and `timestamp` is assigned AFTER the copy, because the
 * fixture row carries its own stamp and a copy that ran second would keep it.
 */
const realRow = (path, ms) => {
  const fx = path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), FX);
  if (fx === null || typeof fx !== 'object') throw new Error(`limit-rows.json has no row at ${path}`);
  const out = {};
  for (const [k, v] of Object.entries(fx)) if (!k.startsWith('_')) out[k] = v;
  out.timestamp = new Date(ms).toISOString();
  return out;
};
/** The rotation every fixture below sits after: five minutes before the tick. (`ROT_AT` is the ROTATED-fold guards'.) */
const RV_ROTATED_AT = NOW - 5 * MIN;
/** `~/seat-a` is deliberately unexpanded: the shell never expands inside JSON, `loadSeats` does. (`SEATS` is the limits phase's.) */
const RV_SEATS = [{ config_dir: '~/seat-a', label: 'seat-a' }, { config_dir: '/seats/b', label: 'seat-b' }];
const SEAT_A_DIR = join(homedir(), 'seat-a');
/** The orch stream after `a` was rotated from seat-a onto seat-b, plus whatever a test appends. */
const rotatedStream = (extra = []) => [
  ev('SPAWNED', 'a', NOW - 60 * MIN, { session_uuid: 'u', tmux_target: 'lead-a', cwd: '/w/a' }),
  ev('ROTATED', 'a', RV_ROTATED_AT, { lead: 'a', from: 'seat-a', to: 'seat-b', rateLimitType: 'five_hour', resetsAt: NOW + 3600_000 }),
  ...extra,
];
/** A rotated, live, spawned row: on seat-b, one rotation, one revival attempt already spent. */
const rotatedRow = (over = {}) =>
  row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', seat: 'seat-b', rotations: [RV_ROTATED_AT], attempts: 1, ...over });
/**
 * The harness for one rotated lead. `tail` is what the limits phase's `readTail('u')` answers — the rows the
 * phase hands `classifyLimit` and then this revert. Every pane is alive: a lead that ended its turn
 * on an API error sits at an idle composer (measured), and `rotate()`'s census
 * gate is this revert's too. `extra` layers on top — `alive`, `panes`, a pool, `deps`.
 */
const revertCtx = ({ tail, cfg = cfgOf({ seats: RV_SEATS }), fleet = { tasks: [rotatedRow()] }, orchEvents = rotatedStream(), extra = {} } = {}) => ctx({
  cfg, fleet, orchEvents,
  alive: new Set(fleet.tasks.filter((t) => t.status !== 'queued').map((t) => `lead-${t.id}`)),
  capturePane: () => IDLE_FRAME,
  readTail: (uuid) => ({ rows: uuid === 'u' ? tail : [], bad_lines: 0, transcript: '/t/u.jsonl', uuid }),
  ...extra,
});

test('revert: a non-rate_limit API error on the tick after a rotation kills, resumes under the ORIGINAL seat, then says ROTATION_FAILED', async () => {
  const { tick } = await load('rv1-' + Date.now());
  const c = revertCtx({ tail: [
    realRow('rate_limit.five_hour.0', RV_ROTATED_AT - 10 * MIN),     // what triggered the rotation
    { type: 'user', timestamp: new Date(RV_ROTATED_AT + 15_000).toISOString() },
    realRow('negative.server_error.0', RV_ROTATED_AT + 20_000),       // the resumed lead's first turn
  ] });
  await tick(c.deps);
  // `resumeLead` refuses while `lead-a` exists (remain-on-exit keeps it), so the kill comes first;
  // the event comes last, after the state it describes — the order `rotate()` step 4 uses.
  ranBefore(c.order, 'killSession:lead-a', 'resumeLead:a');
  ranBefore(c.order, 'resumeLead:a', 'event:ROTATION_FAILED');
  assert.deepEqual(c.calls.killSession, ['lead-a']);
  assert.deepEqual(c.calls.resumeLead, ['a']);
  // The dir is loadSeats' RESOLVED dir, never the raw soma.json string: `~/seat-a` is a seat the
  // shell never expanded, and `--resume` into a literal `~` directory is a resume into nothing.
  assert.deepEqual(c.calls.resumeOpts, [{ configDir: SEAT_A_DIR }]);
  const failed = oneEvent(c, 'ROTATION_FAILED');
  assert.equal(failed.lead, 'a', 'the top-level lead field: foldEvents and the inbox read event.lead');
  // The builder's contract: `from` is the seat that rejected the lead, `to` the seat it goes back to.
  assert.deepEqual(failed.payload, { lead: 'a', from: 'seat-b', to: 'seat-a', why: 'server_error' });
});

test('revert: seat goes back through the store; attempts and rotations are untouched; no ROTATED, REVIVED or LEAD_DEAD is said', async () => {
  const { tick } = await load('rv2-' + Date.now());
  const c = revertCtx({ tail: [realRow('rate_limit.five_hour.0', RV_ROTATED_AT - 10 * MIN), realRow('negative.server_error.0', RV_ROTATED_AT + 20_000)] });
  await tick(c.deps);
  // Off `c.store`, which only `updateFleet` reaches: a `task.seat = …` on the tick's own snapshot
  // leaves the checkpoint saying seat-b while the process runs under seat-a, and the next tick
  // reads the row as still rotated and reverts it again.
  assert.equal(c.task().seat, 'seat-a');
  // Revival's counter, and this is not a revival. The row started the tick at 1, so a reset to 0
  // would fail here where a fixture at 0 would have passed a `== 0` check.
  assert.equal(c.task().attempts, 1);
  // The thrash bound counts rotations the fleet CHOSE; the undo of one is not one, and counting
  // it would halve the bound for exactly the seat that needs the retries.
  assert.deepEqual(c.task().rotations, [RV_ROTATED_AT]);
  assert.deepEqual(eventsOf(c, 'ROTATED'), [], 'a revert is not a rotation');
  assert.deepEqual(eventsOf(c, 'REVIVED'), [], 'nor a revival');
  assert.deepEqual(eventsOf(c, 'LEAD_DEAD'), [], 'the lead was alive on its error row, not dead');
  assert.deepEqual(eventsOf(c, 'WATCHDOG_ERROR'), []);
});

test('revert: a rate_limit row after the rotation is never a revert — it is `seat_window` or `unobservable`, never a revert', async () => {
  const { tick } = await load('rv3-' + Date.now());
  // Two real shapes: the 2.1.238+ row with quotaLimits (five_hour → seat_window, the rotation arm) and
  // the ≤2.1.227 row without (`absent` → unobservable, nobody's). The revert's own predicate
  // excludes `error === 'rate_limit'`, so neither can produce a ROTATION_FAILED.
  for (const path of ['rate_limit.five_hour.0', 'rate_limit.absent.0']) {
    const c = revertCtx({ tail: [realRow('rate_limit.five_hour.0', RV_ROTATED_AT - 10 * MIN), realRow(path, RV_ROTATED_AT + 20_000)] });
    await tick(c.deps);
    assert.deepEqual(eventsOf(c, 'ROTATION_FAILED'), [], `${path}: a limit hit on the new seat is a fresh closure, not a failed rotation`);
    assert.equal(c.task().attempts, 1, `${path}: neither arm charges attempts`);
  }
});

test('revert: an API error stamped BEFORE the rotation is not the rotation\'s failure', async () => {
  const { tick } = await load('rv5-' + Date.now());
  // A tail too short to reach the rate_limit row: the newest assistant row is a server_error the
  // OLD process wrote ten minutes before the kill. Placed by its own timestamp against the
  // ROTATED's stamp it lands before it, so nothing here is the resumed lead's doing.
  const c = revertCtx({ tail: [realRow('negative.server_error.0', RV_ROTATED_AT - 10 * MIN)] });
  await tick(c.deps);
  assert.deepEqual(c.calls.killSession, []);
  assert.deepEqual(c.calls.resumeLead, []);
  assert.deepEqual(eventsOf(c, 'ROTATION_FAILED'), []);
  assert.deepEqual(eventsOf(c, 'WATCHDOG_ERROR'), []);
});

test('revert: the pre-rotation rate_limit row is stale for BOTH arms — nothing closes on it, and a fresh limit on the new seat is a fresh closure', async () => {
  const { tick } = await load('rv-stale-' + Date.now());
  // The tick after a rotation: the resumed lead has not written a row yet, so the tail's newest
  // assistant row is the rate_limit that CAUSED the rotation. `classifyLimit` reads no timestamp
  // and answers seat_window again; the stale-row guard places the row against the newest launch
  // (`history.launch.get(id).at`) before acting, so seat-b is not closed and the lead is not
  // rotated a second time on a stale row. Pinned here because the revert's own boundary is the
  // same rule read from the other side.
  const stale = revertCtx({ tail: [realRow('rate_limit.five_hour.0', RV_ROTATED_AT - 10 * MIN)] });
  await tick(stale.deps);
  assert.deepEqual(stale.calls.closeSeat, [], 'seat-b is not closed on the row that closed seat-a');
  assert.deepEqual(stale.calls.killSession, []);
  assert.deepEqual(eventsOf(stale, 'SEAT_CLOSED'), []);
  assert.deepEqual(eventsOf(stale, 'ROTATION_UNAVAILABLE'), []);
  assert.deepEqual(eventsOf(stale, 'ROTATION_FAILED'), []);
  // The control: the same row stamped AFTER the rotation is the new seat's own limit — seat-b
  // closes, and with no open seat in this fixture's pool the lead is told so, once.
  const fresh = revertCtx({ tail: [realRow('rate_limit.five_hour.0', RV_ROTATED_AT + 20_000)] });
  await tick(fresh.deps);
  assert.deepEqual(fresh.calls.closeSeat.map((x) => x[0]), ['/seats/b'], 'a limit hit ON seat-b closes seat-b');
  assert.deepEqual(oneEvent(fresh, 'ROTATION_UNAVAILABLE').payload, { lead: 'a', why: 'no_open_seat' });
  assert.deepEqual(eventsOf(fresh, 'ROTATION_FAILED'), []);
});

test('revert: a rate_limit row reaching the `none` arm is still never a revert — the predicate holds independently of the dispatch', async () => {
  const { tick } = await load('rv3b-' + Date.now());
  // MEASURED, and this test exists because of the measurement: with the real classifier the
  // revert's own `last.error === 'rate_limit'` clause is unreachable — `classifyLimit` answers
  // `none` only when the newest assistant row is NOT a rate_limit row, so severing the clause
  // alone reddens nothing in this file. `classifyLimit` is an injected dep (REQUIRED_DEPS names
  // it), so the fixture puts the one state where the clause matters in front of the revert: a
  // REAL 429 row the verdict arm handed over. Without the clause this is a ROTATION_FAILED on a
  // limit hit — a lead moved back onto a seat that is closed, for hitting a seat that is not.
  const c = revertCtx({
    tail: [realRow('rate_limit.five_hour.0', RV_ROTATED_AT + 20_000)],
    extra: { classifyLimit: () => ({ kind: 'none' }) },
  });
  await tick(c.deps);
  assert.deepEqual(eventsOf(c, 'ROTATION_FAILED'), [], 'a 429 is a limit hit, never a resume the seat rejected');
  assert.deepEqual(c.calls.killSession, [], 'and nothing is killed for it');
});

test('revert: one healthy assistant row after the rotation proves it, and a later API error is then an ordinary error', async () => {
  const { tick } = await load('rv4-' + Date.now());
  const c = revertCtx({ tail: [
    realRow('rate_limit.five_hour.0', RV_ROTATED_AT - 10 * MIN),
    realRow('healthy.0', RV_ROTATED_AT + 30_000),                     // the resumed lead answered: the rotation took
    realRow('negative.server_error.0', RV_ROTATED_AT + 4 * MIN),
  ] });
  await tick(c.deps);
  // The newest assistant row IS an API error, so a literal "newest row" reading reverts here and
  // moves a working lead back onto a seat that is still closed. Spec §3.5 step 5 is "on the next
  // tick": what it judges is whether the rotation produced a turn, and the healthy row is that
  // proof. The 529 after it is what a 529 is on any seat — nobody's rotation failure.
  assert.deepEqual(c.calls.killSession, []);
  assert.deepEqual(c.calls.resumeLead, []);
  assert.deepEqual(eventsOf(c, 'ROTATION_FAILED'), []);
});

test('revert: the newest LAUNCH must be the rotation — a REVIVED or SPAWNED after the ROTATED stands it down', async () => {
  const { tick } = await load('rv6-' + Date.now());
  for (const type of ['REVIVED', 'SPAWNED']) {
    const payload = type === 'REVIVED' ? { plan: 'resume', attempt: 2, session_uuid: 'u' } : { session_uuid: 'u', tmux_target: 'lead-a', cwd: '/w/a' };
    const c = revertCtx({
      orchEvents: rotatedStream([ev(type, 'a', RV_ROTATED_AT + 2 * MIN, payload)]),
      tail: [realRow('rate_limit.five_hour.0', RV_ROTATED_AT - 10 * MIN), realRow('negative.server_error.0', RV_ROTATED_AT + 3 * MIN)],
    });
    await tick(c.deps);
    // `revive()` relaunches through `seatForRevival`, not under the rotation's target, so an error
    // after it says nothing about the seat the rotation chose — and `revivedAt` cannot tell the two
    // apart, because the contract moves it on ROTATED as well. `orchHistory`'s fold keeps the newest
    // of the three launch types per lead; only a ROTATED at the top qualifies.
    assert.deepEqual(c.calls.killSession, [], `${type} newer than the ROTATED: no kill`);
    assert.deepEqual(eventsOf(c, 'ROTATION_FAILED'), [], `${type} newer than the ROTATED: no ROTATION_FAILED`);
  }
});

test('revert: the row must still sit where the rotation put it — a row on another seat stands it down', async () => {
  const { tick } = await load('rv7-' + Date.now());
  const tail = [realRow('rate_limit.five_hour.0', RV_ROTATED_AT - 10 * MIN), realRow('negative.server_error.0', RV_ROTATED_AT + 20_000)];
  const moved = revertCtx({ tail, fleet: { tasks: [rotatedRow({ seat: 'seat-c' })] } });
  await tick(moved.deps);
  assert.deepEqual(moved.calls.killSession, [], 'the ROTATED says seat-b, the row says seat-c: that rotation is not the one this row is living');
  assert.deepEqual(eventsOf(moved, 'ROTATION_FAILED'), []);
  // No `rotations` guard: `writeFleet` prunes the list to the last hour on every publish, so a lead
  // rotated 61 minutes ago reads `rotations: []` and must still be revertable. The launch fold —
  // `launch.type === 'ROTATED' && launch.to === task.seat` — is the whole of the guard.
  const pruned = revertCtx({ tail, fleet: { tasks: [rotatedRow({ rotations: [] })] } });
  await tick(pruned.deps);
  assert.deepEqual(pruned.calls.killSession, ['lead-a'], 'an empty rotations list is a pruned list, not proof of no rotation');
  assert.equal(oneEvent(pruned, 'ROTATION_FAILED').payload.to, 'seat-a');
});

test('revert: a dead pane is revival\'s, never the revert\'s — no kill, no ROTATION_FAILED; revive() relaunches it with its attempt charged', async () => {
  const { tick } = await load('rv-dead-' + Date.now());
  const tail = [realRow('rate_limit.five_hour.0', RV_ROTATED_AT - 10 * MIN), realRow('negative.server_error.0', RV_ROTATED_AT + 20_000)];
  // The session is listed and its pane is dead (`pane_dead=1`): the census reads `dead_pane`, and
  // the revert's gate is rotate()'s — only a pane read as alive is killed. Nothing happens to it here.
  const listed = revertCtx({ tail, extra: { panes: new Map([['lead-a', livePane({ dead: true })]]) } });
  await tick(listed.deps);
  assert.deepEqual(listed.calls.killSession, []);
  assert.deepEqual(listed.calls.resumeLead, []);
  assert.deepEqual(eventsOf(listed, 'ROTATION_FAILED'), []);
  assert.equal(listed.task().attempts, 1);
  // The hand-off: the same dead pane with the session NOT listed alive is a dead lead, and phase 2
  // owns it — revive() charges the attempt and relaunches on the row's own seat (this fixture's
  // pool offers no open seat), and no ROTATION_FAILED is said for it.
  const dead = revertCtx({ tail, extra: { alive: new Set(), panes: new Map([['lead-a', livePane({ dead: true })]]) } });
  await tick(dead.deps);
  assert.deepEqual(eventsOf(dead, 'ROTATION_FAILED'), []);
  assert.deepEqual(dead.calls.resumeOpts, [{ configDir: '/seats/b' }], 'revival relaunches on the seat the row names, not on the revert\'s original');
  assert.equal(dead.task().attempts, 2, 'revival charged its attempt; the revert never charges one');
  assert.equal(oneEvent(dead, 'REVIVED').lead, 'a');
});

test('revert: an original seat no longer in soma.json is refused once per rotation, loudly, and nothing is killed', async () => {
  const { tick } = await load('rv8-' + Date.now());
  const tail = [realRow('rate_limit.five_hour.0', RV_ROTATED_AT - 10 * MIN), realRow('negative.server_error.0', RV_ROTATED_AT + 20_000)];
  const gone = cfgOf({ seats: [{ config_dir: '/seats/b', label: 'seat-b' }] });     // seat-a removed since the rotation
  const first = revertCtx({ tail, cfg: gone });
  await tick(first.deps);
  // Spec §5: bad inputs fail closed for the kill and open for the lead. It stays on seat-b with
  // its error row, and one event says what could not be done and where the lead is. The record is
  // the tick's `fail('revert', sentence, id)`: `where`, the sentence as `error`, the lead on top.
  assert.deepEqual(first.calls.killSession, []);
  assert.deepEqual(first.calls.resumeLead, []);
  assert.deepEqual(eventsOf(first, 'ROTATION_FAILED'), []);
  const err = oneEvent(first, 'WATCHDOG_ERROR');
  assert.equal(err.lead, 'a');
  assert.equal(err.payload.where, 'revert');
  assert.match(err.payload.error, /"seat-a" is not in soma\.json\.seats/);
  // The row stays in this state until someone edits soma.json or the lead, so unguarded this is a
  // line every 30 s. Deduped off the durable log, per rotation: a refusal newer than the ROTATED
  // has been said; one older than it belongs to an earlier rotation and does not count.
  const again = revertCtx({ tail, cfg: gone, orchEvents: rotatedStream([ev('WATCHDOG_ERROR', 'a', RV_ROTATED_AT + 30_000, { where: 'revert', error: 'said' })]) });
  await tick(again.deps);
  assert.deepEqual(eventsOf(again, 'WATCHDOG_ERROR'), []);
  const earlier = revertCtx({ tail, cfg: gone, orchEvents: [ev('WATCHDOG_ERROR', 'a', RV_ROTATED_AT - 30_000, { where: 'revert', error: 'old' }), ...rotatedStream()] });
  await tick(earlier.deps);
  assert.equal(eventsOf(earlier, 'WATCHDOG_ERROR').length, 1, 'a refusal from before this rotation does not silence this one');
});

test('revert: an error row that cannot be placed in time is the third state — refused once, never killed on', async () => {
  const { tick } = await load('rv14-' + Date.now());
  const unplaced = { ...realRow('negative.server_error.0', RV_ROTATED_AT + 20_000), timestamp: 'not-a-time' };
  const c = revertCtx({ tail: [realRow('rate_limit.five_hour.0', RV_ROTATED_AT - 10 * MIN), unplaced] });
  await tick(c.deps);
  // Not "before the rotation" and not "after it": a row with no readable timestamp answers neither,
  // and collapsing it into either would kill on a guess (after) or hide a real failure (before).
  // Every row Claude Code has written since 2.1.220 carries one, so this is the never-observed
  // shape — which is why it is one deduped line rather than a throw.
  assert.deepEqual(c.calls.killSession, []);
  assert.deepEqual(eventsOf(c, 'ROTATION_FAILED'), []);
  assert.match(oneEvent(c, 'WATCHDOG_ERROR').payload.error, /no readable timestamp/);
});

test('revert: a blind event stream reverts nothing, silently, like every other blind decision in the tick', async () => {
  const { tick } = await load('rv9-' + Date.now());
  const c = revertCtx({
    tail: [realRow('rate_limit.five_hour.0', RV_ROTATED_AT - 10 * MIN), realRow('negative.server_error.0', RV_ROTATED_AT + 20_000)],
    extra: { deps: { orchEvents: () => { throw new Error('EACCES reading the event stream'); } } },
  });
  await tick(c.deps);
  // With no readable ROTATED there is no `from` to go back to and no proof this row was rotated at
  // all; the kill is the irreversible half, so it is the half that does not happen. Silent because
  // `orchHistory`'s blind policy is silence: a state root that cannot be read is doctor's finding.
  assert.deepEqual(c.calls.killSession, []);
  assert.deepEqual(c.calls.resumeLead, []);
  assert.deepEqual(eventsOf(c, 'ROTATION_FAILED'), []);
  assert.deepEqual(eventsOf(c, 'WATCHDOG_ERROR'), []);
});

test('revert: a revert is a launch, so admission stands down for the tick', async () => {
  const { tick } = await load('rv10-' + Date.now());
  // A pool with an OPEN seat, so that admission WOULD launch `b` this tick — the default pool
  // offers no seat and would hold `b` for a reason that is not the one under test.
  const pool = seatPool([{ config_dir: SEAT_A_DIR, label: 'seat-a' }, { config_dir: '/seats/b', label: 'seat-b' }]);
  const c = revertCtx({
    tail: [realRow('rate_limit.five_hour.0', RV_ROTATED_AT - 10 * MIN), realRow('negative.server_error.0', RV_ROTATED_AT + 20_000)],
    fleet: { tasks: [rotatedRow(), row({ id: 'b', status: 'queued' })] },
    extra: { ...pool.over },
  });
  await tick(c.deps);
  assert.deepEqual(c.calls.resumeLead, ['a']);
  // The rule `revive()` and `rotate()` already follow: two sessions hitting the API in one second
  // is what `stagger_s` exists to prevent, and a resume cannot re-arm the stagger clock.
  assert.deepEqual(c.calls.spawnLead, [], 'b waits for the next tick');
  assert.equal(c.task('b').status, 'queued');
});

test('revert: a row spawned before seats existed goes back to the frozen default env — configDir undefined, to: null', async () => {
  const { tick } = await load('rv16-' + Date.now());
  const c = revertCtx({
    orchEvents: [ev('ROTATED', 'a', RV_ROTATED_AT, { lead: 'a', from: null, to: 'seat-b', rateLimitType: 'five_hour', resetsAt: NOW + 3600_000 })],
    tail: [realRow('rate_limit.five_hour.0', RV_ROTATED_AT - 10 * MIN), realRow('negative.server_error.0', RV_ROTATED_AT + 20_000)],
  });
  await tick(c.deps);
  // `seat: null` is the contract's word for "the watchdog's own CLAUDE_CONFIG_DIR" (spec §3.6) and
  // `configDir: undefined` is `resumeLead`'s word for the same thing: restoring it is passing
  // nothing, not passing a seat. The builder admits `to: null` for exactly this row.
  assert.deepEqual(c.calls.resumeOpts, [{ configDir: undefined }]);
  assert.equal(oneEvent(c, 'ROTATION_FAILED').payload.to, null);
  assert.equal(c.task().seat, null);
});

test('revert: `why` names the API error kind the resumed lead died on — the four measured negative shapes', async () => {
  const { tick } = await load('rv15-' + Date.now());
  for (const kind of ['server_error', 'authentication_failed', 'invalid_request', 'oauth_org_not_allowed']) {
    const c = revertCtx({ tail: [realRow('rate_limit.five_hour.0', RV_ROTATED_AT - 10 * MIN), realRow(`negative.${kind}.0`, RV_ROTATED_AT + 20_000)] });
    await tick(c.deps);
    assert.equal(oneEvent(c, 'ROTATION_FAILED').payload.why, kind, `${kind}: the orchestrator reads why off the event, not the transcript`);
  }
});

test('revert: the original seat must read LOGGED IN before the kill — rotate()\'s own probe, and its third state', async () => {
  const { tick } = await load('rv17-' + Date.now());
  const tail = [realRow('rate_limit.five_hour.0', RV_ROTATED_AT - 10 * MIN), realRow('negative.server_error.0', RV_ROTATED_AT + 20_000)];
  // `rotate()` step 2 asks this before ITS kill, for the reason `seats.loggedIn` exists: a resume
  // into a dir with no `oauthAccount` loads the session, writes a fake "Not logged in" turn and
  // exits 1 (measured). `seatDirFor` cannot answer it — `loadSeats` reads soma.json alone, so the
  // `unverified` mark state/seats.json carries is invisible to it. Where `rotate()` marks the seat
  // and picks another, a revert has no other seat: the lead stays alive on the one that rejected
  // it, which is strictly better than a kill into a dir that will exit 1.
  for (const [answer, sentence] of [[false, /nobody is logged in to/], [null, /login state of .* could not be read/]]) {
    const c = revertCtx({ tail, extra: { seatLoggedIn: (dir) => (dir === SEAT_A_DIR ? answer : true) } });
    await tick(c.deps);
    assert.deepEqual(c.calls.seatLoggedIn, [SEAT_A_DIR], `${answer}: the dir probed is the one the lead would be resumed into`);
    assert.deepEqual(c.calls.killSession, [], `${answer}: nothing is killed`);
    assert.deepEqual(c.calls.resumeLead, [], `${answer}: and nothing is resumed into a seat that answers no`);
    assert.deepEqual(eventsOf(c, 'ROTATION_FAILED'), [], `${answer}: a revert that did not happen is not announced`);
    const err = oneEvent(c, 'WATCHDOG_ERROR');
    assert.equal(err.payload.where, 'revert', `${answer}: the revert's own channel, not the phase's catch`);
    assert.equal(err.lead, 'a');
    // `null` is could-not-observe and `false` is nobody-is-logged-in: both refuse, and the
    // sentence says which, because the operator's fix differs (repair the file vs claude auth login).
    assert.match(err.payload.error, sentence, `${answer}: the sentence names which of the three answers came back`);
  }
  // `true` is the only answer that proceeds — the control, one dep answer apart from the two above.
  const ok = revertCtx({ tail, extra: { seatLoggedIn: () => true } });
  await tick(ok.deps);
  assert.deepEqual(ok.calls.killSession, ['lead-a']);
  assert.deepEqual(ok.calls.resumeOpts, [{ configDir: SEAT_A_DIR }]);
  // A row spawned before seats existed goes back to the spawner's frozen env: there is no seat to
  // probe, and `seatLoggedIn(undefined)` would be a read of the watchdog's OWN profile.
  const preSeats = revertCtx({
    orchEvents: [ev('ROTATED', 'a', RV_ROTATED_AT, { lead: 'a', from: null, to: 'seat-b', rateLimitType: 'five_hour', resetsAt: NOW + 3600_000 })],
    tail,
    extra: { seatLoggedIn: () => false },
  });
  await tick(preSeats.deps);
  assert.deepEqual(preSeats.calls.seatLoggedIn, [], 'no seat means nothing to probe, not a probe of the default profile');
  assert.deepEqual(preSeats.calls.resumeOpts, [{ configDir: undefined }]);
});

test('revert: a PROOF row that cannot be placed in time is the third state too — the rotation cannot be judged, so nothing is killed', async () => {
  const { tick } = await load('rv18-' + Date.now());
  const rl = realRow('rate_limit.five_hour.0', RV_ROTATED_AT - 10 * MIN);
  const err = realRow('negative.server_error.0', RV_ROTATED_AT + 4 * MIN);
  const unplaced = { ...realRow('healthy.0', RV_ROTATED_AT + 30_000), timestamp: 'not-a-time' };
  const c = revertCtx({ tail: [rl, unplaced, err] });
  await tick(c.deps);
  // rv4's shape with ONE field broken. The lead may well have answered on the new seat — that is
  // exactly what the unreadable row would say if it could be read — and `?? -Infinity` answered
  // "before the rotation" for it, which discards the proof and kills a working lead back onto a
  // seat that is still closed, silently, under a false ROTATION_FAILED. Neither before nor after
  // is a refusal here, as it is for the deciding row.
  assert.deepEqual(c.calls.killSession, [], 'a proof that cannot be read is not a proof that is absent');
  assert.deepEqual(c.calls.resumeLead, []);
  assert.deepEqual(eventsOf(c, 'ROTATION_FAILED'), []);
  const err1 = oneEvent(c, 'WATCHDOG_ERROR');
  assert.equal(err1.payload.where, 'revert');
  assert.equal(err1.lead, 'a');
  // Its own sentence: the deciding row's refusal names "the newest assistant row is an API error",
  // and an operator reading the log has to be able to tell the two rows apart.
  assert.match(err1.payload.error, /healthy assistant row with no readable timestamp/);
  // A READABLE proof still wins over an unreadable one: the rotation is proven, the revert stands
  // down quietly, and no line is spent on a row whose answer no longer matters.
  const proven = revertCtx({ tail: [rl, unplaced, realRow('healthy.0', RV_ROTATED_AT + 60_000), err] });
  await tick(proven.deps);
  assert.deepEqual(proven.calls.killSession, []);
  assert.deepEqual(eventsOf(proven, 'WATCHDOG_ERROR'), [], 'a proven rotation is not an unjudgeable one');
  // And an unplaceable row that is not a proof candidate changes nothing: an API error row with a
  // broken stamp OLDER than the deciding one is neither the proof nor the verdict.
  const past = revertCtx({ tail: [rl, { ...realRow('negative.invalid_request.0', RV_ROTATED_AT - MIN), timestamp: 'not-a-time' }, err] });
  await tick(past.deps);
  assert.deepEqual(past.calls.killSession, ['lead-a'], 'only HEALTHY rows are proof rows; an unplaceable error row is not one');
  assert.equal(oneEvent(past, 'ROTATION_FAILED').payload.why, 'server_error');
});

test('revert: a torn line in the tail is SKIPPED, not dereferenced — the revert still fires and nothing lands in the phase\'s catch', async () => {
  const { tick } = await load('rv19-' + Date.now());
  // `tokens.readTailRows` pushes `null` into `rows` for a kept line `JSON.parse` rejects (the
  // classifier's caller contract), and `classifyLimit` answers `unobservable` only for a non-object
  // NEWER than the last assistant row — a torn line OLDER than it leaves the verdict `none`, which
  // is this arm. MEASURED with the REAL classifier (this fixture overrides no dep):
  //   classifyLimit([rate_limit, null, server_error]) -> {"kind":"none"}
  // With `isAssistant` reduced to `(r) => r.type === 'assistant'` the tick instead files
  // WATCHDOG_ERROR {where:'limits', error:"Cannot read properties of null (reading 'type')"} and
  // kills nothing — a reachable input that silently disables EVERY revert, and before this test
  // the whole suite stayed green for it.
  const c = revertCtx({ tail: [
    realRow('rate_limit.five_hour.0', RV_ROTATED_AT - 10 * MIN),
    null,
    realRow('negative.server_error.0', RV_ROTATED_AT + 20_000),
  ] });
  await tick(c.deps);
  assert.deepEqual(c.calls.killSession, ['lead-a'], 'a torn line is a row the classifier skipped, not a row that stops the revert');
  assert.deepEqual(eventsOf(c, 'WATCHDOG_ERROR'), [], 'and no TypeError reaches the phase\'s per-lead catch');
  assert.equal(oneEvent(c, 'ROTATION_FAILED').payload.to, 'seat-a');
  // A torn line NEWER than the deciding row is the classifier's own `unobservable`, so it never
  // reaches this arm at all — the control that keeps the assertion above honest about WHICH
  // position the guard is exercised at.
  const newer = revertCtx({ tail: [
    realRow('rate_limit.five_hour.0', RV_ROTATED_AT - 10 * MIN),
    realRow('negative.server_error.0', RV_ROTATED_AT + 20_000),
    null,
  ] });
  await tick(newer.deps);
  assert.deepEqual(newer.calls.killSession, [], 'a torn newest line is unobservable: nobody\'s evidence, and never a kill');
  assert.deepEqual(eventsOf(newer, 'ROTATION_FAILED'), []);
});

test('revert: a row field of the wrong TYPE is not a fact — a truthy `isApiErrorMessage` and a numeric `timestamp` are both refused, never believed', async () => {
  const { tick } = await load('rv20-' + Date.now());
  const rl = realRow('rate_limit.five_hour.0', RV_ROTATED_AT - 10 * MIN);
  const stamp = new Date(RV_ROTATED_AT + 20_000).toISOString();
  // `isApiErrorMessage` is a BOOLEAN on every measured row, and the predicate reads `=== true`.
  // Weakened to truthy, a hand-edited or half-written `1` / `"yes"` becomes "this turn ended on an
  // API error" and the lead is killed for it — garbage in the direction that permits the kill.
  // The classifier agrees it is not one: MEASURED `{"kind":"none"}` for this row, so the arm is real.
  const truthy = revertCtx({ tail: [rl, { type: 'assistant', isApiErrorMessage: 1, error: 'server_error', timestamp: stamp, message: { model: '<synthetic>' } }] });
  await tick(truthy.deps);
  assert.deepEqual(truthy.calls.killSession, [], 'a non-boolean is not `true`, and the revert is a kill');
  assert.deepEqual(eventsOf(truthy, 'ROTATION_FAILED'), []);
  assert.deepEqual(eventsOf(truthy, 'WATCHDOG_ERROR'), [], 'and a row that is not an API error is not an unjudgeable one either');
  // `rowAt` reads a STRING or answers the third state. Without the `typeof` clause `Date.parse`
  // coerces its argument and a small number is a plausible YEAR — MEASURED: `Date.parse(3000)` is
  // the year 3000, a thousand years after the rotation, so the row places itself after it and the
  // lead is KILLED on a guess; `Date.parse(2000)` is 946684800000, a dozen years before this test's
  // clock, so the row places itself before it and a real failure is hidden without a word. Both
  // directions of the same collapse, and both are what the third state exists to refuse.
  for (const stamp of [3000, 2000]) {
    const numeric = revertCtx({ tail: [rl, { ...realRow('negative.server_error.0', RV_ROTATED_AT + 20_000), timestamp: stamp }] });
    await tick(numeric.deps);
    assert.deepEqual(numeric.calls.killSession, [], `${stamp}: a number is not a stamp, and an unplaceable row is never killed on`);
    assert.match(oneEvent(numeric, 'WATCHDOG_ERROR').payload.error, /no readable timestamp/, `${stamp}: it is the loud third state, not a silent verdict`);
  }
});

test('revert: a lead with no launch in the window, and a soma.json that lost its seats — one is silent, one is one line, neither throws', async () => {
  const { tick } = await load('rv21-' + Date.now());
  const tail = [realRow('rate_limit.five_hour.0', RV_ROTATED_AT - 10 * MIN), realRow('negative.server_error.0', RV_ROTATED_AT + 20_000)];
  // No SPAWNED, no REVIVED, no ROTATED for this lead: the stream is readable and simply does not
  // reach back that far. `launch === undefined` is "no rotation can be proved", which is the same
  // answer as "the newest launch is not a rotation" — silent, and nothing is killed. Without the
  // clause `launch.type` is a TypeError in the phase's per-lead catch on every tick of a fleet
  // whose orch log has rolled.
  const noLaunch = revertCtx({ tail, orchEvents: [] });
  await tick(noLaunch.deps);
  assert.deepEqual(noLaunch.calls.killSession, []);
  assert.deepEqual(noLaunch.calls.appendEvent, [], 'an unprovable rotation is not an error to report');
  // `seatDirFor` reaches `loadSeats`, which THROWS on a malformed `cfg.seats` — MEASURED:
  // `loadSeats({})` -> TypeError "seats: cfg.seats must be an array, got undefined". A soma.json
  // edited to drop the key AFTER a rotation is an operator error, and the parser's own sentence is
  // the repair instruction; without the try/catch it is instead a WATCHDOG_ERROR {where:'limits'}
  // that names the phase rather than the seat, and the revert's dedupe never sees it.
  const dropped = revertCtx({ tail, cfg: cfgOf() });
  await tick(dropped.deps);
  assert.deepEqual(dropped.calls.killSession, []);
  const err = oneEvent(dropped, 'WATCHDOG_ERROR');
  assert.equal(err.payload.where, 'revert', 'the revert owns the sentence, so the revert\'s once-per-rotation dedupe bounds it');
  assert.equal(err.lead, 'a');
  assert.match(err.payload.error, /cfg\.seats must be an array, got undefined/);
});

test('revert: an API error row that names no kind still says WHY — `api_error`, never an event the builder refuses', async () => {
  const { tick } = await load('rv22-' + Date.now());
  // Every measured negative row carries `error`; this is the shape none of them has. `why` is a
  // required non-empty string on the builder (`ROTATION_FAILED: why must be a non-empty string`),
  // so without the fallback the revert has already killed and resumed the lead when the builder
  // throws — the event is lost, the phase files a WATCHDOG_ERROR {where:'limits'} instead, and the
  // orchestrator is never told the lead moved.
  for (const broken of [{}, { error: '' }, { error: 42 }]) {
    const c = revertCtx({ tail: [
      realRow('rate_limit.five_hour.0', RV_ROTATED_AT - 10 * MIN),
      { type: 'assistant', isApiErrorMessage: true, timestamp: new Date(RV_ROTATED_AT + 20_000).toISOString(), message: { model: '<synthetic>' }, ...broken },
    ] });
    await tick(c.deps);
    assert.deepEqual(c.calls.killSession, ['lead-a'], `${JSON.stringify(broken)}: the row is still an API error`);
    assert.equal(oneEvent(c, 'ROTATION_FAILED').payload.why, 'api_error', `${JSON.stringify(broken)}: the event still says why, generically`);
  }
});

test('revert: the SNAPSHOT carries the restored seat too — a revival in the same tick lands on the original, not on the seat that rejected the lead', async () => {
  const { tick } = await load('rv23-' + Date.now());
  const tail = [realRow('rate_limit.five_hour.0', RV_ROTATED_AT - 10 * MIN), realRow('negative.server_error.0', RV_ROTATED_AT + 20_000)];
  // The one path in which the `task.seat = original` mirror is not merely bookkeeping. The census
  // ran in phase 0, BEFORE the revert's kill, so it reads `lead-a` alive and the revert fires;
  // `aliveSessions()` runs in phase 2, AFTER it, and a resume whose session is not up yet reads as
  // a dead lead that revival owns. `seatForRevival` asks `pickSeat` first and falls back to
  // `seatOfRow(cfg, task)` when no seat is open — the tick's OWN snapshot — so the mirror is what
  // decides whether the same-tick revival goes home or back onto the seat that just rejected it.
  // `recordSession` carries a comment for exactly this reason; this copy had neither one nor a test.
  const c = revertCtx({ tail, extra: { alive: new Set(), panes: new Map([['lead-a', livePane()]]) } });
  await tick(c.deps);
  assert.deepEqual(c.calls.resumeOpts, [{ configDir: SEAT_A_DIR }, { configDir: SEAT_A_DIR }],
    'the revert resumes onto seat-a, and the revival that follows it in the same tick does too');
  assert.equal(oneEvent(c, 'ROTATION_FAILED').payload.to, 'seat-a');
  assert.equal(oneEvent(c, 'REVIVED').lead, 'a', 'the hand-off happened: this is the revival, not a second revert');
  assert.equal(c.task().attempts, 2, 'revival charged its own attempt; the revert charged none');
  // The store is NOT asserted here on purpose: the revival's own `recordSession` rewrites `seat`
  // from `seatForRevival`'s answer, so the row would read `seat-a` whether the revert's write
  // landed or not. rv2 pins that write, against a tick where nothing rewrites it.
});

test('revert: a ROTATION_FAILED dates the process too — a question the KILLED process asked cannot flip the reverted row to blocked', async () => {
  const { tick } = await load('rv24-' + Date.now());
  const rotatedAt = NOW - 150 * MIN;
  const revertedAt = NOW - 140 * MIN;
  const mk = (askedAt) => ctx({
    fleet: { tasks: [row({ id: 'a', status: 'spawned', lead_session_uuid: 'u', updated: NOW - 300 * MIN })] },
    alive: new Set(['lead-a']),
    leadEvents: { a: [ev('NEEDS_INPUT', 'a', askedAt)] },
    orchEvents: [
      ev('ROTATED', 'a', rotatedAt, { lead: 'a', from: 'seat-a', to: 'seat-b', rateLimitType: 'five_hour', resetsAt: NOW + 3600_000 }),
      ev('ROTATION_FAILED', 'a', revertedAt, { lead: 'a', from: 'seat-b', to: 'seat-a', why: 'server_error' }),
    ],
  });
  // A revert is a kill and a `--resume`, the same "a NEW process for the same row without changing
  // its status" the REVIVED and ROTATED arms are folded for — so `revivedAt` has to move for it
  // too. The question here was asked AFTER the rotation and BEFORE the revert, so the ROTATED
  // cannot answer it: only the ROTATION_FAILED can, and before it joined the fold
  // `releaseBlockedSlot` flipped a lead that is alive and working to `blocked` on a question the
  // process it replaced had asked — and a `blocked` row frees its admission slot.
  const before = mk(revertedAt - MIN);
  await tick(before.deps);
  assert.equal(before.task().status, 'spawned', 'the killed process\'s question is not the resumed process\'s');
  assert.deepEqual(eventsOf(before, 'BLOCKED'), []);
  // The control, one minute the other side of the revert: a question the RESTORED process asked
  // still decides the row, exactly as it does after a revival or a rotation.
  const after = mk(revertedAt + MIN);
  await tick(after.deps);
  assert.equal(after.task().status, 'blocked');
  assert.equal(oneEvent(after, 'BLOCKED').payload.asked_at, revertedAt + MIN);
});

test('revert: a ROTATION_FAILED in the log retires the rotation — a lost row write no longer means a kill and a resume every tick', async () => {
  const { tick } = await load('rv25-' + Date.now());
  const tail = [realRow('rate_limit.five_hour.0', RV_ROTATED_AT - 10 * MIN), realRow('negative.server_error.0', RV_ROTATED_AT + 20_000)];
  // The unretired rotation, as the control: this is rv1's fixture and the arm fires.
  const fresh = revertCtx({ tail });
  await tick(fresh.deps);
  assert.deepEqual(fresh.calls.killSession, ['lead-a'], 'a rotation with no revert in the log is revertable');
  // The same tick one revert later, with the revert's `updateFleet` write LOST — it threw, or the
  // checkpoint was clobbered — so the row still names the seat that rejected the lead and the tail
  // still ends on the same error row (the resumed process has written nothing yet). Measured
  // before ROTATION_FAILED joined the launch fold: the revert fired AGAIN, and again on every tick
  // after it, with no dedupe — the event already in the log was consulted by nothing.
  const lost = revertCtx({ tail, orchEvents: rotatedStream([ev('ROTATION_FAILED', 'a', RV_ROTATED_AT + MIN, { lead: 'a', from: 'seat-b', to: 'seat-a', why: 'server_error' })]) });
  await tick(lost.deps);
  assert.deepEqual(lost.calls.killSession, [], 'the durable log is the brake the row write could not be');
  assert.deepEqual(lost.calls.resumeLead, []);
  assert.deepEqual(eventsOf(lost, 'ROTATION_FAILED'), [], 'and a revert that did not happen is not announced a second time');
  // The row write is still the OTHER brake, and the two are independent: the event may be the one
  // that was lost (it is written last, after the row), and the row alone still stands it down.
  const written = revertCtx({ tail, fleet: { tasks: [rotatedRow({ seat: 'seat-a' })] } });
  await tick(written.deps);
  assert.deepEqual(written.calls.killSession, [], 'either brake alone is enough; neither is the single point of failure');
});

test('revert: a ROTATION_FAILED at the top of the launch fold is not a rotation to undo — the revert never runs BACKWARDS onto the seat that just rejected the lead', async () => {
  const { tick } = await load('rv26-' + Date.now());
  const REVERTED_AT = RV_ROTATED_AT + MIN;
  // The ordinary steady state one revert later, and the one rv25 does NOT cover: rotated a→b,
  // seat-b rejected it, the revert put the row back on seat-a and the write LANDED (rv25's third
  // case is the write that did not). The lead then fails again, freshly, on the seat it came home
  // to — a 529 on seat-a a minute after the revert is nobody's rotation failure, and there is no
  // rotation left to undo.
  const tail = [realRow('rate_limit.five_hour.0', RV_ROTATED_AT - 10 * MIN), realRow('negative.server_error.0', REVERTED_AT + 20_000)];
  const seeded = (type, extraPayload) => revertCtx({
    tail,
    fleet: { tasks: [rotatedRow({ seat: 'seat-a' })] },
    orchEvents: rotatedStream([ev(type, 'a', REVERTED_AT, { lead: 'a', from: 'seat-b', to: 'seat-a', ...extraPayload })]),
  });
  const home = seeded('ROTATION_FAILED', { why: 'server_error' });
  await tick(home.deps);
  // `launch.to !== task.seat` CANNOT catch this one, which is what makes the type test load-bearing
  // rather than belt-and-braces. A REVIVED or SPAWNED newer than the ROTATED is caught downstream
  // by that guard (rv6) because neither payload carries a `to` at all; a ROTATION_FAILED's `to` is
  // the seat the lead went BACK to, so after a landed row write it *is* `task.seat` and the guard
  // passes. Since the revert joined the launch fold, `launch.type !== 'ROTATED'` is the only thing
  // left between this tail and a kill — and what it stops is a revert running backwards: seat-a's
  // fresh error read as seat-a's rejection, and the lead pushed onto seat-b, the seat that
  // rejected it sixty seconds ago. Worse, the ROTATION_FAILED that would announce it folds into
  // `launch` in its turn, with `to` once more equal to the row's seat, so the next tick reads it
  // the same way and the lead ping-pongs every 30 s with nothing to dedupe it.
  assert.deepEqual(home.calls.killSession, [], 'a revert is not a rotation: there is nothing left to undo, so nothing is killed');
  assert.deepEqual(home.calls.resumeLead, [], 'and nothing is resumed back onto the seat the revert just brought the lead home from');
  assert.deepEqual(home.calls.resumeOpts, [], 'not with the wrong dir and not with the right one: the resume does not happen at all');
  assert.deepEqual(eventsOf(home, 'ROTATION_FAILED'), [], 'no second ROTATION_FAILED — and this one would have inverted the truth, naming seat-a as the seat that rejected the lead');
  assert.equal(home.task().seat, 'seat-a', 'the row stays where the revert left it');
  assert.deepEqual(eventsOf(home, 'WATCHDOG_ERROR'), [], 'a launch that is not a rotation is a silent stand-down, not a line in the log every tick');
  // The control, ONE EVENT TYPE apart and identical in every other byte: had the same stamp
  // carried a second ROTATED — seat-b rotating the lead onto seat-a — the newest launch would be
  // a rotation the row really is living, and this same tail reverts it. So the tail, the row, the
  // pane, the census gate and the seat lookup are all live in the case above; the type is the only
  // thing standing it down.
  const rotated = seeded('ROTATED', { rateLimitType: 'five_hour', resetsAt: NOW + 3600_000 });
  await tick(rotated.deps);
  assert.deepEqual(rotated.calls.killSession, ['lead-a'], 'the same fixture with a ROTATED at the top of the fold DOES revert');
  assert.deepEqual(rotated.calls.resumeOpts, [{ configDir: '/seats/b' }], 'onto the seat that rotation came from');
  // The same three effects the severed clause produces above — and here they are TRUE: seat-a is
  // the seat that rejected the lead, seat-b is where it came from. Byte for byte the same payload,
  // a fact in this tick and a lie in the one before it.
  assert.deepEqual(oneEvent(rotated, 'ROTATION_FAILED').payload, { lead: 'a', from: 'seat-a', to: 'seat-b', why: 'server_error' });
});
