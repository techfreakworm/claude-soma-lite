import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

/**
 * A fresh state root plus a fresh `fleet.mjs` instance pointed at it.
 *
 * `tag` (not `Date.now()`) busts the module cache, so two tests that start in the
 * same millisecond still get their own instance — the lock's "do I already hold
 * it" flag is module state. `t.after` matters because `npm test` runs the whole
 * suite in one process: an unremoved mkdtemp dir per test is a real leak.
 */
async function fresh(t, tag) {
  const home = mkdtempSync(join(tmpdir(), 'soma-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.SOMA_HOME = home;
  const { ensureTree, p } = await import('../bin/lib/paths.mjs?' + tag);
  ensureTree();
  return { home, p, f: await import('../bin/lib/fleet.mjs?' + tag) };
}

/** A task literal with every required field, so tests only state what they vary. */
const task = (id, extra = {}) => ({ id, title: 't', repo: 'r', source: {}, brief: 'b', ...extra });

/** Burn `ms` of wall clock, so a test that compares timestamps is not comparing one. */
const spin = (ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until);
};

/**
 * The error `fn` threw, for the cases where one `assert.throws` regex is not the whole
 * claim — an error that has to carry a path *and* a remedy needs an assertion per part,
 * so a message that keeps one and drops the other cannot pass.
 */
const capture = (fn, why) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return assert.fail(`expected a throw: ${why}`);
};

test('enqueue validates ids and dedupes', async (t) => {
  const { f } = await fresh(t, 'enqueue');
  const r = f.enqueue([
    { id: 'cr-1', title: 'a', repo: 'acme/app', source: { kind: 'md', ref: 'x' }, brief: 'b' },
    { id: 'BadId', title: 'x', repo: 'r', source: {}, brief: '' },
    { id: 'cr-1', title: 'dupe', repo: 'r', source: {}, brief: '' },
  ]);
  assert.deepEqual(r.queued, ['cr-1']);
  assert.equal(f.readFleet().tasks.length, 1);
  assert.equal(f.readFleet().tasks[0].status, 'queued');
});

test('admit respects max_leads counting only spawned', async (t) => {
  const { f } = await fresh(t, 'admit');
  f.enqueue([1, 2, 3].map((n) => ({ id: `cr-${n}`, title: 't', repo: 'r', source: {}, brief: 'b' })));
  const cfg = { max_leads: 2 };
  const first = f.admit(f.readFleet(), cfg);
  assert.equal(first, 'cr-1');
  f.setTaskStatus('cr-1', 'spawned');
  f.setTaskStatus('cr-2', 'spawned');
  assert.equal(f.admit(f.readFleet(), cfg), null); // 2 active == max
  f.setTaskStatus('cr-1', 'done');
  assert.equal(f.admit(f.readFleet(), cfg), 'cr-3'); // slot freed
});

test('setTaskStatus rejects unknown status', async (t) => {
  const { f } = await fresh(t, 'status');
  f.enqueue([{ id: 'cr-1', title: 't', repo: 'r', source: {}, brief: 'b' }]);
  assert.throws(() => f.setTaskStatus('cr-1', 'bogus'), /status/);
});

// The three tests above are the original spec, verbatim but for a `fresh()`
// that cleans up after itself. The rest pin the invariants they imply — the
// admission slot arithmetic (decision D3), the id regex that keeps task ids off
// the filesystem's control characters, and the lock that makes fleet.json safe
// for the bus and the watchdog to write at the same time.

test('every non-spawned status frees an admission slot', async (t) => {
  const { f } = await fresh(t, 'slots');
  const cfg = { max_leads: 1 };
  f.enqueue(['a', 'b'].map((id) => task(id)));

  // 'queued' is not active either — otherwise the very first admission would be
  // blocked by the queue it is draining.
  assert.equal(f.countActive(f.readFleet()), 0);
  assert.equal(f.admit(f.readFleet(), cfg), 'a');

  for (const terminal of ['done', 'failed', 'blocked', 'skipped']) {
    f.setTaskStatus('a', 'spawned');
    assert.equal(f.countActive(f.readFleet()), 1);
    assert.equal(f.admit(f.readFleet(), cfg), null, 'a spawned lead holds the only slot');

    f.setTaskStatus('a', terminal);
    assert.equal(f.countActive(f.readFleet()), 0, `${terminal} must not count as active`);
    assert.equal(f.admit(f.readFleet(), cfg), 'b', `${terminal} must free the slot for the next task`);
  }
});

test('admit is FIFO over queued tasks and refuses to guess max_leads', async (t) => {
  const { f } = await fresh(t, 'admit-guards');
  assert.equal(f.admit(f.readFleet(), { max_leads: 10 }), null, 'nothing queued');

  f.enqueue(['a', 'b', 'c'].map((id) => task(id)));
  assert.equal(f.admit(f.readFleet(), { max_leads: 0 }), null, 'a zero cap admits nothing');

  // Insertion order is priority order, and finished tasks are skipped rather than
  // re-admitted.
  f.setTaskStatus('a', 'done');
  assert.equal(f.admit(f.readFleet(), { max_leads: 10 }), 'b');
  f.setTaskStatus('b', 'spawned');
  assert.equal(f.admit(f.readFleet(), { max_leads: 10 }), 'c');

  // `undefined >= n` is false, so a cfg that lost max_leads would admit forever —
  // 27 leads at once instead of 10. And null/''/[] all coerce to 0, so a blanket
  // Number() turns the same misconfiguration into a fleet that never spawns again.
  // Both are worse than a throw.
  // A fractional cap is rejected for a third reason: `2.5` reads as a cap of 3.
  for (const cfg of [{}, undefined, ...[null, '', ' ', [], true, {}, NaN, Infinity, -1, 2.5, '2.5'].map((max_leads) => ({ max_leads }))]) {
    assert.throws(() => f.admit(f.readFleet(), cfg), TypeError, `max_leads ${JSON.stringify(cfg)} must be rejected`);
  }
  assert.equal(f.admit(f.readFleet(), { max_leads: '10' }), 'c', 'a stringly-typed config still works');
});

test('the id regex is the traversal guard, and a missing id is not the string "undefined"', async (t) => {
  const { f } = await fresh(t, 'ids');
  const bad = [
    // Ids that must not reach `leads/<id>/`, `logs/<id>.log`, `events/<id>.ndjson`
    // or the tmux session name `lead-<id>`.
    ...['../etc', 'a/b', 'a\\b', '.', '..', 'a.b', 'CR-1', '1cr', '-cr', '', 'cr 1', 'cr_1',
      'cr-1\n', 'cr-1\r', `a${'b'.repeat(64)}`].map((id) => task(id)),
    // `ID_RE.test(undefined)` is TRUE — it tests the *string* "undefined", and so is
    // `.test(null)`. Without a typeof guard a task with no id joins the fleet under
    // the id "undefined"; every later id-keyed path then collides on it.
    { title: 't', repo: 'r', source: {}, brief: 'b' },
    ...[null, 12, ['cr-1'], { toString: () => 'cr-1' }].map((id) => task(id)),
    // Entries that are not objects at all — soma_enqueue hands this array straight
    // through from a JSON-RPC tool call.
    null, undefined, 'cr-1', 42,
  ];
  const r = f.enqueue(bad);
  assert.deepEqual(r.queued, []);
  assert.equal(r.skipped.length, bad.length);
  assert.deepEqual(f.readFleet().tasks, [], 'not one of them may reach the checkpoint');

  const ok = ['a', 'cr-1', 'z9', 'a-b-c-1', `a${'b'.repeat(63)}`];
  assert.deepEqual(f.enqueue(ok.map((id) => task(id))).queued, ok);

  // Dupes are reported, not silently swallowed: the orchestrator has to be able to
  // tell "queued" from "already there".
  const again = f.enqueue([task('cr-1'), task('cr-2')]);
  assert.deepEqual(again.queued, ['cr-2']);
  assert.deepEqual(again.skipped, [{ id: 'cr-1', reason: 'duplicate' }]);

  assert.throws(() => f.enqueue(), TypeError);
  assert.throws(() => f.enqueue('cr-1'), TypeError);
});

