import './soma-home.mjs';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const tmuxInstalled = spawnSync('tmux', ['-V']).status === 0;
const TEST_SOCKET = `soma-t12-${process.pid}`;
const savedSocket = process.env.SOMA_TMUX_SOCKET;
const savedHome = process.env.SOMA_HOME;

// Set BEFORE the first import of `lib/tmux.mjs`, which captures the socket name at
// load time. This is the only point at which the bus's own `hasPane` — whose default
// `run` is `tmux.defaultRun` — can be aimed at a throwaway server instead of the
// operator's live fleet, and `hasPane` is the one predicate that has to be measured
// against real tmux processes: no stub reproduces "exit 0 with empty stdout".
process.env.SOMA_TMUX_SOCKET = TEST_SOCKET;

const BUS_URL = new URL('../bin/soma-bus.mjs', import.meta.url);
const bus = await import(BUS_URL.href);
const tmux = await import('../bin/lib/tmux.mjs');
const lease = await import('../bin/lib/lease.mjs');
const events = await import('../bin/lib/events.mjs');
const fleet = await import('../bin/lib/fleet.mjs');
// Deliberately NOT cache-busted, unlike most imports in this file: the identity assertions
// below compare function references against the instance `soma-bus.mjs` and
// `soma-watchdog.mjs` themselves resolved, and a `?t=` query mints a second module whose
// exports are different objects — which would fail for a reason that has nothing to do with
// the wiring under test.
const queue = await import('../bin/lib/queue.mjs');
const { queuePausedPath } = queue;

const BUS_SRC = readFileSync(BUS_URL, 'utf8');
const BUS_TOOLS_SRC = readFileSync(new URL('../bin/lib/bus-tools.mjs', import.meta.url), 'utf8');
const SPAWN_EXISTS = existsSync(new URL('../bin/lib/spawn.mjs', import.meta.url));

const SUBDIRS = ['state', 'events', 'heartbeats', 'leads', 'logs', 'worktrees', 'digests'];
const trash = [];
const sessions = new Set();

/** A throwaway `$SOMA_HOME`, laid out and made current. Never the repo tree. */
const freshHome = () => {
  const home = mkdtempSync(join(tmpdir(), 'soma-t12-home-'));
  for (const d of SUBDIRS) mkdirSync(join(home, d), { recursive: true });
  trash.push(home);
  process.env.SOMA_HOME = home;
  return home;
};

/** A real detached tmux session on the throwaway socket; returns its pane id. */
const livePane = (name) => {
  const created = tmux.defaultRun(['new-session', '-d', '-s', name, 'sleep', '600']);
  if (created.code !== 0) return null;   // pty-exhausted host: the caller skips
  sessions.add(name);
  const row = tmux.defaultRun(['list-panes', '-a', '-F', '#{session_name}\t#{pane_id}']).stdout
    .split('\n').find((l) => l.startsWith(`${name}\t`));
  return row ? row.split('\t')[1] : null;
};

after(() => {
  if (tmuxInstalled) {
    const socketPath = tmux.defaultRun(['display-message', '-p', '#{socket_path}']).stdout.trim();
    tmux.defaultRun(['kill-server']);
    // Neither the last session dying nor kill-server unlinks the socket file.
    if (socketPath.includes(TEST_SOCKET)) rmSync(socketPath, { force: true });
  }
  for (const d of trash) rmSync(d, { recursive: true, force: true });
  if (savedSocket === undefined) delete process.env.SOMA_TMUX_SOCKET; else process.env.SOMA_TMUX_SOCKET = savedSocket;
  if (savedHome === undefined) delete process.env.SOMA_HOME; else process.env.SOMA_HOME = savedHome;
});

const ORCH_TOOLS = [
  'soma_adopt', 'soma_release', 'soma_enqueue', 'soma_queue', 'soma_spawn', 'soma_status',
  'soma_inbox', 'soma_send', 'soma_kill', 'soma_resume', 'soma_transcript', 'soma_digest',
];

/** `orchTools` behind the real wiring, for the environment given. */
const orch = (env = {}) => bus.buildTools({ SOMA_ROLE: 'orchestrator', CLAUDE_CODE_SESSION_ID: 'sess-A', ...env }).tools;

/** The whole entrypoint, driven over a stream pair instead of stdio. */
const wire = (opts = {}) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  let buf = '';
  output.on('data', (chunk) => {
    buf += String(chunk);
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) lines.push(JSON.parse(line));
    }
  });
  const started = bus.main({ ...opts, io: { input, output } });
  return {
    ...started,
    lines,
    send: (msg) => input.write(`${JSON.stringify(msg)}\n`),
    byId: (id) => lines.find((m) => m.id === id),
    result: (id) => JSON.parse(lines.find((m) => m.id === id).result.content[0].text),
    notifications: () => lines.filter((m) => typeof m.method === 'string'),
  };
};

/**
 * `assert.ok(false, …)` rather than `assert.fail(…)`, deliberately: a timeout here is
 * how a missing notification or a snapshotted tool Map shows up, and `assert.fail`
 * throws out of the test — which a per-assertion audit cannot attribute to a line and
 * which stops every later assertion in the test from running at all. As an `ok` it is
 * an ordinary assertion: soft-able, attributable, and it lets the assertions after it
 * report their own verdicts.
 */
const until = async (fn, what, ms = 5000) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(false, `timed out waiting for ${what}`);
};

/** A promise's rejection as a value, so a throw is an assertable fact and not a red sibling. */
const settled = (promise) => promise.then((value) => value, (e) => ({ threw: `${e?.code ?? e?.name}: ${e?.message}` }));

// ---------------------------------------------------------------------------
// 1. The role gate
// ---------------------------------------------------------------------------

test('buildTools returns lead set for role=lead, candidate set for role=candidate', async () => {
  const mod = await import('../bin/soma-bus.mjs?' + Date.now());
  const leadNames = [...mod.buildTools({ SOMA_ROLE: 'lead', SOMA_LEAD_NAME: 'cr-1' }).tools.keys()];
  assert.ok(leadNames.includes('soma_report') && !leadNames.includes('soma_spawn'));
  const candNames = [...mod.buildTools({ SOMA_ROLE: 'candidate' }).tools.keys()];
  assert.deepEqual(candNames.sort(), ['soma_adopt', 'soma_status']);
});

test('the orchestrator gets twelve tools, the lead three, and anything unrecognised is a candidate', () => {
  freshHome();
  assert.deepEqual([...bus.buildTools({ SOMA_ROLE: 'orchestrator' }).tools.keys()].sort(), [...ORCH_TOOLS].sort());
  assert.deepEqual([...bus.buildTools({ SOMA_ROLE: 'lead', SOMA_LEAD_NAME: 'cr-1' }).tools.keys()].sort(),
    ['soma_checkpoint', 'soma_report', 'soma_task']);

  // The promotion path depends on "candidate" being the *default*, so every way of
  // not saying "lead" or "orchestrator" has to land there — including a typo, which
  // must not strand a session with two tools and no way out of them.
  for (const role of [undefined, '', 'candidate', 'orch', 'Orchestrator', 'ORCHESTRATOR', 'leader', 'watchdog']) {
    assert.deepEqual([...bus.buildTools({ SOMA_ROLE: role }).tools.keys()].sort(), ['soma_adopt', 'soma_status'],
      `SOMA_ROLE=${JSON.stringify(role)} must be a candidate`);
  }
});

test('the role is read from the env passed in, never from this process', () => {
  freshHome();
  const saved = process.env.SOMA_ROLE;
  process.env.SOMA_ROLE = 'orchestrator';
  try {
    // A bus that consulted process.env would hand this call the control plane.
    assert.deepEqual([...bus.buildTools({}).tools.keys()].sort(), ['soma_adopt', 'soma_status']);
    assert.deepEqual([...bus.buildTools({ SOMA_ROLE: 'lead', SOMA_LEAD_NAME: 'cr-1' }).tools.keys()].sort(),
      ['soma_checkpoint', 'soma_report', 'soma_task']);
  } finally {
    if (saved === undefined) delete process.env.SOMA_ROLE; else process.env.SOMA_ROLE = saved;
  }
});

// ---------------------------------------------------------------------------
// 2. The dep contract — the first realDeps sketch wired 19 of the names bus-tools reads
// ---------------------------------------------------------------------------

/**
 * Every dep name `bus-tools.mjs` reaches for, read out of its source rather than
 * out of a list here. That direction is the whole point: an unwired dep is a
 * handler that quietly refuses (or, for `hasPane`/`leaseStale`, one that quietly
 * lies), so a list maintained by hand beside the wiring cannot fail when the
 * wiring is what is wrong.
 */
