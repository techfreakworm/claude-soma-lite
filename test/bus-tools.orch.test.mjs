import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { rotated, seatClosed } from '../bin/lib/wd/rotation-events.mjs';
import * as fleetMod from '../bin/lib/fleet.mjs';

/**
 * The orchestrator + candidate halves of the bus.
 *
 * `ctx()` below is the original fixture, kept verbatim for the four pinned spec
 * tests. Everything after them uses `orch()`, whose stubs *behave like the real
 * modules* — `acquireLease` refuses a held lease unless forced and reports
 * `stolen_from`, `setTaskStatus` stamps `last_spawn_at` on a genuine transition,
 * `updateFleet` hands out the one live snapshot its nested callers share,
 * `sendKeys` reports whether the target existed. A stub that merely records is a
 * stub that cannot fail, and every defect this file pins is a defect about what
 * happens when a dep says no.
 */

function ctx(overrides = {}) {
  const state = { queued: [], statuses: {}, lease: null, cursor: null };
  return {
    env: { SOMA_ROLE: 'orchestrator', SOMA_SESSION_ID: 'S1', SOMA_TMUX_PANE: '%1' },
    deps: {
      enqueue: (tasks) => { const q = tasks.map((t) => t.id); state.queued.push(...q); return { queued: q }; },
      readFleet: () => ({ tasks: state.queued.map((id) => ({ id, status: state.statuses[id] || 'queued' })), last_spawn_at: null }),
      acquireLease: (claim, opts) => { state.lease = claim; return { ok: true, lease_seq: 1 }; },
      // ⚠ ADDED — this fixture had no `readLease`, and `realDeps()` in `soma-bus.mjs` has
      // always wired one (`startingRole` reads it at startup). Its absence here meant the
      // fixture could write a lease and never read one back, which is exactly the state in
      // which "does the caller still hold it?" is unanswerable — and the four pinned spec tests
      // ran for the whole build without that question being asked once.
      readLease: () => state.lease,
      releaseLease: () => ({ released: true }),
      unread: () => [{ id: '1', type: 'COMPLETED', lead: 'cr-1', payload: {} }],
      writeCursor: (c, id) => { state.cursor = id; },
      spawnLead: (t) => ({ lead: t.id, session_uuid: 'u', tmux_target: `lead-${t.id}`, cwd: '/w' }),
      hasSession: () => true, killSession: () => {}, setTaskStatus: (id, s) => { state.statuses[id] = s; },
      readUsage: () => ({ est_tokens: 1000, turns: 3, last_model: 'claude-fable-5' }),
      ...overrides,
    },
    _state: state,
  };
}

let loads = 0;
/** A fresh module instance per case — `orchTools` closes over a heartbeat clock. */
const load = () => import('../bin/lib/bus-tools.mjs?' + `o${++loads}`);

/** When the fixture's rows were last written. The mail below is newer. */
const T0 = Date.now() - 60_000;

/** A task row with every field `fleet.enqueue` writes, so nothing reads undefined. */
const rowsOf = (tasks) => tasks.map((t) => ({
  id: t.id, title: null, repo: 'r', source: {}, brief: 'b', status: 'queued', base_branch: null,
  budget_class: null, budget_override: null, lead_session_uuid: null, tmux_session: null, attempts: 0, base_sha: null, seat: null, rotations: [],
  launching_at: null, created: T0, updated: T0, ...t,
}));

/**
 * The same fixture with the named keys taken back OFF the rows — the shape every row on a
 * fleet that predates seats actually has: the key ABSENT, not `null` or `[]`.
 *
 * `rowsOf` writes `seat: null, rotations: []` because that is what today's `fleet.enqueue`
 * writes, and that is right for every other test here. But the `Array.isArray(rotations) ? … : 0`
 * and `cut(undefined, 32)` branches of `statusRow` exist for rows that have neither key — every
 * row on a fleet that predates seats — and a fixture that always supplies them cannot reach
 * either branch. Throws rather than deleting nothing when the key is
 * already absent: the first version of the "no rotations" test was handed `rotations: []` by this
 * very fixture and silently stopped exercising the branch its name claims, so the drift has to
 * be loud in BOTH directions.
 */
const withoutKeys = (c, ...keys) => {
  for (const t of c.s.fleet.tasks) {
    for (const k of keys) {
      if (!(k in t)) throw new Error(`withoutKeys: the fixture row has no "${k}" to remove — this test means to exercise the absent-key branch and no longer does`);
      delete t[k];
    }
  }
  return c;
};

const STALE_MS = 10 * 60 * 1000;

function orch(opts = {}) {
  const s = {
    fleet: { tasks: rowsOf(opts.tasks ?? []), last_spawn_at: null },
    // ⚠ **HELD BY S1 BY DEFAULT, AND THAT IS THE FAITHFUL FIXTURE.** `orchTools` is only
    // ever reachable in production by a session the lease names — `startingRole` reads the
    // lease at startup, and the only other way in is a successful `soma_adopt`. A fixture
    // with the orchestrator role and NO lease is an impossible state, and it is what let
    // eleven of the twelve tools ship without ever comparing the caller to the holder:
    // every one of those handlers was driven by a session that held nothing.
    // Pass `lease: null` explicitly for the free-lease cases; pass a foreign holder to
    // drive the demoted path.
    lease: 'lease' in opts ? opts.lease : liveLease({ session_id: 'S1' }),
    panes: new Set(opts.panes ?? ['%1']),
    // The bus's own tmux server, by the socket path `$TMUX` spells first. The orchestrator's
    // default `$TMUX` (below) names it: unless a test says otherwise, the session sits in a
    // pane on soma's server, which is the only place a keystroke wake can be proven to reach.
    server: SOMA_SERVER,
    sessions: new Set(opts.sessions ?? []),
    events: (opts.events ?? []).map((e, i) => {
      const ts = T0 + 1000 + i;
      return { id: `${ts}-${String(i).padStart(4, '0')}`, ts, type: 'MILESTONE', lead: 'cr-1', payload: {}, ...e };
    }),
    cursors: {}, keys: [], killed: [], beats: [], beatOpts: [], spawns: [], resumes: [], appended: [], updates: 0,
    queuePaused: false,
    config: opts.config ?? { max_leads: 10, repos: {}, budgets: { standard: { tokens_cap: 1000 } } },
    usage: opts.usage ?? { est_tokens: 500, turns: 3, last_model: 'claude-fable-5' },
  };
  const deps = {
    // lease.heartbeat: stamps only the holder's own record, silently otherwise.
    // `opts` is recorded, not ignored: the pane travels with the stamp (see lease.heartbeat),
    // and a stub that dropped it would let the wiring rot while the repair stayed tested.
    heartbeat: (sid, opts) => { s.beats.push(sid); s.beatOpts.push(opts); if (s.lease?.session_id === sid) s.lease.heartbeat_at = Date.now(); },
    readLease: () => s.lease,
    // lease.leaseStale, transcribed: a recorded pane that is gone is stale, and so
    // is a heartbeat older than ten minutes even for a live tmux holder.
    leaseStale: (l, hasPane) => !l || (!!l.tmux_pane && !hasPane(l.tmux_pane))
      || !(Number.isFinite(l.heartbeat_at) && Date.now() - l.heartbeat_at <= STALE_MS),
    hasPane: (p) => s.panes.has(p),
    // soma-bus.paneOnServer, transcribed (issue #2): proven only when the pane exists on the bus's
    // server AND the session's `$TMUX` names that server in its first comma field. Pane ids are
    // small per-server counters, so existence alone proves nothing: the operator's own `%1` is
    // "present" on soma's server whenever soma also has a `%1`.
    paneOnServer: (pane, tmuxVar) => typeof pane === 'string' && s.panes.has(pane)
      && typeof tmuxVar === 'string' && tmuxVar.split(',')[0] === s.server,
    acquireLease: (claim, { force = false } = {}) => {
      if (s.lease && !force) return { ok: false, holder: s.lease };
      const prev = s.lease;
      s.lease = { ...claim, lease_seq: (prev?.lease_seq ?? 0) + 1, heartbeat_at: Date.now() };
      return { ok: true, degraded: claim.wake !== 'tmux', lease_seq: s.lease.lease_seq, stolen_from: prev ?? null };
    },
    releaseLease: (sid) => { if (s.lease?.session_id !== sid) return { released: false }; s.lease = null; return { released: true }; },
    // A copy, like the real readFleet: a handler that mutates what it read and
    // expects the change to stick must fail here.
    readFleet: () => structuredClone(s.fleet),
    updateFleet: (mutate) => { s.updates += 1; return mutate(s.fleet); },
    setTaskStatus: (id, st) => {
      const t = s.fleet.tasks.find((x) => x.id === id);
      if (!t) throw new Error(`setTaskStatus: unknown task "${id}"`);
      const was = t.status;
      t.status = st; t.updated = Date.now();
      if (st === 'spawned' && was !== 'spawned') s.fleet.last_spawn_at = t.updated;
    },
    enqueue: (tasks) => {
      const queued = [];
      for (const t of tasks) { s.fleet.tasks.push(rowsOf([t])[0]); queued.push(t.id); }
      return { queued, skipped: [] };
    },
    admit: (f, cfg) => {
      if (!Number.isInteger(cfg?.max_leads)) throw new TypeError('admit: cfg.max_leads must be a non-negative integer');
      if (f.tasks.filter((t) => t.status === 'spawned').length >= cfg.max_leads) return null;
      return f.tasks.find((t) => t.status === 'queued')?.id ?? null;
    },
    // The real predicate, as `soma-bus.mjs` wires it: the one the watchdog's reconcile and `soma status`
    // read too, so a transcription here could agree with itself and disagree with them.
    launching: fleetMod.launching,
    loadConfig: () => s.config,
    unread: (consumer, streams) => s.events
      .filter((e) => streams.includes(e.lead ?? 'orch'))
      .filter((e) => !s.cursors[consumer] || e.id > s.cursors[consumer]),
    writeCursor: (c, id) => { s.cursors[c] = id; },
    eventStreams: () => [...s.fleet.tasks.map((t) => t.id), 'orch'],
    appendEvent: (stream, e) => { s.appended.push({ stream, ...e }); return { id: 'e1', ts: 1 }; },
    sendKeys: (target, line) => { s.keys.push({ target, line }); return s.panes.has(target) || s.sessions.has(target); },
    hasSession: (name) => s.sessions.has(name),
    killSession: (name) => { const had = s.sessions.has(name); s.sessions.delete(name); s.killed.push(name); return had; },
    listPanes: (session) => [{ index: 0, dead: false, title: `claude ${session}` }, { index: 1, dead: true, title: 'teammate-1' }],
    spawnLead: (t) => { s.spawns.push(t.id); s.sessions.add(`lead-${t.id}`); return { lead: t.id, session_uuid: `u-${t.id}`, tmux_target: `lead-${t.id}`, cwd: `/w/${t.id}` }; },
    resumeLead: (t) => { s.resumes.push(t.id); s.sessions.add(`lead-${t.id}`); return { lead: t.id, session_uuid: t.lead_session_uuid }; },
    readUsage: () => s.usage,
    heartbeatAgeMs: () => 1234,
    setQueuePaused: (v) => { s.queuePaused = v; },
    queuePaused: () => s.queuePaused,
    backpressureState: () => ({ active: false }),
    // seats-summary.seatsSummary: no seats configured is the faithful default for a fixture
    // that never mentions seats; the seat tests hand over their own.
    seatsSummary: () => ({ configured: 0, open: [], closed: [], unverified: [], unreadable: false, why: null }),
    tailLog: (lead, n) => `${lead}:${n}`,
    buildDigest: () => ({ path: '/d/today.md', done: 1 }),
    // harness.validateHarnessReport, in shape: it takes the lead's spelling
    // ("H2 — the suite already runs") and answers with the registry's canonical pair. H1 and H4
    // are here for the documented H1 -> H4 degrade, the supersede the fold has to follow.
    validateHarnessReport: (p) => {
      const n = /^h([124])\b/i.exec(String(p?.harness_id))?.[1];
      return n === undefined
        ? { ok: false, error: 'unknown harness_id' }
        : { ok: true, harness_id: `H${n}`, budget_class: { 1: 'standard', 2: 'iterate', 4: 'review' }[n] };
    },
    ...(opts.deps ?? {}),
  };
  return { env: { SOMA_ROLE: 'orchestrator', SOMA_SESSION_ID: 'S1', SOMA_TMUX_PANE: '%1', TMUX: SOMA_TMUX, ...(opts.env ?? {}) }, deps, s };
}

/** soma's tmux server as `#{socket_path}` names it, and `$TMUX` for a pane on it. */
const SOMA_SERVER = '/tmp/tmux-1000/soma';
const SOMA_TMUX = `${SOMA_SERVER},4242,0`;
/** `$TMUX` in the operator's everyday tmux: the default server, not soma's. */
const OWN_TMUX = '/tmp/tmux-1000/default,999,0';

/** A live tmux holder: pane present, heartbeat fresh. */
const liveLease = (over = {}) => ({ session_id: 'S0', tmux_socket: 'soma', tmux_pane: '%1', wake: 'tmux', lease_seq: 7, heartbeat_at: Date.now(), ...over });

/** Let a floating rejection reach the process before the test ends. */
const drain = () => new Promise((resolve) => setImmediate(resolve));

const ORCH_TOOLS = ['soma_adopt', 'soma_release', 'soma_enqueue', 'soma_queue', 'soma_spawn', 'soma_status',
  'soma_inbox', 'soma_send', 'soma_kill', 'soma_resume', 'soma_transcript', 'soma_digest'];

// ---------------------------------------------------------------------------
// The original spec tests, verbatim.
// ---------------------------------------------------------------------------

test('soma_adopt records the lease and reports unread count', async () => {
  const bt = await import('../bin/lib/bus-tools.mjs?' + Date.now());
  const c = ctx();
  const r = await bt.orchTools(c).get('soma_adopt')({});
  assert.equal(r.adopted, true);
  assert.equal(c._state.lease.session_id, 'S1');
});

test('soma_enqueue then soma_status reflects queued tasks', async () => {
  const bt = await import('../bin/lib/bus-tools.mjs?' + Date.now());
  const c = ctx();
  // The adopt is not scenery. Since the holder gate landed, every mutating tool refuses a caller
  // that does not hold the lease, so "enqueue then status" is only reachable through the sequence
  // a real orchestrator actually performs. `soma_status` is a reader and stays open.
  await bt.orchTools(c).get('soma_adopt')({});
  await bt.orchTools(c).get('soma_enqueue')({ tasks: [{ id: 'cr-1', title: 't', repo: 'r', source: {}, brief: 'b' }] });
  const s = await bt.orchTools(c).get('soma_status')({});
  assert.equal(s.leads.length + s.queue.length >= 1, true);
});

test('soma_inbox marks read by writing the newest cursor', async () => {
  const bt = await import('../bin/lib/bus-tools.mjs?' + Date.now());
  const c = ctx();
  // soma_inbox folds terminal statuses onto task rows and advances a role-keyed cursor,
  // so it is a writer and is gated on the lease like every other writer. Adopt first.
  await bt.orchTools(c).get('soma_adopt')({});
  const r = await bt.orchTools(c).get('soma_inbox')({});
  assert.equal(r.events.length, 1);
  assert.equal(c._state.cursor, '1');
});

test('candidate role exposes only adopt + read-only status', async () => {
  const bt = await import('../bin/lib/bus-tools.mjs?' + Date.now());
  const names = [...bt.candidateTools(ctx()).keys()].sort();
  assert.deepEqual(names, ['soma_adopt', 'soma_status']);
});

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

test('the orchestrator is handed exactly the twelve tools the design names', async () => {
  const bt = await load();
  const tools = bt.orchTools(orch());
  assert.deepEqual([...tools.keys()].sort(), [...ORCH_TOOLS].sort());
  for (const [name, fn] of tools) {
    assert.equal(typeof fn, 'function', name);
    assert.equal(fn.constructor.name, 'AsyncFunction', name);
  }
});

test('every handler survives being called with nothing, and answers with JSON', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1' }] });
  for (const [name, fn] of bt.orchTools(c)) {
    for (const args of [undefined, null, {}, 'nonsense', 7]) {
      const r = await fn(args);
      assert.equal(typeof r, 'object', `${name} ${JSON.stringify(args)}`);
      assert.doesNotThrow(() => JSON.stringify(r), `${name} must be serializable`);
    }
  }
});

test('the candidate map shares the orchestrator handlers, and hides the other ten', async () => {
  const bt = await load();
  const c = orch();
  const cand = bt.candidateTools(c);
  assert.deepEqual([...cand.keys()], ['soma_adopt', 'soma_status']);
  for (const name of ORCH_TOOLS) {
    if (name === 'soma_adopt' || name === 'soma_status') assert.equal(typeof cand.get(name), 'function');
    else assert.equal(cand.get(name), undefined, `${name} must not reach a candidate`);
  }
  // and the read-only one really is read-only
  await cand.get('soma_status')({});
  assert.equal(c.s.updates, 0);
  assert.equal(c.s.spawns.length, 0);
});

// ---------------------------------------------------------------------------
// The heartbeat — the lease carry: a live-but-idle orchestrator must not become
// silently stealable, and the stamp is holder-keyed so nothing else can do it.
// ---------------------------------------------------------------------------

/** A lease this session holds, with a stamp old enough to need refreshing. */
const heldLease = (ageMs = 5 * 60 * 1000) => liveLease({ session_id: 'S1', heartbeat_at: Date.now() - ageMs });

test('every orchestrator tool call heartbeats the lease', async () => {
  const bt = await load();
  for (const name of ORCH_TOOLS) {
    const c = orch({ tasks: [{ id: 'cr-1' }], lease: heldLease() });
    await bt.orchTools(c).get(name)({ task_id: 'cr-1', lead: 'cr-1', tasks: [], action: 'status', message: 'hi' });
    assert.deepEqual(c.s.beats, ['S1'], `${name} did not heartbeat`);
  }
});

test('a call inside the minute costs no lease write; one past it costs exactly one', async () => {
  const bt = await load();
  const fresh = orch({ lease: liveLease({ session_id: 'S1' }) });
  const tools = bt.orchTools(fresh);
  for (let i = 0; i < 25; i += 1) await tools.get('soma_status')({});
  assert.deepEqual(fresh.s.beats, [], 'a fresh stamp needs no rewrite');

  const stale = orch({ lease: heldLease() });
  const t2 = bt.orchTools(stale);
  for (let i = 0; i < 25; i += 1) await t2.get('soma_status')({});
  assert.deepEqual(stale.s.beats, ['S1'], 'stamped once, then floored by its own new stamp');
});

test('a session that does not hold the lease never reaches for the fleet lock', async () => {
  const bt = await load();
  for (const lease of [null, liveLease({ session_id: 'S-other' })]) {
    const c = orch({ lease });
    await bt.candidateTools(c).get('soma_status')({});
    await bt.orchTools(c).get('soma_status')({});
    assert.deepEqual(c.s.beats, [], 'heartbeat would no-op anyway; the lock is the cost');
  }
});

test('a heartbeat that fails is retried by the next call and never fails the call', async () => {
  const bt = await load();
  let calls = 0;
  const c = orch({ lease: heldLease(), deps: { heartbeat: () => { calls += 1; throw new Error('fleet.lock: still held by pid 42 in /Users/x/.soma/state'); } } });
  const tools = bt.orchTools(c);
  const a = await tools.get('soma_status')({});
  const b = await tools.get('soma_status')({});
  assert.equal(calls, 2, 'a failed stamp leaves the lease stale, so the next call tries again');
  assert.ok(Array.isArray(a.leads) && Array.isArray(b.leads));
  assert.ok(!JSON.stringify([a, b]).includes('.soma'));
});

test('the heartbeat runs before the tool does its work, and only for a named session', async () => {
  const bt = await load();
  const order = [];
  const c = orch({ lease: heldLease(), deps: { heartbeat: () => order.push('beat'), readFleet: () => { order.push('work'); return { tasks: [], last_spawn_at: null }; } } });
  await bt.orchTools(c).get('soma_status')({});
  assert.deepEqual(order, ['beat', 'work']);

  const anon = orch({ lease: heldLease(), env: { SOMA_SESSION_ID: '' } });
  await bt.orchTools(anon).get('soma_status')({});
  assert.deepEqual(anon.s.beats, []);
});

// ---------------------------------------------------------------------------
// soma_adopt
// ---------------------------------------------------------------------------

test('adopt grants freely when the recorded pane is gone, with no force from the caller', async () => {
  const bt = await load();
  const seen = [];
  const c = orch({
    lease: liveLease({ tmux_pane: '%99' }),      // a pane that no longer exists
    panes: ['%1'],
    deps: { acquireLease: (claim, opts) => { seen.push(opts); return { ok: true, lease_seq: 9, stolen_from: null }; } },
  });
  const r = await bt.orchTools(c).get('soma_adopt')({});
  assert.equal(r.adopted, true);
  assert.equal(r.forced, true, 'staleness must be folded into force');
  assert.deepEqual(seen, [{ force: true }]);
});

test('adopt grants freely past a ten-minute heartbeat, even for a holder with a live pane', async () => {
  const bt = await load();
  const c = orch({ lease: liveLease({ heartbeat_at: Date.now() - STALE_MS - 1000 }) });
  const r = await bt.orchTools(c).get('soma_adopt')({});
  assert.equal(r.adopted, true);
  assert.equal(c.s.lease.session_id, 'S1');
});

test('adopt refuses a live holder, and the refusal is what proves it is live', async () => {
  const bt = await load();
  const c = orch({ lease: liveLease() });
  const r = await bt.orchTools(c).get('soma_adopt')({});
  assert.equal(r.adopted, false);
  assert.equal(r.holder_live, true);
  assert.equal(r.holder.session_id, 'S0');
  assert.equal(r.holder.lease_seq, 7);
  assert.ok(Number.isInteger(r.holder.heartbeat_age_ms));
  assert.match(r.error, /force/);
  assert.equal(c.s.lease.session_id, 'S0', 'the holder must be untouched');
});

test('a refusal that could not check liveness says so instead of claiming it', async () => {
  const bt = await load();
  const c = orch({ lease: liveLease(), deps: { leaseStale: undefined } });
  const r = await bt.orchTools(c).get('soma_adopt')({});
  assert.equal(r.adopted, false);
  assert.equal(r.holder_live, null);
  assert.match(r.error, /does not prove/i);
});

test('force:true from the operator steals a live lease', async () => {
  const bt = await load();
  const c = orch({ lease: liveLease() });
  const r = await bt.orchTools(c).get('soma_adopt')({ force: true });
  assert.equal(r.adopted, true);
  assert.equal(r.stolen_from.session_id, 'S0');
  assert.equal(c.s.lease.session_id, 'S1');
});

