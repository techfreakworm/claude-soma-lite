import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';

/** Fresh temp dir, removed when the test ends. */
const scratch = (t, prefix = 'home-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** Save/restore `$CLAUDE_CONFIG_DIR` — it is often set on a machine that runs these tests. */
const holdConfigDir = (t) => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  });
};

const load = async (tag) => import('../bin/lib/tokens.mjs?' + tag + '-' + Date.now());

/** One assistant row, compact like Claude Code writes them. */
const asst = (model, usage) => JSON.stringify({ message: { role: 'assistant', model, usage } });

/** Write `lines` as `<root>/projects/<proj>/<uuid>.jsonl`, creating dirs. */
const seed = (root, proj, uuid, lines) => {
  const dir = join(root, 'projects', proj);
  mkdirSync(dir, { recursive: true });
  const fp = join(dir, `${uuid}.jsonl`);
  writeFileSync(fp, lines);
  return fp;
};

/**
 * Pin a file's mtime to a fixed epoch second.
 *
 * `readDirUsage` sorts by mtime, so any test of *which* transcript wins has to own the
 * mtimes outright: three `writeFileSync` calls in the same millisecond leave the order to
 * whatever the filesystem's timestamp granularity happens to be, which is how a
 * newest-vs-oldest bug survives a green suite.
 */
const setMtime = (fp, epochSeconds) => utimesSync(fp, epochSeconds, epochSeconds);

// ---------------------------------------------------------------------------
// The two original pinned cases, verbatim in intent: `<home>/.claude/projects/...`.
// ---------------------------------------------------------------------------

test('readUsage sums message.usage and reports last model + turn count', async (t) => {
  const home = scratch(t);
  const proj = join(home, '.claude', 'projects', 'p'); mkdirSync(proj, { recursive: true });
  const lines = [
    { message: { role: 'assistant', model: 'claude-fable-5', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000 } } },
    { message: { role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 200, output_tokens: 80 } } },
  ].map((l) => JSON.stringify(l)).join('\n');
  writeFileSync(join(proj, 'uuid-1.jsonl'), lines);
  const { readUsage } = await load('brief1');
  const u = readUsage('uuid-1', home);
  assert.equal(u.turns, 2);
  assert.equal(u.last_model, 'claude-opus-5');   // deviation from fable is detectable here
  assert.equal(u.est_tokens, 100 + 50 + Math.round(1000 * 0.1) + 200 + 80);
});

test('readUsage degrades to turns on malformed json', async (t) => {
  const home = scratch(t);
  const proj = join(home, '.claude', 'projects', 'p'); mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, 'uuid-2.jsonl'), 'not json\n{"message":{"role":"assistant"}}\n');
  const { readUsage } = await load('brief2');
  const u = readUsage('uuid-2', home);
  assert.equal(u.turns, 1);
  assert.equal(u.est_tokens, 0);
  assert.equal(u.bad_lines, 1);                  // the unparseable line is *reported*, not just swallowed
});

// ---------------------------------------------------------------------------
// Root resolution. This is the whole point of the task: a machine can have
// BOTH a live `$CLAUDE_CONFIG_DIR/projects` and a stale `~/.claude/projects`.
// ---------------------------------------------------------------------------

test('readUsage reads $CLAUDE_CONFIG_DIR, not ~/.claude, when the env var is set', async (t) => {
  holdConfigDir(t);
  const live = scratch(t, 'live-cfg-');
  seed(live, '-tmp-lead', 'uuid-3', asst('claude-fable-5', { input_tokens: 7, output_tokens: 3 }));
  process.env.CLAUDE_CONFIG_DIR = live;
  const { readUsage } = await load('env');
  const u = readUsage('uuid-3');
  assert.equal(u.turns, 1);
  assert.equal(u.est_tokens, 10);
  assert.equal(u.transcript, join(live, 'projects', '-tmp-lead', 'uuid-3.jsonl'));
});

test('a stale ~/.claude/projects never shadows the live $CLAUDE_CONFIG_DIR', async (t) => {
  // The shape this guards against: the SAME session uuid exists in both
  // roots with different numbers. Reading the stale copy is the silent-zero defect.
  holdConfigDir(t);
  const home = scratch(t, 'staletrap-');
  const stale = join(home, '.claude');
  seed(stale, 'p', 'uuid-4', asst('claude-opus-5', { input_tokens: 999999, output_tokens: 999999 }));
  const live = join(home, '.claude-live');
  seed(live, 'p', 'uuid-4', asst('claude-fable-5', { input_tokens: 11, output_tokens: 22 }));

  process.env.CLAUDE_CONFIG_DIR = live;
  const { readUsage } = await load('stale');
  const u = readUsage('uuid-4');
  assert.equal(u.est_tokens, 33, 'read the stale ~/.claude copy instead of the live root');
  assert.equal(u.last_model, 'claude-fable-5');
});

test('precedence: explicit home > $CLAUDE_CONFIG_DIR > homedir()', async (t) => {
  holdConfigDir(t);
  const envRoot = scratch(t, 'envroot-');
  seed(envRoot, 'p', 'uuid-5', asst('claude-opus-5', { input_tokens: 500, output_tokens: 0 }));
  const home = scratch(t, 'arghome-');
  seed(join(home, '.claude'), 'p', 'uuid-5', asst('claude-fable-5', { input_tokens: 1, output_tokens: 2 }));

  process.env.CLAUDE_CONFIG_DIR = envRoot;
  const { readUsage } = await load('prec');

  assert.equal(readUsage('uuid-5', home).est_tokens, 3, 'explicit home must win over the env var');
  assert.equal(readUsage('uuid-5').est_tokens, 500, 'env var must win when no home is passed');

  delete process.env.CLAUDE_CONFIG_DIR;
  // With neither, the root is the real `~/.claude` — assert only that it is where we look,
  // never that a file is there. A unit test must not depend on the operator's transcripts.
  const { transcriptRoot } = await load('prec2');
  assert.equal(transcriptRoot(), join(homedir(), '.claude', 'projects'));
});

test('configRoot names the config root directly; home names the HOME above it', async (t) => {
  holdConfigDir(t);
  process.env.CLAUDE_CONFIG_DIR = '/env/should/lose';
  const { transcriptRoot } = await load('shape');
  // `home` is a HOME whose `.claude` we use — the original tests pass one of these.
  assert.equal(transcriptRoot({ home: '/h' }), join('/h', '.claude', 'projects'));
  // `configRoot` is the config root itself — no `.claude` is appended.
  assert.equal(transcriptRoot({ configRoot: '/c' }), join('/c', 'projects'));
  // Most specific wins.
  assert.equal(transcriptRoot({ home: '/h', configRoot: '/c' }), join('/c', 'projects'));
  // Both are absolutised, like SOMA_HOME(): the watchdog's cwd is not the lead's.
  assert.ok(isAbsolute(transcriptRoot({ home: 'rel-home' })));
  assert.equal(transcriptRoot({ configRoot: 'rel-cfg' }), join(resolve('rel-cfg'), 'projects'));
});

test('readUsage takes configRoot through its third argument', async (t) => {
  holdConfigDir(t);
  process.env.CLAUDE_CONFIG_DIR = '/env/should/lose';
  const cfg = scratch(t, 'cfgroot-');
  seed(cfg, 'p', 'uuid-6', asst('claude-fable-5', { input_tokens: 4, output_tokens: 5 }));
  const { readUsage } = await load('cfgarg');
  assert.equal(readUsage('uuid-6', null, { configRoot: cfg }).est_tokens, 9);
});

test('readUsage honours an injected env instead of process.env', async (t) => {
  holdConfigDir(t);
  process.env.CLAUDE_CONFIG_DIR = '/env/should/lose';
  const cfg = scratch(t, 'injenv-');
  seed(cfg, 'p', 'uuid-7', asst('claude-fable-5', { input_tokens: 6, output_tokens: 6 }));
  const { readUsage } = await load('injenv');
  assert.equal(readUsage('uuid-7', null, { env: { CLAUDE_CONFIG_DIR: cfg } }).est_tokens, 12);
});

// ---------------------------------------------------------------------------
// Degrade, never throw. Every one of these is a live watchdog tick.
// ---------------------------------------------------------------------------

test('a missing transcript, missing root and missing uuid all yield a usable zero', async (t) => {
  holdConfigDir(t);
  const root = scratch(t, 'missing-');
  process.env.CLAUDE_CONFIG_DIR = join(root, 'never-created');
  const { readUsage } = await load('missing');

  for (const call of [() => readUsage('nope'), () => readUsage(''), () => readUsage(null), () => readUsage(undefined)]) {
    const u = call();
    assert.equal(u.est_tokens, 0);
    assert.equal(u.turns, 0);
    assert.equal(u.last_model, null);
    assert.equal(u.transcript, null);
    assert.deepEqual(u.models, []);
  }
});

test('a non-string home, configRoot or env degrades instead of throwing', async (t) => {
  // The header promises "nothing here throws" without qualification, and modelDeviation
  // is hardened against junk while readUsage — the one on the 30 s hot path — was not.
  // If a caller reads a home out of a meta file and a serialisation bug puts a number or
  // null there, resolve() throws a TypeError, the tick dies, and metering stops for ALL TEN
  // LEADS at once. There is no partial failure here: one bad field silences the fleet.
  holdConfigDir(t);
  const root = scratch(t, 'junkargs-');
  seed(root, 'p', 'uuid-29', asst('claude-fable-5', { input_tokens: 1, output_tokens: 1 }));
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readUsage, transcriptRoot } = await load('junkargs');

  for (const home of [42, {}, [], true, () => {}, Symbol('s')]) {
    assert.doesNotThrow(() => readUsage('uuid-29', home), `home=${String(home)}`);
  }
  for (const configRoot of [42, {}, [], true]) {
    assert.doesNotThrow(() => readUsage('uuid-29', null, { configRoot }), `configRoot=${String(configRoot)}`);
  }
  for (const env of [null, 42, 'nope']) {
    assert.doesNotThrow(() => readUsage('uuid-29', null, { env }), `env=${String(env)}`);
  }
  assert.doesNotThrow(() => readUsage('uuid-29', null, null), 'opts=null');
  assert.doesNotThrow(() => transcriptRoot(null), 'transcriptRoot(null)');
  assert.doesNotThrow(() => transcriptRoot(42), 'transcriptRoot(42)');

  // A junk home must be *ignored*, not silently treated as a root — so the env still wins
  // and the reading is the real one rather than a zero.
  assert.equal(readUsage('uuid-29', 42).est_tokens, 2, 'a junk home must fall through to the env');
  assert.equal(readUsage('uuid-29', null, { configRoot: {} }).est_tokens, 2);
  assert.equal(readUsage('uuid-29', null, { env: null }).est_tokens, 2, 'a junk env must fall back to process.env');
});

test('a uuid carrying path separators cannot escape the projects root', async (t) => {
  holdConfigDir(t);
  const root = scratch(t, 'escape-');
  seed(root, 'p', 'uuid-8', asst('claude-fable-5', { input_tokens: 1, output_tokens: 1 }));
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readUsage } = await load('escape');
  for (const bad of ['../p/uuid-8', 'p/uuid-8', '..', '.', 'a\\b']) {
    const u = readUsage(bad);
    assert.equal(u.transcript, null, `${bad} resolved to a transcript`);
    assert.equal(u.est_tokens, 0);
  }
});

