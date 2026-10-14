import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The module under test, freshly instantiated (it holds no state, but keeps the fresh-import idiom). */
const load = (tag) => import('../bin/lib/tmux.mjs?' + tag);

/** Records every argument vector a call produces, answering with a canned result. */
const recorder = (result = { stdout: '', code: 0 }) => {
  const calls = [];
  const run = (args) => { calls.push(args); return typeof result === 'function' ? result(args, calls.length) : result; };
  return { calls, run };
};

/** A spawn request that satisfies newSession's preconditions; override per test. */
const spawnReq = (over = {}) => ({
  name: 'lead-cr-1', cwd: '/w', env: { PATH: '/usr/bin', SOMA_LEAD_NAME: 'cr-1' },
  argv: ['claude', '--model', 'opus'], logPath: '/l.log', ...over,
});

// Targets carry an `=` exact-match prefix: a bare `-t lead-cr-1` resolves by
// prefix to a live `lead-cr-10` once cr-1 has died, and the fleet then wakes,
// kills or liveness-checks the wrong lead. Session targets take `=name`,
// window and pane targets take `=name:` (verified against tmux 3.6a).

test('sendKeys issues literal then Enter as two calls', async () => {
  const t = await import('../bin/lib/tmux.mjs?' + Date.now());
  const calls = [];
  const run = (args) => { calls.push(args); return { stdout: '', code: 0 }; };
  t.sendKeys('lead-cr-1', '[soma] ping', run);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['send-keys', '-t', '=lead-cr-1:', '-l', '--', '[soma] ping']);
  assert.deepEqual(calls[1], ['send-keys', '-t', '=lead-cr-1:', 'Enter']);
});

test('hasSession maps exit code to boolean', async () => {
  const t = await import('../bin/lib/tmux.mjs?' + Date.now());
  assert.equal(t.hasSession('x', () => ({ stdout: '', code: 0 })), true);
  assert.equal(t.hasSession('x', () => ({ stdout: '', code: 1 })), false);
});

test('listPanes parses index/dead/title', async () => {
  const t = await import('../bin/lib/tmux.mjs?' + Date.now());
  const run = () => ({ stdout: '0\t0\tlead\n1\t1\timplementer\n', code: 0 });
  const panes = t.listPanes('lead-cr-1', run);
  assert.deepEqual(panes, [
    { index: 0, dead: false, title: 'lead' },
    { index: 1, dead: true, title: 'implementer' },
  ]);
});

test('newSession uses env -i allowlist prefix, not tmux -e', async () => {
  const t = await import('../bin/lib/tmux.mjs?' + Date.now());
  let seen;
  t.newSession({ name: 'lead-cr-1', cwd: '/w', env: { PATH: '/usr/bin', SOMA_LEAD_NAME: 'cr-1' }, argv: ['claude', '--model', 'opus'], logPath: '/l.log' },
    (args) => { seen = args; return { stdout: '', code: 0 }; });
  assert.equal(seen[0], 'new-session');
  assert.ok(seen.includes('-d'));
  assert.ok(seen.includes('env'));               // env(1) prefix
  assert.ok(seen.join(' ').includes('SOMA_LEAD_NAME=cr-1'));
  assert.ok(seen.join(' ').includes('claude --model opus'));
});

// --- exact-match targeting: the one thing that stops cr-1 from meaning cr-10 ---

test('every target is exact-matched, in the form its command accepts', async () => {
  const t = await load('targets');
  const seen = (fn) => { const { calls, run } = recorder({ stdout: '', code: 0 }); fn(run); return calls[0]; };

  // session targets: `=name`
  assert.deepEqual(seen((run) => t.hasSession('lead-cr-1', run)), ['has-session', '-t', '=lead-cr-1']);
  assert.deepEqual(seen((run) => t.killSession('lead-cr-1', run)), ['kill-session', '-t', '=lead-cr-1']);
  assert.equal(seen((run) => t.listPanes('lead-cr-1', run))[3], '=lead-cr-1');
  // window target: `=name:` — `=name` is rejected with "no such window"
  assert.deepEqual(seen((run) => t.setRemainOnExit('lead-cr-1', run)), ['set-option', '-t', '=lead-cr-1:', 'remain-on-exit', 'on']);
  // pane targets: `=name:` — `=name` is rejected with "can't find pane"
  assert.deepEqual(seen((run) => t.capturePane('lead-cr-1', 40, run)), ['capture-pane', '-p', '-t', '=lead-cr-1:']);
  assert.equal(seen((run) => t.sendKeys('lead-cr-1', 'hi', run))[2], '=lead-cr-1:');
  // and the pipe-pane chained into new-session is a pane target too
  assert.equal(seen((run) => t.newSession(spawnReq(), run)).at(-2), '=lead-cr-1:');

  // A `%N` pane id is already unique — prefixing it would break it. This is
  // what $TMUX_PANE holds, so it is what the lease's tmux_pane wake uses.
  assert.equal(seen((run) => t.sendKeys('%12', 'hi', run))[2], '%12');
  assert.equal(seen((run) => t.capturePane('%12', 40, run))[3], '%12');
  // An explicit session:window.pane spec needs the `=` but not another `:`.
  assert.equal(seen((run) => t.sendKeys('lead-cr-1:0.1', 'hi', run))[2], '=lead-cr-1:0.1');
});

// --- the rest of the surface: every wrapper is its argument vector, so pin them ---

test('newSession pins the whole argument vector, chain and all', async () => {
  const t = await load('vector');
  const { calls, run } = recorder();
  t.newSession({
    name: 'lead-cr-1', cwd: '/w',
    env: { PATH: '/usr/bin', SOMA_LEAD_NAME: 'cr-1', CLAUDE_CODE_EFFORT_LEVEL: 'max' },
    argv: ['claude', '--model', 'opus'], logPath: '/l.log',
  }, run);
  assert.equal(calls.length, 1);                 // one tmux invocation: pipe-pane rides the same command chain
  assert.deepEqual(calls[0], [
    'new-session', '-d', '-s', 'lead-cr-1', '-c', '/w',
    'env', '-i', 'PATH=/usr/bin', 'SOMA_LEAD_NAME=cr-1', 'CLAUDE_CODE_EFFORT_LEVEL=max',
    'claude', '--model', 'opus',
    // A bare `;` is tmux's command separator: the transcript is piped from the
    // session's first byte, so nothing printed before a second call is lost.
    ';', 'pipe-pane', '-O', '-o', '-t', '=lead-cr-1:', "cat >> '/l.log'",
  ]);
  // The session being created is named, not targeted: `-s` takes a plain name.
  assert.equal(calls[0][calls[0].indexOf('-s') + 1], 'lead-cr-1');
});

test("newSession's pipe-pane command survives a log path the shell would mangle", async () => {
  const t = await load('quote');
  // tmux hands pipe-pane's command to /bin/sh, so a space in SOMA_HOME would
  // otherwise become "ambiguous redirect" and the lead would run untranscribed.
  for (const logPath of ['/tmp/soma logs/cr-1.log', "/tmp/it's here/cr-1.log", '/dev/null']) {
    const { calls, run } = recorder();
    t.newSession(spawnReq({ logPath }), run);
    const command = calls[0].at(-1);
    assert.ok(command.startsWith('cat >> '), command);
    // Ask a real shell what that redirect target parses to — it must be exactly one word, the path.
    const word = execFileSync('/bin/sh', ['-c', `printf %s ${command.slice('cat >> '.length)}`], { encoding: 'utf8' });
    assert.equal(word, logPath);
  }
});