test('the claim names the soma tmux server whenever it asks for pane wakes', async () => {
  const bt = await load();
  const c = orch();
  await bt.orchTools(c).get('soma_adopt')({});
  assert.equal(c.s.lease.wake, 'tmux');
  assert.equal(c.s.lease.tmux_socket, 'soma');
  assert.equal(c.s.lease.tmux_pane, '%1');
});

test('a session with no pane claims notify wake and is told its wake is degraded', async () => {
  const bt = await load();
  const c = orch({ env: { SOMA_TMUX_PANE: '' } });
  const r = await bt.orchTools(c).get('soma_adopt')({});
  assert.equal(r.adopted, true);
  assert.equal(r.wake, 'notify');
  assert.equal(r.degraded_wake, true);
  assert.equal(c.s.lease.tmux_socket, null);
});

test('the DEMOTED notice goes to the holder the grant displaced, not to whoever holds it now', async () => {
  const bt = await load();
  let reads = 0;
  const displaced = liveLease({ session_id: 'S-old', tmux_pane: '%old' });
  const c = orch({
    lease: displaced,
    panes: ['%1', '%old'],
    deps: {
      // A second read outside the lock can already name a third session.
      readLease: () => { reads += 1; return reads === 1 ? displaced : liveLease({ session_id: 'S-third', tmux_pane: '%third' }); },
      acquireLease: () => ({ ok: true, lease_seq: 8, stolen_from: displaced }),
    },
  });
  const r = await bt.orchTools(c).get('soma_adopt')({ force: true });
  assert.equal(r.adopted, true);
  assert.equal(r.demoted_notice.sent, true);
  assert.equal(c.s.keys.length, 1);
  assert.equal(c.s.keys[0].target, '%old');
  assert.match(c.s.keys[0].line, /DEMOTED/);
  assert.match(c.s.keys[0].line, /soma_adopt/);
});

test('a displaced holder with no pane, or on another tmux server, is not typed at', async () => {
  const bt = await load();
  for (const [stolen, why] of [
    [liveLease({ tmux_pane: null, wake: 'notify' }), /pane/i],
    [liveLease({ tmux_socket: 'someone-elses' }), /server/i],
  ]) {
    const c = orch({ lease: stolen, deps: { acquireLease: () => ({ ok: true, lease_seq: 2, stolen_from: stolen }) } });
    const r = await bt.orchTools(c).get('soma_adopt')({ force: true });
    assert.equal(r.adopted, true);
    assert.equal(r.demoted_notice.sent, false);
    assert.match(r.demoted_notice.reason, why);
    assert.deepEqual(c.s.keys, []);
  }
});

test('a first adopt with nobody displaced types nothing at anybody, and is not a steal', async () => {
  const bt = await load();
  const c = orch();
  const r = await bt.orchTools(c).get('soma_adopt')({});
  assert.equal(r.stolen_from, null);
  assert.equal(r.demoted_notice, null);
  assert.equal(r.forced, false, 'a free fleet was not taken from anyone');
  assert.deepEqual(c.s.keys, []);
});

test('re-adopting a lease this session already holds is idempotent, not a new generation', async () => {
  const bt = await load();
  const c = orch({ lease: liveLease({ session_id: 'S1', tmux_pane: '%1', lease_seq: 4 }) });
  let acquired = 0;
  c.deps.acquireLease = () => { acquired += 1; return { ok: true, lease_seq: 99 }; };
  const r = await bt.orchTools(c).get('soma_adopt')({});
  assert.equal(r.adopted, true);
  assert.equal(r.already_held, true);
  assert.equal(r.lease_seq, 4, 'the receipt a displaced holder compares must not move');
  assert.equal(acquired, 0);
  assert.deepEqual(c.s.keys, [], 'and nobody types DEMOTED at their own composer');
});

test('a held lease whose record no longer describes this session is rewritten', async () => {
  const bt = await load();
  // promoted outside tmux, now running inside a pane: the recorded wake goes nowhere
  const c = orch({ lease: liveLease({ session_id: 'S1', tmux_pane: null, tmux_socket: null, wake: 'notify', lease_seq: 4 }) });
  const r = await bt.orchTools(c).get('soma_adopt')({});
  assert.equal(r.adopted, true);
  assert.notEqual(r.already_held, true);
  assert.equal(r.lease_seq, 5);
  assert.equal(c.s.lease.wake, 'tmux');
  assert.equal(c.s.lease.tmux_socket, 'soma');
  assert.deepEqual(c.s.keys, [], 'the displaced record was our own; no DEMOTED notice');
});

test('no session identity at all is a diagnosable refusal, not a TypeError from the lease', async () => {
  const bt = await load();
  for (const env of [{ SOMA_SESSION_ID: undefined }, { SOMA_SESSION_ID: '' }, { SOMA_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '' }]) {
    const c = orch({ env });
    let acquired = 0;
    c.deps.acquireLease = () => { acquired += 1; throw new TypeError('acquireLease: claim.session_id must be a non-empty string, got undefined'); };
    const r = await bt.orchTools(c).get('soma_adopt')({});
    assert.equal(r.adopted, false);
    assert.match(r.error, /CLAUDE_CODE_SESSION_ID/);
    assert.match(r.error, /SOMA_SESSION_ID/);
    assert.equal(acquired, 0, 'refuse before the lease is touched');
    assert.equal((await bt.orchTools(c).get('soma_release')({})).released, false);
  }
});

/**
 * The identity contract with `orch-inject.mjs`, measured on Claude Code 2.1.220:
 * the hook payload's `session_id` and the MCP server's `CLAUDE_CODE_SESSION_ID` are
 * the same string, and each claude process overwrites that variable with its own
 * session id. `CLAUDE_SESSION_ID` — what the original entrypoint read — does not exist.
 */
test('the lease records the session id the inject hook will compare against', async () => {
  const bt = await load();
  const real = '00000000-0000-0000-0000-000000000000';
  const c = orch({ lease: null, env: { CLAUDE_CODE_SESSION_ID: real, SOMA_SESSION_ID: undefined } });
  const r = await bt.orchTools(c).get('soma_adopt')({});
  assert.equal(r.adopted, true);
  assert.equal(c.s.lease.session_id, real);
  assert.equal(r.session_id_source, 'claude-code');
});

test('the harness id wins over a SOMA_SESSION_ID override, which can only be wrong while it is present', async () => {
  const bt = await load();
  const real = '00000000-0000-0000-0000-000000000000';
  const c = orch({ lease: null, env: { CLAUDE_CODE_SESSION_ID: real, SOMA_SESSION_ID: 'hand-written' } });
  await bt.orchTools(c).get('soma_adopt')({});
  assert.equal(c.s.lease.session_id, real);
});

test('SOMA_SESSION_ID still carries a bus whose harness never told it who it is', async () => {
  const bt = await load();
  const c = orch({ env: { SOMA_SESSION_ID: 'S1', CLAUDE_CODE_SESSION_ID: undefined } });
  const r = await bt.orchTools(c).get('soma_adopt')({});
  assert.equal(c.s.lease.session_id, 'S1');
  assert.equal(r.session_id_source, 'soma-env', 'and it says so, because injection then depends on the pane arm alone');
});

test('every identity-keyed operation resolves the id the same way', async () => {
  const bt = await load();
  const real = '00000000-0000-0000-0000-000000000000';
  const c = orch({ lease: liveLease({ session_id: real, heartbeat_at: Date.now() - 5 * 60 * 1000 }), env: { CLAUDE_CODE_SESSION_ID: real, SOMA_SESSION_ID: 'hand-written' } });
  const tools = bt.orchTools(c);
  await tools.get('soma_status')({});
  assert.deepEqual(c.s.beats, [real], 'the heartbeat must stamp the record the hooks match');
  const again = await tools.get('soma_adopt')({});
  assert.equal(again.already_held, true, 'and re-adopting recognises the record as ours');
  assert.equal((await tools.get('soma_release')({})).released, true);
});

test('a pane that changed across a reattach is refreshed, and identity still holds', async () => {
  const bt = await load();
  const real = '00000000-0000-0000-0000-000000000000';
  // The id arm keeps identifying the holder while the advisory pane self-heals.
  const c = orch({ lease: liveLease({ session_id: real, tmux_pane: '%7', lease_seq: 3 }), panes: ['%1', '%7'], env: { CLAUDE_CODE_SESSION_ID: real } });
  const r = await bt.orchTools(c).get('soma_adopt')({});
  assert.equal(r.adopted, true);
  assert.equal(r.forced, false, 'refreshing our own record is not a steal');
  assert.equal(c.s.lease.session_id, real);
  assert.equal(c.s.lease.tmux_pane, '%1');
  assert.deepEqual(c.s.keys, [], 'and nobody is told they were demoted');
});

// ---------------------------------------------------------------------------
// soma_adopt: keystroke wakes only for a pane PROVEN to be on soma's own tmux server (issue #2)
// ---------------------------------------------------------------------------

// `$TMUX_PANE` is a pane id, and a pane id is a small per-server counter. A session promoted in
// the operator's everyday tmux carries that server's `%1`; soma's server has its own `%1`, a lead
// or a teammate. Recorded as `wake: 'tmux'`, every urgent wake was typed into that stranger. So
// the claim asks `paneOnServer(pane, $TMUX)` first, and anything short of a yes is the notify claim.

const NOTIFY_CLAIM = { tmux_socket: null, tmux_pane: null, wake: 'notify' };
const claimOfLease = (l) => ({ tmux_socket: l?.tmux_socket, tmux_pane: l?.tmux_pane, wake: l?.wake });

test('a session in another tmux server adopts with notify wake, though soma\'s server has a pane with its id', async () => {
  const bt = await load();
  const c = orch({ lease: null, env: { TMUX: OWN_TMUX } });
  assert.ok(c.s.panes.has(c.env.SOMA_TMUX_PANE), 'fixture: the collision, %1 is on soma\'s server too');
  const r = await bt.orchTools(c).get('soma_adopt')({});
  assert.equal(r.adopted, true);
  assert.equal(r.wake, 'notify');
  assert.equal(r.degraded_wake, true);
  assert.deepEqual(claimOfLease(c.s.lease), NOTIFY_CLAIM);
});

test('nothing short of a proof is a tmux claim: a missing pane, no $TMUX, no verifier, or a verifier that fails', async () => {
  const bt = await load();
  for (const [label, opts] of [
    ['a pane soma\'s server does not have', { env: { SOMA_TMUX_PANE: '%3' } }],
    ['no $TMUX', { env: { TMUX: undefined } }],
    ['an empty $TMUX', { env: { TMUX: '' } }],
    ['no verifier wired', { deps: { paneOnServer: undefined } }],
    ['a verifier that throws', { deps: { paneOnServer: () => { throw new Error('tmux timed out'); } } }],
    ['a verifier whose promise rejects', { deps: { paneOnServer: async () => { throw new Error('EIO'); } } }],
    ['a verifier that answers something other than true', { deps: { paneOnServer: () => 'yes' } }],
  ]) {
    const c = orch({ lease: null, ...opts });
    const r = await bt.orchTools(c).get('soma_adopt')({});
    assert.equal(r.adopted, true, label);
    assert.equal(r.wake, 'notify', label);
    assert.equal(r.degraded_wake, true, label);
    assert.deepEqual(claimOfLease(c.s.lease), NOTIFY_CLAIM, label);
  }
});

test('a proven pane is claimed exactly as before, proven once per adopt, about this pane and this $TMUX', async () => {
  const bt = await load();
  const asked = [];
  const c = orch({ lease: null });
  const real = c.deps.paneOnServer;
  // Asynchronous on purpose: the handler awaits its deps, so an async yes is still a yes.
  c.deps.paneOnServer = async (pane, tmuxVar) => { asked.push([pane, tmuxVar]); return real(pane, tmuxVar); };
  const r = await bt.orchTools(c).get('soma_adopt')({});
  assert.equal(r.wake, 'tmux');
  assert.equal(r.degraded_wake, false);
  assert.deepEqual(claimOfLease(c.s.lease), { tmux_socket: 'soma', tmux_pane: '%1', wake: 'tmux' });
  assert.deepEqual(asked, [['%1', SOMA_TMUX]], 'one tmux round trip per adopt, not one per use of the claim');
});

test('a holder that can no longer prove its pane re-adopts into notify, rather than keep a pane it cannot prove', async () => {
  const bt = await load();
  // Held with keystroke wakes; the same session has since been resumed into the operator's own tmux.
  const c = orch({ lease: liveLease({ session_id: 'S1', lease_seq: 4 }), env: { TMUX: OWN_TMUX } });
  const r = await bt.orchTools(c).get('soma_adopt')({});
  assert.equal(r.adopted, true);
  assert.notEqual(r.already_held, true, 'the record names a pane this session cannot prove is its own');
  assert.equal(r.lease_seq, 5);
  assert.equal(r.degraded_wake, true);
  assert.deepEqual(claimOfLease(c.s.lease), NOTIFY_CLAIM);
});

test('a lease the fleet lock could not hand over is a refusal, and it names no file', async () => {
  const bt = await load();
  const boom = Object.assign(new Error('/Users/someone/.soma/state/fleet.lock is unreadable (EACCES) — gave up after 1000ms'), { code: 'EACCES' });
  const c = orch({ lease: null, deps: { acquireLease: () => { throw boom; } } });
  const r = await bt.orchTools(c).get('soma_adopt')({});
  assert.equal(r.adopted, false);
  assert.match(r.error, /EACCES/);
  assert.ok(!/[/\\]/.test(r.error), r.error);
  assert.ok(!r.error.includes('.soma'));
});

test('a lead session — or one of its teammates — may not take the lease', async () => {
  const bt = await load();
  const c = orch({ env: { SOMA_LEAD_NAME: 'cr-1' } });
  let acquired = 0;
  c.deps.acquireLease = () => { acquired += 1; return { ok: true }; };
  for (const map of [bt.orchTools(c), bt.candidateTools(c)]) {
    const r = await map.get('soma_adopt')({ force: true });
    assert.equal(r.ok, false);
    assert.notEqual(r.adopted, true);
    assert.match(r.error, /cr-1/);
  }
  assert.equal(acquired, 0, 'and the lease is never touched, in either role');
  assert.deepEqual(c.s.beats, [], 'a tainted session does not even heartbeat');
});

test('adopt reports how much unread mail the fleet has been holding', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1' }], events: [{ type: 'COMPLETED' }, { type: 'NEEDS_INPUT' }] });
  const r = await bt.orchTools(c).get('soma_adopt')({});
  assert.equal(r.unread_count, 2);
  assert.deepEqual(c.s.cursors, {}, 'adopt must not consume the mail it counted');
});

// ---------------------------------------------------------------------------
// soma_release
// ---------------------------------------------------------------------------

test('release hands the lease back, and says what is still running', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1', status: 'spawned' }, { id: 'cr-2' }], lease: liveLease({ session_id: 'S1' }) });
  const r = await bt.orchTools(c).get('soma_release')({});
  assert.equal(r.released, true);
  assert.equal(r.leads_running, 1);
  assert.equal(c.s.lease, null);
});

test('a demoted session cannot unmount the orchestrator that replaced it', async () => {
  const bt = await load();
  const c = orch({ lease: liveLease({ session_id: 'S-other' }) });
  const r = await bt.orchTools(c).get('soma_release')({});
  assert.equal(r.released, false);
  assert.equal(r.holder.session_id, 'S-other');
  assert.equal(c.s.lease.session_id, 'S-other');
});

/**
 * THE HOLDER GATE, AND THE TABLE IT WAS FOUND BY.
 *
 * ⚠ **Eleven of the twelve orchestrator tools never compared the caller to the lease
 * holder, so a force-steal did not bind the session it stole from.** Measured live on the
 * real modules: after B force-stole, A **still enqueued a row, still called `killSession`
 * on a live lead, still typed orders into a lead's pane, and still paused the queue.**
 * `soma_release` was the only one of twelve that checked.
 *
 * The predicate was already computed and thrown away: `beat()` compares
 * `current.session_id !== sid` and used it only to decide whether to stamp a heartbeat,
 * then `def` went on to `await handler(...)`. And `soma-bus.main` upgrades the tool Map in
 * place on a successful adopt with no downgrade path, so a demoted session keeps all
 * twelve tools for the life of its process — which is why the gate has to live in the
 * handler and cannot live in the Map.
 *
 * This is not a small residual. The single-holder lease is what the entire promotion
 * design rests on, and `force: true` is gated on operator assent *precisely because*
 * stealing is destructive — so the operator was assenting to a steal that did not bind.
 *
 * Below: the review's live table, reproduced against the fixture, **with the recorded
 * effects asserted and not only the return value**. A refusal that still wrote a row
 * would pass a result-only check.
 */
test('after a force-steal the stolen-from session is refused, and nothing it asked for happens', async () => {
  const bt = await load();
  // A holds the lease; B force-steals it; A goes on calling tools.
  const c = orch({
    lease: liveLease({ session_id: 'sess-AAAA', lease_seq: 1 }),
    tasks: [{ id: 'cr-1', status: 'spawned', tmux_session: 'lead-cr-1', lead_session_uuid: 'u-1' }],
    sessions: ['lead-cr-1'],
    env: { SOMA_SESSION_ID: 'sess-AAAA' },
  });
  const a = bt.orchTools(c);
  // The steal, through the same `acquireLease` the real `soma_adopt` uses.
  c.s.lease = { ...liveLease({ session_id: 'sess-BBBB', lease_seq: 2, tmux_pane: '%9' }) };
  assert.equal(c.s.lease.lease_seq, 2, 'the generation changed — this is a steal, not a re-adopt');

  const before = { updates: c.s.updates, keys: c.s.keys.length, killed: c.s.killed.length, cursors: { ...c.s.cursors }, paused: c.s.queuePaused };

  // Every tool that mutates ANYTHING — the fleet table, a tmux pane, the queue switch,
  // the shared event cursor — refuses, and names the holder so the refusal is actionable.
  const CALLS = [
    ['soma_enqueue', { tasks: [{ id: 'stolen-1', title: 't', repo: 'r', source: {}, brief: 'b' }] }],
    ['soma_queue', { action: 'pause' }],
    ['soma_spawn', { task_id: 'cr-1' }],
    ['soma_inbox', {}],
    ['soma_send', { lead: 'cr-1', message: 'do the thing' }],
    ['soma_kill', { lead: 'cr-1', reason: 'because' }],
    ['soma_resume', { lead: 'cr-1' }],
  ];
  for (const [name, args] of CALLS) {
    const r = await a.get(name)(args);
    assert.equal(r.ok, false, `${name} did not refuse a session that no longer holds the lease`);
    assert.equal(r.holder?.session_id, 'sess-BBBB', `${name} refused without naming the holder`);
    assert.equal(r.holder?.lease_seq, 2, `${name} must report the generation that displaced this session`);
    assert.match(r.error, /does not hold the orchestrator lease/, name);
    assert.ok(!/[/\\]/.test(r.error), `${name} refusal names a path: ${r.error}`);
  }

  // …and the recorded effects, which are what the live probe actually caught. A
  // result-only assertion would pass on a handler that refused *after* doing the work.
  assert.equal(c.s.fleet.tasks.find((t) => t.id === 'stolen-1'), undefined, 'a demoted session enqueued a row');
  assert.equal(c.s.updates, before.updates, 'a demoted session opened a checkpoint transaction');
  assert.deepEqual(c.s.killed.length, before.killed, 'a demoted session killed a lead');
  assert.equal(c.s.keys.length, before.keys, 'a demoted session typed into a pane');
  assert.equal(c.s.queuePaused, before.paused, 'a demoted session paused the queue');
  assert.deepEqual(c.s.cursors, before.cursors, 'a demoted session advanced the role-keyed event cursor — the true holder would never see that mail');
  assert.deepEqual(c.s.spawns, [], 'a demoted session spawned a lead');
  assert.deepEqual(c.s.resumes, [], 'a demoted session resumed a lead');

  // The five that stay open, and each is open for its own stated reason.
  assert.equal((await a.get('soma_status')({})).lease.session_id, 'sess-BBBB', 'a reader must still answer, and answer honestly about who holds it');
  assert.ok(typeof (await a.get('soma_transcript')({ lead: 'cr-1' })).text === 'string');
  assert.ok(await a.get('soma_digest')({}));
  // release refuses on its own richer terms, unchanged.
  const rel = await a.get('soma_release')({});
  assert.equal(rel.released, false);
  assert.equal(rel.holder.session_id, 'sess-BBBB');
  // and adopt is the way back — open, because gating it would make demotion permanent.
  const back = await a.get('soma_adopt')({ force: true });
  assert.equal(back.adopted, true, 'soma_adopt must stay reachable, or a demoted session can never recover');
  assert.equal((await a.get('soma_enqueue')({ tasks: [{ id: 'cr-2', title: 't', repo: 'r', source: {}, brief: 'b' }] })).queued?.length, 1,
    're-adopting must restore the control plane in the same process — the Map was never downgraded, so only the gate can');
});

/**
 * The rule, not the list: **closed by default.** `def`'s third argument is what opens a
 * tool, five tools pass it, and each argues why at its own call site. This asserts the
 * complement — that nothing else does — so a thirteenth tool added later is gated unless
 * somebody consciously opens it. That is the opposite of how the first twelve arrived.
 */
test('every orchestrator tool but the five argued-open ones refuses a caller who is not the holder', async () => {
  const bt = await load();
  const OPEN = new Set(['soma_adopt', 'soma_release', 'soma_status', 'soma_transcript', 'soma_digest']);
  // `may not drive the fleet` is the generic gate's own sentence. `soma_release` says
  // "does not hold the orchestrator lease" too, on its own richer terms, so matching the
  // shared prefix would read release's correct answer as the generic gate firing.
  const GATED = (r) => r?.ok === false && /may not drive the fleet/.test(String(r.error));
  // A FRESH fixture per tool, in both directions. One fixture for the whole Map is how the
  // first draft of this test lied to itself: `soma_release` runs before `soma_enqueue` in
  // Map order, so it released the lease and every later tool was refused for the right
  // reason in the wrong test.
  const args = { lead: 'cr-1', task_id: 'cr-1', tasks: [], action: 'status', message: 'hi' };
  for (const name of [...bt.orchTools(orch()).keys()]) {
    const c = orch({ lease: liveLease({ session_id: 'somebody-else' }), tasks: [{ id: 'cr-1', status: 'spawned' }] });
    const r = await bt.orchTools(c).get(name)(args);
    if (OPEN.has(name)) {
      assert.equal(GATED(r), false, `${name} is documented open but refused on the lease`);
    } else {
      assert.equal(GATED(r), true, `${name} let a non-holder through — that is the holder-gate hole, back`);
      assert.equal(r.holder?.session_id, 'somebody-else', `${name} refused without naming the holder`);
    }
    // The complement, on its own fixture: with the lease held, none of them refuse on it.
    const held = orch({ lease: liveLease({ session_id: 'S1' }), tasks: [{ id: 'cr-1', status: 'spawned' }] });
    assert.equal(GATED(await bt.orchTools(held).get(name)(args)), false, `${name} refused the actual holder`);
  }
});