const consumedDeps = () => {
  const names = new Set();
  for (const m of BUS_TOOLS_SRC.matchAll(/\bdeps\??\.([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of BUS_TOOLS_SRC.matchAll(/\bhas\('([^']+)'\)/g)) names.add(m[1]);
  return names;
};

test('realDeps wires every dep bus-tools reaches for, and the only absences are the deferred ones', () => {
  freshHome();
  const deps = bus.realDeps();
  const consumed = [...consumedDeps()].sort();
  assert.ok(consumed.length >= 34, `expected the full dep surface, found ${consumed.length}: ${consumed}`);

  const unwired = consumed.filter((name) => typeof deps[name] !== 'function').sort();
  // `buildDigest` is the declared v1.x gap (spec §16's cut line). The two spawn deps
  // are the spawner's and are wired the moment `lib/spawn.mjs` exists — so this list
  // shrinks on its own and never needs editing here.
  const expected = ['buildDigest', ...(SPAWN_EXISTS ? [] : ['resumeLead', 'spawnLead'])].sort();
  assert.deepEqual(unwired, expected,
    `unwired deps must be exactly the deferred ones; got ${JSON.stringify(unwired)}`);

  // Every one of the fourteen that sketch omitted, named individually, because
  // this is the correction the whole dep contract turns on.
  for (const name of ['heartbeat', 'leaseStale', 'hasPane', 'updateFleet', 'admit', 'loadConfig',
    'readUsage', 'heartbeatAgeMs', 'queuePaused', 'setQueuePaused', 'backpressureState',
    'validateHarnessReport', 'stampWake', 'launching']) {
    assert.equal(typeof deps[name], 'function', `${name} is consumed by a shipped handler and must be wired`);
  }
});

test('realDeps wires fleet.launching itself: soma_status reads a starting lead by the predicate reconcile and soma status read', () => {
  freshHome();
  // `bus-tools` imports nothing, so the predicate arrives as a dep. A transcription here would be a
  // second bound: `soma_status` saying `starting` for a row the watchdog's reconcile already reads as
  // dead and revives, or the reverse. The identity is asserted against the owner, not the behaviour.
  assert.equal(bus.realDeps().launching, fleet.launching, 'the bus must wire fleet.launching itself');
});

test('the deferred deps refuse in a sentence rather than crashing, and name no path', async () => {
  const home = freshHome();
  fleet.enqueue([{ id: 'cr-1', title: 't', repo: 'r', brief: 'b' }]);
  const tools = orch();
  const replies = {
    spawn: await tools.get('soma_spawn')({ task_id: 'cr-1' }),
    resume: await tools.get('soma_resume')({ lead: 'cr-1' }),
    digest: await tools.get('soma_digest')({}),
  };
  if (!SPAWN_EXISTS) {
    assert.match(replies.spawn.error, /no spawner is wired/);
    assert.match(replies.resume.error, /no spawner is wired/);
  }
  assert.match(replies.digest.error, /digest composer is not available in this build/);
  for (const [name, reply] of Object.entries(replies)) {
    assert.equal(reply.ok, false, `${name} must refuse rather than answer`);
    assert.doesNotMatch(JSON.stringify(reply), new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${name}'s refusal must not carry the state root`);
  }
});

// ---------------------------------------------------------------------------
// 3. hasPane — the probe whose failure is invisible in BOTH directions
// ---------------------------------------------------------------------------

test('the two spellings first suggested for hasPane are wrong on this tmux, in opposite directions', { skip: !tmuxInstalled && 'tmux not installed' }, (t_) => {
  assert.equal(tmux.tmuxArgs([])[1], TEST_SOCKET, 'this test must not run on the production socket');
  const pane = livePane(`t12-canary-${process.pid}`);
  if (!pane) return t_.skip('tmux could not start a session here');

  // This is the canary, not a restatement of the fix: it measures the platform, so
  // a future tmux that changes either behaviour reddens here and says which one.
  const version = tmux.defaultRun(['-V']).stdout.trim();

  // Trap A — `has-session` is a SESSION probe. Given a pane id it exits nonzero for
  // a pane that is right there, so `hasSession(lease.tmux_pane)` reads every live
  // tmux holder as gone: `leaseStale` then says stale, and the fleet is adoptable
  // with no force and no DEMOTED notice while its orchestrator is working.
  assert.equal(tmux.defaultRun(['has-session', '-t', `=${pane}`]).code, 1,
    `${version}: has-session must be measured nonzero for the live pane ${pane}`);
  assert.equal(tmux.hasSession(pane), false, 'so hasSession is not a pane predicate');

  // Trap B — `display-message` exits 0 for a pane that does not exist, printing
  // nothing. `.code === 0` therefore means "some tmux server answered": a DEAD
  // orchestrator pane reads as live, instant adoption never fires, and soma_adopt
  // reports holder_live:true about a session that is gone.
  const deadProbe = tmux.defaultRun(['display-message', '-p', '-t', '%99999', '#{pane_id}']);
  assert.equal(deadProbe.code, 0, `${version}: display-message must be measured exit 0 for a dead pane`);
  assert.equal(deadProbe.stdout.trim(), '', 'and it prints nothing, which is what carries the answer');

  // The live probe exits 0 too — so the exit code cannot distinguish the two cases
  // at all, which is exactly why the output is what the predicate reads.
  const liveProbe = tmux.defaultRun(['display-message', '-p', '-t', pane, '#{pane_id}']);
  assert.equal(liveProbe.code, deadProbe.code, 'the exit code is identical for a live and a dead pane');
  assert.equal(liveProbe.stdout.trim(), pane, 'the output is not');
});

test('hasPane answers for a live pane and for a pane that is gone, through the real default run', { skip: !tmuxInstalled && 'tmux not installed' }, (t_) => {
  const name = `t12-live-${process.pid}`;
  const pane = livePane(name);
  if (!pane) return t_.skip('tmux could not start a session here');

  assert.equal(bus.hasPane(pane), true, `the live pane ${pane} must read present`);
  assert.equal(bus.hasPane('%99999'), false, 'a pane id that was never allocated must read gone');

  // The case the fleet actually meets: an orchestrator whose pane existed and has
  // since died. Nothing about it is hypothetical — it is what instant adoption is for.
  tmux.killSession(name);
  sessions.delete(name);
  assert.equal(bus.hasPane(pane), false, `${pane} must read gone once its session is killed`);
});

test('hasPane reads the output, never the exit code', () => {
  const calls = [];
  const record = (result) => (args) => { calls.push(args); return result; };

  // The trap, as a value: a tmux that exits 0 and prints nothing. Measured above
  // against the real binary; here it pins that the predicate cannot be satisfied
  // by an exit code alone, which no amount of real-tmux passing would prove.
  assert.equal(bus.hasPane('%7', record({ stdout: '', code: 0 })), false);
  assert.equal(bus.hasPane('%7', record({ stdout: '\n', code: 0 })), false);
  // ...and that a nonzero exit beside the right output is still present, so the
  // predicate is not quietly reading both.
  assert.equal(bus.hasPane('%7', record({ stdout: '%7\n', code: 1 })), true);
  assert.equal(bus.hasPane('%7', record({ stdout: ' %7 ', code: 0 })), true);

  // A session name resolves to that session's ACTIVE pane, whose id differs from the
  // target — so target fallback answers about the wrong pane and the ids catch it.
  assert.equal(bus.hasPane('lead-cr-1', record({ stdout: '%3', code: 0 })), false);
  // Neither near miss may pass, and they are not the same near miss: a prefix test
  // would let `%1` be satisfied by an answer about `%12`, which is the pane a fleet
  // of ten leads actually has beside it.
  assert.equal(bus.hasPane('%1', record({ stdout: '%12', code: 0 })), false);
  assert.equal(bus.hasPane('%12', record({ stdout: '%1', code: 0 })), false);

  assert.deepEqual(calls[0], ['display-message', '-p', '-t', '%7', '#{pane_id}']);
  // A missing pane costs no process at all — a `notify`-mode holder records null.
  const none = [];
  assert.equal(bus.hasPane(null, record({ stdout: 'x', code: 0 })), false);
  assert.equal(bus.hasPane('', (a) => { none.push(a); return { stdout: '', code: 0 }; }), false);
  assert.deepEqual(none, [], 'an empty pane must not be probed');
});

/**
 * Issue #2's proof, against recorded answers. The real-tmux half, two servers that both have a
 * `%0`, is in `test/wake-sockets.test.mjs`, inside a TMUX_TMPDIR sandbox.
 */
test('paneOnServer needs both halves of one answer: the pane it asked about, on the server $TMUX names', () => {
  const calls = [];
  const record = (result) => (args) => { calls.push(args); return result; };
  const TMUX = '/tmp/tmux-1000/soma,4242,0';

  assert.equal(bus.paneOnServer('%7', TMUX, record({ stdout: '%7 /tmp/tmux-1000/soma\n', code: 0 })), true);
  assert.deepEqual(calls[0], ['display-message', '-p', '-t', '%7', '#{pane_id} #{socket_path}'],
    'one round trip on the bus\'s own socket; a space, not a tab, because a client with no UTF-8 locale prints a tab as _');

  // The collision this exists for: the pane is there, on THIS server, but the session's $TMUX
  // names another one. A pane-existence probe says yes here, and that yes was the bug.
  assert.equal(bus.paneOnServer('%7', '/tmp/tmux-1000/default,999,0', record({ stdout: '%7 /tmp/tmux-1000/soma', code: 0 })), false);
  // The pane is missing: tmux exits 0 with an EMPTY pane id and still prints the socket path.
  assert.equal(bus.paneOnServer('%7', TMUX, record({ stdout: ' /tmp/tmux-1000/soma\n', code: 0 })), false);
  // No server: exit 1 and nothing on stdout (the "no server running on <path>" line is stderr).
  assert.equal(bus.paneOnServer('%7', TMUX, record({ stdout: '', code: 1 })), false);
  // Near misses on either half, and a locale-mangled answer, prove nothing.
  for (const stdout of ['%71 /tmp/tmux-1000/soma', '%7 /tmp/tmux-1000/soma2', '%7 /tmp/tmux-1000/som', '%7_/tmp/tmux-1000/soma', '%7']) {
    assert.equal(bus.paneOnServer('%7', TMUX, record({ stdout, code: 0 })), false, JSON.stringify(stdout));
  }
  // A socket path may hold a space; a pane id never does, so the answer splits at the first one.
  assert.equal(bus.paneOnServer('%7', '/tmp/a b/tmux-1000/soma,1,0', record({ stdout: '%7 /tmp/a b/tmux-1000/soma\n', code: 0 })), true);

  // Nothing to prove, so no process: no pane, or no $TMUX (a session outside tmux).
  const spawned = [];
  const counting = (args) => { spawned.push(args); return { stdout: '%7 /tmp/tmux-1000/soma', code: 0 }; };
  for (const [pane, tmuxVar] of [[null, TMUX], ['', TMUX], ['%7', undefined], ['%7', ''], ['%7', ',4242,0'], ['%7', 42]]) {
    assert.equal(bus.paneOnServer(pane, tmuxVar, counting), false, JSON.stringify([pane, tmuxVar]));
  }
  assert.deepEqual(spawned, [], 'nothing to prove costs no tmux call');
});

test('a pane on a server that is not running is a gone pane, and no path reaches the caller', { skip: !tmuxInstalled && 'tmux not installed' }, (t_) => {
  const name = `t12-noserver-${process.pid}`;
  const pane = livePane(name);
  if (!pane) return t_.skip('tmux could not start a session here');
  tmux.defaultRun(['kill-server']);
  sessions.clear();

  const probe = tmux.defaultRun(['display-message', '-p', '-t', pane, '#{pane_id}']);
  assert.equal(probe.code, 1);
  assert.equal(probe.stdout, '', 'the "no server running on <socket path>" line is stderr, not stdout');
  assert.match(probe.stderr, /no server running/);
  // Which is what makes the predicate a boolean and not a path leak: it reads stdout.
  assert.equal(bus.hasPane(pane), false);
});

test('leaseStale, with this predicate, keeps the three states apart', { skip: !tmuxInstalled && 'tmux not installed' }, (t_) => {
  freshHome();
  const name = `t12-stale-${process.pid}`;
  const pane = livePane(name);
  if (!pane) return t_.skip('tmux could not start a session here');

  // Live pane, fresh heartbeat: NOT stale. With trap A's predicate this is `true`,
  // and the fleet is silently stealable out from under a working orchestrator.
  const live = { session_id: 'sess-A', tmux_pane: pane, wake: 'tmux', heartbeat_at: Date.now() };
  assert.equal(lease.leaseStale(live, bus.hasPane), false);

  // Dead pane, fresh heartbeat: stale, and that is what instant adoption reads. With
  // trap B's predicate this is `false` and a dead orchestrator holds the fleet for
  // ten more minutes.
  assert.equal(lease.leaseStale({ ...live, tmux_pane: '%99999' }, bus.hasPane), true);

  // No pane at all (a `notify`-mode holder promoted outside tmux): the heartbeat is
  // the only evidence there is, and probing a pane it never had must not be what
  // decides it.
  assert.equal(lease.leaseStale({ ...live, tmux_pane: null, wake: 'notify' }, bus.hasPane), false);
  assert.equal(lease.leaseStale({ ...live, tmux_pane: null, wake: 'notify', heartbeat_at: Date.now() - 11 * 60_000 }, bus.hasPane), true);

  // Live pane, heartbeat aged past ten minutes: stale. Both arms, not just the pane.
  assert.equal(lease.leaseStale({ ...live, heartbeat_at: Date.now() - 11 * 60_000 }, bus.hasPane), true);
});

test('soma_adopt, on real modules and real tmux, refuses a live holder and takes a dead one', { skip: !tmuxInstalled && 'tmux not installed' }, async (t_) => {
  freshHome();
  const name = `t12-adopt-${process.pid}`;
  const pane = livePane(name);
  if (!pane) return t_.skip('tmux could not start a session here');

  // An incumbent whose pane is right there and whose heartbeat is seconds old.
  const granted = lease.acquireLease({ session_id: 'sess-INCUMBENT', tmux_socket: TEST_SOCKET, tmux_pane: pane, wake: 'tmux' });
  assert.equal(granted.ok, true);

  const refused = await orch({ CLAUDE_CODE_SESSION_ID: 'sess-B' }).get('soma_adopt')({});
  assert.equal(refused.adopted, false);
  // `holder_live: true` is the claim `/soma-promote` tells the operator a refusal
  // makes. Under trap A it would be a grant instead; under trap B it would be this
  // same `true` about a pane that had died.
  assert.equal(refused.holder_live, true, 'the refusal must prove the holder is live');
  assert.equal(refused.holder.session_id, 'sess-INCUMBENT');

  // The incumbent's pane dies. Nothing else changes — the heartbeat is still fresh,
  // so only the pane arm can grant this, and only a correct predicate reads it.
  tmux.killSession(name);
  sessions.delete(name);

  const taken = await orch({ CLAUDE_CODE_SESSION_ID: 'sess-B', SOMA_TMUX_PANE: null }).get('soma_adopt')({});
  assert.equal(taken.adopted, true, 'a dead holder must be adoptable at once, with no force from the caller');
  assert.equal(taken.forced, true, 'and reported as having overridden a record that belonged to someone else');
  assert.equal(taken.lease_seq, 2);
  assert.equal(lease.readLease().session_id, 'sess-B');
});

// ---------------------------------------------------------------------------
// 4. tailLog — the sketch's `require()` inside ESM
// ---------------------------------------------------------------------------

test('the transcript tail is read without require(), keeps the end, and is bounded', async () => {
  const home = freshHome();
  const tools = orch();
  fleet.enqueue([{ id: 'cr-1', title: 't', repo: 'r', brief: 'b' }]);

  writeFileSync(join(home, 'logs', 'cr-1.log'), Array.from({ length: 400 }, (_, i) => `line-${i}`).join('\n'));
  const small = await tools.get('soma_transcript')({ lead: 'cr-1', lines: 5 });
  // `require is not defined` is a ReferenceError, which the def() net would turn
  // into "soma soma_transcript failed unexpectedly (ReferenceError)".
  assert.doesNotMatch(JSON.stringify(small), /ReferenceError|require/);
  assert.deepEqual(small.text.split('\n'), ['line-395', 'line-396', 'line-397', 'line-398', 'line-399']);
  assert.equal(small.lines, 5);

  // A transcript larger than the 1 MiB tail window: the answer still comes off the END.
  const filler = `${'x'.repeat(4095)}\n`.repeat(400);            // ~1.6 MiB
  writeFileSync(join(home, 'logs', 'cr-1.log'), `HEAD-MARKER\n${filler}TAIL-MARKER`);
  const big = await tools.get('soma_transcript')({ lead: 'cr-1', lines: 3 });
  assert.ok(big.text.endsWith('TAIL-MARKER'), 'the tail is what a death scene is at');
  assert.doesNotMatch(big.text, /HEAD-MARKER/, 'the head must not be read at all');
  assert.equal(big.text.split('\n').length, 3);

  // The fragment the byte window opens on is dropped, and this is the shape that
  // makes that visible: ONE line longer than the window, then two short ones, with
  // more lines requested than the window holds. Keeping the fragment would answer
  // with a megabyte of filler that the character cap then truncates — and, since the
  // filler is two bytes per character and the window lands on an odd offset, with a
  // replacement character at the front.
  writeFileSync(join(home, 'logs', 'cr-1.log'), `${'é'.repeat(700_000)}\nTAIL-1\nTAIL-2\n`);
  const frag = await tools.get('soma_transcript')({ lead: 'cr-1', lines: 500 });
  assert.equal(frag.text, 'TAIL-1\nTAIL-2\n');
  assert.equal(frag.truncated, false, 'with the fragment dropped there is nothing left to truncate');
  assert.equal(frag.chars, 14);
  assert.doesNotMatch(frag.text, /é/, 'no part of the over-long line survives');
  assert.doesNotMatch(frag.text, /�/, 'and a byte-offset window leaves no replacement character');
});

test('the tail read is bounded, so a transcript too large to hold is still answered', async (t_) => {
  const home = freshHome();
  fleet.enqueue([{ id: 'cr-1', title: 't', repo: 'r', brief: 'b' }]);
  const fp = join(home, 'logs', 'cr-1.log');

  // A sparse 3 GiB log with real content at the end — 4 KiB on disk, and the size a
  // pipe-pane transcript of a long-running lead heads towards. Reading it whole is
  // measured at 1.1 s and a 3 GiB allocation before it gives up with
  // ERR_STRING_TOO_LONG, so under a whole-file readFileSync this is a refusal; the
  // window answers it in under a millisecond. Boundedness produces the same output as
  // a whole-file read at every size that fits in memory, so this is the only kind of
  // assertion that can pin it at all.
  const SIZE = 3 * 1024 ** 3;
  const fd = openSync(fp, 'w');
  try {
    ftruncateSync(fd, SIZE);
    writeSync(fd, Buffer.from('TAIL-A\nTAIL-B\n'), 0, 14, SIZE);
  } finally {
    closeSync(fd);
  }
  if (statSync(fp).blocks * 512 > 64 * 1024 * 1024) return t_.skip('this filesystem does not do sparse files');

  const started = Date.now();
  const reply = await orch().get('soma_transcript')({ lead: 'cr-1', lines: 3 });
  assert.notEqual(reply.ok, false, `a bounded read must answer, not refuse: ${reply.error ?? ''}`);
  assert.match(reply.text, /TAIL-B/, 'and answer with the end of the log');
  assert.ok(Date.now() - started < 2000, `a bounded read must not scan 3 GiB; took ${Date.now() - started}ms`);
});

test('a transcript that is not there is said so, not returned as an empty one', async () => {
  const home = freshHome();
  fleet.enqueue([{ id: 'cr-1', title: 't', repo: 'r', brief: 'b' }]);
  const reply = await orch().get('soma_transcript')({ lead: 'cr-1' });

  // `{text: ''}` reads as "the lead printed nothing", which is a claim about the
  // lead and sends an orchestrator down the wrong path entirely.
  assert.equal(reply.ok, false);
  assert.notEqual(reply.text, '');
  assert.match(reply.error, /transcript could not be read/);
  assert.match(reply.error, /ENOENT/, 'the errno is the diagnosis a model may have');
  assert.doesNotMatch(reply.error, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the path is not');
  assert.doesNotMatch(reply.error, /cr-1\.log/);
});

// ---------------------------------------------------------------------------
// 5. Identity — CLAUDE_SESSION_ID does not exist
// ---------------------------------------------------------------------------

test('the entrypoint never reads CLAUDE_SESSION_ID, and passes CLAUDE_CODE_SESSION_ID through', () => {
  // A source pin, because the defect is a *read that must not exist*: on 2.1.220
  // `CLAUDE_SESSION_ID` is undefined inside an MCP server, so the original
  // `SOMA_SESSION_ID || CLAUDE_SESSION_ID` gave the bus no identity at all and no
  // session on the machine could adopt the fleet. Fail-closed, and total.
  const code = BUS_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /CLAUDE_SESSION_ID/, 'the dead read must not come back');
  // Scoped to `busEnv`'s own declaration, not to the file. Over the whole source a
  // `/\.\.\.env/` pin is satisfied by the spread in `main`'s promotion — which has
  // nothing to do with the identity contract — so the guard could be removed here and
  // the pin would keep passing on the decoy. (Found by running the assertion spy over
  // this file: two matches in one 15 kB subject.) The behavioural half is below.
  const busEnvSrc = /export const busEnv[\s\S]*?\n\}\);/.exec(code)?.[0] ?? '';
  assert.match(busEnvSrc, /^export const busEnv/, 'busEnv must be findable for the pin below to mean anything');
  assert.match(busEnvSrc, /\.\.\.env/, 'busEnv must spread the environment, or CLAUDE_CODE_SESSION_ID never reaches bus-tools');

  const env = bus.busEnv({ CLAUDE_CODE_SESSION_ID: 'uuid-1', SOMA_ROLE: 'candidate', TMUX_PANE: '%4' });
  assert.equal(env.CLAUDE_CODE_SESSION_ID, 'uuid-1');
  assert.equal(env.CLAUDE_SESSION_ID, undefined);
});

test('soma_adopt records the id the inject hook compares against, and says where it came from', async () => {
  freshHome();
  const first = await orch({ CLAUDE_CODE_SESSION_ID: 'uuid-harness', SOMA_SESSION_ID: 'override' }).get('soma_adopt')({});
  assert.equal(first.adopted, true);
  assert.equal(lease.readLease().session_id, 'uuid-harness', 'the harness id wins: an override can only be wrong while it is present');
  assert.equal(first.session_id_source, 'claude-code');

  freshHome();
  const fallback = await orch({ CLAUDE_CODE_SESSION_ID: '', SOMA_SESSION_ID: 'hand-run' }).get('soma_adopt')({});
  assert.equal(fallback.adopted, true);
  assert.equal(fallback.session_id_source, 'soma-env');

  freshHome();
  const none = await orch({ CLAUDE_CODE_SESSION_ID: '' }).get('soma_adopt')({});
  assert.equal(none.adopted, false, 'no identity is a refusal, not a lease no hook can match');
  assert.match(none.error, /CLAUDE_CODE_SESSION_ID/);
  assert.equal(lease.readLease(), null);
});

test('SOMA_TMUX_PANE is $TMUX_PANE, and a deliberate value is not clobbered by its absence', () => {
  // tmux sets TMUX_PANE for every process in a pane, and it decides wake:'tmux' vs
  // wake:'notify' in the lease claim — so the harness value wins, for the same
  // reason the session id does.
  assert.equal(bus.busEnv({ TMUX_PANE: '%9' }).SOMA_TMUX_PANE, '%9');
  assert.equal(bus.busEnv({ TMUX_PANE: '%9', SOMA_TMUX_PANE: '%1' }).SOMA_TMUX_PANE, '%9');
  // The original `SOMA_TMUX_PANE: process.env.TMUX_PANE` overwrites a deliberate value
  // with undefined on every bus that is not in a pane — a hand-run or test bus then
  // silently claims notify-mode wake.
  assert.equal(bus.busEnv({ SOMA_TMUX_PANE: '%1' }).SOMA_TMUX_PANE, '%1');
  assert.equal(bus.busEnv({}).SOMA_TMUX_PANE, undefined);

  // `$TMUX` reaches bus-tools through the spread too: it is what proves the pane is on soma's
  // server (issue #2), so a busEnv that dropped it would degrade every adopt to notify.
  assert.equal(bus.busEnv({ TMUX: '/tmp/tmux-1000/soma,4242,0' }).TMUX, '/tmp/tmux-1000/soma,4242,0');

  // The pane becomes the claim once it is proven, and the proof is asked about exactly the
  // pane and the `$TMUX` this process was started with. The verifier is the one stub here: the
  // real probe, against two real servers, is in `test/wake-sockets.test.mjs`.
  freshHome();
  const asked = [];
  const deps = { ...bus.realDeps(), paneOnServer: (pane, tmuxVar) => { asked.push([pane, tmuxVar]); return true; } };
  const claimed = bus.buildTools(bus.busEnv({ SOMA_ROLE: 'orchestrator', CLAUDE_CODE_SESSION_ID: 'u', TMUX_PANE: '%9', TMUX: '/tmp/tmux-1000/soma,4242,0', SOMA_TMUX_SOCKET: TEST_SOCKET }), deps);
  return claimed.tools.get('soma_adopt')({}).then(async (r) => {
    assert.equal(r.adopted, true);
    assert.equal(r.wake, 'tmux');
    assert.deepEqual(asked, [['%9', '/tmp/tmux-1000/soma,4242,0']]);
    assert.equal(lease.readLease().tmux_pane, '%9');
    assert.equal(lease.readLease().tmux_socket, TEST_SOCKET, 'the claim names the soma tmux server');

    // With the real wiring and no `$TMUX`, nothing can be proven, so the claim is notify.
    freshHome();
    const unproven = await bus.buildTools(bus.busEnv({ SOMA_ROLE: 'orchestrator', CLAUDE_CODE_SESSION_ID: 'u', TMUX_PANE: '%9', SOMA_TMUX_SOCKET: TEST_SOCKET })).tools.get('soma_adopt')({});
    assert.equal(unproven.wake, 'notify');
    assert.equal(unproven.degraded_wake, true);
    assert.equal(lease.readLease().tmux_pane, null);
  });
});

// ---------------------------------------------------------------------------
// 6. The harness fold — the canonical id, not the spelling a lead used
// ---------------------------------------------------------------------------

test('a lead reported harness folds onto the row as its canonical id', async () => {
  const home = freshHome();
  fleet.enqueue([{ id: 'cr-1', title: 't', repo: 'r', brief: 'b' }]);
  fleet.setTaskStatus('cr-1', 'spawned');

  // The spelling a lead actually sends — the harness id with its description glued
  // on. Unvalidated, `soma_status` renders `harness: "H2 — the suite already runs"`.
  events.appendEvent('cr-1', { type: 'HARNESS', lead: 'cr-1', payload: { harness_id: 'h2 — the suite already runs', budget_class: 'iterate' } });

  // Adopt first, on the real lease module. Since the holder gate landed, `soma_inbox` is gated
  // on holding the lease — it folds terminal statuses onto rows and advances a role-keyed cursor,
  // so it is a writer — and this is the sequence a real orchestrator performs anyway.
  assert.equal((await orch().get('soma_adopt')({})).adopted, true);

  const drained = await orch().get('soma_inbox')({ limit: 50 });
  assert.equal(drained.folded, 1);
  const row = fleet.readFleet().tasks.find((t) => t.id === 'cr-1');
  assert.equal(row.harness, 'H2', 'the canonical id, not the raw spelling');
  assert.ok(!/suite already runs/.test(String(row.harness)));
  assert.equal(row.budget_class, 'iterate');

  // And a report the real validator refuses is not folded at all: a wrong harness
  // on the row prices the budget breaker wrongly, so no harness beats a bad one.
  events.appendEvent('cr-1', { type: 'HARNESS', lead: 'cr-1', payload: { harness_id: 'H99-not-a-harness' } });
  const second = await orch().get('soma_inbox')({ limit: 50 });
  assert.equal(second.returned, 1);
  assert.equal(fleet.readFleet().tasks.find((t) => t.id === 'cr-1').harness, 'H2', 'the good one survives');
  assert.doesNotMatch(JSON.stringify(second), new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

// ---------------------------------------------------------------------------
// 7. The entrypoint over the real transport
// ---------------------------------------------------------------------------

test('a candidate session initializes, lists two tools, and can call one', async () => {
  freshHome();
  const b = wire({ env: { SOMA_ROLE: 'candidate', CLAUDE_CODE_SESSION_ID: 'uuid-c' } });

  b.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  await until(() => b.byId(0), 'the initialize reply');
  assert.equal(b.byId(0).result.capabilities.tools.listChanged, true, 'listChanged is what licenses the promotion notice');

  b.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  await until(() => b.byId(1), 'the first tools/list');
  assert.deepEqual(b.byId(1).result.tools.map((t) => t.name), ['soma_adopt', 'soma_status']);

  b.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'soma_status', arguments: {} } });
  await until(() => b.byId(2), 'the soma_status reply');
  const status = b.result(2);
  assert.ok(Array.isArray(status.leads) && Array.isArray(status.queue), JSON.stringify(status));

  // The ten it may not touch are absent, not refusing: an unpromoted session's tool
  // list must not advertise a control plane.
  b.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'soma_spawn', arguments: {} } });
  await until(() => b.byId(3), 'the unknown-tool error');
  assert.equal(b.byId(3).error.code, -32601);
});