test("newSession's log path survives tmux's format expansion too", async () => {
  const t = await load('format');
  // tmux format-expands a pipe-pane command BEFORE /bin/sh sees it: an
  // unescaped `#H` becomes the hostname and `%Y` the year, so the transcript
  // lands somewhere else entirely — with pipe-pane still reporting success.
  const logPath = '/tmp/soma#H-%Y/lead #1 100%.log';
  const { calls, run } = recorder();
  t.newSession(spawnReq({ logPath }), run);
  const command = calls[0].at(-1);
  assert.ok(command.includes('##H'), command);
  assert.ok(command.includes('%%Y'), command);

  // Replay both layers in order: tmux collapses the doubles, then sh parses.
  const expanded = command.replaceAll('##', '#').replaceAll('%%', '%');
  const word = execFileSync('/bin/sh', ['-c', `printf %s ${expanded.slice('cat >> '.length)}`], { encoding: 'utf8' });
  assert.equal(word, logPath);
});

test("newSession's cwd survives tmux's expansion — and is NOT escaped the same way", async () => {
  const t = await load('cwd');
  // `-c` runs through format expansion too, so an unescaped `#` in a worktree
  // path sends the lead to $HOME instead — with tmux still exiting 0. But `-c`
  // has no strftime pass, so doubling `%` there is worse than leaving it: `%%`
  // is never collapsed back, the path stops existing, and the lead lands in
  // $HOME anyway. Both behaviours verified on tmux 3.6a.
  const { calls, run } = recorder();
  t.newSession(spawnReq({ cwd: '/w/lead#1 100%/repo', logPath: '/logs/cr-1 100%.log' }), run);
  const cwdArg = calls[0][calls[0].indexOf('-c') + 1];
  assert.equal(cwdArg, '/w/lead##1 100%/repo');
  // tmux collapses `##` and leaves `%` alone: the path comes back intact.
  assert.equal(cwdArg.replaceAll('##', '#'), '/w/lead#1 100%/repo');

  // The pipe-pane command in the same vector still gets BOTH doubled.
  assert.ok(calls[0].at(-1).includes('%%'), 'pipe-pane keeps the strftime escape');
});

test('newSession refuses to spawn a lead whose env cannot resolve the binary', async () => {
  const t = await load('path-guard');
  // `env -i` clears PATH, so without one in the allowlist env(1) cannot find
  // `claude` — and tmux still exits 0, leaving a session whose pane died at
  // birth: the lead reads as alive forever and never starts.
  const { calls, run } = recorder();
  assert.throws(() => t.newSession(spawnReq({ env: { SOMA_LEAD_NAME: 'cr-1' } }), run), /env\.PATH is required/);
  assert.throws(() => t.newSession(spawnReq({ env: {} }), run), /env\.PATH is required/);
  assert.throws(() => t.newSession(spawnReq({ env: { PATH: '' } }), run), /env\.PATH is required/);
  assert.equal(calls.length, 0, 'nothing may reach tmux once the spawn is refused');
  assert.doesNotThrow(() => t.newSession(spawnReq(), run));
});

test('newSession throws with what tmux said when the session cannot be created', async () => {
  const t = await load('throw');
  assert.throws(
    () => t.newSession(spawnReq(), () => ({ stdout: '', stderr: 'duplicate session: lead-cr-1', code: 1 })),
    /duplicate session: lead-cr-1/,
    'the operator has to see why the lead never came up',
  );
  // A run() that only reports stdout (every stub in the fleet does) must still surface it.
  assert.throws(() => t.newSession(spawnReq(), () => ({ stdout: 'no server running', code: 1 })), /no server running/);
  assert.doesNotThrow(() => t.newSession(spawnReq(), () => ({ stdout: '', code: 0 })));
});

test('sendKeys does not press Enter when the text never landed', async () => {
  const t = await load('guard');
  // A bare Enter into a live pane submits whatever is sitting in the composer —
  // so a failed literal send must not be followed by one.
  const dead = recorder({ stdout: '', code: 1 });
  assert.equal(t.sendKeys('lead-gone', '[soma] ping', dead.run), false);
  assert.equal(dead.calls.length, 1);

  const live = recorder();
  assert.equal(t.sendKeys('lead-cr-1', '[soma] ping', live.run), true);
  assert.equal(live.calls.length, 2);
});

test('a missing pane target degrades instead of throwing', async () => {
  const t = await load('null-target');
  // lease.mjs stores `tmux_pane: null` for a notify-mode holder (wake:'notify'),
  // and the bus forwards `lease.tmux_pane` straight into sendKeys — so this is
  // a routine state. Dereferencing it would take the orchestrator down.
  for (const missing of [null, undefined, '']) {
    const keys = recorder();
    assert.equal(t.sendKeys(missing, 'x', keys.run), false);
    assert.equal(keys.calls.length, 0, 'nothing may reach tmux without a target');

    const cap = recorder();
    assert.equal(t.capturePane(missing, 40, cap.run), '');
    assert.equal(cap.calls.length, 0);
  }
});

test('sendKeys can deliver a message that starts with a dash', async () => {
  const t = await load('dash');
  // Without the `--`, tmux reads the text as flags ("unknown flag -h") and the
  // wake is dropped: a lead would go unwoken because a summary began with "-".
  const { calls, run } = recorder();
  t.sendKeys('lead-cr-1', '--force rebase now', run);
  assert.deepEqual(calls[0], ['send-keys', '-t', '=lead-cr-1:', '-l', '--', '--force rebase now']);
  assert.deepEqual(calls[1], ['send-keys', '-t', '=lead-cr-1:', 'Enter']);
});

test('capturePane returns the last N lines of content, not blank padding', async () => {
  const t = await load('capture');
  // A real capture is pane_height rows, blank-padded below the content: a lead
  // three lines in gives ~21 empty rows, so an unstripped tail is whitespace
  // and both `soma peek` and the death scene read as empty.
  const realistic = { stdout: ['booting lead-cr-1', 'harness: H3 TDD-LOOP', 'waiting for input', ...Array(21).fill('')].join('\n') + '\n', code: 0 };
  const { calls, run } = recorder(realistic);
  assert.equal(t.capturePane('lead-cr-1', 3, run), 'booting lead-cr-1\nharness: H3 TDD-LOOP\nwaiting for input');
  assert.deepEqual(calls[0], ['capture-pane', '-p', '-t', '=lead-cr-1:']);

  // The death scene tmux writes into a dead pane must survive the same path.
  const death = recorder({ stdout: ['npm ERR! test failed', '', 'Pane is dead (status 1, Wed Jul 29 20:37:49 2026)', ...Array(20).fill('')].join('\n') + '\n', code: 0 });
  assert.ok(t.capturePane('lead-cr-1', 40, death.run).endsWith('Pane is dead (status 1, Wed Jul 29 20:37:49 2026)'));

  assert.equal(t.capturePane('lead-cr-1', 40, recorder({ stdout: 'only\n', code: 0 }).run), 'only');
  assert.equal(t.capturePane('lead-cr-1', undefined, recorder({ stdout: 'x\n', code: 0 }).run), 'x'); // default 40
  assert.equal(t.capturePane('lead-gone', 40, () => ({ stdout: '', code: 1 })), '');                 // dead pane, no throw
  assert.equal(t.capturePane('lead-idle', 40, () => ({ stdout: '\n\n\n\n', code: 0 })), '');          // pane with nothing on it
});