test('a session with no identity at all is not the holder either, and cannot drive the fleet', async () => {
  const bt = await load();
  // `sessionId()` answers '' — so `current.session_id === sid` must not be reachable by a
  // lease record that also has no session id. The three degenerate-id guards, one level up.
  for (const lease of [liveLease({ session_id: '' }), liveLease({ session_id: undefined }), null]) {
    const c = orch({ lease, env: { SOMA_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: undefined } });
    const r = await bt.orchTools(c).get('soma_enqueue')({ tasks: [{ id: 'cr-9', title: 't', repo: 'r', source: {}, brief: 'b' }] });
    assert.equal(r.ok, false, `an anonymous session enqueued against lease ${JSON.stringify(lease?.session_id)}`);
    assert.deepEqual(c.s.fleet.tasks.map((t) => t.id), [], 'and it wrote nothing');
  }
});

test('an unreadable lease refuses rather than assuming the caller still holds it', async () => {
  const bt = await load();
  // `leaseOf` answers null for a torn read, an EACCES, or an unwired dep. Fail-closed is
  // the direction for a control plane whose tools kill sessions and type into panes, and
  // it strands nobody: `soma_adopt` is open, and adopting over an unreadable lease is the
  // recovery the operator wants.
  const c = orch({ deps: { readLease: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } } });
  const r = await bt.orchTools(c).get('soma_kill')({ lead: 'cr-1' });
  assert.equal(r.ok, false);
  assert.equal(r.holder, null, 'nothing is known about the holder, and the refusal says so rather than inventing one');
  assert.deepEqual(c.s.killed, []);
});

test('a release the lock refused is a refusal with no path in it', async () => {
  const bt = await load();
  const c = orch({ deps: { releaseLease: () => { throw new Error("ENOENT: no such file, open '/Users/x/.soma/state/orch.lease'"); } } });
  const r = await bt.orchTools(c).get('soma_release')({});
  assert.equal(r.released, false);
  assert.ok(!/[/\\]/.test(r.error), r.error);
});

// ---------------------------------------------------------------------------
// soma_enqueue
// ---------------------------------------------------------------------------

test('enqueue refuses anything that is not an array of task objects', async () => {
  const bt = await load();
  const c = orch();
  for (const tasks of [undefined, null, 'cr-1', 7, { id: 'cr-1' }]) {
    const r = await bt.orchTools(c).get('soma_enqueue')({ tasks });
    assert.equal(r.ok, false, JSON.stringify(tasks));
    assert.match(r.error, /array/);
  }
  assert.equal(c.s.fleet.tasks.length, 0);
});

test('the task id orch is refused: it would collide with the orchestrator own event stream', async () => {
  const bt = await load();
  const c = orch();
  const r = await bt.orchTools(c).get('soma_enqueue')({ tasks: [{ id: 'orch', brief: 'b' }, { id: 'cr-1', brief: 'b' }] });
  assert.deepEqual(r.queued, ['cr-1']);
  assert.ok(r.skipped.some((x) => x.id === 'orch' && x.reason === 'reserved-id'));
  assert.deepEqual(c.s.fleet.tasks.map((t) => t.id), ['cr-1']);
});

test('a configured fleet catches a repo typo at intake; an unconfigured one queues anyway', async () => {
  const bt = await load();
  const known = orch({ config: { max_leads: 10, repos: { 'acme-app-2.0': { path: '/r' } }, budgets: {} } });
  const r = await bt.orchTools(known).get('soma_enqueue')({ tasks: [{ id: 'cr-1', repo: 'acme-app-20' }, { id: 'cr-2', repo: 'acme-app-2.0' }] });
  assert.deepEqual(r.queued, ['cr-2']);
  assert.ok(r.skipped.some((x) => x.id === 'cr-1' && x.reason === 'unknown-repo'));
  assert.deepEqual(r.known_repos, ['acme-app-2.0']);
  assert.ok(!JSON.stringify(r).includes('/r'), 'a repo path is not a repo name');

  const bare = orch();                                     // repos: {} — nothing configured yet
  const r2 = await bt.orchTools(bare).get('soma_enqueue')({ tasks: [{ id: 'cr-9', repo: 'whatever' }] });
  assert.deepEqual(r2.queued, ['cr-9']);
});

test('enqueue hands the fleet the configured repo map, so a repo-level verify_hint can reach the row', async () => {
  const bt = await load();
  /** The fixture's enqueue, plus a record of the options it was handed. */
  const recording = (seen) => (tasks, opts) => {
    seen.push(opts);
    return { queued: tasks.map((x) => x.id), skipped: [] };
  };
  const repos = { 'acme-app': { path: '/repos/acme-app', verify_hint: 'yarn test' } };
  const seen = [];
  const c = orch({ config: { max_leads: 10, repos, budgets: {} }, deps: { enqueue: recording(seen) } });
  const r = await bt.orchTools(c).get('soma_enqueue')({ tasks: [{ id: 'cr-1', repo: 'acme-app', brief: 'b' }] });
  assert.deepEqual(r.queued, ['cr-1']);
  assert.equal(seen.length, 1);
  // `fleet.enqueue` falls back to `repos[task.repo].verify_hint`, and it never reads soma.json
  // itself, so a fallback the bus does not pass the map to never happens.
  assert.deepEqual(seen[0]?.repos, repos, 'soma_enqueue must pass soma.json\'s repos as enqueue(tasks, { repos })');

  // No config to read, unwired or unparseable, means no repo map. It does not mean a failed
  // enqueue: the task still queues, with nothing to fall back on.
  for (const [why, loadConfig] of [['unwired', undefined], ['throws', () => { throw new SyntaxError('Unexpected token } in JSON'); }]]) {
    const calls = [];
    const bare = orch({ deps: { loadConfig, enqueue: recording(calls) } });
    const r2 = await bt.orchTools(bare).get('soma_enqueue')({ tasks: [{ id: 'cr-2', repo: 'r', brief: 'b' }] });
    assert.deepEqual(r2.queued, ['cr-2'], `loadConfig ${why}: the task must still queue`);
    assert.equal(calls.length, 1, `loadConfig ${why}`);
    assert.equal(calls[0]?.repos ?? null, null, `loadConfig ${why}: there is no repo map to pass`);
  }
});

test('a budget class soma.json does not define is refused at intake, and the reply names the ones it does', async () => {
  const bt = await load();
  // The watchdog prices a lead at its pinned class from the first tick, and passes over a pin it
  // cannot bind without a word when the lead's harness prices it. So the door is where a typo
  // in the class has to be caught.
  const c = orch({ config: { max_leads: 10, repos: {}, budgets: { standard: { tokens_cap: 1000 }, babysit: { tokens_cap: 400 }, flat: 42 } } });
  const r = await bt.orchTools(c).get('soma_enqueue')({ tasks: [
    { id: 'cr-1', budget_class: 'babysit' },
    { id: 'cr-2' },                                       // no pin: the lead's harness prices it
    { id: 'cr-3', budget_class: null },                   // the same, spelled out
    { id: 'cr-4', budget_class: 'premium' },              // never written in soma.json
    { id: 'cr-5', budget_class: 'constructor' },          // Object.prototype's, not soma.json's
    { id: 'cr-6', budget_class: 'flat' },                 // an own key with no caps behind it
    { id: 'cr-7', budget_class: 'Babysit' },              // matched exactly, as the breaker matches it
    { id: 'cr-8', budget_class: 7 },
    { id: 'cr-9', budget_class: '' },
    { id: 'cr-10', budget_class: 'toString' },            // two more names no budgets object owns
    { id: 'cr-11', budget_class: '__proto__' },
  ] });
  assert.deepEqual(r.queued, ['cr-1', 'cr-2', 'cr-3']);
  assert.deepEqual(r.skipped, ['cr-4', 'cr-5', 'cr-6', 'cr-7', 'cr-8', 'cr-9', 'cr-10', 'cr-11'].map((id) => ({ id, reason: 'unknown-budget-class' })));
  assert.deepEqual(r.known_budget_classes, ['standard', 'babysit'], 'only the classes the breaker can bind');
  assert.deepEqual(c.s.fleet.tasks.map((t) => t.id), ['cr-1', 'cr-2', 'cr-3']);

  // No refusal of that kind, no list: the reply carries what the caller needs to act on.
  const fine = await bt.orchTools(c).get('soma_enqueue')({ tasks: [{ id: 'cr-12', budget_class: 'standard' }] });
  assert.deepEqual(fine.queued, ['cr-12']);
  assert.equal(fine.known_budget_classes, undefined);
});

test('the class check reads own keys only, and stands down when there is nothing to check against', async () => {
  const bt = await load();
  // A record on the budgets' prototype is a class nobody wrote in soma.json; an `in` lookup
  // would admit it.
  const budgets = Object.assign(Object.create({ premium: { tokens_cap: 1 } }), { standard: { tokens_cap: 1000 } });
  const proto = orch({ config: { max_leads: 10, repos: {}, budgets } });
  const r = await bt.orchTools(proto).get('soma_enqueue')({ tasks: [{ id: 'cr-1', budget_class: 'premium' }] });
  assert.deepEqual(r.skipped, [{ id: 'cr-1', reason: 'unknown-budget-class' }]);
  assert.deepEqual(r.known_budget_classes, ['standard']);

  // As with an unknown repo: a config that cannot be read, or that defines no class at all,
  // validates nothing rather than refusing every pin.
  const unreadable = orch({ deps: { loadConfig: () => { throw new Error('Unexpected token } in JSON at position 9'); } } });
  for (const c of [
    unreadable,
    orch({ config: { max_leads: 10, repos: {} } }),
    orch({ config: { max_leads: 10, repos: {}, budgets: null } }),
    orch({ config: { max_leads: 10, repos: {}, budgets: {} } }),
  ]) {
    const out = await bt.orchTools(c).get('soma_enqueue')({ tasks: [{ id: 'cr-1', budget_class: 'anything' }] });
    assert.deepEqual(out.queued, ['cr-1']);
    assert.equal(out.known_budget_classes, undefined);
  }
});

test('an unbounded brief is refused rather than written into the checkpoint', async () => {
  const bt = await load();
  const c = orch();
  const r = await bt.orchTools(c).get('soma_enqueue')({ tasks: [{ id: 'cr-1', brief: 'x'.repeat(200_000) }] });
  assert.deepEqual(r.queued, []);
  assert.ok(r.skipped.some((x) => x.id === 'cr-1' && x.reason === 'brief-too-long'));
  assert.equal(c.s.fleet.tasks.length, 0);
});

test('no rejected row can echo an unbounded id back into the model context', async () => {
  const bt = await load();
  const c = orch({ deps: { enqueue: () => ({ queued: [], skipped: [{ id: 'z'.repeat(50_000), reason: 'invalid-id' }] }) } });
  const r = await bt.orchTools(c).get('soma_enqueue')({ tasks: [{ id: 'q'.repeat(50_000) }, { id: 'cr-1' }] });
  assert.ok(JSON.stringify(r).length < 2000, `${JSON.stringify(r).length} chars came back`);
});

test('a batch too large to be a backlog is refused whole, not half-queued', async () => {
  const bt = await load();
  const c = orch();
  const tasks = Array.from({ length: 5000 }, (_, i) => ({ id: `cr-${i}` }));
  const r = await bt.orchTools(c).get('soma_enqueue')({ tasks });
  assert.equal(r.ok, false);
  assert.equal(c.s.fleet.tasks.length, 0);
});

test('a checkpoint that will not take the tasks is a refusal that names no file', async () => {
  const bt = await load();
  const c = orch({ deps: { enqueue: () => { throw new Error('/Users/x/.soma/state/fleet.json is not a fleet checkpoint'); } } });
  const r = await bt.orchTools(c).get('soma_enqueue')({ tasks: [{ id: 'cr-1' }] });
  assert.equal(r.ok, false);
  assert.ok(!/[/\\]/.test(r.error), r.error);
});

// ---------------------------------------------------------------------------
// soma_queue
// ---------------------------------------------------------------------------

test('queue pause and resume write the switch; status writes nothing', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1' }, { id: 'cr-2', status: 'spawned' }] });
  const tools = bt.orchTools(c);
  assert.equal((await tools.get('soma_queue')({ action: 'pause' })).paused, true);
  assert.equal(c.s.queuePaused, true);
  const st = await tools.get('soma_queue')({ action: 'status' });
  assert.equal(st.paused, true);
  assert.equal(st.queued, 1);
  assert.equal(st.active, 1);
  assert.equal((await tools.get('soma_queue')({ action: 'resume' })).paused, false);
  assert.equal(c.s.queuePaused, false);
  assert.equal((await tools.get('soma_queue')()).paused, false);      // status is the default
});

test('an unknown queue action is refused instead of silently resuming the queue', async () => {
  const bt = await load();
  const c = orch({ deps: { queuePaused: () => true } });
  for (const action of ['stop', '', 'PAUSED', 42]) {
    const r = await bt.orchTools(c).get('soma_queue')({ action });
    assert.equal(r.ok, false, JSON.stringify(action));
    assert.match(r.error, /pause, resume or status/);
  }
  assert.equal(c.s.queuePaused, false);
});

test('a pause that could not be recorded is a refusal, not a freeze in the orchestrator head', async () => {
  const bt = await load();
  const unwired = orch({ deps: { setQueuePaused: undefined } });
  const a = await bt.orchTools(unwired).get('soma_queue')({ action: 'pause' });
  assert.equal(a.ok, false);
  assert.match(a.error, /pause/);

  const broken = orch({ deps: { setQueuePaused: () => { throw new Error('EACCES /Users/x/.soma/state/queue.paused'); } } });
  const b = await bt.orchTools(broken).get('soma_queue')({ action: 'pause' });
  assert.equal(b.ok, false);
  assert.ok(!/[/\\]/.test(b.error), b.error);
});

// ---------------------------------------------------------------------------
// soma_spawn — the check-and-set
// ---------------------------------------------------------------------------

test('spawn admits and marks the row inside one transaction, then spawns outside it', async () => {
  const bt = await load();
  const order = [];
  const c = orch({ tasks: [{ id: 'cr-1' }] });
  const inner = c.deps.setTaskStatus;
  c.deps.setTaskStatus = (id, st) => { order.push(`set:${st}`); inner(id, st); };
  const outer = c.deps.updateFleet;
  c.deps.updateFleet = (m) => { order.push('tx'); return outer(m); };
  const spawn = c.deps.spawnLead;
  c.deps.spawnLead = (t) => { order.push('spawn'); assert.equal(t.status, 'spawned', 'the spawner sees the admitted row'); return spawn(t); };

  const r = await bt.orchTools(c).get('soma_spawn')({ task_id: 'cr-1' });
  assert.equal(r.spawned, true);
  assert.deepEqual(order, ['tx', 'set:spawned', 'spawn', 'tx']);
  assert.equal(c.s.fleet.tasks[0].status, 'spawned');
});

test('the spawned transition is what stamps last_spawn_at — the bus never stamps it', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1' }] });
  c.deps.setTaskStatus = () => {};                       // a setTaskStatus that stamps nothing
  await bt.orchTools(c).get('soma_spawn')({ task_id: 'cr-1' });
  assert.equal(c.s.fleet.last_spawn_at, null, 'soma_spawn must not stamp the stagger clock itself');
});

test('two admitters cannot both spawn past max_leads', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1' }, { id: 'cr-2' }], config: { max_leads: 1, repos: {}, budgets: {} } });
  const tools = bt.orchTools(c);
  const first = await tools.get('soma_spawn')({ task_id: 'cr-1' });
  const second = await tools.get('soma_spawn')({ task_id: 'cr-2' });
  assert.equal(first.spawned, true);
  assert.equal(second.ok, false);
  assert.match(second.error, /max_leads/);
  assert.deepEqual(c.s.spawns, ['cr-1']);
  assert.equal(c.s.fleet.tasks[1].status, 'queued', 'a refused admission leaves the row queued');
});

test('spawn refuses an unknown, an already-spawned and a terminal task', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1', status: 'spawned' }, { id: 'cr-2', status: 'done' }] });
  const tools = bt.orchTools(c);
  for (const [task_id, re] of [['cr-9', /no task/], ['cr-1', /already spawned/], ['cr-2', /not queued/]]) {
    const r = await tools.get('soma_spawn')({ task_id });
    assert.equal(r.ok, false, task_id);
    assert.match(r.error, re);
  }
  assert.deepEqual(c.s.spawns, []);
});

test('spawn refuses a task id that is not a task id', async () => {
  const bt = await load();
  const c = orch();
  for (const task_id of [undefined, '', '../../etc/passwd', 'orch', 'CR-1', 'x'.repeat(80)]) {
    const r = await bt.orchTools(c).get('soma_spawn')({ task_id });
    assert.equal(r.ok, false, JSON.stringify(task_id));
    // The caller's own rejected value is quoted back (clamped), which is how it
    // learns what was wrong; what must never appear is a path of *ours*.
    assert.ok(!r.error.includes('.soma'), r.error);
    assert.ok(r.error.length < 200, r.error.length);
  }
  assert.deepEqual(c.s.spawns, []);
});

test('a spawn that fails puts the task back in the queue and names no path', async () => {
  const bt = await load();
  const boom = Object.assign(new Error("worktree /Users/x/.soma/worktrees/r/cr-1 is still registered; run 'git worktree unlock'"), { code: 'ENOTSUP' });
  const c = orch({ tasks: [{ id: 'cr-1' }], deps: { spawnLead: () => { throw boom; } } });
  const r = await bt.orchTools(c).get('soma_spawn')({ task_id: 'cr-1' });
  assert.equal(r.ok, false);
  assert.equal(r.requeued, true);
  assert.match(r.error, /ENOTSUP/);
  assert.ok(!/[/\\]/.test(r.error), r.error);
  assert.equal(c.s.fleet.tasks[0].status, 'queued');
});

test('the spawn records the session uuid and tmux session — nothing else in v1 does', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1' }] });
  const r = await bt.orchTools(c).get('soma_spawn')({ task_id: 'cr-1' });
  assert.equal(r.recorded, true);
  assert.equal(c.s.fleet.tasks[0].lead_session_uuid, 'u-cr-1');
  assert.equal(c.s.fleet.tasks[0].tmux_session, 'lead-cr-1');
  // which is what makes token accounting and resume reachable at all
  const st = await bt.orchTools(c).get('soma_status')({ lead: 'cr-1' });
  assert.equal(st.leads[0].est_tokens, 500);
  assert.equal(st.leads[0].model, 'claude-fable-5');
});

/**
 * Wraps a fixture's `updateFleet` and `setTaskStatus` so a test can see which transaction each
 * status write ran inside (`depths`) and what each transaction left on the row (`commits`).
 */
const transactions = (c, id) => {
  const seen = { depths: [], commits: [] };
  let depth = 0;
  const inner = c.deps.updateFleet;
  c.deps.updateFleet = (mutate) => {
    depth += 1;
    try {
      return inner(mutate);
    } finally {
      depth -= 1;
      seen.commits.push(structuredClone(c.s.fleet.tasks.find((t) => t.id === id)));
    }
  };
  const set = c.deps.setTaskStatus;
  c.deps.setTaskStatus = (tid, st) => { seen.depths.push([st, depth]); return set(tid, st); };
  return seen;
};

test('soma_spawn marks the launch in its claim, and the write that records the session clears it', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1' }] });
  let during = null;
  const spawn = c.deps.spawnLead;
  // The row as any reader finds it while the spawner runs outside the lock: the watchdog's reconcile,
  // `soma status`, `soma_status`.
  c.deps.spawnLead = (t) => { during = structuredClone(c.s.fleet.tasks[0]); return spawn(t); };
  const tx = transactions(c, 'cr-1');
  const before = Date.now();
  const r = await bt.orchTools(c).get('soma_spawn')({ task_id: 'cr-1' });
  const after = Date.now();

  assert.equal(r.spawned, true);
  assert.equal(during?.status, 'spawned');
  assert.ok(Number.isFinite(during?.launching_at) && during.launching_at >= before && during.launching_at <= after,
    `the claimed row carries the launch mark, stamped at the claim (got ${during?.launching_at})`);
  // In the claim's own transaction: a status write with the mark following separately leaves a
  // moment in which the row is spawned, unmarked and sessionless — a dead lead to every reader.
  assert.deepEqual(tx.depths, [['spawned', 1]]);
  assert.equal(tx.commits[0].status, 'spawned');
  assert.equal(tx.commits[0].launching_at, during.launching_at);
  // Cleared by the write that names the session, never before it.
  assert.equal(tx.commits.length, 2, 'the claim and the record');
  assert.equal(tx.commits[1].lead_session_uuid, 'u-cr-1');
  assert.equal(tx.commits[1].launching_at, null);
});

test('a soma_spawn that fails clears the mark in the same write that puts the task back in the queue', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1' }] });
  let during = null;
  c.deps.spawnLead = () => {
    during = c.s.fleet.tasks[0].launching_at;
    throw Object.assign(new Error('fetch timed out'), { code: 'ETIMEDOUT' });
  };
  const tx = transactions(c, 'cr-1');
  const r = await bt.orchTools(c).get('soma_spawn')({ task_id: 'cr-1' });

  assert.equal(r.ok, false);
  assert.equal(r.requeued, true);
  assert.ok(Number.isFinite(during), 'the claim marked the row before the spawner ran');
  assert.equal(c.s.fleet.tasks[0].status, 'queued');
  assert.equal(c.s.fleet.tasks[0].launching_at, null, 'a queued row is not starting');
  // One write: the status back to queued and the mark gone together.
  assert.deepEqual(tx.depths, [['spawned', 1], ['queued', 1]]);
  assert.equal(tx.commits.at(-1).status, 'queued');
  assert.equal(tx.commits.at(-1).launching_at, null);
});

test('spawn will not admit a task without a transactional fleet, or without a spawner', async () => {
  const bt = await load();
  for (const dep of ['updateFleet', 'spawnLead']) {
    const c = orch({ tasks: [{ id: 'cr-1' }], deps: { [dep]: undefined } });
    const r = await bt.orchTools(c).get('soma_spawn')({ task_id: 'cr-1' });
    assert.equal(r.ok, false, dep);
    assert.equal(c.s.fleet.tasks[0].status, 'queued');
  }
});

