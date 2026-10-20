import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

/**
 * A fresh state root plus a fresh `config.mjs` instance pointed at it.
 *
 * `tag` (not `Date.now()`) busts the module cache, so two tests that start in the
 * same millisecond still get their own instance. `t.after` matters because
 * `npm test` runs the whole suite in one process: an unremoved mkdtemp dir per
 * test is a real leak.
 */
async function fresh(t, tag) {
  const home = mkdtempSync(join(tmpdir(), 'soma-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.SOMA_HOME = home;
  const { ensureTree, p } = await import('../bin/lib/paths.mjs?' + tag);
  ensureTree();
  return { home, p, c: await import('../bin/lib/config.mjs?' + tag) };
}

/** Hand-write a soma.json the way an operator (or a bad merge) would. */
const seed = (p, text) => writeFileSync(p('soma.json'), typeof text === 'string' ? text : JSON.stringify(text, null, 2));

/**
 * Collect what a test writes to stderr instead of printing it.
 *
 * Returned array is live. Restored in `t.after` so a failure mid-test cannot leave the whole
 * suite's diagnostics swallowed — `npm test` runs every file's tests in one process.
 */
const captureStderr = (t) => {
  const seen = [];
  const real = process.stderr.write;
  process.stderr.write = (chunk) => { seen.push(String(chunk)); return true; };
  t.after(() => { process.stderr.write = real; });
  return seen;
};

const configUrl = new URL('../bin/lib/config.mjs', import.meta.url).href;

/** A repos map big enough that one write of it is more than one syscall (~60 KB). */
const REPO_COUNT = 400;
const bigRepos = (tag) => Object.fromEntries(Array.from({ length: 400 }, (_, i) =>
  ['repo-' + i, { path: '/repos/' + tag + '/' + i, base_branch: 'develop', verify_hint: 'yarn typecheck && yarn lint' }]));

/**
 * A second process rewriting `soma.json` `rounds` times with that overlay.
 *
 * A real process is the only way to sample the window: within one process the writes
 * and reads are ordered by the event loop, so nothing tears. The generator is shipped
 * as source rather than as data so both sides write the same shape from one definition.
 */
function hammerWriter(home, rounds) {
  const src = `
    import { writeConfig } from ${JSON.stringify(configUrl)};
    const bigRepos = ${bigRepos.toString()};
    for (let i = 0; i < ${rounds}; i++) writeConfig({ repos: bigRepos(i % 2 ? 'a' : 'b') });
  `;
  const state = { done: false };
  state.promise = new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, ['--input-type=module', '-e', src], {
      env: { ...process.env, SOMA_HOME: home },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    cp.stderr.on('data', (d) => { err += d; });
    cp.on('error', (e) => { state.done = true; reject(e); });
    cp.on('exit', (code) => {
      state.done = true;
      code === 0 ? resolve() : reject(new Error(`writer exited ${code}: ${err}`));
    });
  });
  return state;
}

// ---------------------------------------------------------------------------
// The original test, verbatim.
// ---------------------------------------------------------------------------

test('defaults expose max_leads 10 and stagger 90; writeConfig merges', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'soma-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.SOMA_HOME = home;
  const { ensureTree } = await import('../bin/lib/paths.mjs?' + Date.now());
  ensureTree();
  const c = await import('../bin/lib/config.mjs?' + Date.now());
  assert.equal(c.DEFAULTS.max_leads, 10);
  assert.equal(c.DEFAULTS.stagger_s, 90);
  const merged = c.writeConfig({ max_leads: 4 });
  assert.equal(merged.max_leads, 4);
  assert.equal(c.loadConfig().max_leads, 4);
  assert.equal(c.loadConfig().stagger_s, 90); // untouched default survives
});

// ---------------------------------------------------------------------------
// DEFAULTS is the constitution: every value here is an operator decision that
// something downstream reads by name.
// ---------------------------------------------------------------------------

test('DEFAULTS carry the exact governance values the fleet is built around', async (t) => {
  const { c } = await fresh(t, 'defaults');
  assert.deepEqual(c.DEFAULTS, {
    max_leads: 10, // decision D3 — the ceiling never queues the backlog below its size
    stagger_s: 90,
    tick_ms: 30000,
    linger_minutes: 45,
    blocked_slot_minutes: 120,
    stall_minutes: 20,
    settle_minutes: 30,
    team_size_max: 3,
    teammate_effort: 'inherit', // decision D2
    lead_effort: 'max',
    notify_policy: 'full',
    tested_claude: { min: '2.1.178', max: '2.1.999' },
    // A fraction, not an absolute: the absolute this replaces was a spend number read as a
    // context number. Derive the limit with resumeContextLimit(cfg), never by hand.
    resume_context_fraction: 0.7,
    resume_context_window: 1000000, // chosen off fable's 833,935; established for the pinned opus (contextWindow 1000000)
    // tokens_cap: directory-metered (lead + team), p95-of-population + headroom, with a ~2.5x
    // team multiplier that is an ESTIMATE in a 1.5x-4x band. research is a FLOOR, n=0.
    // No ladder: turns price work badly. Both clauses of the rule are asserted below.
    // turn_cap: 2 x the observed max of 254, rounded up to the next 100, on the lead's OWN turns.
    budgets: {
      research: { tokens_cap: 5000000, turn_cap: 600, wall_ms: 7200000 },
      standard: { tokens_cap: 20000000, turn_cap: 600, wall_ms: 28800000 },
      iterate: { tokens_cap: 38000000, turn_cap: 600, wall_ms: 43200000 },
      review: { tokens_cap: 25000000, turn_cap: 600, wall_ms: 36000000 },
      babysit: { tokens_cap: 8000000, turn_cap: 0, wall_ms: 0 },
    },
    repos: {},
    teammate_mcp_allow: [],
    env_allow: [],
    lead_branch_push: true,
    seats: [],
  });
  // `harness.mjs` validates a lead's reported `budget_class` against exactly these
  // keys, and `prompts/harnesses.json` maps H1-H6 onto them. A renamed or dropped
  // class rejects every HARNESS report for it, which strands the task unbudgeted.
  assert.deepEqual(Object.keys(c.DEFAULTS.budgets).sort(), ['babysit', 'iterate', 'research', 'review', 'standard']);
  for (const [cls, b] of Object.entries(c.DEFAULTS.budgets)) {
    assert.deepEqual(Object.keys(b).sort(), ['tokens_cap', 'turn_cap', 'wall_ms'], `${cls} shape`);
  }
});