test('killSession and setRemainOnExit report success', async () => {
  const t = await load('lifecycle');
  assert.equal(t.killSession('lead-cr-1', () => ({ stdout: '', code: 0 })), true);
  assert.equal(t.killSession('lead-gone', () => ({ stdout: '', code: 1 })), false);
  assert.equal(t.setRemainOnExit('lead-cr-1', () => ({ stdout: '', code: 0 })), true);
  assert.equal(t.setRemainOnExit('lead-gone', () => ({ stdout: '', code: 1 })), false);
});

test('listSessions names the live sessions and stays empty when the server is down', async () => {
  const t = await load('ls');
  const { calls, run } = recorder({ stdout: 'lead-cr-1\nlead-cr-10\nsoma-watchdog\n', code: 0 });
  assert.deepEqual(t.listSessions(run), ['lead-cr-1', 'lead-cr-10', 'soma-watchdog']);
  assert.deepEqual(calls[0], ['list-sessions', '-F', '#{session_name}']);   // no target: the whole server
  // `list-sessions` exits 1 with no output when no server is running: the
  // watchdog's aliveSessions() must read that as "nothing alive", not throw.
  assert.deepEqual(t.listSessions(() => ({ stdout: '', code: 1 })), []);
});

test('liveSessions is a PANE predicate: remain-on-exit means a session name is not liveness', async () => {
  const t = await load('live');
  // THE WHOLE REASON THIS EXISTS. `setRemainOnExit` keeps a dead lead's pane and session
  // alive on purpose — that IS the death scene the watchdog reads — so `has-session` and
  // `list-sessions` both report a DEAD lead as present. Reconcile against either and
  // `deadLeads` is empty forever: no LEAD_DEAD, no revival, and a lead that died in its
  // first minute holds its slot until an operator notices.
  const { calls, run } = recorder({
    stdout: 'soma-watchdog\t0\nlead-cr-1\t0\nlead-cr-2\t1\nlead-cr-3\t1\nlead-cr-3\t0\n',
    code: 0,
  });
  const live = t.liveSessions(run);
  assert.deepEqual(calls[0], ['list-panes', '-a', '-F', '#{session_name}\t#{pane_dead}']);
  assert.equal(calls.length, 1, 'one round trip per tick, not one per lead');
  assert.ok(live instanceof Set, 'reconcile refuses anything without .has, for prototype reasons');
  assert.equal(live.has('lead-cr-1'), true);
  assert.equal(live.has('lead-cr-2'), false, 'every pane dead is a dead lead');
  // A session with one dead pane and one live one is ALIVE. A lead's window can hold
  // teammate panes (remain-on-exit is set at window scope and covers them), and the
  // asymmetry of the two mistakes is not close: reading a live lead as dead makes this
  // tick kill its session and respawn over its work.
  assert.equal(live.has('lead-cr-3'), true);
  assert.deepEqual([...live].sort(), ['lead-cr-1', 'lead-cr-3', 'soma-watchdog']);
});

test('liveSessions answers null when tmux could not be read, and never invents a dead fleet', async () => {
  const t = await load('live-unreadable');
  // `null` is "we do not know", and it is NOT the same answer as an empty Set. A wedged
  // tmux hits the 5 s timeout in `defaultRun`, which reports `{stdout:'', code:1}` —
  // indistinguishable by output from a healthy server with nothing on it. Read as "no
  // sessions", that one hiccup makes every spawned row look dead at once, and the tick
  // then kills and respawns TEN LIVE LEADS. So the exit code decides, and a non-zero one
  // buys silence for a tick instead of a fleet-wide revival.
  assert.equal(t.liveSessions(() => ({ stdout: '', code: 1 })), null);
  assert.equal(t.liveSessions(() => ({ stdout: '', stderr: 'no server running on /tmp/x', code: 1 })), null);
  // Nor is a *timeout* distinguishable from "no server" by anything but the code, which
  // is why there is no string sniffing here. Both are unknown, and being unknown is safe:
  // the watchdog itself runs inside a tmux session, so a live tick that genuinely sees no
  // tmux server is a contradiction — it would have died with the server.
  assert.equal(t.liveSessions(() => ({ stdout: '', stderr: 'tmux killed by SIGKILL after 5000ms', code: 1 })), null);
  // Exit 0 with nothing listed is an empty Set, not null: that is a readable answer.
  const empty = t.liveSessions(() => ({ stdout: '\n', code: 0 }));
  assert.ok(empty instanceof Set);
  assert.equal(empty.size, 0);
});

test('liveSessions parses hostile pane listings without dropping a live lead', async () => {
  const t = await load('live-parse');
  // A session name may contain a tab, so the LAST tab separates the fields — the same
  // rejoin-rather-than-truncate rule `listPanes` uses for a pane title. Truncating at the
  // first tab would name a session nobody has and drop the real one from the live set,
  // which reads as a dead lead.
  const odd = t.liveSessions(() => ({ stdout: 'we\tird\t0\n', code: 0 }));
  assert.deepEqual([...odd], ['we\tird']);
  // `pane_dead` is `1` for dead and `0` for live, and ONLY the exact `1` counts as dead:
  // a format that stopped emitting the field, or emitted `false`, must fail toward alive.
  assert.deepEqual([...t.liveSessions(() => ({ stdout: 'lead-a\t\n', code: 0 }))], ['lead-a']);
  assert.deepEqual([...t.liveSessions(() => ({ stdout: 'lead-a\tfalse\n', code: 0 }))], ['lead-a']);
  assert.deepEqual([...t.liveSessions(() => ({ stdout: 'lead-a\t1\n', code: 0 }))], []);
  // A row with no separator at all cannot be attributed to a session and is skipped
  // rather than added under its own whole text.
  assert.deepEqual([...t.liveSessions(() => ({ stdout: 'garbage\nlead-a\t0\n', code: 0 }))], ['lead-a']);
  // An Object.prototype-named session is an ordinary member of a Set. `lead-` prefixes
  // them in practice, but this build has already shipped one registry that answered
  // truthy for every one of these, so the container is a Set here too.
  const proto = t.liveSessions(() => ({ stdout: 'constructor\t0\n__proto__\t0\ntoString\t1\n', code: 0 }));
  assert.equal(proto.has('constructor'), true);
  assert.equal(proto.has('__proto__'), true);
  assert.equal(proto.has('toString'), false);
  assert.equal(proto.has('valueOf'), false, 'membership is Set membership, not property lookup');
});