test('a queued task carries the whole record, and the checkpoint round-trips through the filesystem', async (t) => {
  const { f, p } = await fresh(t, 'record');
  assert.deepEqual(f.readFleet(), { tasks: [], last_spawn_at: null }, 'a fleet with no file reads empty');

  f.enqueue([{ id: 'cr-1', title: 'a', repo: 'acme/app', source: { kind: 'md', ref: 'x' }, brief: 'do it', base_branch: 'develop', budget_class: 'standard' }]);
  f.enqueue([task('cr-2', { title: undefined, repo: undefined, source: undefined, brief: undefined })]);

  const [one, two] = f.readFleet().tasks;
  assert.deepEqual(Object.keys(one).sort(), [
    'attempts', 'base_branch', 'base_sha', 'brief', 'budget_class', 'budget_override', 'created', 'id',
    'launching_at', 'lead_session_uuid', 'repo', 'rotations', 'seat', 'source', 'status', 'title', 'tmux_session',
    'updated', 'verify_hint',
  ]);
  assert.equal(one.status, 'queued');
  assert.equal(one.attempts, 0);
  assert.equal(one.base_branch, 'develop');
  // A class given at enqueue is written twice: `budget_class` for display, which the inbox fold
  // then keeps following the lead's harness, and `budget_override`, the pin the breaker reads
  // first and nothing else ever writes.
  assert.equal(one.budget_class, 'standard');
  assert.equal(one.budget_override, 'standard');
  assert.deepEqual(one.source, { kind: 'md', ref: 'x' });
  assert.ok(Number.isInteger(one.created) && one.created === one.updated);
  // No verify command on the task and no repo map to fall back on: null, written, not absent.
  assert.equal(one.verify_hint, null);

  // Absent optional fields become null/{}/'' rather than `undefined`, which
  // JSON.stringify would drop — the in-memory record and the persisted one have to
  // have the same shape or a consumer's `'field' in task` check flips after a reload.
  assert.deepEqual(Object.keys(two).sort(), Object.keys(one).sort());
  assert.equal(two.title, null);
  assert.equal(two.repo, null);
  assert.deepEqual(two.source, {});
  assert.equal(two.brief, '');
  assert.equal(two.budget_class, null);
  assert.equal(two.budget_override, null, 'no class pinned: the lead is priced by its harness');
  assert.equal(two.verify_hint, null);

  const onDisk = JSON.parse(readFileSync(p('state', 'fleet.json'), 'utf8'));
  assert.deepEqual(onDisk.tasks.map((x) => x.id), ['cr-1', 'cr-2']);
  assert.equal(onDisk.last_spawn_at, null);
  assert.deepEqual(
    readdirSync(p('state')).filter((n) => n.endsWith('.tmp')),
    [],
    'tmp+rename must leave no scratch file behind',
  );

  // The bus and the watchdog are separate processes: state lives in the file, not
  // in the module instance that wrote it.
  const reloaded = await import('../bin/lib/fleet.mjs?record-reload');
  assert.deepEqual(reloaded.readFleet().tasks.map((x) => x.id), ['cr-1', 'cr-2']);
});

test('a corrupt checkpoint fails loudly instead of being read — and overwritten — as an empty fleet', async (t) => {
  const { f, p } = await fresh(t, 'corrupt');
  const fp = p('state', 'fleet.json');
  f.enqueue([task('cr-1')]);

  for (const corrupt of ['{"tasks": [{"id"', 'null', '[]', '"x"', '{"tasks": {}}', '']) {
    writeFileSync(fp, corrupt);
    assert.throws(() => f.readFleet(), `readFleet accepted ${JSON.stringify(corrupt)}`);
    // The bytes are what a rebuild would work from; enqueue must not land on top.
    assert.throws(() => f.enqueue([task('cr-2')]));
    assert.equal(readFileSync(fp, 'utf8'), corrupt, 'a failed enqueue must leave the file untouched');
    assert.equal(existsSync(p('state', 'fleet.lock')), false, 'and must still release the lock');
  }

  // A checkpoint from a newer soma keeps its unknown fields through this soma's
  // read-modify-write cycle rather than being silently downgraded.
  writeFileSync(fp, JSON.stringify({ tasks: [], last_spawn_at: 7, future_field: { keep: true } }));
  f.enqueue([task('cr-3')]);
  const after = JSON.parse(readFileSync(fp, 'utf8'));
  assert.deepEqual(after.future_field, { keep: true });
  assert.equal(after.last_spawn_at, 7);
  assert.deepEqual(after.tasks.map((x) => x.id), ['cr-3']);
});

// --------------------------------------------------------------------------- verify_hint
//
// The command a lead's verifier runs. Two readers depend on finding it on the row:
// `standing.mjs` renders it as the brief's `- verify:` line and `soma_task` returns it. Both
// read `task.verify_hint`, so a row built without the field gives every lead a brief that says
// `verify: (none configured)`, even when the orchestrator sent one or soma.json configures one
// for the repo.

/** Each row's verify_hint by id. A missing key shows in a failed diff as `undefined`, not as null. */
const hints = (fleet) => Object.fromEntries(fleet.tasks.map((x) => [x.id, x.verify_hint]));

test('a task\'s own verify_hint lands on the row as given, and survives the trip through the file', async (t) => {
  const { f, p } = await fresh(t, 'verify-own');
  f.enqueue([task('cr-1', { verify_hint: 'npm test' }), task('cr-2', { verify_hint: '  yarn test --run ' })]);
  // Stored as given, not trimmed. The row records what the orchestrator sent, and the brief's
  // `fact()` already flattens and trims whatever it renders.
  const want = { 'cr-1': 'npm test', 'cr-2': '  yarn test --run ' };
  assert.deepEqual(hints(f.readFleet()), want);
  assert.deepEqual(hints(JSON.parse(readFileSync(p('state', 'fleet.json'), 'utf8'))), want, 'the checkpoint on disk carries it');
  // The bus that enqueues and the lead's bus that answers `soma_task` are different processes,
  // so the file has to carry the hint, not the module instance that wrote it.
  const reloaded = await import('../bin/lib/fleet.mjs?verify-own-reload');
  assert.deepEqual(hints(reloaded.readFleet()), want);
});