test('every turn_cap satisfies the rule config.mjs states, so the sentence cannot go stale again', async (t) => {
  const { c } = await fresh(t, 'turncaps');
  // The comment in config.mjs claimed `turn_cap` was "~1.3x the observed max turn count" while
  // four of the five values measured 0.47x / 0.98x / 1.18x / 1.57x of it — and `standard: 250`
  // sat UNDER the observed max of 254, so it would have killed the very session the calibration
  // named as the closest structural analogue to a delegating lead. A prose claim about numbers
  // that nothing checks is exactly how that happened, and it happened twice (the original
  // 30/50/60/80 ladder was inherited and never calibrated at all). This is the check.
  const OBSERVED_MAX_TURNS = 254;      // MEASURED, n=21 real one-ticket sessions (median 134)
  // MEASURED, n=1: the one real lead-shaped directory carries ~177,000 est_tokens per LEAD turn
  // (29,918,461 est over its lead's own 169 turns), and a later live re-read of that same
  // growing directory measured ~232,000. So the MEASURED band is ~177,000–232,000 and the
  // constant below sits deliberately beneath it.
  //
  // THE FALSE PROVENANCE THIS LINE USED TO CARRY, corrected in both places at once. It said
  // "the same figure read 145,961 at an earlier snapshot of the same growing directory", which
  // presents 145,961 as a reading. It is a CROSS-SNAPSHOT COMPOSITION: an earlier snapshot's
  // 5-transcript directory total over the CURRENT snapshot's lead turn count. No observed state
  // ever had that per-turn cost. The identical sentence sat in `config.mjs` and the recorded
  // debt named only that one — so a one-site fix would have left the falsehood in the very test
  // whose stated job is to stop prose claims about numbers from going stale. That is why both
  // moved together, and it is the general rule this build keeps re-learning: when a false
  // premise is found, grep for every site that ENCODES it, not just the site that states it.
  const DIR_EST_PER_LEAD_TURN = 145_000;   // a chosen floor below the measured band, not a reading
  const ceil100 = (n) => Math.ceil(n / 100) * 100;

  for (const [cls, b] of Object.entries(c.DEFAULTS.budgets)) {
    if (b.turn_cap === 0) continue;  // babysit disables the backstop by design — asserted below
    // The rule, stated once in config.mjs and enforced here. One value, no ladder: turns price
    // work badly (est_tokens ~ turns^1.23), so a per-class turn ladder only pretends they do.
    assert.equal(b.turn_cap, ceil100(2 * OBSERVED_MAX_TURNS),
      `${cls}: turn_cap must be 2 x the observed max of ${OBSERVED_MAX_TURNS}, rounded up to the next 100`);
    // Clause 1 — a backstop set below the observed maximum is not a backstop, it is the budget
    // wearing a backstop's documentation. `standard: 250` sat under an observed 254.
    assert.ok(b.turn_cap >= 2 * OBSERVED_MAX_TURNS,
      `${cls}: turn_cap ${b.turn_cap} does not clear 2x the observed max of ${OBSERVED_MAX_TURNS}`);
    // Clause 2 — `tokens_cap` must bind BEFORE `turn_cap` at observed cost, or `turn_cap` is the
    // operative budget however it is documented. This is the assertion that keeps the two moving
    // together: raise a `tokens_cap` far enough (the 4x-multiplier case config.mjs names, where
    // `standard` becomes 32,000,000) and this fails until `turn_cap` follows.
    assert.ok(b.tokens_cap / b.turn_cap <= DIR_EST_PER_LEAD_TURN,
      `${cls}: implied allowance ${Math.round(b.tokens_cap / b.turn_cap)} est_tokens per lead turn exceeds the `
      + `measured ${DIR_EST_PER_LEAD_TURN} — turns would bind before tokens, which is the diagnosis this rule removes`);
  }
  // babysit is the one exemption and it is explicit, not an omission: a long-lived watcher has
  // many cheap turns over an unbounded wall, so turns are the wrong axis for it entirely.
  assert.equal(c.DEFAULTS.budgets.babysit.turn_cap, 0, 'a long-lived watcher is not bounded in turns');
  // And the ordering that matters is in tokens_cap, not in a turn ladder — turns price work
  // badly (est_tokens ~ turns^1.23), so a per-class turn ladder only pretends they do.
  const caps = c.DEFAULTS.budgets;
  assert.ok(caps.research.tokens_cap < caps.standard.tokens_cap, 'research < standard');
  assert.ok(caps.standard.tokens_cap < caps.review.tokens_cap, 'standard < review');
  assert.ok(caps.review.tokens_cap < caps.iterate.tokens_cap, 'review < iterate');
});