test('paneStates is one round trip per tick and keeps liveSessions\' argv untouched', async () => {
  const t = await load('panestates');
  // Beside `liveSessions`, never instead of it: its Set-of-names contract is pinned above and read
  // at six call sites in soma.mjs. This is the richer listing the pane census reads — what each
  // session's pane is RUNNING, which is the only thing that tells a bare shell from a lead.
  const { calls, run } = recorder({
    stdout: [
      'soma-watchdog\t%0\t1\t0\t4242\tnode\t',
      'lead-cr-1\t%3\t1\t0\t53105\t2.1.263\t✳ Claude Code',
      'lead-cr-2\t%5\t1\t0\t7955\tzsh\t',
      'lead-cr-3\t%7\t1\t1\t20820\tenv\t',
      '',
    ].join('\n'),
    code: 0,
  });
  const states = t.paneStates(run);
  assert.equal(calls.length, 1, 'one round trip per tick, not one per lead');
  assert.deepEqual(calls[0], ['list-panes', '-a', '-F',
    '#{session_name}\t#{pane_id}\t#{pane_active}\t#{pane_dead}\t#{pane_pid}\t#{pane_current_command}\t#{pane_title}']);
  assert.ok(states instanceof Map, 'a Map, never an object keyed by session name (reconcile.mjs\'s prototype reason)');
  assert.deepEqual(states.get('lead-cr-1'), {
    dead: false, cmd: '2.1.263', pid: 53105, title: '✳ Claude Code', pane_id: '%3', active: true,
    panes: [{ pane_id: '%3', active: true, dead: false, cmd: '2.1.263', pid: 53105, title: '✳ Claude Code' }],
  });
  // The three measured shapes: a live claude reads its VERSION STRING (the symlink target's
  // basename), a bare shell reads `zsh` with pane_dead=0, and a dead pane reads `env` (argv[0] of
  // the spawn command) with pane_dead=1 and an empty title.
  assert.equal(states.get('lead-cr-2').cmd, 'zsh');
  assert.equal(states.get('lead-cr-2').dead, false);
  assert.equal(states.get('lead-cr-3').dead, true);
  assert.equal(states.get('lead-cr-3').cmd, 'env');
  assert.equal(states.get('lead-cr-3').title, '');
  assert.equal(states.get('soma-watchdog').cmd, 'node');
  // A malformed pid is null, not NaN and not 0.
  assert.equal(t.paneStates(() => ({ stdout: 'lead-a\t%1\t1\t0\t\tzsh\t\n', code: 0 })).get('lead-a').pid, null);
});

test('paneStates answers null when tmux could not be read, and only the exact `1` is dead', async () => {
  const t = await load('panestates-null');
  // The `liveSessions` contract, for the same reason: a wedged server's 5 s timeout reports
  // `{stdout:'', code:1}`, byte-identical to an idle server, and an empty Map read as "every
  // lead absent" would let the census mark ten live leads dead in one tick. `null` is "not
  // measured", and the tick skips the census for one tick on it.
  assert.equal(t.paneStates(() => ({ stdout: '', code: 1 })), null);
  assert.equal(t.paneStates(() => ({ stdout: '', stderr: 'tmux killed by SIGKILL after 5000ms', code: 1 })), null);
  const empty = t.paneStates(() => ({ stdout: '\n', code: 0 }));
  assert.ok(empty instanceof Map);
  assert.equal(empty.size, 0, 'exit 0 with nothing listed is an empty Map: a readable answer');
  for (const [flag, dead] of [['1', true], ['0', false], ['', false], ['false', false], ['true', false]]) {
    assert.equal(t.paneStates(() => ({ stdout: `lead-a\t%1\t1\t${flag}\t1\tzsh\t\n`, code: 0 })).get('lead-a').dead, dead, `pane_dead=${JSON.stringify(flag)}`);
  }
});

test('paneStates keeps tabs inside a title, collapses a session to its ACTIVE pane, and skips unattributable rows', async () => {
  const t = await load('panestates-parse');
  // Title is the LAST field and is rejoined rather than truncated (the `listPanes` rule). The
  // session name is first and is split on the first tab: soma's own names are `lead-<id>`,
  // `orch` and `soma-watchdog`, none of which can carry a tab, and a foreign session that does
  // misparses into an entry nobody looks up.
  const odd = t.paneStates(() => ({ stdout: 'lead-a\t%1\t1\t0\t5\t2.1.263\tteam\tlead\n', code: 0 }));
  assert.equal(odd.get('lead-a').title, 'team\tlead');
  // Two panes in one session (a teammate split into the lead's window): the record's top-level
  // fields are the ACTIVE pane's, which is exactly the pane `capturePane('=name:')` reads, so the
  // metadata and the frame the classifier is handed describe the same pane by construction.
  const split = t.paneStates(() => ({
    stdout: 'lead-a\t%1\t0\t0\t5\t2.1.263\t✳ lead\nlead-a\t%2\t1\t0\t6\tzsh\t\n',
    code: 0,
  }));
  assert.equal(split.get('lead-a').pane_id, '%2');
  assert.equal(split.get('lead-a').cmd, 'zsh');
  assert.deepEqual(split.get('lead-a').panes.map((p) => p.pane_id), ['%1', '%2']);
  // No pane flagged active (should not happen; tmux always has one): the first row stands in.
  const none = t.paneStates(() => ({ stdout: 'lead-a\t%1\t0\t0\t5\t2.1.263\t✳ lead\nlead-a\t%2\t0\t0\t6\tzsh\t\n', code: 0 }));
  assert.equal(none.get('lead-a').pane_id, '%1');
  // A row with too few fields cannot be attributed and is skipped, never turned into a session.
  const garbage = t.paneStates(() => ({ stdout: 'garbage\nlead-a\t%1\t1\t0\t5\tzsh\t\n', code: 0 }));
  assert.deepEqual([...garbage.keys()], ['lead-a']);
  // Object.prototype-named sessions are ordinary Map members.
  const proto = t.paneStates(() => ({ stdout: 'constructor\t%1\t1\t0\t5\tzsh\t\n__proto__\t%2\t1\t0\t6\tnode\t\n', code: 0 }));
  assert.equal(proto.get('constructor').cmd, 'zsh');
  assert.equal(proto.get('__proto__').cmd, 'node');
  assert.equal(proto.has('toString'), false, 'membership is Map membership, not property lookup');
});

test('a listing tmux answered but not one row of which parses is "not measured", never an empty fleet (#45)', async () => {
  const t = await load('unparseable');
  // What tmux 3.6a printed, byte for byte, for a live lead to a client in `LANG=C` (no `-u`): the
  // tabs as `_`, and in the pane listing the title's `✳` too. Exit 0. Every row lacks its
  // separator, every row was skipped, and the answer was an EMPTY Set — "no lead has a live pane" —
  // which reconcile turns into LEAD_DEAD, a kill and a respawn for every spawned lead in one tick.
  const live = () => ({ stdout: 'soma-watchdog_0\nlead-cr-1_0\n', stderr: '', code: 0 });
  const panes = () => ({ stdout: 'lead-cr-1_%0_1_0_71101_sleep__ Claude Code\n', stderr: '', code: 0 });
  assert.equal(t.liveSessions(live), null, 'liveSessions read a listing it could not parse as an empty server');
  assert.equal(t.paneStates(panes), null, 'paneStates read a listing it could not parse as an empty server');

  // The controls, which are what make the two nulls above a rule rather than a new blanket answer.
  // An EMPTY listing on exit 0 is still a readable answer: a server with nothing on it.
  const empty = () => ({ stdout: '', stderr: '', code: 0 });
  assert.ok(t.liveSessions(empty) instanceof Set);
  assert.equal(t.liveSessions(empty).size, 0);
  assert.ok(t.paneStates(empty) instanceof Map);
  assert.equal(t.paneStates(empty).size, 0);
  // One row that parses keeps today's per-row skip: the listing WAS read, and the rows beside it
  // that do not parse corroborate nothing.
  assert.deepEqual([...t.liveSessions(() => ({ stdout: 'lead-cr-1_0\nlead-cr-2\t0\n', code: 0 }))], ['lead-cr-2']);
  assert.deepEqual([...t.paneStates(() => ({ stdout: 'lead-cr-1_%0_1_0_7_zsh_\nlead-cr-2\t%1\t1\t0\t8\tzsh\t\n', code: 0 })).keys()], ['lead-cr-2']);
  // And the backstop counts rows that PARSED, not rows that are live: a listing whose only row is a
  // dead pane is a measured server with no live session on it, never "not measured".
  const dead = t.liveSessions(() => ({ stdout: 'lead-cr-1\t1\n', code: 0 }));
  assert.ok(dead instanceof Set, 'a parsed dead pane is a reading, not an unreadable listing');
  assert.equal(dead.size, 0);
});