test('a max_leads that is not a number is a refusal about max_leads, not a crash', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1' }], config: { max_leads: null, repos: {}, budgets: {} } });
  const r = await bt.orchTools(c).get('soma_spawn')({ task_id: 'cr-1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /max_leads/);
  assert.deepEqual(c.s.spawns, []);
});

// ---------------------------------------------------------------------------
// soma_status
// ---------------------------------------------------------------------------

test('a status row carries what the design asks a status row to carry', async () => {
  const bt = await load();
  const c = orch({
    tasks: [{ id: 'cr-1', status: 'spawned', title: 'fix the widget', repo: 'acme-app', harness: 'H2', budget_class: 'standard', lead_session_uuid: 'u1', tmux_session: 'lead-cr-1', pr_url: 'https://gh/pr/1' }],
    sessions: ['lead-cr-1'],
  });
  const r = await bt.orchTools(c).get('soma_status')({});
  const row = r.leads[0];
  assert.equal(row.lead, 'cr-1');
  assert.equal(row.status, 'spawned');
  assert.equal(row.liveness, 'alive');
  assert.equal(row.harness, 'H2');
  assert.equal(row.turns, 3);
  assert.equal(row.est_tokens, 500);
  assert.equal(row.budget_pct, 50);                       // 500 of the standard class's 1000
  assert.equal(row.model, 'claude-fable-5');
  assert.equal(row.heartbeat_age_ms, 1234);
  assert.equal(row.pr_url, 'https://gh/pr/1');
  assert.equal(row.tmux_target, 'lead-cr-1');
  assert.deepEqual(row.team, [{ title: 'claude lead-cr-1', dead: false }, { title: 'teammate-1', dead: true }]);
  assert.equal(r.watchdog_alive, false);
  assert.deepEqual(r.backpressure, { active: false, reason: null, since: null, until: null });
});

test('a status row carries the pane census, and liveness comes from the pane rather than the session name', async () => {
  const bt = await load();
  const since = Date.now() - 90_000;
  const c = orch({
    tasks: [
      { id: 'cr-1', status: 'spawned', lead_session_uuid: 'u1', tmux_session: 'lead-cr-1', pane_state: 'blocked_on_prompt', pane_state_since: since, pane_kind: 'permission', pane_cmd: '2.1.259' },
      { id: 'cr-2', status: 'done', tmux_session: 'lead-cr-2', pane_state: 'dead_shell', pane_state_since: since, pane_cmd: 'zsh' },
      { id: 'cr-3', status: 'spawned', tmux_session: 'lead-cr-3' },
    ],
    sessions: ['lead-cr-1', 'lead-cr-2', 'lead-cr-3'],          // `hasSession` says alive for all three
    deps: paneDeps(
      // cr-2 is the live ghost's shape: zsh under the spinner title tmux-resurrect restored with it.
      new Map([['lead-cr-1', paneOf({ cmd: '2.1.259' })], ['lead-cr-2', paneOf({ cmd: 'zsh', title: '◐ lead-task-7' })]]),
      (name) => (name === 'lead-cr-1' ? PROMPT_FRAME : IDLE_FRAME),
    ),
  });
  const r = await bt.orchTools(c).get('soma_status')({});
  const [a, b, d] = r.leads;
  assert.equal(a.pane_state, 'blocked_on_prompt');
  assert.equal(a.pane_fine, 'blocked_on_prompt');
  assert.equal(a.pane_kind, 'permission');
  assert.equal(a.pane_cmd, '2.1.259');
  assert.equal(a.pane_state_source, 'live');
  assert.ok(a.pane_state_age_ms >= 90_000 && a.pane_state_age_ms < 600_000, `the watchdog's clock on the recorded state, got ${a.pane_state_age_ms}`);
  assert.equal(a.liveness, 'alive', 'a prompt-blocked lead holds a live claude and its slot');
  // The 38-hour case: a done row whose pane is not what its status says. The status word is the
  // lifecycle word and stays; the pane field carries the disagreement.
  assert.equal(b.status, 'done');
  assert.equal(b.liveness, 'not-running');
  assert.equal(b.pane_state, 'dead_shell');
  assert.equal(b.pane_cmd, 'zsh');
  // cr-3: `hasSession` says alive, the pane listing has no such session. The name probe is what
  // reported a dead pane and a bare shell as alive before; the pane predicate decides now.
  assert.equal(d.liveness, 'absent');
  assert.equal(d.pane_state, 'absent');
  assert.equal(d.pane_state_age_ms, null);
  // No excerpt on a status row — the dialog text carries absolute paths — and no path anywhere.
  assert.equal('excerpt' in a, false);
  assert.ok(!/[/\\]/.test(JSON.stringify(r).replace(/https?:\/\//g, '')), 'no path may reach the model');
});

test('status liveness is unknown, never absent, when the pane could not be observed; an unwired bus falls back to the row and the name probe', async () => {
  const bt = await load();
  const unlisted = orch({ tasks: [{ id: 'cr-1', status: 'spawned', tmux_session: 'lead-cr-1' }], sessions: ['lead-cr-1'], deps: paneDeps(null, '') });
  const ru = await bt.orchTools(unlisted).get('soma_status')({});
  assert.equal(ru.leads[0].liveness, 'unknown');
  assert.equal(ru.leads[0].pane_state, 'unobservable');
  // Two-state collapse guard: a tmux hiccup must not render a working lead as gone.
  assert.notEqual(ru.leads[0].liveness, 'absent');
  const recorded = orch({ tasks: [{ id: 'cr-1', status: 'spawned', tmux_session: 'lead-cr-1', pane_state: 'alive', pane_state_since: Date.now() - 5000, pane_kind: null, pane_cmd: '2.1.263' }], sessions: ['lead-cr-1'] });
  const rr = await bt.orchTools(recorded).get('soma_status')({});
  assert.equal(rr.leads[0].pane_state, 'alive');
  assert.equal(rr.leads[0].pane_state_source, 'recorded');
  assert.equal(rr.leads[0].pane_fine, null);
  assert.equal(rr.leads[0].liveness, 'alive', 'no pane reader: the session-name probe still answers');
});

test('soma_status says starting for a lead whose spawn has claimed its row and not yet made its session; an unobservable pane, a live session and an expired mark read as before', async () => {
  const bt = await load();
  const marked = (age) => [{ id: 'cr-1', status: 'spawned', launching_at: Date.now() - age }];
  const rowOf = async (tasks, deps, sessions = []) => (await bt.orchTools(orch({ tasks, deps, sessions })).get('soma_status')({})).leads[0];

  // Thirty seconds into the fetch: tmux answers, and the lead's session is not on it yet.
  const starting = await rowOf(marked(30_000), paneDeps(new Map(), IDLE_FRAME));
  assert.equal(starting.liveness, 'starting');
  assert.equal(starting.pane_state, 'absent', 'the pane field still says what tmux said');
  assert.deepEqual(starting.team, [], 'no session, so no team to list');
  // A tmux hiccup is never `starting`: an unobservable pane is `unknown` whatever the row says.
  assert.equal((await rowOf(marked(30_000), paneDeps(null, ''))).liveness, 'unknown');
  // The session beats the mark: a record write that failed leaves a mark on a lead that is up.
  assert.equal((await rowOf(marked(30_000), paneDeps(new Map([['lead-cr-1', paneOf()]]), IDLE_FRAME), ['lead-cr-1'])).liveness, 'alive');
  // A pane that is THERE and dead, or a bare shell, is a lead that died, mark or no mark: only an
  // absent pane can be a launch that has not made its session yet.
  for (const [what, pane] of [['a dead pane', paneOf({ dead: true, cmd: 'env', title: '' })], ['a bare shell', paneOf({ cmd: 'zsh', title: '◐ lead-task-7' })]]) {
    const read = await rowOf(marked(30_000), paneDeps(new Map([['lead-cr-1', pane]]), ''), ['lead-cr-1']);
    assert.equal(read.liveness, 'absent', what);
  }
  // Past the bound the row reads as it did before the mark, `absent`, and it is revival's to deal with.
  assert.equal((await rowOf(marked(fleetMod.LAUNCH_GRACE_MS), paneDeps(new Map(), IDLE_FRAME))).liveness, 'absent');
  // Unmarked, as every row read before the mark existed.
  assert.equal((await rowOf([{ id: 'cr-1', status: 'spawned' }], paneDeps(new Map(), IDLE_FRAME))).liveness, 'absent');
});

test('soma_status without a pane reader: the session-name probe stands in, and a lead still launching is starting there too', async () => {
  const bt = await load();
  const marked = (age) => [{ id: 'cr-1', status: 'spawned', launching_at: Date.now() - age }];
  const livenessOf = async (tasks, sessions = [], deps = {}) => (await bt.orchTools(orch({ tasks, sessions, deps })).get('soma_status')({})).leads[0].liveness;
  assert.equal(await livenessOf(marked(30_000)), 'starting');
  assert.equal(await livenessOf(marked(30_000), ['lead-cr-1']), 'alive');
  assert.equal(await livenessOf(marked(fleetMod.LAUNCH_GRACE_MS)), 'absent');
  // A bus with no predicate wired keeps the old answer rather than guessing at one.
  assert.equal(await livenessOf(marked(30_000), [], { launching: undefined }), 'absent');
  // Only a running row is ever starting: a blocked or finished row is not-running, mark or no mark.
  assert.equal(await livenessOf([{ id: 'cr-1', status: 'blocked', launching_at: Date.now() - 30_000 }]), 'not-running');
});

// ---------------------------------------------------------------------------
// soma_status — seats (account rotation)
// ---------------------------------------------------------------------------

test('a status row carries seat: null for a lead spawned before seats existed — the ROW has no seat key, and the reply says null rather than dropping the field', async () => {
  const bt = await load();
  // `withoutKeys`, not `seat: null`: a pre-seats row has no such key, `cut` is what turns that
  // into an explicit `null`, and a `seat: task?.seat` that skipped `cut` would leave the field
  // off the reply entirely — "not reported" wearing the clothes of "no seat".
  const c = withoutKeys(orch({ tasks: [{ id: 'cr-1', status: 'spawned', tmux_session: 'lead-cr-1' }], sessions: ['lead-cr-1'] }), 'seat');
  const r = await bt.orchTools(c).get('soma_status')({});
  assert.equal(r.leads[0].seat, null);
});

test('a status row carries the seat label the row records', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1', status: 'spawned', tmux_session: 'lead-cr-1', seat: 'seat-b' }], sessions: ['lead-cr-1'] });
  const r = await bt.orchTools(c).get('soma_status')({});
  assert.equal(r.leads[0].seat, 'seat-b');
});

test('rotations_last_hour counts stamps inside the hour against the clock, not the row\'s length', async () => {
  const bt = await load();
  // The wall clock, because `statusRow` reads Date.now() and nothing here injects one. 61 min
  // old is out, 59 min old is in, a NaN is neither: the row was pruned at its last write, and
  // the write could have been an hour ago.
  const now = Date.now();
  const c = orch({ tasks: [{ id: 'cr-1', status: 'spawned', tmux_session: 'lead-cr-1', rotations: [now - 61 * 60_000, now - 59 * 60_000, now - 1000, Number.NaN] }], sessions: ['lead-cr-1'] });
  const r = await bt.orchTools(c).get('soma_status')({});
  assert.equal(r.leads[0].rotations_last_hour, 2);
});

test('rotations_last_hour is 0, not null, for a row whose rotations list is empty — "none" is a measurement here', async () => {
  const bt = await load();
  // The row `fleet.enqueue` writes today: the key is there and the list is empty.
  const c = orch({ tasks: [{ id: 'cr-1', status: 'spawned', tmux_session: 'lead-cr-1' }], sessions: ['lead-cr-1'] });
  const r = await bt.orchTools(c).get('soma_status')({});
  assert.equal(r.leads[0].rotations_last_hour, 0);
});

test('rotations_last_hour is 0, not null, for a row with NO rotations key — the row every live lead has today', async () => {
  const bt = await load();
  // The `: 0` fallback of `rotationsLastHour`, which the empty-list fixture above cannot reach:
  // `[].filter(…).length` is 0 by the other arm. Every row on a fleet that predates seats is this
  // row (it carries neither `seat` nor `rotations`), so the regression this refuses —
  // `rotations_last_hour: null`, "not measured", for a lead that has simply never rotated — is
  // the one every lead would show on the first tick after the merge.
  const c = withoutKeys(orch({ tasks: [{ id: 'cr-1', status: 'spawned', tmux_session: 'lead-cr-1' }], sessions: ['lead-cr-1'] }), 'rotations');
  const r = await bt.orchTools(c).get('soma_status')({});
  assert.equal(r.leads[0].rotations_last_hour, 0);
});

test('the reply carries the seat pool as labels only — a seat\'s config_dir is a path and never reaches the model', async () => {
  const bt = await load();
  // The limit fixture's reset (2015-08-24T16:30Z, in ms): `closed_until` passes through untouched.
  const until = 1_440_433_800_000;
  const c = orch({ tasks: [], deps: { seatsSummary: () => ({
    configured: 3,
    open: [{ label: 'seat-a', config_dir: '/Users/x/.cfg-a' }],
    closed: [{ label: 'seat-b', config_dir: '/Users/x/.cfg-b', closed_until: until, closed_reason: 'five_hour' }],
    unverified: [{ label: 'seat-c', config_dir: '/Users/x/.cfg-c' }],
    unreadable: false, why: null,
  }) } });
  const r = await bt.orchTools(c).get('soma_status')({});
  // The path check first, so a reply that spread the summary fails on the claim that matters.
  assert.ok(!JSON.stringify(r).includes('/Users'), 'no path may reach the model');
  assert.deepEqual(r.seats, {
    configured: 3, open: ['seat-a'],
    closed: [{ label: 'seat-b', closed_until: until, closed_reason: 'five_hour' }],
    unverified: ['seat-c'], unreadable: false,
  });
});

test('seats is null when this bus has no seat reader wired — "not reported", never "no seats"', async () => {
  const bt = await load();
  const c = orch({ tasks: [] });
  delete c.deps.seatsSummary;
  const r = await bt.orchTools(c).get('soma_status')({});
  assert.equal(r.seats, null);
});

test('a seat reader that throws reads as unreadable with nothing open', async () => {
  const bt = await load();
  const c = orch({ tasks: [], deps: { seatsSummary: () => { throw new Error('EACCES: seats'); } } });
  const r = await bt.orchTools(c).get('soma_status')({});
  assert.deepEqual([r.seats.unreadable, r.seats.open, r.seats.configured], [true, [], null]);
});

test('a seat reader that throws leaks no filesystem path into the reply', async () => {
  const bt = await load();
  // A PIN, and it needs its own test rather than an entry in the whole-surface path list.
  // MEASURED: in `no refusal on the whole surface names a filesystem path` EVERY dep throws,
  // `readFleet` included, so `soma_status` refuses at `fleetOf()` and never calls
  // `seatsSummary` — the name is in that list for the day the surface changes, but nothing
  // there can fail because of it. The fleet has to READ for this claim to be reachable.
  const c = orch({ tasks: [], deps: { seatsSummary: () => { throw new Error('ENOENT: no such file or directory, open \'/Users/someone/.soma/state/seats.json\''); } } });
  const r = await bt.orchTools(c).get('soma_status')({});
  assert.ok(!JSON.stringify(r).includes('.soma'), JSON.stringify(r.seats));
});

test('a reader that says unreadable is passed through as unreadable, with the count it could still give', async () => {
  const bt = await load();
  const c = orch({ tasks: [], deps: { seatsSummary: () => ({ configured: 2, open: [], closed: [], unverified: [], unreadable: true, why: 'state/seats.json could not be read' }) } });
  const r = await bt.orchTools(c).get('soma_status')({});
  assert.deepEqual([r.seats.unreadable, r.seats.configured], [true, 2]);
});

test('a reader that says unreadable AND names open seats has the seats dropped — an unreadable pool claims nothing open', async () => {
  const bt = await load();
  // The invariant `seats-summary` promises upstream, held HERE too, because this is the shape
  // the model reads. An unreadable pool that still listed `open: ['seat-a']` would be the
  // could-not-observe state wearing the answer's clothes.
  const c = orch({ tasks: [], deps: { seatsSummary: () => ({
    configured: 2, open: [{ label: 'seat-a', config_dir: '/x' }], closed: [], unverified: [], unreadable: true, why: 'state/seats.json could not be read',
  }) } });
  const r = await bt.orchTools(c).get('soma_status')({});
  assert.deepEqual(r.seats.open, []);
});

test('an unreadable flag that is neither true nor false is not a reading — it reads unreadable, never "readable"', async () => {
  const bt = await load();
  // Three states, not two: a flag this function cannot interpret is no evidence that the pool
  // was read. `=== true` alone would answer `unreadable: false` here — garbage as the
  // safe-looking answer, which is this project's characteristic defect.
  const c = orch({ tasks: [], deps: { seatsSummary: () => ({
    configured: 2, open: [{ label: 'seat-a', config_dir: '/x' }], closed: [], unverified: [], unreadable: 'yes',
  }) } });
  const r = await bt.orchTools(c).get('soma_status')({});
  assert.equal(r.seats.unreadable, true);
});

test('a seat reader that answers something that is not a record reads as unreadable, never as an empty pool', async () => {
  const bt = await load();
  // "No seats configured" and "I could not read the pool" are different answers, and only one
  // of them is safe to act on. Not reachable through `realDeps` today; the claim is the
  // function's own, and nothing else held it.
  const c = orch({ tasks: [], deps: { seatsSummary: () => 'no seats' } });
  const r = await bt.orchTools(c).get('soma_status')({});
  assert.deepEqual(r.seats, { configured: null, open: [], closed: [], unverified: [], unreadable: true });
});

test('a pool larger than the reply\'s cap is truncated at 32 labels while configured keeps the true count', async () => {
  const bt = await load();
  // `MAX_SEATS` bounds what one reply names per bucket; `configured` is not bounded, so the two
  // together are how a reader sees that it is not looking at the whole pool. No realistic pool
  // reaches 33 seats — the cap is a bound on the reply's size, and an unbounded list is what it
  // exists to refuse.
  const open = Array.from({ length: 33 }, (_, i) => ({ label: `seat-${i}`, config_dir: `/x/${i}` }));
  const c = orch({ tasks: [], deps: { seatsSummary: () => ({ configured: 33, open, closed: [], unverified: [], unreadable: false }) } });
  const r = await bt.orchTools(c).get('soma_status')({});
  assert.deepEqual([r.seats.open.length, r.seats.configured], [32, 33]);
});

test('a closed seat whose closed_until is not a finite number reads null — "not measured", not a date', async () => {
  const bt = await load();
  const c = orch({ tasks: [], deps: { seatsSummary: () => ({
    configured: 1, open: [], closed: [{ label: 'seat-b', config_dir: '/x', closed_until: 'soon', closed_reason: 'five_hour' }], unverified: [], unreadable: false,
  }) } });
  const r = await bt.orchTools(c).get('soma_status')({});
  assert.equal(r.seats.closed[0].closed_until, null);
});

test('a seat whose label is not a usable string is left out of the labels, never reported as a literal null', async () => {
  const bt = await load();
  // `loadSeats` always supplies a string (it defaults to the dir's basename), so this is the
  // hand-edited / rewired case; a `null` inside `open` would read to the model as a seat named
  // nothing rather than as a row it could not name.
  const c = orch({ tasks: [], deps: { seatsSummary: () => ({
    configured: 2, open: [{ label: null, config_dir: '/x' }, { label: 'seat-a', config_dir: '/y' }], closed: [], unverified: [], unreadable: false,
  }) } });
  const r = await bt.orchTools(c).get('soma_status')({});
  assert.deepEqual(r.seats.open, ['seat-a']);
});

test('a finished, failed or blocked lead still appears in status', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1', status: 'done' }, { id: 'cr-2', status: 'failed' }, { id: 'cr-3', status: 'blocked' }, { id: 'cr-4' }] });
  const r = await bt.orchTools(c).get('soma_status')({});
  assert.deepEqual(r.leads.map((x) => x.lead), ['cr-1', 'cr-2', 'cr-3']);
  assert.deepEqual(r.queue, ['cr-4']);
  assert.deepEqual(r.counts, { done: 1, failed: 1, blocked: 1, queued: 1 });
  assert.deepEqual(r.leads.map((x) => x.liveness), ['not-running', 'not-running', 'not-running']);
});

test('status for one lead answers about that lead, whatever its state', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1', status: 'done' }, { id: 'cr-2' }] });
  const tools = bt.orchTools(c);
  const one = await tools.get('soma_status')({ lead: 'cr-1' });
  assert.deepEqual(one.leads.map((x) => x.lead), ['cr-1']);
  const q = await tools.get('soma_status')({ lead: 'cr-2' });
  assert.deepEqual(q.leads.map((x) => x.lead), ['cr-2']);
  const none = await tools.get('soma_status')({ lead: 'cr-9' });
  assert.equal(none.ok, false);
});

test('status names the recorded tmux session, not a guess, when the row has one', async () => {
  const bt = await load();
  const probed = [];
  const c = orch({
    tasks: [{ id: 'cr-1', status: 'spawned', tmux_session: 'lead-cr-1-r2' }],
    deps: { hasSession: (n) => { probed.push(n); return true; } },
  });
  const r = await bt.orchTools(c).get('soma_status')({});
  assert.equal(r.leads[0].tmux_target, 'lead-cr-1-r2');
  assert.ok(probed.includes('lead-cr-1-r2'));
});

test('a lead with no recorded session, or a broken usage read, still yields a row', async () => {
  const bt = await load();
  const c = orch({
    tasks: [{ id: 'cr-1', status: 'spawned', lead_session_uuid: 'u1' }],
    sessions: ['lead-cr-1'],
    deps: {
      readUsage: () => { throw new Error("ENOENT open '/Users/x/.claude/projects/p/u1.jsonl'"); },
      listPanes: () => { throw new Error('tmux killed by SIGKILL after 5000ms'); },
      heartbeatAgeMs: () => { throw new Error('ENOENT /Users/x/.soma/heartbeats/cr-1'); },
      hasSession: () => { throw new Error('tmux is not on PATH'); },
    },
  });
  const r = await bt.orchTools(c).get('soma_status')({});
  assert.equal(r.leads.length, 1);
  assert.equal(r.leads[0].turns, null);
  assert.equal(r.leads[0].est_tokens, null);
  assert.equal(r.leads[0].liveness, 'absent');
  assert.deepEqual(r.leads[0].team, []);
  assert.equal(r.leads[0].heartbeat_age_ms, null);
  assert.ok(!/[/\\]/.test(JSON.stringify(r).replace(/https?:\/\//g, '')), 'no path may reach the model');
});

test('a checkpoint that cannot be read is a refusal that does not name it', async () => {
  const bt = await load();
  const c = orch({ deps: { readFleet: () => { throw new Error('/Users/x/.soma/state/fleet.json is not a fleet checkpoint'); } } });
  const r = await bt.orchTools(c).get('soma_status')({});
  assert.equal(r.ok, false);
  assert.ok(!/[/\\]/.test(r.error), r.error);
});

test('status tells a candidate who owns the fleet and whether that claim is stale', async () => {
  const bt = await load();
  const c = orch({ lease: liveLease(), env: { SOMA_ROLE: 'candidate' } });
  const r = await bt.candidateTools(c).get('soma_status')({});
  assert.equal(r.lease.session_id, 'S0');
  assert.equal(r.lease.wake, 'tmux');
  assert.equal(r.lease_stale, false);
});

test('a hand-edited lease or task row cannot flood the model through status', async () => {
  const bt = await load();
  const c = orch({
    tasks: [{ id: 'cr-1', status: 'spawned', title: 'T'.repeat(9000), pr_url: 'u'.repeat(9000), harness: 'H'.repeat(9000), budget_class: 'b'.repeat(9000) }],
    lease: liveLease({ session_id: 'S'.repeat(9000), tmux_pane: '%'.repeat(9000) }),
    usage: { est_tokens: 1, turns: 1, last_model: 'm'.repeat(9000) },
    sessions: ['lead-cr-1'],
    deps: { listPanes: () => Array.from({ length: 500 }, (_, i) => ({ index: i, dead: false, title: 't'.repeat(500) })) },
  });
  const r = await bt.orchTools(c).get('soma_status')({});
  assert.ok(JSON.stringify(r).length < 8000, `${JSON.stringify(r).length} chars`);
});

// ---------------------------------------------------------------------------
// soma_inbox
// ---------------------------------------------------------------------------

test('the inbox parks its cursor on the last event it actually returned', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1' }], events: Array.from({ length: 10 }, () => ({ type: 'MILESTONE' })) });
  const r = await bt.orchTools(c).get('soma_inbox')({ limit: 4 });
  assert.equal(r.events.length, 4);
  assert.equal(r.remaining, 6);
  assert.equal(c.s.cursors.orch, r.events[3].id);
  const next = await bt.orchTools(c).get('soma_inbox')({ limit: 4 });
  assert.deepEqual(next.events.map((e) => e.id), c.s.events.slice(4, 8).map((e) => e.id));
});

test('the inbox cursor is the orchestrator own, never the inject hook one', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1' }], events: [{ type: 'COMPLETED' }] });
  await bt.orchTools(c).get('soma_inbox')({});
  assert.deepEqual(Object.keys(c.s.cursors), ['orch']);
});

test('mark_read false leaves the mail unread, and a failed cursor write says so', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1' }], events: [{ type: 'COMPLETED' }] });
  const r = await bt.orchTools(c).get('soma_inbox')({ mark_read: false });
  assert.equal(r.events.length, 1);
  assert.equal(r.marked_read, false);
  assert.deepEqual(c.s.cursors, {});

  const broken = orch({ tasks: [{ id: 'cr-1' }], events: [{ type: 'COMPLETED' }], deps: { writeCursor: () => { throw new Error('EACCES /Users/x/.soma/events/.cursors.json'); } } });
  const r2 = await bt.orchTools(broken).get('soma_inbox')({});
  assert.equal(r2.events.length, 1, 'a cursor failure re-delivers; it never loses');
  assert.equal(r2.marked_read, false);
  assert.ok(!/[/\\]/.test(JSON.stringify(r2)));
});

test('the inbox limit is bounded, defaulted, and cannot be talked into dumping the log', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1' }], events: Array.from({ length: 400 }, () => ({ type: 'MILESTONE' })) });
  const tools = bt.orchTools(c);
  assert.equal((await tools.get('soma_inbox')({ mark_read: false })).events.length, 50);
  assert.equal((await tools.get('soma_inbox')({ mark_read: false, limit: 1e9 })).events.length, 200);
  assert.equal((await tools.get('soma_inbox')({ mark_read: false, limit: 'lots' })).events.length, 50);
  assert.equal((await tools.get('soma_inbox')({ mark_read: false, limit: 0 })).events.length, 50);
  assert.equal((await tools.get('soma_inbox')({ mark_read: false, limit: '7' })).events.length, 7);
});