test('a truncated final line — the file is appended to while we read it — is skipped, not fatal', async (t) => {
  holdConfigDir(t);
  const root = scratch(t, 'trunc-');
  const whole = [
    asst('claude-fable-5', { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100 }),
    asst('claude-fable-5', { input_tokens: 30, output_tokens: 40 }),
  ].join('\n');
  const partial = '\n{"message":{"role":"assistant","model":"claude-fable-5","usage":{"input_to';
  seed(root, 'p', 'uuid-9', whole + partial);
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readUsage } = await load('trunc');
  const u = readUsage('uuid-9');
  assert.equal(u.turns, 2, 'the two complete turns must still be counted');
  assert.equal(u.est_tokens, 10 + 20 + Math.round(100 * 0.1) + 30 + 40);
  assert.equal(u.bad_lines, 1);
  assert.equal(u.last_model, 'claude-fable-5');
});

test('a directory where the transcript file should be yields zero, not a throw', async (t) => {
  holdConfigDir(t);
  const root = scratch(t, 'isdir-');
  mkdirSync(join(root, 'projects', 'p', 'uuid-10.jsonl'), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readUsage } = await load('isdir');
  const u = readUsage('uuid-10');
  assert.equal(u.est_tokens, 0);
  assert.equal(u.transcript, null, 'a directory is not a transcript');
});

test('a file where the projects root should be yields zero, not a throw', async (t) => {
  holdConfigDir(t);
  const root = scratch(t, 'rootfile-');
  writeFileSync(join(root, 'projects'), 'not a directory');
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readUsage } = await load('rootfile');
  assert.equal(readUsage('uuid-11').est_tokens, 0);
});

test('an unreadable transcript yields zero, not a throw', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores mode bits');
  holdConfigDir(t);
  const root = scratch(t, 'noperm-');
  const fp = seed(root, 'p', 'uuid-12', asst('claude-fable-5', { input_tokens: 5, output_tokens: 5 }));
  chmodSync(fp, 0o000);
  t.after(() => { try { chmodSync(fp, 0o600); } catch { /* already gone */ } });
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readUsage } = await load('noperm');
  const u = readUsage('uuid-12');
  assert.equal(u.est_tokens, 0);
  assert.equal(u.turns, 0);
});

test('an empty transcript and a whitespace-only transcript both yield zero', async (t) => {
  holdConfigDir(t);
  const root = scratch(t, 'empty-');
  seed(root, 'p', 'uuid-13', '');
  seed(root, 'p', 'uuid-14', '\n\n   \n\n');
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readUsage } = await load('empty');
  for (const id of ['uuid-13', 'uuid-14']) {
    const u = readUsage(id);
    assert.equal(u.est_tokens, 0, id);
    assert.equal(u.turns, 0, id);
    assert.equal(u.bad_lines, 0, `${id}: blank lines are not corruption`);
  }
});

test('non-numeric usage values are ignored rather than concatenated into est_tokens', async (t) => {
  holdConfigDir(t);
  const root = scratch(t, 'nonnum-');
  seed(root, 'p', 'uuid-15', [
    asst('claude-fable-5', { input_tokens: '100', output_tokens: 50 }),
    asst('claude-fable-5', { input_tokens: null, output_tokens: 7, cache_read_input_tokens: [1] }),
  ].join('\n'));
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readUsage } = await load('nonnum');
  const u = readUsage('uuid-15');
  assert.equal(u.est_tokens, 57);
  assert.equal(typeof u.est_tokens, 'number');
});

// ---------------------------------------------------------------------------
// Findings from real transcripts.
// ---------------------------------------------------------------------------

test('cache_creation_input_tokens counts at weight 1.0 in est_tokens, and is also reported raw', async (t) => {
  // Lead ruling: across real transcripts, cache-creation tokens come to about half of
  // what the rest of the formula counts — present on every assistant row and billed
  // above base input. Leaving them out let a `standard` lead run ~2x its 1.5M cap.
  holdConfigDir(t);
  const root = scratch(t, 'cachecreate-');
  seed(root, 'p', 'uuid-16', asst('claude-fable-5', {
    input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: 40000,
    cache_creation: { ephemeral_5m_input_tokens: 12000, ephemeral_1h_input_tokens: 28000 },
    server_tool_use: { web_search_requests: 0 }, service_tier: null, speed: null,
  }));
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readUsage } = await load('cachecreate');
  const u = readUsage('uuid-16');
  assert.equal(u.est_tokens, 2 + 3 + Math.round(1000 * 0.1) + 40000);
  assert.deepEqual(u.raw, {
    input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: 40000,
  });
});

test('the nested cache_creation breakdown is NOT added on top of its parent field', async (t) => {
  // `cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens` sum to
  // `cache_creation_input_tokens` (to within a small fraction of a percent across real
  // transcripts). Counting both would double the largest term in the formula.
  holdConfigDir(t);
  const root = scratch(t, 'nodouble-');
  seed(root, 'p', 'uuid-24', asst('claude-fable-5', {
    input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 500,
    cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 300 },
  }));
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readUsage } = await load('nodouble');
  assert.equal(readUsage('uuid-24').est_tokens, 500, 'the 5m/1h split is a breakdown, not extra volume');
});

// ---------------------------------------------------------------------------
// The field-set guard. Missing `cache_creation_input_tokens` cost this fleet a
// 2x budget error that no test could have caught. These are that test.
// ---------------------------------------------------------------------------

test('every known usage field is classified as either counted or deliberately ignored', async () => {
  const { USAGE_FIELDS, KNOWN_USAGE_FIELDS } = await load('fields');
  // Hoisted to consts because KNOWN_USAGE_FIELDS is asserted against them below. Comparing
  // that set to `[...counted, ...ignored]` — the very lists the module built it from — can
  // only restate the module's own arithmetic; comparing it to the literal is an independent
  // statement, and a set built from one half of the classification fails it.
  const EXPECTED_COUNTED = [
    'cache_creation_input_tokens', 'cache_read_input_tokens', 'input_tokens', 'output_tokens',
  ];
  const EXPECTED_IGNORED = [
    // `output_tokens_details` was added by a later Claude Code version and caught by the
    // field-set guard below, not by anyone reading a changelog. It is `{thinking_tokens: N}`,
    // a breakdown OF `output_tokens`: measured over real assistant rows it NEVER
    // exceeds output_tokens, and in aggregate it is close to half of all output volume — so counting
    // it would inflate the output term by nearly half and invalidate every calibrated cap.
    // `fallback_credit` arrived the same way, and is `null` on every real row that carries it.
    'cache_creation', 'fallback_credit', 'inference_geo', 'iterations', 'output_tokens_details',
    'server_tool_use', 'service_tier', 'speed',
  ];
  const counted = Object.keys(USAGE_FIELDS.counted);
  const ignored = Object.keys(USAGE_FIELDS.ignored);

  assert.deepEqual(counted.sort(), EXPECTED_COUNTED,
    'the counted set is the four token-bearing fields observed in the real corpus');
  assert.deepEqual(ignored.sort(), EXPECTED_IGNORED,
    'and every other observed field is ignored *on purpose*');

  for (const [k, w] of Object.entries(USAGE_FIELDS.counted)) {
    assert.equal(typeof w, 'number', `${k} needs a numeric weight`);
    assert.ok(w > 0, `${k} weight must be positive`);
  }
  for (const [k, why] of Object.entries(USAGE_FIELDS.ignored)) {
    assert.equal(typeof why, 'string', `${k} needs a written reason`);
    assert.ok(why.length > 20, `${k}: "${why}" is not a reason anyone can act on`);
  }
  for (const k of counted) assert.ok(!ignored.includes(k), `${k} is both counted and ignored`);
  // KNOWN_USAGE_FIELDS is what the hot path actually consults, so it is asserted against the
  // literal rather than against the two lists the module derived it from. Built from `counted`
  // alone, every ignored field would surface in `unknown_usage_fields` on every real row.
  assert.deepEqual([...KNOWN_USAGE_FIELDS].sort(), [...EXPECTED_COUNTED, ...EXPECTED_IGNORED].sort());
  assert.equal(KNOWN_USAGE_FIELDS.size, EXPECTED_COUNTED.length + EXPECTED_IGNORED.length);

  // Two facts about these two exports that nothing asserted, and the second is why the swap
  // above is not on its own worth much: given the two literal comparisons at the top of this
  // test, `[...KNOWN_USAGE_FIELDS]` against the literal and against `[...counted, ...ignored]`
  // are logically the SAME assertion. These are the ones with independent teeth.
  //
  // 1. USAGE_FIELDS is frozen all the way down. It is the `tokens_cap` calibration by the module's
  //    own header, and it is a mutable exported object on the watchdog's hot path: one
  //    `USAGE_FIELDS.counted.cache_read_input_tokens = 1` anywhere in the process retunes every
  //    budget class for every lead, with nothing in soma.json and nothing in a diff to show it.
  //    Removing either inner Object.freeze leaves the rest of this suite green.
  assert.throws(() => { USAGE_FIELDS.counted.cache_read_input_tokens = 1; }, TypeError,
    'a weight is the calibration — it must not be reassignable at runtime');
  assert.throws(() => { USAGE_FIELDS.ignored.speed = 'now counted'; }, TypeError,
    'an ignore reason must not be rewritable at runtime either');
  assert.throws(() => { USAGE_FIELDS.counted.brand_new_tokens = 1; }, TypeError,
    'and a weight must not be ADDABLE either, or the guard below never sees the field');
  assert.throws(() => { delete USAGE_FIELDS.ignored.iterations; }, TypeError,
    'nor a classification deletable — an unclassified key must surface, not vanish');
  assert.equal(USAGE_FIELDS.counted.cache_read_input_tokens, 0.1, 'and none of that took effect');

  // 2. KNOWN_USAGE_FIELDS cannot be added to. `Object.freeze` on a Set freezes its PROPERTIES,
  //    not its contents — `frozenSet.add(x)` succeeds — so the flat set the hot path consults
  //    was silently mutable. One `.add('reasoning_tokens')` disarms `unknown_usage_fields` for
  //    that field permanently, and the whole point of that list is to be the thing that notices
  //    a new token-bearing field before it becomes another 2x budget error.
  assert.throws(() => KNOWN_USAGE_FIELDS.add('reasoning_tokens'), /immutable/,
    'the hot-path guard set must not be extendable from outside');
  assert.throws(() => KNOWN_USAGE_FIELDS.delete('input_tokens'), /immutable/,
    'nor shrinkable — deleting a counted key makes it report as unknown on every real row');
  assert.throws(() => KNOWN_USAGE_FIELDS.clear(), /immutable/,
    'nor clearable, which would report every usage key on every row as unclassified');
  assert.equal(KNOWN_USAGE_FIELDS.size, EXPECTED_COUNTED.length + EXPECTED_IGNORED.length,
    'and none of those took effect either');

  // The weights are the calibration. Changing one without moving the `tokens_cap` values is the bug.
  assert.equal(USAGE_FIELDS.counted.input_tokens, 1);
  assert.equal(USAGE_FIELDS.counted.output_tokens, 1);
  assert.equal(USAGE_FIELDS.counted.cache_read_input_tokens, 0.1);
  assert.equal(USAGE_FIELDS.counted.cache_creation_input_tokens, 1);
});

test('a usage field nobody has classified is reported, not silently dropped', async (t) => {
  holdConfigDir(t);
  const root = scratch(t, 'newfield-');
  seed(root, 'p', 'uuid-25', [
    asst('claude-fable-5', { input_tokens: 1, output_tokens: 1, reasoning_tokens: 999999 }),
    asst('claude-fable-5', { input_tokens: 1, output_tokens: 1, some_future_tokens: 5 }),
    asst('claude-fable-5', { input_tokens: 1, output_tokens: 1 }),
  ].join('\n'));
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readUsage } = await load('newfield');
  const u = readUsage('uuid-25');
  assert.deepEqual(u.unknown_usage_fields, ['reasoning_tokens', 'some_future_tokens']);
  assert.equal(u.est_tokens, 6, 'an unclassified field is reported but never guessed at');
});