test('a successful adopt grows the tool list in place and announces it', async () => {
  freshHome();
  const b = wire({ env: { SOMA_ROLE: 'candidate', CLAUDE_CODE_SESSION_ID: 'uuid-up', SOMA_TMUX_SOCKET: TEST_SOCKET } });

  b.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  await until(() => b.byId(1), 'the candidate tools/list');
  assert.equal(b.byId(1).result.tools.length, 2);

  b.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'soma_adopt', arguments: {} } });
  await until(() => b.byId(2), 'the adopt reply');
  assert.equal(b.result(2).adopted, true);

  await until(() => b.notifications().length, 'the tools/list_changed notification');
  assert.deepEqual(b.notifications().map((m) => m.method), ['notifications/tools/list_changed']);
  assert.equal(b.notifications()[0].id, undefined, 'a notification carries no id');

  // The Map serve() is holding grew, which is why no restart and no /mcp reconnect.
  b.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  await until(() => b.byId(3), 'the promoted tools/list');
  assert.deepEqual(b.byId(3).result.tools.map((t) => t.name).sort(), [...ORCH_TOOLS].sort());

  // ...and a control tool now actually dispatches.
  b.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'soma_enqueue', arguments: { tasks: [{ id: 'cr-9', title: 't', repo: 'r', brief: 'b' }] } } });
  await until(() => b.byId(4), 'the enqueue reply');
  assert.deepEqual(b.result(4).queued, ['cr-9']);
});