test('serverAbsent is true only for tmux\'s own two "no server answers on this socket" sentences', async () => {
  const t = await load('server-absent');
  // A machine that has never started soma's server: no socket FILE, so the connect is ENOENT.
  const never = recorder({ stdout: '', stderr: 'error connecting to /tmp/tmux-501/soma (No such file or directory)\n', code: 1 });
  assert.equal(t.serverAbsent(never.run), true, 'never started: no socket file at all');
  // One probe, against the whole server, and one that cannot start a server: `list-sessions`, never
  // `new-session`, which would bring up the very server it was asked about.
  assert.deepEqual(never.calls, [['list-sessions', '-F', '#{session_name}']]);
  // kill-server and a last-session exit both LEAVE the socket file behind, and a connect to a socket
  // file nobody listens on is ECONNREFUSED — tmux's other sentence for the same fact.
  assert.equal(t.serverAbsent(() => ({ stdout: '', stderr: 'no server running on /tmp/tmux-501/soma\n', code: 1 })), true, 'stale socket file');
  // Everything else is NOT a reading of "no server". False only means the caller keeps its
  // `unverified` third state, which is the safe direction for every one of these.
  for (const [what, r] of [
    ['a server that answered', { stdout: 'soma-watchdog\n', stderr: '', code: 0 }],
    ['the no-server words on an exit 0', { stdout: '', stderr: 'no server running on /tmp/x', code: 0 }],
    ["defaultRun's own timeout", { stdout: '', stderr: 'tmux killed by SIGKILL after 5000ms', code: 1 }],
    ['an empty stderr, which is what a missing binary leaves', { stdout: '', stderr: '', code: 1 }],
    ['a stub that reports no stderr at all', { stdout: '', code: 1 }],
    ['the words on stdout rather than stderr', { stdout: 'no server running on /tmp/x', code: 1 }],
    ['a socket it may not open', { stdout: '', stderr: 'error connecting to /tmp/tmux-501/soma (Permission denied)', code: 1 }],
    ['an unsafe socket directory', { stdout: '', stderr: 'directory /tmp/tmux-501 has unsafe permissions', code: 1 }],
    ['a server that died under the client', { stdout: '', stderr: 'server exited unexpectedly', code: 1 }],
    ['the words with another line after them', { stdout: '', stderr: 'no server running on /tmp/x\nlost server', code: 1 }],
    ['the words with another line before them', { stdout: '', stderr: 'warning\nerror connecting to /tmp/x (No such file or directory)', code: 1 }],
  ]) {
    assert.equal(t.serverAbsent(() => r), false, what);
  }
});

test('the no-server reading is serverAbsent\'s alone: liveSessions and paneStates still answer null for it', async () => {
  const t = await load('server-absent-split');
  // THE SPLIT IS BY CALLER, NOT BY STDERR. The watchdog's reconcile reads `liveSessions` and the
  // census reads `paneStates`, and "error connecting … (No such file or directory)" says only that
  // the socket FILE is missing — which is also what a LIVE server looks like after a /tmp cleaner
  // deletes its socket. An empty Set there reads every live lead as dead: LEAD_DEAD, a respawn whose
  // new-session starts a FRESH server, and two leads on one worktree. So both keep `null` ("skip
  // this tick") for both sentences, and only the CLI's human reports ask `serverAbsent`.
  for (const said of ['no server running on /tmp/tmux-501/soma', 'error connecting to /tmp/tmux-501/soma (No such file or directory)']) {
    const run = () => ({ stdout: '', stderr: `${said}\n`, code: 1 });
    assert.equal(t.liveSessions(run), null, `liveSessions on "${said}"`);
    assert.equal(t.paneStates(run), null, `paneStates on "${said}"`);
    assert.equal(t.serverAbsent(run), true, `serverAbsent on "${said}"`);
  }
});

test('tmuxProcessesOn finds a tmux by its OWN -L option, and by the whole name (#66)', async () => {
  const t = await load('server-processes-parse');
  const P = (pid, ...argv) => ({ pid, argv });
  const procs = [
    // What `ps` showed for a live server, measured: the argv of the client that started it.
    P(11, 'tmux', '-L', 'soma', 'new-session', '-d', '-s', 'soma-watchdog', 'sleep', '600'),
    P(12, 'tmux', '-Lsoma', 'new-session', '-d'),                // the value in the same word
    P(13, 'tmux', '-u', '-L', 'soma', 'new-session'),            // after another flag: soma's own calls
    P(14, '/usr/bin/tmux', '-L', 'soma', 'attach'),             // argv[0] a path
    P(15, 'tmux', '-f', '/dev/null', '-L', 'soma', 'ls'),        // after a flag that takes a value
    P(16, 'tmux', '-uL', 'soma', 'ls'),                         // grouped flags
    P(21, 'tmux', '-L', 'soma_pers', 'new-session'),            // another fleet's socket: NOT soma
    P(22, 'tmux', '-L', 'soma2', 'ls'),
    P(23, 'node', 'bin/soma.mjs', '-L', 'soma'),                // not tmux
    P(24, 'ssh', '-L', 'soma'),
    P(25, 'notmux', '-L', 'soma'),
    P(26, 'tmux', 'new-session', '-d', 'sh', '-c', 'x -L soma'),  // the COMMAND's words, not tmux's
    P(27, 'tmux', '--', 'new-session', '-L', 'soma'),
    P(28, 'tmux', 'ls'),                                        // the default socket
    P(29, 'tmux', '-L'),                                        // no value at all
    P(30, 'tmux', '-L', 'other', '-L', 'soma', 'ls'),           // the last -L wins, as in getopt
    P(31),                                                      // no argv: a kernel thread
    null,
  ];
  assert.deepEqual(t.tmuxProcessesOn(procs, 'soma'), [11, 12, 13, 14, 15, 16, 30]);
  assert.deepEqual(t.tmuxProcessesOn(procs, 'soma_pers'), [21]);
  assert.deepEqual(t.tmuxProcessesOn(procs, 'other'), [], 'overridden by a later -L');
  assert.deepEqual(t.tmuxProcessesOn(null, 'soma'), []);
});

test('parsePs reads `ps -axo pid=,uid=,command=` into pids, uids and words (#66)', async () => {
  const t = await load('parse-ps');
  const ps = [
    '    1     0 /sbin/launchd',
    '64311   501 tmux -f /dev/null -L soma new-session -d -s soma-watchdog sleep 600',
    '  777   502 /opt/homebrew/bin/tmux -L  soma_pers   attach',
    '',
    'not a row',
    '  888 ',
    '  889   501 ',                                   // a pid and a uid, and no command
    '  890 tmux -L soma ls',                          // no uid: not a row of this listing
  ].join('\n');
  assert.deepEqual(t.parsePs(ps), [
    { pid: 1, uid: 0, argv: ['/sbin/launchd'] },
    { pid: 64311, uid: 501, argv: ['tmux', '-f', '/dev/null', '-L', 'soma', 'new-session', '-d', '-s', 'soma-watchdog', 'sleep', '600'] },
    { pid: 777, uid: 502, argv: ['/opt/homebrew/bin/tmux', '-L', 'soma_pers', 'attach'] },
  ]);
  assert.deepEqual(t.tmuxProcessesOn(t.parsePs(ps), 'soma'), [64311]);
  assert.deepEqual(t.parsePs(''), []);
});