test('a task with no usable verify_hint of its own takes its repo\'s from soma.json, and its own still wins', async (t) => {
  const { f } = await fresh(t, 'verify-repo');
  const repos = { r: { path: '/repos/r', verify_hint: 'yarn test' } };
  f.enqueue([
    task('cr-1'),
    // None of these is a command, so none may hide the repo's: '' and whitespace come from an
    // unfilled template slot, and the rest are type slips in a hand-written plan.
    task('cr-2', { verify_hint: '' }),
    task('cr-3', { verify_hint: '   ' }),
    task('cr-4', { verify_hint: null }),
    task('cr-5', { verify_hint: 42 }),
    task('cr-6', { verify_hint: {} }),
    task('cr-7', { verify_hint: true }),
    // A command named for this task is more specific than the repo's default.
    task('cr-8', { verify_hint: 'npm test' }),
  ], { repos });
  assert.deepEqual(hints(f.readFleet()), {
    'cr-1': 'yarn test', 'cr-2': 'yarn test', 'cr-3': 'yarn test', 'cr-4': 'yarn test',
    'cr-5': 'yarn test', 'cr-6': 'yarn test', 'cr-7': 'yarn test', 'cr-8': 'npm test',
  });
});

test('verify_hint is null when neither the task nor its repo names one, and only the repo map\'s own entries count', async (t) => {
  const { f } = await fresh(t, 'verify-none');
  // `r` carries a real hint, so a null below is never just the map being empty.
  const repos = {
    r: { path: '/repos/r', verify_hint: 'yarn test' },
    bare: { path: '/repos/bare' },
    blank: { path: '/repos/blank', verify_hint: '  ' },
    odd: { path: '/repos/odd', verify_hint: 7 },
    gone: null,
  };
  f.enqueue([
    task('cr-1', { repo: 'bare' }),         // an entry with no hint
    task('cr-2', { repo: 'blank' }),        // a blank one
    task('cr-3', { repo: 'odd' }),          // one that is not a command
    task('cr-4', { repo: 'gone' }),         // a hand-edited null entry
    task('cr-5', { repo: 'elsewhere' }),    // a repo the map does not name
    task('cr-6', { repo: undefined }),      // no repo at all
    // Names every plain object answers to through its prototype: `repos[name]` is
    // Object.prototype, the Object constructor and a function. None is a configured repo.
    task('cr-7', { repo: '__proto__' }),
    task('cr-8', { repo: 'constructor' }),
    task('cr-9', { repo: 'toString' }),
  ], { repos });
  // No map at all: no second argument, an empty one, and the null or undefined a bus hands
  // over when no config is wired or soma.json will not load. Enqueue must still work.
  f.enqueue([task('cr-10')]);
  f.enqueue([task('cr-11')], {});
  f.enqueue([task('cr-12')], { repos: null });
  f.enqueue([task('cr-13')], { repos: undefined });
  // An entry the map only inherits is not one the operator configured.
  f.enqueue([task('cr-14', { repo: 'inherited' })], { repos: Object.create({ inherited: { path: '/repos/i', verify_hint: 'yarn test' } }) });

  const ids = Array.from({ length: 14 }, (_, i) => `cr-${i + 1}`);
  assert.deepEqual(f.readFleet().tasks.map((x) => x.id), ids, 'every task was queued');
  assert.deepEqual(hints(f.readFleet()), Object.fromEntries(ids.map((id) => [id, null])));
});

test('a repo is looked up by its name only: not by a key its string form matches, and not in an array', async (t) => {
  const { f } = await fresh(t, 'verify-repo-key');
  const entry = { path: '/repos/r', verify_hint: 'yarn test' };
  // `Object.hasOwn` turns its key into a string, so a repo that is not a string finds an own key
  // spelled like it: null finds "null", undefined finds "undefined", 42 finds "42". None of them
  // is a repo name. `r` in the same map is the control: a real name still finds its hint.
  f.enqueue([task('cr-1', { repo: null }), task('cr-2', { repo: 'r' })], { repos: { null: entry, r: entry } });
  f.enqueue([task('cr-3', { repo: undefined })], { repos: { undefined: entry } });
  f.enqueue([task('cr-4', { repo: 42 })], { repos: { 42: entry } });
  // soma.json's repos is an object keyed by name. An array's indexes are own keys too, but an
  // array is not a repo map.
  f.enqueue([task('cr-5', { repo: '0' })], { repos: [entry] });
  assert.deepEqual(hints(f.readFleet()), { 'cr-1': null, 'cr-2': 'yarn test', 'cr-3': null, 'cr-4': null, 'cr-5': null });
});

test('a verify_hint given at enqueue, or configured for the repo, reaches the lead in its standing brief and in soma_task', async (t) => {
  const { f } = await fresh(t, 'verify-e2e');
  const { writeStanding } = await import('../bin/lib/standing.mjs?verify-e2e');
  const { leadTools } = await import('../bin/lib/bus-tools.mjs?verify-e2e');

  /**
   * The two places a lead learns its verify command, both fed from the real row: the brief
   * the spawner writes from it, and `soma_task` answered by a `taskFor` that reads the real
   * checkpoint the way `soma-bus.mjs` wires it.
   */
  const lead = async (id) => {
    const row = f.readFleet().tasks.find((x) => x.id === id);
    const brief = readFileSync(writeStanding(row), 'utf8');
    const tools = leadTools({ env: { SOMA_LEAD_NAME: id }, deps: { taskFor: (lid) => f.readFleet().tasks.find((x) => x.id === lid) ?? {} } });
    return { brief, verify: brief.split('\n').filter((l) => l.startsWith('- verify:')), task: await tools.get('soma_task')({}) };
  };

  // Sent by the orchestrator with the task.
  f.enqueue([{ id: 'cr-1', repo: 'r', brief: 'b', verify_hint: 'npm test' }]);
  const own = await lead('cr-1');
  assert.equal(own.verify.length, 1, 'the brief has exactly one verify line');
  assert.match(own.verify[0], /^- verify: `npm test`/);
  assert.doesNotMatch(own.brief, /\(none configured\)/);
  assert.equal(own.task.verify_hint, 'npm test');

  // Configured for the repo in soma.json, with nothing on the task.
  f.enqueue([{ id: 'cr-2', repo: 'r', brief: 'b' }], { repos: { r: { path: '/repos/r', verify_hint: 'yarn test' } } });
  const cfg = await lead('cr-2');
  assert.equal(cfg.verify.length, 1, 'the brief has exactly one verify line');
  assert.match(cfg.verify[0], /^- verify: `yarn test`/);
  assert.doesNotMatch(cfg.brief, /\(none configured\)/);
  assert.equal(cfg.task.verify_hint, 'yarn test');
});

// --------------------------------------------------------------------------- seats (account rotation)

test('a queued row starts with seat: null — written, not absent, so the key survives a reload', async (t) => {
  const { f } = await fresh(t, 'seat-null');
  f.enqueue([task('cr-1')]);
  assert.equal(f.readFleet().tasks[0].seat, null);
});

test('a queued row starts with rotations: [] — an empty list, not a missing one', async (t) => {
  const { f } = await fresh(t, 'rotations-empty');
  f.enqueue([task('cr-1')]);
  assert.deepEqual(f.readFleet().tasks[0].rotations, []);
});