test('a fully-known usage row reports no unknown fields', async (t) => {
  holdConfigDir(t);
  const root = scratch(t, 'allknown-');
  const { USAGE_FIELDS } = await load('allknown-fields');
  const usage = {};
  for (const k of Object.keys(USAGE_FIELDS.counted)) usage[k] = 0;
  usage.cache_creation = { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 };
  usage.server_tool_use = { web_search_requests: 0, web_fetch_requests: 0 };
  usage.service_tier = null; usage.inference_geo = null; usage.iterations = null; usage.speed = null;
  usage.fallback_credit = null;
  seed(root, 'p', 'uuid-26', asst('claude-fable-5', usage));
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readUsage } = await load('allknown');
  assert.deepEqual(readUsage('uuid-26').unknown_usage_fields, []);
});

test('the operator\'s live transcripts carry no usage field this module does not know', async (t) => {
  // The guard that actually fires when a future Claude Code adds a field: it reads the
  // REAL transcripts, not a fixture. Skips where there are none, so CI stays honest.
  const { readUsage, transcriptRoot } = await load('livefields');
  const root = transcriptRoot();
  let projects;
  try { projects = readdirSync(root); } catch { return t.skip(`no transcript root at ${root}`); }

  const files = [];
  for (const proj of projects) {
    let names;
    try { names = readdirSync(join(root, proj)); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      try {
        const s = statSync(join(root, proj, n));
        if (s.isFile() && s.size > 2000) files.push({ uuid: n.slice(0, -6), mtime: s.mtimeMs });
      } catch { /* vanished */ }
    }
  }
  if (files.length === 0) return t.skip(`no transcripts under ${root}`);

  // The 8 most recent: a new field arrives with a new version, so recency is the signal.
  files.sort((a, b) => b.mtime - a.mtime);
  const checked = files.slice(0, 8);
  const surprises = new Map();
  let read = 0, turns = 0;
  for (const { uuid } of checked) {
    const u = readUsage(uuid);
    if (u.transcript !== null) read += 1;
    turns += u.turns;
    for (const f of u.unknown_usage_fields) surprises.set(f, (surprises.get(f) ?? 0) + 1);
  }
  assert.deepEqual([...surprises.keys()], [],
    `Claude Code now emits message.usage fields this module does not classify: ${[...surprises.keys()].join(', ')}. `
    + 'Add each to USAGE_FIELDS.counted (with a weight, and move the tokens_cap values with it) or '
    + 'USAGE_FIELDS.ignored (with a written reason).');
  // The assertion this replaces was `assert.ok(checked.length > 0)`, which the `t.skip` eleven
  // lines up already guarantees — it could not fail. These two can, and they are the ways this
  // guard goes green by vacuum rather than by finding nothing: `readUsage` failing to locate
  // files we just listed under its own `transcriptRoot()` (the root-resolution defect this
  // whole module exists for, which would make the loop above examine nothing), and a set of
  // transcripts holding no assistant rows at all, which classifies no fields either.
  assert.equal(read, checked.length,
    `readUsage found only ${read} of the ${checked.length} transcripts listed under ${root} — `
    + 'the field guard examined less than it reported, so its silence means nothing');
  assert.ok(turns > 0,
    `the ${checked.length} newest transcripts under ${root} carry no assistant rows between them, `
    + 'so no usage field was inspected and this guard passed without reading anything');
});

// ---------------------------------------------------------------------------
// Model deviation. Determined here, so no caller re-derives the matching rule.
// ---------------------------------------------------------------------------

test('modelDeviation matches a pinned alias against the resolved id', async () => {
  const { modelDeviation } = await load('dev1');
  // `--model fable` resolves to `claude-fable-5`: the pin is an *infix*, so a plain
  // startsWith() check reports every correctly-pinned lead as deviating.
  const ok = modelDeviation({ last_model: 'claude-fable-5', models: ['claude-fable-5'] }, 'fable');
  assert.equal(ok.deviated, false);
  assert.deepEqual(ok.unexpected, []);
  assert.equal(ok.pinned, 'fable');
  assert.equal(ok.last_model, 'claude-fable-5');
});

test('modelDeviation matches a versioned suffix on a fully-qualified pin', async () => {
  const { modelDeviation } = await load('dev2');
  // `claude-haiku-4-5-20251001` is a real observed id — a dated suffix must not read as drift.
  const d = modelDeviation({ last_model: 'claude-haiku-4-5-20251001', models: ['claude-haiku-4-5-20251001'] }, 'claude-haiku-4-5');
  assert.equal(d.deviated, false);
  assert.equal(modelDeviation({ last_model: 'claude-fable-5', models: ['claude-fable-5'] }, 'claude-fable').deviated, false);
});

test('modelDeviation flags a real fallback', async () => {
  const { modelDeviation } = await load('dev3');
  const d = modelDeviation({ last_model: 'claude-opus-5', models: ['claude-opus-5'] }, 'fable');
  assert.equal(d.deviated, true);
  assert.deepEqual(d.unexpected, ['claude-opus-5']);
});

test('modelDeviation sees a fallback that already reverted', async () => {
  const { modelDeviation } = await load('dev4');
  // One session can hold claude-opus-4-8, claude-fable-5 and claude-opus-5. last_model
  // alone says "clean"; the fleet defect is still real and still worth seeing.
  const d = modelDeviation(
    { last_model: 'claude-fable-5', models: ['claude-fable-5', 'claude-opus-4-8', 'claude-opus-5'] }, 'fable');
  assert.equal(d.deviated, false, 'it is not deviating *now*');
  assert.deepEqual(d.unexpected, ['claude-opus-4-8', 'claude-opus-5'], 'but it did');
});

test("modelDeviation reports '<synthetic>' as an auth/API fault, never as deviation", async () => {
  const { modelDeviation } = await load('dev5');
  const d = modelDeviation({ last_model: 'claude-fable-5', models: ['<synthetic>', 'claude-fable-5'] }, 'fable');
  assert.equal(d.synthetic, true, 'the caller needs to know, and needs a different fix');
  assert.equal(d.deviated, false);
  assert.deepEqual(d.unexpected, []);

  // A lead that never got past login has ONLY a synthetic row.
  const only = modelDeviation({ last_model: null, models: ['<synthetic>'] }, 'fable');
  assert.equal(only.synthetic, true);
  assert.equal(only.deviated, false, "'<synthetic>' is not a model that can deviate");
});

test('modelDeviation does not match a substring that straddles segments', async () => {
  const { modelDeviation } = await load('dev6');
  // 'us' is inside 'claude-opus-5'. A plain includes() would call that a match.
  assert.equal(modelDeviation({ last_model: 'claude-opus-5', models: ['claude-opus-5'] }, 'us').deviated, true);
  assert.equal(modelDeviation({ last_model: 'claude-opus-5', models: ['claude-opus-5'] }, 'pus').deviated, true);
});

test('modelDeviation requires the pin segments to be CONTIGUOUS, not merely present in order', async () => {
  // The rule is *contiguous* segment containment, and nothing in this file pinned the
  // contiguity: swapping the containment loop for a non-contiguous subsequence match survives
  // the whole suite green, because every other pin here is either a SINGLE segment that must
  // fail ('us', 'pus') or a multi-segment run that must match ('claude-haiku-4-5').
  //
  // Under that mutant a lead pinned `fable-5` and actually running `claude-fable-4-5` reports
  // CLEAN — the silent false negative across the whole fleet that this function exists to
  // prevent, and the same class of failure that made a plain prefix rule wrong.
  const { modelDeviation } = await load('dev-contig');
  const d = modelDeviation({ last_model: 'claude-fable-4-5', models: ['claude-fable-4-5'] }, 'fable-5');
  assert.equal(d.deviated, true,
    "'fable-5' is not a contiguous run inside ['claude','fable','4','5'] — a subsequence is not a match");
  assert.deepEqual(d.unexpected, ['claude-fable-4-5']);
  // The same pin against the genuinely contiguous id still matches, so this is not simply
  // "be stricter" — it is the difference between containment and subsequence.
  assert.equal(modelDeviation({ last_model: 'claude-fable-5', models: ['claude-fable-5'] }, 'fable-5').deviated,
    false, "'fable-5' IS a contiguous run inside ['claude','fable','5']");
  // Order is part of contiguity: the same two segments reversed is not a match.
  assert.equal(modelDeviation({ last_model: 'claude-fable-5', models: ['claude-fable-5'] }, '5-fable').deviated, true);
});

test('modelDeviation matches case-insensitively', async () => {
  const { modelDeviation } = await load('dev-case');
  // Dropping toLowerCase() fails no other test in this file, and the failure it causes is
  // ALL TEN LEADS reporting deviated:true at once on a green suite — the same
  // false-alarm-on-the-whole-fleet mode that made a plain prefix rule wrong.
  const d1 = modelDeviation({ last_model: 'claude-fable-5', models: ['claude-fable-5'] }, 'FABLE');
  assert.equal(d1.deviated, false, 'an upper-case pin must still match a lower-case id');
  assert.deepEqual(d1.unexpected, []);
  const d2 = modelDeviation({ last_model: 'CLAUDE-FABLE-5', models: ['CLAUDE-FABLE-5'] }, 'fable');
  assert.equal(d2.deviated, false, 'a lower-case pin must still match an upper-case id');
  assert.deepEqual(d2.unexpected, []);
  // And case-folding must not turn a real deviation into a match.
  assert.equal(modelDeviation({ last_model: 'CLAUDE-OPUS-5', models: ['CLAUDE-OPUS-5'] }, 'fable').deviated, true);
});

test('modelDeviation degrades on no pin, no turns and junk input', async () => {
  const { modelDeviation, readUsage } = await load('dev7');
  for (const args of [
    [{ last_model: 'claude-opus-5', models: ['claude-opus-5'] }, null],
    [{ last_model: 'claude-opus-5', models: ['claude-opus-5'] }, ''],
    [{ last_model: 'claude-opus-5', models: ['claude-opus-5'] }, '   '],
  ]) {
    const d = modelDeviation(...args);
    assert.equal(d.deviated, false, 'nothing pinned ⇒ nothing to deviate from');
    assert.deepEqual(d.unexpected, []);
    assert.equal(d.pinned, null);
  }
  // A lead with no turns yet is not deviating.
  const fresh = modelDeviation(readUsage('does-not-exist'), 'fable');
  assert.equal(fresh.deviated, false);
  assert.equal(fresh.synthetic, false);
  // And nothing here may throw on a watchdog tick.
  for (const junk of [null, undefined, {}, 42, 'nope', { models: 'not-an-array' }, { models: [1, 2] }]) {
    assert.doesNotThrow(() => modelDeviation(junk, 'fable'), `threw on ${JSON.stringify(junk)}`);
  }
});

test('modelDeviation composes with readUsage on a real reading', async (t) => {
  holdConfigDir(t);
  const root = scratch(t, 'compose-');
  seed(root, 'p', 'uuid-27', [
    asst('claude-fable-5', { input_tokens: 1, output_tokens: 1 }),
    asst('claude-opus-5', { input_tokens: 1, output_tokens: 1 }),
  ].join('\n'));
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readUsage, modelDeviation } = await load('compose');
  const d = modelDeviation(readUsage('uuid-27'), 'fable');
  assert.equal(d.deviated, true);
  assert.deepEqual(d.unexpected, ['claude-opus-5']);
});