test('a refused adopt does not hand over the control plane', async () => {
  freshHome();
  // A holder with no pane and a fresh heartbeat: neither arm of leaseStale grants,
  // and there is no tmux involved, so this refusal is deterministic.
  lease.acquireLease({ session_id: 'sess-INCUMBENT', wake: 'notify', tmux_pane: null });
  const b = wire({ env: { SOMA_ROLE: 'candidate', CLAUDE_CODE_SESSION_ID: 'uuid-loser' } });

  b.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'soma_adopt', arguments: {} } });
  await until(() => b.byId(1), 'the refusal');
  assert.equal(b.result(1).adopted, false);

  b.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  await until(() => b.byId(2), 'the tools/list after the refusal');
  assert.deepEqual(b.byId(2).result.tools.map((t) => t.name), ['soma_adopt', 'soma_status'],
    'a session that took the control plane on a refused adopt is a second orchestrator on one queue');
  assert.deepEqual(b.notifications(), [], 'and nothing was announced');
  assert.equal(lease.readLease().session_id, 'sess-INCUMBENT');
});

test('the promotion replaces its own wrapper, so a re-adopt announces nothing new', async () => {
  freshHome();
  const b = wire({ env: { SOMA_ROLE: 'candidate', CLAUDE_CODE_SESSION_ID: 'uuid-again', SOMA_TMUX_SOCKET: TEST_SOCKET } });
  const before = b.tools.get('soma_adopt');

  b.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'soma_adopt', arguments: {} } });
  await until(() => b.byId(1) && b.notifications().length === 1, 'the first adopt and its notice');

  assert.notEqual(b.tools.get('soma_adopt'), before, "the wrapper is overwritten by the orchestrator's own handler");

  // `/soma-promote` may re-adopt a lease this session already holds, and an
  // idempotent re-adopt has nothing to announce — there is no wrapper stack to grow.
  b.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'soma_adopt', arguments: {} } });
  await until(() => b.byId(2), 'the second adopt');
  assert.equal(b.result(2).adopted, true);
  assert.equal(b.result(2).already_held, true);
  assert.equal(b.result(2).lease_seq, 1, 'an idempotent re-adopt is not a new generation');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(b.notifications().length, 1, 'and it announces nothing a second time');
});