test('a retired soma.json key is stripped from the merged config rather than carried forward', async (t) => {
  const { c, p } = await fresh(t, 'legacy');
  captureStderr(t);
  // Removing `resume_token_guard` from DEFAULTS protected the DEFAULT population and left the
  // TUNED one exposed. `loadConfig` is `deepMerge(DEFAULTS, readOverlay())` and this file's own
  // header promises unknown keys are preserved, so an operator soma.json that already carries
  // `resume_token_guard: 200000` KEEPS it on cfg after the merge. A consumer written to the old
  // design then reads a cumulative SPEND number as a live CONTEXT number — 200x apart on one real
  // transcript — and reproduces the original bug verbatim, silently, on exactly the machines
  // where someone bothered to tune the dial.
  assert.ok('resume_token_guard' in c.LEGACY_KEYS, 'the retired key must be NAMED, not merely absent from DEFAULTS');
  assert.ok(c.LEGACY_KEYS.resume_token_guard.length > 40, 'and carry a reason the operator can act on');

  seed(p, { resume_token_guard: 200000, max_leads: 3 });
  const cfg = c.loadConfig();
  assert.ok(!('resume_token_guard' in cfg), 'the retired key must not survive the merge');
  assert.equal(cfg.resume_token_guard, undefined);
  assert.equal(cfg.max_leads, 3, 'and the honest key beside it still applies');
  assert.equal(cfg.resume_context_fraction, 0.7, 'with the replacement in place');
  // The write path returns a merged config of its own and needs the same treatment.
  assert.ok(!('resume_token_guard' in c.writeConfig({ stagger_s: 5 })), 'writeConfig returns a merged config too');
  // The FILE is deliberately NOT rewritten. soma.json is the operator's overlay; editing it
  // behind their back is the same violation as letting an old soma eat a new file's settings.
  // The warning is the fix, and it tells them to delete the line.
  assert.equal(JSON.parse(readFileSync(p('soma.json'), 'utf8')).resume_token_guard, 200000,
    "the operator's own file must be left intact");
  // A genuinely unknown key is still preserved — this is a named exception, not a whitelist.
  seed(p, { resume_token_guard: 1, future_knob: { deep: true } });
  assert.deepEqual(c.loadConfig().future_knob, { deep: true }, 'an unknown key is not a retired one');
});

test('a retired key warns once per process, names its replacement, and does not spam the tick', async (t) => {
  const { c, p } = await fresh(t, 'legacywarn');
  seed(p, { resume_token_guard: 200000 });
  const seen = captureStderr(t);
  for (let i = 0; i < 4; i++) c.loadConfig();
  c.writeConfig({ stagger_s: 1 });

  assert.equal(seen.length, 1,
    `the watchdog calls loadConfig() on every 30 s tick — one warning per process, got ${seen.length}`);
  assert.match(seen[0], /resume_token_guard/, 'it must name the key');
  assert.match(seen[0], /soma\.json/, 'and the file to edit');
  assert.match(seen[0], /resumeContextLimit/, 'and the replacement, or the operator has nowhere to go');
  // Dropped in silence is the one thing this must not be: the operator chose that number for a
  // reason and it no longer means what they meant.
  assert.match(seen[0], /SPEND[\s\S]*CONTEXT/, 'and why the old number was wrong, not just that it is gone');
});

test('loadConfig() with no soma.json is exactly DEFAULTS, and every call hands back a private copy', async (t) => {
  const { c } = await fresh(t, 'nofile');
  assert.deepEqual(c.loadConfig(), c.DEFAULTS);

  // The watchdog is a long-lived process that calls loadConfig() every tick. If a
  // merged config shared structure with DEFAULTS, one consumer normalizing a value
  // in place would silently rewrite the defaults for every later caller in the
  // process — a governance cap that changes without anyone editing soma.json.
  const cfg = c.loadConfig();
  cfg.max_leads = 1;
  cfg.budgets.standard.tokens_cap = 1;
  cfg.env_allow.push('LEAK');
  cfg.repos.app = { path: '/leak' };
  assert.equal(c.DEFAULTS.max_leads, 10);
  assert.equal(c.DEFAULTS.budgets.standard.tokens_cap, 20000000);
  assert.deepEqual(c.DEFAULTS.env_allow, []);
  assert.deepEqual(c.DEFAULTS.repos, {});
  assert.deepEqual(c.loadConfig(), c.DEFAULTS);
  assert.notEqual(c.loadConfig().budgets, c.loadConfig().budgets, 'nested objects must not be shared between calls');
});