test("last_model skips '<synthetic>' so an API error is not read as model deviation", async (t) => {
  // Observed live: a lead that cannot authenticate writes an assistant row with
  // model '<synthetic>' and all-zero usage. Reporting that as last_model would
  // raise a false deviation alarm against `--model fable`.
  holdConfigDir(t);
  const root = scratch(t, 'synthetic-');
  seed(root, 'p', 'uuid-17', [
    asst('claude-fable-5', { input_tokens: 1, output_tokens: 1 }),
    asst('<synthetic>', { input_tokens: 0, output_tokens: 0 }),
  ].join('\n'));
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readUsage } = await load('synthetic');
  const u = readUsage('uuid-17');
  assert.equal(u.last_model, 'claude-fable-5');
  assert.equal(u.turns, 2, 'the synthetic row is still a turn against turn_cap');
  assert.deepEqual(u.models, ['<synthetic>', 'claude-fable-5'], 'but it stays visible in models');
});

test('models reports every distinct model, so a reverted fallback is still visible', async (t) => {
  // A single session can hold claude-opus-4-8, claude-fable-5 and claude-opus-5.
  holdConfigDir(t);
  const root = scratch(t, 'models-');
  seed(root, 'p', 'uuid-18', [
    asst('claude-fable-5', { output_tokens: 1 }),
    asst('claude-opus-5', { output_tokens: 1 }),
    asst('claude-fable-5', { output_tokens: 1 }),
  ].join('\n'));
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readUsage } = await load('models');
  const u = readUsage('uuid-18');
  assert.equal(u.last_model, 'claude-fable-5', 'the fallback already reverted');
  assert.deepEqual(u.models, ['claude-fable-5', 'claude-opus-5'], 'it must still be detectable');
});

test('only assistant rows count; user rows and non-message rows are ignored', async (t) => {
  holdConfigDir(t);
  const root = scratch(t, 'rows-');
  seed(root, 'p', 'uuid-19', [
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
    JSON.stringify({ message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'file-history-snapshot', snapshot: { a: 1 } }),
    asst('claude-fable-5', { input_tokens: 9, output_tokens: 1 }),
    JSON.stringify({ message: null }),
    JSON.stringify({ message: 'a string, not an object' }),
    JSON.stringify([1, 2, 3]),
    JSON.stringify('a bare json string'),
  ].join('\n'));
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readUsage } = await load('rows');
  const u = readUsage('uuid-19');
  assert.equal(u.turns, 1);
  assert.equal(u.est_tokens, 10);
  assert.equal(u.bad_lines, 0, 'valid JSON that is not an assistant row is not corruption');
});

// ---------------------------------------------------------------------------
// The chunked reader itself. A 26 MB transcript is read in 256 KB slices, so
// lines and multi-byte characters straddle chunk boundaries by construction.
// ---------------------------------------------------------------------------

test('lines and multi-byte characters straddling chunk boundaries are read intact', async (t) => {
  holdConfigDir(t);
  const root = scratch(t, 'chunk-');
  // The multi-byte characters live in the MODEL id, which is *asserted* below. Putting them
  // only in an unread `note` field made this test unable to fail: per-chunk decoding would
  // mangle the bytes, every number would still add up, and the mojibake would surface as a
  // model id that matches no pin — a false deviation alarm on a green suite.
  const MODEL = 'claude-fable-5-例例🜂-ünïcøde';
  const rows = [];
  for (let i = 0; i < 200; i++) {
    rows.push(JSON.stringify({
      note: '例'.repeat(5) + '🜂 straddle ' + i,
      message: { role: 'assistant', model: MODEL, usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 10 } },
    }));
  }
  seed(root, 'p', 'uuid-20', rows.join('\n'));
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readUsage } = await load('chunk');
  const expected = 200 * (1 + 2 + Math.round(10 * 0.1));
  for (const chunkSize of [7, 13, 64, 4096, 262144]) {
    const u = readUsage('uuid-20', null, { chunkSize });
    assert.equal(u.turns, 200, `turns wrong at chunkSize=${chunkSize}`);
    assert.equal(u.est_tokens, expected, `est_tokens wrong at chunkSize=${chunkSize}`);
    assert.equal(u.bad_lines, 0, `bad_lines wrong at chunkSize=${chunkSize}`);
    assert.deepEqual(u.models, [MODEL], `model id corrupted at chunkSize=${chunkSize}`);
    assert.equal(u.last_model, MODEL, `last_model corrupted at chunkSize=${chunkSize}`);
  }
});

test('EVERY chunk boundary inside a multi-byte model id still decodes intact', async (t) => {
  // The test above cannot actually detect per-piece decoding, which is the bug it was written
  // for: with a fixed chunk size the split lands wherever it lands, and for these rows that is
  // always in the trailing `}}` rather than inside a character. Proven by mutation — swapping
  // the byte-assembling read for `tail.toString() + piece.toString()` leaves it green.
  //
  // So sweep EVERY chunk size from 1 to the line length. That guarantees a boundary falls
  // inside each multi-byte sequence, including between the two halves of a surrogate pair.
  holdConfigDir(t);
  const root = scratch(t, 'straddle-');
  const MODEL = 'claude-fable-5-例-🜂-ü';
  const line = asst(MODEL, { input_tokens: 1, output_tokens: 1 });
  const bytes = Buffer.byteLength(line, 'utf8');
  // PREMISE GUARD, and it is load-bearing: the sweep below only has power because MODEL
  // contains multi-byte characters. Change it to a plain-ASCII id — an entirely plausible
  // "tidy up the odd characters in this fixture" edit — and the per-piece-decoding mutation
  // is no longer caught, silently. The version of this line that read
  // `bytes > Buffer.from(line, 'utf8').length - 1` could not do that job: those two
  // expressions are THE SAME NUMBER by definition, so it reduced to `X > X - 1` and was true
  // for every input that has ever existed, ASCII included. Comparing UTF-8 bytes against
  // UTF-16 code units is the comparison that actually distinguishes the two cases:
  // 26 > 21 for this fixture, 21 > 21 (false) for an ASCII one.
  assert.ok(Buffer.byteLength(MODEL, 'utf8') > MODEL.length,
    `the MODEL fixture must contain multi-byte characters, or this sweep cannot detect `
    + `per-piece decoding: ${JSON.stringify(MODEL)} is ${Buffer.byteLength(MODEL, 'utf8')} bytes `
    + `in ${MODEL.length} code units`);
  seed(root, 'p', 'uuid-34', line + '\n');
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readUsage } = await load('straddle');
  for (let chunkSize = 1; chunkSize <= bytes + 2; chunkSize++) {
    const u = readUsage('uuid-34', null, { chunkSize });
    assert.deepEqual(u.models, [MODEL],
      `model id corrupted at chunkSize=${chunkSize}: got ${JSON.stringify(u.models)}`);
    assert.equal(u.turns, 1, `turns wrong at chunkSize=${chunkSize}`);
    assert.equal(u.est_tokens, 2, `est_tokens wrong at chunkSize=${chunkSize}`);
    assert.equal(u.bad_lines, 0, `bad_lines wrong at chunkSize=${chunkSize}`);
  }
});

test('est_tokens rounds the cache-read weight, it does not truncate it', async (t) => {
  // Every other fixture uses multiples of 10, so Math.floor passes them all. 15 * 0.1 = 1.5:
  // round gives 2, floor gives 1. The weight is the `tokens_cap` calibration; pin its arithmetic.
  holdConfigDir(t);
  const root = scratch(t, 'rounding-');
  seed(root, 'p', 'uuid-28', [
    asst('claude-fable-5', { cache_read_input_tokens: 15 }),
    asst('claude-fable-5', { cache_read_input_tokens: 5 }),   // 0.5 -> 1 rounding up at .5
    asst('claude-fable-5', { cache_read_input_tokens: 4 }),   // 0.4 -> 0
  ].join('\n'));
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readUsage } = await load('rounding');
  assert.equal(readUsage('uuid-28').est_tokens, 2 + 1 + 0);
});

test('a chunked read agrees with a whole-file read on the same bytes', async (t) => {
  holdConfigDir(t);
  const root = scratch(t, 'agree-');
  const rows = [];
  for (let i = 0; i < 500; i++) {
    rows.push(i % 7 === 0 ? 'garbage line ' + i : asst(i % 3 ? 'claude-fable-5' : 'claude-opus-5', {
      input_tokens: i, output_tokens: i * 2, cache_read_input_tokens: i * 100, cache_creation_input_tokens: i * 10,
    }));
  }
  const text = rows.join('\n') + '\n';
  seed(root, 'p', 'uuid-21', text);
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readUsage, USAGE_FIELDS } = await load('agree');

  // Independent oracle: the first sketch's whole-file loop, i.e. a second *reading strategy*.
  // It takes the weights from the module on purpose — this test exists to prove the chunked
  // reader sees the same bytes, and hard-coding the formula in two places is what let the
  // last formula change slip past it.
  let est = 0, turns = 0, last = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    const m = row.message;
    if (!m || m.role !== 'assistant') continue;
    turns += 1;
    if (m.model) last = m.model;
    const u = m.usage || {};
    for (const [f, w] of Object.entries(USAGE_FIELDS.counted)) est += Math.round((u[f] || 0) * w);
  }

  const u = readUsage('uuid-21', null, { chunkSize: 997 });
  assert.equal(u.turns, turns);
  assert.equal(u.est_tokens, est);
  assert.equal(u.last_model, last);
});

test('a single absurdly long line is dropped without exhausting memory', async (t) => {
  holdConfigDir(t);
  const root = scratch(t, 'longline-');
  seed(root, 'p', 'uuid-22', [
    asst('claude-fable-5', { input_tokens: 1, output_tokens: 1 }),
    '{"junk":"' + 'x'.repeat(200000) + '"}',
    asst('claude-fable-5', { input_tokens: 1, output_tokens: 1 }),
  ].join('\n'));
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readUsage } = await load('longline');
  const u = readUsage('uuid-22', null, { chunkSize: 512, maxLine: 4096 });
  assert.equal(u.turns, 2, 'the rows either side of the oversized line must survive');
  // `>= 1` was weak by construction and provably so: deleting the `dropping = true` resync
  // leaves it green, because without the resync the reader simply hits the maxLine ceiling
  // again on every 4 KB of the same 200 KB line. That reports the one oversized line ~49
  // times, and `bad_lines` is the field that distinguishes "one truncated tail, normal on a
  // live file" from "the format drifted and nothing parses". An EXACT count is what pins the
  // resync: the line is counted once, then the reader skips to the next newline.
  assert.equal(u.bad_lines, 1,
    'the oversized line is counted exactly once, then the reader resyncs at the next newline');
});

// ---------------------------------------------------------------------------
// Cost. The watchdog calls this once per live lead on every 30 s tick.
// ---------------------------------------------------------------------------