test('serverProcesses answers three ways: pids, none, or "the process table could not be read" (#66)', async () => {
  const t = await load('server-processes');
  const P = (pid, ...argv) => ({ pid, uid: process.getuid(), argv });
  const self = P(process.pid, 'node', '--test');
  const table = [self, P(11, 'tmux', '-L', 'soma', 'new-session'), P(12, 'tmux', '-L', 'soma_pers', 'ls')];
  assert.deepEqual(t.serverProcesses('soma', () => table), [11]);
  assert.deepEqual(t.serverProcesses('soma_pers', () => table), [12]);
  assert.deepEqual(t.serverProcesses('nobody', () => table), [], 'none found is an empty list, and it is what lets `up` start a server');
  // Every process found, not the first: a server and a client attached to it, or two servers on one
  // path. The refusal names each pid, because each may be the one to recover.
  assert.deepEqual(t.serverProcesses('soma', () => [...table, P(13, 'tmux', '-L', 'soma', 'attach')]), [11, 13]);
  // `null` is "cannot tell", which `up` refuses on. A table that could not be read is that — and so
  // is one without THIS process in it, because it is not a listing of this machine's processes: an
  // empty `ps`, or a /proc that is not procfs, would otherwise read as "no tmux anywhere".
  assert.equal(t.serverProcesses('soma', () => null), null);
  assert.equal(t.serverProcesses('soma', () => []), null, 'an empty table is not "none found"');
  assert.equal(t.serverProcesses('soma', () => [P(11, 'tmux', '-L', 'soma')]), null, 'a table without this process was not read whole');
  // The default socket is the module's own, the one every other call here talks to.
  assert.deepEqual(t.serverProcesses(undefined, () => [self, P(13, 'tmux', '-L', t.socketName(), 'ls')]), [13]);
});

test('serverProcesses counts only this user\'s tmux: another user\'s `-L soma` is another socket (#66)', async () => {
  const t = await load('server-processes-uid');
  const me = process.getuid();
  const other = me + 1;
  const P = (pid, uid, ...argv) => ({ pid, uid, argv });
  const self = P(process.pid, me, 'node', '--test');
  // A `-L` socket lives at <TMUX_TMPDIR>/tmux-<uid>/<name>, so another user's `tmux -L soma` is never
  // this user's socket. Counted, it would refuse this user's `up` for as long as it runs, on a shared
  // machine, naming a pid this user is not allowed to signal.
  const theirs = P(41, other, 'tmux', '-L', 'soma', 'new-session');
  const ours = P(42, me, 'tmux', '-L', 'soma', 'ls');
  assert.deepEqual(t.serverProcesses('soma', () => [self, theirs, ours]), [42], 'this user\'s, and not the other\'s');
  assert.deepEqual(t.serverProcesses('soma', () => [self, theirs]), [], 'another user\'s alone is none found');
  // A process whose owner did not read is not shown to be this user's, so it does not count either;
  // `listProcesses` leaves such a process out.
  assert.deepEqual(t.serverProcesses('soma', () => [self, P(43, undefined, 'tmux', '-L', 'soma')]), []);
  // THIS process must be in the table as this user. If it is not, the owners were not read, every
  // process looks like someone else's, and "none found" would start a server beside a live one.
  assert.equal(t.serverProcesses('soma', () => [P(process.pid, undefined, 'node'), ours]), null);
  assert.equal(t.serverProcesses('soma', () => [P(process.pid, other, 'node'), ours]), null);
  // The uid compared is the one given (`process.getuid()` by default); with none there is no telling.
  assert.deepEqual(t.serverProcesses('soma', () => [P(process.pid, other, 'node'), theirs, ours], other), [41]);
  assert.equal(t.serverProcesses('soma', () => [self, ours], null), null, 'no uid to compare is "cannot tell"');
});

test('listPanes keeps tabs inside a pane title and tolerates an empty listing', async () => {
  const t = await load('panes');
  const { calls, run } = recorder({ stdout: '0\t0\tteam\tlead\n', code: 0 });
  assert.deepEqual(t.listPanes('lead-cr-1', run), [{ index: 0, dead: false, title: 'team\tlead' }]);
  assert.deepEqual(calls[0], ['list-panes', '-s', '-t', '=lead-cr-1', '-F', '#{pane_index}\t#{pane_dead}\t#{pane_title}']);
  assert.deepEqual(t.listPanes('lead-gone', () => ({ stdout: '', code: 1 })), []);
});

test('production still talks to the soma socket; tests can point elsewhere', async (t_) => {
  const saved = process.env.SOMA_TMUX_SOCKET;
  t_.after(() => { if (saved === undefined) delete process.env.SOMA_TMUX_SOCKET; else process.env.SOMA_TMUX_SOCKET = saved; });

  delete process.env.SOMA_TMUX_SOCKET;
  const prod = await load('socket-default');
  // The single shared server is a design commitment (one inventory, one
  // failure domain) — nothing may quietly move soma off it.
  assert.deepEqual(prod.tmuxArgs(['has-session', '-t', '=lead-cr-1']), ['-L', 'soma', '-u', 'has-session', '-t', '=lead-cr-1']);

  process.env.SOMA_TMUX_SOCKET = 'soma-throwaway';
  const isolated = await load('socket-override');
  assert.deepEqual(isolated.tmuxArgs(['kill-session']), ['-L', 'soma-throwaway', '-u', 'kill-session']);

  process.env.SOMA_TMUX_SOCKET = '';             // an empty override is not an override
  assert.equal((await load('socket-empty')).tmuxArgs([])[1], 'soma');
});

test('every tmux call carries -u, so a listing parses the same whatever the caller\'s locale (#45)', async () => {
  const t = await load('utf8-flag');
  // Measured, tmux 3.6a: a client that does not believe it is in a UTF-8 locale (it reads the first
  // of LC_ALL, LC_CTYPE and LANG that is set) prints every non-printable byte of a format's output
  // as `_` — the TAB that separates `liveSessions`' and `paneStates`' fields included — and still
  // exits 0. The watchdog runs under `env -i` with LANG and no LC_*, so `LANG=C`, or a locale that
  // came from LC_ALL alone, was enough to read every live lead as dead. `-u` makes the client UTF-8
  // whatever the environment says. On EVERY call, `soma attach` included: there it makes tmux draw
  // UTF-8 to the operator's terminal, which is what a lead's pane holds in any case.
  const argv = t.tmuxArgs(['list-panes', '-a']);
  assert.deepEqual(argv, ['-L', t.socketName(), '-u', 'list-panes', '-a']);
  // The socket stays at index 1: this file, spawn.test.mjs and the bus smoke test read it there.
  assert.equal(t.tmuxArgs([])[1], t.socketName());
});

// The default run() is the only code path that touches the OS; exercise it with
// read-only probes (neither starts a session) when tmux is installed. Both OS
// tests run on a throwaway socket, so `npm test` never touches a live fleet's.
const tmuxInstalled = spawnSync('tmux', ['-V']).status === 0;
const TEST_SOCKET = `soma-test-${process.pid}`;