test('the inbox sweeps every lead stream plus orch, even with no eventStreams wired', async () => {
  const bt = await load();
  const seen = [];
  const c = orch({
    tasks: [{ id: 'cr-1' }, { id: 'cr-2' }],
    deps: { eventStreams: undefined, unread: (consumer, streams) => { seen.push([consumer, streams]); return []; } },
  });
  await bt.orchTools(c).get('soma_inbox')({});
  assert.deepEqual(seen, [['orch', ['cr-1', 'cr-2', 'orch']]]);
});

test('a HARNESS event folds the canonical harness onto the task row, transactionally', async () => {
  const bt = await load();
  const c = orch({
    tasks: [{ id: 'cr-1', status: 'spawned' }],
    events: [{ type: 'HARNESS', lead: 'cr-1', payload: { harness_id: 'h2 — the suite already runs', plan_summary: 'p' } }],
  });
  const r = await bt.orchTools(c).get('soma_inbox')({});
  assert.equal(r.folded, 1);
  assert.equal(c.s.fleet.tasks[0].harness, 'H2', 'the registry spelling, not the lead prose');
  assert.equal(c.s.fleet.tasks[0].budget_class, 'iterate');
  assert.equal(c.s.updates, 1, 'through updateFleet, once');
  // and the status column is no longer permanently null
  assert.equal((await bt.orchTools(c).get('soma_status')({ lead: 'cr-1' })).leads[0].harness, 'H2');
});

test('a refused or unvalidatable harness is not folded at all', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1' }], events: [{ type: 'HARNESS', lead: 'cr-1', payload: { harness_id: 'constructor' } }] });
  const r = await bt.orchTools(c).get('soma_inbox')({});
  assert.equal(r.folded, 0);
  assert.equal(c.s.fleet.tasks[0].harness, undefined);
  assert.equal(c.s.updates, 0);
});

test('an operator-chosen budget class survives the fold', async () => {
  const bt = await load();
  const c = orch({
    // A row enqueued with `budget_class: 'research'` since `budget_override` exists: `fleet.enqueue`
    // writes the class into both fields, and the pin is what the fold defers to.
    tasks: [{ id: 'cr-1', budget_class: 'research', budget_override: 'research' }],
    events: [{ type: 'HARNESS', lead: 'cr-1', payload: { harness_id: 'H2' } }],
  });
  await bt.orchTools(c).get('soma_inbox')({});
  assert.equal(c.s.fleet.tasks[0].harness, 'H2');
  assert.equal(c.s.fleet.tasks[0].budget_class, 'research');
});

test('a superseding HARNESS moves the row\'s class to the new harness\'s when nobody pinned one', async () => {
  const bt = await load();
  // The documented H1 -> H4 degrade, after the first report was drained. Left at `standard`, the
  // row shows a review lead's spend against standard's cap in `soma_status`, and nothing on it
  // could tell that class from an operator's pin.
  const c = orch({
    tasks: [{ id: 'cr-1', status: 'spawned', harness: 'H1', budget_class: 'standard' }],
    events: [{ type: 'HARNESS', lead: 'cr-1', payload: { harness_id: 'H4 — the review loop' } }],
  });
  const r = await bt.orchTools(c).get('soma_inbox')({});
  assert.equal(r.folded, 1);
  assert.equal(c.s.fleet.tasks[0].harness, 'H4');
  assert.equal(c.s.fleet.tasks[0].budget_class, 'review');
});

test('a pinned class survives a superseding HARNESS, and a drain with nothing else to say writes nothing', async () => {
  const bt = await load();
  const c = orch({
    tasks: [{ id: 'cr-1', status: 'spawned', harness: 'H1', budget_class: 'babysit', budget_override: 'babysit' }],
    events: [{ type: 'HARNESS', lead: 'cr-1', payload: { harness_id: 'H4' } }],
  });
  const r = await bt.orchTools(c).get('soma_inbox')({});
  assert.equal(r.folded, 1, 'the harness still moves');
  assert.equal(c.s.fleet.tasks[0].harness, 'H4');
  assert.equal(c.s.fleet.tasks[0].budget_class, 'babysit');

  // The harness already matches and the pin outranks the harness's class: the row disagrees with
  // nothing, so `updateFleet` is not paid for.
  const still = orch({
    tasks: [{ id: 'cr-1', status: 'spawned', harness: 'H4', budget_class: 'babysit', budget_override: 'babysit' }],
    events: [{ type: 'HARNESS', lead: 'cr-1', payload: { harness_id: 'H4' } }],
  });
  const again = await bt.orchTools(still).get('soma_inbox')({});
  assert.equal(again.folded, 0);
  assert.equal(still.s.updates, 0);
});

test('a supersede across two separate drains moves the class with the harness, and the fold never writes a pin', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1', status: 'spawned' }], events: [{ type: 'HARNESS', lead: 'cr-1', payload: { harness_id: 'H1' } }] });
  const tools = bt.orchTools(c);
  assert.equal((await tools.get('soma_inbox')({})).folded, 1);
  assert.equal(c.s.fleet.tasks[0].budget_class, 'standard');

  // The documented degrade, filed after the first report was drained and marked read.
  const ts = T0 + 5000;
  c.s.events.push({ id: `${ts}-0009`, ts, type: 'HARNESS', lead: 'cr-1', payload: { harness_id: 'H4' } });
  assert.equal((await tools.get('soma_inbox')({})).folded, 1);
  assert.equal(c.s.fleet.tasks[0].harness, 'H4');
  assert.equal(c.s.fleet.tasks[0].budget_class, 'review');
  assert.equal(c.s.fleet.tasks[0].budget_override, null, 'only fleet.enqueue writes the pin');
});

test('a row the old fold left behind has its class corrected by the next report, though its harness has not moved', async () => {
  const bt = await load();
  // What the fold before `budget_override` left after an H1 -> H4 supersede: the harness moved,
  // the class did not, and the row has no `budget_override` key at all. When the lead next reports
  // H4 (a re-report, or a re-delivery the cursor did not get past), the class is the ONLY thing the
  // row disagrees with, so the transaction has to open for it alone.
  const c = withoutKeys(orch({
    tasks: [{ id: 'cr-1', status: 'spawned', harness: 'H4', budget_class: 'standard' }],
    events: [{ type: 'HARNESS', lead: 'cr-1', payload: { harness_id: 'H4' } }],
  }), 'budget_override');
  const r = await bt.orchTools(c).get('soma_inbox')({});
  assert.equal(r.folded, 1);
  assert.equal(c.s.updates, 1);
  assert.equal(c.s.fleet.tasks[0].budget_class, 'review');
  assert.equal(Object.hasOwn(c.s.fleet.tasks[0], 'budget_override'), false, 'a missing pin is no pin, and the fold does not invent one');
});

test('a COMPLETED event folds its PR url onto the row', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1', status: 'spawned' }], events: [{ type: 'COMPLETED', lead: 'cr-1', payload: { summary: 's', pr_url: 'https://github.com/a/b/pull/9' } }] });
  await bt.orchTools(c).get('soma_inbox')({});
  assert.equal(c.s.fleet.tasks[0].pr_url, 'https://github.com/a/b/pull/9');
});

test('nothing new to fold means no fleet write at all', async () => {
  const bt = await load();
  const c = orch({
    tasks: [{ id: 'cr-1', harness: 'H2', budget_class: 'iterate', pr_url: 'u' }],
    events: [{ type: 'HARNESS', lead: 'cr-1', payload: { harness_id: 'H2' } }, { type: 'MILESTONE' }, { type: 'COMPLETED', lead: 'cr-1', payload: { pr_url: 'u' } }],
  });
  const r = await bt.orchTools(c).get('soma_inbox')({});
  assert.equal(r.events.length, 3);
  assert.equal(c.s.updates, 0);
});

test('a fold that fails still delivers the mail', async () => {
  const bt = await load();
  const c = orch({
    tasks: [{ id: 'cr-1' }],
    events: [{ type: 'HARNESS', lead: 'cr-1', payload: { harness_id: 'H2' } }],
    deps: { updateFleet: () => { throw new Error('fleet.lock: /Users/x/.soma/state/fleet.lock held by pid 9'); } },
  });
  const r = await bt.orchTools(c).get('soma_inbox')({});
  assert.equal(r.events.length, 1);
  assert.equal(r.folded, 0);
  assert.equal(c.s.cursors.orch, c.s.events[0].id);
  assert.ok(!/[/\\]/.test(JSON.stringify(r)));
});

test('a fold cannot be steered at another stream by a forged lead field', async () => {
  const bt = await load();
  const c = orch({
    tasks: [{ id: 'cr-1' }],
    events: [{ type: 'HARNESS', lead: '../../etc/passwd', payload: { harness_id: 'H2' } }, { type: 'HARNESS', lead: 'orch', payload: { harness_id: 'H2' } }],
    deps: { unread: () => c.s.events },
  });
  const r = await bt.orchTools(c).get('soma_inbox')({});
  assert.equal(r.folded, 0);
  assert.equal(c.s.updates, 0);
});

test('an unreadable event log is a refusal that names no file', async () => {
  const bt = await load();
  const c = orch({ deps: { unread: () => { throw Object.assign(new Error("EACCES: open '/Users/x/.soma/events/cr-1.ndjson'"), { code: 'EACCES' }); } } });
  const r = await bt.orchTools(c).get('soma_inbox')({});
  assert.equal(r.ok, false);
  assert.ok(!/[/\\]/.test(r.error), r.error);
  assert.ok(!r.error.includes('ndjson'));
});

// ---------------------------------------------------------------------------
// soma_send
// ---------------------------------------------------------------------------

test('a message that did not land is not reported as delivered', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1', status: 'spawned' }] });    // no tmux session for it
  const r = await bt.orchTools(c).get('soma_send')({ lead: 'cr-1', message: 'answer: yes' });
  assert.equal(r.delivered, false);
  assert.match(r.error, /cr-1/);
  assert.equal(c.s.keys.length, 1);
});

test('a message to a live lead is typed into its pane and submitted once', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1', status: 'spawned' }], sessions: ['lead-cr-1'] });
  const r = await bt.orchTools(c).get('soma_send')({ lead: 'cr-1', message: 'use develop, not main' });
  assert.equal(r.delivered, true);
  assert.deepEqual(c.s.keys, [{ target: 'lead-cr-1', line: 'use develop, not main' }]);
});

test('a multi-line answer is delivered as one turn, and control bytes never reach the composer', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1', status: 'spawned' }], sessions: ['lead-cr-1'] });
  await bt.orchTools(c).get('soma_send')({ lead: 'cr-1', message: 'line one\nline two\r\n\tthird\u001b[2Dand an escape' });
  const { line } = c.s.keys[0];
  assert.ok(!/[\n\r\t\u001b]/.test(line), JSON.stringify(line));
  assert.equal(line, 'line one line two third [2Dand an escape');
});

test('an unbounded message is clamped before it is typed', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1', status: 'spawned' }], sessions: ['lead-cr-1'] });
  const r = await bt.orchTools(c).get('soma_send')({ lead: 'cr-1', message: 'x'.repeat(50_000) });
  assert.equal(r.delivered, true);
  assert.equal(r.clamped, true);
  assert.ok(c.s.keys[0].line.length <= 2000, c.s.keys[0].line.length);
});

// ---------------------------------------------------------------------------
// soma_send: the pane gate. Measured on a live dialog: `send-keys -l` is swallowed
// and the Enter selects the highlighted "1. Yes" — so a send into a prompt-blocked pane is a
// blind approval. Into a bare shell the message EXECUTES; into a dead pane tmux exits 0.
// ---------------------------------------------------------------------------

const RULE = '─'.repeat(80);
const IDLE_FRAME = [RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'].join('\n');
const PROMPT_FRAME = [
  RULE, ' Bash command', '', '   │ cd /w/a && grep -n x somefile.txt', '',
  ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel · Tab to amend',
].join('\n');
/** A `tmux.paneStates()` record for a live claude pane (`pane_current_command` is the version string). */
/**
 * An AskUserQuestion frame (Claude Code 2.1.263): the live dialog's layout with neutral words, option
 * descriptions shortened. Its footer carries a slash (`Tab/Arrow keys`), so it doubles as the
 * fixture for "no path-shaped character may reach the model" on a refusal.
 */
const QUESTION_FRAME = [
  '│ paragraph. May I update the README?', '',
  '❯ 1. Yes — update the README', '     Rewrite the paragraph so it states the new default and links the changelog.',
  '  2. Yes, but show me the diff first', '  3. Not yet — leave the README', '  4. Type something.',
  RULE, '  5. Chat about this', '', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
].join('\n');
const paneOf = (over = {}) => ({
  dead: false, cmd: '2.1.263', pid: 1, title: '✳ Claude Code', pane_id: '%9', active: true,
  panes: [{ pane_id: '%9', dead: false, cmd: '2.1.263', pid: 1, title: '✳ Claude Code', active: true }],
  ...over,
});
/**
 * The two pane deps `soma-bus.mjs` wires, built the way it builds them — from the real
 * `readPane` over a listing and a screen reader — because `bus-tools.mjs` is import-free and
 * consumes the READING, not the classifier. `frame` may be a string or a function of the target.
 */
const { readPane } = await import('../bin/lib/wd/pane-state.mjs');
const paneDeps = (panes, frame) => ({
  paneStates: () => panes,
  paneReading: (target, listing) => readPane(target, {
    panes: listing === undefined ? panes : listing,
    capture: (t) => (typeof frame === 'function' ? frame(t) : frame),
  }),
});

test('soma_send refuses to type into a prompt-blocked pane, because Enter approves the pending command', async () => {
  const bt = await load();
  const c = orch({
    tasks: [{ id: 'cr-1', status: 'spawned' }], sessions: ['lead-cr-1'],
    deps: paneDeps(new Map([['lead-cr-1', paneOf({ cmd: '2.1.259', title: '✳ Claude Code' })]]), PROMPT_FRAME),
  });
  const r = await bt.orchTools(c).get('soma_send')({ lead: 'cr-1', message: 'answer: yes' });
  assert.equal(r.delivered, false);
  assert.equal(r.refused, true);
  assert.equal(r.pane_state, 'blocked_on_prompt');
  assert.equal(r.pane_kind, 'permission');
  assert.match(r.error, /approve/i);
  assert.deepEqual(c.s.keys, [], 'not one keystroke');
  // The dialog quotes the pending command, which carries absolute paths; none may reach the model.
  assert.ok(!/[/\\]/.test(JSON.stringify(r)), JSON.stringify(r));
  // `force:true` is the caller saying "I have looked at the pane": it types, and still reports what it saw.
  const forced = await bt.orchTools(c).get('soma_send')({ lead: 'cr-1', message: 'answer: yes', force: true });
  assert.equal(forced.delivered, true);
  assert.equal(forced.pane_state, 'blocked_on_prompt');
  assert.equal(c.s.keys.length, 1);
});

test('soma_send refuses the AskUserQuestion dialog — a live spawned lead sat on one while the gate read it as unrecognised and typed', async () => {
  const bt = await load();
  // Same select-list UI as the permission dialog, option 1 highlighted: the literal is swallowed
  // and the Enter would answer the lead's question blind. The frame was measured on the fleet;
  // the keystroke was not sent into it, on purpose.
  const c = orch({
    tasks: [{ id: 'cr-1', status: 'spawned' }], sessions: ['lead-cr-1'],
    deps: paneDeps(new Map([['lead-cr-1', paneOf({ title: '✳ Claude Code' })]]), QUESTION_FRAME),
  });
  const r = await bt.orchTools(c).get('soma_send')({ lead: 'cr-1', message: 'go with option 1' });
  assert.equal(r.delivered, false);
  assert.equal(r.refused, true);
  assert.equal(r.pane_state, 'blocked_on_prompt');
  assert.equal(r.pane_kind, 'question');
  assert.notEqual(r.pane_state, 'unrecognised', 'the critical failure class: a dialog read as a shrug, and typed into with delivered: true');
  assert.match(r.error, /question/i, 'the refusal names the kind, so the orchestrator knows the lead is ASKING, not asking permission');
  assert.equal(r.warning, undefined);
  assert.deepEqual(c.s.keys, [], 'not one keystroke');
  // The footer on screen is `Tab/Arrow keys`; nothing of it may reach the model.
  assert.ok(!/[/\\]/.test(JSON.stringify(r)), JSON.stringify(r));
  // A footer with no composer and no known question is still refused — as a dialog of unknown kind.
  const odd = orch({
    tasks: [{ id: 'cr-1', status: 'spawned' }], sessions: ['lead-cr-1'],
    deps: paneDeps(new Map([['lead-cr-1', paneOf()]]), QUESTION_FRAME.replace('Enter to select · Tab/Arrow keys to navigate · ', '')),
  });
  const ro = await bt.orchTools(odd).get('soma_send')({ lead: 'cr-1', message: 'hi' });
  assert.equal(ro.refused, true);
  assert.equal(ro.pane_state, 'blocked_on_prompt');
  assert.equal(ro.pane_kind, 'unknown');
  assert.deepEqual(odd.s.keys, []);
});

test('soma_send refuses a bare shell and a dead pane, each in its own words', async () => {
  const bt = await load();
  // Measured: `send-keys -l -- 'Operator: hello…'` then Enter into a zsh pane printed
  // `zsh: command not found: Operator:` — the symptom seen live, byte for byte.
  const shell = orch({ tasks: [{ id: 'cr-1', status: 'done' }], sessions: ['lead-cr-1'], deps: paneDeps(new Map([['lead-cr-1', paneOf({ cmd: 'zsh', title: '' })]]), '') });
  const rs = await bt.orchTools(shell).get('soma_send')({ lead: 'cr-1', message: 'Operator: hello, this is your brief' });
  assert.equal(rs.delivered, false);
  assert.equal(rs.pane_state, 'dead_shell');
  assert.match(rs.error, /execut/i);
  assert.deepEqual(shell.s.keys, []);
  // Measured: send-keys into a dead pane exits 0 for both calls, so `landed()` would say delivered.
  const dead = orch({ tasks: [{ id: 'cr-1', status: 'spawned' }], sessions: ['lead-cr-1'], deps: paneDeps(new Map([['lead-cr-1', paneOf({ dead: true, cmd: 'env', title: '' })]]), '') });
  const rd = await bt.orchTools(dead).get('soma_send')({ lead: 'cr-1', message: 'hi' });
  assert.equal(rd.delivered, false);
  assert.equal(rd.pane_state, 'dead_pane');
  assert.deepEqual(dead.s.keys, []);
  assert.notEqual(rs.error, rd.error, 'two different hazards must not read identically');
});

test('soma_send says when it could not see the pane, rather than typing blind or claiming delivery', async () => {
  const bt = await load();
  // The listing failed: the bus cannot rule out a dialog. Refused — the recoverable direction —
  // with the override named, because typing blind into a dialog is the unrecoverable one.
  const unlisted = orch({ tasks: [{ id: 'cr-1', status: 'spawned' }], sessions: ['lead-cr-1'], deps: paneDeps(null, IDLE_FRAME) });
  const ru = await bt.orchTools(unlisted).get('soma_send')({ lead: 'cr-1', message: 'hi' });
  assert.equal(ru.delivered, false);
  assert.equal(ru.pane_state, 'unobservable');
  assert.match(ru.error, /force/);
  assert.deepEqual(unlisted.s.keys, []);
  // A capture that came back empty for a live claude pane is the same non-verdict.
  const blank = orch({ tasks: [{ id: 'cr-1', status: 'spawned' }], sessions: ['lead-cr-1'], deps: paneDeps(new Map([['lead-cr-1', paneOf()]]), '') });
  const rb = await bt.orchTools(blank).get('soma_send')({ lead: 'cr-1', message: 'hi' });
  assert.equal(rb.pane_state, 'unobservable');
  assert.equal(rb.delivered, false);
  assert.deepEqual(blank.s.keys, []);
  // A session that is not in the listing at all is `absent`: said before tmux is asked.
  const absent = orch({ tasks: [{ id: 'cr-1', status: 'spawned' }], deps: paneDeps(new Map(), '') });
  const ra = await bt.orchTools(absent).get('soma_send')({ lead: 'cr-1', message: 'hi' });
  assert.equal(ra.pane_state, 'absent');
  assert.equal(ra.delivered, false);
  assert.deepEqual(absent.s.keys, []);
  // Three refusals, three different sentences.
  assert.equal(new Set([ru.error, rb.error, ra.error]).size, 3, JSON.stringify([ru.error, rb.error, ra.error]));
});

test('soma_send types into an idle pane and reports what it saw; an unrecognised pane is typed with a warning', async () => {
  const bt = await load();
  const idle = orch({ tasks: [{ id: 'cr-1', status: 'spawned' }], sessions: ['lead-cr-1'], deps: paneDeps(new Map([['lead-cr-1', paneOf()]]), IDLE_FRAME) });
  const ri = await bt.orchTools(idle).get('soma_send')({ lead: 'cr-1', message: 'hi' });
  assert.equal(ri.delivered, true);
  assert.equal(ri.pane_state, 'alive');
  assert.equal(ri.pane_fine, 'idle');
  assert.equal(idle.s.keys.length, 1);
  // Unrecognised is a reading (the frame was seen, it matched nothing), not a hazard the census
  // has measured, so it is typed — with the reading attached so a refusal habit cannot form
  // around a Claude Code wording change.
  const odd = orch({ tasks: [{ id: 'cr-1', status: 'spawned' }], sessions: ['lead-cr-1'], deps: paneDeps(new Map([['lead-cr-1', paneOf({ cmd: 'node' })]]), 'something else entirely') });
  const ro = await bt.orchTools(odd).get('soma_send')({ lead: 'cr-1', message: 'hi' });
  assert.equal(ro.delivered, true);
  assert.equal(ro.pane_state, 'unrecognised');
  assert.match(ro.warning, /unrecognised/);
  // And in `soma_status` the same pane is `alive`, never `absent`: tmux says the pane's process is
  // live and not a shell, so an unfamiliar screen is a live lead whose screen is unfamiliar. Read as
  // absent, an operator resumes over it (`soma_resume` refuses on a live session, but `force` does not).
  const rs = await bt.orchTools(odd).get('soma_status')({});
  assert.equal(rs.leads[0].pane_state, 'unrecognised');
  assert.equal(rs.leads[0].liveness, 'alive');
});

test('soma_status never reads the pane of a queued row: it has no session, and a listing miss would be reported as absent', async () => {
  const bt = await load();
  const reads = [];
  const listing = new Map([['lead-cr-1', paneOf()]]);
  const c = orch({
    tasks: [{ id: 'cr-1', status: 'spawned', tmux_session: 'lead-cr-1' }, { id: 'cr-2', status: 'queued' }],
    sessions: ['lead-cr-1'],
    deps: { paneStates: () => listing, paneReading: (target, panes) => { reads.push(target); return readPane(target, { panes: panes ?? listing, capture: () => IDLE_FRAME }); } },
  });
  // The queued row is asked for by name, so `statusRow` runs for it (the unfiltered `leads` path).
  const r = await bt.orchTools(c).get('soma_status')({ lead: 'cr-2' });
  assert.equal(r.leads.length, 1);
  assert.equal(r.leads[0].status, 'queued');
  assert.equal(r.leads[0].pane_state, null, 'nothing is claimed about a pane that never existed');
  assert.equal(r.leads[0].pane_state_source, null);
  assert.equal(r.leads[0].liveness, 'not-running');
  assert.deepEqual(reads, [], 'the reader was not consulted for the queued row');
  // And the ordinary listing reads the spawned row's pane and leaves the queued one alone.
  await bt.orchTools(c).get('soma_status')({});
  assert.deepEqual(reads, ['lead-cr-1']);
});

test('a bus with no pane reader wired types as before and says the pane was not checked', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1', status: 'spawned' }], sessions: ['lead-cr-1'] });   // orch() wires no paneStates
  const r = await bt.orchTools(c).get('soma_send')({ lead: 'cr-1', message: 'hi' });
  assert.equal(r.delivered, true);
  assert.equal(r.pane_state, null);
  assert.match(r.warning, /not checked/i);
});