test('readUsage does not hold the whole transcript in memory', async (t) => {
  const root = scratch(t, 'mem-');
  const row = JSON.stringify({
    pad: 'p'.repeat(4000),
    message: { role: 'assistant', model: 'claude-fable-5', usage: { input_tokens: 1, output_tokens: 1 } },
  });
  const rows = [];
  for (let i = 0; i < 2000; i++) rows.push(row);   // ~8 MB
  seed(root, 'p', 'uuid-23', rows.join('\n'));

  // The property is that LIVE memory stays bounded WHILE the transcript is read. This used to
  // measure `heapUsed` growth across the call, which answers neither half of that. Growth counts
  // whatever garbage the collector has not got to yet, and `global.gc?.()` is a no-op without
  // `--expose-gc`, which `npm test` does not pass — so the number followed GC timing, and this
  // was seen failing at "heap grew 18.5 MB" and passing on the rerun. And memory held AFTER the
  // call proves nothing: a whole-file read's buffer is garbage by the time the call returns.
  //
  // So it is measured during the read, in a child started with `--expose-gc`. The child wraps
  // `readSync`, the module's chunk read, so that after every chunk it forces a full collection
  // and samples the live set: `heapUsed` plus `arrayBuffers`, because a Buffer's bytes live
  // outside the JS heap. The module sees `readSync` through an ESM named import, a snapshot of
  // `fs` that a later patch does not reach; `syncBuiltinESMExports()` refreshes it, so the wrap
  // holds whichever module imported `node:fs` first (without it, a module imported before the
  // patch was sampled zero times). The peak is judged against a forced-collection baseline taken
  // after a warm-up read.
  //
  // Measured on this fixture: a streamed read peaked at most 0.6 MB above the baseline in 100 runs
  // (macOS idle and with every core busy, and an ext4 Linux VM) — the 256 KB chunk buffer and a
  // partial line. Mutating the reader into `readFileSync(fp)` plus `split` peaks at 7.8 MB, the
  // whole file. The bound sits between them with room on both sides. `samples` and `turns` are
  // asserted too, so a reader that stops calling `readSync` cannot pass by being examined
  // nowhere: `readFileSync(fp, 'utf8')` reads natively and leaves this assay zero samples.
  const TOKENS = new URL('../bin/lib/tokens.mjs', import.meta.url).href;
  const src = `
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    const fs = createRequire(import.meta.url)('node:fs');
    const live = () => { const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers; };
    let sampling = false, samples = 0, peak = 0;
    const realReadSync = fs.readSync;
    fs.readSync = function (...args) {
      const n = realReadSync.apply(this, args);
      if (sampling) { gc(); samples += 1; peak = Math.max(peak, live()); }
      return n;
    };
    syncBuiltinESMExports();
    const { readUsage } = await import(${JSON.stringify(TOKENS)});
    const opts = { configRoot: ${JSON.stringify(root)} };
    readUsage('uuid-23', null, opts);              // warm, then measure the second pass
    gc();
    const baseline = live();
    sampling = true;
    const u = readUsage('uuid-23', null, opts);
    sampling = false;
    process.stdout.write(JSON.stringify({ turns: u.turns, samples, grew: peak - baseline }));
  `;
  const r = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', src], { encoding: 'utf8' });
  assert.equal(r.status, 0, `the measuring child failed: ${r.stderr}`);
  const { turns, samples, grew } = JSON.parse(r.stdout);
  assert.equal(turns, 2000, 'the measured read did not see the whole transcript');
  assert.ok(samples > 0, 'readUsage never called readSync, so nothing was measured');
  assert.ok(grew < 2 * 1024 * 1024,
    `live memory peaked ${(grew / 1048576).toFixed(1)} MB above baseline reading an 8 MB transcript`);
});

// ---------------------------------------------------------------------------
// Live context, for the resume guard. Cumulative spend and current context are
// different quantities that correlate early and then diverge without bound.
// ---------------------------------------------------------------------------

test('live_context is the last row\'s prompt: input + cache_read + cache_creation', async (t) => {
  holdConfigDir(t);
  const root = scratch(t, 'ctx-');
  seed(root, 'p', 'uuid-30', [
    asst('claude-fable-5', { input_tokens: 1, output_tokens: 900, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 }),
    asst('claude-fable-5', { input_tokens: 2, output_tokens: 900, cache_read_input_tokens: 300000, cache_creation_input_tokens: 40000 }),
  ].join('\n'));
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readUsage } = await load('ctx');
  const u = readUsage('uuid-30');
  assert.equal(u.live_context, 2 + 300000 + 40000, 'output_tokens is not part of the prompt');
  assert.equal(u.zero_tail_rows, 0);
  // est_tokens is cumulative; live_context is instantaneous. They must not be the same number.
  assert.notEqual(u.live_context, u.est_tokens);
});

test('live_context skips a trailing <synthetic> zero row and counts the skip', async (t) => {
  // THE DEFECT. planRevival runs on DEAD leads, and dying on an API or auth error is what
  // writes a '<synthetic>' all-zero row. Some real sessions end on one, and it masks
  // their live context. A lead that died at 800k would report 0, be
  // resumed, and immediately compact.
  holdConfigDir(t);
  const root = scratch(t, 'ctxsynth-');
  seed(root, 'p', 'uuid-31', [
    asst('claude-fable-5', { input_tokens: 3, cache_read_input_tokens: 100000 }),
    asst('<synthetic>', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    asst('<synthetic>', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
  ].join('\n'));
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readUsage } = await load('ctxsynth');
  const u = readUsage('uuid-31');
  assert.equal(u.live_context, 100003, 'the last row with a real prompt reading, not the last row');
  assert.equal(u.zero_tail_rows, 2, 'the skip count is itself the "died abnormally" signal');
  assert.equal(u.turns, 3, 'the synthetic rows are still turns');
});

test('live_context is 0 with no usable reading, and zero_tail_rows says why', async (t) => {
  holdConfigDir(t);
  const root = scratch(t, 'ctxzero-');
  seed(root, 'p', 'uuid-32', asst('<synthetic>', { input_tokens: 0, output_tokens: 0 }));
  seed(root, 'p', 'uuid-33', '');
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readUsage } = await load('ctxzero');
  const dead = readUsage('uuid-32');
  assert.equal(dead.live_context, 0);
  assert.equal(dead.zero_tail_rows, 1, 'never started: one zero row and nothing before it');
  const empty = readUsage('uuid-33');
  assert.equal(empty.live_context, 0);
  assert.equal(empty.zero_tail_rows, 0, 'an empty transcript has no rows to skip');
});

test('an INTERIOR run of zero rows is reset by the next real prompt, not carried to the end', async (t) => {
  // Deleting `acc.zero_tail_rows = 0` survives the whole suite green, because every other
  // fixture in this file puts its zero rows at the TAIL. An interior zero row is the SAME
  // EVENT as a tail one — an API or auth error mid-session — the only difference being that
  // the lead then RECOVERED. Without the reset a healthy live lead reports
  // `zero_tail_rows > 0`, a field documented as "died abnormally" and read by the revival
  // decision, so a lead that is working fine gets restarted from scratch instead of resumed.
  //
  // The module comment names counting-zero-rows-as-events as the thing that produced about twice
  // as many compaction events as there were. This is the assertion that stops it recurring.
  holdConfigDir(t);
  const root = scratch(t, 'ctxinterior-');
  seed(root, 'p', 'uuid-35', [
    asst('claude-fable-5', { input_tokens: 3, cache_read_input_tokens: 4997 }),
    asst('<synthetic>', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    asst('<synthetic>', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    asst('claude-fable-5', { input_tokens: 9, output_tokens: 400, cache_read_input_tokens: 8991 }),
  ].join('\n'));
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readUsage } = await load('ctxinterior');
  const u = readUsage('uuid-35');
  assert.equal(u.zero_tail_rows, 0,
    'the zero rows are in the INTERIOR — the lead errored and recovered, it did not die');
  assert.equal(u.live_context, 9000, 'and live context is the LAST real reading, not the pre-error one');
  assert.equal(u.turns, 4, 'all four rows are turns against turn_cap');
});

test('an assistant row with NO usage object at all counts as a zero-tail row', async (t) => {
  // A separate code path from the all-zero-prompt one, and nothing asserted it. A row with no
  // `usage` carries no context reading, exactly like an all-zero one — which is what a row
  // written while the process was dying looks like. Treating it as "nothing happened" would
  // report a lead that died mid-write as having finished cleanly, and `zero_tail_rows` is the
  // signal the revival decision reads to tell those two apart.
  holdConfigDir(t);
  const root = scratch(t, 'ctxnousage-');
  seed(root, 'p', 'uuid-36', [
    asst('claude-fable-5', { input_tokens: 3, cache_read_input_tokens: 100000 }),
    asst('claude-fable-5'),   // no `usage` key at all
  ].join('\n'));
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readUsage } = await load('ctxnousage');
  const u = readUsage('uuid-36');
  assert.equal(u.zero_tail_rows, 1, 'no usage object is no context reading either');
  assert.equal(u.live_context, 100003, 'so live_context stays on the last row that HAD a reading');
  assert.equal(u.turns, 2, 'and it is still a turn against turn_cap');
  assert.equal(u.est_tokens, 3 + Math.round(100000 * 0.1), 'it contributes no spend');
});

test('resumeContextLimit derives an absolute from a configured fraction', async () => {
  const { resumeContextLimit } = await load('rcl');
  // The fraction is the configured thing and the absolute is derived — an absolute is what
  // produced the units bug, and on a 200k-window model an absolute 700k never fires at all.
  assert.equal(resumeContextLimit({ resume_context_fraction: 0.7, resume_context_window: 1000000 }), 700000);
  assert.equal(resumeContextLimit({ resume_context_fraction: 0.7, resume_context_window: 200000 }), 140000);
  assert.equal(resumeContextLimit({ resume_context_fraction: 0.5, resume_context_window: 1000000 }), 500000);
  // Degrades to the shipped default rather than to 0 — a 0 limit would refuse every resume.
  assert.equal(resumeContextLimit({}), 700000);
  assert.equal(resumeContextLimit(null), 700000);
  assert.equal(resumeContextLimit({ resume_context_fraction: 'nope' }), 700000);
  assert.equal(resumeContextLimit({ resume_context_window: 0 }), 700000);
});

// ---------------------------------------------------------------------------
// The slug directory. The meter sums a lead AND its team, because teammate turns
// are written to their own transcripts (isSidechain true on none of the rows measured).
// ---------------------------------------------------------------------------

test('slugForCwd matches Claude Code: every non-alphanumeric becomes a dash, case is kept', async () => {
  const { slugForCwd } = await load('slug');
  // Derived from real (cwd, directory) pairs, every one of which it matched.
  assert.equal(slugForCwd('/Users/op/work'), '-Users-op-work');
  assert.equal(slugForCwd('/Users/op/work/.worktrees/app-PROJ-42'), '-Users-op-work--worktrees-app-PROJ-42');
  assert.equal(slugForCwd('/Users/op/work/acme-app-2.0/x'), '-Users-op-work-acme-app-2-0-x');
  // Underscore IS replaced — pinned by a real pair (`a_b` -> `a-b`). A path that does
  // not exist is used deliberately: realpath cannot resolve it, so this asserts the transform
  // alone. Symlink resolution is a separate test, because the two rules compose.
  assert.equal(slugForCwd('/nonexistent-soma-test/a_b/c_d'), '-nonexistent-soma-test-a-b-c-d');
  // Case IS preserved. Lowercasing failed most of the real pairs.
  assert.equal(slugForCwd('/Users/OP/MyRepo'), '-Users-OP-MyRepo');
  // A path that does not exist still slugifies — this runs on a watchdog tick.
  assert.equal(slugForCwd('/no/such/dir/anywhere'), '-no-such-dir-anywhere');
  // Junk degrades to null rather than throwing.
  for (const junk of [null, undefined, 42, {}, '']) assert.equal(slugForCwd(junk), null, String(junk));
});