test('DEFAULTS is frozen all the way down', async (t) => {
  const { c } = await fresh(t, 'frozen');
  assert.throws(() => { c.DEFAULTS.max_leads = 4; }, TypeError);
  assert.throws(() => { c.DEFAULTS.budgets.standard.tokens_cap = 1; }, TypeError);
  assert.throws(() => { c.DEFAULTS.tested_claude.max = '9.9.9'; }, TypeError);
  assert.throws(() => { c.DEFAULTS.env_allow.push('X'); }, TypeError);
  assert.throws(() => { delete c.DEFAULTS.budgets; }, TypeError);
  assert.equal(c.DEFAULTS.max_leads, 10);
});

// ---------------------------------------------------------------------------
// Merge semantics: soma.json is an overlay, not a replacement.
// ---------------------------------------------------------------------------

test('a partial soma.json merges recursively over defaults; arrays and scalars replace', async (t) => {
  const { c, p } = await fresh(t, 'partial');
  seed(p, {
    max_leads: 3,
    budgets: { standard: { turn_cap: 5 } },
    repos: { 'acme-app-2.0': { path: '/repos/acme-app', base_branch: 'develop' } },
    env_allow: ['HOME', 'PATH'],
  });
  const cfg = c.loadConfig();

  assert.equal(cfg.max_leads, 3, 'the operator wins');
  assert.equal(cfg.stagger_s, 90, 'an unmentioned default survives');
  // Nested merge is the whole point: naming one field of one budget class must not
  // wipe that class's other caps, nor the four classes the operator never mentioned.
  assert.deepEqual(cfg.budgets.standard, { tokens_cap: 20000000, turn_cap: 5, wall_ms: 28800000 });
  assert.deepEqual(cfg.budgets.research, c.DEFAULTS.budgets.research);
  assert.deepEqual(Object.keys(cfg.budgets).sort(), ['babysit', 'iterate', 'research', 'review', 'standard']);
  assert.deepEqual(cfg.repos['acme-app-2.0'], { path: '/repos/acme-app', base_branch: 'develop' });
  // An allowlist is a decision, not an accumulation: element-wise merging would make
  // `env_allow` impossible to shrink, and this list is a security boundary.
  assert.deepEqual(cfg.env_allow, ['HOME', 'PATH']);
  assert.deepEqual(cfg.teammate_mcp_allow, []);
});

test('an unknown key in soma.json survives the merge instead of being dropped', async (t) => {
  const { c, p } = await fresh(t, 'unknown');
  // Same reason `readFleet` spreads unknown fields through: a file written by a newer
  // soma must not lose the operator's settings when an older one reads or rewrites it.
  seed(p, { max_leads: 2, future_knob: { deep: true } });
  assert.deepEqual(c.loadConfig().future_knob, { deep: true });
  assert.deepEqual(c.writeConfig({ stagger_s: 5 }).future_knob, { deep: true });
  assert.deepEqual(JSON.parse(readFileSync(p('soma.json'), 'utf8')).future_knob, { deep: true });
});

test('loadConfig re-reads the file every call, so an operator edit lands without a restart', async (t) => {
  const { c, p } = await fresh(t, 'reread');
  // `soma-watchdog` re-reads `tick_ms` on every loop and admission re-reads
  // `max_leads`; caching the parse here would mean an edit needs a fleet restart.
  seed(p, { tick_ms: 1000 });
  assert.equal(c.loadConfig().tick_ms, 1000);
  seed(p, { tick_ms: 5000 });
  assert.equal(c.loadConfig().tick_ms, 5000);
  rmSync(p('soma.json'));
  assert.equal(c.loadConfig().tick_ms, 30000, 'a deleted file falls back to the default');
});

// ---------------------------------------------------------------------------
// writeConfig
// ---------------------------------------------------------------------------

test('writeConfig accumulates patches without losing a sibling key', async (t) => {
  const { c, p } = await fresh(t, 'accumulate');
  c.writeConfig({ max_leads: 4 });
  c.writeConfig({ stagger_s: 120 });
  // Registering a second repo must not deregister the first: `spawn` reads
  // `cfg.repos[task.repo]` and an evicted repo means a lead with no base branch.
  c.writeConfig({ repos: { 'acme-app-2.0': { path: '/repos/acme-app', base_branch: 'develop' } } });
  const merged = c.writeConfig({ repos: { 'acme-pay': { path: '/repos/acme-pay' } } });

  for (const cfg of [merged, c.loadConfig()]) {
    assert.equal(cfg.max_leads, 4);
    assert.equal(cfg.stagger_s, 120);
    assert.equal(cfg.tick_ms, 30000, 'defaults still fill the gaps');
    assert.deepEqual(Object.keys(cfg.repos).sort(), ['acme-app-2.0', 'acme-pay']);
    assert.equal(cfg.repos['acme-app-2.0'].base_branch, 'develop');
  }
  // Deep into a nested default, twice, from a clean file.
  c.writeConfig({ budgets: { standard: { turn_cap: 5 } } });
  c.writeConfig({ budgets: { babysit: { tokens_cap: 1 } } });
  const cfg = c.loadConfig();
  assert.deepEqual(cfg.budgets.standard, { tokens_cap: 20000000, turn_cap: 5, wall_ms: 28800000 });
  assert.deepEqual(cfg.budgets.babysit, { tokens_cap: 1, turn_cap: 0, wall_ms: 0 });
  // An array patch replaces rather than appends or merges element-wise. Shrinking is
  // the case that separates the three: an index-wise merge would leave 'B' and 'C'
  // behind, so a revoked env var would stay in the allowlist forever.
  c.writeConfig({ env_allow: ['A', 'B', 'C'] });
  assert.deepEqual(c.writeConfig({ env_allow: ['Z'] }).env_allow, ['Z']);
  assert.deepEqual(JSON.parse(readFileSync(p('soma.json'), 'utf8')).env_allow, ['Z']);
  assert.deepEqual(c.loadConfig().env_allow, ['Z']);
});