test('setTaskStatus stamps the spawn clock, refuses unknown ids, and heals a wiped state dir', async (t) => {
  const { f, p } = await fresh(t, 'set-status');
  f.enqueue([task('cr-1')]);
  assert.equal(f.readFleet().last_spawn_at, null);

  const before = Date.now();
  f.setTaskStatus('cr-1', 'spawned');
  // Nothing else in the system stamps `last_spawn_at`, and wd/admission.mjs gates
  // the 90 s stagger on it: unstamped, the stagger is dead config.
  const stamped = f.readFleet().last_spawn_at;
  assert.ok(Number.isInteger(stamped) && stamped >= before, `last_spawn_at not stamped on spawn (${stamped})`);

  // Only a genuine transition counts. A reconciler re-affirming the status of a live
  // lead every 30 s tick would otherwise keep pushing the 90 s stagger out of reach
  // and starve admission for as long as one lead runs.
  spin(2);
  f.setTaskStatus('cr-1', 'spawned');
  assert.ok(f.readFleet().tasks[0].updated > stamped, 'the clock moved, so this re-affirm is a real test');
  assert.equal(f.readFleet().last_spawn_at, stamped, 're-affirming spawned must not push the stagger clock');

  f.setTaskStatus('cr-1', 'done');
  assert.equal(f.readFleet().last_spawn_at, stamped, 'only a spawn moves the spawn clock');
  assert.ok(f.readFleet().tasks[0].updated >= stamped);

  // Ids are never removed from the fleet, so an unknown one is a caller bug — and a
  // silent no-op here is how `soma_kill cr-99` reports success having killed nothing.
  assert.throws(() => f.setTaskStatus('cr-99', 'failed'), /unknown task/);
  assert.throws(() => f.setTaskStatus('cr-1', 'bogus'), /status/);
  assert.equal(f.readFleet().tasks[0].status, 'done', 'a rejected write leaves the checkpoint alone');

  // A tree wiped under a running watchdog must not wedge every later tick.
  rmSync(p('state'), { recursive: true, force: true });
  assert.deepEqual(f.enqueue([task('cr-2')]).queued, ['cr-2']);
  assert.deepEqual(f.readFleet().tasks.map((x) => x.id), ['cr-2']);
});

test('withFleetLock: holds, releases on throw, nests, and never wedges on a stale or garbage lock', async (t) => {
  const { f, p } = await fresh(t, 'lock');
  const lock = p('state', 'fleet.lock');

  assert.equal(f.withFleetLock(() => {
    assert.equal(readFileSync(lock, 'utf8').trim(), String(process.pid), 'the lock records its owner');
    return 'value';
  }), 'value');
  assert.equal(existsSync(lock), false, 'released on the happy path');

  assert.throws(() => f.withFleetLock(() => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(lock), false, 'released when fn throws');

  // lease.mjs wraps fleet-lock-guarded work of its own; a nested acquire that
  // queued behind itself would deadlock for the whole timeout and then throw.
  assert.equal(f.withFleetLock(() => f.withFleetLock(() => 'inner')), 'inner');
  assert.equal(existsSync(lock), false);

  // Release is synchronous, so an async fn would unlock at its first await and run
  // the rest of its "protected" work in the open. Refused, not awaited.
  assert.throws(() => f.withFleetLock(async () => 'nope'), TypeError);
  assert.throws(() => f.withFleetLock(() => f.withFleetLock(async () => 'nope')), TypeError);
  assert.throws(() => f.updateFleet(async () => 'nope'), TypeError);
  assert.equal(existsSync(lock), false, 'and the lock is released anyway');

  // A lock left by a dead process is taken over.
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  writeFileSync(lock, String(dead));
  assert.equal(f.withFleetLock(() => 'took over', { timeoutMs: 1000 }), 'took over');

  // ...and so is one with no readable pid. `Number('')` is 0 and `process.kill(0, 0)`
  // signals our own process group without throwing, so a truncated lock file reads
  // as "alive" to a naive check and wedges the fleet permanently.
  for (const garbage of ['', '   ', 'not-a-pid', '0', '-1', String(dead) + '\n']) {
    writeFileSync(lock, garbage);
    assert.equal(f.withFleetLock(() => 'ok', { timeoutMs: 1000 }), 'ok', `wedged on lock content ${JSON.stringify(garbage)}`);
  }

  // A live holder is waited on, then reported — never stolen.
  writeFileSync(lock, String(process.pid));
  let ran = false;
  assert.throws(() => f.withFleetLock(() => { ran = true; }, { timeoutMs: 150 }), /fleet\.lock/);
  assert.equal(ran, false);
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid), 'a timed-out waiter leaves the live lock alone');

  // Nor is a lock we cannot *read*. An EACCES is the environment misbehaving, not
  // evidence the owner died — a takeover on the strength of one is a permissions
  // hiccup promoted into two writers. (Under a root test runner the read succeeds and
  // this is the live-holder case above, which must refuse the steal for its own reason.)
  chmodSync(lock, 0o000);
  ran = false;
  const unreadable = capture(() => f.withFleetLock(() => { ran = true; }, { timeoutMs: 100 }), 'an unreadable lock');
  assert.equal(ran, false, 'an unreadable lock must not be stolen');
  chmodSync(lock, 0o600);
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid), 'and must be left exactly as it was');

  // Refusing to steal it is right, and it also means nothing soma does *later* clears it:
  // the next call fails identically, so the wait is unbounded across calls and an operator
  // is the only way out of it. So the error has to be addressed to one — naming the file,
  // absolutely, because it moves with $SOMA_HOME, and saying what to do about it. "Gave up
  // after 100ms" alone reads as a hang to wait out, which this is not. (A root runner reads
  // the file fine and gets the live-holder message instead; the case below covers every uid.)
  if (process.getuid?.() !== 0) {
    assert.match(unreadable.message, /unreadable \(EACCES\)/, 'the error must say why it could not be read');
    assert.ok(unreadable.message.includes(lock), `and name the absolute lock path: ${unreadable.message}`);
    assert.match(unreadable.message, /remove it by hand if no soma process is running/, 'and how to clear it');
  }
  rmSync(lock);

  // The same dead end reached another way: something in the lock's place that is not a file
  // at all. EISDIR for every uid, so this one holds under a root runner too.
  mkdirSync(lock);
  ran = false;
  const notAFile = capture(() => f.withFleetLock(() => { ran = true; }, { timeoutMs: 100 }), 'a lock that is a directory');
  assert.equal(ran, false, 'a lock soma cannot classify must not be entered past either');
  assert.match(notAFile.message, /unreadable \(EISDIR\)/, 'the error must say why it could not be read');
  assert.ok(notAFile.message.includes(lock), `and name the absolute lock path: ${notAFile.message}`);
  assert.match(notAFile.message, /remove it by hand if no soma process is running/, 'and how to clear it');
  rmSync(lock, { recursive: true });

  // `linkLanded`'s nlink === 2 shortcut returns from the acquire *before* the live-holder
  // check above ever runs, so it has to be proof rather than a guess — and it is proof only
  // while the scratch name is ours alone. When it was `fleet.lock.<pid>.tmp` anyone could
  // derive it, and on the one deployment the shortcut exists for (a shared $SOMA_HOME on a
  // network filesystem) host B's pid 500 derives host A's pid 500's name exactly. Pre-link
  // that name to a live holder's lock and nlink === 2 is true of a lock we never won: this
  // entered the critical section beside pid 1 — and deleted pid 1's lock on the way out.
  const guessable = `${lock}.${process.pid}.tmp`;
  writeFileSync(lock, '1\n'); // pid 1 is alive on every host, and never ours to steal from
  linkSync(lock, guessable);
  ran = false;
  assert.throws(() => f.withFleetLock(() => { ran = true; }, { timeoutMs: 100 }), /fleet\.lock/);
  assert.equal(ran, false, 'a scratch name a stranger can derive must not prove we hold the lock');
  assert.equal(readFileSync(lock, 'utf8'), '1\n', 'and the live holder must keep its lock, bytes and all');
  rmSync(guessable);
  rmSync(lock);

  // Mutations go through the lock: a stale one left in place is cleared by them.
  writeFileSync(lock, String(dead));
  f.enqueue([task('cr-1')]);
  assert.equal(existsSync(lock), false);
  writeFileSync(lock, String(dead));
  f.setTaskStatus('cr-1', 'spawned');
  assert.equal(existsSync(lock), false);
});