test('a lead and an already-promoted orchestrator get no upgrade wrapper', async () => {
  freshHome();
  const orchBus = wire({ env: { SOMA_ROLE: 'orchestrator', CLAUDE_CODE_SESSION_ID: 'uuid-o', SOMA_TMUX_SOCKET: TEST_SOCKET } });
  const adopt = orchBus.tools.get('soma_adopt');
  orchBus.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'soma_adopt', arguments: {} } });
  await until(() => orchBus.byId(1), 'the orchestrator adopt');
  assert.equal(orchBus.result(1).adopted, true);
  assert.equal(orchBus.tools.get('soma_adopt'), adopt, 'nothing to upgrade, so nothing was wrapped');
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(orchBus.notifications(), [], 'and nothing announced a list that never changed');

  freshHome();
  const leadBus = wire({ env: { SOMA_ROLE: 'lead', SOMA_LEAD_NAME: 'cr-1' } });
  leadBus.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  await until(() => leadBus.byId(1), 'the lead tools/list');
  assert.deepEqual(leadBus.byId(1).result.tools.map((t) => t.name).sort(), ['soma_checkpoint', 'soma_report', 'soma_task']);
  assert.equal(leadBus.tools.get('soma_adopt'), undefined, 'a lead has no adopt to wrap');
});