test('writeConfig stores the operator overlay only — never the defaults, never a DEFAULTS key', async (t) => {
  const { c, p } = await fresh(t, 'overlay');
  c.writeConfig({ max_leads: 4 });
  const onDisk = JSON.parse(readFileSync(p('soma.json'), 'utf8'));

  // Baking the whole of DEFAULTS into the file would pin today's values forever: a
  // later soma that lowers `max_leads` or retunes a budget would be silently
  // shadowed by the snapshot. The file is what the operator changed; code owns the rest.
  assert.deepEqual(onDisk, { max_leads: 4 });
  assert.ok(!('DEFAULTS' in onDisk), 'the defaults object must never be written as a key');
  assert.ok(!('budgets' in onDisk), 'an untouched nested default must not be materialized');
  assert.equal(c.loadConfig().max_leads, 4);
  assert.equal(c.loadConfig().budgets.standard.turn_cap, 600, 'and it still reads complete');
  assert.deepEqual(c.writeConfig({}).max_leads, 4, 'an empty patch is a no-op, not a reset');
});

test('writeConfig publishes atomically and recreates a wiped state root', async (t) => {
  const { c, home, p } = await fresh(t, 'atomic');
  c.writeConfig({ max_leads: 4 });
  // tmp+rename is the house publish idiom (`writeFleet`, `writeCursor`): a reader
  // sees the old file or the new one, never a truncated one — which matters because
  // `loadConfig` deliberately throws on unparseable JSON.
  assert.deepEqual(readdirSync(home).filter((f) => f.includes('.tmp')), []);

  rmSync(home, { recursive: true, force: true });
  assert.equal(c.writeConfig({ stagger_s: 7 }).stagger_s, 7, 'a wiped state root self-heals');
  assert.equal(c.loadConfig().stagger_s, 7);
  assert.deepEqual(JSON.parse(readFileSync(p('soma.json'), 'utf8')), { stagger_s: 7 });
});

test('writeConfig rejects a patch that is not an object; a missing patch is a no-op write', async (t) => {
  const { c, p } = await fresh(t, 'badpatch');
  for (const patch of [5, 'max_leads=4', true, ['max_leads', 4]]) {
    assert.throws(() => c.writeConfig(patch), TypeError, `${JSON.stringify(patch)} must be refused`);
  }
  // `Object.keys(5)` is `[]`, so an unguarded merge would report success having
  // written nothing — the silent no-op that makes a config bug look like a read bug.
  assert.equal(c.writeConfig().max_leads, 10);
  assert.deepEqual(JSON.parse(readFileSync(p('soma.json'), 'utf8')), {});
});

// ---------------------------------------------------------------------------
// A config that cannot be trusted must not read as "defaults".
// ---------------------------------------------------------------------------

test('a corrupt or non-object soma.json fails loudly instead of reverting to defaults', async (t) => {
  const { c, p } = await fresh(t, 'corrupt');
  // Reading `max_leads: 3` as 10 because the file lost a brace is the worst outcome
  // available: the operator's cap is gone and the fleet ramps to ten leads anyway.
  for (const raw of ['', '{', '{"max_leads": 4,}', 'null', '[]', '42', '"nope"', 'true']) {
    seed(p, raw);
    assert.throws(() => c.loadConfig(), (e) => {
      assert.ok(e instanceof Error, `${JSON.stringify(raw)} threw a non-Error`);
      assert.match(e.message, /soma\.json/, `${JSON.stringify(raw)} must name the offending file`);
      return true;
    }, `loadConfig must reject ${JSON.stringify(raw)}`);
    assert.throws(() => c.writeConfig({ max_leads: 1 }), /soma\.json/, `writeConfig must reject ${JSON.stringify(raw)}`);
  }
  // And a bad file is never clobbered by the failed write, so it stays repairable.
  assert.equal(readFileSync(p('soma.json'), 'utf8'), 'true');
});

test('a reader in another process never catches soma.json half-written', async (t) => {
  const { c, home } = await fresh(t, 'tear');
  // This test is what earns the right to throw on unparseable JSON. `writeFileSync`
  // straight to soma.json truncates first, so a concurrent watchdog tick would read
  // an empty or half-flushed file and — by design — throw, turning every config write
  // into a chance of a dead tick. tmp+rename makes the swap atomic instead.
  c.writeConfig({ repos: bigRepos('seed') }); // so a complete file is the invariant from read #1
  const writer = hammerWriter(home, 60);
  let reads = 0;
  while (!writer.done) {
    const cfg = c.loadConfig(); // a torn read throws here — that IS the assertion
    assert.equal(cfg.max_leads, 10);
    assert.equal(Object.keys(cfg.repos).length, REPO_COUNT);
    reads++;
    await new Promise((r) => setImmediate(r));
  }
  await writer.promise;
  assert.ok(reads > 20, `only ${reads} reads landed — the race window was never sampled`);
});