test('send refuses a bad lead id, an unknown lead and an empty message', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1', status: 'spawned' }], sessions: ['lead-cr-1'] });
  const tools = bt.orchTools(c);
  for (const args of [{ lead: '../x', message: 'hi' }, { lead: 'cr-9', message: 'hi' }, { lead: 'cr-1', message: '   ' }, { lead: 'cr-1' }]) {
    const r = await tools.get('soma_send')(args);
    assert.notEqual(r.delivered, true, JSON.stringify(args));
    assert.ok(!JSON.stringify(r).includes('.soma'), JSON.stringify(r));
  }
  assert.deepEqual(c.s.keys, []);
});

// ---------------------------------------------------------------------------
// soma_kill
// ---------------------------------------------------------------------------

test('kill kills the session, fails the row, and logs why', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1', status: 'spawned', tmux_session: 'lead-cr-1' }], sessions: ['lead-cr-1'] });
  const r = await bt.orchTools(c).get('soma_kill')({ lead: 'cr-1', reason: 'wrong repo\nstop' });
  assert.equal(r.killed, true);
  assert.equal(r.status_set, true);
  assert.equal(r.logged, true);
  assert.deepEqual(c.s.killed, ['lead-cr-1']);
  assert.equal(c.s.fleet.tasks[0].status, 'failed');
  assert.deepEqual(c.s.appended, [{ stream: 'orch', type: 'KILLED', lead: 'cr-1', payload: { lead: 'cr-1', reason: 'wrong repo stop' } }]);
});

test('an operator reason cannot put an unbounded line on the orchestrator log', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1', status: 'spawned' }], sessions: ['lead-cr-1'] });
  await bt.orchTools(c).get('soma_kill')({ lead: 'cr-1', reason: 'z'.repeat(60_000) });
  const line = JSON.stringify(c.s.appended[0]);
  assert.ok(line.length < 9 * 1024, `${line.length} chars on the line`);
});

test('kill refuses an unknown lead instead of reporting a kill it did not do', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1' }] });
  const r = await bt.orchTools(c).get('soma_kill')({ lead: 'cr-99' });
  assert.equal(r.ok, false);
  assert.deepEqual(c.s.killed, []);
  assert.deepEqual(c.s.appended, []);
});

test('a log that will not take the KILLED event does not undo the kill, and names no file', async () => {
  const bt = await load();
  const c = orch({
    tasks: [{ id: 'cr-1', status: 'spawned' }],
    sessions: ['lead-cr-1'],
    deps: { appendEvent: () => { throw new Error("ENOSPC: write '/Users/x/.soma/events/orch.ndjson'"); } },
  });
  const r = await bt.orchTools(c).get('soma_kill')({ lead: 'cr-1', reason: 'x' });
  assert.equal(r.killed, true);
  assert.equal(r.logged, false);
  assert.ok(!/[/\\]/.test(JSON.stringify(r)), JSON.stringify(r));
});

// ---------------------------------------------------------------------------
// soma_resume
// ---------------------------------------------------------------------------

test('resume brings a dead lead back and re-occupies its slot', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1', status: 'failed', lead_session_uuid: 'u1' }] });
  const r = await bt.orchTools(c).get('soma_resume')({ lead: 'cr-1' });
  assert.equal(r.resumed, true);
  assert.deepEqual(c.s.resumes, ['cr-1']);
  assert.equal(c.s.fleet.tasks[0].status, 'spawned');
  assert.ok(Number.isFinite(c.s.fleet.last_spawn_at), 'a revival is a spawn for the stagger clock');
});

test('resume will not start a second Claude on a live lead unless forced', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1', status: 'spawned', lead_session_uuid: 'u1' }], sessions: ['lead-cr-1'] });
  const tools = bt.orchTools(c);
  const refused = await tools.get('soma_resume')({ lead: 'cr-1' });
  assert.equal(refused.resumed, false);
  assert.match(refused.error, /soma_kill/);
  assert.deepEqual(c.s.resumes, []);
  const forced = await tools.get('soma_resume')({ lead: 'cr-1', force: true });
  assert.equal(forced.resumed, true);
});

test('resume refuses a lead with no recorded session to resume', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1', status: 'failed' }] });
  const r = await bt.orchTools(c).get('soma_resume')({ lead: 'cr-1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /spawn/);
  assert.deepEqual(c.s.resumes, []);
});

test('a resume that throws is a refusal with no path, and does not claim a slot', async () => {
  const bt = await load();
  const c = orch({
    tasks: [{ id: 'cr-1', status: 'failed', lead_session_uuid: 'u1' }],
    deps: { resumeLead: () => { throw new Error('tmux new-session failed: duplicate session /Users/x/.soma/worktrees/r/cr-1'); } },
  });
  const r = await bt.orchTools(c).get('soma_resume')({ lead: 'cr-1' });
  assert.equal(r.resumed, false);
  assert.ok(!/[/\\]/.test(r.error), r.error);
  assert.equal(c.s.fleet.tasks[0].status, 'failed');
});

// ---------------------------------------------------------------------------
// soma_transcript / soma_digest
// ---------------------------------------------------------------------------

test('the transcript tail is bounded in lines and in characters, and keeps the end', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1' }], deps: { tailLog: (lead, n) => `${'a'.repeat(200_000)}THE-END:${n}` } });
  const tools = bt.orchTools(c);
  const r = await tools.get('soma_transcript')({ lead: 'cr-1', lines: 1e6 });
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 40_000, r.text.length);
  assert.match(r.text, /THE-END:500$/, 'the death scene is at the end of a transcript');
  const d = await tools.get('soma_transcript')({ lead: 'cr-1' });
  assert.match(d.text, /THE-END:120$/);
});

test('a transcript that cannot be read is a refusal, never an empty transcript', async () => {
  const bt = await load();
  const broken = orch({ tasks: [{ id: 'cr-1' }], deps: { tailLog: () => { throw new Error("EACCES '/Users/x/.soma/logs/cr-1.log'"); } } });
  const a = await bt.orchTools(broken).get('soma_transcript')({ lead: 'cr-1' });
  assert.equal(a.ok, false);
  assert.ok(!/[/\\]/.test(a.error), a.error);

  const unwired = orch({ tasks: [{ id: 'cr-1' }], deps: { tailLog: undefined } });
  const b = await bt.orchTools(unwired).get('soma_transcript')({ lead: 'cr-1' });
  assert.equal(b.ok, false);
});

test('the digest is passed through, and its absence is admitted rather than faked', async () => {
  const bt = await load();
  const c = orch();
  assert.deepEqual(await bt.orchTools(c).get('soma_digest')({}), { path: '/d/today.md', done: 1 });

  const unwired = orch({ deps: { buildDigest: undefined } });
  const r = await bt.orchTools(unwired).get('soma_digest')({});
  assert.equal(r.ok, false);
  assert.match(r.error, /digest/);

  const broken = orch({ deps: { buildDigest: () => { throw new Error("EACCES '/Users/x/.soma/digests/x.md'"); } } });
  const r2 = await bt.orchTools(broken).get('soma_digest')({});
  assert.equal(r2.ok, false);
  assert.ok(!/[/\\]/.test(r2.error), r2.error);
});

// ---------------------------------------------------------------------------
// Cross-cutting discipline
// ---------------------------------------------------------------------------

test('no refusal on the whole surface names a filesystem path', async () => {
  const bt = await load();
  const paths = ['/Users/someone/.soma/state/fleet.json', 'C:\\Users\\someone\\.soma\\events\\cr-1.ndjson'];
  for (const path of paths) {
    const throwing = {};
    for (const name of ['heartbeat', 'readLease', 'acquireLease', 'releaseLease', 'readFleet', 'updateFleet', 'setTaskStatus',
      'enqueue', 'unread', 'writeCursor', 'eventStreams', 'appendEvent', 'sendKeys', 'hasSession', 'killSession', 'listPanes',
      'spawnLead', 'resumeLead', 'readUsage', 'heartbeatAgeMs', 'setQueuePaused', 'queuePaused', 'backpressureState',
      'tailLog', 'buildDigest', 'loadConfig', 'validateHarnessReport', 'admit', 'leaseStale', 'hasPane', 'seatsSummary']) {
      throwing[name] = () => { throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT', path }); };
    }
    const c = orch({ tasks: [{ id: 'cr-1' }], deps: throwing });
    for (const [name, fn] of bt.orchTools(c)) {
      const body = JSON.stringify(await fn({ task_id: 'cr-1', lead: 'cr-1', tasks: [{ id: 'cr-2' }], action: 'pause', message: 'hi', reason: 'r' })) ?? '';
      assert.ok(!body.includes('.soma'), `${name}: ${body}`);
      assert.ok(!body.includes('ndjson'), `${name}: ${body}`);
      assert.ok(!body.includes('Users'), `${name}: ${body}`);
    }
  }
});

test('a handler that throws anyway degrades to a refusal instead of a -32000 the model reads', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1' }] });
  // a dep that is not a function at all: the shape no guard clause anticipates
  c.deps.readFleet = 'not a function';
  c.deps.unread = 'not a function';
  for (const name of ORCH_TOOLS) {
    const r = await bt.orchTools(c).get(name)({ task_id: 'cr-1', lead: 'cr-1', tasks: [], message: 'hi' });
    assert.equal(typeof r, 'object', name);
    assert.doesNotThrow(() => JSON.stringify(r), name);
  }
});

test('every handler awaits its deps, so an async wiring still answers correctly', async () => {
  const bt = await load();
  const base = orch({ tasks: [{ id: 'cr-1', status: 'spawned', lead_session_uuid: 'u1' }], sessions: ['lead-cr-1'], events: [{ type: 'HARNESS', lead: 'cr-1', payload: { harness_id: 'H2' } }] });
  const slow = {};
  for (const [k, v] of Object.entries(base.deps)) {
    if (typeof v === 'function') slow[k] = async (...args) => v(...args);
  }
  const c = orch({ tasks: [{ id: 'cr-1', status: 'spawned', lead_session_uuid: 'u1' }], sessions: ['lead-cr-1'], events: [{ type: 'HARNESS', lead: 'cr-1', payload: { harness_id: 'H2' } }], deps: slow });
  const tools = bt.orchTools(c);
  assert.equal((await tools.get('soma_status')({})).leads[0].liveness, 'alive');
  assert.equal((await tools.get('soma_send')({ lead: 'cr-1', message: 'hi' })).delivered, true);
  assert.equal((await tools.get('soma_inbox')({})).folded, 1);
  assert.equal((await tools.get('soma_adopt')({})).adopted, true);
  assert.equal((await tools.get('soma_queue')({ action: 'pause' })).paused, true);
});

test('a dep that returns a rejecting promise cannot float a rejection out of the bus', async () => {
  const bt = await load();
  const seen = [];
  const onUnhandled = (e) => seen.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const rejecting = {};
    for (const name of ['heartbeat', 'sendKeys', 'appendEvent', 'writeCursor', 'setQueuePaused', 'listPanes', 'readUsage', 'heartbeatAgeMs']) {
      rejecting[name] = () => Promise.reject(new Error(`${name} exploded`));
    }
    const c = orch({ tasks: [{ id: 'cr-1', status: 'spawned', lead_session_uuid: 'u1' }], sessions: ['lead-cr-1'], deps: rejecting });
    for (const [, fn] of bt.orchTools(c)) await fn({ task_id: 'cr-1', lead: 'cr-1', tasks: [], message: 'hi', action: 'pause' });
    await drain(); await drain();
    assert.deepEqual(seen.map((e) => e.message), []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('no handler edits the arguments object the transport parsed for it', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1', status: 'spawned' }], sessions: ['lead-cr-1'] });
  const tools = bt.orchTools(c);
  const args = { task_id: 'cr-1', lead: 'cr-1', tasks: [{ id: 'cr-7', brief: 'b' }], message: 'hi\nthere', reason: 'r', limit: 3, action: 'pause', force: false };
  const before = JSON.stringify(args);
  for (const [, fn] of tools) await fn(args);
  assert.equal(JSON.stringify(args), before);
});

// ---------------------------------------------------------------------------
// Fix round 1 — the terminal flip, the lead-name gate, and the claims that
// were fixed but never pinned.
// ---------------------------------------------------------------------------

test('a COMPLETED event frees the lead slot, so admission does not starve', async () => {
  const bt = await load();
  const c = orch({
    tasks: [{ id: 'cr-1', status: 'spawned', lead_session_uuid: 'u1' }, { id: 'cr-2', status: 'spawned', lead_session_uuid: 'u2' }, { id: 'cr-3' }],
    config: { max_leads: 2, repos: {}, budgets: {} },
    events: [
      { type: 'COMPLETED', lead: 'cr-1', payload: { summary: 's', pr_url: 'https://gh/p/1' } },
      { type: 'COMPLETED', lead: 'cr-2', payload: { summary: 's' } },
    ],
  });
  const tools = bt.orchTools(c);
  // Both leads have finished, but until the rows say so the fleet is full…
  assert.match((await tools.get('soma_spawn')({ task_id: 'cr-3' })).error, /max_leads/);
  const r = await tools.get('soma_inbox')({});
  assert.equal(r.terminal, 2);
  assert.deepEqual(c.s.fleet.tasks.map((t) => t.status), ['done', 'done', 'queued']);
  assert.equal(c.s.fleet.tasks[0].pr_url, 'https://gh/p/1', 'the pr_url fold still happens in the same pass');
  // …and now it is not.
  assert.equal((await tools.get('soma_spawn')({ task_id: 'cr-3' })).spawned, true);
});

test('ERROR and GAVE_UP fail the row; NEEDS_INPUT is left to the watchdog clock', async () => {
  const bt = await load();
  const c = orch({
    tasks: [{ id: 'cr-1', status: 'spawned' }, { id: 'cr-2', status: 'spawned' }, { id: 'cr-3', status: 'spawned' }],
    events: [
      { type: 'ERROR', lead: 'cr-1', payload: { summary: 'boom' } },
      { type: 'GAVE_UP', lead: 'cr-2', payload: {} },
      { type: 'NEEDS_INPUT', lead: 'cr-3', payload: { question: 'develop or main?' } },
    ],
  });
  const r = await bt.orchTools(c).get('soma_inbox')({});
  assert.equal(r.terminal, 2);
  // blocked frees a slot the instant it is written, and the design gives a blocked
  // lead blocked_slot_minutes of grace first — a clock this bus does not have.
  assert.deepEqual(c.s.fleet.tasks.map((t) => t.status), ['failed', 'failed', 'spawned']);
});

test('a stale terminal event cannot undo a kill, resurrect a finished lead, or close a queued task', async () => {
  const bt = await load();
  const c = orch({
    tasks: [{ id: 'cr-1', status: 'failed' }, { id: 'cr-2', status: 'done' }, { id: 'cr-3', status: 'skipped' }, { id: 'cr-4', status: 'queued' }],
    events: [
      { type: 'COMPLETED', lead: 'cr-1', payload: { summary: 'but the operator killed me' } },
      { type: 'ERROR', lead: 'cr-2', payload: {} },
      { type: 'COMPLETED', lead: 'cr-3', payload: {} },
      { type: 'COMPLETED', lead: 'cr-4', payload: {} },
    ],
  });
  const r = await bt.orchTools(c).get('soma_inbox')({});
  assert.equal(r.terminal, 0);
  assert.deepEqual(c.s.fleet.tasks.map((t) => t.status), ['failed', 'done', 'skipped', 'queued']);
});

test('a blocked lead that finishes still reaches a terminal state', async () => {
  const bt = await load();
  const c = orch({
    tasks: [{ id: 'cr-1', status: 'blocked' }],
    events: [{ type: 'COMPLETED', lead: 'cr-1', payload: { pr_url: 'u' } }],
  });
  const r = await bt.orchTools(c).get('soma_inbox')({});
  assert.equal(r.terminal, 1);
  assert.equal(c.s.fleet.tasks[0].status, 'done', 'else the fleet never drains and never settles');
});

test('a terminal flip goes through the one transaction, and a failed one still delivers the mail', async () => {
  const bt = await load();
  const c = orch({
    tasks: [{ id: 'cr-1', status: 'spawned' }],
    events: [{ type: 'COMPLETED', lead: 'cr-1', payload: { pr_url: 'u' } }],
  });
  await bt.orchTools(c).get('soma_inbox')({});
  assert.equal(c.s.updates, 1, 'one transaction for the flip and the fold together');

  const broken = orch({
    tasks: [{ id: 'cr-1', status: 'spawned' }],
    events: [{ type: 'COMPLETED', lead: 'cr-1', payload: {} }],
    deps: { updateFleet: () => { throw new Error('fleet.lock: /Users/x/.soma/state/fleet.lock held by pid 9'); } },
  });
  const r = await bt.orchTools(broken).get('soma_inbox')({});
  assert.equal(r.events.length, 1);
  assert.equal(r.terminal, 0);
  assert.ok(!/[/\\]/.test(JSON.stringify(r)));
});

test('a lead-tainted session is refused by every orchestrator tool, not just adopt', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1', status: 'spawned' }], sessions: ['lead-cr-1'], lease: liveLease({ session_id: 'S1' }), env: { SOMA_LEAD_NAME: 'cr-1' } });
  for (const [name, fn] of bt.orchTools(c)) {
    const r = await fn({ task_id: 'cr-1', lead: 'cr-1', tasks: [{ id: 'cr-9' }], action: 'pause', message: 'hi', reason: 'r', force: true });
    assert.notEqual(r.adopted, true, name);
    assert.notEqual(r.spawned, true, name);
    assert.notEqual(r.released, true, name);
    assert.notEqual(r.delivered, true, name);
    assert.notEqual(r.killed, true, name);
    assert.notEqual(r.resumed, true, name);
    assert.match(JSON.stringify(r), /cr-1/, `${name} should say which lead this session belongs to`);
    assert.match(JSON.stringify(r), /SOMA_LEAD_NAME/, `${name} should name the variable to unset`);
  }
  // and no effect of any kind happened: a lead spawning leads is a fork bomb of
  // Claude Code sessions on one subscription.
  assert.deepEqual(c.s.spawns, []);
  assert.deepEqual(c.s.resumes, []);
  assert.deepEqual(c.s.killed, []);
  assert.deepEqual(c.s.keys, []);
  assert.deepEqual(c.s.appended, []);
  assert.equal(c.s.lease.session_id, 'S1');
  assert.equal(c.s.updates, 0);
  assert.equal(c.s.fleet.tasks.length, 1);
  assert.equal(c.s.queuePaused, false);
  assert.deepEqual(c.s.cursors, {});
  // the candidate map carries the same gate
  for (const [, fn] of bt.candidateTools(c)) assert.notEqual((await fn({})).adopted, true);
});

test('resumeLead is called with the task and an options object, never with force: a second positional lands in resumeLead(task, deps) and silently replaces its wiring', async () => {
  const bt = await load();
  const seen = [];
  const c = orch({
    tasks: [{ id: 'cr-1', status: 'failed', lead_session_uuid: 'u1' }],
    deps: { resumeLead: (...args) => { seen.push(args); return { lead: 'cr-1', session_uuid: 'u1' }; } },
  });
  await bt.orchTools(c).get('soma_resume')({ lead: 'cr-1', force: true });
  assert.equal(seen.length, 1);
  // The dep-level contract is `resumeLead(task, opts)`; `soma-bus.mjs` forwards `opts` THIRD to
  // `spawn.resumeLead(task, undefined, opts)`, so nothing this bus passes can reach the dep set.
  assert.equal(seen[0].length, 2, 'the task and the launch options, nothing else');
  assert.equal(seen[0][0].id, 'cr-1');
  assert.deepEqual(seen[0][1], {}, 'no seats configured: an empty options object — never force, never a dep set');
});

test('kill reports what tmux actually did, not what was asked of it', async () => {
  const bt = await load();
  // the session is already gone — the lead crashed, or the watchdog reaped it
  const c = orch({ tasks: [{ id: 'cr-1', status: 'spawned' }], sessions: [] });
  const r = await bt.orchTools(c).get('soma_kill')({ lead: 'cr-1', reason: 'stop' });
  assert.equal(r.killed, false, 'there was no session to kill');
  assert.equal(r.status_set, true, 'but the row is still failed and the event still logged');
  assert.equal(r.logged, true);
  assert.equal(c.s.fleet.tasks[0].status, 'failed');

  const live = orch({ tasks: [{ id: 'cr-1', status: 'spawned' }], sessions: ['lead-cr-1'] });
  assert.equal((await bt.orchTools(live).get('soma_kill')({ lead: 'cr-1' })).killed, true);
});

test('a message that did not land does not invent a reason for it', async () => {
  const bt = await load();
  const base = { tasks: [{ id: 'cr-1', status: 'spawned' }], sessions: ['lead-cr-1'] };
  const refused = orch({ ...base, deps: { sendKeys: () => false } });
  const threw = orch({ ...base, deps: { sendKeys: () => { throw new Error('tmux: /Users/x/.tmux failed'); } } });
  const unwired = orch({ ...base, deps: { sendKeys: undefined } });
  const errors = [];
  for (const c of [refused, threw, unwired]) {
    const r = await bt.orchTools(c).get('soma_send')({ lead: 'cr-1', message: 'answer' });
    assert.equal(r.delivered, false);
    assert.ok(!/[/\\]/.test(r.error), r.error);
    errors.push(r.error);
  }
  assert.equal(new Set(errors).size, 3, `three different causes must not read identically: ${JSON.stringify(errors)}`);
  assert.ok(!errors[1].includes('no live pane'), 'a send that threw did not establish that the pane is gone');
  assert.ok(!errors[2].includes('no live pane'), 'an unwired tmux says nothing about the lead');
});

test('a single-character control that JS does not call whitespace still cannot reach a composer', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1', status: 'spawned' }], sessions: ['lead-cr-1'] });
  // U+0085 NEL and U+009B CSI are C1 controls: JS \s excludes them, and a terminal in
  // 8-bit mode reads them as a newline and an escape-sequence introducer. Built with
  // fromCharCode so this file stays free of raw control bytes.
  const NEL = String.fromCharCode(0x85);
  const CSI = String.fromCharCode(0x9b);
  await bt.orchTools(c).get('soma_send')({ lead: 'cr-1', message: `one${NEL}two${CSI}[2Dthree` });
  assert.equal(c.s.keys[0].line, 'one two [2Dthree');
});