test('a session that already holds the lease starts as the orchestrator, so the promotion survives a restart', async () => {
  freshHome();
  // The hole this closes: the in-process upgrade dies with the bus process, and a
  // `--resume` (which preserves the session id) or an MCP reconnect starts a fresh
  // bus that reads the same empty SOMA_ROLE. Before this, that session held the
  // lease on disk and had two tools — the control plane silently gone.
  lease.acquireLease({ session_id: 'uuid-holder', wake: 'notify', tmux_pane: null });

  const restarted = wire({ env: { CLAUDE_CODE_SESSION_ID: 'uuid-holder' } });
  assert.equal(restarted.role, 'orchestrator');
  restarted.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  await until(() => restarted.byId(1), 'the restarted tools/list');
  assert.deepEqual(restarted.byId(1).result.tools.map((t) => t.name).sort(), [...ORCH_TOOLS].sort());

  // ...and only for the session the lease actually names.
  const other = wire({ env: { CLAUDE_CODE_SESSION_ID: 'uuid-someone-else' } });
  assert.equal(other.role, 'candidate');
  other.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  await until(() => other.byId(1), "the other session's tools/list");
  assert.deepEqual(other.byId(1).result.tools.map((t) => t.name), ['soma_adopt', 'soma_status']);

  assert.equal(wire({ env: {} }).role, 'candidate');
  assert.equal(wire({ env: { SOMA_SESSION_ID: 'uuid-holder' } }).role, 'orchestrator', 'the override still identifies a hand-run bus');

  // A lead never reaches the control plane this way — and this assertion only means
  // something while the lease above still names `uuid-holder`, so it stays here rather
  // than after the fresh home below.
  assert.equal(wire({ env: { SOMA_ROLE: 'lead', SOMA_LEAD_NAME: 'cr-1', CLAUDE_CODE_SESSION_ID: 'uuid-holder' } }).role, 'lead');

  // A session with no identity, on a fleet with no lease, is a candidate — its own
  // case because the two absences compare EQUAL: an unguarded
  // `readLease()?.session_id === id` is `undefined === undefined`, which would hand
  // twelve control tools to every fresh session on a machine that has no fleet.
  freshHome();
  assert.equal(lease.readLease(), null);
  assert.equal(wire({ env: {} }).role, 'candidate');
  assert.equal(wire({ env: { SOMA_ROLE: 'candidate' } }).role, 'candidate');

  // And a lease that cannot be read is a candidate, never a bus that failed to start.
  // The startup throw is captured as a value: `main()` is called from a bare statement,
  // and an uncaught throw there aborts the test instead of failing the line that is
  // about it.
  const home = freshHome();
  lease.acquireLease({ session_id: 'uuid-holder', wake: 'notify', tmux_pane: null });
  rmSync(join(home, 'state', 'orch.lease'), { force: true });
  mkdirSync(join(home, 'state', 'orch.lease'), { recursive: true });
  let broken;
  let startupError = null;
  try {
    broken = wire({ env: { CLAUDE_CODE_SESSION_ID: 'uuid-holder' } });
  } catch (e) {
    startupError = `${e?.code ?? e?.name}: ${e?.message}`;
  }
  assert.equal(startupError, null, 'an unreadable lease must not stop the bus from starting at all');
  assert.equal(broken?.role, 'candidate');
  broken?.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  await until(() => broken?.byId(1), 'the tools/list past an unreadable lease');
  assert.equal(broken?.byId(1).result.tools.length, 2, 'degraded, not dead');
});

/**
 * The parameter names each handler actually destructures, read out of
 * `bus-tools.mjs`. A declared schema that does not match them is not a cosmetic
 * defect: an MCP client puts `inputSchema` in front of a model, so a model that
 * cannot see the word `message` calls `soma_send` with something else — once — and
 * reports the lead as answered.
 */
const handlerParams = () => {
  const regs = [...BUS_TOOLS_SRC.matchAll(/(?:def|tools\.set)\('(soma_[a-z_]+)'/g)];
  const out = new Map();
  regs.forEach((m, i) => {
    const body = BUS_TOOLS_SRC.slice(m.index, i + 1 < regs.length ? regs[i + 1].index : BUS_TOOLS_SRC.length);
    const inline = /^(?:def|tools\.set)\('[^']+',\s*async\s*\(\{([^}]*)\}/.exec(body);
    const destructured = /const\s*\{([^}]*)\}\s*=\s*args\s*\?\?\s*\{\}/.exec(body);
    const list = inline?.[1] ?? destructured?.[1] ?? '';
    out.set(m[1], list.split(',').map((s) => s.trim().split(/[=:]/)[0].trim()).filter(Boolean).sort());
  });
  return out;
};

test('every tool declares the arguments its handler actually reads', () => {
  const params = handlerParams();
  assert.equal(params.size, 15, `expected all 15 registrations, found ${[...params.keys()]}`);

  for (const [name, expected] of params) {
    const spec = bus.describe(name);
    assert.equal(spec.name, name);
    assert.ok(spec.description.length > 40, `${name} needs a description a model can act on, got ${JSON.stringify(spec.description)}`);
    assert.doesNotMatch(spec.description, /^soma soma_/, `${name}'s description must not be the placeholder`);
    assert.equal(spec.inputSchema.type, 'object');
    assert.deepEqual(Object.keys(spec.inputSchema.properties ?? {}).sort(), expected,
      `${name}'s declared properties must be the parameters it destructures`);
  }

  // Spot-check the two that matter most, so a bulk-generated schema cannot satisfy
  // the loop above with the right keys and the wrong types.
  const send = bus.describe('soma_send').inputSchema;
  assert.deepEqual(send.required.sort(), ['lead', 'message']);
  assert.equal(send.properties.message.type, 'string');
  const inbox = bus.describe('soma_inbox').inputSchema;
  assert.equal(inbox.properties.limit.maximum, 200, "the handler's own cap");
  assert.equal(inbox.properties.limit.default, 50);
  assert.equal(inbox.properties.mark_read.type, 'boolean');
  assert.equal(bus.describe('soma_report').inputSchema.properties.type.enum.length, 6);
});

test('a soma_enqueue task row declares verify_hint, as a string', () => {
  // `prompts/orchestrator.md` tells the model to send `verify_hint` with each task. Task rows are
  // declared `additionalProperties: false`, so while the field is undeclared the schema tells the
  // model it may not send the one field the prompt asks for.
  const item = bus.describe('soma_enqueue').inputSchema.properties.tasks.items;
  assert.equal(item.additionalProperties, false, 'the premise: an undeclared row field is refused');
  assert.equal(item.properties.verify_hint?.type, 'string', 'soma_enqueue\'s task row must declare verify_hint as a string');
  // Optional, like every field but the id: a task with none falls back to its repo's hint in soma.json.
  assert.deepEqual(item.required, ['id']);
});

test('describe answers for a name it has never heard of instead of throwing', () => {
  // serve() calls describe once per key in the live Map, and a throw during
  // tools/list costs the session its whole tool list.
  const unknown = bus.describe('soma_time_travel');
  assert.equal(unknown.name, 'soma_time_travel');
  assert.equal(typeof unknown.description, 'string');
  assert.deepEqual(unknown.inputSchema, { type: 'object' });
  for (const hostile of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const spec = bus.describe(hostile);
    assert.equal(spec.name, hostile);
    assert.equal(typeof spec.description, 'string', `${hostile} must not resolve off the prototype`);
    assert.deepEqual(spec.inputSchema, { type: 'object' });
  }
});

// ---------------------------------------------------------------------------
// 8. The main guard
// ---------------------------------------------------------------------------

/** Start the bus as a real child process and ask it to initialize. */
const initializes = (entry, home) => new Promise((resolve) => {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, SOMA_HOME: home, SOMA_ROLE: 'candidate' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  const done = (value) => { try { child.kill('SIGKILL'); } catch { /* already gone */ } resolve(value); };
  const timer = setTimeout(() => done({ ok: false, out, err }), 8000);
  child.stdout.on('data', (c) => {
    out += String(c);
    if (out.includes('\n')) { clearTimeout(timer); done({ ok: true, reply: JSON.parse(out.split('\n')[0]), err }); }
  });
  child.stderr.on('data', (c) => { err += String(c); });
  child.on('error', () => { clearTimeout(timer); done({ ok: false, out, err }); });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} })}\n`);
});

test('the bus starts when it is run through a symlink, and from a path with a space in it', async () => {
  const home = freshHome();
  const dir = mkdtempSync(join(tmpdir(), 'soma t12 main '));   // the space is the point
  trash.push(dir);

  const link = join(dir, 'bus-link.mjs');
  symlinkSync(BUS_URL, link);
  const spaced = join(dir, 'bin');
  cpSync(new URL('../bin/', import.meta.url), spaced, { recursive: true });
  const spacedEntry = join(spaced, 'soma-bus.mjs');

  for (const entry of [link, spacedEntry]) {
    // The negative control, measured rather than asserted about. The guard this replaces,
    // `import.meta.url === \`file://${argv[1]}\``, compares a raw argv path against a
    // percent-encoded, symlink-resolved URL, and these are the two ways those differ:
    // a space is encoded in one and not the other, and a symlink resolves to its
    // target in one and not the other. Under that guard `main()` never runs, and an
    // MCP server that starts and answers no frame is how it fails.
    assert.notEqual(`file://${entry}`, pathToFileURL(realpathSync(entry)).href,
      `the guard this replaces must actually be wrong for ${entry}, or this case proves nothing`);

    const started = await initializes(entry, home);
    assert.equal(started.ok, true, `the bus run as ${entry} must answer initialize; stderr=${started.err}`);
    assert.equal(started.reply.id, 0);
    assert.equal(started.reply.result.serverInfo.name, 'soma');
    assert.equal(started.err, '', 'and it must put nothing on stderr on a clean start');
  }
});

test('importing the module starts no server', async () => {
  // The other half of the guard: this whole file has imported the bus dozens of
  // times without one of them attaching to this process's stdin. If it had, the
  // test runner's own stdio would be a JSON-RPC channel.
  const fresh = await import(`${BUS_URL.href}?guard=${Date.now()}`);
  assert.equal(typeof fresh.main, 'function');
  assert.equal(process.stdin.listenerCount('data'), 0, 'an imported bus must not have subscribed to stdin');
});