test('slugForCwd resolves symlinks first, as Claude Code does', async (t) => {
  // Verified behaviourally: a run with cwd /tmp/soma-XXXXXX (a `mktemp -d` dir) wrote its transcript to
  // `-private-tmp-soma-XXXXXX`. macOS /tmp is a symlink to /private/tmp, so
  // slugifying the string soma built would miss every transcript.
  const { slugForCwd } = await load('sluglink');
  const real = scratch(t, 'realdir-');
  const link = join(tmpdir(), 'somalink-' + process.pid + '-' + real.split('-').pop());
  symlinkSync(real, link);
  t.after(() => { try { rmSync(link, { force: true }); } catch { /* gone */ } });
  assert.equal(slugForCwd(link), slugForCwd(real), 'a symlink must slugify to its target');
  assert.equal(slugForCwd(real), realpathSync(real).replace(/[^A-Za-z0-9]/g, '-'));
});

// ---------------------------------------------------------------------------
// Account rotation (docs/superpowers/specs/2026-09-15-account-rotation-design.md, approach B).
// A lead moves from seat A to seat B by `claude --resume` under B's CLAUDE_CONFIG_DIR, and
// B/projects is a SYMLINK to the shared tree (RUNBOOK §7 "Provisioning a seat", step 2). The
// watchdog keeps metering through its OWN root. That is only correct if a uuid resolves to the
// same file from either root — so this pins the reader, and asks for no change in tokens.mjs.
//
// SIX OF ITS TEN ASSERTIONS ARE MEASUREMENTS; the other four are labelled below, each naming
// which one carries its weight. An assertion count is a claim about how many measurements were
// taken (`cli.test.mjs`'s header), so: the six are the transcript under the watchdog root, the
// transcript under seat B's OWN spelling, the fixture row's token sum, the seat-B append seen as
// a turn from seat A, that append's token sum, and seat C finding nothing — each reddened alone,
// on its own message, under a production mutation, with the seat-C one invisible to every other
// test in this file. The four that are not: the fixture guard (no production mutation can reach
// it) and three entailed by their neighbours under this fixture. Read the coverage here as six.
// ---------------------------------------------------------------------------

test('two seats whose projects/ share one realpath read the SAME transcript from either root', async (t) => {
  holdConfigDir(t);
  const seatA = scratch(t, 'seat-a-');   // the watchdog's root: a REAL projects/ tree
  const seatB = scratch(t, 'seat-b-');   // a rotation target: projects/ -> seat A's projects/
  const seatC = scratch(t, 'seat-c-');   // the control: its OWN, separate projects/ tree
  const uuid = 'uuid-seat-1';
  const fpA = seed(seatA, '-Users-x-wt-lead', uuid, asst('claude-opus-5', { input_tokens: 10, output_tokens: 5 }) + '\n');
  try {
    symlinkSync(join(seatA, 'projects'), join(seatB, 'projects'));
  } catch (e) {
    // Third state, kept apart from pass and fail: no symlink, nothing observed.
    return t.skip(`could not create the seat symlink here (${e.code}) — the invariant was NOT observed`);
  }
  // The fixture is exactly what doctor's `seat projects is the shared tree` accepts: one realpath.
  // DOCUMENTATION, NOT A MEASUREMENT — a FIXTURE GUARD. No production mutation can reach it: it
  // reads the symlink this test just made, through `node:fs`, before `tokens.mjs` is loaded. It
  // is here so a symlink that silently pointed somewhere else fails as a fixture fault instead of
  // as a reader fault; the readings below carry the weight.
  assert.equal(realpathSync(join(seatB, 'projects')), realpathSync(join(seatA, 'projects')), 'fixture: the two projects/ must share one realpath');

  process.env.CLAUDE_CONFIG_DIR = seatA;
  const { readUsage } = await load('seats');
  const viaA = readUsage(uuid);                                // what the watchdog reads
  const viaB = readUsage(uuid, null, { configRoot: seatB });   // what a lead rotated onto B writes to

  assert.equal(viaA.transcript, fpA, 'the watchdog root did not find the transcript');
  // Reported under seat B's OWN spelling — this is the line that reddens if configRoot is ignored,
  // because falling through to the env would ALSO find the file (same tree) and hide the defect.
  assert.equal(viaB.transcript, join(seatB, 'projects', '-Users-x-wt-lead', uuid + '.jsonl'), 'seat B did not read through ITS OWN symlinked projects/');
  // DOCUMENTATION, NOT A MEASUREMENT — ENTAILED. Both paths are already pinned exactly (the two
  // assertions above) and the fixture guard pins their realpaths equal, so this equality follows
  // arithmetically: no defect can make it the first red. It states the claim in the reader's
  // terms, and would start carrying weight the day either path above stops being pinned exactly.
  assert.equal(realpathSync(viaB.transcript), realpathSync(viaA.transcript), 'the two roots resolved to different files');
  // DOCUMENTATION, NOT A MEASUREMENT — ENTAILED. One reader over one file: `readUsage` passes
  // `opts` on to `readTranscript`, which reads only `chunkSize` and `maxLine` from it and neither
  // call sets either, so the fold cannot differ between them while the two paths above hold.
  assert.deepEqual(
    { turns: viaB.turns, est_tokens: viaB.est_tokens, last_model: viaB.last_model },
    { turns: viaA.turns, est_tokens: viaA.est_tokens, last_model: viaA.last_model },
    'the two roots disagree about one file');
  assert.equal(viaA.est_tokens, 15, 'the fixture row was not metered');

  // The rotated lead appends under seat B; the watchdog, still on seat A, sees the new turn.
  appendFileSync(viaB.transcript, asst('claude-opus-5', { input_tokens: 100, output_tokens: 50 }) + '\n');
  const after = readUsage(uuid);
  assert.equal(after.turns, 2, 'a turn written through seat B was invisible from seat A');
  assert.equal(after.est_tokens, 165, 'the seat-B append was not metered from seat A');

  // Control: a seat provisioned WITHOUT the symlink (§7 step 2 skipped) reads nothing — the
  // silent-zero failure this module's header warns about, and the reason the step exists.
  mkdirSync(join(seatC, 'projects'), { recursive: true });
  const viaC = readUsage(uuid, null, { configRoot: seatC });
  assert.equal(viaC.transcript, null, 'a seat with its OWN projects/ tree must not find seat A\'s transcript');
  // DOCUMENTATION, NOT A MEASUREMENT — ENTAILED by the assertion above: a null transcript is the
  // `zeroUsage(null, uuid)` early return, whose every count is 0. The transcript assertion is the
  // one that carries this control, and it is the most valuable line in the test — the only one in
  // this file that sees a `readUsage` which falls back to the env root when the named seat is empty.
  assert.equal(viaC.est_tokens, 0, 'a seat with its OWN projects/ tree metered something');
});

test('readDirUsage sums every transcript in the lead\'s slug directory', async (t) => {
  holdConfigDir(t);
  const root = scratch(t, 'dirmeter-');
  const cwd = scratch(t, 'leadwt-');
  const { slugForCwd, readDirUsage } = await load('dirmeter');
  const slug = slugForCwd(cwd);
  seed(root, slug, 'lead', asst('claude-fable-5', { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 1000 }));
  seed(root, slug, 'mate-1', asst('claude-fable-5', { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 500 }));
  seed(root, slug, 'mate-2', asst('claude-opus-5', { input_tokens: 1, output_tokens: 2 }));
  process.env.CLAUDE_CONFIG_DIR = root;

  const d = readDirUsage(cwd);
  assert.equal(d.transcripts, 3);
  assert.equal(d.est_tokens, (100 + 200 + 100) + (10 + 20 + 500) + (1 + 2));
  assert.equal(d.turns, 3);
  assert.deepEqual(d.models, ['claude-fable-5', 'claude-opus-5']);
  assert.equal(d.raw.cache_creation_input_tokens, 500);
  assert.equal(d.dir, join(root, 'projects', slug));
  assert.equal(d.sessions.length, 3);
  assert.deepEqual(d.sessions.map((s) => s.uuid).sort(), ['lead', 'mate-1', 'mate-2']);
  // A lead-only read sees a fraction of it — the defect Ruling 1 fixes.
  const { readUsage } = await load('dirmeter2');
  assert.ok(readUsage('lead').est_tokens < d.est_tokens);
});

test('readDirUsage keeps live context per-session, because summing it is meaningless', async (t) => {
  holdConfigDir(t);
  const root = scratch(t, 'dirctx-');
  const cwd = scratch(t, 'leadwt2-');
  const { slugForCwd, readDirUsage } = await load('dirctx');
  const slug = slugForCwd(cwd);
  seed(root, slug, 'lead', asst('claude-fable-5', { input_tokens: 1, cache_read_input_tokens: 499999 }));
  seed(root, slug, 'mate', asst('claude-fable-5', { input_tokens: 1, cache_read_input_tokens: 99 }));
  process.env.CLAUDE_CONFIG_DIR = root;
  const d = readDirUsage(cwd);
  assert.equal(d.live_context, undefined, 'a directory has no single live context');
  const lead = d.sessions.find((s) => s.uuid === 'lead');
  assert.equal(lead.live_context, 500000, 'the resume decision reads the LEAD\'s own session');
  assert.equal(d.sessions.find((s) => s.uuid === 'mate').live_context, 100);
});

test('readDirUsage over-counts an operator session in the worktree, and that is the safe direction', async (t) => {
  holdConfigDir(t);
  const root = scratch(t, 'overcount-');
  const cwd = scratch(t, 'leadwt3-');
  const { slugForCwd, readDirUsage } = await load('overcount');
  const slug = slugForCwd(cwd);
  seed(root, slug, 'lead', asst('claude-fable-5', { input_tokens: 5, output_tokens: 5 }));
  seed(root, slug, 'operator-poking-around', asst('claude-opus-5', { input_tokens: 1000, output_tokens: 1000 }));
  process.env.CLAUDE_CONFIG_DIR = root;
  // Documented and deliberate: the worktree is the lead's, and over-counting trips early.
  assert.equal(readDirUsage(cwd).est_tokens, 2010);
});

test('readDirUsage bounds how much it will read, and reports what it dropped', async (t) => {
  holdConfigDir(t);
  const root = scratch(t, 'bounded-');
  const cwd = scratch(t, 'leadwt4-');
  const { slugForCwd, readDirUsage } = await load('bounded');
  const slug = slugForCwd(cwd);
  for (let i = 0; i < 10; i++) seed(root, slug, `s-${i}`, asst('claude-fable-5', { input_tokens: 1, output_tokens: 0 }));
  process.env.CLAUDE_CONFIG_DIR = root;
  const d = readDirUsage(cwd, { maxTranscripts: 4 });
  assert.equal(d.transcripts, 4);
  assert.equal(d.transcripts_skipped, 6, 'a silent cap reads as "covered everything"');
  assert.equal(d.est_tokens, 4);
  const all = readDirUsage(cwd);
  assert.equal(all.transcripts, 10);
  assert.equal(all.transcripts_skipped, 0);
});