/**
 * The forgery has to be tried on a key DEFAULTS does not already own.
 *
 * `deepMerge(DEFAULTS, over)` starts from `copy(DEFAULTS)`, which already holds
 * `max_leads: 10` as an OWN property — so a forged `max_leads: 1` arriving on the
 * prototype is shadowed whatever `keysOf` does. `assert.equal(cfg.max_leads, 10)`
 * therefore measures the merge order and not the guard, and was measured toothless
 * against the exact defect this test is named for. Same for `budgets.standard`'s real
 * caps, and for `merged.max_leads` on the patch path.
 *
 * Two other things this test used to assert that no mutation of this module can make
 * fail, recorded so they are not restored: `{}.max_leads === undefined` ("nothing
 * leaked onto Object.prototype") — `copy()` builds a fresh `out = {}` and `out.__proto__
 * = v` reparents THAT object, never `Object.prototype`, so global pollution is
 * unreachable here by construction; and `deepEqual(nested.repos, {})` — a reparented
 * object with no own keys IS deep-strict-equal to `{}`, because that comparison does not
 * reach the prototype. Both verified across five mutations of the merge.
 */
test('a soma.json key named __proto__ cannot forge a config value', async (t) => {
  const { c, p } = await fresh(t, 'proto');
  // `JSON.parse` keeps `__proto__` as an own key, and `out.__proto__ = v` runs the
  // Object.prototype setter — so an unguarded merge would hand back a config whose
  // `max_leads` reads 1 while `Object.keys()` and `JSON.stringify()` show nothing.
  seed(p, '{"__proto__": {"max_leads": 1}, "stagger_s": 7}');
  const cfg = c.loadConfig();
  assert.equal(Object.getPrototypeOf(cfg), Object.prototype);
  assert.equal(cfg.stagger_s, 7, 'the honest key beside it still applies');

  // The failure mode stated as itself: a value that reads forged off the config while
  // appearing in no `Object.keys` and no diff. On a key DEFAULTS cannot answer for.
  seed(p, '{"__proto__": {"not_a_default_key": "forged"}, "stagger_s": 7}');
  const forged = c.loadConfig();
  assert.equal(forged.not_a_default_key, undefined, 'a forged key is readable off the config through its prototype chain');
  assert.deepEqual(Object.keys(forged).filter((k) => k === '__proto__'), [], 'the forged key survived the merge as an own key');

  // A nested container DEFAULTS does not own, which is a SECOND filter and not the same
  // one: `deepMerge` recurses only where both sides are mergeable, so an unknown key's
  // value is handed to `copy()` wholesale. Measured — dropping the filter from `copy`
  // alone is invisible to every other assertion in this file.
  seed(p, '{"future_knob": {"__proto__": {"path": "/evil"}, "deep": true}}');
  const unknown = c.loadConfig().future_knob;
  assert.equal(unknown.path, undefined, 'a forged key reached an unknown config container');
  assert.equal(Object.getPrototypeOf(unknown), Object.prototype);
  assert.equal(unknown.deep, true, 'the honest sibling in the same container still applies');

  // And a nested container DEFAULTS does own, which is the recursive-merge path.
  seed(p, '{"repos": {"__proto__": {"path": "/evil"}}, "budgets": {"standard": {"__proto__": {"forged_cap": 1}}}}');
  const nested = c.loadConfig();
  assert.equal(Object.getPrototypeOf(nested.repos), Object.prototype);
  assert.deepEqual(Object.keys(nested.repos), [], 'a forged repo key survived as an own key');
  assert.equal(nested.budgets.standard.forged_cap, undefined, 'a forged cap is readable off a budget class');
  assert.equal(Object.getPrototypeOf(nested.budgets.standard), Object.prototype, 'a budget class was reparented');

  // Same guard on the patch path, which is fed by MCP tool arguments — but what is
  // decidable here is narrower than it looks. A `__proto__` in a patch is consumed by
  // the setter on the overlay object, so it is an own key of nothing: `JSON.stringify`
  // does not persist it and the second merge does not copy it, whatever `keysOf` does.
  // The reachable claim is that nothing forged reaches the FILE, which is what a merge
  // built from object spread (`{...overlay, ...patch}` defines rather than sets) breaks.
  const merged = c.writeConfig(JSON.parse('{"__proto__": {"max_leads": 2}, "tick_ms": 4000}'));
  assert.equal(merged.tick_ms, 4000, 'the honest key in the patch still lands');
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  const onDisk = readFileSync(p('soma.json'), 'utf8');
  assert.equal(onDisk.includes('__proto__'), false, `a forged key was persisted into soma.json: ${onDisk}`);
});

// ---------------------------------------------------------------------------
// seats — the account pool (design 2026-09-15 §2)
// ---------------------------------------------------------------------------

test('DEFAULTS.seats is an empty pool, so a fleet that configures no seats rotates nothing', async (t) => {
  const { c } = await fresh(t, 'seats-default');
  assert.deepEqual(c.DEFAULTS.seats, []);
});