test('a leaseStale that does not answer with a boolean is unknown, never stale', async () => {
  const bt = await load();
  for (const answer of ['yes', 1, {}, 'no']) {
    const c = orch({ lease: liveLease({ session_id: 'S-other' }), deps: { leaseStale: () => answer } });
    const r = await bt.orchTools(c).get('soma_adopt')({});
    assert.equal(r.adopted, false, `leaseStale -> ${JSON.stringify(answer)} must not grant a steal`);
    assert.equal(r.holder_live, null, 'and it must not claim the holder is live either');
    assert.equal(c.s.lease.session_id, 'S-other');
  }
});

test('status bounds the whole reply, not just each field, and never drops a row silently', async () => {
  const bt = await load();
  const hostile = Array.from({ length: 400 }, (_, i) => ({
    id: `cr-${i + 1}`, status: 'spawned', title: 'T'.repeat(9000), pr_url: 'u'.repeat(9000),
    harness: 'H'.repeat(9000), budget_class: 'b'.repeat(9000), tmux_session: `lead-cr-${i + 1}`,
  }));
  const c = orch({
    tasks: hostile,
    sessions: hostile.map((t) => t.tmux_session),
    usage: { est_tokens: 1, turns: 1, last_model: 'm'.repeat(9000) },
    deps: { listPanes: () => Array.from({ length: 500 }, (_, i) => ({ index: i, dead: false, title: 't'.repeat(500) })) },
  });
  const r = await bt.orchTools(c).get('soma_status')({});
  const bytes = JSON.stringify(r).length;
  assert.ok(bytes < 400_000, `${bytes} bytes came back`);
  assert.equal(r.leads.length + r.rows_omitted, 400, 'whatever is dropped is counted, not hidden');
  assert.ok(r.rows_omitted > 0);
});

// ---------------------------------------------------------------------------
// Fix round 2 — the flip in mirror: a read must not close a row, and a
// re-delivered event must not close a lead that has since come back.
// ---------------------------------------------------------------------------

test('a peek folds the facts a lead reported but never closes its row', async () => {
  const bt = await load();
  const c = orch({
    tasks: [{ id: 'cr-1', status: 'spawned' }],
    events: [{ type: 'HARNESS', lead: 'cr-1', payload: { harness_id: 'H2' } }, { type: 'COMPLETED', lead: 'cr-1', payload: { pr_url: 'u' } }],
  });
  const r = await bt.orchTools(c).get('soma_inbox')({ mark_read: false });
  assert.equal(r.terminal, 0, 'a read is not a lifecycle decision');
  assert.equal(c.s.fleet.tasks[0].status, 'spawned');
  // the monotonic facts still land: they display, they do not reap
  assert.equal(c.s.fleet.tasks[0].harness, 'H2');
  assert.equal(c.s.fleet.tasks[0].pr_url, 'u');
  assert.deepEqual(c.s.cursors, {});
  // and a real drain then does close it
  const drain2 = await bt.orchTools(c).get('soma_inbox')({});
  assert.equal(drain2.terminal, 1);
  assert.equal(c.s.fleet.tasks[0].status, 'done');
});

test('a re-delivered terminal event cannot close a lead that has since been resumed', async () => {
  const bt = await load();
  const c = orch({
    tasks: [{ id: 'cr-1', status: 'spawned', lead_session_uuid: 'u1' }],
    events: [{ type: 'COMPLETED', lead: 'cr-1', payload: { summary: 'done' } }],
  });
  const tools = bt.orchTools(c);
  assert.equal((await tools.get('soma_inbox')({})).terminal, 1);
  assert.equal(c.s.fleet.tasks[0].status, 'done');

  // the operator brings it back — a new session, live, on the same worktree
  assert.equal((await tools.get('soma_resume')({ lead: 'cr-1' })).resumed, true);
  assert.equal(c.s.fleet.tasks[0].status, 'spawned');

  // the cursor was lost (a failed writeCursor is reported as marked_read:false and
  // leaves exactly this state), so the same COMPLETED arrives again
  c.s.cursors = {};
  const again = await tools.get('soma_inbox')({});
  assert.equal(again.events.length, 1);
  assert.equal(again.terminal, 0, 'an event older than the row cannot close it');
  assert.equal(c.s.fleet.tasks[0].status, 'spawned', 'the watchdog reaps tmux-alive done leads: this would kill live work');
  const st = await tools.get('soma_status')({ lead: 'cr-1' });
  assert.equal(st.leads[0].liveness, 'alive');
});

test('the in-transaction guard is what protects a killed lead whose mail also carries a harness', async () => {
  const bt = await load();
  // The normal lead sequence is STARTED -> HARNESS -> … -> COMPLETED, so the harness
  // clause opens the transaction and execution reaches the status branch: only the
  // re-check inside it keeps the operator's kill.
  const c = orch({
    tasks: [{ id: 'cr-1', status: 'failed' }],
    events: [{ type: 'HARNESS', lead: 'cr-1', payload: { harness_id: 'H2' } }, { type: 'COMPLETED', lead: 'cr-1', payload: { pr_url: 'u' } }],
  });
  const r = await bt.orchTools(c).get('soma_inbox')({});
  assert.equal(c.s.updates, 1, 'the transaction really was entered');
  assert.equal(c.s.fleet.tasks[0].harness, 'H2', 'and it really did write');
  assert.equal(r.terminal, 0);
  assert.equal(c.s.fleet.tasks[0].status, 'failed', 'the kill stands');
});

test('the last terminal event in the log wins, in either order', async () => {
  const bt = await load();
  const first = orch({
    tasks: [{ id: 'cr-1', status: 'spawned' }],
    events: [{ type: 'COMPLETED', lead: 'cr-1', payload: {} }, { type: 'ERROR', lead: 'cr-1', payload: { summary: 'then it broke' } }],
  });
  await bt.orchTools(first).get('soma_inbox')({});
  assert.equal(first.s.fleet.tasks[0].status, 'failed');

  const second = orch({
    tasks: [{ id: 'cr-1', status: 'spawned' }],
    events: [{ type: 'ERROR', lead: 'cr-1', payload: {} }, { type: 'COMPLETED', lead: 'cr-1', payload: {} }],
  });
  await bt.orchTools(second).get('soma_inbox')({});
  assert.equal(second.s.fleet.tasks[0].status, 'done');
});

test('the fold flips a status without going through setTaskStatus', async () => {
  const bt = await load();
  let calls = 0;
  const c = orch({
    tasks: [{ id: 'cr-1', status: 'spawned' }],
    events: [{ type: 'COMPLETED', lead: 'cr-1', payload: {} }],
  });
  const inner = c.deps.setTaskStatus;
  c.deps.setTaskStatus = (...a) => { calls += 1; return inner(...a); };
  await bt.orchTools(c).get('soma_inbox')({});
  assert.equal(c.s.fleet.tasks[0].status, 'done');
  assert.equal(calls, 0, 'one transaction, one guard, no nested lock acquisition');
});

test('a lead-tainted session cannot even heartbeat a lease it holds', async () => {
  const bt = await load();
  // A held lease with a stamp old enough to need refreshing: without the gate this
  // call would write one, so the assertion has teeth.
  const c = orch({ lease: heldLease(20 * 60 * 1000), env: { SOMA_LEAD_NAME: 'cr-1' } });
  await bt.orchTools(c).get('soma_status')({});
  assert.deepEqual(c.s.beats, [], 'the gate runs before the heartbeat, not after it');
  // and the same fixture without the taint does stamp it
  const clean = orch({ lease: heldLease(20 * 60 * 1000) });
  await bt.orchTools(clean).get('soma_status')({});
  assert.deepEqual(clean.s.beats, ['S1']);
});

test('a tmux_session out of the checkpoint is not trusted as a target or as text', async () => {
  const bt = await load();
  const secret = '/Users/someone/.soma/state/orch.lease';
  const keys = [];
  const c = orch({
    tasks: [{ id: 'cr-1', status: 'spawned', tmux_session: secret }],
    deps: { sendKeys: (target, line) => { keys.push({ target, line }); return false; } },
  });
  const r = await bt.orchTools(c).get('soma_send')({ lead: 'cr-1', message: 'hi' });
  assert.equal(r.delivered, false);
  assert.ok(!/[/\\]/.test(JSON.stringify(r)), JSON.stringify(r));
  assert.equal(keys[0].target, 'lead-cr-1', 'a target that is not a session name is not a session name');

  // and a row that names a PANE would otherwise type into the orchestrator's own
  const hijack = orch({ tasks: [{ id: 'cr-1', status: 'spawned', tmux_session: '%1' }], panes: ['%1'] });
  const h = await bt.orchTools(hijack).get('soma_send')({ lead: 'cr-1', message: 'hi' });
  assert.equal(hijack.s.keys[0].target, 'lead-cr-1');
  assert.notEqual(h.tmux_target, '%1');
  // a legitimate retry suffix still survives
  const retry = orch({ tasks: [{ id: 'cr-1', status: 'spawned', tmux_session: 'lead-cr-1-r2' }], sessions: ['lead-cr-1-r2'] });
  assert.equal((await bt.orchTools(retry).get('soma_send')({ lead: 'cr-1', message: 'hi' })).tmux_target, 'lead-cr-1-r2');
});

test('the queue list bounds each id, not just how many there are', async () => {
  const bt = await load();
  const c = orch({ tasks: Array.from({ length: 1200 }, (_, i) => ({ id: `cr-${'9'.repeat(200)}-${i}`, status: 'queued' })) });
  const r = await bt.orchTools(c).get('soma_status')({});
  const bytes = JSON.stringify(r).length;
  assert.ok(bytes < 200_000, `${bytes} bytes came back`);
  assert.ok(r.queue.every((id) => id.length <= 64), 'fleet.json is not a trusted input');
});

test('capping the rows never hides a running lead behind a wall of finished ones', async () => {
  const bt = await load();
  const finished = Array.from({ length: 400 }, (_, i) => ({ id: `old-${i}`, status: 'done' }));
  const live = [{ id: 'cr-1', status: 'spawned' }, { id: 'cr-2', status: 'spawned' }, { id: 'cr-3', status: 'blocked' }];
  const c = orch({ tasks: [...finished, ...live], sessions: ['lead-cr-1', 'lead-cr-2'] });
  const r = await bt.orchTools(c).get('soma_status')({});
  const shown = r.leads.map((row) => row.lead);
  for (const t of live) assert.ok(shown.includes(t.id), `${t.id} must be visible: status's whole job is the running fleet`);
  assert.ok(r.rows_omitted > 0);
  assert.equal(r.leads.length + r.rows_omitted, 403);
});

test('the in-transaction recency clause is what saves a resumed lead whose mail also carries a harness', async () => {
  const bt = await load();
  // The row was just written (a resume), and its unread mail carries both the HARNESS
  // it does not have yet and its own older COMPLETED. The harness clause opens the
  // transaction — so, exactly as with FLIPPABLE, only the re-check inside it declines
  // the flip. Without this the outer pre-check alone would satisfy the test and the
  // in-transaction clause would be untested.
  const c = orch({
    tasks: [{ id: 'cr-1', status: 'spawned', updated: Date.now() }],
    events: [{ type: 'HARNESS', lead: 'cr-1', payload: { harness_id: 'H2' } }, { type: 'COMPLETED', lead: 'cr-1', payload: { pr_url: 'u' } }],
  });
  const r = await bt.orchTools(c).get('soma_inbox')({});
  assert.equal(c.s.updates, 1, 'the transaction really was entered');
  assert.equal(c.s.fleet.tasks[0].harness, 'H2', 'and it really did write');
  assert.equal(c.s.fleet.tasks[0].pr_url, 'u');
  assert.equal(r.terminal, 0);
  assert.equal(c.s.fleet.tasks[0].status, 'spawned', 'mail that predates the resume does not decide this row');
});

// ---------------------------------------------------------------------------
// Fix round 3 — the guards behind the guards.
// ---------------------------------------------------------------------------

test('a metadata write never moves the clock the terminal guard reads', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1' }], config: { max_leads: 10, repos: {}, budgets: {} } });
  const tools = bt.orchTools(c);
  await tools.get('soma_spawn')({ task_id: 'cr-1' });
  const afterSpawn = c.s.fleet.tasks[0].updated;
  assert.equal(c.s.fleet.tasks[0].lead_session_uuid, 'u-cr-1', 'the metadata really was written');

  // A terminal event stamped at the same millisecond as the spawn must still be able
  // to close the row: `updated` may only be moved by a lifecycle change, and the
  // `spawned` transition already moved it — earlier, which is the safe direction.
  c.s.events = [{ id: `${afterSpawn}-0000`, ts: afterSpawn, type: 'COMPLETED', lead: 'cr-1', payload: {} }];
  const r = await tools.get('soma_inbox')({});
  assert.equal(r.terminal, 1, 'a metadata stamp after the transition would strand this event forever');
  assert.equal(c.s.fleet.tasks[0].status, 'done');
});

test('the outer pre-check declines a stale flip without opening a transaction', async () => {
  const bt = await load();
  // The only patch is a terminal status, and it is older than the row: the drain must
  // not take the fleet lock, write and rename — which is what the pre-check is for.
  const c = orch({
    tasks: [{ id: 'cr-1', status: 'spawned', updated: Date.now() }],
    events: [{ type: 'COMPLETED', lead: 'cr-1', payload: {} }],
  });
  const r = await bt.orchTools(c).get('soma_inbox')({});
  assert.equal(r.events.length, 1, 'the mail is still delivered');
  assert.equal(r.terminal, 0);
  assert.equal(c.s.updates, 0, 'no transaction, so no write+rename per drain of already-seen mail');
});

test('an event written without a ts is still placed in time by its own id', async () => {
  const bt = await load();
  const c = orch({
    tasks: [{ id: 'cr-1', status: 'spawned' }],
    events: [{ type: 'COMPLETED', lead: 'cr-1', payload: {} }],
  });
  // events.mjs guarantees ts is exactly the numeric prefix of the id, so a hand-edited
  // line that lost the field can still decide a row.
  delete c.s.events[0].ts;
  const r = await bt.orchTools(c).get('soma_inbox')({});
  assert.equal(r.terminal, 1);
  assert.equal(c.s.fleet.tasks[0].status, 'done');

  // …and one that cannot be placed at all decides nothing.
  const junk = orch({
    tasks: [{ id: 'cr-2', status: 'spawned' }],
    events: [{ type: 'COMPLETED', lead: 'cr-2', payload: {} }],
  });
  delete junk.s.events[0].ts;
  junk.s.events[0].id = 'not-an-event-id';
  assert.equal((await bt.orchTools(junk).get('soma_inbox')({})).terminal, 0);
  assert.equal(junk.s.fleet.tasks[0].status, 'spawned');
});

test('a tmux_session with a trailing newline is not a tmux session name', async () => {
  const bt = await load();
  const keys = [];
  const c = orch({
    tasks: [{ id: 'cr-1', status: 'spawned', tmux_session: 'lead-cr-1\n' }],
    deps: { sendKeys: (target, line) => { keys.push({ target, line }); return true; } },
  });
  const r = await bt.orchTools(c).get('soma_send')({ lead: 'cr-1', message: 'hi' });
  // JS `$` is end-of-input, not end-of-line, unless the regex carries /m — which is
  // exactly why this is rejected rather than accepted with a line break riding along
  // into a tmux target and into a tool result.
  assert.equal(keys[0].target, 'lead-cr-1');
  assert.equal(r.tmux_target, 'lead-cr-1');
  assert.ok(!/\n/.test(r.tmux_target));
});

test('the rows that survive the cap are reported in checkpoint order, not in rank order', async () => {
  const bt = await load();
  const finished = Array.from({ length: 400 }, (_, i) => ({ id: `old-${String(i).padStart(3, '0')}`, status: 'done' }));
  const c = orch({
    tasks: [...finished, { id: 'cr-1', status: 'spawned' }, { id: 'cr-2', status: 'spawned' }],
    sessions: ['lead-cr-1', 'lead-cr-2'],
  });
  const r = await bt.orchTools(c).get('soma_status')({});
  const shown = r.leads.map((row) => row.lead);
  // The two live leads earn their place past the cap, and then take their place at the
  // END, where the checkpoint put them — enqueue order is priority order.
  assert.deepEqual(shown.slice(-2), ['cr-1', 'cr-2']);
  assert.equal(shown[0], 'old-000');
  const indexOf = (id) => c.s.fleet.tasks.findIndex((t) => t.id === id);
  const positions = shown.map(indexOf);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'the reply is ordered by the checkpoint');
});

test('a report filed while the spawner was still finishing is not stranded by the metadata write', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1' }], config: { max_leads: 10, repos: {}, budgets: {} } });
  // The event lands after the `spawned` transition and before the uuid is recorded.
  // If that record stamps `updated`, the row ends up newer than the event and the
  // flip is declined for good — row `spawned`, slot held, forever. The busy-wait only
  // forces the two writes into different milliseconds so the test is deterministic.
  c.deps.spawnLead = (t) => {
    const at = Date.now();
    c.s.events.push({ id: `${at}-0000`, ts: at, type: 'COMPLETED', lead: t.id, payload: {} });
    const until = at + 3;
    while (Date.now() < until) { /* spin */ }
    return { lead: t.id, session_uuid: `u-${t.id}`, tmux_target: `lead-${t.id}` };
  };
  const tools = bt.orchTools(c);
  assert.equal((await tools.get('soma_spawn')({ task_id: 'cr-1' })).recorded, true);
  assert.equal(c.s.fleet.tasks[0].lead_session_uuid, 'u-cr-1');
  const r = await tools.get('soma_inbox')({});
  assert.equal(r.terminal, 1, 'only a lifecycle change may move the clock the flip reads');
  assert.equal(c.s.fleet.tasks[0].status, 'done');
});

