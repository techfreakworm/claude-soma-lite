/**
 * `bin/soma.mjs` — the operator's whole interface to the fleet.
 *
 * Every test here drives the exported `dispatch(argv, deps)` with recorded effects. Two
 * rules of the file, both learned from sibling modules rather than invented:
 *
 * - **The guarded deps have no defaults**, so a test that forgets one gets a TypeError
 *   naming it instead of a real `tmux new-session`, a real `claude mcp add` against the
 *   operator's own `~/.claude.json`, or a real detached `claude`. Same refusal, for the
 *   same reason, as `spawn.checkDeps` and `soma-watchdog`'s `checkDeps`.
 * - **An assertion that cannot fail is labelled as documentation**, naming why and which
 *   assertion carries the weight instead — see `queue.test.mjs` for the precedent. An
 *   assertion count is a claim about how many measurements were taken.
 */
import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A throwaway tmux socket, set BEFORE `tmux.mjs` is first loaded — which is why both imports
 * below are dynamic: `tmux.mjs` reads `$SOMA_TMUX_SOCKET` into a module-level const at load
 * time, and `soma.mjs` imports it, so a static `import` here would win the race and pin the
 * default. Two things depend on that ordering. It makes `tmuxArgs`' socket DISTINGUISHABLE from
 * the literal `'soma'`, so an arm that re-spelled it is a measurable difference rather than an
 * equivalent one. And it means that if a future arm ever shells out to a real tmux from this
 * suite, it reaches a socket nobody's fleet is on.
 */
process.env.SOMA_TMUX_SOCKET = 'soma-t24-cli-test';
const tmux = await import('../bin/lib/tmux.mjs');
const { dispatch, realDeps, GUARDED_DEPS, USAGE, WATCHDOG_ENV_ALLOW } = await import('../bin/soma.mjs');
// Dynamic for the same load-order reason as the imports above: spawn.mjs pulls in tmux.mjs.
const { ENV_ALLOW } = await import('../bin/lib/spawn.mjs');
// The clock the `seats:` line renders with — imported so a test can use the already-pinned
// formatter as its oracle instead of re-deriving a local-time string.
const { clock } = await import('../bin/lib/seats-summary.mjs');
// The launch bound `status` reads a starting lead by — the same one the watchdog's reconcile and
// `soma_status` read — so the tests below sit on either side of it rather than of a copy.
const { LAUNCH_GRACE_MS } = await import('../bin/lib/fleet.mjs');

const CLI = fileURLToPath(new URL('../bin/soma.mjs', import.meta.url));

/** A throwaway state root per test. Every path helper reads `$SOMA_HOME` lazily. */
const root = (t) => {
  const prev = process.env.SOMA_HOME;
  const home = mkdtempSync(join(tmpdir(), 'soma-cli-'));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (prev === undefined) delete process.env.SOMA_HOME; else process.env.SOMA_HOME = prev;
  });
  process.env.SOMA_HOME = home;
  return home;
};

/**
 * A complete stub dep set: every guarded name present, every one recording rather than
 * doing. `over` replaces individual entries.
 *
 * `calls` is shared with the caller so a test can assert *what* was asked for, and the
 * defaults here are the inert answers — `liveSessions` sees nothing, `confirm` says no,
 * `linkProbe` says the volume is fine — so an arm that is supposed to stop cannot pass by
 * accidentally getting a permissive stub.
 */
const mk = (over = {}, { answer = false } = {}) => {
  const out = [];
  const err = [];
  const calls = {
    newSession: [], killSession: [], sendKeys: [], capturePane: [], resumeLead: [],
    exec: [], capture: [], confirm: [], installSkill: [], setTaskStatus: [],
    enqueue: [], appendEvent: [], heartbeat: [], clearBackpressure: [],
    // The seat a resume picked, the options the spawner got, and every fleet the store was asked
    // to mutate — so a test can read the row a `resume` wrote without a real checkpoint.
    resumeOpts: [], pickSeat: [], updateFleet: [],
    // One entry per process-table scan `up` made, so a test can tell "found nothing" from "never looked".
    serverProcesses: [],
  };
  const deps = {
    print: (s) => out.push(String(s)),
    warn: (s) => err.push(String(s)),
    liveSessions: () => new Set(),
    // Asked only about a `null` listing, by `status`, `down` and `up`. `false` is the inert answer: it
    // claims nothing about the server, so a `null` keeps its `unverified` reading, `down` keeps its
    // exit 3 and `up` refuses — the arms that read "no server" hand over `() => true` themselves.
    serverAbsent: () => false,
    // No tmux process for soma's socket. Never the real scan, on purpose: on a machine running a
    // fleet it finds that fleet's server, and every `up` test would then refuse for a reason that is
    // the machine's, not the test's. Asked only by `up`, after a "no server" from `serverAbsent`.
    serverProcesses: () => { calls.serverProcesses.push(1); return []; },
    // The pane census's listing: `null` is the inert answer ("not measured"), so `status` prints
    // `?` in the PANE column and `send` refuses to type blind — the arms about panes hand over
    // an explicit listing (`panesFor`).
    paneStates: () => null,
    newSession: (spec) => { calls.newSession.push(spec); },
    killSession: (name) => { calls.killSession.push(name); return true; },
    sendKeys: (target, text) => { calls.sendKeys.push({ target, text }); return true; },
    // The idle composer (frame 006), so a pane read through the default classifies as a live idle
    // lead — the reading under which every arm behaves as it did before the pane gate existed.
    capturePane: (target, lines) => { calls.capturePane.push({ target, lines }); return IDLE_FRAME; },
    resumeLead: (task, opts) => { calls.resumeLead.push(task); calls.resumeOpts.push(opts); return { session_uuid: task.lead_session_uuid }; },
    exec: (cmd, args) => { calls.exec.push({ cmd, args }); },
    // Readable by default, because `init` READS THE REGISTRATION BACK: a stub that answered an
    // empty stdout would make every init test fail on the verification rather than on its subject.
    capture: (cmd, args) => { calls.capture.push({ cmd, args }); return { stdout: 'soma: node /abs/bin/soma-bus.mjs', stderr: '', code: 0 }; },
    doctor: async () => true,
    canary: async () => true,
    // The ANSWER is a parameter, not an override, so a test can vary it and still count the
    // prompts. Overriding `confirm` wholesale would silently replace this recorder — and then
    // "exactly one prompt, before anything starts" would read 0 and pass for the wrong reason.
    confirm: (q) => { calls.confirm.push(q); return answer; },
    linkProbe: () => ({ ok: true, code: null, dir: '/state' }),
    installSkill: (cfgRoot) => { calls.installSkill.push(cfgRoot); return { ok: true, dest: '/claude/skills/soma-promote' }; },
    loadConfig: () => ({ max_leads: 10, budgets: { standard: { tokens_cap: 20000000 } } }),
    readFleet: () => ({ tasks: [] }),
    enqueue: (tasks) => { calls.enqueue.push(tasks); return { queued: tasks.map((x) => x.id), skipped: [] }; },
    setTaskStatus: (id, status) => { calls.setTaskStatus.push({ id, status }); },
    readUsage: () => ({}),
    readLease: () => null,
    heartbeat: (sid) => { calls.heartbeat.push(sid); },
    appendEvent: (stream, ev) => { calls.appendEvent.push({ stream, ev }); return { id: '1', ts: 1 }; },
    readEvents: () => [],
    queuePaused: () => false,
    // The seat pool: no seats configured is the inert answer, so `status` prints one line and
    // the seat arms hand over their own summaries.
    seatsSummary: () => ({ configured: 0, open: [], closed: [], unverified: [], unreadable: false, why: null }),
    // The freeze record, as `soma_status` reads it: no record is the inert answer. Recorded, so the
    // thaw tests can assert the one action was taken exactly once — or not at all.
    backpressureState: () => ({ active: false }),
    clearBackpressure: () => { calls.clearBackpressure.push(1); return { active: false }; },
    readFile: () => '[]',
    // No seat is ever open unless a test says so — an arm that should refuse cannot pass on a
    // permissive stub — and the store hands the mutation the fleet `readFleet` answers, keeping
    // what it mutated.
    pickSeat: (now, cfg) => { calls.pickSeat.push([now, cfg]); return null; },
    updateFleet: (mutate) => { const live = deps.readFleet(); const result = mutate(live); calls.updateFleet.push(live); return result; },
    ...over,
  };
  return { deps, out, err, calls, stdout: () => out.join('\n'), stderr: () => err.join('\n') };
};