test('the checkpoint lock releases the lock it published, not whatever holds that name', async (t) => {
  const { f, p } = await fresh(t, 'release-identity');
  const lock = p('state', 'fleet.lock');

  // This lock did NOT have this check until the extraction: release was an unconditional
  // `unlink` by name, so a holder whose lock had already been taken over deleted the
  // *successor's* lock on the way out and the successor went on believing it held a mutex
  // nobody had — worse than the takeover it follows, because the successor never learns, where
  // a losing takeover at least leaves someone to time out and say so. Measured against the
  // pre-extraction module: 40 of 40 exits deleted the successor; 0 of 40 after.
  //
  // The steal is done from inside `fn` because that is the only place it can be done
  // deterministically, and it is exactly the interleaving a crashed-holder misdiagnosis makes.
  const successor = `${spawnSync(process.execPath, ['-e', '']).pid}\n`;
  assert.notEqual(successor, `${process.pid}\n`);
  f.withFleetLock(() => {
    assert.equal(readFileSync(lock, 'utf8').trim(), String(process.pid), 'the lock names us while we hold it');
    rmSync(lock);                       // a waiter decides we are dead and takes it over...
    writeFileSync(lock, successor);      // ...and publishes its own
  });
  assert.equal(existsSync(lock), true, "the successor's lock must survive our release");
  assert.equal(readFileSync(lock, 'utf8'), successor, 'and it must still be the successor that owns it');
  rmSync(lock);

  // A successor carrying our own pid — a recycled pid re-taking its own lock — is a successor
  // too. On ext4 it lands on our inode NUMBER, which the filesystem hands straight back, so there
  // only the bytes can tell them apart: the successor's carry no nonce of ours. While a lock's
  // bytes were the pid alone, this failed on every run on an ext4 Linux VM.
  f.withFleetLock(() => { rmSync(lock); writeFileSync(lock, `${process.pid}\n`); });
  assert.equal(existsSync(lock), true, 'a successor carrying our own pid is still not our lock');
  rmSync(lock);

  // A successor carrying our EXACT bytes, nonce and all, on another inode: a copy, which isolates
  // the inode half of the identity. Our inode is pinned under a second name before the swap, so
  // the filesystem cannot hand its number to the copy (ext4 would) and the two are different
  // files on every filesystem.
  const pinned = `${lock}.pinned`;
  let ours = null, copy = null;
  f.withFleetLock(() => {
    const bytes = readFileSync(lock, 'utf8');
    linkSync(lock, pinned);
    ours = statSync(lock).ino;
    rmSync(lock);
    writeFileSync(lock, bytes);
    copy = statSync(lock).ino;
  });
  assert.notEqual(copy, ours, 'sanity: the copy really is a different file');
  assert.equal(existsSync(lock), true, 'a successor carrying our exact bytes is still not our lock');
  rmSync(lock);
  rmSync(pinned);

  // Which must not turn into a lock nothing ever clears: over-caution here is its own outage.
  f.withFleetLock(() => 'ok');
  assert.equal(existsSync(lock), false, 'an ordinary release still drops our own lock');
  f.withFleetLock(() => { writeFileSync(lock, 'garbage\n'); });
  assert.equal(existsSync(lock), false, 'a corrupt lock is not left for the next tick to wait on');
  assert.throws(() => f.withFleetLock(() => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(lock), false, 'and a throwing fn still releases');

  // A re-entrant inner return must not release the outer's lock either — the outer is still in
  // its critical section, and `lease.mjs` composes exactly this shape.
  f.withFleetLock(() => {
    f.withFleetLock(() => 'inner');
    assert.equal(existsSync(lock), true, 'a nested return must not release the lock the outer still holds');
  });
  assert.equal(existsSync(lock), false);
  assert.deepEqual(readdirSync(p('state')).filter((n) => n.endsWith('.tmp')), []);
});

test('a link that landed somewhere other than fleet.lock is not a lock we won', async (t) => {
  const { home, p } = await fresh(t, 'link-landed-inode');
  const url = new URL('../bin/lib/fleet.mjs', import.meta.url).href;

  // The other hardening this lock gained. `linkLanded`'s shortcut returns from the acquire
  // *before* the live-holder check runs, and it used to ask only "did our scratch gain a second
  // name". On the network filesystem the shortcut exists for, a `link(2)` that reports EEXIST
  // may have landed — but nlink === 2 does not say the name it landed under is the LOCK. Here
  // it lands elsewhere, so a count-only proof claims a lock that was never published at all.
  const r = await new Promise((resolve) => {
    const cp = spawn(process.execPath, ['--input-type=module', '-e', `
      import { createRequire } from 'node:module';
      const fs = createRequire(import.meta.url)('fs');
      const real = fs.linkSync;
      fs.linkSync = (from) => {
        real(from, String(from) + '.elsewhere');      // the link DID land, under another name
        throw Object.assign(new Error('EEXIST: stubbed, link'), { code: 'EEXIST' });
      };
      const { withFleetLock } = await import(${JSON.stringify(url)});
      let entered = false;
      try { withFleetLock(() => { entered = true; }, { timeoutMs: 100 }); } catch (e) {
        process.stdout.write(JSON.stringify({ entered, message: e.message })); process.exit(0);
      }
      process.stdout.write(JSON.stringify({ entered }));
    `], { env: { ...process.env, SOMA_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    cp.stdout.on('data', (d) => { out += d; });
    cp.stderr.on('data', (d) => { err += d; });
    cp.on('exit', () => { try { resolve(JSON.parse(out)); } catch { resolve({ message: err.trim() }); } });
  });

  assert.equal(r.entered, false, 'a second name on our scratch is not proof the LOCK is ours');
  assert.match(r.message ?? '', /keeps being re-taken by another acquirer/, `and the refusal reports the race it lost: ${r.message}`);
  assert.equal(existsSync(p('state', 'fleet.lock')), false, 'no lock was ever published');
});

test('a filesystem without hard links says so, instead of reporting a socket error', async (t) => {
  const { home, p } = await fresh(t, 'no-hard-links');
  const url = new URL('../bin/lib/fleet.mjs', import.meta.url).href;

  // `link(2)` IS the lock, so a volume that does not do hard links cannot host $SOMA_HOME
  // at all — and it used to say so in libuv's words rather than soma's: `ENOTSUP: operation
  // not supported on socket, link '…'`, verified on a real MS-DOS/FAT image. That errno is
  // not EEXIST, so it escapes the acquire loop untouched, and an operator who pointed
  // $SOMA_HOME at an exFAT drive or a cloud-sync mount got a socket error about a file.
  // This is the tree's only hard-link dependency, so nothing else in soma would tell them.
  //
  // Stubbed rather than mounted: a real FAT volume needs hdiutil and a mount, while this
  // patch lands before the first ESM import of node:fs and is therefore visible to
  // fleet.mjs's own `import { linkSync }` — so the code under test is the shipped code.
  const acquireWith = (code) => new Promise((resolve, reject) => {
    const src = `
      import { createRequire } from 'node:module';
      createRequire(import.meta.url)('fs').linkSync = () => {
        throw Object.assign(new Error(${JSON.stringify(`${code}: stubbed link failure, link`)}), { code: ${JSON.stringify(code)} });
      };
      const { withFleetLock } = await import(${JSON.stringify(url)});
      try {
        withFleetLock(() => 0, { timeoutMs: 50 });
        process.stdout.write(JSON.stringify({ entered: true }));
      } catch (e) {
        process.stdout.write(JSON.stringify({ message: e.message, causeCode: e.cause?.code ?? null }));
      }
    `;
    const cp = spawn(process.execPath, ['--input-type=module', '-e', src], {
      env: { ...process.env, SOMA_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    cp.stdout.on('data', (d) => { out += d; });
    cp.stderr.on('data', (d) => { err += d; });
    cp.on('error', reject);
    cp.on('exit', () => resolve(out ? JSON.parse(out) : { message: `(nothing on stdout; stderr: ${err.trim()})`, causeCode: null }));
  });

  // All three, because some filesystems report an unsupported link as EPERM rather than
  // ENOTSUP. Each has to carry the cause, the errno, the absolute path (it moves with
  // $SOMA_HOME) and the remedy — an assertion per part, so a message that keeps one and
  // drops the rest cannot pass.
  for (const code of ['ENOTSUP', 'EOPNOTSUPP', 'EPERM']) {
    const r = await acquireWith(code);
    assert.equal(r.entered, undefined, `${code} must not be treated as a successful acquire`);
    assert.match(r.message, /must be on a filesystem that supports hard links/, `${code} must name the cause`);
    assert.match(r.message, new RegExp(`link\\(2\\) returned ${code}`), `${code} must be named: ${r.message}`);
    assert.ok(r.message.includes(p('state', 'fleet.lock')), `${code} must name the absolute lock path: ${r.message}`);
    assert.match(r.message, /move SOMA_HOME off this volume/, `${code} must say what to do about it`);
    assert.equal(r.causeCode, code, 'and keep the original error as its cause');
  }

  // And not one errno more. A cross-device link is a different fault with a different fix,
  // and burying it under "this volume has no hard links" would send someone reformatting a
  // disk over a misplaced state root. (EPERM is in the set above, which is why the catch
  // wraps only the `linkSync` call — `takeOver`'s unlink returns EPERM for a lock that is
  // really a directory, and that must keep its own report.)
  const unrelated = await acquireWith('EXDEV');
  assert.match(unrelated.message, /EXDEV: stubbed link failure/, 'an unrelated link failure must surface as itself');
  assert.doesNotMatch(unrelated.message, /supports hard links/);

  // No `wx` fallback, deliberately — degrading to O_CREAT|O_EXCL here would reopen the
  // empty-file steal window silently, on exactly the machines nobody is watching. So the
  // acquire fails, and having failed it leaves nothing behind.
  assert.deepEqual(readdirSync(p('state')).filter((n) => n.endsWith('.tmp')), [], 'a refused acquire leaves no scratch file');
  assert.equal(existsSync(p('state', 'fleet.lock')), false, 'and no lock');
});

test('refusing an async fn does not leave a rejection to take the process down', async (t) => {
  const { f, p } = await fresh(t, 'async-reject');
  const lock = p('state', 'fleet.lock');
  f.enqueue([task('cr-1')]);

  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  // Refusing the fn is right; abandoning the promise it already returned is not.
  // Node's default is --unhandled-rejections=throw, so an unadopted rejection kills
  // the process at the next microtask checkpoint — *after* the caller has caught and
  // handled the TypeError. One async mutate would take down the watchdog or the bus
  // rather than costing a tick.
  const rejecting = async () => { throw new Error('inner-boom'); };
  assert.throws(() => f.withFleetLock(rejecting), TypeError);
  assert.throws(() => f.withFleetLock(() => f.withFleetLock(rejecting)), TypeError);
  assert.throws(() => f.updateFleet(async (fleet) => { fleet.tick = 1; throw new Error('inner-boom'); }), TypeError);

  // A rejection surfaces once the microtask queue drains, so let a turn pass first.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled.map(String), [], 'the refused promise must be adopted, not abandoned');

  assert.equal(existsSync(lock), false, 'the lock is released anyway');
  assert.equal(f.readFleet().tick, undefined, 'and the half-mutation was not published');
  assert.deepEqual(f.readFleet().tasks.map((x) => x.id), ['cr-1']);
});

test('nested mutations share one snapshot: the outer publish cannot drop the inner write', async (t) => {
  const { f } = await fresh(t, 'nested');
  f.enqueue([task('cr-1'), task('cr-2')]);

  // The composition the lock invites and the naive implementation breaks: an inner
  // updateFleet reading its own second snapshot publishes F2, then the outer
  // publishes its stale F1 straight over the top — the lost update the lock exists
  // to prevent, now wearing the lock's clothes.
  const result = f.updateFleet((fleet) => {
    f.setTaskStatus('cr-1', 'spawned');
    assert.equal(fleet.tasks.find((x) => x.id === 'cr-1').status, 'spawned', 'the nest sees its own writes');
    fleet.tick = 1;
    return 'both';
  });
  assert.equal(result, 'both');

  const after = f.readFleet();
  assert.equal(after.tasks.find((x) => x.id === 'cr-1').status, 'spawned', 'the inner write survived the outer publish');
  assert.equal(after.tick, 1, 'and so did the outer one');
  assert.ok(Number.isInteger(after.last_spawn_at), 'including the fields the inner call stamps');

  // Same for enqueue, and the ordering of the two publishes does not matter because
  // there is only one.
  f.updateFleet((fleet) => {
    fleet.tick = 2;
    f.enqueue([task('cr-3')]);
  });
  const after2 = f.readFleet();
  assert.deepEqual(after2.tasks.map((x) => x.id), ['cr-1', 'cr-2', 'cr-3']);
  assert.equal(after2.tick, 2);

  // One transaction, so an outer throw publishes neither half.
  assert.throws(() => f.updateFleet((fleet) => {
    f.setTaskStatus('cr-2', 'spawned');
    fleet.tick = 3;
    throw new Error('boom');
  }), /boom/);
  const after3 = f.readFleet();
  assert.equal(after3.tasks.find((x) => x.id === 'cr-2').status, 'queued', 'the inner write rolled back with the outer');
  assert.equal(after3.tick, 2);

  // ...and the aborted transaction leaves nothing behind for the next one.
  f.setTaskStatus('cr-2', 'blocked');
  assert.equal(f.readFleet().tasks.find((x) => x.id === 'cr-2').status, 'blocked');
});

test('concurrent processes enqueueing the same fleet lose no updates', async (t) => {
  const { home, f } = await fresh(t, 'contention');
  const url = new URL('../bin/lib/fleet.mjs', import.meta.url).href;
  const PER_WRITER = 25;

  // Two real processes, because that is the shape the lock exists for: the bus and
  // the watchdog each read-modify-write fleet.json. Unlocked, the interleaved
  // read/write cycles clobber each other and the fleet comes up short.
  const writer = (n) => new Promise((resolve, reject) => {
    const src = `
      import { enqueue } from ${JSON.stringify(url)};
      for (let i = 0; i < ${PER_WRITER}; i++) {
        enqueue([{ id: \`w${n}-\${i}\`, title: 't', repo: 'r', source: {}, brief: 'b' }]);
      }
    `;
    const cp = spawn(process.execPath, ['--input-type=module', '-e', src], {
      env: { ...process.env, SOMA_HOME: home },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    cp.stderr.on('data', (d) => { err += d; });
    cp.on('error', reject);
    cp.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${n} exited ${code}: ${err}`))));
  });

  await Promise.all([writer(1), writer(2)]);

  const ids = f.readFleet().tasks.map((x) => x.id);
  const expected = [1, 2].flatMap((n) => Array.from({ length: PER_WRITER }, (_, i) => `w${n}-${i}`));
  assert.equal(ids.length, expected.length, `lost ${expected.length - ids.length} updates to a race`);
  assert.deepEqual([...ids].sort(), expected.sort());
  assert.equal(existsSync(join(home, 'state', 'fleet.lock')), false, 'both writers released');
});

test('the lock is never observable without an owner in it, and a counter under it loses no ticks', async (t) => {
  const { home, p } = await fresh(t, 'lock-atomicity');
  const url = new URL('../bin/lib/fleet.mjs', import.meta.url).href;
  const lock = p('state', 'fleet.lock');
  const counter = join(home, 'counter');
  const CHILDREN = 6;
  const PER_CHILD = 25;
  writeFileSync(counter, '0');

  // The narrowest thing a lock has to do: N processes each read-modify-write one number
  // PER_CHILD times, and the total is CHILDREN * PER_CHILD or the lock let two of them
  // in at once. A double entry does not corrupt the file — it loses a tick, because both
  // holders read the same value and both write it back plus one.
  const child = (n) => new Promise((resolve, reject) => {
    const src = `
      import { readFileSync, writeFileSync } from 'node:fs';
      import { withFleetLock } from ${JSON.stringify(url)};
      const fp = ${JSON.stringify(counter)};
      for (let i = 0; i < ${PER_CHILD}; i++) {
        // A generous timeout, not the 5 s default: this runs alongside the rest of the
        // suite, and a loaded machine queueing six racers must fail the assertion below
        // for a real reason or not at all.
        withFleetLock(() => writeFileSync(fp, String(Number(readFileSync(fp, 'utf8')) + 1)), { timeoutMs: 30000 });
      }
    `;
    const cp = spawn(process.execPath, ['--input-type=module', '-e', src], {
      env: { ...process.env, SOMA_HOME: home },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    cp.stderr.on('data', (d) => { err += d; });
    cp.on('error', reject);
    cp.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child ${n} exited ${code}: ${err}`))));
  });

  // While they race, watch the lock the way a waiter does. This is the regression that
  // matters, because it is the mechanism rather than its symptom: an `O_EXCL` create
  // publishes the *name* on the open and the *pid* on the write, and this loop caught
  // the file existing and EMPTY on ~22% of the reads that found it there at all. An
  // empty lock is precisely what the stale-owner check reads as "the holder is dead" —
  // so a waiter unlinked a live lock and walked in beside it. Linked into place from a
  // fully written scratch file, there is no such intermediate state to observe.
  let present = 0;
  let ownerless = 0;
  let racing = true;
  const children = Promise.all(Array.from({ length: CHILDREN }, (_, i) => child(i + 1)));
  children.then(() => { racing = false; }, () => { racing = false; });
  while (racing) {
    for (let i = 0; i < 100; i++) {
      let raw;
      try {
        raw = readFileSync(lock, 'utf8');
      } catch {
        continue; // unheld right now, which is the other legal state
      }
      present++;
      if (raw.trim() === '') ownerless++;
    }
    await new Promise((resolve) => setImmediate(resolve)); // let the exit events land
  }
  await children;

  assert.ok(present >= 10, `the probe never caught the lock held (${present} hits), so it proves nothing`);
  assert.equal(ownerless, 0, `the lock existed with no owner in it on ${ownerless}/${present} reads — every one is a window for a waiter to steal it from a live holder`);
  // Deliberately not this bug's evidence — the assertion above is. Measured against the
  // pre-fix module, this line holds at exactly 150 on 5/5 runs at 6x25 and 5/5 at 8x50; at
  // 12x60 it loses a tick on 2/5 runs for 3.3x the runtime, and an assertion that catches a
  // known-broken lock two times in five is a coin flip, not a regression test. Stealing a
  // live holder's lock through the empty window needs a waiter to sample it inside a window
  // microseconds wide *and* win the create that follows, so the loss rate sits far below the
  // ownerless-read rate the probe measures deterministically. What this line guards is the
  // other route to two holders: one that hands the lock out twice with no empty window to
  // observe — a takeover that unlinks a live holder's lock, a re-entrancy flag that outlives
  // the process it belonged to. That loses ticks without the lock ever looking ownerless,
  // and nothing else in this file would notice.
  assert.equal(Number(readFileSync(counter, 'utf8')), CHILDREN * PER_CHILD, 'a missing tick is two processes inside the lock at once');
  assert.equal(existsSync(lock), false, 'every child released');
  assert.deepEqual(
    readdirSync(p('state')).filter((n) => n.endsWith('.tmp')),
    [],
    'and the scratch file the lock is linked from is cleaned up with it',
  );
});

test('rotationsWithin keeps finite stamps newer than now − window, drops the rest, keeps a fast clock', async (t) => {
  const { f } = await fresh(t, 'within');
  // A sample reset as the clock (2015-08-24T16:30Z, in ms): any fixed instant would do, and
  // this one is the limit fixture's, so a units slip to seconds would be off by 1000 here too.
  const now = 1_440_433_800_000;
  const W = f.ROTATION_WINDOW_MS;
  assert.equal(W, 3_600_000);
  assert.deepEqual(
    f.rotationsWithin([now - W, now - W + 1, now, now + 5000, 'x', Infinity, Number.NaN], now),
    [now - W + 1, now, now + 5000],
  );
});

test('writeFleet prunes a row\'s rotations to the window, so the list cannot grow without bound', async (t) => {
  const { f } = await fresh(t, 'prune');
  f.enqueue([task('cr-1')]);
  const now = Date.now();
  const stale = now - f.ROTATION_WINDOW_MS - 1;
  const recent = now - 30 * 60 * 1000;
  f.updateFleet((fleet) => { fleet.tasks[0].rotations = [stale, recent, now, Number.NaN]; });
  assert.deepEqual(f.readFleet().tasks[0].rotations, [recent, now]);
});

test('the prune never invents a rotations key on a row that has none (a pre-seats checkpoint keeps its shape)', async (t) => {
  const { f, p } = await fresh(t, 'prune-absent');
  writeFileSync(p('state', 'fleet.json'), JSON.stringify({ tasks: [{ id: 'cr-0', status: 'done' }], last_spawn_at: null }));
  f.updateFleet(() => true);
  assert.equal('rotations' in f.readFleet().tasks[0], false);
});

test('writeFleet prunes against the clock it is GIVEN, not the wall clock — the published `now` is a real parameter', async (t) => {
  const { f } = await fresh(t, 'write-now');
  f.enqueue([task('cr-1')]);
  // Two stamps about a day old: stale against `Date.now()`, both inside the window against a
  // `now` that sits at the newer of them. Only a threaded clock can keep them, so this is what
  // says the second parameter is wired through to `rotationsWithin` rather than merely declared
  // — `updateFleet`, its only caller today, passes nothing, and a later tidy could have deleted
  // the parameter with the whole suite green (MEASURED: it did, 22 pass / 0 fail).
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const fleet = f.readFleet();
  fleet.tasks[0].rotations = [dayAgo - 30 * 60 * 1000, dayAgo];
  f.writeFleet(fleet, dayAgo);
  assert.deepEqual(f.readFleet().tasks[0].rotations, [dayAgo - 30 * 60 * 1000, dayAgo]);
});

// --------------------------------------------------------------------------- the launch mark

test('a queued row starts with launching_at: null — no launch in flight, written rather than absent', async (t) => {
  const { f } = await fresh(t, 'launching-null');
  f.enqueue([task('cr-1')]);
  assert.equal(f.readFleet().tasks[0].launching_at, null);
});

test('launching: a spawned row with a mark is starting until the mark is LAUNCH_GRACE_MS old, and from then on it is not', async (t) => {
  const { f } = await fresh(t, 'launching-bound');
  const now = 1_440_433_800_000;
  const G = f.LAUNCH_GRACE_MS;
  const marked = (age) => ({ id: 'cr-1', status: 'spawned', launching_at: now - age });
  assert.equal(f.launching(marked(0), now), true, 'claimed this instant');
  assert.equal(f.launching(marked(30_000), now), true, 'thirty seconds into a fetch');
  assert.equal(f.launching(marked(G - 1), now), true, 'the last millisecond inside the bound');
  // Past the bound a row with no session is treated as dead again, as every row was before the
  // mark. Reading it as starting for ever is how a lost mark would hold a slot no reconcile can free.
  assert.equal(f.launching(marked(G), now), false, 'the bound itself is out');
  assert.equal(f.launching(marked(G + 1), now), false);
  assert.equal(f.launching(marked(24 * 3600 * 1000), now), false, 'a day-old mark that a lost record left behind');
});

test('launching: no mark, a mark that is not a number, a row that is not spawned, or no clock is never starting', async (t) => {
  const { f } = await fresh(t, 'launching-never');
  const now = 1_440_433_800_000;
  const recent = now - 1000;
  for (const mark of [null, undefined, Number.NaN, Infinity, String(recent), {}]) {
    assert.equal(f.launching({ id: 'cr-1', status: 'spawned', launching_at: mark }, now), false, `mark ${String(mark)}`);
  }
  assert.equal(f.launching({ id: 'cr-1', status: 'spawned' }, now), false, 'a row from before the mark existed');
  // The resume paths and blocked -> spawned move a row into `spawned` with a session already up, and
  // a finished row has nothing to start: only a claimed `spawned` row is ever starting.
  for (const status of ['queued', 'done', 'failed', 'blocked', 'skipped']) {
    assert.equal(f.launching({ id: 'cr-1', status, launching_at: recent }, now), false, status);
  }
  // No clock, no grace: `reconcile` called without one keeps its old contract.
  for (const clock of [undefined, null, Number.NaN, String(now)]) {
    assert.equal(f.launching({ id: 'cr-1', status: 'spawned', launching_at: recent }, clock), false, `now ${String(clock)}`);
  }
  for (const hole of [null, undefined, 'cr-1']) assert.equal(f.launching(hole, now), false, `row ${String(hole)}`);
});

test('launching: a mark from the future counts only within the bound, so a backward clock step cannot hold a slot', async (t) => {
  const { f } = await fresh(t, 'launching-future');
  const now = 1_440_433_800_000;
  const G = f.LAUNCH_GRACE_MS;
  const marked = (at) => ({ id: 'cr-1', status: 'spawned', launching_at: at });
  // A clock stepped back a little after the claim: the mark reads as a few seconds ahead, and the
  // lead it marks is still starting.
  assert.equal(f.launching(marked(now + 5000), now), true, 'a small backward step is still starting');
  assert.equal(f.launching(marked(now + G - 1), now), true);
  // Ahead by the bound or more, it is not believed: read as "starting" it would keep the row out of
  // reconcile's reach until the clock caught up, and a garbage stamp would never be caught up with.
  assert.equal(f.launching(marked(now + G), now), false, 'a step as large as the bound falls back to the unmarked reading');
  assert.equal(f.launching(marked(9e15), now), false, 'a stamp from the far future is ignored');
  assert.equal(f.launching(marked(now * 1000), now), false, 'a stamp in microseconds is ignored');
});

test('LAUNCH_GRACE_MS covers the repo-lock wait, one whole fetch, and a minute', async (t) => {
  const { f } = await fresh(t, 'launching-grace');
  // A literal in fleet.mjs, so the relation is pinned here: any shorter, and a spawn that waited out
  // the repo lock and then one whole fetch would read as a dead lead while its spawner still runs.
  // It is not the longest launch possible: every git call gets its own GIT_TIMEOUT_MS.
  const { GIT_TIMEOUT_MS, LOCK_TIMEOUT_MS } = await import('../bin/lib/worktree.mjs');
  assert.ok(Number.isInteger(GIT_TIMEOUT_MS) && GIT_TIMEOUT_MS > 0, `the fetch allowance, got ${GIT_TIMEOUT_MS}`);
  assert.ok(Number.isInteger(LOCK_TIMEOUT_MS) && LOCK_TIMEOUT_MS > 0, `the repo-lock wait, got ${LOCK_TIMEOUT_MS}`);
  assert.ok(f.LAUNCH_GRACE_MS >= LOCK_TIMEOUT_MS + GIT_TIMEOUT_MS + 60_000,
    `LAUNCH_GRACE_MS (${f.LAUNCH_GRACE_MS}) must cover the ${LOCK_TIMEOUT_MS} ms repo-lock wait, the ${GIT_TIMEOUT_MS} ms fetch and a minute for the local steps`);
});