test('defaultRun reports a failing tmux instead of throwing, and keeps its noise off the terminal', { skip: !tmuxInstalled && 'tmux not installed' }, async (t_) => {
  const saved = process.env.SOMA_TMUX_SOCKET;
  process.env.SOMA_TMUX_SOCKET = TEST_SOCKET;    // inherited by the child spawned below
  t_.after(() => { if (saved === undefined) delete process.env.SOMA_TMUX_SOCKET; else process.env.SOMA_TMUX_SOCKET = saved; });
  const t = await load('default-run');
  const absent = `soma-absent-${process.pid}`;
  // execFileSync throws on a nonzero exit; the wrapper has to hand back a code,
  // because "this session is gone" is ordinary control flow for the watchdog.
  const r = t.defaultRun(['has-session', '-t', `=${absent}`]);
  assert.equal(r.code, 1);
  assert.equal(typeof r.stdout, 'string');
  assert.equal(typeof r.stderr, 'string');       // whatever tmux complained about, captured not printed

  // hasSession is polled every tick; tmux's "can't find session" must never
  // reach the operator's stderr, so run it in a child and look at what leaked.
  const url = new URL('../bin/lib/tmux.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['-e',
    `import(${JSON.stringify(url)}).then((m) => process.stdout.write(String(m.hasSession(${JSON.stringify(absent)}))))`,
  ], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, 'false');
  assert.equal(child.stderr, '', 'tmux errors must be captured, not inherited');
});