test('readDirUsage takes last_model from the NEWEST transcript that has one', async (t) => {
  // `readDirUsage().last_model` had ZERO assertions anywhere in the suite: reversing the sort
  // to pick the OLDEST session survived green. It feeds `modelDeviation().deviated` — the
  // actionable "is this lead off its pin right now" state a watchdog alarms on — on what is
  // now the PRIMARY meter path. Reading the oldest transcript answers a question nobody asked
  // and answers the real one wrong in both directions: a stale teammate on the pin masks a
  // live lead that has fallen off it, and a stale teammate off the pin alarms on a clean fleet.
  holdConfigDir(t);
  const root = scratch(t, 'dirlast-');
  const cwd = scratch(t, 'leadwt6-');
  const { slugForCwd, readDirUsage } = await load('dirlast');
  const slug = slugForCwd(cwd);
  // mtimes are owned outright, not left to filesystem granularity — see `setMtime`.
  setMtime(seed(root, slug, 'oldest', asst('claude-opus-4-8', { output_tokens: 1 })), 1_600_000_000);
  setMtime(seed(root, slug, 'middle', asst('claude-opus-5', { output_tokens: 1 })), 1_700_000_000);
  setMtime(seed(root, slug, 'newest', asst('claude-fable-5', { output_tokens: 1 })), 1_800_000_000);
  process.env.CLAUDE_CONFIG_DIR = root;

  const d = readDirUsage(cwd);
  assert.equal(d.last_model, 'claude-fable-5', 'the NEWEST transcript, not the oldest and not a merge');
  assert.deepEqual(d.sessions.map((s) => s.uuid), ['newest', 'middle', 'oldest'], 'sessions are newest-first');
  assert.deepEqual(d.models, ['claude-fable-5', 'claude-opus-4-8', 'claude-opus-5'], 'and models still carries all three');

  // Now the case the doc used to state wrongly ("the most recently modified transcript"): a
  // NEWER transcript with no model of its own must not blank the answer. A teammate that never
  // got past login writes only '<synthetic>' rows, so its own `last_model` is null — and null
  // reads as "not deviating", i.e. a fleet-wide false CLEAN produced by the session that failed
  // hardest. The reading falls through to the newest transcript that HAS a model.
  setMtime(seed(root, slug, 'never-logged-in', asst('<synthetic>', { input_tokens: 0, output_tokens: 0 })), 1_900_000_000);
  const after = readDirUsage(cwd);
  assert.equal(after.sessions[0].uuid, 'never-logged-in', 'it really is the newest file');
  assert.equal(after.sessions[0].last_model, null, 'and it really has no model of its own');
  assert.equal(after.last_model, 'claude-fable-5', 'so the answer falls through to the newest that HAS one');
});

test('the transcript cap keeps the NEWEST transcripts, not an arbitrary subset', async (t) => {
  // The bounded-read test above seeds ten IDENTICAL transcripts, so it pins the cap's SAFETY
  // (nothing dropped silently) while leaving the property that makes it choose CORRECTLY
  // unpinned — reversing the sort to oldest-first survives it green. The cap exists for the
  // misconfigured case where a shared slug directory holds tens of transcripts; a bounded read
  // that keeps the DEAD ones there meters a busy lead as nearly idle and never trips.
  holdConfigDir(t);
  const root = scratch(t, 'dirnewest-');
  const cwd = scratch(t, 'leadwt7-');
  const { slugForCwd, readDirUsage } = await load('dirnewest');
  const slug = slugForCwd(cwd);
  // Token counts are powers of ten so any subset sums to a distinguishable number.
  for (let i = 0; i < 5; i++) {
    setMtime(seed(root, slug, `s-${i}`, asst('claude-fable-5', { input_tokens: 10 ** i, output_tokens: 0 })),
      1_600_000_000 + i * 1_000_000);
  }
  process.env.CLAUDE_CONFIG_DIR = root;
  const d = readDirUsage(cwd, { maxTranscripts: 2 });
  assert.equal(d.est_tokens, 10_000 + 1_000, 'the two NEWEST (s-4, s-3), not the two oldest (1 + 10)');
  assert.deepEqual(d.sessions.map((s) => s.uuid), ['s-4', 's-3']);
  assert.equal(d.transcripts_skipped, 3);
});

test('readDirUsage reads only .jsonl files, so a stray copy is not counted twice', async (t) => {
  // Dropping the `.endsWith('.jsonl')` filter survives green. A slug directory is a plain
  // directory on the operator's machine: a hand-made backup of a transcript would then be
  // summed alongside the original and DOUBLE that lead's metered spend — tripping the breaker
  // at half its budget — and a binary file such as `.DS_Store` would land in `bad_lines`,
  // which is the signal that says "the transcript format has drifted".
  holdConfigDir(t);
  const root = scratch(t, 'dirext-');
  const cwd = scratch(t, 'leadwt8-');
  const { slugForCwd, readDirUsage } = await load('dirext');
  const slug = slugForCwd(cwd);
  const row = asst('claude-fable-5', { input_tokens: 6, output_tokens: 4 });
  seed(root, slug, 'lead', row);
  const dir = join(root, 'projects', slug);
  writeFileSync(join(dir, 'lead.jsonl.bak'), row);        // `cp lead.jsonl lead.jsonl.bak`
  writeFileSync(join(dir, '.DS_Store'), ' binary junk ');
  writeFileSync(join(dir, 'notes.txt'), 'reminder to self');
  process.env.CLAUDE_CONFIG_DIR = root;

  const d = readDirUsage(cwd);
  assert.equal(d.transcripts, 1, 'only `.jsonl` files are transcripts');
  assert.equal(d.est_tokens, 10, 'a `.bak` copy of a transcript must not be counted a second time');
  assert.equal(d.turns, 1);
  assert.equal(d.bad_lines, 0, 'and a non-transcript file must not be read as format drift');
  assert.deepEqual(d.sessions.map((s) => s.uuid), ['lead']);
});

test('readDirUsage degrades on a missing directory and on junk input', async (t) => {
  holdConfigDir(t);
  const root = scratch(t, 'dirmissing-');
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readDirUsage } = await load('dirmissing');
  const gone = readDirUsage('/no/such/worktree');
  assert.equal(gone.est_tokens, 0);
  assert.equal(gone.turns, 0);
  assert.equal(gone.transcripts, 0);
  assert.deepEqual(gone.sessions, []);
  for (const junk of [null, undefined, 42, {}, '']) {
    assert.doesNotThrow(() => readDirUsage(junk), String(junk));
    assert.equal(readDirUsage(junk).est_tokens, 0);
    assert.equal(readDirUsage(junk).dir, null);
  }
});

test('readDirUsage composes with modelDeviation across the whole team', async (t) => {
  holdConfigDir(t);
  const root = scratch(t, 'dirdev-');
  const cwd = scratch(t, 'leadwt5-');
  const { slugForCwd, readDirUsage, modelDeviation } = await load('dirdev');
  const slug = slugForCwd(cwd);
  seed(root, slug, 'lead', asst('claude-fable-5', { output_tokens: 1 }));
  seed(root, slug, 'mate', asst('claude-opus-5', { output_tokens: 1 }));
  process.env.CLAUDE_CONFIG_DIR = root;
  const d = modelDeviation(readDirUsage(cwd), 'fable');
  assert.deepEqual(d.unexpected, ['claude-opus-5'], 'a teammate off the pin is a fleet defect too');
});

// ---------------------------------------------------------------------------
// The `soma up` spend projection. Pure arithmetic, so `soma up` only has to print it.
// ---------------------------------------------------------------------------

test('projectFleetSpend reports the worst case across budget classes', async () => {
  const { projectFleetSpend } = await load('proj');
  const p = projectFleetSpend({
    max_leads: 10,
    budgets: {
      research: { tokens_cap: 5000000 },
      standard: { tokens_cap: 20000000 },
      review: { tokens_cap: 25000000 },
      iterate: { tokens_cap: 38000000 },
      babysit: { tokens_cap: 8000000 },
    },
  });
  assert.equal(p.max_leads, 10);
  assert.equal(p.worst.name, 'iterate', 'the worst case is the LARGEST class, not the typical one');
  assert.equal(p.worst.tokens_cap, 38000000);
  assert.equal(p.worst.fleet_total, 380000000);
  // Descending by fleet total: 38M, 25M, 20M, 8M, 5M.
  assert.deepEqual(p.classes.map((c) => c.name), ['iterate', 'review', 'standard', 'babysit', 'research']);
  assert.equal(p.classes.find((c) => c.name === 'standard').fleet_total, 200000000);
  assert.match(p.message, /10 leads/);
  assert.match(p.message, /380,000,000/);
  assert.match(p.message, /iterate/);
});

test('projectFleetSpend refuses a max_leads admission would refuse, rather than projecting 0 (#21)', async () => {
  // This used to read every one of these as 0 and print "0 leads × … = 0" — the warning that
  // lies. `soma up` now refuses on the throw; `fleet.admit` refuses the same values.
  const { projectFleetSpend } = await load('proj2');
  for (const junk of [null, undefined, 42, 'nope', {}, { budgets: null }]) {
    assert.throws(() => projectFleetSpend(junk), { name: 'TypeError', message: /max_leads/ }, String(junk));
  }
  for (const bad of ['ten', '', '  ', 2.5, '2.5', -1, null, [], {}, true, Infinity, NaN]) {
    assert.throws(() => projectFleetSpend({ max_leads: bad, budgets: {} }),
      { name: 'TypeError', message: /max_leads must be a non-negative integer/ }, `max_leads ${String(bad)} was accepted`);
  }
  assert.throws(() => projectFleetSpend({ max_leads: 'ten', budgets: {} }), { message: /got "ten"$/ });
  // The value is shown without JSON.stringify, which throws on a BigInt while explaining itself.
  assert.throws(() => projectFleetSpend({ max_leads: 5n, budgets: {} }), { message: /got 5$/ });
  // A budgets that is not an object of classes projects no classes; the lead count is still real.
  const p = projectFleetSpend({ max_leads: 3, budgets: null });
  assert.equal(p.max_leads, 3);
  assert.deepEqual(p.classes, []);
  assert.equal(p.worst.fleet_total, 0);
});

test('projectFleetSpend reads a numeric-string max_leads as admission does (#21)', async () => {
  const { projectFleetSpend } = await load('proj3');
  const p = projectFleetSpend({ max_leads: '10', budgets: { heavy: { tokens_cap: 5000 }, standard: { tokens_cap: 1000 } } });
  assert.equal(p.max_leads, 10);
  assert.equal(p.worst.name, 'heavy');
  assert.equal(p.worst.fleet_total, 50000);
  assert.match(p.message, /10 leads × 5,000 est_tokens \(heavy, the largest budget class\) = 50,000/);
  assert.equal(projectFleetSpend({ max_leads: ' 4 ', budgets: {} }).max_leads, 4);
});

test('projectFleetSpend reads a numeric-string tokens_cap as the breaker does (#52)', async () => {
  // The issue's own numbers. `count()` read `"60000000"` as 0, so the worst case shown was the
  // all-standard 200,000,000 while the breaker would let ten iterate leads spend 600,000,000.
  const { projectFleetSpend } = await load('proj52');
  const p = projectFleetSpend({ max_leads: 10, budgets: { iterate: { tokens_cap: '60000000' }, standard: { tokens_cap: 20000000 } } });
  assert.equal(p.worst.name, 'iterate');
  assert.equal(p.worst.tokens_cap, 60000000);
  assert.equal(p.worst.fleet_total, 600000000);
  assert.match(p.message, /600,000,000/);
});

test('projectFleetSpend refuses a tokens_cap the breaker would refuse, rather than projecting 0 (#52)', async () => {
  const { projectFleetSpend } = await load('proj52b');
  for (const bad of ['lots', '', '  ', null, -1, '-1', Infinity, 'Infinity', NaN, true, [], {}]) {
    assert.throws(() => projectFleetSpend({ max_leads: 1, budgets: { heavy: { tokens_cap: bad } } }),
      { name: 'TypeError', message: /budgets\.heavy\.tokens_cap must be a non-negative number/ }, `tokens_cap ${String(bad)} was accepted`);
  }
  assert.throws(() => projectFleetSpend({ max_leads: 1, budgets: { heavy: { tokens_cap: 'lots' } } }), { message: /got "lots"$/ });
  // The value is shown without JSON.stringify, which throws on a BigInt while explaining itself.
  assert.throws(() => projectFleetSpend({ max_leads: 1, budgets: { heavy: { tokens_cap: 5n } } }), { message: /got 5$/ });
});