/** A `tmux.paneStates()` record for a live claude pane — `pane_current_command` is the version string, measured. */
const pane = (over = {}) => ({
  dead: false, cmd: '2.1.263', pid: 1, title: '✳ Claude Code', pane_id: '%9', active: true,
  panes: [{ pane_id: '%9', dead: false, cmd: '2.1.263', pid: 1, title: '✳ Claude Code', active: true }],
  ...over,
});
const RULE = '─'.repeat(80);
/** frame 006: the idle composer, on the lines the classifier reads. */
const IDLE_FRAME = [RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'].join('\n');
/** frame 191: an interrupted turn's text back in the composer, never submitted. */
const DRAFT_FRAME = [RULE, '❯ Use the AskUserQuestion tool once to ask me a single question: "Which', '  colour?" with options Red and Blue.', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n');
/** frame 138: the permission dialog. */
const PROMPT_FRAME = [RULE, ' Bash command', '', '   │ cd /w/a && grep -n x somefile.txt', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel · Tab to amend'].join('\n');
/** An AskUserQuestion frame (2.1.263): the live dialog's layout with neutral words, descriptions shortened. */
const QUESTION_FRAME = ['│ May I update the README?', '', '❯ 1. Yes — update the README', '  2. Yes, but show me the diff first', '  3. Not yet — leave the README', '  4. Type something.', RULE, '  5. Chat about this', '', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel'].join('\n');
/**
 * Every named session is a live claude pane, so `send`'s gate stands aside. Only the listing:
 * `mk()`'s own `capturePane` stays in place because it RECORDS, and the arms about peeking read
 * that record; its default frame classifies as idle.
 */
const panesFor = (...names) => ({ paneStates: () => new Map(names.map((n) => [n, pane()])) });

/**
 * A `liveSessions` that sees nothing on the idempotency read and the watchdog on the read-back.
 *
 * `up` asks twice for different reasons — "is one already running" and "did the one I just
 * started survive" — and a stub that answered the same both times could only exercise one of
 * the two paths.
 */
const startsClean = () => {
  let n = 0;
  return () => (++n === 1 ? new Set() : new Set(['soma-watchdog']));
};

/** The real-tmux tests below run wherever tmux is installed, and skip only where it is not. */
const tmuxInstalled = spawnSync('tmux', ['-V']).status === 0;

/**
 * A REAL tmux server in a sandbox of its own, read the way a shell with no UTF-8 locale reads it:
 * issue #45's operator, whose `soma resume` from such a shell killed a live lead and resumed it.
 *
 * `run` is the transport `tmux.mjs`' readers take, and it executes `tmux` with `tmux.tmuxArgs`, so
 * whatever the module puts on every call rides along exactly as in production. Its environment is
 * this process's minus LC_ALL, LC_CTYPE and TMUX, with LANG=C: tmux decides UTF-8 from the first of
 * the three locale variables that is set, and (measured) treats any client that sees $TMUX as UTF-8,
 * so a suite run from inside a tmux pane would not reproduce the bug without dropping it.
 *
 * The socket is `tmux.socketName()`, because this file pins SOMA_TMUX_SOCKET before `tmux.mjs`
 * loads and `tmuxArgs` names nothing else. It is unique all the same: TMUX_TMPDIR is a fresh
 * directory, under /tmp because a Unix socket path is limited to about 104 bytes on macOS (#46),
 * and no other server lives in it. Setup, the control and teardown use the sandbox's own `-L`.
 */
const cLocaleTmux = (t, ...sessions) => {
  const dir = mkdtempSync('/tmp/st-');
  const env = { ...process.env, LANG: 'C', TMUX_TMPDIR: dir };
  for (const k of ['LC_ALL', 'LC_CTYPE', 'TMUX', 'TMUX_PANE']) delete env[k];
  const sandbox = (args) => spawnSync('tmux', ['-L', tmux.socketName(), ...args], { encoding: 'utf8', env });
  t.after(() => {
    sandbox(['kill-server']);
    rmSync(dir, { recursive: true, force: true });
  });
  sessions.forEach((name, i) => {
    // `-f /dev/null` on the call that starts the server: an operator's ~/.tmux.conf may load
    // plugins that save and restore sessions, and a throwaway server must run none of them.
    const r = sandbox([...(i === 0 ? ['-f', '/dev/null'] : []), 'new-session', '-d', '-s', name, 'sleep 600']);
    assert.equal(r.status, 0, `the sandbox server must start ${name}: ${r.stderr}`);
  });
  // The control: this shell really does mangle the listing, or a test built on it measures nothing.
  const raw = sandbox(['list-panes', '-a', '-F', '#{session_name}\t#{pane_dead}']).stdout;
  assert.ok(raw.includes(`${sessions[0]}_0`), `a C-locale client must print the tab as "_" here; it printed ${JSON.stringify(raw)}`);
  const run = (args) => {
    const r = spawnSync('tmux', tmux.tmuxArgs(args), { encoding: 'utf8', env, timeout: 5000 });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
  };
  const alive = (name) => sandbox(['has-session', '-t', `=${name}`]).status === 0;
  return { run, alive };
};

// --------------------------------------------------------------------------- status

test('status renders a row per lead', async (t) => {
  root(t);
  const h = mk({
    readFleet: () => ({ tasks: [{ id: 'cr-1', status: 'spawned', lead_session_uuid: 'u1' }] }),
    liveSessions: () => new Set(['lead-cr-1']),
    readUsage: () => ({ turns: 2, est_tokens: 100, last_model: 'claude-fable-5' }),
  });
  assert.equal(await dispatch(['status'], h.deps), 0);
  const s = h.stdout();
  assert.match(s, /\bcr-1\b/);
  assert.match(s, /\bspawned\b/);
  assert.match(s, /\b2\b/);
  assert.match(s, /100/);
  assert.match(s, /claude-fable-5/);
});

test('the LIVE column reads panes, never session names, and says so when it could not measure', async (t) => {
  root(t);
  const fleet = () => ({ tasks: [{ id: 'cr-1', status: 'spawned', lead_session_uuid: 'u1' }] });
  const row = (s) => s.split('\n').find((l) => l.startsWith('cr-1'));

  // `remain-on-exit` keeps a dead lead's session — and its NAME — alive on purpose: that pane
  // is the death scene the watchdog reads. So `hasSession('lead-cr-1')` is true for a lead that
  // died in its first minute, and a LIVE column built on it reports every corpse as running.
  // `liveSessions()` is the only primitive that tells the two apart (`#{pane_dead}`).
  const dead = mk({ readFleet: fleet, liveSessions: () => new Set(['other']) });
  await dispatch(['status'], dead.deps);
  assert.match(row(dead.stdout()), /\bdead\b/);

  const live = mk({ readFleet: fleet, liveSessions: () => new Set(['lead-cr-1']) });
  await dispatch(['status'], live.deps);
  assert.match(row(live.stdout()), /\byes\b/);

  // A wedged tmux hits the 5 s timeout and reports `{stdout:'', code:1}` — byte-identical to a
  // healthy server with nothing on it. `liveSessions` answers `null` for that, and rendering it
  // as "dead" would tell the operator ten working leads had died. It has to read as unmeasured.
  const unknown = mk({ readFleet: fleet, liveSessions: () => null });
  await dispatch(['status'], unknown.deps);
  assert.match(row(unknown.stdout()), /\?/);
  assert.doesNotMatch(row(unknown.stdout()), /\bdead\b/);

  // A row that never had a session has no liveness to report, and "dead" against a queued task
  // is a fault the operator would go looking for. Only `spawned` and `blocked` hold one.
  const notYet = mk({
    readFleet: () => ({ tasks: [{ id: 'cr-2', status: 'queued' }, { id: 'cr-3', status: 'done' }] }),
    liveSessions: () => new Set(),
  });
  await dispatch(['status'], notYet.deps);
  const rows = notYet.stdout().split('\n').filter((l) => /^cr-[23]/.test(l));
  assert.equal(rows.length, 2);
  for (const r of rows) assert.doesNotMatch(r, /\b(dead|yes)\b/, r);
});

test('the PANE column names what each pane is doing, for every row with a session, never in the LIVE column\'s words', async (t) => {
  root(t);
  const fleet = () => ({ tasks: [
    { id: 'cr-1', status: 'spawned', tmux_session: 'lead-cr-1' },   // idle composer
    { id: 'cr-2', status: 'done', tmux_session: 'lead-cr-2' },      // bare zsh: task-7, restored by tmux-resurrect — with its saved spinner title
    { id: 'cr-3', status: 'blocked', tmux_session: 'lead-cr-3' },   // permission dialog: the 38-hour case
    { id: 'cr-4', status: 'queued' },                               // never had a session
    { id: 'cr-5', status: 'failed', tmux_session: 'lead-cr-5' },    // claude exited, pane kept for the death scene
    { id: 'cr-6', status: 'done', tmux_session: 'lead-cr-6' },      // session gone
    { id: 'cr-7', status: 'spawned', tmux_session: 'lead-cr-7' },   // working: spinner title
    { id: 'cr-8', status: 'spawned', tmux_session: 'lead-cr-8' },   // text in the composer, never submitted
    { id: 'cr-9', status: 'spawned', tmux_session: 'lead-cr-9' },   // running something the classifier does not know
  ] });
  const panes = new Map([
    ['lead-cr-1', pane()], ['lead-cr-2', pane({ cmd: 'zsh', title: '◐ lead-task-7' })], ['lead-cr-3', pane({ cmd: '2.1.259', title: '✳ Claude Code' })],
    ['lead-cr-5', pane({ dead: true, cmd: 'env', title: '' })], ['lead-cr-7', pane({ title: '◐ Claude Code' })], ['lead-cr-8', pane()], ['lead-cr-9', pane({ cmd: 'node' })],
  ]);
  const frames = { 'lead-cr-1': IDLE_FRAME, 'lead-cr-3': PROMPT_FRAME, 'lead-cr-7': IDLE_FRAME, 'lead-cr-8': DRAFT_FRAME, 'lead-cr-9': 'nothing the classifier knows' };
  const h = mk({
    readFleet: fleet,
    liveSessions: () => new Set([...panes.keys()]),
    paneStates: () => panes,
    capturePane: (target, lines) => { h.calls.capturePane.push({ target, lines }); return frames[target] ?? ''; },
  });
  assert.equal(await dispatch(['status'], h.deps), 0);
  const rowOf = (harness, id) => harness.stdout().split('\n').find((l) => l.startsWith(`${id} `));
  assert.match(h.stdout(), /\bPANE\b/, 'the column is named in the header');
  assert.match(rowOf(h, 'cr-1'), /\bidle\b/);
  assert.match(rowOf(h, 'cr-2'), /\bshell\b/);
  assert.match(rowOf(h, 'cr-3'), /\bprompt\b/);
  assert.match(rowOf(h, 'cr-5'), /\bexited\b/);
  assert.match(rowOf(h, 'cr-6'), /\bgone\b/);
  assert.match(rowOf(h, 'cr-7'), /\bworking\b/);
  assert.match(rowOf(h, 'cr-8'), /\bdraft\b/, 'the unsent-brief case made visible: text in the composer, Enter never fired');
  assert.match(rowOf(h, 'cr-9'), /\bother\b/);
  // Rows the LIVE column does not judge still get a pane reading — that is where the 38-hour
  // case and the resurrected shells lived — but never in the LIVE column's own words.
  for (const id of ['cr-2', 'cr-4', 'cr-5', 'cr-6']) assert.doesNotMatch(rowOf(h, id), /\b(dead|yes)\b/, rowOf(h, id));
  assert.match(rowOf(h, 'cr-4'), /^cr-4\s+queued\s+-\s+-\s/, 'a queued row has no pane to read');
  // Captures are spent on live non-shell panes only: not the shell, not the corpse, not the missing session.
  assert.deepEqual(h.calls.capturePane.map((c) => c.target).sort(), ['lead-cr-1', 'lead-cr-3', 'lead-cr-7', 'lead-cr-8', 'lead-cr-9']);
  // The footer is the one line an operator reads first: how many panes need a human, and the two
  // moves. Counted from the rendered column (cr-3 on a dialog, cr-2 a shell), never from status.
  assert.match(h.stdout(), /panes needing a human: 1 on a dialog[^\n]*· 1 bare shell/);
  assert.match(h.stdout(), /never \`soma send\` them/);
  // The listing could not be read: `?`, and never a verdict — the same third state the LIVE column has.
  const unknown = mk({ readFleet: fleet, liveSessions: () => null, paneStates: () => null });
  await dispatch(['status'], unknown.deps);
  assert.match(rowOf(unknown, 'cr-1'), /^cr-1\s+spawned\s+\?\s+\?\s/);
  assert.doesNotMatch(rowOf(unknown, 'cr-2'), /\b(shell|gone|exited)\b/);
  assert.equal(unknown.calls.capturePane.length, 0);
});

test('a lead whose spawn has not made its session yet reads LIVE starting and PANE -, not dead and gone, until the bound', async (t) => {
  root(t);
  // `launching_at` is the claim's mark: the spawn flips the row to `spawned` first and creates the
  // session last, after a fetch that may take two minutes, and for that whole window this row read
  // `spawned  dead  gone`, exactly like a lead that had died.
  const fleet = (age) => () => ({ tasks: [{ id: 'cr-1', status: 'spawned', tmux_session: null, launching_at: Date.now() - age }] });
  const rowOf = (h) => h.stdout().split('\n').find((l) => l.startsWith('cr-1 '));

  // Thirty seconds into the fetch: tmux answers, and the lead's session is not on it yet.
  const starting = mk({ readFleet: fleet(30_000), liveSessions: () => new Set(), paneStates: () => new Map() });
  assert.equal(await dispatch(['status'], starting.deps), 0);
  assert.match(rowOf(starting), /^cr-1\s+spawned\s+starting\s+-\s/);
  assert.doesNotMatch(rowOf(starting), /\b(dead|gone)\b/);
  // No tmux server answering at all reads as an empty server, and a launch may be what starts one.
  const noServer = mk({ readFleet: fleet(30_000), liveSessions: () => null, serverAbsent: () => true });
  await dispatch(['status'], noServer.deps);
  assert.match(rowOf(noServer), /^cr-1\s+spawned\s+starting\s+-\s/);

  // Past the bound the row reads as it did before the mark, `dead  gone`, and revival deals with it.
  const expired = mk({ readFleet: fleet(LAUNCH_GRACE_MS), liveSessions: () => new Set(), paneStates: () => new Map() });
  await dispatch(['status'], expired.deps);
  assert.match(rowOf(expired), /^cr-1\s+spawned\s+dead\s+gone\s/);
  // The session beats the mark (a record write that failed leaves one behind on a lead that is up).
  const up = mk({ readFleet: fleet(30_000), liveSessions: () => new Set(['lead-cr-1']), paneStates: () => new Map([['lead-cr-1', pane()]]) });
  await dispatch(['status'], up.deps);
  assert.match(rowOf(up), /^cr-1\s+spawned\s+yes\s+idle\s/);
  // tmux unreadable is `?` in both columns: a hiccup is never a launch.
  const unread = mk({ readFleet: fleet(30_000), liveSessions: () => null, paneStates: () => null });
  await dispatch(['status'], unread.deps);
  assert.match(rowOf(unread), /^cr-1\s+spawned\s+\?\s+\?\s/);
  // A pane the census already sees is shown as itself: the session can appear between the two reads.
  const between = mk({ readFleet: fleet(30_000), liveSessions: () => new Set(), paneStates: () => new Map([['lead-cr-1', pane()]]) });
  await dispatch(['status'], between.deps);
  assert.match(rowOf(between), /^cr-1\s+spawned\s+starting\s+idle\s/);
  // Only a claimed `spawned` row is ever starting.
  const blocked = mk({ readFleet: () => ({ tasks: [{ id: 'cr-1', status: 'blocked', launching_at: Date.now() - 30_000 }] }), paneStates: () => new Map() });
  await dispatch(['status'], blocked.deps);
  assert.match(rowOf(blocked), /^cr-1\s+blocked\s+dead\s+gone\s/);
});

test('the status table stays aligned now that LIVE can read starting: every cell starts under its header', async (t) => {
  root(t);
  const h = mk({
    readFleet: () => ({ tasks: [
      { id: 'cr-1', status: 'spawned', launching_at: Date.now() - 30_000 },   // starting
      { id: 'cr-2', status: 'spawned', lead_session_uuid: 'u2' },            // yes, with a usage reading
      { id: 'cr-3', status: 'spawned' },                                     // dead
      { id: 'cr-4', status: 'queued' },                                      // -
    ] }),
    liveSessions: () => new Set(['lead-cr-2']),
    paneStates: () => new Map([['lead-cr-2', pane()]]),
    readUsage: () => ({ turns: 12, est_tokens: 3456, last_model: 'claude-fable-5' }),
  });
  await dispatch(['status'], h.deps);
  const lines = h.stdout().split('\n');
  const header = lines.find((l) => l.startsWith('LEAD '));
  assert.ok(header, 'the table header is printed');
  const cols = ['STATUS', 'LIVE', 'PANE', 'SEAT', 'TURNS', 'TOKENS', 'MODEL'].map((name) => [name, header.indexOf(name)]);
  const row = (id) => lines.find((l) => l.startsWith(`${id} `));
  assert.equal(row('cr-1').slice(cols[1][1], cols[2][1]).trim(), 'starting', 'the widest LIVE word is in the table under test');
  for (const id of ['cr-1', 'cr-2', 'cr-3', 'cr-4']) {
    const line = row(id);
    for (const [name, at] of cols) {
      assert.ok(at > 0, `${name} is in the header`);
      assert.notEqual(line[at], ' ', `${id}: the ${name} cell starts at column ${at}: ${JSON.stringify(line)}`);
      assert.equal(line[at - 1], ' ', `${id}: the cell before ${name} ends before column ${at}: ${JSON.stringify(line)}`);
    }
  }
});

test('status prints what it resolved: state root, queue, lease holder, watchdog', async (t) => {
  const home = root(t);
  const h = mk({
    queuePaused: () => true,
    readLease: () => ({ session_id: 'sess-abc', lease_seq: 3, heartbeat_at: Date.now() - 61_000 }),
    liveSessions: () => new Set(['soma-watchdog']),
    readFleet: () => ({ tasks: [{ id: 'cr-1', status: 'queued' }, { id: 'cr-2', status: 'done' }] }),
  });
  assert.equal(await dispatch(['status'], h.deps), 0);
  const s = h.stdout();
  assert.ok(s.includes(home), 'the state root every reading was taken from is named');
  assert.match(s, /PAUSED/);
  assert.match(s, /sess-abc/);
  assert.match(s, /queued 1/);
  assert.match(s, /done 1/);
  assert.match(s, /watchdog: live/);
});

test('status names an absent watchdog as the reason nothing is draining', async (t) => {
  root(t);
  const h = mk({ readFleet: () => ({ tasks: [{ id: 'cr-1', status: 'queued' }] }) });
  await dispatch(['status'], h.deps);
  assert.match(h.stdout(), /watchdog: absent/);
  // The operator's next action, on the line that reports the fault: a queued fleet with no
  // watchdog looks identical to a healthy idle one until someone knows this.
  assert.match(h.stdout(), /soma up/);
});

test('status reads "no tmux server answers on soma\'s socket" as an absent watchdog and an empty server, not as an unreadable tmux', async (t) => {
  root(t);
  // A machine that has never run `soma up`: tmux exits 1 with "error connecting to …
  // (No such file or directory)", so `liveSessions` and `paneStates` both answer null — and
  // `serverAbsent` recognises tmux's own words for "no server answers on this socket". It used to
  // print `watchdog: unverified — tmux could not be read` on exactly that machine.
  const fleet = () => ({ tasks: [
    { id: 'cr-1', status: 'spawned', tmux_session: 'lead-cr-1' },
    { id: 'cr-2', status: 'done', tmux_session: 'lead-cr-2' },
    { id: 'cr-3', status: 'queued' },
  ] });
  const h = mk({ readFleet: fleet, liveSessions: () => null, paneStates: () => null, serverAbsent: () => true });
  assert.equal(await dispatch(['status'], h.deps), 0);
  const line = (harness, prefix) => harness.stdout().split('\n').find((l) => l.startsWith(prefix));
  // The socket by its one spelling, `tmux.socketName()` — this file's throwaway name — so an arm
  // that re-spelled it as `soma` is a measurable difference.
  assert.equal(line(h, 'watchdog:'), `watchdog: absent — no tmux server answers on socket ${tmux.socketName()},`
    + ' so nothing spawns, revives, meters or drains without it. Run `soma up`.');
  assert.doesNotMatch(h.stdout(), /unverified|could not be read/, 'nothing went unread: tmux said why it had nothing to list');
  // No server answering, no sessions to list: a spawned row reads `dead`, not `?`, and the PANE
  // column agrees with it — every row that had a session reads `gone` (an empty listing's token,
  // never the `?` that means "tmux could not be read"), and nothing is captured.
  assert.match(line(h, 'cr-1 '), /^cr-1\s+spawned\s+dead\s+gone\s/);
  assert.match(line(h, 'cr-2 '), /^cr-2\s+done\s+-\s+gone\s/);
  assert.match(line(h, 'cr-3 '), /^cr-3\s+queued\s+-\s+-\s/);
  assert.equal(h.calls.capturePane.length, 0);

  // Every OTHER null stays the third state, word for word: a timeout, a missing binary and a
  // permission error are unknowns, and an unknown is not an absence.
  const unknown = mk({ readFleet: fleet, liveSessions: () => null, paneStates: () => null, serverAbsent: () => false });
  assert.equal(await dispatch(['status'], unknown.deps), 0);
  assert.equal(line(unknown, 'watchdog:'), 'watchdog: unverified — tmux could not be read, so its state is unknown here');
  assert.match(line(unknown, 'cr-1 '), /^cr-1\s+spawned\s+\?\s+\?\s/);

  // Asked only about a null: a listing tmux answered is never second-guessed by the probe.
  const listed = mk({ readFleet: fleet, liveSessions: () => new Set(['soma-watchdog', 'lead-cr-1']), serverAbsent: () => true });
  assert.equal(await dispatch(['status'], listed.deps), 0);
  assert.equal(line(listed, 'watchdog:'), 'watchdog: live (tmux session soma-watchdog)');
  assert.match(line(listed, 'cr-1 '), /^cr-1\s+spawned\s+yes\s/);
});

test('the queue line says whether anything is admitting: a bare "open" only beside a live watchdog', async (t) => {
  root(t);
  // `queue: open` printed before `soma up` had ever run, while help says `up` is what opens the
  // queue. Both were right by their own lights — the pause FLAG was absent, and admission is the
  // watchdog's tick — so the line now says which of the two the operator is looking at.
  const queueOf = async (over) => {
    const h = mk(over);
    assert.equal(await dispatch(['status'], h.deps), 0);
    return h.stdout().split('\n').find((l) => l.startsWith('queue:'));
  };
  const NOTHING_ADMITS = 'queue: open (no watchdog is running, so nothing is admitted until `soma up`)';
  assert.equal(await queueOf({ liveSessions: () => new Set(['soma-watchdog']) }), 'queue: open', 'a live watchdog drains an open queue: unchanged');
  assert.equal(await queueOf({ liveSessions: () => new Set() }), NOTHING_ADMITS, 'a server with no watchdog session');
  assert.equal(await queueOf({ liveSessions: () => null, serverAbsent: () => true }), NOTHING_ADMITS, 'no tmux server answering at all');
  // Unverified: still `open` — the flag WAS read — but whether anything acts on it is not known, and
  // "nothing is admitted" would be a claim the reading cannot support.
  const unknown = await queueOf({ liveSessions: () => null, serverAbsent: () => false });
  assert.match(unknown, /^queue: open \(/);
  assert.match(unknown, /unknown/);
  assert.doesNotMatch(unknown, /no watchdog is running/);
  // PAUSED and unreadable describe the flag itself, and stay exactly as they were whatever the
  // watchdog's state.
  for (const liveSessions of [() => new Set(['soma-watchdog']), () => new Set(), () => null]) {
    assert.equal(await queueOf({ queuePaused: () => true, liveSessions, serverAbsent: () => true }),
      'queue: PAUSED — admission is frozen (soma_queue resume re-opens it)');
    assert.match(await queueOf({ queuePaused: () => { throw new Error('EACCES: state dir'); }, liveSessions, serverAbsent: () => true }),
      /^queue: unreadable — .*\(EACCES: state dir\), so this is NOT a claim that admission is open\./);
  }
});

test('status prints ONE orchestrator line, and an unreadable lease is not "none"', async (t) => {
  root(t);
  const orchLines = (h) => h.stdout().split('\n').filter((l) => l.startsWith('orchestrator:'));

  // `readLease` THROWS on EACCES/EIO and returns `null` only for the genuinely-released state. The
  // catch left `lease` at `null`, so the `=== null` discriminator below it could not work: the arm
  // printed "unreadable lease (…)" AND THEN "none — nothing is dispatching work". Two lines that
  // disagree are worse than one wrong line, because the operator cannot tell which to trust — and
  // the false one is the actionable-looking one. Nothing drove a throwing readLease through
  // `status` before this test.
  const broken = mk({ readLease: () => { throw new Error('EACCES: permission denied'); } });
  assert.equal(await dispatch(['status'], broken.deps), 0);
  const brokenLines = orchLines(broken);
  assert.equal(brokenLines.length, 1, `exactly one orchestrator line, got ${JSON.stringify(brokenLines)}`);
  assert.match(brokenLines[0], /EACCES: permission denied/, 'the reason, which is the actionable part');
  // The exact false claim, not the word "none" — the surviving line quotes that word in order to
  // deny it. Independently falsifiable even beside the count above: a catch that printed nothing
  // and fell through to the released arm would also leave exactly one line, and it would be this.
  assert.doesNotMatch(brokenLines[0], /no session holds the lease/, 'an unreadable lease is not a released one');

  // The released state still says so AND still names the consequence. This is a primary diagnosis
  // for a stalled fleet, and the whole line could be deleted with the suite green.
  const none = mk({ readLease: () => null });
  await dispatch(['status'], none.deps);
  assert.equal(orchLines(none).length, 1);
  assert.match(orchLines(none)[0], /none/);
  assert.match(orchLines(none)[0], /dispatching/, 'why an operator should care that it is none');

  // And a held lease is still exactly one line, naming the holder.
  const held = mk({ readLease: () => ({ session_id: 'sess-abc', lease_seq: 3, heartbeat_at: Date.now() }) });
  await dispatch(['status'], held.deps);
  assert.equal(orchLines(held).length, 1);
  assert.match(orchLines(held)[0], /sess-abc/);
});

test('status reports an unreadable pause flag as unreadable, not as open', async (t) => {
  root(t);
  // A two-state collapse in the file that insists on three everywhere else, and it fell on the
  // side of the reassuring answer: "admission is open" is a claim about the fleet, and a flag that
  // could not be read is not evidence for it.
  const h = mk({ queuePaused: () => { throw new Error('EACCES: state dir'); } });
  assert.equal(await dispatch(['status'], h.deps), 0);
  const line = h.stdout().split('\n').find((l) => l.startsWith('queue:'));
  assert.match(line, /unreadable/i);
  assert.match(line, /EACCES/, 'the reason, so doctor is not the only way to find out');
  // And a readable flag still renders as the two verdicts it has, so the assertions above cannot
  // be satisfied by an arm that reports every queue as unreadable. Beside a LIVE watchdog: with
  // none, a bare `open` would overstate it, and the line says so (the queue-line test below).
  const openH = mk({ liveSessions: () => new Set(['soma-watchdog']) });
  await dispatch(['status'], openH.deps);
  assert.equal(openH.stdout().split('\n').find((l) => l.startsWith('queue:')), 'queue: open');
});

// --------------------------------------------------------------------------- status: seats

test('the SEAT column is named in the header, and a row with no seat renders "-"', async (t) => {
  root(t);
  const h = mk({
    readFleet: () => ({ tasks: [{ id: 'cr-1', status: 'spawned', tmux_session: 'lead-cr-1' }] }),
    liveSessions: () => new Set(['lead-cr-1']),
  });
  assert.equal(await dispatch(['status'], h.deps), 0);
  assert.match(h.stdout(), /\bSEAT\b/, 'the column is named in the header');
  // LIVE yes (the session is listed), PANE ? (mk's listing is null), SEAT - (no seat recorded).
  assert.match(h.stdout().split('\n').find((l) => l.startsWith('cr-1 ')), /^cr-1\s+spawned\s+yes\s+\?\s+-\s/);
});

test('a row with a seat renders its label beside the pane', async (t) => {
  root(t);
  const h = mk({
    readFleet: () => ({ tasks: [{ id: 'cr-1', status: 'spawned', tmux_session: 'lead-cr-1', seat: 'seat-b' }] }),
    liveSessions: () => new Set(['lead-cr-1']),
  });
  await dispatch(['status'], h.deps);
  assert.match(h.stdout().split('\n').find((l) => l.startsWith('cr-1 ')), /^cr-1\s+spawned\s+yes\s+\?\s+seat-b\s/);
});

const SEATS_NONE = { configured: 0, open: [], closed: [], unverified: [], unreadable: false, why: null };
const seatRow = (label, over = {}) => ({ label, config_dir: `/seats/${label}`, ...over });
const seatsLineOf = (h) => h.stdout().split('\n').find((l) => l.startsWith('seats:'));
/** The limit fixture's reset (2015-08-24T16:30Z, in ms) as the `closed_until` sample; `clock` is the oracle for how it renders. */
const RESET_MS = 1_440_433_800_000;

test('the fleet header lists each seat: open, or closed until its reset time with the reason', async (t) => {
  root(t);
  const h = mk({ seatsSummary: () => ({ ...SEATS_NONE, configured: 2, open: [seatRow('seat-a')], closed: [{ ...seatRow('seat-b'), closed_until: RESET_MS, closed_reason: 'five_hour' }] }) });
  assert.equal(await dispatch(['status'], h.deps), 0);
  // `clock` is the pinned oracle: the same instant through the same formatter against the same
  // wall clock, so neither the process TZ nor a day boundary can make the two differ.
  assert.equal(seatsLineOf(h), `seats: seat-a open · seat-b closed until ${clock(RESET_MS)} (five_hour)`);
});

test('an unverified seat is named with the login it needs, because no machine action fixes it', async (t) => {
  root(t);
  const h = mk({ seatsSummary: () => ({ ...SEATS_NONE, configured: 1, unverified: [seatRow('seat-c')] }) });
  await dispatch(['status'], h.deps);
  assert.match(seatsLineOf(h), /seat-c unverified \(not logged in — CLAUDE_CONFIG_DIR=\/seats\/seat-c claude auth login\)/);
});

test('no configured seats says so, rather than printing an empty list', async (t) => {
  root(t);
  const h = mk();
  await dispatch(['status'], h.deps);
  assert.equal(seatsLineOf(h), 'seats: none configured — leads run under this process\'s CLAUDE_CONFIG_DIR');
});

test('the three buckets print in the documented order — open · closed · unverified — whatever order the summary hands them over in', async (t) => {
  root(t);
  // The comment above `seatsLine` promises this order and only open-before-closed was pinned:
  // no other test has `unverified` non-empty beside another bucket, and the one that has it at
  // all asserts with `match`. One exact line, all three clauses, so moving a loop reddens it.
  const h = mk({ seatsSummary: () => ({
    ...SEATS_NONE,
    configured: 3,
    unverified: [seatRow('seat-c')],
    closed: [{ ...seatRow('seat-b'), closed_until: RESET_MS, closed_reason: 'five_hour' }],
    open: [seatRow('seat-a')],
  }) });
  await dispatch(['status'], h.deps);
  assert.equal(
    seatsLineOf(h),
    `seats: seat-a open · seat-b closed until ${clock(RESET_MS)} (five_hour)`
      + ' · seat-c unverified (not logged in — CLAUDE_CONFIG_DIR=/seats/seat-c claude auth login)',
  );
});

test('RUNBOOK §10 quotes a seats: line `soma status` can actually print', async (t) => {
  root(t);
  // §10 is the bring-up checklist — what to OBSERVE, not infer — so the string it hands the
  // operator has to be one this code produces. It read `seat-a closed until <reset> (<reason>) ·
  // seat-b open`: the post-rotation state with the clauses in config order, which `seatsLine`
  // never emits, because it buckets open · closed · unverified. Derived from the real
  // line rather than re-spelled here, so the doc is pinned to the code and not to another
  // sentence — the same shape as `RUNBOOK §9 counts thaw's refusals the way the arm does`.
  const h = mk({ seatsSummary: () => ({
    ...SEATS_NONE,
    configured: 2,
    open: [seatRow('seat-b')],                                                   // the seat the lead landed on
    closed: [{ ...seatRow('seat-a'), closed_until: RESET_MS, closed_reason: 'five_hour' }],
  }) });
  await dispatch(['status'], h.deps);
  const real = seatsLineOf(h).replace(/^seats: /, '')
    .replace(clock(RESET_MS), '<reset>')
    .replace('(five_hour)', '(<reason>)');
  // Non-vacuity, before the scan: a line missing either clause would make a doc that quotes half
  // of it — or a doc-side regression — pass for a reason that has nothing to do with the order.
  assert.match(real, /\bopen\b/, 'the fixture must produce an open clause, or the containment below is not about ordering');
  assert.match(real, /closed until <reset> \(<reason>\)/, 'the fixture must produce a templated closed clause, or the containment below cannot match a doc');
  const runbook = readFileSync(fileURLToPath(new URL('../RUNBOOK.md', import.meta.url)), 'utf8');
  const start = runbook.indexOf('**(1) The events**');
  const end = runbook.indexOf('**(2) The transcript tail**');
  // Could-not-observe, checked first and reddening rather than skipping: with either boundary
  // gone this pin is reading some other part of the document.
  assert.ok(start !== -1 && end > start,
    'could not observe: RUNBOOK §10 no longer runs from "(1) The events" to "(2) The transcript tail" — re-anchor this pin');
  const events = runbook.slice(start, end).replace(/\s+/g, ' ');   // the example wraps; the line does not
  assert.ok(events.includes('`' + real + '`'),
    `RUNBOOK §10 quotes a seats: line status cannot print. The real one, templated, is \`${real}\``);
});

test('a summary whose configured count is unknown reads UNREADABLE, never "none configured" — an unmeasured count is not a claim that there are no seats', async (t) => {
  root(t);
  // `{ configured: null, unreadable: false }` is a record `bus-tools.shapeSeats` already builds
  // (for a reader whose count it could not read), and "none configured" is not a fallback for
  // it: that sentence tells the operator leads run under this process's own CLAUDE_CONFIG_DIR,
  // which is a claim about the pool that an unknown count cannot support.
  const h = mk({ seatsSummary: () => ({ ...SEATS_NONE, configured: null }) });
  assert.equal(await dispatch(['status'], h.deps), 0);
  assert.match(seatsLineOf(h), /^seats: UNREADABLE \(the configured seat count is unknown\)/);
});

test('an unreadable seat state is reported as UNREADABLE with the reason, and never as open', async (t) => {
  root(t);
  const h = mk({ seatsSummary: () => ({ ...SEATS_NONE, configured: 2, unreadable: true, why: 'state/seats.json is not valid JSON' }) });
  await dispatch(['status'], h.deps);
  assert.match(seatsLineOf(h), /^seats: UNREADABLE \(state\/seats\.json is not valid JSON\)/);
  assert.doesNotMatch(seatsLineOf(h), /\bopen\b(?!")/, 'the only "open" on the line is the quoted claim it denies');
});

test('a seatsSummary that throws is the same third state, and status still exits 0', async (t) => {
  root(t);
  const h = mk({ seatsSummary: () => { throw new Error('EACCES: seats'); } });
  assert.equal(await dispatch(['status'], h.deps), 0);
  assert.match(seatsLineOf(h), /^seats: UNREADABLE \(EACCES: seats\)/);
});

test('with no seatsSummary override, status reads the real soma.json and state/seats.json under SOMA_HOME', async (t) => {
  const home = root(t);
  // A live closure has to be ahead of the wall clock, so this one sample is Date.now()-based;
  // `clock(until)` is again the oracle for its rendering.
  const until = Date.now() + 3 * 3_600_000;
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(join(home, 'soma.json'), JSON.stringify({ seats: [{ config_dir: join(home, 'seat-a'), label: 'seat-a' }, { config_dir: join(home, 'seat-b'), label: 'seat-b' }] }));
  writeFileSync(join(home, 'state', 'seats.json'), JSON.stringify({ seats: [{ config_dir: join(home, 'seat-b'), label: 'seat-b', closed_until: until, closed_reason: 'five_hour', unverified: false }] }));
  const h = mk();
  delete h.deps.seatsSummary; // fall through to dispatch's default: seats-summary.seatsSummary
  assert.equal(await dispatch(['status'], h.deps), 0);
  assert.equal(seatsLineOf(h), `seats: seat-a open · seat-b closed until ${clock(until)} (five_hour)`);
});


// --------------------------------------------------------------------------- status: the freeze record

test('status renders the freeze beside the pause, in three states, through the reader soma_status uses', async (t) => {
  root(t);
  const line = (h) => h.stdout().split('\n').find((l) => l.startsWith('backpressure:'));
  const none = mk();
  await dispatch(['status'], none.deps);
  assert.equal(line(none), 'backpressure: none');

  const frozen = mk({ backpressureState: () => ({ active: true, reason: 'org_level_disabled_until', since: 1_440_433_800_000, until: null }) });
  await dispatch(['status'], frozen.deps);
  assert.match(line(frozen), /FROZEN/);
  assert.match(line(frozen), /org_level_disabled_until/, 'the reason, which is what the operator acts on');
  assert.match(line(frozen), /2015-08-24T16:30:00\.000Z/, 'since, as a time a human can read');
  assert.match(line(frozen), /no known end/);
  assert.match(line(frozen), /soma thaw/, 'and the verb that lifts a spend-cap record');

  // A PARTIAL record — which the reader accepts on purpose (`{active:true, reason:'storm'}` "is
  // still a record", test/wd.test.mjs) — says its `since` is unknown instead of rendering the
  // absence. `whenMs`'s non-finite arm is the only thing standing between a hand-edited record and
  // a status line that reads `since NaN`, and changing that arm to 'NaN' left this file 98/98.
  const partial = mk({ backpressureState: () => ({ active: true, reason: 'org_level_disabled_until' }) });
  await dispatch(['status'], partial.deps);
  assert.match(line(partial), /an unknown time/, 'a record with no since says so');
  assert.doesNotMatch(line(partial), /NaN|Invalid Date/, 'and never renders the absence as a number or a broken date');

  // A storm record names its own remedy — the watchdog — and is not offered `soma thaw`, which refuses it.
  const stormy = mk({ backpressureState: () => ({ active: true, reason: 'storm', since: 1_440_433_800_000, until: 1_440_437_400_000 }) });
  await dispatch(['status'], stormy.deps);
  assert.match(line(stormy), /FROZEN/);
  assert.match(line(stormy), /until 2015-08-24T17:30:00\.000Z/);
  assert.match(line(stormy), /clears itself/);
  assert.doesNotMatch(line(stormy), /soma thaw/);
  // `until` is DESCRIPTIVE — nothing in `bin/` compares it to a clock (the limits phase's spend-cap branch
  // writes `until: null`, so only a hand-written record reaches this) — and a stated end that has
  // passed is therefore not a freeze that lifted. The line says so, because the reading an
  // operator would otherwise take from a past timestamp is that the fleet had already thawed.
  assert.match(line(stormy), /PASSED/, 'a stated end in the past is not silence');
  assert.match(line(stormy), /nothing expires a record by its own clock/);
  const future = mk({ backpressureState: () => ({ active: true, reason: 'org_level_disabled_until', since: 1_440_433_800_000, until: 4_102_444_800_000 }) });
  await dispatch(['status'], future.deps);
  assert.match(line(future), /until 2100-01-01T00:00:00\.000Z/);
  assert.doesNotMatch(line(future), /PASSED/, 'and an end still ahead is not announced as one');

  // The third state is not "none": an unreadable record is not evidence that admission is open.
  const torn = mk({ backpressureState: () => ({ active: false, unreadable: true, why: 'state/backpressure.json is not JSON' }) });
  await dispatch(['status'], torn.deps);
  assert.match(line(torn), /unreadable/);
  assert.match(line(torn), /not JSON/, 'the reason, so doctor is not the only way to find out');
  assert.doesNotMatch(line(torn), /: none/);
  const throwing = mk({ backpressureState: () => { throw new Error('EACCES: state dir'); } });
  await dispatch(['status'], throwing.deps);
  assert.match(line(throwing), /unreadable/);
  assert.match(line(throwing), /EACCES/);
});

test('status against the real file: the CLI default backpressureState is wd/backpressure.mjs\'s reader, three-state', async (t) => {
  const home = root(t);
  const line = (h) => h.stdout().split('\n').find((l) => l.startsWith('backpressure:'));
  // The default dep, not the stub: `mk()` stubs every arm's deps, so without this the CLI default
  // is an unpinned module call that a lambda returning {active:false} would satisfy forever.
  const real = () => { const h = mk(); delete h.deps.backpressureState; return h; };
  const none = real();
  await dispatch(['status'], none.deps);
  assert.equal(line(none), 'backpressure: none', 'no file');
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(join(home, 'state', 'backpressure.json'), JSON.stringify({ active: true, reason: 'org_level_disabled_until', since: 1_440_433_800_000, until: null }));
  const frozen = real();
  await dispatch(['status'], frozen.deps);
  assert.match(line(frozen), /FROZEN/);
  assert.match(line(frozen), /org_level_disabled_until/);
  writeFileSync(join(home, 'state', 'backpressure.json'), '{ not json');
  const torn = real();
  await dispatch(['status'], torn.deps);
  assert.match(line(torn), /unreadable/);
  assert.match(line(torn), /not JSON/);
});


// --------------------------------------------------------------------------- thaw

test('thaw clears an org spend-cap record and prints what it cleared; refuses a storm, an unreadable record, a failed clear, and --as without the lease', async (t) => {
  root(t);
  const cap = { active: true, reason: 'org_level_disabled_until', since: 1_440_433_800_000, until: null };
  const h = mk({ backpressureState: () => cap });
  assert.equal(await dispatch(['thaw'], h.deps), 0);
  assert.equal(h.calls.clearBackpressure.length, 1, 'the one action: the owning module\'s clear');
  assert.match(h.stdout(), /thawed/);
  assert.match(h.stdout(), /org_level_disabled_until/, 'the record it cleared, so the operator sees what they lifted');
  assert.match(h.stdout(), /2015-08-24T16:30:00\.000Z/);
  assert.match(h.stdout(), /next tick/);
  // Who acted, on THIS arm. The generic "a bare human invocation says it is acting as operator"
  // test drives `send`, so deleting `d.print(act.note)` here left this file 98/98 — and a fleet
  // whose freeze was lifted by someone would have no line saying by whom.
  assert.match(h.stdout(), /acting as operator/, 'the actor note, printed by the arm that acts');

  // The same clock helper on this side: a partial record (no `since`) says the time is unknown
  // rather than printing `NaN` into the line that tells an operator what they just lifted.
  const partial = mk({ backpressureState: () => ({ active: true, reason: 'org_level_disabled_until' }) });
  assert.equal(await dispatch(['thaw'], partial.deps), 0);
  assert.match(partial.stdout(), /frozen since an unknown time/);
  assert.doesNotMatch(partial.stdout(), /NaN|Invalid Date/);

  // A live storm is the watchdog's: it re-writes its record every corroborated tick, so a clear here
  // would be undone within 30 s and would hide the storm from `soma status` meanwhile.
  const storm = mk({ backpressureState: () => ({ active: true, reason: 'storm', since: 1_440_433_800_000, until: null }) });
  assert.equal(await dispatch(['thaw'], storm.deps), 3);
  assert.equal(storm.calls.clearBackpressure.length, 0);
  assert.match(storm.stderr(), /storm/i);
  assert.match(storm.stderr(), /watchdog/);

  // Nothing to thaw is not a refusal: it is the state the verb exists to reach.
  const none = mk();
  assert.equal(await dispatch(['thaw'], none.deps), 0);
  assert.equal(none.calls.clearBackpressure.length, 0);
  assert.match(none.stdout(), /nothing to thaw/);

  // The third state is refused, not cleared blind: the bytes are the evidence.
  const torn = mk({ backpressureState: () => ({ active: false, unreadable: true, why: 'state/backpressure.json is not JSON' }) });
  assert.equal(await dispatch(['thaw'], torn.deps), 3);
  assert.equal(torn.calls.clearBackpressure.length, 0);
  assert.match(torn.stderr(), /not JSON/);
  assert.match(torn.stderr(), /by hand/);
  const throwing = mk({ backpressureState: () => { throw new Error('EACCES: state dir'); } });
  assert.equal(await dispatch(['thaw'], throwing.deps), 3);
  assert.match(throwing.stderr(), /EACCES/);

  // A clear that fails is a refusal that says so, never a "thawed" over a record still on disk.
  const stuck = mk({ backpressureState: () => cap, clearBackpressure: () => { throw new Error('fleet.lock: /s/state/fleet.lock is still held by pid 7 — gave up after 5000ms'); } });
  assert.equal(await dispatch(['thaw'], stuck.deps), 3);
  assert.match(stuck.stderr(), /fleet\.lock/);
  assert.doesNotMatch(stuck.stdout(), /thawed/);

  // Mutating, so `--as` is checked like every other mutating verb: a session that does not hold
  // the lease may not lift the fleet's freeze; the holder does, and its heartbeat is stamped.
  const notHolder = mk({ backpressureState: () => cap, readLease: () => ({ session_id: 'other', lease_seq: 2, heartbeat_at: Date.now() }) });
  assert.equal(await dispatch(['thaw', '--as', 'mine'], notHolder.deps), 3);
  assert.equal(notHolder.calls.clearBackpressure.length, 0);
  const holder = mk({ backpressureState: () => cap, readLease: () => ({ session_id: 'mine', lease_seq: 2, heartbeat_at: Date.now() }) });
  assert.equal(await dispatch(['thaw', '--as', 'mine'], holder.deps), 0);
  assert.deepEqual(holder.calls.heartbeat, ['mine'], 'the orchestrator driving from a shell keeps its lease fresh');
});

test('thaw against the real file: the CLI default deps read and clear state/backpressure.json through wd/backpressure.mjs', async (t) => {
  const home = root(t);
  mkdirSync(join(home, 'state'), { recursive: true });
  const fp = join(home, 'state', 'backpressure.json');
  writeFileSync(fp, JSON.stringify({ active: true, reason: 'org_level_disabled_until', since: 1_440_433_800_000, until: null }));
  const real = () => { const h = mk(); delete h.deps.backpressureState; delete h.deps.clearBackpressure; return h; };
  const h = real();
  assert.equal(await dispatch(['thaw'], h.deps), 0);
  assert.match(h.stdout(), /thawed/);
  assert.deepEqual(JSON.parse(readFileSync(fp, 'utf8')), { active: false }, 'the cleared record is the contract\'s');
  // And the refusal reads the same real file: a storm record on disk is left exactly as it was.
  const stormBytes = JSON.stringify({ active: true, reason: 'storm', since: 1_440_433_800_000, until: null });
  writeFileSync(fp, stormBytes);
  const s = real();
  assert.equal(await dispatch(['thaw'], s.deps), 3);
  assert.equal(readFileSync(fp, 'utf8'), stormBytes);
});

// --------------------------------------------------------------------------- enqueue

test('enqueue forwards tasks to fleet.enqueue', async (t) => {
  root(t);
  const h = mk({ readFile: () => JSON.stringify([{ id: 'cr-1', title: 't', repo: 'r', source: {}, brief: 'b' }]) });
  assert.equal(await dispatch(['enqueue', '--file', 'tasks.json'], h.deps), 0);
  assert.equal(h.calls.enqueue[0][0].id, 'cr-1');
  assert.match(h.stdout(), /cr-1/);
});

/** `fleet.enqueue`'s stub, recording the options it was handed beside the tasks. */
const enqueueInto = (seen) => (tasks, opts) => {
  seen.push(opts);
  return { queued: tasks.map((x) => x.id), skipped: [] };
};

test('enqueue hands fleet.enqueue the repos soma.json configures, so a repo-level verify_hint reaches the row', async (t) => {
  const home = root(t);
  const tasksFile = () => JSON.stringify([{ id: 'cr-1', repo: 'r', brief: 'b' }]);
  const repos = { r: { path: '/repos/r', base_branch: 'develop', verify_hint: 'yarn test' } };

  // State 1: the wiring. `fleet.enqueue` never reads soma.json itself, so the map has to travel
  // with the tasks.
  const seen = [];
  const h = mk({ readFile: tasksFile, loadConfig: () => ({ max_leads: 10, budgets: {}, repos }), enqueue: enqueueInto(seen) });
  assert.equal(await dispatch(['enqueue', '--file', 'tasks.json'], h.deps), 0);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]?.repos, repos, 'soma enqueue must pass d.loadConfig().repos as enqueue(tasks, { repos })');

  // State 2: the real modules. The real soma.json under SOMA_HOME, the real loadConfig and the
  // real fleet.enqueue, read back off the checkpoint they wrote.
  writeFileSync(join(home, 'soma.json'), JSON.stringify({ repos }));
  const r = mk({ readFile: tasksFile });
  delete r.deps.loadConfig;
  delete r.deps.enqueue;
  assert.equal(await dispatch(['enqueue', '--file', 'tasks.json'], r.deps), 0);
  const row = JSON.parse(readFileSync(join(home, 'state', 'fleet.json'), 'utf8')).tasks.find((x) => x.id === 'cr-1');
  assert.equal(row?.verify_hint, 'yarn test');
});

test('enqueue still queues when soma.json cannot be read, and says on one stderr line that no repo verify_hint was applied', async (t) => {
  const home = root(t);
  // Nothing in this error names soma.json, so a warning that names it was worded by the arm itself.
  const seen = [];
  const h = mk({
    readFile: () => JSON.stringify([{ id: 'cr-1', repo: 'r', brief: 'b' }]),
    loadConfig: () => { throw new SyntaxError('Unexpected token } in JSON at position 12'); },
    enqueue: enqueueInto(seen),
  });
  assert.equal(await dispatch(['enqueue', '--file', 'tasks.json'], h.deps), 0, 'a config the operator broke must not block the queue');
  assert.equal(seen.length, 1, 'the task is queued anyway');
  assert.equal(seen[0]?.repos ?? null, null, 'with no repo map');
  assert.match(h.stdout(), /queued 1: cr-1/);
  assert.equal(h.err.length, 1, `one warning, got: ${JSON.stringify(h.err)}`);
  assert.doesNotMatch(h.err[0], /\n/, 'on one line');
  assert.match(h.err[0], /soma\.json/, 'naming the file that could not be read');
  // The negation is the claim: "no repo verify_hint was applied", or "verify_hint … not applied".
  assert.match(h.err[0], /\b(?:no|without)\b[^\n]{0,30}\bverify_hints?\b|\bverify_hints?\b[^\n]{0,40}\bnot\b/i,
    'and what was lost: no repo verify_hint was applied');

  // The same through the real modules: a soma.json that is not JSON, and the task's own hint
  // still lands, because it never depended on the config.
  writeFileSync(join(home, 'soma.json'), '{"repos": ');
  const r = mk({ readFile: () => JSON.stringify([{ id: 'cr-2', repo: 'r', brief: 'b', verify_hint: 'npm test' }]) });
  delete r.deps.loadConfig;
  delete r.deps.enqueue;
  assert.equal(await dispatch(['enqueue', '--file', 'tasks.json'], r.deps), 0);
  assert.match(r.stderr(), /soma\.json/);
  const row = JSON.parse(readFileSync(join(home, 'state', 'fleet.json'), 'utf8')).tasks.find((x) => x.id === 'cr-2');
  assert.equal(row?.verify_hint, 'npm test');
});

test('enqueue\'s soma.json warning stays on one line when the parse error quotes the file across lines', async (t) => {
  const home = root(t);
  // A pretty-printed soma.json with a bare token. V8's JSON.parse message quotes the source
  // around the bad token, newlines included, and the real loadConfig passes that message on.
  writeFileSync(join(home, 'soma.json'), '{\n  "repos": {\n    "r": { "path": x }\n  }\n}\n');
  const { loadConfig } = await import('../bin/lib/config.mjs');
  assert.throws(() => loadConfig(), (e) => /\n/.test(e.message), 'the premise: the real loadConfig error for this file spans lines');

  const r = mk({ readFile: () => JSON.stringify([{ id: 'cr-3', repo: 'r', brief: 'b', verify_hint: 'npm test' }]) });
  delete r.deps.loadConfig;
  delete r.deps.enqueue;
  assert.equal(await dispatch(['enqueue', '--file', 'tasks.json'], r.deps), 0);
  assert.equal(r.err.length, 1, `one warning, got: ${JSON.stringify(r.err)}`);
  assert.doesNotMatch(r.err[0], /\n/, 'on one line: the parse error is folded into it, not printed as the file excerpt it quotes');
  assert.match(r.err[0], /soma\.json/, 'naming the file that could not be read');
  const row = JSON.parse(readFileSync(join(home, 'state', 'fleet.json'), 'utf8')).tasks.find((x) => x.id === 'cr-3');
  assert.equal(row?.verify_hint, 'npm test', 'and the task still queues with its own hint');
});

test('enqueue reports what was DROPPED, not only what was queued', async (t) => {
  root(t);
  // `fleet.enqueue` skips an invalid or duplicate id rather than throwing, and says which:
  // one bad row in a plan of thirty must not cost the other twenty-nine. Printing only
  // `queued` is how "enqueued 30" hides four drops and a fleet quietly runs short.
  const h = mk({
    readFile: () => JSON.stringify([{ id: 'cr-1' }, { id: 'BAD' }, { id: 'cr-1' }]),
    enqueue: () => ({ queued: ['cr-1'], skipped: [{ id: null, reason: 'invalid-id' }, { id: 'cr-1', reason: 'duplicate' }] }),
  });
  assert.equal(await dispatch(['enqueue', '--file', 'tasks.json'], h.deps), 0);
  const s = h.stdout();
  assert.match(s, /skipped/i);
  assert.match(s, /invalid-id/);
  assert.match(s, /duplicate/);
});

test('enqueue that queued nothing at all exits non-zero', async (t) => {
  root(t);
  // Rows were offered and none was taken, so the fleet is unchanged. `queued 0` beside a zero
  // exit is how a plan of thirty duplicate ids reads as a success to whoever scripted it.
  const h = mk({
    readFile: () => JSON.stringify([{ id: 'BAD' }, { id: 'ALSO BAD' }]),
    enqueue: () => ({ queued: [], skipped: [{ id: null, reason: 'invalid-id' }, { id: null, reason: 'invalid-id' }] }),
  });
  assert.notEqual(await dispatch(['enqueue', '--file', 'tasks.json'], h.deps), 0);
  assert.match(h.stderr(), /nothing was queued/);

  // An empty array is not a failed enqueue: nothing was offered, so nothing was dropped.
  const none = mk({ readFile: () => '[]', enqueue: () => ({ queued: [], skipped: [] }) });
  assert.equal(await dispatch(['enqueue', '--file', 'tasks.json'], none.deps), 0);
});

test('enqueue refuses a file that is not a JSON array, and one that is not JSON', async (t) => {
  root(t);
  const notArray = mk({ readFile: () => '{"id":"cr-1"}' });
  assert.notEqual(await dispatch(['enqueue', '--file', 'tasks.json'], notArray.deps), 0);
  assert.match(notArray.stderr(), /array/);
  assert.equal(notArray.calls.enqueue.length, 0);

  const notJson = mk({ readFile: () => 'nope' });
  assert.notEqual(await dispatch(['enqueue', '--file', 'tasks.json'], notJson.deps), 0);
  assert.match(notJson.stderr(), /tasks\.json/);
  assert.equal(notJson.calls.enqueue.length, 0);
});

test('enqueue with no --file says which flag is missing instead of parsing undefined', async (t) => {
  root(t);
  const h = mk();
  assert.notEqual(await dispatch(['enqueue'], h.deps), 0);
  assert.match(h.stderr(), /--file/);
});

// --------------------------------------------------------------------------- usage

test('unknown subcommand exits non-zero with usage', async (t) => {
  root(t);
  const h = mk();
  assert.equal(await dispatch(['frobnicate'], h.deps), 1);
  assert.match(h.stdout().toLowerCase() + h.stderr().toLowerCase(), /usage/);
});

test('no subcommand at all is usage, and --help is a success', async (t) => {
  root(t);
  const bare = mk();
  assert.equal(await dispatch([], bare.deps), 1);
  const help = mk();
  assert.equal(await dispatch(['--help'], help.deps), 0);
  assert.match(help.stdout().toLowerCase(), /usage/);
});

test('--help carries the soma release / soma_release warning', async (t) => {
  root(t);
  // The footgun: `soma_release` hands back the ORCHESTRATOR LEASE; `soma release <lead>`
  // un-holds ONE LEAD. `skills/soma-promote/SKILL.md` §5 tells the operator both exist, so
  // the CLI's own help has to distinguish them where the operator is already looking.
  const h = mk();
  await dispatch(['--help'], h.deps);
  const s = h.stdout();
  // LOUDLY, which is the requirement: naming both verbs somewhere in the text is not enough —
  // the line has to say they are not the same thing, or an operator skims past it.
  assert.match(s, /`soma release <lead>` IS NOT `soma_release`/);
  assert.match(s, /ORCHESTRATOR LEASE/);
});

// ------------------------------------------------------------------------------ up

test('up prints the worst-case projection and does not open the queue before confirmation', async (t) => {
  root(t);
  const h = mk({ liveSessions: startsClean() }, { answer: true });
  assert.equal(await dispatch(['up'], h.deps), 0);
  const s = h.stdout();
  // The measured figure the operator kept `max_leads: 10` against, from `projectFleetSpend`.
  assert.match(s, /Fleet worst case: 10 leads/);
  assert.match(s, /200,000,000 est_tokens/);
  assert.equal(h.calls.confirm.length, 1, 'exactly one prompt, before anything starts');
  assert.equal(h.calls.newSession.length, 1);
  // Ordering is the requirement, not the presence of both: the projection is shown and
  // answered BEFORE the watchdog exists. Measured by index — the prompt string is pushed
  // during the arm, the session spec after it.
  assert.ok(s.indexOf('Fleet worst case') < s.indexOf('watchdog:'));
});

test('a declined confirmation opens nothing and does not report success', async (t) => {
  root(t);
  const h = mk();   // the recorder's default answer is no
  const code = await dispatch(['up'], h.deps);
  assert.notEqual(code, 0);
  assert.equal(h.calls.newSession.length, 0);
  assert.match(h.stdout() + h.stderr(), /abort/i);
});

test('up refuses when the confirmation cannot be asked at all', async (t) => {
  root(t);
  // `confirm` answers three states, not two, for the reason `holder_live` does: "the operator
  // said no" and "there was no terminal to ask" are different facts, and treating the second
  // as a yes is how a spend gate becomes a warning that scrolls past in a script.
  const h = mk({ confirm: () => null });
  assert.notEqual(await dispatch(['up'], h.deps), 0);
  assert.equal(h.calls.newSession.length, 0);
  assert.match(h.stderr(), /confirm/i);
});

test('up hands the watchdog an ABSOLUTE, NORMALISED SOMA_HOME', async (t) => {
  const home = root(t);
  // A TRAILING SLASH, deliberately: it is what tells `SOMA_HOME()` apart from the raw variable.
  // `/x/soma/` and `/x/soma` must be the SAME root, not two spellings of it — the resolver
  // collapses `//`, `/./`, `/../` and the trailing slash, and forwarding `process.env.SOMA_HOME`
  // verbatim (the sketch) would hand the watchdog the other spelling.
  process.env.SOMA_HOME = `${home}/`;
  const h = mk({}, { answer: true });
  await dispatch(['up'], h.deps);
  const env = h.calls.newSession[0].env;
  assert.equal(env.SOMA_HOME, home);
  assert.equal(isAbsolute(env.SOMA_HOME), true);
  // The sketch spelled this `process.env.SOMA_HOME || ''`, which forwards a RELATIVE value
  // verbatim. Ten state paths then resolve per-process — including the fleet checkpoint and
  // the lock beside it, so the mutex is taken on two different files, and the orchestrator
  // lease, so two sessions each believe they hold a single-holder lease.
  process.env.SOMA_HOME = 'relative/root';
  const rel = mk({}, { answer: true });
  assert.equal(await dispatch(['up'], rel.deps), 2);
  assert.equal(rel.calls.newSession.length, 0);
  assert.match(rel.stderr(), /SOMA_HOME must be an absolute path/);
});

test('up forwards the environment a watchdog and its leads cannot work without', async (t) => {
  root(t);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: '/tmp/cfgroot', SOMA_TMUX_SOCKET: 'soma-test', PATH: '/usr/bin', HOME: '/tmp/h' };
  const h = mk({ env }, { answer: true });
  await dispatch(['up'], h.deps);
  const wd = h.calls.newSession[0].env;
  // `newSession` runs the command under `env -i`, so what is not here does not exist for the
  // watchdog OR for the leads it spawns — `spawn.buildLeadEnv` copies `ENV_ALLOW` out of the
  // WATCHDOG's `process.env`. Dropping CLAUDE_CONFIG_DIR costs both the budget breaker (it
  // reads transcripts under the wrong root and meters zero for every lead) and every lead's
  // trust mark (claude stops on "Quick safety check" in a detached pane with nobody there).
  assert.equal(wd.CLAUDE_CONFIG_DIR, '/tmp/cfgroot');
  // A watchdog on a different tmux socket from the CLI that started it is the same class of
  // split as a forked state root: both processes are right by their own lights, and the
  // watchdog supervises a server with nothing on it.
  assert.equal(wd.SOMA_TMUX_SOCKET, 'soma-test');
  assert.equal(wd.PATH, '/usr/bin');
  assert.equal(wd.HOME, '/tmp/h');
  // Without USER every lead is `Not logged in`: OAuth lives in the macOS keychain and the
  // lookup does not resolve without it. Asserted HERE and not only in spawn.test.mjs because
  // `buildLeadEnv` copies out of the watchdog's env — ENV_ALLOW carrying it is not enough.
  assert.equal(wd.USER, process.env.USER);
});

/**
 * `ENV_ALLOW ⊆ WATCHDOG_ENV_ALLOW`, and it is a separate test so no sibling absorbs it.
 *
 * `spawn.buildLeadEnv` copies `spawn.ENV_ALLOW` out of the **watchdog's** `process.env`, and
 * `tmux.newSession` runs the watchdog under `env -i` with `WATCHDOG_ENV_ALLOW`. So a name in
 * `ENV_ALLOW` and not in `WATCHDOG_ENV_ALLOW` is one the lead is *declared* to receive and
 * cannot possibly get — and nothing reports it. The lead comes up missing the variable and
 * looks fine.
 *
 * Measured, which is why this test exists: `USER` was added to `ENV_ALLOW` and the leads were
 * STILL `Not logged in`, because this second list had not been touched. Both module comments
 * already described the coupling; the drift is what nothing caught. Two lists with a stated
 * dependency and no assertion tying them is the same shape as the duplicate-hook-registration
 * defect — redundant only while one is a subset of the other, and silently in conflict once
 * it is not.
 */
test('ENV_ALLOW is a subset of WATCHDOG_ENV_ALLOW, or a lead is declared a name it cannot receive', () => {
  const missing = [...ENV_ALLOW].filter((k) => !WATCHDOG_ENV_ALLOW.includes(k));
  assert.deepEqual(missing, [],
    `buildLeadEnv copies these out of the watchdog's env, and the watchdog is started under env -i with WATCHDOG_ENV_ALLOW — so ${missing.join(', ')} would be forwarded to nothing`);
});

test('up drops empty environment values rather than forwarding them', async (t) => {
  root(t);
  // soma spells "unset" as `''` and every reader uses `||`. Forwarding `CLAUDE_CONFIG_DIR=`
  // makes that true of soma and unverified of claude — and that is the one variable where the
  // two disagreeing is a silent hang.
  const h = mk({ env: { ...process.env, CLAUDE_CONFIG_DIR: '', PATH: '/usr/bin', HOME: '/tmp/h' } }, { answer: true });
  await dispatch(['up'], h.deps);
  assert.equal(Object.hasOwn(h.calls.newSession[0].env, 'CLAUDE_CONFIG_DIR'), false);
});

test('up runs the watchdog on THIS node, at a path that survives a space in it', async (t) => {
  root(t);
  const h = mk({}, { answer: true });
  await dispatch(['up'], h.deps);
  const { argv, logPath, name, cwd } = h.calls.newSession[0];
  // `engines.node` is >=24 and the whole suite is invisible on 20. `node` off the forwarded
  // PATH is whatever nvm last selected; `process.execPath` is the interpreter that got here.
  assert.equal(argv[0], process.execPath);
  assert.match(argv[1], /soma-watchdog\.mjs$/);
  // The measurement: the exact path, resolved the same way this test resolves it.
  assert.equal(argv[1], fileURLToPath(new URL('../bin/soma-watchdog.mjs', import.meta.url)));
  // DOCUMENTATION, NOT A MEASUREMENT. `new URL(...).pathname` — the sketch — percent-encodes, so
  // a checkout under `/Users/x/My Repos/` yields `/Users/x/My%20Repos/...` and node resolves
  // nothing. This assertion cannot fail while the repo path contains no encodable character, and
  // no test can move the repo: `import.meta.url` is fixed before the suite runs. It records the
  // forbidden output; the equality above is what carries the weight, and it too is blind to the
  // difference on a clean path — the guard is `fileURLToPath` in the source, reviewed not tested.
  assert.doesNotMatch(argv[1], /%2[0-9A-Fa-f]/);
  assert.equal(name, 'soma-watchdog');
  assert.equal(isAbsolute(cwd), true);
  // `/dev/null` — the sketch — throws away the one record of why a watchdog died on startup.
  assert.match(logPath, /watchdog\.log$/);
});

test('up verifies the watchdog is running instead of trusting new-session', async (t) => {
  root(t);
  // A spawn call that returned proves tmux accepted the argv, nothing more: with a bad PATH
  // `env -i` cannot resolve the interpreter, tmux still exits 0, and the pane dies instantly.
  const gone = mk({ liveSessions: () => new Set() }, { answer: true });
  const code = await dispatch(['up'], gone.deps);
  assert.notEqual(code, 0, 'a watchdog that is not there afterwards is not a successful up');
  assert.match(gone.stderr(), /watchdog/);
  assert.ok(gone.stderr().includes('watchdog.log'), 'the transcript that holds the reason is named');

  const there = mk({ liveSessions: startsClean() }, { answer: true });
  assert.equal(await dispatch(['up'], there.deps), 0);
  assert.equal(there.calls.newSession.length, 1, 'this is the fresh-start path, not the idempotent one');
  assert.match(there.stdout(), /watchdog: live/);
});

test('up reports UNVERIFIED, not started, when tmux cannot be read back', async (t) => {
  root(t);
  let n = 0;
  // First read (the idempotency check) says nothing is running; the read-back says nothing
  // could be measured. "Not measured" must not collapse into either verdict.
  const h = mk({ liveSessions: () => (++n === 1 ? new Set() : null) }, { answer: true });
  const code = await dispatch(['up'], h.deps);
  assert.notEqual(code, 0);
  const all = h.stdout() + h.stderr();
  assert.match(all, /unverified/i);
  assert.doesNotMatch(all, /watchdog: live/);
});

test('up does not claim the queue is open while the pause flag is set', async (t) => {
  root(t);
  // The pause flag survives `soma down` and back up on purpose — a paused queue must stay paused
  // across a restart, or the pause belongs to one watchdog process rather than to the fleet — and
  // admission vetoes on it every tick. "the queue is open" over a set flag is the same defect as
  // a status reporting `queue_paused: true` while admission keeps spawning, sign flipped.
  const paused = mk({ liveSessions: startsClean(), queuePaused: () => true }, { answer: true });
  assert.equal(await dispatch(['up'], paused.deps), 0);
  assert.match(paused.stdout(), /watchdog: live/);
  assert.match(paused.stdout(), /PAUSED/);

  const open = mk({ liveSessions: startsClean() }, { answer: true });
  await dispatch(['up'], open.deps);
  assert.doesNotMatch(open.stdout(), /PAUSED/);
  assert.match(open.stdout(), /drain the queue/);
});

test('up does not claim the queue is open over a set pause flag on the ALREADY-LIVE path either', async (t) => {
  root(t);
  // The already-live early return said "the queue is already open" without reading the flag at
  // all: the check lived 90 lines below, on the fresh-start path only. That makes the operator's
  // most likely `up` — "is the fleet running?" — the one invocation that lies. The flag survives
  // `soma down` and back up on purpose and admission vetoes on it every tick, so a live watchdog
  // is NOT an open queue. The suite tested the two paths separately and never crossed them: the
  // pause test uses `startsClean()` (fresh path) and the idempotency test never set the flag.
  const paused = mk({ liveSessions: () => new Set(['soma-watchdog']), queuePaused: () => true }, { answer: true });
  assert.equal(await dispatch(['up'], paused.deps), 0);
  assert.equal(paused.calls.newSession.length, 0, 'this is the already-live path, not the fresh-start one');
  assert.match(paused.stdout(), /PAUSED/);
  assert.doesNotMatch(paused.stdout(), /queue is already open/, 'the false claim, in its own words');

  // THE CONTROL, and it is what makes the assertion above a measurement: with the flag CLEAR the
  // same path must still say the queue is open. Without this, an arm that simply stopped
  // mentioning the queue would pass — which is how deleting a line reads as fixing it.
  const open = mk({ liveSessions: () => new Set(['soma-watchdog']) }, { answer: true });
  assert.equal(await dispatch(['up'], open.deps), 0);
  assert.match(open.stdout(), /queue is already open/);
  assert.doesNotMatch(open.stdout(), /PAUSED/);
});

test('up prints the projection BEFORE it asks, not merely as well as', async (t) => {
  root(t);
  // ONE ORDERED TRACE, because two separate sinks cannot see a reorder. The previous assertion
  // compared `stdout.indexOf('Fleet worst case')` against `stdout.indexOf('watchdog:')` — but the
  // prompt is not on stdout in these tests at all, so moving `d.print(spend.message)` to AFTER
  // `confirm()` returns left it green, and the mutation that claimed to measure the ordering was a
  // duplicate of the one that deletes the print. The operator answering a spend prompt with no
  // figure on screen is the precise defect the requirement exists to prevent.
  //
  // `print` and `confirm` are both overridden here so the two land in the same array; `h.stdout()`
  // and `h.calls.confirm` are therefore not used by this test, and the recorder's prompt counting
  // is measured by the test above instead.
  const trace = [];
  const h = mk({
    liveSessions: startsClean(),
    print: (s) => { trace.push(`print:${s}`); },
    confirm: () => { trace.push('confirm'); return true; },
    newSession: () => { trace.push('newSession'); },
  });
  assert.equal(await dispatch(['up'], h.deps), 0);
  const projection = trace.findIndex((l) => l.startsWith('print:') && l.includes('Fleet worst case'));
  const prompt = trace.indexOf('confirm');
  const started = trace.indexOf('newSession');
  assert.notEqual(projection, -1, 'the projection is printed');
  assert.notEqual(prompt, -1, 'the operator is asked');
  assert.notEqual(started, -1, 'and on this path the watchdog is started');
  // The requirement in the order it was written: the figure is on screen BEFORE the question.
  assert.ok(projection < prompt, `projection must precede the prompt; trace was ${JSON.stringify(trace)}`);
  // And nothing starts until the question has been answered.
  assert.ok(prompt < started, `the prompt must precede the start; trace was ${JSON.stringify(trace)}`);
});

test('up is idempotent: a live watchdog is reported, not duplicated, and costs no prompt', async (t) => {
  root(t);
  const h = mk({ liveSessions: () => new Set(['soma-watchdog']) }, { answer: true });
  assert.equal(await dispatch(['up'], h.deps), 0);
  assert.equal(h.calls.newSession.length, 0);
  assert.equal(h.calls.confirm.length, 0, 'the queue is already open; nothing new is being spent');
  assert.match(h.stdout(), /already/i);
});

test('up, from a shell with no UTF-8 locale, reads a live watchdog as live and asks for no spend (#45)', { skip: !tmuxInstalled && 'tmux not installed' }, async (t) => {
  root(t);
  // `up`'s idempotency read through the REAL reader, over a real server with a live watchdog on it.
  // Without `-u` tmux printed the listing's tab as `_`, the watchdog read as absent, and `up` went on
  // to the worst-case spend prompt — and on a yes, to a second `new-session` for a name that exists.
  const srv = cLocaleTmux(t, 'soma-watchdog');
  const h = mk({ liveSessions: () => tmux.liveSessions(srv.run) }, { answer: true });
  assert.equal(await dispatch(['up'], h.deps), 0, h.stderr());
  assert.match(h.stdout(), /watchdog: live already/);
  assert.equal(h.calls.confirm.length, 0, 'the operator was asked to approve spend for a fleet that is already running');
  assert.equal(h.calls.newSession.length, 0, 'a second watchdog was started');
  assert.equal(srv.alive('soma-watchdog'), true);
});

test('up refuses when tmux cannot be read, before it projects, asks or starts anything (#66)', async (t) => {
  root(t);
  // `null` is "not measured" — a timeout, a missing binary, a permission error — and the already-
  // running check counted only a listing that HAD the watchdog, so `null` read as "none running": the
  // projection, the prompt, and on a yes a watchdog started beside one tmux could not show.
  const h = mk({ liveSessions: () => null }, { answer: true });
  assert.equal(await dispatch(['up'], h.deps), 3, h.stderr());
  assert.equal(h.calls.confirm.length, 0, 'the operator was asked to approve spend with the fleet\'s state unknown');
  assert.equal(h.calls.newSession.length, 0, 'a watchdog was started beside one tmux could not show');
  assert.doesNotMatch(h.stdout(), /worst case/i, 'nothing is projected on an unreadable tmux');
  assert.match(h.stderr(), /^soma up: tmux could not be read/m);
  assert.match(h.stderr(), /UNKNOWN/);
  assert.ok(h.stderr().includes(tmux.socketName()), 'the socket that could not be read is named');
  assert.match(h.stderr(), /`soma status`/, 'and how to check is said');
  assert.match(h.stderr(), /RUNBOOK §11\.10/);
  // The scan is for tmux's "no server" only; anything else unreadable refuses without it.
  assert.equal(h.calls.serverProcesses.length, 0);
});

test('up over a listing tmux answered but soma cannot parse refuses, through the real readers (#66)', async (t) => {
  root(t);
  // #45's mangled listing — exit 0, every tab a `_` — read by the REAL `liveSessions` and
  // `serverAbsent` over one stub transport. The listing is now `null`, and tmux answered, so it is not
  // "no server": `up` must refuse, not fall through to a second watchdog.
  const run = (args) => (args[0] === 'list-panes'
    ? { stdout: 'soma-watchdog_0\n', stderr: '', code: 0 }
    : { stdout: 'soma-watchdog\n', stderr: '', code: 0 });
  const h = mk({ liveSessions: () => tmux.liveSessions(run), serverAbsent: () => tmux.serverAbsent(run) }, { answer: true });
  assert.equal(await dispatch(['up'], h.deps), 3, h.stderr());
  assert.equal(h.calls.confirm.length, 0, 'the operator was asked to approve spend over a listing soma could not read');
  assert.equal(h.calls.newSession.length, 0, 'a second watchdog was started');
  assert.match(h.stderr(), /UNKNOWN/);
});

test('up on tmux\'s "no server" refuses while a tmux process for its socket is still alive, and names it (#66)', async (t) => {
  root(t);
  // RUNBOOK §11.10 measured two LIVE servers that say "no server answers": one whose socket file was
  // deleted while it ran, one wedged until its accept queue overflowed. A `new-session` in either
  // starts a SECOND server on the same path, beside the first and its running leads.
  const h = mk({ liveSessions: () => null, serverAbsent: () => true, serverProcesses: () => [4242, 4343] }, { answer: true });
  assert.equal(await dispatch(['up'], h.deps), 3, h.stderr());
  assert.equal(h.calls.confirm.length, 0, 'the operator was asked to approve spend beside a live server');
  assert.equal(h.calls.newSession.length, 0, 'a second server was started beside a live one');
  const e = h.stderr();
  assert.match(e, /pid 4242, 4343/, 'every process found is named, by pid');
  assert.ok(e.includes(`socket ${tmux.socketName()}`), 'and the socket it was found for');
  assert.match(e, /socket file was deleted/, 'the first of the two states');
  assert.match(e, /accept queue overflowed/, 'the second');
  assert.match(e, /kill -USR1 <pid>/, 'the recovery for a deleted socket file');
  assert.match(e, /kill -CONT <pid>/, 'and for a stopped server');
  assert.match(e, /`soma status`/);
});

test('up on tmux\'s "no server" refuses on ONE live tmux process for its socket, and names it (#66)', async (t) => {
  root(t);
  // One process is the ordinary case: the fleet's own server, its socket file deleted or its accept
  // queue overflowed. Every other refusal here passes two pids or none, so a check that wanted more
  // than one would pass them all and start a second server beside this one.
  const h = mk({ liveSessions: () => null, serverAbsent: () => true, serverProcesses: () => [4242] }, { answer: true });
  assert.equal(await dispatch(['up'], h.deps), 3, h.stderr());
  assert.equal(h.calls.confirm.length, 0, 'the operator was asked to approve spend beside a live server');
  assert.equal(h.calls.newSession.length, 0, 'a second server was started beside a live one');
  assert.match(h.stderr(), /\(pid 4242\)/, 'the one process found is named, by pid');
});

test('up on tmux\'s "no server" refuses when the process table cannot be read (#66)', async (t) => {
  root(t);
  // "Cannot tell" is not "none found": the second is the answer that starts a server.
  const h = mk({ liveSessions: () => null, serverAbsent: () => true, serverProcesses: () => null }, { answer: true });
  assert.equal(await dispatch(['up'], h.deps), 3, h.stderr());
  assert.equal(h.calls.confirm.length, 0);
  assert.equal(h.calls.newSession.length, 0);
  assert.match(h.stderr(), /process table could not be read/);
  assert.match(h.stderr(), /RUNBOOK §11\.10/);
});

test('up on tmux\'s "no server" with no tmux process for its socket is a fresh machine: projection, prompt, start (#66)', async (t) => {
  root(t);
  // The control for the three refusals above, and where every machine stands before its first `soma
  // up`: no server answers, and no tmux for the socket is alive. That one goes on exactly as before.
  let n = 0;
  const h = mk({ liveSessions: () => (++n === 1 ? null : new Set(['soma-watchdog'])), serverAbsent: () => true }, { answer: true });
  assert.equal(await dispatch(['up'], h.deps), 0, h.stderr());
  assert.equal(h.calls.serverProcesses.length, 1, 'the process table was looked at, once, before starting a server');
  assert.match(h.stdout(), /Fleet worst case/);
  assert.equal(h.calls.confirm.length, 1);
  assert.equal(h.calls.newSession.length, 1);
  assert.match(h.stdout(), /watchdog: live \(tmux session soma-watchdog/);
});

test('up refuses a state root that cannot take a hard link, once, before anything starts', async (t) => {
  root(t);
  // Without `link(2)` every `withFleetLock` acquisition throws the same diagnosis for the
  // deployment's lifetime. Probing once at startup is the difference between one refusal an
  // operator can act on and a watchdog that reprints it every 30 s forever.
  const h = mk({ linkProbe: () => ({ ok: false, code: 'ENOTSUP', dir: '/vol/state' }) }, { answer: true });
  assert.equal(await dispatch(['up'], h.deps), 2);
  assert.equal(h.calls.newSession.length, 0);
  assert.equal(h.calls.confirm.length, 0);
  const e = h.stderr();
  assert.match(e, /ENOTSUP/);
  assert.match(e, /hard link/i);
  assert.ok(e.includes('/vol/state'), 'the volume that refused is named, not just the requirement');
});

test('up refuses a seats that is not an array before it projects, asks, or starts anything', async (t) => {
  const home = root(t);
  // The REAL loader, not the stub `mk` carries: the refusal under test is loadConfig's, and a
  // stubbed config would measure only the stub. A watchdog started on this file used to read `{}`
  // as "no seats" and revive dead leads into a spawner that throws on it, after the kill and the
  // attempt charge.
  const { loadConfig } = await import('../bin/lib/config.mjs');
  writeFileSync(join(home, 'soma.json'), JSON.stringify({ seats: {} }));
  const h = mk({ loadConfig }, { answer: true });
  assert.equal(await dispatch(['up'], h.deps), 2);
  assert.match(h.stderr(), /^soma up: .*\bseats\b/m, 'the refusal must name the key');
  assert.doesNotMatch(h.stdout(), /worst case/i, 'a spend projection was printed from a config soma refuses');
  assert.equal(h.calls.confirm.length, 0, 'the operator was asked to approve spend on a refused config');
  assert.equal(h.calls.newSession.length, 0, 'a watchdog was started on a refused config');
});

test('up beside a watchdog already running reads soma.json too, and refuses one that watchdog is refusing (#53)', async (t) => {
  const home = root(t);
  // The already-live path returned before soma.json was ever read: on a file the loader refuses it
  // printed "the queue is already open" and exited 0, while the running watchdog — which loads the
  // same file at the top of every tick — logged WATCHDOG_ERROR on each one and admitted nothing. A
  // fresh `soma up` on the same file exits 2 naming the key. The REAL loader, as in the test above.
  const { loadConfig } = await import('../bin/lib/config.mjs');
  writeFileSync(join(home, 'soma.json'), JSON.stringify({ seats: {} }));
  const h = mk({ loadConfig, liveSessions: () => new Set(['soma-watchdog']) }, { answer: true });
  assert.equal(await dispatch(['up'], h.deps), 2, 'the exit a fresh `soma up` gives the same file');
  assert.match(h.stderr(), /^soma up: .*\bseats\b/m, 'the refusal must name the key');
  assert.match(h.stderr(), /watchdog .*is refusing it/, 'and say the running watchdog is refusing the same file');
  assert.match(h.stderr(), /admits nothing/, 'and what that costs: nothing is admitted until it is fixed');
  assert.doesNotMatch(h.stdout(), /queue is already open/, 'the false claim, in its own words');
  assert.equal(h.calls.confirm.length, 0);
  assert.equal(h.calls.newSession.length, 0);

  // THE CONTROL: the same path over a file the loader accepts is unchanged — exit 0, the queue line,
  // and nothing on stderr. Without it, an arm that refused every live `up` would pass the above.
  writeFileSync(join(home, 'soma.json'), JSON.stringify({ seats: [] }));
  const ok = mk({ loadConfig, liveSessions: () => new Set(['soma-watchdog']) }, { answer: true });
  assert.equal(await dispatch(['up'], ok.deps), 0, ok.stderr());
  assert.match(ok.stdout(), /queue is already open/);
  assert.equal(ok.stderr(), '');
  assert.equal(ok.calls.confirm.length, 0);
});

test('up --canary does not open the queue on a verdict that is not a pass', async (t) => {
  root(t);
  const bad = mk({ canary: async () => false }, { answer: true });
  assert.notEqual(await dispatch(['up', '--canary'], bad.deps), 0);
  assert.equal(bad.calls.newSession.length, 0, 'the canary IS the gate that opens the queue');
  assert.match(bad.stderr(), /canary/i);

  const good = mk({ canary: async () => true, liveSessions: () => new Set(['soma-watchdog']) }, { answer: true });
  // The idempotency read sees the watchdog already up, so this measures only that a passing
  // canary is not itself treated as a failure.
  assert.equal(await dispatch(['up', '--canary'], good.deps), 0);
});

test('up --canary through the REAL canary wiring refuses with exit 3 and the documented message, on both paths', async (t) => {
  root(t);
  // Every other --canary test stubs `canary`, which is how the real wiring shipped a crash: the
  // production dep called `runCanary()` with no driver, `probeCanary` threw its "needs a live
  // driver" TypeError, nothing in `up` caught it, and the CLI's last-resort handler exited 2 — where
  // the help text and RUNBOOK §5.3/§5.4 promise "unproven" and a refusal with exit 3. So `canary`
  // here is `realDeps().canary`, exactly as `soma up --canary` calls it. `runCanary` writes its
  // verdict straight to process.stderr, which is captured for the run and restored after.
  const verdict = [];
  const realWrite = process.stderr.write;
  t.after(() => { process.stderr.write = realWrite; });
  const run = async (h) => {
    process.stderr.write = (chunk) => { verdict.push(String(chunk)); return true; };
    try {
      return await dispatch(['up', '--canary'], h.deps);
    } catch (e) {
      return assert.fail(`soma up --canary threw instead of refusing (the CLI would exit 2): ${e?.message}`);
    } finally {
      process.stderr.write = realWrite;
    }
  };
  for (const [path, over, live] of [
    ['a fresh start', { liveSessions: startsClean() }, false],
    ['an already-live watchdog', { liveSessions: () => new Set(['soma-watchdog']) }, true],
  ]) {
    verdict.length = 0;
    const h = mk({ ...over, canary: realDeps().canary }, { answer: true });
    assert.equal(await run(h), 3, `${path}: --canary must refuse with exit 3`);
    if (live) {
      // A watchdog is running and draining the queue — the line above the refusal says so — so
      // "the queue was not opened" would be false here. Say what --canary did NOT do instead.
      assert.doesNotMatch(h.stderr(), /the queue was not opened/, `${path}: the queue is open, and the refusal must not say otherwise`);
      assert.match(h.stderr(), /the canary did not report a pass/, `${path}: the refusal still names the verdict`);
      assert.match(h.stderr(), /already running is untouched/, `${path}: the running watchdog is left as it is`);
      assert.match(h.stderr(), /`soma down`/, `${path}: and the verb that does stop a fleet is named`);
    } else {
      assert.match(h.stderr(), /the canary did not report a pass, so the queue was not opened/, `${path}: the documented canaryRefusal() message`);
    }
    assert.match(h.stderr(), /NOTE, because it is the likeliest reason on this build/, `${path}: the note about the unbuilt driver stays`);
    const everything = `${h.stderr()}\n${verdict.join('')}`;
    assert.doesNotMatch(everything, /needs a live driver/, `${path}: a wiring error must not stand in for the verdict`);
    assert.match(verdict.join(''), /canary: ERROR — the canary did not run/, `${path}: the verdict is on stderr above the refusal`);
    assert.match(verdict.join(''), /not built/, `${path}: and it says why nothing was proven`);
    assert.doesNotMatch(h.stdout(), /canary: pass/, path);
    assert.equal(h.calls.newSession.length, 0, `${path}: no watchdog was started by --canary`);
  }
});

test('up wraps ensureTree rather than letting a library throw reach the operator as a stack', async (t) => {
  root(t);
  process.env.SOMA_HOME = 'not/absolute';
  const h = mk({}, { answer: true });
  assert.equal(await dispatch(['up'], h.deps), 2);
  const e = h.stderr();
  assert.match(e, /^soma: /m);
  assert.match(e, /SOMA_HOME must be an absolute path/);
  // The whole diagnosis, verbatim from `paths.mjs`: this refusal is a backstop a correct
  // launch never reaches, so the message is all that survives to explain itself.
  assert.match(e, /each process's own cwd/);
  assert.equal(e.includes('    at '), false, 'a stack trace, not a diagnosis, is what the wrap removes');
});

test('init wraps ensureTree the same way', async (t) => {
  root(t);
  process.env.SOMA_HOME = './rel';
  const h = mk();
  assert.equal(await dispatch(['init'], h.deps), 2);
  assert.match(h.stderr(), /SOMA_HOME must be an absolute path/);
  assert.equal(h.calls.capture.length, 0, 'nothing is registered against a root soma refused');
});

// ---------------------------------------------------------------------------- down

test('down stops the watchdog and says what it did NOT stop', async (t) => {
  root(t);
  const h = mk();   // the recorder's default already reports a session that was there
  assert.equal(await dispatch(['down'], h.deps), 0);
  assert.deepEqual(h.calls.killSession, ['soma-watchdog']);
  assert.match(h.stdout(), /lead/i);

  // Zero either way, symmetrically with `up`'s already-running path: an already-stopped watchdog
  // is the state the operator asked for, and `soma down && …` must not break on a second run.
  // NOTE the stub: `liveSessions` answers an empty Set, so tmux WAS read back and reports none.
  // That is what makes this the verified-absent case rather than the unreachable-tmux one below.
  const absent = mk({ killSession: () => false });
  assert.equal(await dispatch(['down'], absent.deps), 0);
  assert.match(absent.stdout() + absent.stderr(), /no session/i);
  // The absence is a READING, not the mere lack of a success. Rendering the two identically is
  // what made a tmux that could not be reached indistinguishable from a fleet that is stopped.
  assert.match(absent.stdout(), /read back/i);
});

test('down refuses to report a fleet stopped on a kill it could not verify', async (t) => {
  root(t);
  // `tmux.killSession` is `run([...]).code === 0`, and `tmux.defaultRun` NEVER THROWS: a missing
  // binary, a wrong SOMA_TMUX_SOCKET and its own 5 s SIGKILL timeout all map to `{code: 1}`. So a
  // `false` conflates "there was no such session" with "tmux could not be reached at all", and
  // the try/catch a caller wraps around the call is unreachable — the third state is structurally
  // invisible from the boolean. Read as the first, the second tells the operator the fleet is
  // stopped while the watchdog may still be spawning, reviving, metering and reaping. So the arm
  // reads the server back with `liveSessions`, which is where `status`, `up` and `resume` already
  // take their own third state from.
  const unknown = mk({ killSession: () => false, liveSessions: () => null });
  assert.equal(await dispatch(['down'], unknown.deps), 3, 'an unverified stop is not a stopped fleet');
  const u = unknown.stdout() + unknown.stderr();
  assert.match(u, /UNVERIFIED/);
  // The exact sentence the old arm printed for this state, at exit 0. It is the defect, so it is
  // named: an assertion on the new wording alone would pass for an arm that had merely added a
  // line while still claiming nothing was running.
  assert.doesNotMatch(u, /no session named soma-watchdog was running/);

  // tmux ANSWERED, and the session is still there: the kill did not take, and the watchdog is
  // still supervising the fleet. A different fact from "not measured", and a different message.
  const stillLive = mk({ killSession: () => false, liveSessions: () => new Set(['soma-watchdog']) });
  assert.equal(await dispatch(['down'], stillLive.deps), 3);
  assert.match(stillLive.stderr(), /still reports soma-watchdog as live/);

  // A THROW from the call is no more knowledge about the SESSION than a `false` is, so it goes to
  // the same read-back rather than being reported as an absence.
  const threw = mk({ killSession: () => { throw new Error('tmux gone'); }, liveSessions: () => null });
  assert.equal(await dispatch(['down'], threw.deps), 3);
  assert.match(threw.stderr(), /tmux gone/);

  // Every one of these still says what `down` did NOT do. The leads keep running unsupervised
  // whether or not the watchdog stopped, and that is the thing operators get wrong about it.
  for (const h of [unknown, stillLive, threw]) assert.match(h.stdout(), /Running leads were NOT stopped/);
});

test('down when no tmux server answers on soma\'s socket reports nothing running and exits 0 — kill still refuses on the same reading', async (t) => {
  root(t);
  // On a machine that never started soma's server, `soma down` printed UNVERIFIED and exited 3 —
  // breaking the `soma down && …` this arm promises, on the most ordinary machine there is. tmux
  // said why it could list nothing: no server answers on the socket, so no watchdog either.
  const none = mk({ killSession: () => false, liveSessions: () => null, serverAbsent: () => true });
  assert.equal(await dispatch(['down'], none.deps), 0);
  assert.equal(none.stdout().split('\n').find((l) => l.startsWith('watchdog:')),
    `watchdog: no session named soma-watchdog was running (no tmux server answers on socket ${tmux.socketName()}).`);
  assert.doesNotMatch(none.stdout() + none.stderr(), /UNVERIFIED/);
  assert.match(none.stdout(), /Running leads were NOT stopped/, 'said every time: leads are separate sessions');

  // Any other unreadable tmux is still UNVERIFIED and exit 3: the probe said nothing about a server.
  const unknown = mk({ killSession: () => false, liveSessions: () => null, serverAbsent: () => false });
  assert.equal(await dispatch(['down'], unknown.deps), 3);
  assert.match(unknown.stderr(), /UNVERIFIED/);
  assert.doesNotMatch(unknown.stdout(), /no session named soma-watchdog was running/);

  // `kill` does NOT take this reading, and its arm is unchanged. "error connecting … (No such file
  // or directory)" says only that the socket FILE is missing, which is also what a live server looks
  // like after a /tmp cleaner deleted its socket — and `kill`'s answer to an absence is a `failed`
  // row over what may be a live lead, the destructive case `stopper` exists to refuse. `down` writes
  // nothing on it.
  const fleet = () => ({ tasks: [{ id: 'cr-1', status: 'spawned' }] });
  const k = mk({ readFleet: fleet, killSession: () => false, liveSessions: () => null, serverAbsent: () => true });
  assert.equal(await dispatch(['kill', 'cr-1'], k.deps), 3);
  assert.equal(k.calls.setTaskStatus.length, 0, 'no failed row over a possibly-live lead');
  assert.match(k.stderr(), /NOT killed/);
  assert.match(k.stderr(), /cannot tell/i);
  assert.equal(k.calls.appendEvent.some((a) => a.ev.type === 'KILLED'), false);
  assert.ok(k.calls.appendEvent.some((a) => a.ev.type === 'KILL_REFUSED'));
});

// ---------------------------------------------------------------------------- init

test('init installs the promote skill under the resolved claude config root', async (t) => {
  root(t);
  const h = mk({
    env: { ...process.env, CLAUDE_CONFIG_DIR: '/tmp/cfgroot-skill' },
    installSkill: (cfgRoot) => { h.calls.installSkill.push(cfgRoot); return { ok: true, dest: '/cfg/skills/soma-promote' }; },
  });
  assert.equal(await dispatch(['init'], h.deps), 0);
  // The ARGUMENT, not just the dest the installer echoed back. `CLAUDE_CONFIG_DIR` moves this
  // root, and a skill written under a hard-coded `~/.claude` on a machine where it is set is a
  // `/soma-promote` that does not exist — with nothing erroring, because the copy succeeds.
  assert.deepEqual(h.calls.installSkill, ['/tmp/cfgroot-skill']);
  const s = h.stdout();
  assert.ok(s.includes('/cfg/skills/soma-promote'), 'without this /soma-promote does not exist on a real machine');
});

test('init reports a failed skill install as a failure', async (t) => {
  root(t);
  const h = mk({ installSkill: () => ({ ok: false, dest: '/cfg/skills/soma-promote', error: 'EACCES' }) });
  assert.notEqual(await dispatch(['init'], h.deps), 0);
  assert.match(h.stderr(), /EACCES/);
});

test('init registers the bus at user scope with no static session identity', async (t) => {
  root(t);
  const h = mk();
  assert.equal(await dispatch(['init'], h.deps), 0);
  const add = h.calls.capture.find((c) => c.args.includes('add'));
  assert.ok(add, 'the bus is registered, or no session ever carries soma_adopt');
  const flat = add.args.join(' ');
  assert.match(flat, /-s user/);
  // MEASURED: two sessions sharing one identity BOTH get `already_held: true`, and either can
  // `soma_release` the other's lease — a session that never held it unmounts the real
  // orchestrator. Precedence contains it today (`CLAUDE_CODE_SESSION_ID` wins while present);
  // planting the variable is what makes the hazard reachable.
  assert.doesNotMatch(flat, /SOMA_SESSION_ID/);
  assert.ok(add.args.some((a) => /soma-bus\.mjs$/.test(a)), 'the absolute bus path is what gets registered');
  assert.equal(add.args.includes(process.execPath), true);
});

test('init verifies the registration landed instead of trusting the exit code', async (t) => {
  root(t);
  // A `claude mcp add` that exits 0 having written nothing readable is the same defect one
  // layer out from a watchdog reported as started because a spawn call returned.
  const blind = mk({
    capture: (cmd, args) => (args.includes('get')
      ? { stdout: '', stderr: 'No MCP server found', code: 1 }
      : { stdout: '', stderr: '', code: 0 }),
  });
  assert.notEqual(await dispatch(['init'], blind.deps), 0);
  assert.match(blind.stderr(), /soma/);

  const seen = mk({
    capture: (cmd, args) => (args.includes('get')
      ? { stdout: 'soma: node /abs/bin/soma-bus.mjs', stderr: '', code: 0 }
      : { stdout: '', stderr: '', code: 0 }),
  });
  assert.equal(await dispatch(['init'], seen.deps), 0);
  assert.match(seen.stdout(), /soma-bus\.mjs/);
});

/**
 * The registration must carry the state root, and the read-back must have THREE outcomes.
 *
 * MEASURED on a real fleet: with `env: {}` in the entry, a session promoted from a second
 * profile's Claude mounted a bus rooted at `~/.soma` while the live fleet was in
 * `~/.soma-second`. `soma_adopt` succeeded, `soma_status` showed an empty fleet, the running lead
 * was invisible, and nothing errored — an existing-but-empty root and a fleet that has not
 * started are the same reading. `~/.soma` existed, left by this repo's own test fixtures.
 *
 * The third outcome is the point. "The output names a different root" is a failure; "the output
 * names no root at all" is NOT, because `claude mcp get`'s format is not soma's to pin, and a
 * format change must not read as a wrong root. Two states over a three-state world is the shape
 * that produced most of this build's near-misses.
 */
test('init pins SOMA_HOME into the registration, and the read-back has three outcomes not two', async (t) => {
  const home = root(t);

  // 1. the argv carries it
  const h = mk({ capture: (cmd, args) => { h.calls.capture.push({ cmd, args }); return args.includes('get')
    ? { stdout: `soma: node /abs/bin/soma-bus.mjs\n  SOMA_HOME=${home}`, stderr: '', code: 0 }
    : { stdout: '', stderr: '', code: 0 }; } });
  assert.equal(await dispatch(['init'], h.deps), 0);
  const add = h.calls.capture.find((c) => c.args.includes('add'));
  assert.ok(add.args.includes('-e'), 'without -e the bus silently resolves ~/.soma');
  assert.ok(add.args.includes(`SOMA_HOME=${home}`), 'the root is pinned at registration, not left to the session');
  assert.match(h.stdout(), new RegExp(`SOMA_HOME=${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    'and it is reported, so the operator can see which fleet a promoted session would drive');

  // 2. a DIFFERENT root is a failure — this is the bug, caught
  const wrong = mk({ capture: (cmd, args) => (args.includes('get')
    ? { stdout: 'soma: node /abs/bin/soma-bus.mjs\n  SOMA_HOME=/somewhere/else', stderr: '', code: 0 }
    : { stdout: '', stderr: '', code: 0 }) });
  assert.notEqual(await dispatch(['init'], wrong.deps), 0);
  assert.match(wrong.stderr(), /SOMA_HOME/);

  // 3. NO root named is not a failure — the format is not ours to pin — but it is not silence
  const quiet = mk({ capture: (cmd, args) => (args.includes('get')
    ? { stdout: 'soma: node /abs/bin/soma-bus.mjs', stderr: '', code: 0 }
    : { stdout: '', stderr: '', code: 0 }) });
  assert.equal(await dispatch(['init'], quiet.deps), 0, 'a format soma does not recognise is not a failed install');
  assert.match(quiet.stderr(), /could not confirm/, 'but it must say what it could not observe');
});

/**
 * The inject-hook line is a claim about the world, so it must be READ from the world — and it
 * has three answers, not two.
 *
 * MEASURED: this arm printed `inject hook: NOT installed` unconditionally. An operator wired the
 * hook into `settings.json` by hand, verified it firing in both profiles, and `soma init` went on
 * reporting it missing. The comment that used to stand here reasoned about one way the message
 * could go stale (someone finding `orch-inject.mjs` on disk) and missed this one.
 *
 * "soma init does not write user settings.json" was never the false part and is still true. The
 * false part was asserting a registration state nothing had looked at.
 *
 * The third state is the one worth the separate assertion: an unreadable or absent settings.json
 * is NOT evidence of absence, and printing it as "NOT installed" is the same two-state-over-a-
 * three-state-world shape as a doctor row that reads `pass` because no observation happened.
 */
test('the inject-hook line is observed, and has three states not two', async (t) => {
  root(t);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: '/tmp/cfgroot' };
  const withSettings = (readFile) => mk({ env, readFile });

  // 1. wired by hand -> says registered, and says soma init did not do it
  const on = withSettings(() => JSON.stringify({ hooks: { UserPromptSubmit: [
    { matcher: '', hooks: [{ type: 'command', command: 'SOMA_HOME=/x node /a/bin/hooks/orch-inject.mjs' }] },
  ] } }));
  await dispatch(['init'], on.deps);
  assert.match(on.stdout(), /inject hook: registered/);
  assert.match(on.stdout(), /wired it by hand/, 'so nobody credits soma init with an install it did not do');
  assert.doesNotMatch(on.stdout(), /inject hook: NOT installed/);
  assert.match(on.stdout(), /pins SOMA_HOME/, 'a hook on the wrong root reads the default state root');

  // 2. readable and absent -> the original message, now earned rather than asserted
  const off = withSettings(() => JSON.stringify({ model: 'opus' }));
  await dispatch(['init'], off.deps);
  assert.match(off.stdout(), /inject hook: NOT installed/);
  assert.doesNotMatch(off.stdout(), /NOT OBSERVED/);

  // 3. unreadable -> NEITHER. A missing file is not evidence of a missing hook.
  const blind = withSettings(() => { throw new Error('ENOENT: no such file'); });
  await dispatch(['init'], blind.deps);
  assert.match(blind.stdout(), /NOT OBSERVED/);
  assert.match(blind.stdout(), /ENOENT/, 'and it names what stopped it, so the operator can fix the right thing');
  assert.doesNotMatch(blind.stdout(), /inject hook: NOT installed/,
    'an unreadable settings.json reported as "not installed" is an assertion about something nothing read');
  assert.doesNotMatch(blind.stdout(), /inject hook: registered/);

  // 4. a hook on some OTHER script is not this hook — the match must be on the command, not on
  //    the mere existence of a UserPromptSubmit entry.
  const other = withSettings(() => JSON.stringify({ hooks: { UserPromptSubmit: [
    { matcher: '', hooks: [{ type: 'command', command: 'node /a/bin/hooks/something-else.mjs' }] },
  ] } }));
  await dispatch(['init'], other.deps);
  assert.match(other.stdout(), /inject hook: NOT installed/);

  // 5. malformed JSON is unreadable, not absent — same reasoning as (3).
  const junk = withSettings(() => '{ not json');
  await dispatch(['init'], junk.deps);
  assert.match(junk.stdout(), /NOT OBSERVED/);
});

/**
 * The socket is pinned too, and for a consequence the root's pin does not cover.
 *
 * MEASURED: with two fleets — one on the default socket, a second on `soma_second` —
 * `soma_second` was in the second registration only because it had been added by hand. `init`
 * never wrote it, so a re-run would have dropped it silently. The second bus would then send
 * wake keystrokes on socket `soma` **addressed by a pane id from `soma_second`**: a second-fleet
 * lead's NEEDS_INPUT typed into whatever `%0` happens to be on the FIRST server.
 *
 * `wake()` hands `sendKeys` only `lease.tmux_pane`, never the lease's recorded `tmux_socket`, so
 * the bus's own environment is the only thing choosing the server. A pane id is meaningless
 * across servers, which is why a wrong socket is worse than a missing one.
 *
 * The value must come from `tmux.socketName()`, not from a fresh read of the environment here:
 * there were already two spellings of that resolution, and a third in `soma.mjs` could pin a
 * socket this process's own tmux calls do not use.
 */
test('init pins SOMA_TMUX_SOCKET, or one fleet wakes another fleet\'s panes', async (t) => {
  root(t);
  const tmuxMod = await import('../bin/lib/tmux.mjs');
  const sock = tmuxMod.socketName();
  assert.equal(sock, 'soma-t24-cli-test',
    'the suite sets a throwaway socket before tmux.mjs loads; if this drifts the pins below are meaningless');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: '/tmp/cfgroot' };

  // 1. the argv carries it, and carries the SAME value tmuxArgs uses
  const h = mk({ env, readFile: () => '{}', capture: (cmd, args) => { h.calls.capture.push({ cmd, args }); return args.includes('get')
    ? { stdout: `soma: node /abs/bin/soma-bus.mjs\n  SOMA_HOME=/x\n  SOMA_TMUX_SOCKET=${sock}`, stderr: '', code: 0 }
    : { stdout: '', stderr: '', code: 0 }; } });
  await dispatch(['init'], h.deps);
  const add = h.calls.capture.find((c) => c.args.includes('add'));
  assert.ok(add.args.includes(`SOMA_TMUX_SOCKET=${sock}`),
    'without this, a re-run of init drops a second fleet\'s socket and its wakes cross servers');
  assert.ok(tmuxMod.tmuxArgs(['x']).includes(sock),
    'the pinned value must be the one this process actually talks to');
  assert.match(h.stdout(), new RegExp(`tmux socket pinned to ${sock}`));

  // 2. a DIFFERENT socket is a failure — this is the cross-server wake, caught
  const wrong = mk({ env, readFile: () => '{}', capture: (cmd, args) => (args.includes('get')
    ? { stdout: 'soma: node /abs/bin/soma-bus.mjs\n  SOMA_HOME=/x\n  SOMA_TMUX_SOCKET=someone-elses', stderr: '', code: 0 }
    : { stdout: '', stderr: '', code: 0 }) });
  assert.notEqual(await dispatch(['init'], wrong.deps), 0);
  assert.match(wrong.stderr(), /SOMA_TMUX_SOCKET/);
  assert.match(wrong.stderr(), /another tmux server/);

  // 3. no socket named -> DECLINES. The output format is not soma's to pin, so a format change
  //    must not read as a wrong socket, nor as a confirmed one.
  const quiet = mk({ env, readFile: () => '{}', capture: (cmd, args) => (args.includes('get')
    ? { stdout: 'soma: node /abs/bin/soma-bus.mjs', stderr: '', code: 0 }
    : { stdout: '', stderr: '', code: 0 }) });
  assert.equal(await dispatch(['init'], quiet.deps), 0, 'an unrecognised format is not a failed install');
  assert.match(quiet.stderr(), /could not confirm.*SOMA_TMUX_SOCKET/s);
  assert.doesNotMatch(quiet.stdout(), /tmux socket pinned to/);
});

test('init reports a failed `mcp add` on the add itself, not via the read-back', async (t) => {
  root(t);
  // The `add` fails and the `get` would SUCCEED. A stub that failed both would let the read-back
  // guard absorb this, and the add guard could be deleted with every test still green — which is
  // exactly how a toothless assertion hides behind its neighbour.
  const h = mk({
    capture: (cmd, args) => { h.calls.capture.push({ cmd, args }); return args.includes('add')
      ? { stdout: '', stderr: 'claude: command not found', code: 127 }
      : { stdout: 'soma: node /abs/bin/soma-bus.mjs', stderr: '', code: 0 }; },
  });
  assert.notEqual(await dispatch(['init'], h.deps), 0);
  assert.match(h.stderr(), /command not found/);
  assert.match(h.stderr(), /mcp add/);
});

test('init prints every root it resolved, and the one thing it did not install', async (t) => {
  const home = root(t);
  const h = mk({ env: { ...process.env, CLAUDE_CONFIG_DIR: '/tmp/cfgroot' } });
  await dispatch(['init'], h.deps);
  const s = h.stdout();
  assert.ok(s.includes(home), 'the state root');
  assert.ok(s.includes('/tmp/cfgroot'), 'the claude config root — CLAUDE_CONFIG_DIR moves it');
  // The lease-gated UserPromptSubmit inject hook is not registered. Silence would leave an
  // orchestrator believing its event feed is wired and going blind to NEEDS_INPUT.
  assert.match(s, /inject hook/i);
  assert.match(s, /orch-inject/);
  // THE REASON MUST BE ONE THAT STAYS TRUE. It used to say "bin/hooks/orch-inject.mjs is not on
  // this branch", which was true of the branch this arm was written on and stops being true the
  // moment the hook lands — it is on the integration branch now — at which point the message
  // becomes a lie the first time an operator goes looking for the file. Presence of the file was
  // never the reason; absence of anything that writes user settings.json is, and that is
  // checkable from here.
  assert.doesNotMatch(s, /not on this branch/);
  assert.match(s, /settings\.json/);
});

// ---------------------------------------------------------------------------- init --seat

/**
 * A real, empty seat directory: `init --seat` refuses one that does not exist.
 *
 * Named `emptySeatDir`, not `seatDir`: the `resume` arm below already declares a
 * block-scoped `const seatDir` of its own, and two same-named bindings one scope apart in
 * one file is the shape a later reader mis-reads.
 */
const emptySeatDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'soma-seat-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('init --seat refuses a missing, empty, relative or absent directory before touching anything, and expands ~ through resolveConfigDir', async (t) => {
  const home = root(t);
  // Usage errors: no value, a flag where the value should be, an empty string (resolveConfigDir's
  // TypeError), two relative spellings. Exit 1, nothing installed, nothing registered.
  for (const argv of [['init', '--seat'], ['init', '--seat', '--force'], ['init', '--seat', ''], ['init', '--seat', 'seat-b'], ['init', '--seat', './seat-b']]) {
    const h = mk();
    assert.equal(await dispatch(argv, h.deps), 1, JSON.stringify(argv));
    assert.match(h.stderr(), /--seat/, JSON.stringify(argv));
    assert.equal(h.calls.installSkill.length + h.calls.capture.length, 0, `${JSON.stringify(argv)}: refused, yet something was installed or registered`);
    // "before touching anything" is an ORDERING property, and installSkill/capture alone did not
    // hold it: move the whole --seat block after `tree()` and both stay at zero while the real
    // `ensureTree()` has already created the state root's seven subdirs. The state
    // root is a fresh empty mkdtemp, so anything in it was made by this refused run.
    assert.deepEqual(readdirSync(home), [], `${JSON.stringify(argv)}: refused, yet the state tree was created — the flag is parsed before tree()`);
  }
  // `--seat` with no value has its OWN refusal, and the better sentence is the unprotected part:
  // delete that arm and resolveConfigDir(undefined) throws a message that also contains "--seat"
  // and also exits 1, so /--seat/ above cannot tell the two apart.
  const noValue = mk();
  assert.equal(await dispatch(['init', '--seat'], noValue.deps), 1);
  assert.match(noValue.stderr(), /--seat needs a directory/, 'the no-value refusal must say what --seat needs, not report a type error about it');
  assert.match(noValue.stderr(), /Omit --seat to initialise the fleet's own root/, "…and that omitting it is how you initialise the fleet's own root");
  // An absolute path that is not a directory is an environment fault (exit 2): a seat is a
  // config dir that has already been logged in, and creating it here would register a bus into
  // an account that does not exist yet.
  const absent = mk();
  const nowhere = join(tmpdir(), `soma-no-such-seat-${process.pid}`);
  assert.equal(await dispatch(['init', '--seat', nowhere], absent.deps), 2);
  assert.match(absent.stderr(), /is not a directory/);
  assert.match(absent.stderr(), /claude auth login/, 'the refusal must say how a seat comes to exist');
  assert.equal(absent.calls.installSkill.length + absent.calls.capture.length, 0);
  // `~` is expanded by seats.resolveConfigDir — the same function loadSeats runs on soma.json —
  // so a quoted `~/…` here names exactly the seat soma.json will name.
  const saved = process.env.HOME;
  const fake = mkdtempSync(join(tmpdir(), 'soma-home-'));
  t.after(() => { process.env.HOME = saved; rmSync(fake, { recursive: true, force: true }); });
  process.env.HOME = fake;
  mkdirSync(join(fake, '.claude-seat-b'));
  const tilde = mk();
  assert.equal(await dispatch(['init', '--seat', '~/.claude-seat-b'], tilde.deps), 0);
  assert.deepEqual(tilde.calls.installSkill, [join(homedir(), '.claude-seat-b')]);
});

test('--seat consumes its value everywhere the CLI reads positionals, so a seat dir is never a stray positional', async (t) => {
  root(t);
  // `--seat` is in VALUE_FLAGS, and removing it from that set reddens nothing today because
  // `init` is the only verb that reads --seat and it never calls positionals().
  // The membership is global, so it is pinned through a verb that does: `peek` takes its id
  // from positionals(rest), and with --seat consuming its value the id is the LAST token.
  // Inert for `init` until the day it grows positional validation — which is the day the seat
  // dir would silently become the task id.
  const h = mk();
  assert.equal(await dispatch(['peek', '--seat', '~/.claude-seat-b', 'cr-1'], h.deps), 0,
    'the token after --seat was read as the task id and refused as a bad one: --seat is not consuming its value');
  assert.deepEqual(h.calls.capturePane.map((c) => c.target), ['lead-cr-1'],
    "the value after --seat was read as the task id: positionals() did not skip it, so `soma peek --seat <dir> <id>` peeks at the seat");
});

test("init --seat says a seat it could not stat was NOT OBSERVED, and does not tell the operator to mkdir it",
  { skip: process.getuid?.() === 0 ? 'running as root: EACCES on a parent cannot be staged' : false }, async (t) => {
    const home = root(t);
    // The shipped `isDir` was two-state — `catch { return false; }` — so EACCES on the seat path
    // was reported as "is not a directory" with the remedy `mkdir <seat> && … claude auth login`.
    // That remedy is wrong for a directory that EXISTS and cannot be searched, and
    // an operator who runs it makes a second seat beside the one they meant. Refusing is the safe
    // direction and stays; the sentence is what changes.
    const locked = mkdtempSync(join(tmpdir(), 'soma-locked-'));
    const seat = join(locked, 'seat-b');
    mkdirSync(seat);
    t.after(() => { chmodSync(locked, 0o755); rmSync(locked, { recursive: true, force: true }); });
    chmodSync(locked, 0o000);
    const h = mk();
    assert.equal(await dispatch(['init', '--seat', seat], h.deps), 2, 'an unreadable seat path must still refuse, and as an environment fault');
    assert.match(h.stderr(), /could not be stat'ed \(EACCES/, 'the refusal must name what actually happened to the stat');
    assert.match(h.stderr(), /NOT observed/, 'a stat that failed is not an observation that the seat is missing');
    assert.doesNotMatch(h.stderr(), /`mkdir /, 'EACCES on the path is not a missing seat: mkdir is the wrong remedy and makes a second seat');
    assert.equal(h.calls.installSkill.length + h.calls.capture.length, 0);
    assert.deepEqual(readdirSync(home), [], 'refused before tree(), like every other --seat refusal');
  });

test("init --seat installs the skill under the SEAT, not the fleet's config root", async (t) => {
  root(t);
  const seat = emptySeatDir(t);
  const h = mk({
    env: { ...process.env, CLAUDE_CONFIG_DIR: '/tmp/cfgroot-fleet' },
    installSkill: (cfgRoot) => { h.calls.installSkill.push(cfgRoot); return { ok: true, dest: join(cfgRoot, 'skills', 'soma-promote') }; },
  });
  assert.equal(await dispatch(['init', '--seat', seat], h.deps), 0);
  // The ARGUMENT, as the fleet-root test above asserts it: a skill written under the fleet's
  // root is a /soma-promote that does not exist for a session started under the seat.
  assert.deepEqual(h.calls.installSkill, [seat]);
  assert.ok(h.stdout().includes(join(seat, 'skills', 'soma-promote')));
  assert.match(h.stdout(), /claude config root: .*--seat/, "the report must say this root is a seat, not the fleet's");
});

test('init --seat runs `claude mcp` remove, add AND the read-back with CLAUDE_CONFIG_DIR=<seat>', async (t) => {
  root(t);
  const seat = emptySeatDir(t);
  const h = mk({
    env: { ...process.env, CLAUDE_CONFIG_DIR: '/tmp/cfgroot-fleet', USER: 'op', PATH: '/usr/bin' },
    capture: (cmd, args, opts) => { h.calls.capture.push({ cmd, args, opts }); return { stdout: 'soma: node /abs/bin/soma-bus.mjs', stderr: '', code: 0 }; },
  });
  assert.equal(await dispatch(['init', '--seat', seat], h.deps), 0);
  const claude = h.calls.capture.filter((c) => c.cmd === 'claude');
  // All three, or the read-back reads the FLEET's registration and calls the seat done.
  assert.deepEqual(claude.map((c) => c.args[1]), ['remove', 'add', 'get']);
  for (const c of claude) {
    assert.equal(c.opts?.env?.CLAUDE_CONFIG_DIR, seat, `\`claude mcp ${c.args[1]}\` ran against the fleet's root, not the seat`);
  }
  // …and the rest of the subprocess environment is the caller's: PATH still finds `claude`,
  // USER still reaches the keychain (the `Not logged in` lesson from WATCHDOG_ENV_ALLOW).
  assert.equal(claude[1].opts.env.USER, 'op');
  assert.equal(claude[1].opts.env.PATH, '/usr/bin');
});

test("init --seat pins the FLEET's SOMA_HOME and tmux socket into the seat, and says what to do next", async (t) => {
  const home = root(t);
  const seat = emptySeatDir(t);
  const h = mk({ capture: (cmd, args, opts) => { h.calls.capture.push({ cmd, args, opts }); return { stdout: 'soma: node /abs/bin/soma-bus.mjs', stderr: '', code: 0 }; } });
  assert.equal(await dispatch(['init', '--seat', seat], h.deps), 0);
  const add = h.calls.capture.find((c) => c.args.includes('add'));
  // The pins do not move with the root: N seats for ONE fleet is the documented 1:1 pairing
  // inverted on purpose. A seat pinned to its own root would adopt a lease over an empty tree.
  assert.ok(add.args.includes(`SOMA_HOME=${home}`), "a seat's bus must drive THIS fleet");
  assert.ok(add.args.includes(`SOMA_TMUX_SOCKET=${tmux.socketName()}`), "a seat on another socket wakes another server's panes");
  assert.match(h.stdout(), /seat initialized at /);
  assert.match(h.stdout(), /soma\.json\.seats/, 'the next step is the seats entry, then doctor');
  assert.match(h.stdout(), /soma doctor/);
});

test("init --seat and the RUNBOOK point at doctor's seat checks without stating a count only CHECKS gets to state", async (t) => {
  root(t);
  // The shipped message said "the four seat checks" while this branch's CHECKS carries FIVE of
  // them (`seat pool state readable` joined late), and nothing compared the two: the assertions
  // beside it read only /soma\.json\.seats/ and /soma doctor/. Counted on both sides rather than
  // spelled on one — the shape `RUNBOOK §9 counts thaw's refusals the way the arm does` uses.
  const { CHECKS } = await import('../bin/lib/doctor.mjs');
  const seatChecks = CHECKS.filter((c) => /seat/.test(c));
  // The could-not-observe state, explicit: a filter that matched nothing would make the two
  // scans below vacuous, and "neither text states a count" would pass for a reason that has
  // nothing to do with doctor.
  assert.ok(seatChecks.length >= 4, `doctor must carry the seat checks these two texts send the operator to; found ${seatChecks.length}`);
  const seat = emptySeatDir(t);
  const h = mk({ capture: (cmd, args, opts) => { h.calls.capture.push({ cmd, args, opts }); return { stdout: 'soma: node /abs/bin/soma-bus.mjs', stderr: '', code: 0 }; } });
  assert.equal(await dispatch(['init', '--seat', seat], h.deps), 0);
  const runbook = readFileSync(fileURLToPath(new URL('../RUNBOOK.md', import.meta.url)), 'utf8');
  const para = /`soma init --seat <dir>` does[\s\S]*?\n\n/.exec(runbook)?.[0] ?? '';
  assert.match(para, /^`soma init --seat <dir>` does/, 'the RUNBOOK paragraph must be findable, or the scan below is vacuous');
  for (const [where, text] of [['the `soma init --seat` success message', h.stdout()], ['the RUNBOOK §4 paragraph', para]]) {
    // Anchored on `soma doctor` -> `seat`, not on the word `seat` alone: both texts are about
    // seats throughout, so a bare /seat/ here could not fail.
    assert.match(text, /soma doctor[\s\S]{0,120}?seat/, `${where} must send the operator from soma doctor to its seat checks`);
    // Any literal count is wrong the next time a seat check is added or renamed, and the RUNBOOK
    // copies these words. Only CHECKS may state how many there are.
    const claim = /\b(no|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+seat checks\b/i.exec(text);
    assert.equal(claim, null, `${where} states ${JSON.stringify(claim?.[0])}, and doctor carries ${seatChecks.length} checks with "seat" in the name`);
  }
});

test("init --seat creates THIS shell's state tree, exactly as a plain init does — the seat gets no state root of its own", async (t) => {
  // RUNBOOK §7's verb row said `--seat` "creates no state tree". It does. The
  // `--seat` block only ever `return`s on a REFUSAL; every success path falls through to
  // `tree()` -> `paths.ensureTree()`, which mkdirs the state root's subdirs under `$SOMA_HOME`.
  // That is `$SOMA_HOME` of the SHELL, and nothing about it is conditional on `--seat`: run from
  // a shell pinned elsewhere, `init --seat` silently creates a SECOND state root and pins the
  // seat's bus to it — the failure §7 step 3's "check the root is this fleet's" exists to catch.
  //
  // Pinned as a RELATION between the two runs, never as a list of subdir names: a literal list
  // is the next thing to go stale when `SUBDIRS` grows, and the claim the RUNBOOK makes is
  // "exactly as a plain `init` does", not "these seven".
  const fleetHome = root(t);
  const plain = mk();
  assert.equal(await dispatch(['init'], plain.deps), 0);
  const afterPlain = readdirSync(fleetHome).sort();
  // A SECOND fresh root for the `--seat` run, restored INLINE rather than through a hook: two
  // `t.after`s restoring one env var leave the ordering between them deciding which root the
  // next test runs against.
  const otherHome = mkdtempSync(join(tmpdir(), 'soma-cli-seatroot-'));
  t.after(() => rmSync(otherHome, { recursive: true, force: true }));
  const seat = emptySeatDir(t);
  process.env.SOMA_HOME = otherHome;
  const seated = mk();
  const code = await dispatch(['init', '--seat', seat], seated.deps);
  const afterSeat = readdirSync(otherHome).sort();
  process.env.SOMA_HOME = fleetHome;
  assert.equal(code, 0, 'the --seat run must SUCCEED, or what it did to the state root says nothing');
  assert.notDeepEqual(afterPlain, [],
    'a plain init that created nothing would make the comparison below pass for the wrong reason');
  assert.deepEqual(afterSeat, afterPlain,
    '`init --seat` left a different state root from a plain `init` — the two are one act on $SOMA_HOME, and the RUNBOOK verb row says so');
  assert.deepEqual(readdirSync(seat).sort(), [],
    'nothing is created INSIDE the seat dir — the state root is the shell\'s; the seat gets the skill and the bus only');
});

test("without --seat, init calls capture with two arguments and the fleet's own root — byte-identical to before", async (t) => {
  root(t);
  const h = mk({
    env: { ...process.env, CLAUDE_CONFIG_DIR: '/tmp/cfgroot-fleet' },
    capture: (...a) => { h.calls.capture.push(a); return { stdout: 'soma: node /abs/bin/soma-bus.mjs', stderr: '', code: 0 }; },
  });
  assert.equal(await dispatch(['init'], h.deps), 0);
  assert.ok(h.calls.capture.length >= 3, 'remove, add and the read-back');
  for (const a of h.calls.capture) assert.equal(a.length, 2, `capture(${a[1]?.[1]}) received a third argument without --seat`);
  assert.deepEqual(h.calls.installSkill, ['/tmp/cfgroot-fleet']);
  assert.doesNotMatch(h.stdout(), /--seat|seat initialized/);
});

// -------------------------------------------------------------------- attach / peek

test('attach targets one exact session on the shared socket', async (t) => {
  root(t);
  const h = mk();
  assert.equal(await dispatch(['attach', 'cr-1'], h.deps), 0);
  const { cmd, args } = h.calls.exec[0];
  assert.equal(cmd, 'tmux');
  // The socket name has ONE spelling, `tmux.tmuxArgs`, and this asserts the whole argv came out
  // of it rather than being re-spelled here. A second `-L soma` in this file is the same class
  // of fault as a second `queuePausedPath()`: nothing errors, and on a throwaway socket the
  // operator attaches to a server the fleet is not on. (`tmux.mjs` reads
  // `$SOMA_TMUX_SOCKET` once at module load, so this cannot be driven through `deps.env` —
  // which is exactly why the argv, not the socket string, is what gets pinned.)
  assert.deepEqual(args, tmux.tmuxArgs(['attach', '-t', '=lead-cr-1']));
  // tmux resolves a bare `-t` by exact match, then unambiguous PREFIX: with `lead-cr-1` dead
  // and `lead-cr-10` alive, `-t lead-cr-1` attaches the operator to the wrong lead. `=` forces
  // exact matching, and this is the one place soma spells a tmux target itself.
  assert.ok(args.includes('=lead-cr-1'));
});

test('attach prefers the session name the row actually records', async (t) => {
  root(t);
  // A worktree retry suffixes the session (`lead-cr-1-r2`), and the row is where that is
  // written down. Re-deriving `lead-<id>` here would attach to a session that no longer exists.
  const h = mk({ readFleet: () => ({ tasks: [{ id: 'cr-1', status: 'spawned', tmux_session: 'lead-cr-1-r2' }] }) });
  await dispatch(['attach', 'cr-1'], h.deps);
  assert.ok(h.calls.exec[0].args.includes('=lead-cr-1-r2'));
});

test('a tmux_session the checkpoint should never hold does not reach tmux as a target', async (t) => {
  root(t);
  // `tmux_session` lives in a file an operator can edit, and `%1` is not a session name — it is a
  // PANE id. `tmux.capturePane` and `tmux.sendKeys` pass `%`-prefixed targets straight through
  // (`%12` is already unique, so `paneTarget` leaves it alone), so a row reading `%1` would peek
  // at, or type into, WHOEVER IS RUNNING THIS COMMAND — the orchestrator's own pane. That is how
  // an orchestrator types its own answer into a lead's session, and a prior task measured the same
  // hazard on the same field: `TMUX_NAME_RE` in `sessionOf` mirrors `bus-tools`' guard. Deleting
  // the guard survived the entire suite before this test existed.
  const hostile = (tmux_session) => mk({
    readFleet: () => ({ tasks: [{ id: 'cr-1', status: 'blocked', tmux_session, lead_session_uuid: 'u1' }] }),
    ...panesFor('lead-cr-1', 'lead-cr-1-r2'),
  });

  for (const bad of ['%1', '%12', 'lead cr-1', 'lead-cr-1:0.1', '-L/tmp/evil']) {
    const sent = hostile(bad);
    assert.equal(await dispatch(['send', 'cr-1', 'hi'], sent.deps), 0, bad);
    assert.deepEqual(sent.calls.sendKeys, [{ target: 'lead-cr-1', text: 'hi' }], bad);

    const peeked = hostile(bad);
    await dispatch(['peek', 'cr-1'], peeked.deps);
    assert.equal(peeked.calls.capturePane[0].target, 'lead-cr-1', bad);

    const killed = hostile(bad);
    await dispatch(['kill', 'cr-1'], killed.deps);
    assert.deepEqual(killed.calls.killSession, ['lead-cr-1'], bad);

    const attached = hostile(bad);
    await dispatch(['attach', 'cr-1'], attached.deps);
    assert.deepEqual(attached.calls.exec[0].args, tmux.tmuxArgs(['attach', '-t', '=lead-cr-1']), bad);
  }

  // A WHITELIST, not a `%` blacklist: the five values above are rejected for the shapes they have,
  // not for one leading character. `lead-cr-1-r2` — what a worktree retry actually records — is
  // still preferred over the derived name, which the attach test above pins from the other side.
  const legit = hostile('lead-cr-1-r2');
  await dispatch(['send', 'cr-1', 'hi'], legit.deps);
  assert.equal(legit.calls.sendKeys[0].target, 'lead-cr-1-r2');
});

test('attach and peek refuse a missing or malformed lead id', async (t) => {
  root(t);
  for (const argv of [['attach'], ['peek'], ['attach', '../etc'], ['peek', 'Cr-1']]) {
    const h = mk();
    assert.notEqual(await dispatch(argv, h.deps), 0, argv.join(' '));
    assert.equal(h.calls.exec.length + h.calls.capturePane.length, 0, argv.join(' '));
  }
});

test('peek tails the pane, honours --lines, and never renders empty as silence', async (t) => {
  root(t);
  const h = mk({ capturePane: (target, lines) => { h.calls.capturePane.push({ target, lines }); return 'line a\nline b'; } });
  assert.equal(await dispatch(['peek', 'cr-1'], h.deps), 0);
  // The BARE name: `tmux.capturePane` applies its own pane target (`=name:`), so an `=` added
  // here arrives doubled — tmux answers "can't find pane", the capture comes back empty, and an
  // operator reads a live lead as one that printed nothing. Same for sendKeys and killSession;
  // only `attach`, whose argv this CLI builds itself, spells the `=`.
  assert.equal(h.calls.capturePane[0].target, 'lead-cr-1');
  assert.equal(h.calls.capturePane[0].lines, 60);
  assert.match(h.stdout(), /line b/);

  const n = mk();
  await dispatch(['peek', 'cr-1', '--lines', '5'], n.deps);
  assert.equal(n.calls.capturePane[0].lines, 5);

  // BOUNDED, because it becomes a tmux argument — `capture-pane -S -<n>` — and the bound is what
  // stops `--lines 1e9` from being handed to the server. Removing the `Math.min(n, max)` from
  // `count` survived everything else in this file.
  const huge = mk();
  await dispatch(['peek', 'cr-1', '--lines', '999999'], huge.deps);
  assert.equal(huge.calls.capturePane[0].lines, 2000);
  // A non-numeric or non-positive value falls back to the default rather than to NaN or to 0,
  // which `capture-pane` would read as "the whole scrollback" and "nothing" respectively.
  for (const bad of ['nope', '0', '-5', '2.5']) {
    const b = mk();
    await dispatch(['peek', 'cr-1', '--lines', bad], b.deps);
    assert.equal(b.calls.capturePane[0].lines, 60, bad);
  }

  const empty = mk({ capturePane: () => '' });
  await dispatch(['peek', 'cr-1'], empty.deps);
  assert.match(empty.stdout() + empty.stderr(), /no output|nothing/i);
});

// ---------------------------------------------------------------------------- send

test('send types the message into the lead and reports delivery', async (t) => {
  root(t);
  const h = mk({ readFleet: () => ({ tasks: [{ id: 'cr-1', status: 'blocked' }] }), ...panesFor('lead-cr-1') });
  assert.equal(await dispatch(['send', 'cr-1', 'do the thing'], h.deps), 0);
  assert.deepEqual(h.calls.sendKeys, [{ target: 'lead-cr-1', text: 'do the thing' }]);
  assert.match(h.stdout(), /delivered/);
});

test('send refuses to type into a dialog, a shell, a dead pane or an unread pane, names each, and --force overrides', async (t) => {
  root(t);
  const fleet = () => ({ tasks: [{ id: 'cr-1', status: 'spawned', tmux_session: 'lead-cr-1' }] });
  // Measured on a live dialog: the literal is swallowed and the Enter selects the highlighted
  // "1. Yes" — a `soma send` into this pane is a blind approval of whatever command is pending.
  const blocked = mk({ readFleet: fleet, paneStates: () => new Map([['lead-cr-1', pane({ cmd: '2.1.259' })]]), capturePane: () => PROMPT_FRAME });
  assert.equal(await dispatch(['send', 'cr-1', 'hi'], blocked.deps), 3);
  assert.deepEqual(blocked.calls.sendKeys, [], 'not one keystroke');
  assert.match(blocked.stderr(), /approv/i);
  assert.match(blocked.stderr(), /--force/);
  // The AskUserQuestion dialog (measured live): the same select list, so the
  // same blind answer. Refused, and the sentence says the lead is asking, not asking permission.
  const asking = mk({ readFleet: fleet, paneStates: () => new Map([['lead-cr-1', pane()]]), capturePane: () => QUESTION_FRAME });
  assert.equal(await dispatch(['send', 'cr-1', 'option 1'], asking.deps), 3);
  assert.deepEqual(asking.calls.sendKeys, [], 'not one keystroke');
  assert.match(asking.stderr(), /question/i);
  assert.doesNotMatch(asking.stderr(), /unrecognised/);
  // Measured on a zsh pane: `Operator: hello…` ran — `zsh: command not found: Operator:`.
  const shell = mk({ readFleet: fleet, paneStates: () => new Map([['lead-cr-1', pane({ cmd: 'zsh', title: '' })]]) });
  assert.equal(await dispatch(['send', 'cr-1', 'hi'], shell.deps), 3);
  assert.deepEqual(shell.calls.sendKeys, []);
  assert.match(shell.stderr(), /execut/i);
  // Measured on a dead pane: send-keys exits 0 twice and nothing happens.
  const dead = mk({ readFleet: fleet, paneStates: () => new Map([['lead-cr-1', pane({ dead: true, cmd: 'env', title: '' })]]) });
  assert.equal(await dispatch(['send', 'cr-1', 'hi'], dead.deps), 3);
  assert.deepEqual(dead.calls.sendKeys, []);
  // Unreadable listing: the refusal the CLI already makes for `resume` — UNMEASURED refuses like
  // LIVE does — because typing blind into a dialog is the unrecoverable direction.
  const unread = mk({ readFleet: fleet, paneStates: () => null });
  assert.equal(await dispatch(['send', 'cr-1', 'hi'], unread.deps), 3);
  assert.deepEqual(unread.calls.sendKeys, []);
  assert.match(unread.stderr(), /could not be read/i);
  // Four refusals, four different sentences: an operator must be able to tell them apart.
  assert.equal(new Set([blocked.stderr(), shell.stderr(), dead.stderr(), unread.stderr()]).size, 4);
  // `--force` is the operator saying "I have looked at the pane".
  const forced = mk({ readFleet: fleet, paneStates: () => new Map([['lead-cr-1', pane({ cmd: '2.1.259' })]]), capturePane: () => PROMPT_FRAME });
  assert.equal(await dispatch(['send', 'cr-1', 'hi', '--force'], forced.deps), 0);
  assert.equal(forced.calls.sendKeys.length, 1);
  assert.match(forced.stdout() + forced.stderr(), /blocked_on_prompt|prompt/);
  // An unrecognised screen is a reading, not a measured hazard: typed, with the reading printed.
  const odd = mk({ readFleet: fleet, paneStates: () => new Map([['lead-cr-1', pane({ cmd: 'node' })]]), capturePane: () => 'no known marker here' });
  assert.equal(await dispatch(['send', 'cr-1', 'hi'], odd.deps), 0);
  assert.equal(odd.calls.sendKeys.length, 1);
  assert.match(odd.stdout() + odd.stderr(), /unrecognised/);
});

test('send reports a dropped answer as not delivered, and separates it from a throw', async (t) => {
  root(t);
  const fleet = () => ({ tasks: [{ id: 'cr-1', status: 'blocked' }] });
  // `sendKeys` withholds the Enter when the literal send failed, and answers false. Reporting
  // that as sent is how a NEEDS_INPUT lead waits forever on an answer nobody typed.
  const dropped = mk({ readFleet: fleet, sendKeys: () => false, ...panesFor('lead-cr-1') });
  assert.notEqual(await dispatch(['send', 'cr-1', 'x'], dropped.deps), 0);
  assert.match(dropped.stderr(), /not delivered/i);

  const threw = mk({ readFleet: fleet, sendKeys: () => { throw new Error('tmux gone'); }, ...panesFor('lead-cr-1') });
  assert.notEqual(await dispatch(['send', 'cr-1', 'x'], threw.deps), 0);
  const e = threw.stderr();
  assert.match(e, /tmux gone/);
  // Three outcomes, three different things known. A failed CALL proves nothing about the
  // lead, so it must not be reported as "that pane is gone" — a diagnosis stated as a fact.
  assert.doesNotMatch(e, /pane is gone/);
});

test('send refuses an unknown lead and an empty message', async (t) => {
  root(t);
  const unknown = mk({ readFleet: () => ({ tasks: [] }) });
  assert.notEqual(await dispatch(['send', 'cr-9', 'hi'], unknown.deps), 0);
  assert.equal(unknown.calls.sendKeys.length, 0);
  assert.match(unknown.stderr(), /cr-9/);

  const blank = mk({ readFleet: () => ({ tasks: [{ id: 'cr-1', status: 'blocked' }] }), ...panesFor('lead-cr-1') });
  assert.notEqual(await dispatch(['send', 'cr-1', '   '], blank.deps), 0);
  assert.equal(blank.calls.sendKeys.length, 0);
});

test('send collapses a multi-line message to one line', async (t) => {
  root(t);
  // send-keys types the literal text and submits with a separate Enter. An embedded newline
  // would submit the first line and leave the rest sitting in the composer.
  const h = mk({ readFleet: () => ({ tasks: [{ id: 'cr-1', status: 'blocked' }] }), ...panesFor('lead-cr-1') });
  await dispatch(['send', 'cr-1', 'first\nsecond'], h.deps);
  assert.equal(h.calls.sendKeys[0].text.includes('\n'), false);
  assert.match(h.calls.sendKeys[0].text, /first second/);
});

test('--as re-checks the lease, and refuses a session that does not hold it', async (t) => {
  root(t);
  const fleet = () => ({ tasks: [{ id: 'cr-1', status: 'blocked' }] });
  const notHolder = mk({ readFleet: fleet, readLease: () => ({ session_id: 'other', lease_seq: 2 }), ...panesFor('lead-cr-1') });
  assert.notEqual(await dispatch(['send', 'cr-1', 'hi', '--as', 'mine'], notHolder.deps), 0);
  assert.equal(notHolder.calls.sendKeys.length, 0, 'a demoted session may not act on the fleet');
  const e = notHolder.stderr();
  assert.match(e, /other/, 'who does hold it');
  assert.equal(notHolder.calls.heartbeat.length, 0);

  const holder = mk({ readFleet: fleet, readLease: () => ({ session_id: 'mine', lease_seq: 2 }), ...panesFor('lead-cr-1') });
  assert.equal(await dispatch(['send', 'cr-1', 'hi', '--as', 'mine'], holder.deps), 0);
  assert.equal(holder.calls.sendKeys.length, 1);
  // The lease reads stale after 10 minutes without a heartbeat, and a stale lease is adoptable
  // WITHOUT force — so an orchestrator driving the fleet from the CLI in fallback mode would
  // lose it silently while working. Every orchestrator tool call stamps it; so does this.
  assert.deepEqual(holder.calls.heartbeat, ['mine']);
});

test('--as against a fleet with no lease at all is refused, not assumed', async (t) => {
  root(t);
  const h = mk({ readFleet: () => ({ tasks: [{ id: 'cr-1', status: 'blocked' }] }), readLease: () => null });
  assert.notEqual(await dispatch(['send', 'cr-1', 'hi', '--as', 'mine'], h.deps), 0);
  assert.equal(h.calls.sendKeys.length, 0);
});

test('a bare human invocation says it is acting as operator instead of refusing', async (t) => {
  root(t);
  const h = mk({ readFleet: () => ({ tasks: [{ id: 'cr-1', status: 'blocked' }] }), readLease: () => ({ session_id: 'someone-else' }), ...panesFor('lead-cr-1') });
  assert.equal(await dispatch(['send', 'cr-1', 'hi'], h.deps), 0);
  assert.match(h.stdout(), /operator/i);
  assert.equal(h.calls.sendKeys.length, 1);
  assert.equal(h.calls.heartbeat.length, 0, 'the operator is not the lease holder and must not warm its clock');
});

test('--as with no value is a refusal, not an anonymous act', async (t) => {
  root(t);
  // A lease IS present, and it names nobody in particular. Without one, the "this fleet has no
  // orchestrator lease" branch absorbs this and the `--as`-needs-a-value guard could be deleted
  // with the test still green.
  const h = mk({
    readFleet: () => ({ tasks: [{ id: 'cr-1', status: 'blocked' }] }),
    readLease: () => ({ session_id: 'sess-holder', lease_seq: 1 }),
  });
  assert.notEqual(await dispatch(['send', 'cr-1', 'hi', '--as'], h.deps), 0);
  assert.equal(h.calls.sendKeys.length, 0);
  assert.match(h.stderr(), /--as needs a session id/);
});

// ---------------------------------------------------------------------------- kill

test('kill kills the session, then the row, and reports the two separately', async (t) => {
  root(t);
  const order = [];
  const h = mk({
    readFleet: () => ({ tasks: [{ id: 'cr-1', status: 'spawned' }] }),
    killSession: (n) => { order.push(`kill:${n}`); h.calls.killSession.push(n); return true; },
    setTaskStatus: (id, s) => { order.push(`status:${s}`); h.calls.setTaskStatus.push({ id, status: s }); },
  });
  assert.equal(await dispatch(['kill', 'cr-1', 'wrong ticket'], h.deps), 0);
  // The kill FIRST, because it is what the operator asked for: a failed row-write then leaves a
  // dead session the watchdog reconciles, rather than a "failed" row beside a live lead.
  assert.deepEqual(order, ['kill:lead-cr-1', 'status:failed']);
  assert.deepEqual(h.calls.killSession, ['lead-cr-1']);
  assert.deepEqual(h.calls.setTaskStatus, [{ id: 'cr-1', status: 'failed' }]);
  const logged = h.calls.appendEvent.find((a) => a.ev.type === 'KILLED');
  assert.ok(logged, 'the operator intervention is in the history the fleet is rebuilt from');
  assert.equal(logged.ev.payload.reason, 'wrong ticket');
  assert.equal(logged.ev.lead, 'cr-1');
});

test('kill reports a row it could not update without claiming the row is failed', async (t) => {
  root(t);
  const h = mk({
    readFleet: () => ({ tasks: [{ id: 'cr-1', status: 'spawned' }] }),
    setTaskStatus: () => { throw new Error('checkpoint locked'); },
  });
  assert.notEqual(await dispatch(['kill', 'cr-1'], h.deps), 0);
  assert.equal(h.calls.killSession.length, 1, 'the kill is what the operator asked for and happens first');
  assert.match(h.stderr(), /reconcile|not.*updated/i);
  // WHICH verified outcome got here matters to whoever reads the line: "killed" and "there was
  // nothing to kill" leave the fleet in different states, and this arm knows the difference.
  assert.match(h.stderr(), /the session was killed/);

  // The same row failure on the verified-ABSENT path must not say the session was killed — a
  // small instance of the same defect the read-back exists to remove.
  const nothingToKill = mk({
    readFleet: () => ({ tasks: [{ id: 'cr-1', status: 'spawned' }] }),
    killSession: () => false,
    liveSessions: () => new Set(),
    setTaskStatus: () => { throw new Error('checkpoint locked'); },
  });
  assert.notEqual(await dispatch(['kill', 'cr-1'], nothingToKill.deps), 0);
  assert.match(nothingToKill.stderr(), /no session by that name/);
  assert.doesNotMatch(nothingToKill.stderr(), /the session was killed/);
});

test('kill does not mark a row failed on a kill it could not verify', async (t) => {
  root(t);
  const fleet = () => ({ tasks: [{ id: 'cr-1', status: 'spawned' }] });

  // THE DESTRUCTIVE DIRECTION, and the reason this was the Critical rather than a Medium.
  // `killSession` answers `false` for a tmux it could not reach at all (see the `down` test), and
  // the arm used to read that as "session not found", mark the row `failed` and exit 0. The
  // operator then believes the lead is dead and stops watching it, while a real claude keeps
  // burning tokens on its worktree — and the checkpoint agrees with them.
  const unmeasured = mk({ readFleet: fleet, killSession: () => false, liveSessions: () => null });
  assert.equal(await dispatch(['kill', 'cr-1'], unmeasured.deps), 3);
  assert.equal(unmeasured.calls.setTaskStatus.length, 0, 'a possibly-live lead is not marked failed');
  assert.match(unmeasured.stderr(), /NOT killed/);
  assert.match(unmeasured.stderr(), /cannot tell/i, 'what is not known, rather than a verdict');
  // A KILLED event would be a false record in the history the fleet is rebuilt from.
  assert.equal(unmeasured.calls.appendEvent.some((a) => a.ev.type === 'KILLED'), false);
  // Independent of the row write above: an arm that returned 3, wrote nothing, and STILL printed
  // its summary line would tell the operator the session was not found. It is a claim either way.
  assert.doesNotMatch(unmeasured.stdout(), /session not found/);

  // tmux ANSWERED and the session is still there: the kill did not take, so the lead is running.
  const stillLive = mk({ readFleet: fleet, killSession: () => false, liveSessions: () => new Set(['lead-cr-1']) });
  assert.equal(await dispatch(['kill', 'cr-1'], stillLive.deps), 3);
  assert.equal(stillLive.calls.setTaskStatus.length, 0);
  assert.match(stillLive.stderr(), /still reports lead-cr-1 as live/);

  // VERIFIED absent, and this half is what stops the fix from being "refuse whenever killSession
  // says false". tmux answered and reports nothing by that name, so the state the operator asked
  // for is the state that exists: the row goes `failed` and the exit is zero.
  const absent = mk({ readFleet: fleet, killSession: () => false, liveSessions: () => new Set() });
  assert.equal(await dispatch(['kill', 'cr-1'], absent.deps), 0);
  assert.deepEqual(absent.calls.setTaskStatus, [{ id: 'cr-1', status: 'failed' }]);
  assert.match(absent.stdout(), /not found \(tmux read back\)/);
  assert.ok(absent.calls.appendEvent.some((a) => a.ev.type === 'KILLED'));
});

test('kill refuses an unknown task rather than reporting a kill of nothing', async (t) => {
  root(t);
  const h = mk({ readFleet: () => ({ tasks: [] }) });
  assert.notEqual(await dispatch(['kill', 'cr-9'], h.deps), 0);
  assert.equal(h.calls.killSession.length, 0);
  assert.equal(h.calls.setTaskStatus.length, 0);
});

// -------------------------------------------------------------------- resume / retry

test('resume kills the stale session BEFORE it resumes', async (t) => {
  root(t);
  const order = [];
  const h = mk({
    readFleet: () => ({ tasks: [{ id: 'cr-1', status: 'spawned', lead_session_uuid: 'u1' }] }),
    liveSessions: () => new Set(),
    killSession: (n) => { order.push(`kill:${n}`); return true; },
    resumeLead: (task) => { order.push('resume'); return { session_uuid: task.lead_session_uuid }; },
  });
  assert.equal(await dispatch(['resume', 'cr-1'], h.deps), 0);
  // `remain-on-exit` keeps a dead lead's session alive on purpose, and `spawn` refuses to
  // start a lead whose session name is already taken. Resume-without-kill therefore fails
  // silently and forever on exactly the leads that need reviving.
  assert.deepEqual(order, ['kill:lead-cr-1', 'resume']);
  assert.deepEqual(h.calls.setTaskStatus, [{ id: 'cr-1', status: 'spawned' }]);
  assert.match(h.stdout(), /u1/);
});

test('resume refuses a lead that is still live unless forced', async (t) => {
  root(t);
  const fleet = () => ({ tasks: [{ id: 'cr-1', status: 'spawned', lead_session_uuid: 'u1' }] });
  const live = mk({ readFleet: fleet, liveSessions: () => new Set(['lead-cr-1']) });
  assert.notEqual(await dispatch(['resume', 'cr-1'], live.deps), 0);
  assert.equal(live.calls.resumeLead.length, 0, 'two claude sessions on one worktree edit the same files to two plans');
  assert.equal(live.calls.killSession.length, 0);
  assert.match(live.stderr(), /--force/);

  // UNMEASURED refuses exactly like LIVE does. Two claude sessions resumed onto one worktree
  // edit the same files to two different plans, and that is unrecoverable — so a tmux that could
  // not be read is not permission to try. `alive === true` in place of `alive !== false` here is
  // the mutation that opens it.
  const unknown = mk({ readFleet: fleet, liveSessions: () => null });
  assert.notEqual(await dispatch(['resume', 'cr-1'], unknown.deps), 0);
  assert.equal(unknown.calls.resumeLead.length, 0);
  assert.match(unknown.stderr(), /could not be measured/);

  const forced = mk({ readFleet: fleet, liveSessions: () => new Set(['lead-cr-1']) });
  assert.equal(await dispatch(['resume', 'cr-1', '--force'], forced.deps), 0);
  assert.equal(forced.calls.resumeLead.length, 1);
  assert.equal(forced.calls.killSession.length, 1, 'forced still kills first — that ordering is not the guard');
});

test('resume, from a shell with no UTF-8 locale, reads a live lead as live and neither kills nor resumes it (#45)', { skip: !tmuxInstalled && 'tmux not installed' }, async (t) => {
  root(t);
  // The operator's report on #45, end to end through soma's REAL readers: `liveSessions` and
  // `killSession` are tmux.mjs's own, over a real server holding a live `lead-cr-1`. Only the spawner
  // stays a recorder, so nothing real is launched. Without `-u` tmux printed the listing's tab as
  // `_`, the lead read as not live, and resume KILLED its session and put a second claude on its
  // worktree — the one outcome the liveness guard exists to prevent.
  const srv = cLocaleTmux(t, 'lead-cr-1');
  const kills = [];
  const h = mk({
    readFleet: () => ({ tasks: [{ id: 'cr-1', status: 'spawned', lead_session_uuid: 'u1' }] }),
    liveSessions: () => tmux.liveSessions(srv.run),
    killSession: (name) => { kills.push(name); return tmux.killSession(name, srv.run); },
  });
  assert.equal(await dispatch(['resume', 'cr-1'], h.deps), 3, h.stderr());
  assert.deepEqual(kills, [], 'a live lead\'s session was killed');
  assert.equal(h.calls.resumeLead.length, 0, 'a second claude session was put on a live lead\'s worktree');
  assert.equal(srv.alive('lead-cr-1'), true, 'the live session must still be there');
  assert.match(h.stderr(), /cr-1 is still live/);
});

test('resume refuses a listing tmux answered but soma cannot parse as unmeasured, never as a dead lead (#45)', async (t) => {
  root(t);
  // The backstop beside `-u`, through the real reader over a stub transport: exit 0, every tab a `_`.
  // Read as an empty server, that listing is "cr-1 is not live", and resume kills and resumes it.
  const mangled = () => ({ stdout: 'lead-cr-1_0\n', stderr: '', code: 0 });
  const h = mk({
    readFleet: () => ({ tasks: [{ id: 'cr-1', status: 'spawned', lead_session_uuid: 'u1' }] }),
    liveSessions: () => tmux.liveSessions(mangled),
  });
  assert.equal(await dispatch(['resume', 'cr-1'], h.deps), 3, h.stderr());
  assert.equal(h.calls.killSession.length, 0, 'a session was killed on a listing soma could not read');
  assert.equal(h.calls.resumeLead.length, 0);
  assert.match(h.stderr(), /could not be measured/);
});

test('resume refuses a row with no recorded claude session', async (t) => {
  root(t);
  const h = mk({ readFleet: () => ({ tasks: [{ id: 'cr-1', status: 'failed', lead_session_uuid: null }] }) });
  assert.notEqual(await dispatch(['resume', 'cr-1'], h.deps), 0);
  assert.equal(h.calls.resumeLead.length, 0);
  assert.match(h.stderr(), /retry/, 'the verb that does work here is named');
});

test('resume reports a spawner failure as a failure', async (t) => {
  root(t);
  const h = mk({
    readFleet: () => ({ tasks: [{ id: 'cr-1', status: 'failed', lead_session_uuid: 'u1' }] }),
    resumeLead: () => { throw new Error('worktree is gone'); },
  });
  assert.notEqual(await dispatch(['resume', 'cr-1'], h.deps), 0);
  assert.match(h.stderr(), /worktree is gone/);
  assert.equal(h.calls.setTaskStatus.length, 0, 'a row marked spawned beside no session is worse than a failed one');
});

test('resume refuses a soma.json loadConfig refuses BEFORE the kill, with the reason and exit 2', async (t) => {
  const home = root(t);
  // The arm read soma.json tolerantly — "the spawner's to refuse" — and the spawner does refuse it,
  // but only after the kill below has destroyed the dead pane `soma peek` shows. With a seats that
  // is not an array refused at load, that was every resume on such a file.
  // The REAL loader, on a real bad file: the refusal under test is its sentence.
  const { loadConfig } = await import('../bin/lib/config.mjs');
  writeFileSync(join(home, 'soma.json'), JSON.stringify({ seats: {} }));
  const fleet = () => ({ tasks: [{ id: 'cr-1', status: 'failed', lead_session_uuid: 'u1' }] });
  const h = mk({ readFleet: fleet, loadConfig });
  assert.equal(await dispatch(['resume', 'cr-1'], h.deps), 2, 'the same exit `soma up` gives a config it cannot load');
  assert.equal(h.calls.killSession.length, 0, 'the dead pane is still standing');
  assert.equal(h.calls.resumeLead.length, 0);
  assert.equal(h.calls.setTaskStatus.length, 0);
  assert.equal(h.calls.updateFleet.length, 0);
  assert.match(h.stderr(), /^soma resume: .*\bseats\b/m, 'the loader\'s reason, which names the key');

  // The control: the same row on a config that loads is killed first and resumed.
  writeFileSync(join(home, 'soma.json'), JSON.stringify({ seats: [] }));
  const ok = mk({ readFleet: fleet, loadConfig });
  assert.equal(await dispatch(['resume', 'cr-1'], ok.deps), 0, ok.stderr());
  assert.equal(ok.calls.killSession.length, 1);
  assert.equal(ok.calls.resumeLead.length, 1);
});

test('resume launches onto an open seat picked BEFORE the kill, records it through the store, refuses with every seat closed, and stays seat-blind with no seats configured', async (t) => {
  root(t);
  const SEATED = { max_leads: 10, budgets: { standard: { tokens_cap: 20000000 } }, seats: [{ config_dir: '/s/a', label: 'seat-a' }, { config_dir: '/s/b', label: 'seat-b' }] };
  /** What `seats.pick` hands back: the seat with its closure fields. */
  const SEAT_B = { config_dir: '/s/b', label: 'seat-b', closed_until: 0, closed_reason: null, unverified: false };
  // A dead lead that died on seat-a. `seat` and `rotations` are the fleet row's rotation fields.
  const fleet = () => ({ tasks: [{ id: 'cr-1', status: 'failed', lead_session_uuid: 'u1', seat: 'seat-a', rotations: [] }] });
  const order = [];
  const picks = [];
  const h = mk({
    readFleet: fleet,
    loadConfig: () => SEATED,
    pickSeat: (now, cfg) => { order.push('pickSeat'); picks.push([now, cfg]); return SEAT_B; },
    killSession: (name) => { order.push(`killSession:${name}`); return true; },
  });
  assert.equal(await dispatch(['resume', 'cr-1'], h.deps), 0);
  assert.equal(picks.length, 1, 'the pool was asked once');
  assert.equal(picks[0][1], SEATED, 'against THIS config, so a seat removed from soma.json is never picked');
  assert.ok(Number.isFinite(picks[0][0]), 'and against a clock');
  // Picked BEFORE the kill: a refusal must leave the dead pane standing (it is the death scene
  // `soma peek` shows) and the row as it was.
  assert.deepEqual(order, ['pickSeat', 'killSession:lead-cr-1']);
  assert.deepEqual(h.calls.resumeOpts, [{ configDir: '/s/b' }], 'the spawner gets the config dir, not the label');
  assert.deepEqual(h.calls.updateFleet.map((f) => f.tasks[0].seat), ['seat-b'], 'the row records the seat, through the store');
  assert.deepEqual(h.calls.setTaskStatus, [{ id: 'cr-1', status: 'spawned' }]);
  assert.match(h.stdout(), /seat seat-b/);

  // Every seat closed or unverified: REFUSED (exit 3), nothing killed, nothing resumed, nothing
  // written. This shell's own account is a seat too, and may be the very one that just closed.
  const closed = mk({ readFleet: fleet, loadConfig: () => SEATED, pickSeat: () => null });
  assert.equal(await dispatch(['resume', 'cr-1'], closed.deps), 3);
  assert.equal(closed.calls.killSession.length, 0);
  assert.equal(closed.calls.resumeLead.length, 0);
  assert.equal(closed.calls.setTaskStatus.length, 0);
  assert.equal(closed.calls.updateFleet.length, 0);
  assert.match(closed.stderr(), /every configured seat is closed or unverified/);
  assert.match(closed.stderr(), /soma status/, 'the verb that shows each seat\'s reset time is named');

  // No seats configured (the fixture's default config): today's launch — `{}` to the spawner, the
  // pool never asked — and the row records the TRUTH, `seat: null`, though it carried a label.
  const blind = mk({ readFleet: fleet });
  assert.equal(await dispatch(['resume', 'cr-1'], blind.deps), 0);
  assert.equal(blind.calls.pickSeat.length, 0, 'a fleet with no seats never reads state/seats.json');
  assert.deepEqual(blind.calls.resumeOpts, [{}]);
  assert.deepEqual(blind.calls.updateFleet.map((f) => f.tasks[0].seat), [null]);
});

test('dispatch wires pickSeat and updateFleet by default, so a real `soma resume` is neither seat-blind nor a silent refusal', async (t) => {
  const home = root(t);
  const seatDir = join(home, 'seat-a');
  const SEATED = { max_leads: 10, budgets: { standard: { tokens_cap: 20000000 } }, seats: [{ config_dir: seatDir, label: 'seat-a' }] };
  // NEITHER is overridden here: the arm runs against `seats.pick` and `fleet.updateFleet`
  // themselves. Both are dispatch DEFAULTS rather than GUARDED_DEPS, so `realDeps wires every
  // guarded name` does not cover them — and measured, with either default deleted this file stayed
  // 100/100 GREEN while every seated `soma resume` became exit 3 ("soma.json.seats could not be
  // read" / "its row could not record the seat"), because `d.pickSeat(...)` on an undefined dep
  // throws straight into the arm's own catch. A default that no test reaches is a default that can
  // be deleted, and this one fails closed and silently.
  const h = mk({
    readFleet: () => ({ tasks: [{ id: 'cr-1', status: 'failed', lead_session_uuid: 'u1', seat: null, rotations: [] }] }),
    loadConfig: () => SEATED,
  });
  delete h.deps.pickSeat;
  delete h.deps.updateFleet;
  assert.equal(await dispatch(['resume', 'cr-1'], h.deps), 0, h.stderr());
  assert.deepEqual(h.calls.resumeOpts, [{ configDir: seatDir }], 'the real seats.pick answered with the one configured seat, resolved');
  assert.match(h.stdout(), /seat seat-a/);
  assert.doesNotMatch(h.stderr(), /could not/, 'neither default was missing');
});

test('cfg.seats [] — what loadConfig hands every un-seated fleet — resumes as before, and never asks the pool', async (t) => {
  root(t);
  // MEASURED: neither live soma.json has a `seats` key, so `loadConfig()` returns `seats: []` out
  // of DEFAULTS — `[]`, not absent, is what production passes this arm, and the tests above use
  // "no seats key" and "two seats". Dropping the `&& cfg.seats.length > 0` half left the whole
  // suite green — 1296 tests when that was measured, a dated reading and not the current
  // baseline — while turning every `soma resume` on a live-shaped fleet into exit 3
  // ("every configured seat is closed or unverified (0 in soma.json)"), because the fixture's
  // pool — like the real one with no seats — answers null.
  const h = mk({
    readFleet: () => ({ tasks: [{ id: 'cr-1', status: 'failed', lead_session_uuid: 'u1', seat: null, rotations: [] }] }),
    loadConfig: () => ({ max_leads: 10, budgets: { standard: { tokens_cap: 20000000 } }, seats: [] }),
  });
  assert.equal(await dispatch(['resume', 'cr-1'], h.deps), 0, h.stderr());
  assert.equal(h.calls.pickSeat.length, 0, 'a fleet with no seats never reads state/seats.json');
  assert.deepEqual(h.calls.resumeOpts, [{}], 'the spawner gets its own env, exactly as before seats existed');
  assert.deepEqual(h.calls.updateFleet.map((f) => f.tasks[0].seat), [null]);
  assert.doesNotMatch(h.stderr(), /closed or unverified/);
});

test('retry re-queues a terminal row, killing its stale session first', async (t) => {
  root(t);
  const order = [];
  const h = mk({
    readFleet: () => ({ tasks: [{ id: 'cr-1', status: 'failed' }] }),
    killSession: (n) => { order.push(`kill:${n}`); return true; },
    setTaskStatus: (id, status) => { order.push(`status:${status}`); h.calls.setTaskStatus.push({ id, status }); },
  });
  assert.equal(await dispatch(['retry', 'cr-1'], h.deps), 0);
  assert.deepEqual(order, ['kill:lead-cr-1', 'status:queued']);
  assert.ok(h.calls.appendEvent.some((a) => a.ev.type === 'RETRIED'));
});

test('retry re-queues only a row that did not deliver', async (t) => {
  root(t);
  // `spawned`/`blocked` still hold a live answerable session; `queued` is already there; and
  // `done` has a draft PR against its worktree that a second lead would silently supersede.
  for (const status of ['spawned', 'blocked', 'queued', 'done']) {
    const h = mk({ readFleet: () => ({ tasks: [{ id: 'cr-1', status }] }) });
    assert.notEqual(await dispatch(['retry', 'cr-1'], h.deps), 0, status);
    assert.equal(h.calls.setTaskStatus.length, 0, status);
    assert.equal(h.calls.killSession.length, 0, status);
  }
  assert.equal(await dispatch(['retry', 'cr-1'], mk({ readFleet: () => ({ tasks: [{ id: 'cr-1', status: 'skipped' }] }) }).deps), 0);
});

// -------------------------------------------------------------------------- digest

test('digest prints recent events oldest-last and consumes nothing', async (t) => {
  root(t);
  const events = {
    orch: [{ id: '2-0', ts: 2, type: 'KILLED', lead: 'cr-1', payload: { reason: 'x' } }],
    'cr-1': [{ id: '1-0', ts: 1, type: 'STARTED', lead: 'cr-1', payload: {} }],
  };
  const asked = [];
  const h = mk({
    readFleet: () => ({ tasks: [{ id: 'cr-1', status: 'spawned' }] }),
    readEvents: (stream) => { asked.push(stream); return events[stream] ?? []; },
  });
  assert.equal(await dispatch(['digest'], h.deps), 0);
  const s = h.stdout();
  assert.ok(s.indexOf('STARTED') < s.indexOf('KILLED'), 'append order, so the last line is the newest');
  assert.deepEqual(asked.sort(), ['cr-1', 'orch']);
  // `soma_inbox` advances a cursor; this deliberately does not, so re-reading is free and an
  // operator cannot consume the orchestrator's mail by looking at it.
  assert.match(s, /cr-1/);
});

test('digest honours --lines and says when there is nothing yet', async (t) => {
  root(t);
  const many = Array.from({ length: 10 }, (_, i) => ({ id: `${i}-0`, ts: i, type: `E${i}`, lead: null, payload: {} }));
  const h = mk({ readEvents: (s) => (s === 'orch' ? many : []) });
  await dispatch(['digest', '--lines', '3'], h.deps);
  assert.match(h.stdout(), /E9/);
  assert.doesNotMatch(h.stdout(), /\bE6\b/);

  const none = mk();
  assert.equal(await dispatch(['digest'], none.deps), 0);
  assert.match(none.stdout(), /no events/i);

  // The same bound as `peek`, and it needs more events than the cap to be visible at all: with ten
  // events in the log, `--lines 3` and `--lines 999999` render identically, which is why the cap
  // was unmeasured. The header names both numbers, so a clamp that did not happen is readable.
  const flood = Array.from({ length: 2500 }, (_, i) => ({ id: `${i}-0`, ts: i, type: 'E', lead: null, payload: {} }));
  const capped = mk({ readEvents: (s) => (s === 'orch' ? flood : []) });
  await dispatch(['digest', '--lines', '999999'], capped.deps);
  assert.match(capped.stdout(), /the last 2000 of 2500 events/);
});

// ------------------------------------------------------------- the v1.x gap arms

test('hold, release and gc refuse loudly instead of falling through to usage', async (t) => {
  root(t);
  // `thaw` left this list when it became a real verb (its own tests are under "thaw" below).
  for (const argv of [['hold', 'cr-1'], ['release', 'cr-1'], ['gc']]) {
    const h = mk();
    const code = await dispatch(argv, h.deps);
    // `3`, not `1`. These ARE refusals, the legend reserves 3 for "soma refused", and every other
    // refusal in the file uses it — so `1` left `soma hold` and `soma frobnicate` indistinguishable
    // to a script, which undoes most of the point of refusing with a reason rather than being
    // absent. The contrast is asserted below rather than assumed.
    assert.equal(code, 3, argv.join(' '));
    const all = h.stdout() + h.stderr();
    assert.match(all, /not implemented|v1\.x/i, argv.join(' '));
    // A verb that printed USAGE would read as "you typed it wrong" for a verb the runbook,
    // the ROADMAP and the promote skill all say exists.
    assert.doesNotMatch(all, /^usage: soma/m, argv.join(' '));
  }
  // The distinction the exit code now carries: a declared gap is not a typo.
  const typo = mk();
  assert.equal(await dispatch(['frobnicate'], typo.deps), 1);
});

test('--canary is named in the gap list, not only in the flag list', async (t) => {
  root(t);
  // The discoverability hole: USAGE advertised `up [--canary]` with no marker, while the same block
  // had a "NOT IMPLEMENTED IN THIS BUILD (v1.x)" section naming hold/release/gc/thaw. The one flag
  // that cannot pass on this build was the one gap missing from the gap list. Nothing prints
  // `canary: pass` unless the verdict was literally `true`, so the failure mode was never "believes
  // it passed" — it was "tries it, and has to read a refusal to find out".
  const gaps = USAGE.slice(USAGE.indexOf('NOT IMPLEMENTED IN THIS BUILD'));
  assert.match(gaps, /--canary/);
  assert.match(gaps, /EVALUATION only/);
  // And the golden path an operator should use instead is named where they are already looking.
  assert.match(gaps, /WITHOUT --canary/);

  // The other direction, and it is the half `USAGE names every verb the dispatcher answers` cannot
  // see: that test only asks `USAGE.includes('thaw')`, which a row in THIS block satisfies just as
  // well — so re-adding `thaw  no backpressure ignore list yet` under `gc` left this file 98/98 and
  // USAGE would advertise one verb in two contradictory blocks. `thaw` is built; it left this list.
  assert.doesNotMatch(gaps, /thaw/, 'a built verb must not also be listed as not implemented');
  assert.match(USAGE.slice(0, USAGE.indexOf('NOT IMPLEMENTED IN THIS BUILD')), /^ {2}thaw {2,}/m,
    'and it is named in the verb list instead');
  // The control for the absence above: a verb row in this block matches a bare-word pattern, so a
  // typo in `/thaw/` would not read as coverage.
  assert.match(gaps, /gc/, 'the pattern shape fires on a verb that really is listed here');
});

test('hold says WHY it is absent rather than just that it is', async (t) => {
  root(t);
  const h = mk();
  await dispatch(['hold', 'cr-1'], h.deps);
  const all = h.stdout() + h.stderr();
  // Nothing in `bin/` reads `leads/<id>/HOLD`. Writing it would ship a flag that is written,
  // displayed and never obeyed — the defect `queue.mjs` exists because of, one file over.
  assert.match(all, /HOLD/);
  assert.match(all, /watchdog/i);
});

test('release names the lease verb it is not', async (t) => {
  root(t);
  const h = mk();
  await dispatch(['release', 'cr-1'], h.deps);
  const all = h.stdout() + h.stderr();
  assert.ok(all.includes('soma_release'));
  assert.match(all, /lease/i);
});

// ------------------------------------------------------------------- the dep contract

/** One arm per guarded dep — the arm that actually calls it. */
const ARM_FOR = {
  liveSessions: ['status'], serverAbsent: ['status'], serverProcesses: ['up'], paneStates: ['status'], newSession: ['up'], killSession: ['down'], sendKeys: ['send', 'cr-1', 'x'],
  capturePane: ['peek', 'cr-1'], resumeLead: ['resume', 'cr-1'], exec: ['attach', 'cr-1'],
  capture: ['init'], doctor: ['doctor'], canary: ['up', '--canary'], confirm: ['up'],
  linkProbe: ['up'], installSkill: ['init'],
};

test('every guarded dep is refused when absent, never silently defaulted', async (t) => {
  root(t);
  // The refusal `spawn.checkDeps` and `soma-watchdog.checkDeps` both make, for the same
  // reason: `{...realDeps(), ...deps}` lets a test that stubs eight deps and forgets
  // `newSession` start a real detached process on the operator's machine.
  assert.ok(GUARDED_DEPS.length >= 10);
  assert.deepEqual(GUARDED_DEPS.filter((n) => !ARM_FOR[n]), [], 'every guarded dep has an arm that calls it');
  // And the other way round: a tmux-reading dep mapped here but missing from GUARDED_DEPS is one the
  // dispatcher could default from the real wiring, and this suite would then shell out to tmux.
  assert.deepEqual(Object.keys(ARM_FOR).filter((n) => !GUARDED_DEPS.includes(n)), [], 'every dep mapped here is guarded');
  for (const name of GUARDED_DEPS) {
    const h = mk({ readFleet: () => ({ tasks: [{ id: 'cr-1', status: 'failed', lead_session_uuid: 'u1' }] }) }, { answer: true });
    delete h.deps[name];
    await assert.rejects(
      () => dispatch(ARM_FOR[name], h.deps),
      (e) => e instanceof TypeError && e.message.includes(name),
      `omitting ${name} must be refused by name`,
    );
  }
});

test('realDeps wires every guarded name', async () => {
  // A name in `GUARDED_DEPS` that `realDeps` does not wire is an arm that throws in
  // production while every injected test passes.
  const real = realDeps();
  const missing = GUARDED_DEPS.filter((k) => typeof real[k] !== 'function');
  assert.deepEqual(missing, []);
});

/*
 * The four real implementations below are exercised, not just wired. Every other test in this
 * file stubs them, so "realDeps has thirteen functions" would otherwise be the whole claim —
 * and a dep that is present, named and never run is precisely the shape of the inert safety
 * mechanisms this build has already found six of. The three that talk to the operator's own
 * machine (`newSession`, `exec`, `resumeLead`) stay unexercised on purpose.
 */

test('the real link probe answers for a healthy state root and leaves nothing behind', async (t) => {
  const home = root(t);
  const r = realDeps().linkProbe();
  assert.equal(r.ok, true);
  assert.equal(r.dir, join(home, 'state'));
  // The scratch files are removed in a `finally`. A probe that littered the state root would
  // leave a `.linkprobe.<pid>` beside fleet.json on every `soma up` for the life of the deployment.
  assert.deepEqual(readdirSync(join(home, 'state')), []);
});

test('the real skill install copies the shipped skill and reads it back', async (t) => {
  root(t);
  const cfg = mkdtempSync(join(tmpdir(), 'soma-cfg-'));
  t.after(() => rmSync(cfg, { recursive: true, force: true }));
  const r = realDeps().installSkill(cfg);
  assert.equal(r.ok, true);
  assert.equal(r.dest, join(cfg, 'skills', 'soma-promote'));
  // The read-back is the point of the dep: `cpSync` succeeding is not evidence that SKILL.md
  // arrived with the frontmatter claude registers it by.
  assert.match(readFileSync(join(r.dest, 'SKILL.md'), 'utf8'), /^name: soma-promote$/m);
  // Idempotent, because `soma init` is re-run whenever the operator is unsure.
  assert.equal(realDeps().installSkill(cfg).ok, true);
});

test('the real capture reports an exit code instead of throwing', async (t) => {
  root(t);
  const { capture } = realDeps();
  const ok = capture(process.execPath, ['-e', 'process.stdout.write("hi")']);
  assert.deepEqual([ok.code, ok.stdout], [0, 'hi']);
  // A non-zero exit is ordinary control flow here — `claude mcp get soma` on a machine where
  // nothing is registered — so the reason has to come back as data, not as a stack.
  const bad = capture(process.execPath, ['-e', 'process.stderr.write("nope");process.exit(3)']);
  assert.equal(bad.code, 3);
  assert.match(bad.stderr, /nope/);
  const absent = capture(join(tmpdir(), 'no-such-binary-soma-cli-test'), []);
  assert.notEqual(absent.code, 0);
});

test("the real capture forwards an env override to the subprocess, and inherits the CLI's without one", async () => {
  const { capture } = realDeps();
  const script = 'process.stdout.write(process.env.CLAUDE_CONFIG_DIR ?? "unset")';
  const seat = capture(process.execPath, ['-e', script], { env: { ...process.env, CLAUDE_CONFIG_DIR: '/tmp/soma-seat-b' } });
  assert.equal(seat.code, 0);
  assert.equal(seat.stdout, '/tmp/soma-seat-b', "the seat did not reach the subprocess — `claude mcp add` would write the fleet's .claude.json");
  const plain = capture(process.execPath, ['-e', script]);
  assert.equal(plain.stdout, process.env.CLAUDE_CONFIG_DIR ?? 'unset', "without the option the subprocess must see the CLI's own environment");
});

test('the real confirm answers "nobody to ask" off a tty, never "yes"', async (t) => {
  root(t);
  // node --test runs with stdin piped, so this is the non-interactive path — the one `up` must
  // refuse on rather than assume consent. Asserted `=== null`, not falsy: `false` here would mean
  // "the operator declined", which is a different fact and a different message.
  assert.strictEqual(process.stdin.isTTY, undefined, 'this test only means anything off a tty');
  assert.strictEqual(realDeps().confirm('open the queue? '), null);
});

test('doctor returns the verdict as an exit code and captures no stderr', async (t) => {
  root(t);
  const pass = mk({ doctor: async () => true });
  assert.equal(await dispatch(['doctor'], pass.deps), 0);
  const fail = mk({ doctor: async () => false });
  assert.notEqual(await dispatch(['doctor'], fail.deps), 0);
  // `loadConfig`'s legacy-key notice goes to `process.stderr` once per process. Doctor
  // deliberately does not capture stderr, so that notice reaches the terminal rather than
  // being folded into soma's own formatting — and `formatDoctor` writes stdout so
  // `soma doctor | tee` works. DOCUMENTATION, not a measurement: this asserts the arm did
  // not push anything into the injected `warn` sink on a pass, which cannot fail while the
  // arm has no `warn` call on that path. The measurement that carries the weight is the
  // exit code above; the arm's stdout/stderr routing is `doctor.mjs`'s own test.
  assert.equal(pass.stderr(), '');
});

// ------------------------------------------------------------------- the entrypoint

test('the entrypoint runs, exits with the arm code, and prints usage on a bad verb', async (t) => {
  const home = root(t);
  const env = { ...process.env, SOMA_HOME: home };
  const run = (args) => {
    try {
      return { out: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 };
    } catch (e) {
      return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status };
    }
  };
  // `import.meta.url === \`file://${process.argv[1]}\`` — the sketch — is false for any path
  // needing percent-encoding, and then the CLI silently does nothing at all. `pathToFileURL`
  // is what the watchdog already uses.
  const help = run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out.toLowerCase(), /usage/);
  const bad = run(['frobnicate']);
  assert.equal(bad.code, 1);
  assert.match(bad.out.toLowerCase(), /usage/);
});

test('USAGE names every verb the dispatcher answers, and no verb it does not', async (t) => {
  root(t);
  // The defect this closes: `send`, `kill`, `resume` and `digest` appeared in the sketch's
  // USAGE while falling through to `default: print(USAGE); return 1`, and
  // `skills/soma-promote/SKILL.md` claims CLI parity on every verb that dispatches work.
  const verbs = ['init', 'up', 'down', 'status', 'attach', 'peek', 'send', 'enqueue', 'retry',
    'kill', 'resume', 'hold', 'release', 'gc', 'doctor', 'digest', 'thaw'];
  for (const v of verbs) assert.ok(USAGE.includes(v), `USAGE must name ${v}`);

  // The positive control, and it is what makes the loop below a measurement rather than a
  // tautology: the detector has to fire on a verb that really does fall through. Without it,
  // routing the unknown-verb usage to stderr would silently make every iteration unfailable.
  const control = mk();
  assert.equal(await dispatch(['frobnicate'], control.deps), 1);
  assert.equal(/^usage: soma/m.test(control.stdout()), true, 'the fall-through detector fires');

  for (const v of verbs) {
    const h = mk();
    const code = await dispatch([v], h.deps);
    // Answered, i.e. NOT the unknown-verb path. Every arm here either works or refuses with
    // its own reason; none may reach `default`.
    const printedUsage = /^usage: soma/m.test(h.stdout());
    assert.equal(printedUsage && code === 1, false, `${v} falls through to the unknown-verb default`);
  }
});

test('RUNBOOK §9 counts thaw\'s refusals the way the arm does', async (t) => {
  root(t);
  // The doc said "`thaw`'s two refusals" while the arm has FOUR exit-3 paths — the four this file
  // drives above (an unreadable record, a storm record, a clear that throws, and `--as` without
  // the lease). Counted on both sides rather than spelled on one, so adding or removing a refusal
  // is a red test against the number a woken operator reads at 3am, not a silent drift.
  const src = readFileSync(fileURLToPath(new URL('../bin/soma.mjs', import.meta.url)), 'utf8');
  const arm = /\n {4}case 'thaw': \{\n[\s\S]*?\n {4}\}\n/.exec(src)?.[0] ?? '';
  // The could-not-observe state, explicit: a regex that found nothing would count 0 refusals and
  // "the RUNBOOK says no refusals" would pass for a reason that has nothing to do with the doc.
  assert.match(arm, /^\n {4}case 'thaw': \{/, 'the thaw arm must be findable, or the count below is a vacuous 0');
  const refusals = (arm.match(/return REFUSED;/g) ?? []).length;
  assert.equal(refusals, 4, 'unreadable record, storm record, a clear that throws, and --as without the lease');
  const WORD = ['no', 'one', 'two', 'three', 'four', 'five', 'six'][refusals] ?? String(refusals);
  const runbook = readFileSync(fileURLToPath(new URL('../RUNBOOK.md', import.meta.url)), 'utf8');
  assert.match(runbook, new RegExp("thaw`'s " + WORD + " refusals"),
    `RUNBOOK §9 must say thaw has ${WORD} refusals, which is what the arm has`);
});

test('the login verb the CLI prints is the one every document spells, and one build is cited for it', async (t) => {
  root(t);
  // Three documents tell an operator how to log a seat in, and `claude login` is not a verb on any
  // installed build: in 2.1.276 a `login` subcommand exists only under `claude auth` and under the
  // XAA IdP command group. The RUNBOOK cited 2.1.273 — not installed on this machine — while the spec
  // line beside it cited 2.1.276 for the same reading: two provenances for one fact,
  // and the older one unre-checkable. The verb itself is taken from what the CLI PRINTS, so the
  // documents are pinned to soma's own output rather than to each other.
  const h = mk({ seatsSummary: () => ({ ...SEATS_NONE, configured: 1, unverified: [seatRow('seat-c')] }) });
  await dispatch(['status'], h.deps);
  const printed = /\bclaude(?: [a-z]+)* login\b/.exec(seatsLineOf(h))?.[0] ?? null;
  assert.equal(printed, 'claude auth login',
    'the unverified-seat clause must name the login verb, or every scan below is vacuous');
  const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const DOCS = [
    ['RUNBOOK.md', read('../RUNBOOK.md')],
    ['README.md', read('../README.md')],
    ['the rotation spec', read('../docs/superpowers/specs/2026-09-15-account-rotation-design.md')],
  ];
  for (const [name, text] of DOCS) {
    assert.ok(text.includes(printed), `${name} never spells the login verb the CLI prints (${printed})`);
    assert.doesNotMatch(text, /\bclaude\s+login\b/,
      `${name} spells \`claude login\`, which is not a verb on any installed build — the CLI itself prints ${printed}`);
  }
  // One fact, one provenance. The two documents that say where the verb was read must name the
  // same build; three states, and a missing sentence reddens rather than passing silently.
  // Whitespace-tolerant across the whole phrase: both sentences are wrapped prose, and a pin that
  // forces a wrap point reddens on a reflow that changed nothing.
  const CITES = /`claude auth login`[\s\S]{0,24}read out of (\d+\.\d+\.\d+)'s\s+own command table/;
  const cited = new Map();
  for (const [name, text] of DOCS) {
    const m = CITES.exec(text);
    if (m !== null) cited.set(name, m[1]);
  }
  assert.deepEqual([...cited.keys()], ['RUNBOOK.md', 'the rotation spec'],
    'both provenance sentences must be findable — re-anchor this pin rather than dropping it');
  assert.equal(cited.get('RUNBOOK.md'), cited.get('the rotation spec'),
    'the RUNBOOK and the spec cite different builds for one reading of the command table; re-read it on one build and write that');
});

test('the promote skill table and the dispatcher agree on every row', async (t) => {
  root(t);
  // `skills/soma-promote/SKILL.md` is the fallback contract an orchestrator follows when the
  // MCP control tools did not surface. A row naming a subcommand this CLI answers with USAGE
  // is a false parity claim in the one document read while something is already wrong.
  const skill = readFileSync(fileURLToPath(new URL('../skills/soma-promote/SKILL.md', import.meta.url)), 'utf8');
  for (const verb of ['soma status', 'soma enqueue --file', 'soma send', 'soma kill', 'soma resume', 'soma peek', 'soma digest']) {
    assert.ok(skill.includes(verb), `SKILL.md names ${verb}`);
    assert.ok(USAGE.includes(verb.split(' ')[1]), `USAGE answers ${verb}`);
  }
  // The skill correctly says there is no `inbox` subcommand. Adding one silently would make its
  // §6 table wrong in the other direction. Tested by the argv, not by the text — USAGE *mentions*
  // inbox, to say it does not exist.
  const h = mk();
  assert.equal(await dispatch(['inbox'], h.deps), 1);
  assert.equal(/^usage: soma/m.test(h.stdout()), true, 'inbox is an unknown verb, not an arm');
});