test('against a real tmux: the transcript path, the wake, and a wedged server', { skip: !tmuxInstalled && 'tmux not installed' }, async (t_) => {
  const saved = process.env.SOMA_TMUX_SOCKET;
  process.env.SOMA_TMUX_SOCKET = TEST_SOCKET;    // a throwaway server: never the operator's live fleet
  t_.after(() => { if (saved === undefined) delete process.env.SOMA_TMUX_SOCKET; else process.env.SOMA_TMUX_SOCKET = saved; });
  const t = await load('integration');
  assert.equal(t.tmuxArgs([])[1], TEST_SOCKET, 'the integration test must not run on the production socket');
  const name = `soma-selftest-${process.pid}`;
  // Everything a stub cannot prove: that tmux accepts these vectors, that the
  // transcript lands at the exact path, and that a wedged tmux gives up.
  const dir = mkdtempSync(join(tmpdir(), 'soma smoke '));
  // `#` and `%` are tmux format sequences, the space and quote are shell metachars.
  const logPath = join(dir, "lead #1 100% it's.log");
  // Filled in once the server is up; neither the last session dying nor
  // kill-server unlinks the socket file, so the throwaway one goes with us
  // rather than littering /tmp with one dead socket per test run.
  let socketPath = '';
  t_.after(() => {
    t.killSession(name);
    if (socketPath.includes(TEST_SOCKET)) rmSync(socketPath, { force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  try {
    // `-f /dev/null` on the call that STARTS the server, the only one that reads a config: the
    // operator's ~/.tmux.conf may load plugins that restore and save sessions, and a throwaway
    // server must run none of them. tmux takes the flag anywhere before the command, so it rides `run`.
    t.newSession({ name, cwd: dir, env: { PATH: process.env.PATH, HOME: process.env.HOME }, argv: ['sh', '-c', 'echo BIRTH-LINE; cat'], logPath },
      (args) => t.defaultRun(['-f', '/dev/null', ...args]));
  } catch (e) {
    // A pty-exhausted host ("fork failed: Device not configured") is an OS
    // limit, not a regression — do not fail the fleet's build over it.
    return t_.skip(`tmux could not start a session here: ${e.message}`);
  }

  const until = async (what, fn, ms = 4000) => {
    for (const deadline = Date.now() + ms; Date.now() < deadline;) {
      if (fn()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail(`timed out waiting for ${what}`);
  };

  socketPath = t.defaultRun(['display-message', '-p', '#{socket_path}']).stdout.trim();
  assert.ok(socketPath.endsWith(TEST_SOCKET), `expected a throwaway socket, got ${socketPath}`);
  assert.equal(t.hasSession(name), true);
  assert.ok(t.listSessions().includes(name));
  // The transcript exists at exactly the path asked for — not at a hostname-
  // and-year-expanded neighbour, and not nowhere.
  await until('the transcript to reach the exact path', () => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('BIRTH-LINE'));

  // A wake whose text starts with `-` still lands in the pane.
  assert.equal(t.sendKeys(name, '--force [soma] ping'), true);
  await until('the wake to appear in the pane', () => t.capturePane(name, 40).includes('--force [soma] ping'));
  // ...and the capture is content, not the pane's blank padding.
  const tail = t.capturePane(name, 40);
  assert.ok(!tail.endsWith('\n'), 'trailing blank rows must be stripped');
  assert.ok(tail.split('\n').length <= 40);

  // A wedged tmux must not hang the synchronous watchdog: `wait-for` blocks on
  // a channel nothing will ever signal. Short timeout here; production takes 5s.
  const started = Date.now();
  const wedged = t.defaultRun(['wait-for', `soma-never-signalled-${process.pid}`], { timeout: 400 });
  assert.equal(wedged.code, 1);
  assert.ok(Date.now() - started < 3000, `should have been killed at ~400ms, took ${Date.now() - started}ms`);
  assert.match(wedged.stderr, /killed by SIG/);  // and says so, so newSession's throw is diagnosable

  assert.equal(t.killSession(name), true);
  assert.equal(t.hasSession(name), false);
});

test('against a real tmux: serverAbsent reads a never-started and a killed server as absent, a running one as present', { skip: !tmuxInstalled && 'tmux not installed' }, async (t_) => {
  // A sandbox of its own, not only a socket name: TMUX_TMPDIR moves the directory tmux keeps every
  // socket in, so not even a mistyped name could reach a live fleet's server. Both are set BEFORE the
  // import — tmux.mjs reads SOMA_TMUX_SOCKET at load — and both reach the tmux child through the
  // inherited environment.
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  const sock = `soma-absent-${process.pid}`;
  const saved = { SOMA_TMUX_SOCKET: process.env.SOMA_TMUX_SOCKET, TMUX_TMPDIR: process.env.TMUX_TMPDIR };
  process.env.SOMA_TMUX_SOCKET = sock;
  process.env.TMUX_TMPDIR = dir;
  // The cleanup names the sandbox itself rather than going through the module, so it cannot reach
  // any other server whatever state the module ended up in.
  const sandbox = (args) => spawnSync('tmux', ['-L', sock, ...args], { encoding: 'utf8', env: { ...process.env, TMUX_TMPDIR: dir } });
  t_.after(() => {
    sandbox(['kill-server']);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(dir, { recursive: true, force: true });
  });
  const t = await load('server-absent-real');
  assert.equal(t.tmuxArgs([])[1], sock, 'this test must not run on the production socket');
  const said = () => t.defaultRun(['list-sessions', '-F', '#{session_name}']).stderr.trim();

  // Never started: no socket file, so tmux says "error connecting to … (No such file or directory)".
  assert.equal(t.serverAbsent(), true, `never started — tmux said: ${said()}`);
  // ...while the watchdog's own reading of the very same thing stays "not measured".
  assert.equal(t.liveSessions(), null);

  // `-f /dev/null` on the call that starts the server, for the reason the test above gives.
  const up = t.defaultRun(['-f', '/dev/null', 'new-session', '-d', '-s', `soma-absent-probe-${process.pid}`, 'cat']);
  // A pty-exhausted host is an OS limit, not a regression (the same allowance as the test above).
  if (up.code !== 0) return t_.skip(`tmux could not start a session here: ${up.stderr.trim()}`);
  assert.equal(t.serverAbsent(), false, 'a running server is not absent');
  const socketPath = t.defaultRun(['display-message', '-p', '#{socket_path}']).stdout.trim();
  assert.ok(socketPath.startsWith(realpathSync(dir)), `expected a socket inside the sandbox, got ${socketPath}`);

  // kill-server: the server is gone, its socket file stays behind (measured on 3.6a), and a connect
  // to it is refused — tmux's OTHER sentence, "no server running on …".
  assert.equal(t.defaultRun(['kill-server']).code, 0);
  assert.equal(t.serverAbsent(), true, `after kill-server — tmux said: ${said()}`);
  if (existsSync(socketPath)) assert.match(said(), /^no server running on /, 'a stale socket file must be the path this exercised');
});

test('against a real tmux, from a shell with no UTF-8 locale: both listings still see a live session (#45)', { skip: !tmuxInstalled && 'tmux not installed' }, async (t_) => {
  // Issue #45's shell, reproduced rather than described, in a CHILD process: `tmux.mjs` reads its
  // socket once at load, and the locale that matters is the tmux client's, which inherits the
  // child's environment. That environment is this one minus LC_ALL and LC_CTYPE, with LANG=C — the
  // watchdog's own shape, which forwards LANG and no LC_* — and minus TMUX: measured, a client that
  // sees $TMUX treats itself as UTF-8 whatever LANG says, so a suite run from inside a tmux pane
  // would not reproduce the bug with it. (The watchdog has no $TMUX: `env -i` drops it.)
  //
  // The sandbox is under /tmp rather than `tmpdir()`: a Unix socket path is limited to about 104
  // bytes on macOS, and a long TMPDIR pushes `<dir>/tmux-<uid>/<socket>` past it (issue #46).
  const dir = mkdtempSync('/tmp/st-');
  const sock = `sl-${process.pid}`;
  const env = { ...process.env, LANG: 'C', TMUX_TMPDIR: dir, SOMA_TMUX_SOCKET: sock };
  for (const k of ['LC_ALL', 'LC_CTYPE', 'TMUX', 'TMUX_PANE']) delete env[k];
  // The sandbox's own spelling, for setup, the control and teardown — never the module under test,
  // so the cleanup cannot reach another server whatever the module does.
  const sandbox = (args) => spawnSync('tmux', ['-L', sock, ...args], { encoding: 'utf8', env });
  t_.after(() => {
    sandbox(['kill-server']);
    rmSync(dir, { recursive: true, force: true });
  });
  // `-f /dev/null` on the call that starts the server, for the reason the integration test gives.
  const up = sandbox(['-f', '/dev/null', 'new-session', '-d', '-s', 'lead-cr-1', 'sleep 600']);
  assert.equal(up.status, 0, `the sandbox server must start: ${up.stderr}`);
  assert.equal(env.TMUX_TMPDIR, dir, 'the child must reach the sandbox, not the default socket directory');
  assert.equal(env.SOMA_TMUX_SOCKET, sock, 'the child must talk to the sandbox socket, never a live fleet\'s');

  // THE CONTROL: this environment reproduces the defect. Without it, a tmux that stopped mangling
  // the tab would leave the assertions below green for a reason that has nothing to do with soma.
  const raw = sandbox(['list-panes', '-a', '-F', '#{session_name}\t#{pane_dead}']);
  assert.equal(raw.stdout, 'lead-cr-1_0\n', 'a C-locale client must print the tab as `_` here, or this test measures nothing');

  const url = new URL('../bin/lib/tmux.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['-e',
    `import(${JSON.stringify(url)}).then((m) => { const l = m.liveSessions(); const p = m.paneStates();`
    + ' process.stdout.write(JSON.stringify({ socket: m.socketName(), live: l && [...l], panes: p && [...p.keys()] })); })',
  ], { encoding: 'utf8', env });
  assert.equal(child.status, 0, child.stderr);
  const got = JSON.parse(child.stdout);
  assert.equal(got.socket, sock);
  assert.deepEqual(got.live, ['lead-cr-1'], 'liveSessions read a live session as absent (or as unmeasured)');
  assert.deepEqual(got.panes, ['lead-cr-1'], 'paneStates read a live session as absent (or as unmeasured)');
});

test('against a real tmux: serverProcesses finds a live server by its -L name — still, once its socket file is gone (#66)', { skip: !tmuxInstalled && 'tmux not installed' }, async (t_) => {
  // A sandbox of its own (the serverAbsent test's shape): TMUX_TMPDIR and the socket set BEFORE the
  // import, because tmux.mjs reads SOMA_TMUX_SOCKET at load. Under /tmp for the socket path limit
  // (#46). The scan reads the real process table, so the name is unique to this process: a scan
  // for `soma` on a machine running a fleet would find that fleet's server, correctly.
  const dir = mkdtempSync('/tmp/st-');
  const sock = `sp-${process.pid}`;
  const saved = { SOMA_TMUX_SOCKET: process.env.SOMA_TMUX_SOCKET, TMUX_TMPDIR: process.env.TMUX_TMPDIR };
  process.env.SOMA_TMUX_SOCKET = sock;
  process.env.TMUX_TMPDIR = dir;
  const sandbox = (args) => spawnSync('tmux', ['-L', sock, ...args], { encoding: 'utf8', env: { ...process.env, TMUX_TMPDIR: dir } });
  let pid = null;
  const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
  t_.after(() => {
    sandbox(['kill-server']);
    // Once its socket file is gone, kill-server cannot reach it: the server goes by its pid, which
    // was read from the sandbox's own `display-message`, so it can only be the sandbox server.
    if (pid !== null && alive(pid)) process.kill(pid, 'SIGKILL');
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(dir, { recursive: true, force: true });
  });
  const t = await load('server-processes-real');
  assert.equal(t.socketName(), sock, 'this test must not scan for the production socket');
  const up = sandbox(['-f', '/dev/null', 'new-session', '-d', '-s', 'probe', 'sleep 600']);
  assert.equal(up.status, 0, `the sandbox server must start: ${up.stderr}`);
  pid = Number(sandbox(['display-message', '-p', '#{pid}']).stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 0, 'the server pid, from the server itself');

  assert.deepEqual(t.serverProcesses(), [pid], 'the sandbox server, by pid, and nothing else');
  // Found as this user's: the owner the real process table gives the server is the uid the scan keeps.
  assert.equal(t.listProcesses().find((p) => p.pid === pid)?.uid, process.getuid(), 'the server reads as this user\'s');
  assert.deepEqual(t.serverProcesses(`${sock}x`), [], 'a longer name is another socket');
  assert.deepEqual(t.serverProcesses(sock.slice(0, -1)), [], 'and so is a prefix: `soma` is not `soma_pers`');

  // The state #66 is about, made rather than described: the socket FILE deleted under a live server.
  const socketPath = sandbox(['display-message', '-p', '#{socket_path}']).stdout.trim();
  assert.ok(socketPath.endsWith(`/${sock}`), `expected the sandbox socket, got ${socketPath}`);
  rmSync(socketPath);
  assert.equal(t.serverAbsent(), true, 'tmux now says no server answers on the socket');
  assert.equal(alive(pid), true, 'while the server is alive');
  assert.deepEqual(t.serverProcesses(), [pid], 'and the scan still finds it — what `soma up` asks before it starts a second one');

  // The control: once the server is really gone, the same scan finds nothing.
  process.kill(pid, 'SIGTERM');
  for (const deadline = Date.now() + 4000; alive(pid) && Date.now() < deadline;) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(pid), false, 'the sandbox server did not exit on SIGTERM');
  pid = null;                                      // gone: the cleanup must never signal a reused pid
  assert.deepEqual(t.serverProcesses(), [], 'a server that is gone is not found');
});