test('projectFleetSpend projects a class with no tokens_cap of its own as 0, and takes 0 and 2.5 as caps (#52)', async () => {
  const { projectFleetSpend } = await load('proj52c');
  // Not token-capped, as checkBudget reads it: an inherited cap is a cap nobody wrote in soma.json.
  const inherited = Object.create({ tokens_cap: 'lots' });
  const p = projectFleetSpend({ max_leads: 2, budgets: { capless: { turn_cap: 9 }, inherited, off: { tokens_cap: 0 }, half: { tokens_cap: 2.5 } } });
  const by = Object.fromEntries(p.classes.map((c) => [c.name, c.fleet_total]));
  assert.deepEqual(by, { capless: 0, inherited: 0, off: 0, half: 5 });
  assert.equal(p.worst.name, 'half');
});

// ---------------------------------------------------------------------------
// The ignore reasons themselves. My own `iterations` reason was factually wrong,
// and the >20-char length check could not tell.
// ---------------------------------------------------------------------------

test('an ignored field that carries numeric leaves must say WHY it is not additional volume', async () => {
  // A classification is only as good as its stated reason. The guard did not catch the
  // `iterations` mistake because the key WAS classified — just with a reason that asserted
  // "carries no token count of its own" about a field carrying a full per-call breakdown.
  // For the three ignored fields whose real values contain numbers, a length check is not
  // enough: the reason has to explain the non-additivity, or the next wrong reason lands too.
  const { USAGE_FIELDS } = await load('reasons');
  const CARRY_NUMBERS = ['cache_creation', 'server_tool_use', 'iterations'];
  const EXPLAINS = /breakdown|double-count|per-call|per-API-call|last call|request counts|not tokens/i;
  for (const key of CARRY_NUMBERS) {
    const why = USAGE_FIELDS.ignored[key];
    assert.ok(why, `${key} must be classified`);
    assert.match(why, EXPLAINS,
      `${key}: "${why}" does not explain why its numbers are not additional volume`);
    assert.ok(!/carries no token count/i.test(why),
      `${key}: claims to carry no token count, which is the mistake this test exists for`);
  }
});

// ---------------------------------------------------------------------------
// readTailRows — the limits phase's reader. Same file, same byte reader as the meter.
// ---------------------------------------------------------------------------

test('readTailRows returns the last N parsed rows oldest-first, from the SAME file readUsage reads', async (t) => {
  holdConfigDir(t);
  const root = scratch(t, 'tail-');
  const lines = [];
  for (let i = 0; i < 100; i++) lines.push(i % 2 ? asst('claude-opus-5', { input_tokens: i }) : JSON.stringify({ type: 'user', i }));
  seed(root, 'p', 'uuid-t1', lines.join('\n') + '\n');
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readTailRows, readUsage } = await load('tail1');
  const tail = readTailRows('uuid-t1', { last: 3 });
  assert.deepEqual(tail.rows, lines.slice(-3).map((l) => JSON.parse(l)), 'the last three, oldest first');
  assert.equal(tail.bad_lines, 0);
  // The seam with the meter: one locator, one file. A tail reader with its own idea of the
  // projects root would read another lead's transcript — or none — while the meter read the
  // right one, and no rotation would ever fire.
  assert.equal(tail.transcript, readUsage('uuid-t1').transcript);
  assert.equal(tail.uuid, 'uuid-t1');
  assert.equal(readTailRows('uuid-t1').rows.length, 40, 'the default keeps 40 rows');
  assert.equal(readTailRows('uuid-t1', { last: 2.9 }).rows.length, 2, 'last is floored, never rounded up');
  assert.equal(readTailRows('uuid-t1', { last: 0 }).rows.length, 40, 'a non-positive last is the default, not "no rows"');
});

test('readTailRows marks a torn line that is not the first kept line with null in its place, drops a leading one, and passes parsed non-object values through', async (t) => {
  holdConfigDir(t);
  const root = scratch(t, 'tail-');
  const good = JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5' } });
  const TORN = '{"type":"assistant","isApiErrorMessage":tr';
  seed(root, 'p', 'uuid-t2', good + '\n' + TORN);
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readTailRows } = await load('tail2');
  const torn = readTailRows('uuid-t2');
  // The torn LAST line is the normal case for a live file — and it is exactly the line the
  // classifier has to know about: it may be the healthy row that makes a rate_limit row before it
  // `none`, and a kill on that guess lands mid-turn. So it is handed over as `null` IN ITS PLACE
  // (the classifier's caller contract), never silently dropped.
  assert.deepEqual(torn.rows, [JSON.parse(good), null]);
  assert.equal(torn.bad_lines, 1, 'counted AND placed: the classifier reads the null, the meter reads the count');
  // A torn line in the MIDDLE reads the same way, in its place.
  seed(root, 'p', 'uuid-t2b', [good, TORN, good].join('\n'));
  assert.deepEqual(readTailRows('uuid-t2b').rows, [JSON.parse(good), null, JSON.parse(good)]);
  // The FIRST kept line is the one exception: a tail window that opens mid-file opens on a line the
  // reader did not see the start of, so a leading unparseable line is dropped (and counted).
  seed(root, 'p', 'uuid-t2c', [TORN, good, good].join('\n'));
  const leading = readTailRows('uuid-t2c', { last: 3 });
  assert.deepEqual(leading.rows, [JSON.parse(good), JSON.parse(good)]);
  assert.equal(leading.bad_lines, 1);
  // Valid JSON that is not an object (`[]`, `1`, `null`, `"x"`) parses and passes through AS PARSED:
  // the classifier owns what a non-object entry means (older than the last assistant row: history;
  // newer: unobservable), and it cannot own that if the reader hides them.
  seed(root, 'p', 'uuid-t3', [good, '[]', '1', 'null', '"x"', ''].join('\n'));
  assert.deepEqual(readTailRows('uuid-t3').rows, [JSON.parse(good), [], 1, null, 'x']);
  assert.equal(readTailRows('uuid-t3').bad_lines, 0);
});

test('readTailRows yields no rows and a null transcript for a missing file or a bad uuid, never a throw', async (t) => {
  holdConfigDir(t);
  process.env.CLAUDE_CONFIG_DIR = scratch(t, 'tail-');
  const { readTailRows } = await load('tail3');
  assert.deepEqual(readTailRows('nope'), { rows: [], bad_lines: 0, transcript: null, uuid: 'nope' });
  for (const bad of [undefined, null, '', '.', '..', '../x', 'a/b', 42]) {
    assert.deepEqual(readTailRows(bad), { rows: [], bad_lines: 0, transcript: null, uuid: null }, `uuid ${JSON.stringify(bad)}`);
  }
});

test('readTailRows sees the same lines as a whole-file split when lines and multi-byte characters straddle chunk boundaries', async (t) => {
  holdConfigDir(t);
  const root = scratch(t, 'tail-');
  const lines = [];
  for (let i = 0; i < 60; i++) lines.push(JSON.stringify({ type: 'assistant', i, message: { model: i % 2 ? 'claude-opus-5-ü€🙂' : 'claude-opus-5' } }));
  const text = lines.join('\n') + '\n';
  seed(root, 'p', 'uuid-t4', text);
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readTailRows } = await load('tail4');
  const oracle = text.split('\n').filter((l) => l.trim() !== '').slice(-7).map((l) => JSON.parse(l));
  for (const chunkSize of [1, 2, 3, 5, 7, 64]) {
    assert.deepEqual(readTailRows('uuid-t4', { last: 7, chunkSize }).rows, oracle, `chunkSize ${chunkSize}`);
  }
});

test('readTailRows places a null where an OVER-LONG line was dropped, and counts only the drops inside the kept tail', async (t) => {
  holdConfigDir(t);
  const root = scratch(t, 'tail-');
  process.env.CLAUDE_CONFIG_DIR = root;
  const { readTailRows, readUsage } = await load('tail5');
  const good = JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5' } });
  // `streamLines` refuses to buffer a line past `maxLine` and resyncs at the next newline. Reached
  // here the way `a single absurdly long line is dropped without exhausting memory` reaches it —
  // chunkSize 512 / maxLine 4096, so the line straddles chunk reads, which is the only way the
  // ceiling is ever crossed. The PRODUCTION ceiling is measured below, on a real 17 MB line.
  const FAT = JSON.stringify({ type: 'assistant', blob: 'x'.repeat(17_000) });
  const OPTS = { chunkSize: 512, maxLine: 4096 };

  // THE DEFECT THIS PINS. The dropped line was counted in `bad_lines` and never placed, so the row
  // VANISHED out of `rows` and the row before it became the newest — the exact opposite of what a
  // torn line does. MEASURED on the real reader and the real classifier, with a rate_limit row
  // followed by a HEALTHY row carrying one oversized blob: `rows=1 bad_lines=1`, and
  // `classifyLimit` answered `{kind:'seat_window', resetsAt:1440433800000}` for a lead that had
  // already recovered — which the limits phase acts on by killing it mid-turn and rotating it.
  seed(root, 'p', 'uuid-t5', [good, FAT].join('\n') + '\n');
  const dropped = readTailRows('uuid-t5', OPTS);
  assert.deepEqual(dropped.rows, [JSON.parse(good), null], 'the over-long line is a null IN ITS PLACE, exactly like a torn one');
  assert.equal(dropped.bad_lines, 1, 'counted AND placed: the count alone is what hid the missing row');

  // At the PRODUCTION default ceiling (16 MB, no `maxLine` given), on a real 17 MB line — the size
  // one `Read` of a large file puts in a transcript. 47 ms all in, so the real bound is pinned
  // rather than described.
  seed(root, 'p', 'uuid-t5b', [good, JSON.stringify({ type: 'assistant', blob: 'x'.repeat(17 * 1024 * 1024) })].join('\n') + '\n');
  const real = readTailRows('uuid-t5b');
  assert.deepEqual(real.rows, [JSON.parse(good), null], 'the default maxLine is a real ceiling, and a line over it is still placed');
  assert.equal(real.bad_lines, 1);

  // The count is the TAIL's, not the whole file's. `streamLines` walks every line, so a lead with
  // one oversized row thousands of lines back reported a torn tail on EVERY tick — an alarm naming
  // a row the tail does not contain. A drop that scrolls out of the window scrolls out of the count.
  const many = [FAT];
  for (let i = 0; i < 6; i++) many.push(JSON.stringify({ type: 'assistant', i }));
  seed(root, 'p', 'uuid-t6', many.join('\n') + '\n');
  const outside = readTailRows('uuid-t6', { ...OPTS, last: 3 });
  assert.deepEqual(outside.rows.map((r) => r.i), [3, 4, 5], 'the last three lines, all intact — the drop is six rows back');
  assert.equal(outside.bad_lines, 0, 'not this tail\'s tear');
  // And the meter's own reading is unchanged: `bad_lines` there answers "how much of this
  // transcript did not parse", which is the whole file's question.
  assert.equal(readUsage('uuid-t6', null, OPTS).bad_lines, 1, 'the meter still counts a drop anywhere in the file');

  // The FIRST kept line is the one exception, as it is for a torn one: a window that opens mid-file
  // opens on a line whose start the reader never saw, so a leading drop is counted and not placed.
  seed(root, 'p', 'uuid-t7', [FAT, good, good].join('\n') + '\n');
  const leading = readTailRows('uuid-t7', { ...OPTS, last: 3 });
  assert.deepEqual(leading.rows, [JSON.parse(good), JSON.parse(good)]);
  assert.equal(leading.bad_lines, 1);
});