/**
 * The pane travels with the stamp — the WIRING, not the repair.
 *
 * `lease.heartbeat` repairs a stale `tmux_pane` when it is handed one, and that repair is
 * tested in `lease.test.mjs`. This asserts the other half: that `beat()` actually hands it one.
 * Measured necessity — with the repair in place and fully tested, removing
 * `{ pane: paneOf() }` from the call site reddened NOTHING. Two sides of a seam, each covered,
 * the seam itself blind; the same shape as the defect where soma denied its own bus.
 *
 * The value must be the same proven pane `claimOf()` writes, or the repair would fight the claim.
 */

test('beat() hands the heartbeat this session\'s pane, not just its id', async () => {
  const bt = await load();
  // Holder, inside tmux, whose lease still names the pane of a previous incarnation. This is
  // the real shape: `claude --resume <id>` keeps the session id and gets a NEW pane — on soma's
  // server, which is what lets the bus prove it (the fixture's verifier needs it there).
  const c = orch({
    lease: liveLease({ session_id: 'S1', tmux_pane: '%OLD', heartbeat_at: 0 }),
    panes: ['%1', '%NEW'],
    env: { SOMA_TMUX_PANE: '%NEW' },
  });
  await bt.orchTools(c).get('soma_status')({});
  assert.deepEqual(c.s.beats, ['S1'], 'the holder stamped');
  assert.deepEqual(c.s.beatOpts, [{ pane: '%NEW' }],
    'without the pane the lease can never learn that a resume moved this session to a new pane');

  // Outside tmux there is no pane to offer, and null must not be dressed up as one —
  // `lease.heartbeat` ignores it, and that only holds if what arrives is really null.
  const n = orch({
    lease: liveLease({ session_id: 'S1', tmux_socket: null, tmux_pane: null, wake: 'notify', heartbeat_at: 0 }),
    env: { SOMA_TMUX_PANE: '' },
  });
  await bt.orchTools(n).get('soma_status')({});
  assert.deepEqual(n.s.beatOpts, [{ pane: null }], 'a session outside tmux offers null, not an empty string');
});

test('beat() offers only a pane it can prove, so a resume into another tmux server cannot re-point the lease', async () => {
  const bt = await load();
  // The holder was resumed into the operator's everyday tmux, into a `%3` that soma's server ALSO
  // has (a lead's, say). Repairing the lease to `%3` would aim every wake at that lead, so the
  // heartbeat is offered null, and `lease.heartbeat` leaves a null pane alone.
  const c = orch({
    lease: liveLease({ session_id: 'S1', tmux_pane: '%1', heartbeat_at: 0 }),
    panes: ['%1', '%3'],
    env: { SOMA_TMUX_PANE: '%3', TMUX: OWN_TMUX },
  });
  await bt.orchTools(c).get('soma_status')({});
  assert.deepEqual(c.s.beats, ['S1'], 'the holder still stamped');
  assert.deepEqual(c.s.beatOpts, [{ pane: null }]);
});

test('a resumed bus that never adopts takes the proof itself before the heartbeat carries a pane', async () => {
  const bt = await load();
  // `claude --resume` keeps the session id, so the lease is still this session's and the NEW bus
  // process never calls soma_adopt: `beat()` is all that runs there. It has to prove the pane in
  // this process, every time it would pass one, and can reuse nothing an adopt computed elsewhere.
  for (const [label, env, want] of [
    ['resumed into a pane on soma\'s server', { SOMA_TMUX_PANE: '%NEW' }, '%NEW'],
    ['resumed into a pane on another server', { SOMA_TMUX_PANE: '%NEW', TMUX: OWN_TMUX }, null],
  ]) {
    const asked = [];
    const c = orch({ lease: liveLease({ session_id: 'S1', tmux_pane: '%OLD', heartbeat_at: 0 }), panes: ['%1', '%NEW'], env });
    const real = c.deps.paneOnServer;
    c.deps.paneOnServer = (pane, tmuxVar) => { asked.push([pane, tmuxVar]); return real(pane, tmuxVar); };
    await bt.orchTools(c).get('soma_status')({});
    assert.deepEqual(asked, [['%NEW', env.TMUX ?? SOMA_TMUX]], `${label}: the proof is taken here, about this pane and this $TMUX`);
    assert.deepEqual(c.s.beatOpts, [{ pane: want }], label);
  }
});

test('the proof costs at most one tmux call a minute: beat\'s floor gates it', async () => {
  const bt = await load();
  let proofs = 0;
  const c = orch({ lease: liveLease({ session_id: 'S1', tmux_pane: '%1', heartbeat_at: 0 }) });
  const real = c.deps.paneOnServer;
  c.deps.paneOnServer = (pane, tmuxVar) => { proofs += 1; return real(pane, tmuxVar); };
  const tools = bt.orchTools(c);
  for (let i = 0; i < 5; i += 1) await tools.get('soma_status')({});
  assert.deepEqual(c.s.beatOpts, [{ pane: '%1' }], 'one heartbeat: the first call stamped, the floor held the rest');
  assert.equal(proofs, 1, 'and so one proof');
});

// ---------------------------------------------------------------------------
// Account rotation (design §3.8): the six new types are mail, not verbs — the inbox
// returns them as stored and folds nothing
// ---------------------------------------------------------------------------

/**
 * The digest and RUNBOOK §10 read `SEAT_CLOSED … then ROTATED` off the orchestrator's drain,
 * so the drain has to hand them over exactly as the log holds them: `foldEvents` acts only on
 * HARNESS, a COMPLETED's pr_url and the TERMINAL_STATUS types, and `soma_inbox` slices `waiting`
 * without filtering. Both events are built by the builders the watchdog appends with, so what
 * this feeds through is the stored shape, not a hand-written one; the SEAT_CLOSED is lead-less
 * and reaches the sweep through the `orch` stream it always includes.
 */
test('a ROTATED and a SEAT_CLOSED come back from soma_inbox as stored, fold nothing, and flip no row', async () => {
  const bt = await load();
  const RESETS_AT = 1_440_433_800_000;   // 2015-08-24T16:30Z — the limit fixture's resetsAt 1440433800 s, in ms
  const c = orch({
    tasks: [{ id: 'cr-1', status: 'spawned', lead_session_uuid: 'u' }],
    events: [
      rotated({ lead: 'cr-1', from: 'seat-a', to: 'seat-b', rateLimitType: 'five_hour', resetsAt: RESETS_AT }),
      seatClosed({ seat: 'seat-a', reason: 'five_hour', resetsAt: RESETS_AT }),
    ],
  });
  const r = await bt.orchTools(c).get('soma_inbox')({});
  assert.deepEqual(r.events.map((e) => [e.type, e.lead, e.payload]), [
    ['ROTATED', 'cr-1', { lead: 'cr-1', from: 'seat-a', to: 'seat-b', rateLimitType: 'five_hour', resetsAt: RESETS_AT }],
    ['SEAT_CLOSED', null, { seat: 'seat-a', reason: 'five_hour', resetsAt: RESETS_AT }],
  ]);
  assert.equal(r.returned, 2);
  assert.deepEqual([r.folded, r.terminal], [0, 0], 'neither is a HARNESS, a COMPLETED, nor a terminal event');
  assert.equal(c.s.updates, 0, 'no fleet transaction was opened at all');
  assert.equal(c.s.fleet.tasks[0].status, 'spawned');
  assert.equal(r.marked_read, true, 'read like any other mail — the digest, not the inbox, is where they are re-read');
});

// ---------------------------------------------------------------------------
// soma_status × the freeze record
// ---------------------------------------------------------------------------

test('soma_status reads back a record the real writer wrote, with all four fields, and the cleared shape after', async (t) => {
  const bt = await load();
  const home = mkdtempSync(join(tmpdir(), 'soma-bp-'));
  const prev = process.env.SOMA_HOME;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (prev === undefined) delete process.env.SOMA_HOME; else process.env.SOMA_HOME = prev;
  });
  process.env.SOMA_HOME = home;
  const { clearBackpressure, readBackpressure, writeBackpressure } = await import('../bin/lib/wd/backpressure.mjs?orch-' + Date.now());
  // The real reader as the dep `soma-bus.mjs` wires: what the watchdog writes is what the orchestrator reads.
  const c = orch({ deps: { backpressureState: readBackpressure } });
  const status = bt.orchTools(c).get('soma_status');

  writeBackpressure({ active: true, reason: 'storm', since: 1_440_433_800_000, until: null });
  assert.deepEqual((await status({})).backpressure, { active: true, reason: 'storm', since: 1_440_433_800_000, until: null });
  // The other writer's record reads back the same way — the two writers are one function.
  writeBackpressure({ active: true, reason: 'org_level_disabled_until', since: 1_440_433_860_000, until: null });
  assert.deepEqual((await status({})).backpressure, { active: true, reason: 'org_level_disabled_until', since: 1_440_433_860_000, until: null });
  clearBackpressure();
  assert.deepEqual((await status({})).backpressure, { active: false, reason: null, since: null, until: null });
});

test('soma_status flags an unreadable record instead of calling it not frozen; a clean record carries no flag', async () => {
  const bt = await load();
  const torn = orch({ deps: { backpressureState: () => ({ active: false, unreadable: true, why: 'state/backpressure.json is not JSON' }) } });
  const r = await bt.orchTools(torn).get('soma_status')({});
  assert.deepEqual(r.backpressure, { active: false, reason: null, since: null, until: null, unreadable: true });
  assert.equal('why' in r.backpressure, false, 'the reason is in the watchdog log; the reply carries the state');
  // Conditional, so the four-field shape every consumer matches is unchanged on a clean record.
  const clean = orch();
  assert.equal('unreadable' in (await bt.orchTools(clean).get('soma_status')({})).backpressure, false);
});

test('soma_status says it could not observe the freeze record, rather than calling it not frozen', async () => {
  const bt = await load();
  // Three NON-observations, and none of them is evidence that admission is open: a reader that
  // throws, a reader that answers something that is not a record, and a bus with no reader wired
  // at all. The two siblings in this same reply are already three-state — `queue_paused` degrades
  // to `null`, `seats` to `unreadable: true` — and `soma status`'s own arm turns a throw into
  // `unreadable`. This fold was the one place left where "could not read" and "open" were one
  // answer, on the field an orchestrator reads before deciding whether to enqueue.
  const UNOBSERVED = { active: false, reason: null, since: null, until: null, unreadable: true };
  const throwing = orch({ deps: { backpressureState: () => { throw new Error('EACCES: state dir'); } } });
  const t = (await bt.orchTools(throwing).get('soma_status')({})).backpressure;
  assert.deepEqual(t, UNOBSERVED, 'a reader that threw reported nothing');
  assert.equal('why' in t, false, 'the cause is in the watchdog log and in `soma status`; the reply carries the state');
  const nonsense = orch({ deps: { backpressureState: () => undefined } });
  assert.deepEqual((await bt.orchTools(nonsense).get('soma_status')({})).backpressure, UNOBSERVED,
    'an answer that is not a record is not a record that says "open"');
  const unwired = orch();
  delete unwired.deps.backpressureState;
  assert.deepEqual((await bt.orchTools(unwired).get('soma_status')({})).backpressure, UNOBSERVED,
    'a bus with no reader wired has not observed the file either');
  // The control, and the contract this must not move: a reader that really did read carries no
  // flag, and the four-field shape every consumer matches is unchanged.
  const clean = orch();
  assert.deepEqual((await bt.orchTools(clean).get('soma_status')({})).backpressure,
    { active: false, reason: null, since: null, until: null });
});

// ---------------------------------------------------------------------------
// soma_spawn / soma_resume — onto an open seat (account rotation, design §4)
// ---------------------------------------------------------------------------

const SEATED = { max_leads: 10, repos: {}, budgets: { standard: { tokens_cap: 1000 } }, seats: [{ config_dir: '/s/a', label: 'seat-a' }, { config_dir: '/s/b', label: 'seat-b' }] };
/** What `seats.pick` hands back: the seat with its closure fields. */
const SEAT_B = { config_dir: '/s/b', label: 'seat-b', closed_until: 0, closed_reason: null, unverified: false };

test('soma_spawn picks a seat through pickSeat, launches with { configDir }, and writes the seat label onto the row', async () => {
  const bt = await load();
  const picks = [];
  const launches = [];
  const c = orch({ tasks: [{ id: 'cr-1' }], config: SEATED, deps: {
    pickSeat: (now, cfg) => { picks.push([now, cfg]); return SEAT_B; },
    spawnLead: (t, opts) => { launches.push(opts); return { lead: t.id, session_uuid: 'u-cr-1', tmux_target: 'lead-cr-1', cwd: '/w/cr-1' }; },
  } });
  const r = await bt.orchTools(c).get('soma_spawn')({ task_id: 'cr-1' });
  assert.equal(r.spawned, true);
  assert.equal(r.seat, 'seat-b');
  assert.equal(picks.length, 1);
  assert.equal(picks[0][1], SEATED, 'the pool is asked against THIS config, so a seat removed from soma.json is never picked');
  assert.ok(Number.isFinite(picks[0][0]), 'and against a clock');
  assert.deepEqual(launches, [{ configDir: '/s/b' }], 'the config dir, not the label: the spawner cannot resolve a label');
  assert.equal(c.s.fleet.tasks[0].seat, 'seat-b', 'through the store, in the same record write as the uuid');
  assert.ok(!JSON.stringify(r).includes('/s/'), 'the reply carries the label; a config_dir is a path');
});

test('soma_spawn with every seat closed refuses before the claim: the row stays queued, nothing launches, and the sentence names soma_status', async () => {
  const bt = await load();
  const c = orch({ tasks: [{ id: 'cr-1' }], config: SEATED, deps: { pickSeat: () => null } });
  const r = await bt.orchTools(c).get('soma_spawn')({ task_id: 'cr-1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /every configured seat is closed or unverified/);
  assert.match(r.error, /soma_status/);
  assert.deepEqual(c.s.spawns, []);
  assert.equal(c.s.fleet.tasks[0].status, 'queued');
  assert.equal(c.s.updates, 0, 'refused BEFORE the transaction, so no row was claimed and released');
});

test('soma_spawn and soma_resume refuse a soma.json loadConfig refuses, before the claim or the launch, in a sentence with no path in it', async () => {
  const bt = await load();
  // `configOf()` reads a THROW as "no config", which is right for a reader and wrong for a launch:
  // once loadConfig began refusing a seats that is not an array, soma_spawn skipped its max_leads
  // gate on such a file, claimed the row, stamped the stagger clock and failed
  // only at the spawner's own read — and soma_resume went seat-blind into resumeLead's. The loader's
  // own sentence carries the file's path, which the bus never echoes.
  const refused = () => { throw new Error('/abs/soma/soma.json: seats must be an array of { "config_dir": …, "label": … } entries, or [] (or no seats key) for no rotation, got an object'); };
  const fixture = (deps = {}) => orch({ tasks: [{ id: 'cr-1' }, { id: 'cr-2', status: 'failed', lead_session_uuid: 'u2' }], deps });
  const c = fixture({ loadConfig: refused });
  const tools = bt.orchTools(c);

  const spawn = await tools.get('soma_spawn')({ task_id: 'cr-1' });
  assert.equal(spawn.ok, false);
  assert.match(spawn.error, /soma\.json could not be loaded/);
  assert.match(spawn.error, /soma doctor/, 'the command that names the fault');
  assert.ok(!spawn.error.includes('/abs/'), `the refusal echoed a path: ${spawn.error}`);
  assert.deepEqual(c.s.spawns, []);
  assert.equal(c.s.updates, 0, 'refused before the transaction: no row was claimed and released');
  assert.equal(c.s.fleet.tasks[0].status, 'queued');
  assert.equal(c.s.fleet.last_spawn_at, null, 'and the stagger clock was not stamped');

  const resume = await tools.get('soma_resume')({ lead: 'cr-2' });
  assert.equal(resume.ok, false);
  assert.match(resume.error, /soma\.json could not be loaded/);
  assert.ok(!resume.error.includes('/abs/'), `the refusal echoed a path: ${resume.error}`);
  assert.deepEqual(c.s.resumes, []);
  assert.equal(c.s.fleet.tasks[1].status, 'failed');

  // A reader acts on nothing, so it keeps answering on the same file.
  const status = await tools.get('soma_status')({});
  assert.notEqual(status.ok, false, `soma_status refused: ${status.error}`);
  assert.ok(Array.isArray(status.queue), 'soma_status still renders the fleet');

  // The control: a config that loads spawns and resumes exactly as before.
  const ok = fixture();
  const okTools = bt.orchTools(ok);
  assert.equal((await okTools.get('soma_spawn')({ task_id: 'cr-1' })).spawned, true);
  assert.notEqual((await okTools.get('soma_resume')({ lead: 'cr-2' })).ok, false);
  assert.deepEqual(ok.s.spawns, ['cr-1']);
  assert.deepEqual(ok.s.resumes, ['cr-2']);
});

test('soma_spawn and soma_resume with no seats configured launch as before: {} and seat: null, and the pool is never asked', async () => {
  const bt = await load();
  let picks = 0;
  const launches = [];
  const c = orch({ tasks: [{ id: 'cr-1' }, { id: 'cr-2', status: 'failed', lead_session_uuid: 'u2' }], deps: {
    pickSeat: () => { picks += 1; return SEAT_B; },
    spawnLead: (t, opts) => { launches.push(opts); return { lead: t.id, session_uuid: `u-${t.id}`, tmux_target: `lead-${t.id}`, cwd: `/w/${t.id}` }; },
    resumeLead: (t, opts) => { launches.push(opts); return { lead: t.id, session_uuid: t.lead_session_uuid }; },
  } });
  const tools = bt.orchTools(c);
  assert.equal((await tools.get('soma_spawn')({ task_id: 'cr-1' })).seat, null);
  assert.equal((await tools.get('soma_resume')({ lead: 'cr-2' })).seat, null);
  assert.deepEqual(launches, [{}, {}]);
  assert.equal(picks, 0, 'a fleet with no seats never reads state/seats.json');
  assert.equal(c.s.fleet.tasks[0].seat, null);
  assert.equal(c.s.fleet.tasks[1].seat, null);
});

test('soma_resume picks a seat and writes it, and a pickSeat that throws is a refusal that names no path', async () => {
  const bt = await load();
  const launches = [];
  const c = orch({ tasks: [{ id: 'cr-1', status: 'failed', lead_session_uuid: 'u1', seat: 'seat-a' }], config: SEATED, deps: {
    pickSeat: () => SEAT_B,
    resumeLead: (t, opts) => { launches.push(opts); return { lead: t.id, session_uuid: t.lead_session_uuid }; },
  } });
  const r = await bt.orchTools(c).get('soma_resume')({ lead: 'cr-1' });
  assert.equal(r.resumed, true);
  assert.equal(r.seat, 'seat-b');
  assert.deepEqual(launches, [{ configDir: '/s/b' }]);
  assert.equal(c.s.fleet.tasks[0].seat, 'seat-b', 'seat-a was where it died; seat-b is where it runs now');
  const boom = Object.assign(new Error('seats: cfg.seats[0] must be an object { config_dir, label }, got string — see /Users/x/.soma/soma.json'), { code: 'EBADSEAT' });
  const bad = orch({ tasks: [{ id: 'cr-1', status: 'failed', lead_session_uuid: 'u1' }], config: SEATED, deps: { pickSeat: () => { throw boom; } } });
  const refused = await bt.orchTools(bad).get('soma_resume')({ lead: 'cr-1' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /soma\.json\.seats could not be read/);
  assert.match(refused.error, /EBADSEAT/);
  assert.ok(!/[/\\]/.test(refused.error), refused.error);
  assert.deepEqual(bad.s.resumes, []);
  assert.equal(bad.s.fleet.tasks[0].status, 'failed', 'a refused resume claims no slot');
});

test('cfg.seats [] — what loadConfig hands every un-seated fleet — launches as before, and never asks the pool', async () => {
  const bt = await load();
  // MEASURED: neither live soma.json has a `seats` key, so `loadConfig()` returns `seats: []` from
  // DEFAULTS. `[]` is therefore the production value of `seatFor`'s predicate, and every test here
  // used either "no seats key" or "two seats". Dropping the `&& cfg.seats.length > 0` half left
  // the full 1296-test suite green while turning every `soma_spawn` and `soma_resume` on a
  // live-shaped fleet into "every configured seat is closed or unverified (0 in soma.json)".
  let picks = 0;
  const launches = [];
  const EMPTY = { max_leads: 10, repos: {}, budgets: { standard: { tokens_cap: 1000 } }, seats: [] };
  const c = orch({ tasks: [{ id: 'cr-1' }, { id: 'cr-2', status: 'failed', lead_session_uuid: 'u2' }], config: EMPTY, deps: {
    pickSeat: () => { picks += 1; return SEAT_B; },
    spawnLead: (t, opts) => { launches.push(opts); return { lead: t.id, session_uuid: `u-${t.id}`, tmux_target: `lead-${t.id}`, cwd: `/w/${t.id}` }; },
    resumeLead: (t, opts) => { launches.push(opts); return { lead: t.id, session_uuid: t.lead_session_uuid }; },
  } });
  const tools = bt.orchTools(c);
  const spawned = await tools.get('soma_spawn')({ task_id: 'cr-1' });
  assert.equal(spawned.spawned, true, '`[]` is not "every seat is closed"');
  assert.equal(spawned.seat, null);
  const resumed = await tools.get('soma_resume')({ lead: 'cr-2' });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.seat, null);
  assert.deepEqual(launches, [{}, {}], 'the spawner gets its own env, exactly as before seats existed');
  assert.equal(picks, 0, 'a fleet with no seats never reads state/seats.json');
});

test('a seat that is not a usable record is a refusal, not a launch with configDir undefined', async () => {
  const bt = await load();
  // `pickSeat` is a dep: an older bus, a future pool, or a half-written `state/seats.json` row can
  // answer with something that is not a seat. Without the shape check `launchOptsFor` builds
  // `{ configDir: undefined }`, which `buildLeadEnv` reads as "no seat" — so the lead launches on
  // the bus process's OWN account, which is the one thing the refusal exists to prevent: that dir
  // is a seat too, and may be the very account that just closed. Dropping the check to `seat ===
  // null` left the full suite green.
  for (const answer of [{ label: 'seat-b' }, { config_dir: '', label: 'seat-b' }, 'seat-b', 42, [], undefined]) {
    const c = orch({ tasks: [{ id: 'cr-1' }], config: SEATED, deps: { pickSeat: () => answer } });
    const r = await bt.orchTools(c).get('soma_spawn')({ task_id: 'cr-1' });
    const name = JSON.stringify(answer) ?? 'undefined';
    assert.equal(r.ok, false, name);
    assert.match(r.error, /every configured seat is closed or unverified/, name);
    assert.deepEqual(c.s.spawns, [], name);
    assert.equal(c.s.fleet.tasks[0].status, 'queued', name);
  }
});