test('a seats overlay replaces the default wholesale, so a seat is removed by editing soma.json', async (t) => {
  const { c, p } = await fresh(t, 'seats-overlay');
  seed(p, { seats: [{ config_dir: '~/.claude-seat-a', label: 'seat-a' }, { config_dir: '~/.claude-seat-b', label: 'seat-b' }] });
  assert.deepEqual(c.loadConfig().seats.map((s) => s.label), ['seat-a', 'seat-b']);
  seed(p, { seats: [{ config_dir: '~/.claude-seat-b', label: 'seat-b' }] });
  // An element-wise merge would leave seat-a in the pool forever; a seat whose account was
  // handed back must leave the pool by the same edit that added it.
  assert.deepEqual(c.loadConfig().seats.map((s) => s.label), ['seat-b']);
});

test('loadConfig refuses a seats that is not an array, naming the file, the key and the shape it wants', async (t) => {
  const { c, p } = await fresh(t, 'seats-shape');
  // A non-array `seats` used to load fine and be read as "no seats" by the watchdog's seat pick,
  // while the spawner read the same value through `seats.loadSeats` and threw — after a dead
  // lead's pane was killed and its revival attempt charged. Refused here, it never reaches either.
  for (const value of [{}, 'a', 5, null, true]) {
    seed(p, { seats: value });
    assert.throws(() => c.loadConfig(), (e) => {
      assert.match(e.message, /soma\.json/, `${JSON.stringify(value)}: the refusal must name the file`);
      assert.match(e.message, /\bseats\b/, `${JSON.stringify(value)}: the refusal must name the key`);
      assert.match(e.message, /config_dir/, `${JSON.stringify(value)}: the refusal must say what an entry looks like`);
      return true;
    }, `seats ${JSON.stringify(value)} was accepted`);
  }
  // What stays accepted: an empty pool, the key absent, a real pool — and an array whose ENTRY is
  // malformed. Entries are `seats.loadSeats`' to judge and `soma doctor`'s to name, not this loader's.
  seed(p, { seats: [] });
  assert.deepEqual(c.loadConfig().seats, []);
  seed(p, { max_leads: 2 });
  assert.deepEqual(c.loadConfig().seats, [], 'absent, the default applies');
  seed(p, { seats: [{ config_dir: '~/.claude-seat-a', label: 'seat-a' }] });
  assert.deepEqual(c.loadConfig().seats.map((s) => s.label), ['seat-a']);
  seed(p, { seats: ['not-an-entry'] });
  assert.deepEqual(c.loadConfig().seats, ['not-an-entry'], 'a malformed entry is not this loader\'s to refuse');
});

test('the seats DEFAULTS array is frozen like every other allowlist', async (t) => {
  const { c } = await fresh(t, 'seats-frozen');
  // `/not extensible/`, not a bare TypeError: against a DEFAULTS with no `seats` at all,
  // `undefined.push` is a TypeError too, and the assertion would pass having pinned nothing.
  assert.throws(() => { c.DEFAULTS.seats.push({ config_dir: '/x', label: 'x' }); }, { name: 'TypeError', message: /not extensible/ });
});

test('a seats patch replaces the pool rather than merging into it, so a seat can be removed by patch', async (t) => {
  const { c, p } = await fresh(t, 'seats-patch');
  seed(p, { seats: [{ config_dir: '~/.claude-seat-a', label: 'seat-a' }, { config_dir: '~/.claude-seat-b', label: 'seat-b' }] });
  // The bite the test above cannot deliver, and the reason this one exists: `loadConfig` always
  // merges the FILE over an EMPTY `DEFAULTS.seats`, so an element-wise merge of arrays would read
  // identically there — mutation-checked, and that test survives it. `writeConfig` merges the patch
  // over the operator's own overlay, which is the one place a merged array would keep a seat whose
  // account was handed back (and the path the bus's config patch takes).
  assert.deepEqual(c.writeConfig({ seats: [{ config_dir: '~/.claude-seat-b', label: 'seat-b' }] }).seats.map((s) => s.label), ['seat-b']);
});

// ---------------------------------------------------------------------------
// Issue #21: max_leads is judged at load time. A numeric string is handed back as its number, so
// every reader sees one value; anything else is refused, naming the file and key.
// ---------------------------------------------------------------------------

test('loadConfig hands back a numeric-string max_leads as a number (#21)', async (t) => {
  const { c, p } = await fresh(t, 'numeric-strings');
  // The spend projection read `"10"` as 0 while admission read it as 10: `soma up` asked to open
  // the queue to 0 leads, and ten started.
  seed(p, { max_leads: '10' });
  assert.equal(c.loadConfig().max_leads, 10);
  seed(p, { max_leads: ' 4 ' });
  assert.equal(c.loadConfig().max_leads, 4, 'trimmed, as fleet.admit trims it');
  // Normalising the merged copy must not reach the frozen DEFAULTS (it would throw if it tried).
  assert.equal(c.DEFAULTS.max_leads, 10);
});