// ---------------------------------------------------------------------------
// 9. Hygiene: no refusal names a path, and the state files are where the watchdog looks
// ---------------------------------------------------------------------------

test('no refusal on the real-dep surface names a filesystem path', async () => {
  const home = freshHome();
  // Break every reader at once, in the two ways that put a path in err.message. A
  // checkpoint that parses but is not one is rejected by `fleet.mjs` with a message
  // that quotes its absolute path — measured, and it is the shape a hand-edited
  // fleet.json takes — and a directory where a file belongs is EISDIR out of fs.
  // The bus's contract is that neither reaches a model.
  fleet.enqueue([{ id: 'cr-1', title: 't', repo: 'r', brief: 'b' }]);
  fleet.setTaskStatus('cr-1', 'spawned');
  writeFileSync(join(home, 'state', 'fleet.json'), '{"tasks": "not an array"}');
  for (const rel of [['state', 'orch.lease'], ['events', 'orch.ndjson'],
    ['events', 'cr-1.ndjson'], ['events', '.cursors.json'], ['logs', 'cr-1.log'],
    ['state', 'backpressure.json'], ['heartbeats', 'cr-1']]) {
    mkdirSync(join(home, ...rel), { recursive: true });
  }

  const tools = orch({ SOMA_TMUX_PANE: '%1' });
  const args = {
    soma_adopt: {}, soma_release: {}, soma_enqueue: { tasks: [{ id: 'cr-2', title: 't', repo: 'r', brief: 'b' }] },
    soma_queue: { action: 'pause' }, soma_spawn: { task_id: 'cr-1' }, soma_status: {},
    soma_inbox: {}, soma_send: { lead: 'cr-1', message: 'hi' }, soma_kill: { lead: 'cr-1', reason: 'why' },
    soma_resume: { lead: 'cr-1' }, soma_transcript: { lead: 'cr-1' }, soma_digest: {},
  };
  const escaped = new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  let refusals = 0;
  for (const name of ORCH_TOOLS) {
    const reply = await settled(tools.get(name)(args[name]));
    const json = JSON.stringify(reply ?? null);
    assert.equal(reply?.threw, undefined, `${name} must answer a value, never throw at the transport`);
    assert.doesNotMatch(json, escaped, `${name} leaked the state root: ${json.slice(0, 400)}`);
    assert.doesNotMatch(json, /\/(Users|home|private|tmp|var)\//, `${name} leaked an absolute path: ${json.slice(0, 400)}`);
    if (reply?.ok === false || reply?.error) refusals++;
  }
  // Without this the loop above would pass on a surface that never failed at all.
  assert.ok(refusals >= 8, `a broken state root must actually make the surface refuse; only ${refusals} did`);

  // The lead's three too — and `leadTools` has NO catch-all net, so an unguarded
  // `taskFor` lets `readFleet`'s thrown message reach the transport, which hands it
  // to the lead's model verbatim as a -32000. The rejection is turned into a value so
  // that "it answered" is an assertion on its own line rather than a red sibling.
  const leadTools = bus.buildTools({ SOMA_ROLE: 'lead', SOMA_LEAD_NAME: 'cr-1' }).tools;
  for (const [name, a] of [['soma_task', {}], ['soma_report', { type: 'MILESTONE', payload: {} }], ['soma_checkpoint', { note: 'n' }]]) {
    const reply = await settled(leadTools.get(name)(a));
    const json = JSON.stringify(reply ?? null);
    assert.equal(reply?.threw, undefined, `${name} must answer a value; a raw fs failure must not reach a lead's model`);
    assert.doesNotMatch(json, escaped, `${name} leaked the state root: ${json.slice(0, 400)}`);
    assert.doesNotMatch(json, /ENOENT|EISDIR|\/(Users|home|private|tmp|var)\//, `${name} leaked a raw fs failure: ${json.slice(0, 400)}`);
  }
  assert.match((await settled(leadTools.get('soma_task')({}))).error, /no task row for lead cr-1/);
});

test('the state files the bus owns are where the design says, and self-heal a wiped root', () => {
  const home = freshHome();
  const deps = bus.realDeps();

  assert.equal(deps.queuePaused(), false);
  deps.setQueuePaused(true);
  // The path is a contract with the watchdog's tick, and it is now asked of the module that
  // OWNS it rather than spelled here. Spelled here it would be the third copy of one
  // string — and the second copy is what already broke this: the bus wrote
  // `state/queue.paused` while the watchdog read `state/QUEUE_PAUSED`, so `soma_queue
  // pause` and `soma_status` agreed with each other and admission kept spawning. A
  // test that re-spells the path passes on both sides of that split.
  assert.ok(existsSync(queuePausedPath()));
  assert.equal(deps.queuePaused(), true);
  deps.setQueuePaused(false);
  assert.equal(existsSync(queuePausedPath()), false);
  assert.equal(deps.queuePaused(), false);
  deps.setQueuePaused(false);   // idempotent: unpausing an unpaused queue is not an error
  // And the switch a lead-facing tool writes is under THIS root, so a wiped or
  // retargeted state root moves it rather than leaving an orphan behind.
  assert.equal(queuePausedPath(), join(home, 'state', 'QUEUE_PAUSED'));

  assert.equal(deps.lastWakeAgeMs(), Infinity, 'no stamp yet must never debounce a wake');
  deps.stampWake();
  // Asked of the helper that owns the string, for the queue switch's reason one notch down:
  // `stampWake` writes this path and `realDeps().lastWakeAgeMs` reads it, 89 lines apart and
  // one of them inside the block an agent rewiring deps is editing. A test that re-spells the
  // path passes on both sides of the split it is meant to catch.
  assert.ok(existsSync(bus.lastWakePath()));
  assert.ok(deps.lastWakeAgeMs() < 5000);
  assert.equal(bus.lastWakePath(), join(home, 'state', 'last-wake'), 'and it is under THIS root');

  assert.equal(deps.heartbeatAgeMs('cr-1'), null, 'no touch file is "not known", not a stall');
  writeFileSync(join(home, 'heartbeats', 'cr-1'), '');
  assert.ok(deps.heartbeatAgeMs('cr-1') < 5000);

  assert.deepEqual(deps.backpressureState(), { active: false });
  writeFileSync(join(home, 'state', 'backpressure.json'), JSON.stringify({ active: true, reason: 'storm' }));
  assert.equal(deps.backpressureState().active, true);

  assert.deepEqual(deps.eventStreams(), ['orch'], 'the orchestrator always sweeps its own stream');
  fleet.enqueue([{ id: 'cr-1', title: 't', repo: 'r', brief: 'b' }, { id: 'cr-2', title: 't', repo: 'r', brief: 'b' }]);
  assert.deepEqual(deps.eventStreams(), ['cr-1', 'cr-2', 'orch']);

  // A checkpoint that will not parse must not silence the mail: an inbox that sweeps
  // nothing reads as "no news", which is indistinguishable from a working fleet
  // going quiet. (A *missing* checkpoint would not prove this — `readFleet` answers
  // ENOENT with an empty fleet and never throws.)
  writeFileSync(join(home, 'state', 'fleet.json'), '{ not json');
  assert.deepEqual(deps.eventStreams(), ['orch']);

  // A state root wiped from under a running fleet must not permanently disable the
  // push channel or the queue switch. Each self-heal is measured against a root that
  // is genuinely missing — the second wipe is there because the first writer would
  // otherwise recreate `state/` and the second would ride on it.
  rmSync(join(home, 'state'), { recursive: true, force: true });
  assert.equal(deps.lastWakeAgeMs(), Infinity);
  assert.equal(deps.queuePaused(), false);
  assert.deepEqual(deps.backpressureState(), { active: false });
  assert.deepEqual(deps.eventStreams(), ['orch']);
  deps.setQueuePaused(true);
  assert.ok(existsSync(queuePausedPath()), 'setQueuePaused self-heals');

  rmSync(join(home, 'state'), { recursive: true, force: true });
  deps.stampWake();
  assert.ok(existsSync(bus.lastWakePath()), 'stampWake self-heals');

  // ONE SPELLING, and this is the guard. The reader and the writer of this path are 89 lines
  // apart in `soma-bus.mjs`, and the read sits inside `realDeps()` — the block an agent
  // rewiring deps edits — while the write sits in a helper that agent will not open. A second
  // copy of that path component growing back there does not throw: `lastWakeAgeMs` would just
  // read `Infinity` forever and every urgent event would wake the pane, with nothing saying the
  // floor had stopped working. Counted, not merely absent, because the one legitimate
  // occurrence IS in that file — which also makes this its own positive control: a typo in the
  // pattern reads 0, not 1, and fails. Scoped to a quoted literal for the queue pin's reason:
  // a path component must be quoted to be used as one, and a pin that forbids describing the
  // defect is a pin that gets the description deleted.
  assert.equal((BUS_SRC.match(/['"]last-wake['"]/g) ?? []).length, 1,
    'bin/soma-bus.mjs must name the wake path exactly once, in lastWakePath()');
});

test('realDeps hands seatsSummary NO clock: a forwarded argument would decide which seats this fleet believes are open', () => {
  const home = freshHome();
  // The comment on that entry says the arity is fixed *on purpose* — `seatsSummary(nowMs)` takes
  // a clock — and nothing held it: `seatsSummary: () => seatsSummary()` rewritten to the bare
  // `seatsSummary,` left this file at 31 pass / 0 fail (MEASURED). bus-tools calls it with no
  // argument today, so the property is invisible until the day some caller passes one.
  //
  // A closure that expired a minute ago is the probe: open against the real clock, closed
  // against any small `nowMs`, because every `closed_until` is a large epoch-ms number.
  const seat = join(home, 'seat-a');
  writeFileSync(join(home, 'soma.json'), JSON.stringify({ seats: [{ config_dir: seat, label: 'seat-a' }] }));
  writeFileSync(join(home, 'state', 'seats.json'), JSON.stringify({
    seats: [{ config_dir: seat, label: 'seat-a', closed_until: Date.now() - 60_000, closed_reason: 'five_hour', unverified: false }],
  }));
  assert.deepEqual(bus.realDeps().seatsSummary(1).open.map((x) => x.label), ['seat-a']);
});

test('the bus and the watchdog reach the queue switch through ONE path, and this file is the guard', async () => {
  const home = freshHome();
  const deps = bus.realDeps();
  const wd = await import('../bin/soma-watchdog.mjs?queue-' + Date.now());

  // THE DEFECT THIS PINS, WHICH SHIPPED AND WAS CAUGHT BY READING RATHER THAN BY A TEST.
  // `soma-bus.mjs` wired the switch inline at `state/queue.paused`; `soma-watchdog.mjs`
  // read `state/QUEUE_PAUSED`. Both files were internally correct and both were tested,
  // and the two test suites agreed with their own halves — so the round trip was green
  // end to end while the only consumer whose behaviour matters read a file nobody wrote.
  // `soma_queue pause` wrote one, `soma_status` read the same one back and rendered
  // `queue_paused: true`, and admission kept spawning. There is no assertion inside
  // either file that could have failed; the defect lives in the GAP between them, so the
  // pin has to be a cross-file identity.
  const write = bus.realDeps().setQueuePaused;
  const readInTick = wd.realDeps().queuePaused;
  write(true);
  assert.equal(readInTick(), true, 'the tick must see what soma_queue pause wrote');
  assert.equal(deps.queuePaused(), true, 'and so must soma_status');
  write(false);
  assert.equal(readInTick(), false, 'and it must see the resume too');
  assert.equal(deps.queuePaused(), false);

  // Both halves resolve to the one module, not merely to the same string today. A second
  // implementation that happened to spell the path identically would pass the round trip
  // above and drift on the next edit, so the identity is asserted against the owner.
  assert.equal(bus.realDeps().queuePaused, queue.queuePaused, 'the bus must wire queue.queuePaused itself');
  assert.equal(bus.realDeps().setQueuePaused, queue.setQueuePaused, 'the bus must wire queue.setQueuePaused itself');
  assert.equal(wd.realDeps().queuePaused, queue.queuePaused, 'and so must the watchdog');
  assert.equal(queuePausedPath(), join(home, 'state', 'QUEUE_PAUSED'));

  // And no file may re-spell it. A grep over the source is what would have caught this an
  // hour earlier, so the grep becomes the regression test — but scoped to STRING LITERALS,
  // not to source text. The first version of this assertion matched anywhere and tripped on
  // the comment above, which *names both spellings on purpose*: prose diagnosing a defect is
  // exactly what a reader needs kept, and a pin that forbids describing the bug is a pin that
  // gets the description deleted. A path component has to be a quoted literal to be used as
  // one, so quotes are the whole distinction.
  // The separator is REQUIRED, not optional. The first version made it `[._-]?` and matched
  // `'queuePaused'` — the dep NAME in `REQUIRED_DEPS`, which is not a path and must stay. A
  // path component always carries a separator (`queue.paused`, `QUEUE_PAUSED`, `queue-paused`);
  // camelCase is the identifier. Both forms of the mistake this pin exists for have one.
  const LITERAL = [/['"]QUEUE_PAUSED['"]/, /['"]queue[._-]paused['"]/i];
  for (const file of ['bin/soma-bus.mjs', 'bin/soma-watchdog.mjs']) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const re of LITERAL) {
      assert.doesNotMatch(src, re,
        `${file} spells a queue-switch path of its own (${re}); import it from lib/queue.mjs, which owns that string`);
    }
  }
  // The control, and it is not decoration: both assertions above are claims about an ABSENCE,
  // and an absence proves nothing unless the same pattern is shown to fire where the string
  // really does live. Without this, a typo in either regex reads as full coverage.
  const owner = readFileSync(new URL('../bin/lib/queue.mjs', import.meta.url), 'utf8');
  assert.match(owner, LITERAL[0]);
});

test('the bus and the watchdog reach state/backpressure.json through ONE module, and the writer is the one the reader waited for', async () => {
  const home = freshHome();
  const wd = await import('../bin/soma-watchdog.mjs?bp-' + Date.now());
  // NOT cache-busted: the identity assertions below compare against the instance the bus and the
  // watchdog themselves resolved, for the reason the `queue` import above gives.
  const backpressure = await import('../bin/lib/wd/backpressure.mjs');
  const read = bus.realDeps().backpressureState;

  assert.deepEqual(read(), { active: false }, 'no file is "not frozen", as before');
  // The watchdog's writers, the bus's reader: what the tick freezes, soma_status shows.
  wd.realDeps().writeBackpressure({ active: true, reason: 'storm', since: 1_440_433_800_000, until: null });
  assert.deepEqual(read(), { active: true, reason: 'storm', since: 1_440_433_800_000, until: null });
  wd.realDeps().clearBackpressure();
  assert.deepEqual(read(), { active: false });

  // Both halves resolve to the one module, not merely to the same string today. The queue switch
  // shipped exactly that way — two spellings, both tested, one file nobody wrote.
  assert.equal(read, backpressure.readBackpressure, 'the bus must wire readBackpressure itself');
  assert.equal(wd.realDeps().readBackpressure, backpressure.readBackpressure, 'and so must the watchdog');
  assert.equal(wd.realDeps().writeBackpressure, backpressure.writeBackpressure);
  assert.equal(wd.realDeps().clearBackpressure, backpressure.clearBackpressure);
  assert.equal(backpressure.backpressurePath(), join(home, 'state', 'backpressure.json'), 'and it is under THIS root');

  // And the bus may not re-spell it. Scoped to a quoted literal, for the queue pin's reason: prose
  // diagnosing the old inline read is exactly what a reader needs kept.
  assert.equal((BUS_SRC.match(/['"]backpressure\.json['"]/g) ?? []).length, 0,
    'bin/soma-bus.mjs must not spell state/backpressure.json; wd/backpressure.mjs owns it');
});

test('realDeps reaches the REAL seats.pick: the bus\'s one decisive dep is wired, not merely named', () => {
  const home = freshHome();
  // `realDeps wires every dep bus-tools reaches for` can only ask `typeof === 'function'`, so it
  // catches a DELETED key and not a wrong one: replacing
  // `pickSeat: (now, cfg) => pickOpenSeat(now, cfg)` with `pickSeat: () => null` left the whole
  // suite green — 1296 tests when that was measured, a dated reading and not the current
  // baseline — while every `soma_spawn` and `soma_resume` on a seated fleet would
  // refuse with "every configured seat is closed or unverified". The watchdog got this pin for its
  // two decisive deps; this is the bus's one.
  const seat = join(home, 'seat-a');
  const cfg = { seats: [{ config_dir: seat, label: 'seat-a' }] };
  writeFileSync(join(home, 'soma.json'), JSON.stringify(cfg));
  const closedUntil = Date.now() + 60_000;
  writeFileSync(join(home, 'state', 'seats.json'), JSON.stringify({
    seats: [{ config_dir: seat, label: 'seat-a', closed_until: closedUntil, closed_reason: 'five_hour', unverified: false }],
  }));
  const pickSeat = bus.realDeps().pickSeat;
  // A closure an hour out: shut against the clock the bus will really pass, open against a clock
  // past it. Both halves are needed — a `() => null` stub passes the first alone, and a
  // `() => SEAT` stub passes the second alone.
  assert.equal(pickSeat(Date.now(), cfg), null, 'a closed seat is not offered');
  assert.deepEqual(pickSeat(closedUntil + 1, cfg), {
    config_dir: seat, label: 'seat-a', closed_until: closedUntil, closed_reason: 'five_hour', unverified: false,
  }, 'and the real pool answers with the real row once the closure has passed');
  // The clock is the caller's, not `Date.now()` inside the wiring: a fixed-arity forward is what
  // `seatsSummary` above also pins, and for the same reason.
  assert.equal(pickSeat.length, 2, 'pickSeat takes (now, cfg) — a dropped parameter would silently use the wrong clock');
});