test('loadConfig refuses a max_leads that is not a non-negative integer, naming the file and the key (#21)', async (t) => {
  const { c, p } = await fresh(t, 'maxleads-refused');
  for (const value of [null, '', '  ', 'ten', 2.5, '2.5', -1, '-1', [], {}, true, 'Infinity']) {
    seed(p, { max_leads: value });
    assert.throws(() => c.loadConfig(), (e) => {
      assert.match(e.message, /soma\.json/, `${JSON.stringify(value)}: the refusal must name the file`);
      assert.match(e.message, /\bmax_leads must be a non-negative integer\b/, `${JSON.stringify(value)}: the key and the shape`);
      assert.match(e.message, /got /, `${JSON.stringify(value)}: and what it got`);
      return true;
    }, `max_leads ${JSON.stringify(value)} was accepted`);
  }
  seed(p, { max_leads: 'ten' });
  assert.throws(() => c.loadConfig(), /got "ten"$/);
  seed(p, { max_leads: 0 });
  assert.equal(c.loadConfig().max_leads, 0, 'a cap of 0 is a real setting: admit nothing');
});

test('loadConfig normalises max_leads whatever budgets holds, null and arrays included (#21, #52)', async (t) => {
  const { c, p } = await fresh(t, 'budgets-shapes');
  // Not judged here: the shape of `budgets` is its readers' to refuse. Whatever it holds, the
  // max_leads beside it is still read and handed back as its number, and no tokens_cap is judged
  // that a class does not carry itself.
  for (const budgets of [null, [], 'x', { weird: null }, { weird: 5 }, { weird: 'x' }, { weird: ['5'] }, { capless: { turn_cap: 9 } }]) {
    seed(p, { max_leads: '3', budgets });
    let cfg;
    assert.doesNotThrow(() => { cfg = c.loadConfig(); }, `budgets ${JSON.stringify(budgets)} threw`);
    assert.equal(cfg.max_leads, 3);
  }
  // A class with no tokens_cap of its own is not token-capped, as checkBudget reads it, and is not
  // handed one.
  seed(p, { budgets: { capless: { turn_cap: 9 } } });
  assert.equal(Object.hasOwn(c.loadConfig().budgets.capless, 'tokens_cap'), false);
});

// ---------------------------------------------------------------------------
// Issue #52: a budget class's numeric-string tokens_cap is handed back as its number at load time,
// by the breaker's rule, so the breaker, the spend projection and soma_status all read one value.
// Anything else is left for the breaker to refuse in that class alone.
// ---------------------------------------------------------------------------

test('loadConfig hands back a numeric-string tokens_cap as a number (#52)', async (t) => {
  const { c, p } = await fresh(t, 'tokens-cap-strings');
  // The breaker enforced `"60000000"` at 60M while the projection read it as 0, so the worst case
  // `soma up` asked about left that class out.
  for (const [raw, want] of [['60000000', 60000000], [' 7 ', 7], ['2e3', 2000]]) {
    seed(p, { budgets: { heavy: { tokens_cap: raw, turn_cap: '9' } } });
    const cls = c.loadConfig().budgets.heavy;
    assert.equal(cls.tokens_cap, want, `${JSON.stringify(raw)} is read as reqNum reads it`);
    assert.equal(cls.turn_cap, '9', 'only tokens_cap is normalised: the other keys of the class are untouched');
  }
  // Normalising the merged copy must not reach the frozen DEFAULTS (it would throw if it tried).
  assert.equal(c.DEFAULTS.budgets.standard.tokens_cap, 20000000);
  assert.equal(Object.hasOwn(c.DEFAULTS.budgets, 'heavy'), false);
});

test('loadConfig leaves a tokens_cap the breaker would refuse as it is, for the breaker to refuse in that class alone (#52)', async (t) => {
  const { c, p } = await fresh(t, 'tokens-cap-left');
  const { checkBudget } = await import('../bin/lib/wd/budget.mjs');
  // Not refused at load: `tick()` calls loadConfig() first, outside every phase's try, so a throw
  // here would skip every tick and leave the whole fleet with no breaker. The breaker refuses the
  // value per lead instead, inside the meter's own try, so only that class loses its breaker.
  for (const value of ['lots', '', '  ', null, -1, '-1', 'Infinity', 'NaN', true, [], {}]) {
    seed(p, { budgets: { heavy: { tokens_cap: value, turn_cap: 9 } } });
    let cfg;
    assert.doesNotThrow(() => { cfg = c.loadConfig(); }, `tokens_cap ${JSON.stringify(value)} refused the whole file`);
    assert.deepEqual(cfg.budgets.heavy.tokens_cap, value, `${JSON.stringify(value)} is handed through untouched`);
    assert.throws(() => checkBudget(null, cfg.budgets.heavy), { name: 'TypeError', message: /cls\.tokens_cap must be a non-negative finite number/ },
      `${JSON.stringify(value)}: the breaker still refuses it`);
  }
  // 0 is "no token cap" and a cap need not be whole: both are the breaker's to accept.
  for (const ok of [0, 2.5]) {
    seed(p, { budgets: { heavy: { tokens_cap: ok, turn_cap: 9 } } });
    assert.equal(c.loadConfig().budgets.heavy.tokens_cap, ok);
  }
});

test('the DEFAULTS config still loads as DEFAULTS, and loading it leaves DEFAULTS as it was (#21)', async (t) => {
  const { c } = await fresh(t, 'defaults-validated');
  const before = structuredClone(c.DEFAULTS);
  assert.deepEqual(c.loadConfig(), c.DEFAULTS);
  assert.deepEqual(c.DEFAULTS, before);
  assert.ok(Object.isFrozen(c.DEFAULTS.budgets.standard));
});
