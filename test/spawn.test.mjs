/**
 * The spawner's tests. Every pin here stands for a *silent* failure — a lead that starts
 * and looks healthy while one safety property is off — so the assertions are written to
 * fail on the argv/env/call-order artefact rather than on an effect nothing observes.
 *
 * Nothing in this file touches the repo working tree, spawns tmux, or runs `claude`. The
 * one test that exercises a real implementation (`withRepoLock`) writes only under the
 * throwaway `$SOMA_HOME` that `soma-home.mjs` sets.
 */
import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { leadDir, logPath, worktreeDir, SOMA_HOME } from '../bin/lib/paths.mjs';
import { enumerateUserMcpServers, writeWorktreeGuardrails } from '../bin/lib/settings-gen.mjs';
import { withRepoLock } from '../bin/lib/worktree.mjs';
import { socketName, tmuxArgs } from '../bin/lib/tmux.mjs';
import * as s from '../bin/lib/spawn.mjs';

// --- helpers -----------------------------------------------------------------

/** The value tmux will hand `claude` after `flag`, or undefined. */
const argAfter = (argv, flag) => (argv.indexOf(flag) === -1 ? undefined : argv[argv.indexOf(flag) + 1]);
/** How many argv *elements* are exactly `flag` — a joined "--model fable" counts zero. */
const countOf = (argv, flag) => argv.filter((a) => a === flag).length;

/**
 * A spawner environment with the operator's real hazards in it.
 *
 * `CLAUDE_CODE_EFFORT_LEVEL: 'low'` is the machine this ships to (research §2: the
 * operator's persisted level is `low`), so a lead that merely inherited would run at low
 * and the watchdog would raise MODEL_DEVIATION on a fleet that looked fine.
 */
const SPAWNER_ENV = Object.freeze({
  HOME: '/Users/op',
  PATH: '/opt/homebrew/bin:/usr/bin',
  SHELL: '/bin/zsh',
  TERM: 'xterm-256color',
  LANG: 'en_US.UTF-8',
  TMPDIR: '/var/folders/t/',
  CLAUDE_CONFIG_DIR: '/Users/op/.claude-work',
  CLAUDE_CODE_EFFORT_LEVEL: 'low',
  ANTHROPIC_API_KEY: 'sk-ant-SECRETVALUE',
  OPENAI_API_KEY: 'sk-SECRETVALUE',
  GH_TOKEN: 'ghp_SECRETVALUE',
  AWS_SECRET_ACCESS_KEY: 'SECRETVALUE',
  SSH_AUTH_SOCK: '/private/tmp/ssh-SECRETVALUE/agent.1',
  ELEVENLABS_API_KEY: 'SECRETVALUE',
});

const CFG = Object.freeze({
  repos: { r: { path: '/repo', base_branch: 'develop' } },
  teammate_effort: 'inherit',
  teammate_mcp_allow: [],
  env_allow: [],
});

/**
 * What `settings-gen.writeLeadSettings` actually publishes, verbatim in shape.
 *
 * The spawner now READS this file back to compose the launch settings, so a stub returning
 * a path that does not exist (`'/s.json'`, which is what this harness used to hand back)
 * tests nothing about the composition and would make every launch throw. Keeping the real
 * shape here is also what lets the "adds without displacing" test mean something: a model
 * pin, a `permissions` block and three hooks are all present to be lost.
 *
 * ⚠ **THIS IS A COMPOSITION FIXTURE, NOT A COPY OF WHAT `writeLeadSettings` WRITES.** The
 * real generator writes NO `permissions` key — those three bare names reached every teammate
 * through `--settings` and cost the fleet its hands (`settings-gen`'s header has the
 * measurements). They are kept *here* on purpose and for one reason: `withTeammateGuard` must
 * carry an arbitrary settings file through verbatim, and a fixture with no `permissions`
 * cannot show that a `permissions` block survives the merge. `test/settings-gen.test.mjs`
 * owns the assertion about what the generator actually emits; nothing in this file may be
 * read as a claim that a real lead settings file looks like this.
 */
const LEAD_SETTINGS = Object.freeze({
  model: 'opus',
  permissions: { deny: ['Edit', 'Write', 'NotebookEdit'] },
  hooks: {
    PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: "mkdir -p '/s/heartbeats' && touch '/s/heartbeats/cr-1'" }] }],
    Stop: [{ matcher: '', hooks: [{ type: 'command', command: "node '/i/bin/hooks/lead-stop.mjs'" }] }],
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: "node '/i/bin/hooks/lead-gate.mjs'" }] }],
  },
});

/** Publish a stand-in `leads/<id>/settings.json` under the throwaway state root. */
function writeFakeLeadSettings(id, body = LEAD_SETTINGS) {
  const fp = join(leadDir(id), 'settings.json');
  mkdirSync(dirname(fp), { recursive: true });
  writeFileSync(fp, typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`);
  return fp;
}

/** The launch settings the spawner handed tmux, parsed. */
const launchSettingsOf = (spec) => JSON.parse(readFileSync(argAfter(spec.argv, '--settings'), 'utf8'));

/**
 * A complete stub dep set plus an `order` log. Every dep is stubbed, deliberately: the
 * spawner refuses a partial set rather than silently reaching for the real tmux.
 */
function harness(over = {}, { trustFile = '/Users/op/.claude-work/.claude.json' } = {}) {
  const order = [];
  const calls = { preTrust: [], newSession: [], guardrails: [], standing: [], remain: [], hasSession: [], lock: [] };
  const deps = {
    withRepoLock: (repo, fn, run) => {
      calls.lock.push(repo);
      order.push('lock');
      try {
        return fn(run);
      } finally {
        order.push('unlock');
      }
    },
    hasSession: (name) => { calls.hasSession.push(name); return false; },
    ensureWorktree: () => { order.push('worktree'); return { dir: '/w/cr-1', branch: 'soma/cr-1', base_sha: 'sha', reused: false, excluded: true }; },
    writeWorktreeGuardrails: (dir, opts) => { order.push('guardrails'); calls.guardrails.push([dir, opts]); return '/w/cr-1/.claude/settings.local.json'; },
    preTrust: (...a) => { order.push('pretrust'); calls.preTrust.push(a); return trustFile; },
    writeLeadMcpConfig: () => { order.push('mcp'); return '/m.json'; },
    writeLeadSettings: (id) => { order.push('settings'); return writeFakeLeadSettings(id); },
    writeStanding: (t) => { order.push('standing'); calls.standing.push(t); return '/std.md'; },
    enumerateUserMcpServers: () => ['kite'],
    newSession: (spec) => { order.push('tmux'); calls.newSession.push(spec); },
    setRemainOnExit: (n) => { order.push('remain'); calls.remain.push(n); return true; },
    uuid: () => 'u1',
    loadConfig: () => CFG,
    env: SPAWNER_ENV,
    ...over,
  };
  return { deps, order, calls };
}

/** The order the three given corrections require, with the lock boundary outermost. */
const FULL_ORDER = ['lock', 'worktree', 'guardrails', 'pretrust', 'mcp', 'settings', 'standing', 'tmux', 'remain', 'unlock'];

/**
 * The position of `step` in `order`, refusing an absent one.
 *
 * `order.indexOf('pretrust') < order.indexOf('tmux')` is *true* when pretrust never ran, so
 * an ordering assertion written that way passes on a spawn that skipped the step entirely.
 * Measured: a mutation that dropped the trust re-mark on resume left that assertion green.
 */
function at(order, step) {
  const i = order.indexOf(step);
  assert.notEqual(i, -1, `${step} never ran, so its position cannot be asserted`);
  return i;
}

// --- buildLeadArgv -----------------------------------------------------------

test('buildLeadArgv carries all non-negotiable pins in order', () => {
  const argv = s.buildLeadArgv({ id: 'cr-1', sessionUuid: 'u1', brief: 'do x',
    settingsPath: '/s.json', mcpPath: '/m.json', standingPath: '/std.md' });
  const line = argv.join(' ');
  assert.ok(line.includes('--model opus'));
  assert.ok(line.includes('--effort max'));
  // No --disallowedTools any more: the lead-only edit ban is lifted, so a lead's tool
  // surface matches its teammates'. Its absence is asserted directly below.
  assert.ok(!line.includes('--disallowedTools'), 'the lifted edit ban must not re-appear on argv');
  assert.ok(line.includes('--strict-mcp-config'));
  assert.ok(line.includes('--append-system-prompt-file /std.md'));
  assert.ok(line.includes('--remote-control lead-cr-1'));
  assert.ok(argv[argv.length - 2] === '--');           // brief is last, after the -- guard
  assert.equal(argv[argv.length - 1], 'do x');
});

/**
 * The same pins as *argv elements*, which is the property that actually matters.
 *
 * `argv.join(' ').includes('--model opus')` above is satisfied by the single element
 * `'--model opus'` — one word to execFile, "unknown option" to claude, and a lead that
 * never starts. Only an index-pair check can tell the two apart.
 */
test('every pin is its own argv element, so no pin can be one joined word', () => {
  const argv = s.buildLeadArgv({ id: 'cr-1', sessionUuid: 'u1', brief: 'do x',
    settingsPath: '/s.json', mcpPath: '/m.json', standingPath: '/std.md' });
  assert.equal(argv[0], 'claude');
  // `LEAD_MODEL` is the pin, exported because the watchdog's MODEL_DEVIATION check has to
  // judge the transcript against the SAME pin this argv carries. Spelled in both files it
  // could be changed in one: a watchdog still comparing against a retired pin reports every
  // correctly-pinned lead as deviating, or — the silent direction — reports a real fallback
  // as clean. Asserted here as an argv element so the export cannot drift from the launch.
  assert.equal(s.LEAD_MODEL, 'opus');
  assert.equal(argAfter(argv, '--model'), s.LEAD_MODEL);
  for (const [flag, value] of [
    ['--model', 'opus'],
    ['--effort', 'max'],
    ['--permission-mode', 'acceptEdits'],
    ['--setting-sources', 'user,project,local'],
    ['--name', 'lead-cr-1'],
    ['--remote-control', 'lead-cr-1'],
    ['--settings', '/s.json'],
    ['--mcp-config', '/m.json'],
    ['--append-system-prompt-file', '/std.md'],
    ['--session-id', 'u1'],
  ]) {
    assert.equal(countOf(argv, flag), 1, `${flag} must appear exactly once as its own element`);
    assert.equal(argAfter(argv, flag), value, `${flag} must be followed by ${value}`);
  }
  for (const bare of ['--dangerously-skip-permissions', '--strict-mcp-config']) {
    assert.equal(countOf(argv, bare), 1, `${bare} must appear exactly once as its own element`);
  }
});

/**
 * THE PIN'S TWO JOBS HAVE TO AGREE, AND NOTHING CHECKED THAT THEY DO.
 *
 * `LEAD_MODEL` is both the LAUNCH TOKEN (`--model <it>`) and the WATCHDOG'S PIN
 * (`modelDeviation(usage, LEAD_MODEL)`), and the two are satisfied by different things: the
 * launcher needs an alias claude accepts, the watchdog needs a value `matchesPin` can find in
 * the id claude actually resolves that alias to. Every existing assertion covers one job or the
 * other, so a value that launches fine and matches nothing — `'opus5'`, `'claude opus'`, a full
 * id with a typo — would ship green while reporting **every healthy lead in the fleet as
 * deviating**, which is the noise-that-gets-ignored failure `LEAD_MODEL`'s own comment warns
 * about. This is the crossing test.
 *
 * The resolved id is hardcoded rather than probed, deliberately: probing means a paid API call
 * in the unit suite. It is the id measured on 2026-08-17 (`--model opus` →
 * `modelUsage: {"claude-opus-5": …}`), and `spawn.LEAD_MODEL`'s comment carries the measurement.
 */
test('the launch token and the watchdog pin agree on the id claude really resolves', async () => {
  const { modelDeviation } = await import('../bin/lib/tokens.mjs?pin-' + Date.now());
  const RESOLVED = 'claude-opus-5';                 // measured: `--model opus` resolves to this
  const clean = modelDeviation({ last_model: RESOLVED, models: [RESOLVED] }, s.LEAD_MODEL);
  assert.equal(clean.deviated, false,
    `LEAD_MODEL ${JSON.stringify(s.LEAD_MODEL)} does not match ${RESOLVED} — every correctly-pinned lead would report as deviating`);
  assert.equal(clean.pinned, s.LEAD_MODEL);
  // The dated-suffix form of the same model, which the segment rule exists to accept.
  assert.equal(modelDeviation({ last_model: `${RESOLVED}-20251001`, models: [`${RESOLVED}-20251001`] }, s.LEAD_MODEL).deviated, false);
  // …and the detector still bites in the direction it owns: a cross-family fallback.
  for (const fallen of ['claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5']) {
    const dev = modelDeviation({ last_model: fallen, models: [RESOLVED, fallen] }, s.LEAD_MODEL);
    assert.equal(dev.deviated, true, `a fallback to ${fallen} read as correctly pinned`);
    assert.deepEqual(dev.unexpected, [fallen]);
  }
  // The declared blind spot, pinned as a KNOWN state rather than left to be discovered: an
  // Opus-5 -> Opus-4.5 fallback satisfies `opus` and raises nothing. If this line ever flips,
  // someone sharpened the pin (`LEAD_MODEL = 'claude-opus-5'`) — update the comment, not this.
  assert.equal(modelDeviation({ last_model: 'claude-opus-4-5', models: ['claude-opus-4-5'] }, s.LEAD_MODEL).deviated, false,
    'the within-family blind spot documented on LEAD_MODEL has changed');
});

test('the -- guard closes the argv, so variadic --mcp-config cannot swallow the brief', () => {
  const argv = s.buildLeadArgv({ id: 'cr-1', sessionUuid: 'u1', brief: '--force a rewrite',
    settingsPath: '/s.json', mcpPath: '/m.json', standingPath: '/std.md' });
  assert.equal(countOf(argv, '--'), 1, 'exactly one -- separator');
  // A brief that begins with a dash is the case the separator exists for: it is the last
  // element and is NOT re-read as a flag.
  assert.deepEqual(argv.slice(argv.indexOf('--')), ['--', '--force a rewrite']);
});

test('a fresh spawn pins --session-id; a resume pins --resume; never both', () => {
  const base = { id: 'cr-1', sessionUuid: 'u1', brief: 'b', settingsPath: '/s.json', mcpPath: '/m.json', standingPath: '/std.md' };
  const fresh = s.buildLeadArgv(base);
  assert.equal(argAfter(fresh, '--session-id'), 'u1');
  assert.equal(countOf(fresh, '--resume'), 0, 'a fresh spawn must not resume');

  const again = s.buildLeadArgv({ ...base, resume: true });
  assert.equal(argAfter(again, '--resume'), 'u1');
  assert.equal(countOf(again, '--session-id'), 0, 'claude refuses to reuse a --session-id; a resume must not pass one');
});

test('buildLeadArgv refuses an argv it cannot make safe, rather than passing undefined to execFile', () => {
  const ok = { id: 'cr-1', sessionUuid: 'u1', brief: 'b', settingsPath: '/s.json', mcpPath: '/m.json', standingPath: '/std.md' };
  assert.doesNotThrow(() => s.buildLeadArgv(ok));
  // Each guard names its own field, so a guard that checks the wrong one is a failure
  // rather than a message that still matches.
  for (const key of ['sessionUuid', 'brief', 'settingsPath', 'mcpPath', 'standingPath']) {
    const named = new RegExp(`buildLeadArgv: ${key} must be a non-empty string`);
    assert.throws(() => s.buildLeadArgv({ ...ok, [key]: undefined }), named, `a missing ${key} must be refused by name`);
    assert.throws(() => s.buildLeadArgv({ ...ok, [key]: '' }), named, `an empty ${key} must be refused by name`);
  }
});

test('a lead id that is not a plain name is refused before it can become a tmux target', () => {
  const ok = { id: 'cr-1', sessionUuid: 'u1', brief: 'b', settingsPath: '/s.json', mcpPath: '/m.json', standingPath: '/std.md' };
  for (const id of ['cr 1', '../evil', 'CR-1', '-cr', 'cr;kill', '1cr']) {
    assert.throws(() => s.buildLeadArgv({ ...ok, id }), /is not a usable lead id/, `${JSON.stringify(id)} must be refused`);
  }
});

// --- ENV_ALLOW ---------------------------------------------------------------

test('ENV_ALLOW carries CLAUDE_CONFIG_DIR, and no name that could be a credential', () => {
  assert.ok(s.ENV_ALLOW.includes('CLAUDE_CONFIG_DIR'),
    'env -i DROPS it, so the orchestrator would mark trust in one .claude.json and the lead read another');
  for (const k of ['HOME', 'PATH', 'SHELL', 'TERM', 'LANG', 'TMPDIR']) {
    assert.ok(s.ENV_ALLOW.includes(k), `${k} is part of the shipped allowlist`);
  }
  // Values reach `ps` on this platform and are inherited by every teammate.
  for (const name of s.ENV_ALLOW) {
    assert.doesNotMatch(name, /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_AUTH$|AUTH_SOCK/i,
      `${name} looks like a credential; ENV_ALLOW is world-readable via ps and inherited by teammates`);
  }
  assert.ok(Object.isFrozen(s.ENV_ALLOW), 'a mutable allowlist is one stray push away from forwarding anything');
});

/**
 * The same list, **closed** — and it is a separate test so that no sibling assertion can
 * absorb the mutation it exists for.
 *
 * The denylist above catches a name that *looks* like a credential. This catches every name it
 * does not, and measured, that is most of them: `DATABASE_URL`, `SENTRY_DSN`,
 * `ANTHROPIC_BASE_URL` and `NODE_OPTIONS` could each be added to `ENV_ALLOW` with all 574
 * tests still green. `NODE_OPTIONS` is the one that matters — `NODE_OPTIONS=--require=/tmp/x.js`
 * is arbitrary code in every node process the lead and every teammate start, the guard hooks
 * included, and a guard hook running attacker-supplied code ends the whole enforcement story.
 *
 * The same point was argued one level up and not applied here: a credential
 * *denylist* "dies on `DATABASE_URL` … open by construction", while "an allow-list of six names
 * is enforceable because it is **closed**". Growing this list is a deliberate act, so it must
 * red a test and make somebody state the argument again.
 */
test('ENV_ALLOW is exactly these eight names, so the list cannot grow by one the denylist misses', () => {
  assert.deepEqual([...s.ENV_ALLOW], ['HOME', 'PATH', 'SHELL', 'TERM', 'LANG', 'TMPDIR', 'CLAUDE_CONFIG_DIR', 'USER'],
    'every name here is inherited by every teammate and every workflow agent, and is world-readable via ps');
});

/**
 * `USER` earned its place by measurement, and this test records the measurement so the next
 * person to prune the list does not have to rediscover it in a detached pane.
 *
 * On the first real fleet, on the machine v1 ships to: `claude -p` under `env -i` with the
 * other seven names returns `Not logged in · Please run /login`; the identical command with
 * `USER` added authenticates. Twice each way. `LOGNAME` alone does NOT substitute. OAuth
 * credentials are in the macOS keychain — there is no `.credentials.json` in either config
 * root — and the lookup does not resolve without it.
 *
 * The disclosure argument, which is why this one is allowed to grow a closed list: `HOME` is
 * already forwarded and is `/Users/<username>`, so a teammate can already read the username.
 * `USER` adds no information. Any future addition needs an argument of that shape.
 */
test('ENV_ALLOW carries USER, without which a lead renders normally and can never call the API', () => {
  assert.ok(s.ENV_ALLOW.includes('USER'),
    'measured: env -i without USER => "Not logged in · Please run /login"; the pane still renders and the composer still accepts input');
  assert.ok(!s.ENV_ALLOW.includes('LOGNAME'),
    'LOGNAME was measured NOT to substitute for USER, so carrying it would be one more forwarded name for nothing');
});

// --- buildLeadEnv ------------------------------------------------------------

test('buildLeadEnv pins effort max and teams flag, scrubbed via allowlist', () => {
  const env = s.buildLeadEnv({ id: 'cr-1', teammateEffort: 'inherit' });
  assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, 'max');
  assert.equal(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, '1');
  assert.equal(env.SOMA_LEAD_NAME, 'cr-1');
});

test('buildLeadEnv forwards exactly the allowlist and nothing that smells of a secret', () => {
  const env = s.buildLeadEnv({ id: 'cr-1', teammateEffort: 'inherit', env: SPAWNER_ENV });
  assert.equal(env.HOME, '/Users/op');
  assert.equal(env.PATH, '/opt/homebrew/bin:/usr/bin', 'env -i clears PATH; without this the lead cannot resolve `claude`');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/Users/op/.claude-work');
  for (const leaked of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'SSH_AUTH_SOCK', 'ELEVENLABS_API_KEY']) {
    assert.equal(env[leaked], undefined, `${leaked} must not reach a lead or the teammates that inherit its env`);
  }
  // The strong form: no forwarded VALUE came from a hazardous variable, whatever it was named.
  for (const [k, v] of Object.entries(env)) {
    assert.doesNotMatch(String(v), /SECRETVALUE/, `${k} carries a value copied out of a credential variable`);
  }
});

test('the lead runs at effort max even when the spawner itself is pinned low', () => {
  const env = s.buildLeadEnv({ id: 'cr-1', teammateEffort: 'inherit', env: SPAWNER_ENV });
  assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, 'max',
    'the operator persists effortLevel low; only this variable outranks it, and effort max cannot live in settings.json');
});

/**
 * spec §7: "when set to a level, the spawner keeps `--effort max` (pins the lead) and
 * DROPS the env var". The variable outranks subagent frontmatter, so leaving it set is
 * what makes a configured teammate level unreachable.
 */
test('teammate_effort of a level drops the env var, and the lead is still pinned by argv', () => {
  const env = s.buildLeadEnv({ id: 'cr-1', teammateEffort: 'high', env: SPAWNER_ENV });
  assert.ok(!('CLAUDE_CODE_EFFORT_LEVEL' in env),
    'the env var outranks per-teammate frontmatter, so teammate_effort: high cannot take effect while it is set');
  const argv = s.buildLeadArgv({ id: 'cr-1', sessionUuid: 'u1', brief: 'b', settingsPath: '/s', mcpPath: '/m', standingPath: '/d' });
  assert.equal(argAfter(argv, '--effort'), 'max', 'the lead is pinned by the flag whatever the config says about teammates');
});

test('an unset teammate_effort behaves as inherit rather than dropping the pin', () => {
  const env = s.buildLeadEnv({ id: 'cr-1', env: SPAWNER_ENV });
  assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, 'max', 'a missing config value must not silently un-pin effort');
});

/**
 * The branch's polarity, which is the whole property. Deciding "is this a configured level?"
 * decides whether to DROP the pin, so an unrecognised value has to fall to `inherit` and KEEP
 * it. Nothing validates `teammate_effort` anywhere — `config.DEFAULTS` supplies it and there is
 * no effort-level check in `bin/` — so `'inheret'` is one typo in `soma.json`, and read as a
 * level it drops `CLAUDE_CODE_EFFORT_LEVEL` for every teammate and every workflow agent, i.e.
 * the operator's persisted `effortLevel: low` reaching the entire fleet. It throws nothing. The
 * lead stays pinned by `--effort max`, so the watchdog's MODEL_DEVIATION check — which reads
 * the *lead's* transcript — never fires; the failure is entirely on the teammate side.
 *
 * **Measured: before this test the suite could not tell fail-open from fail-safe.** A reviewer
 * swapped one branch for the other and all 574 tests stayed green. These two tests are what
 * distinguish them, so the next person to touch that line finds out which way it fails.
 */
test('an unrecognised teammate_effort falls back to inherit rather than silently un-pinning', () => {
  // `''` and `null` are in here rather than in the unset test above because `soma up` spells
  // unset as `''` and a JSON config spells it as `null`, so both arrive as real config values.
  for (const notALevel of ['inheret', 'Inherit', 'INHERIT', 'maximum', 'max ', ' max', 'default', 'none', 'true', 'xhig', 'MAX', '', null, 0, 3, true, {}]) {
    const env = s.buildLeadEnv({ id: 'cr-1', teammateEffort: notALevel, env: SPAWNER_ENV });
    assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, 'max',
      `teammate_effort: ${JSON.stringify(notALevel)} is not a level, so reading it as one un-pins every teammate and workflow agent to the operator's persisted low`);
  }
});

test('each level claude actually accepts drops the pin, so a configured level is reachable', () => {
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const env = s.buildLeadEnv({ id: 'cr-1', teammateEffort: level, env: SPAWNER_ENV });
    assert.ok(!('CLAUDE_CODE_EFFORT_LEVEL' in env),
      `the env var outranks per-teammate frontmatter, so teammate_effort: ${level} cannot take effect while it is set`);
  }
});

test('buildLeadEnv refuses a lead id that could not be a state directory name', () => {
  for (const id of [undefined, '', 'cr 1', '../evil', 'CR-1']) {
    assert.throws(() => s.buildLeadEnv({ id, env: SPAWNER_ENV }), /is not a usable lead id/,
      `SOMA_LEAD_NAME reaches the gate, which joins it onto leads/<id>/BUDGET_TRIPPED: ${JSON.stringify(id)}`);
  }
});

test('buildLeadEnv sets SOMA_LEAD_SESSION_UUID, which is what tells a lead from its teammates', () => {
  const env = s.buildLeadEnv({ id: 'cr-1', sessionUuid: 'u1', env: SPAWNER_ENV });
  assert.equal(env.SOMA_LEAD_SESSION_UUID, 'u1',
    'lead-gate compares hook session_id against this; unset makes isLead false for EVERY session, '
    + 'so the lead\'s push/merge denies never fire (fails open) and the bus arm refuses everyone (fails closed)');
  const without = s.buildLeadEnv({ id: 'cr-1', env: SPAWNER_ENV });
  assert.ok(!('SOMA_LEAD_SESSION_UUID' in without), 'absent rather than the string "undefined", which would match a session id never minted');
});

test('SOMA_HOME reaches the lead resolved and identical to what the bus config records', () => {
  const env = s.buildLeadEnv({ id: 'cr-1', env: { ...SPAWNER_ENV, SOMA_HOME: `${SOMA_HOME()}/` } });
  assert.equal(env.SOMA_HOME, SOMA_HOME(),
    'settings-gen writes SOMA_HOME() into mcp.json; two spellings of one root make the bus and the lead disagree about where state lives');
});

/**
 * Issue #1. `env -i` dropped the socket and nothing put it back, so every lead's bus fell back to
 * `soma` and typed its wakes into whatever pane held the orchestrator's pane id THERE: in the
 * field, another fleet's orchestrator. Injected like SOMA_HOME, from the spawner's own module,
 * because that is the server `tmux.newSession` creates the lead on: equal by construction.
 */
test('SOMA_TMUX_SOCKET reaches the lead as the server the spawner creates it on, injected and never copied', () => {
  const env = s.buildLeadEnv({ id: 'cr-1', env: SPAWNER_ENV });
  assert.equal(env.SOMA_TMUX_SOCKET, socketName());
  assert.deepEqual(tmuxArgs([]), ['-L', env.SOMA_TMUX_SOCKET, '-u'], 'the socket every tmux call from this process, newSession included, runs under');
  const copied = s.buildLeadEnv({ id: 'cr-1', env: { ...SPAWNER_ENV, SOMA_TMUX_SOCKET: 'not-the-spawners-server' } });
  assert.equal(copied.SOMA_TMUX_SOCKET, socketName(),
    'a copied value can name a server the lead was not created on; the injected one cannot');
  assert.ok(!s.ENV_ALLOW.includes('SOMA_TMUX_SOCKET'), 'injected, so it must not also ride the copy');
});

test('the env tmux starts the lead with names the server it is started on', () => {
  const { deps, calls } = harness();
  s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps);
  assert.equal(calls.newSession[0].env.SOMA_TMUX_SOCKET, socketName());
});

test('an allow-listed variable set to empty is dropped, so "" cannot read as set', () => {
  const env = s.buildLeadEnv({ id: 'cr-1', env: { ...SPAWNER_ENV, CLAUDE_CONFIG_DIR: '' } });
  assert.ok(!('CLAUDE_CONFIG_DIR' in env),
    'soma up forwards unset as ""; claudeConfigRoot and pretrust both treat "" as unset via ||, and a set-but-empty '
    + 'variable in the lead is the one way the two could diverge');
});

test('every value handed to tmux is a string, because tmux builds k=v by concatenation', () => {
  const env = s.buildLeadEnv({ id: 'cr-1', sessionUuid: 'u1', teammateEffort: 'inherit', env: SPAWNER_ENV });
  for (const [k, v] of Object.entries(env)) assert.equal(typeof v, 'string', `${k} is ${typeof v}, which tmux would stringify`);
  assert.equal(env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, '0');
  assert.equal(env.DISABLE_AUTOUPDATER, '1');
});

// --- spawnLead ---------------------------------------------------------------

test('spawnLead wires worktree, pre-trust, settings, tmux in order', () => {
  const { deps, order } = harness();
  const r = s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps);
  assert.deepEqual(order.filter((o) => o !== 'lock' && o !== 'unlock' && o !== 'standing'),
    ['worktree', 'guardrails', 'pretrust', 'mcp', 'settings', 'tmux', 'remain']);
  assert.equal(r.tmux_target, 'lead-cr-1');
  assert.equal(r.session_uuid, 'u1');
});

test('the whole spawn runs inside the per-repo lock, and the lock is not dead code', () => {
  const { deps, order, calls } = harness();
  s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps);
  assert.deepEqual(order, FULL_ORDER);
  assert.deepEqual(calls.lock, ['r'], 'the lock is keyed on the repo, which is what serializes two admitters');
});

test('spawnLead is synchronous, because withRepoLock releases before a promise could settle', () => {
  const { deps } = harness();
  const r = s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps);
  assert.equal(typeof r?.then, 'undefined', 'a thenable here means the "protected" work runs after the lock is gone');
});

test('against the real withRepoLock: the callback is accepted and the mutex is actually taken', () => {
  const { deps, order } = harness({ withRepoLock });
  const r = s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps);
  assert.equal(r.session_uuid, 'u1', 'the real lock ran the spawn to completion rather than refusing a thenable');
  assert.deepEqual(order, ['worktree', 'guardrails', 'pretrust', 'mcp', 'settings', 'standing', 'tmux', 'remain'],
    'the real lock pushes nothing of its own; every step still ran, in order, inside it');
});

/**
 * Teammates inherit the cwd of whoever spawned them, so a lead launched at
 * the repo root puts the whole fleet in ONE `projects/<slug>/` directory and the token
 * meter reads every lead's spend as every other lead's.
 */
test('the lead cwd is its own worktree, not the shared checkout', () => {
  const { deps, calls } = harness();
  const r = s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps);
  assert.equal(calls.newSession[0].cwd, '/w/cr-1');
  assert.equal(r.cwd, '/w/cr-1');
  assert.notEqual(calls.newSession[0].cwd, '/repo', 'the shared checkout is the one cwd that collapses the whole fleet onto one token meter');
  // And the standing brief is told the SAME cwd the session is launched in, so the lead can
  // state it to teammates as a fact instead of `cd`-ing to it in every command — 31% of a
  // lead's Bash calls were `cd <own worktree> && …` when nothing told it where it was, and on
  // Claude Code 2.1.259 that shape stopped 79 sessions on a permission prompt nobody saw.
  assert.equal(calls.standing[0].cwd, calls.newSession[0].cwd, 'the standing brief must state the cwd the session actually has');
});

test('a worktree without an absolute dir fails the spawn instead of launching at an unknown cwd', () => {
  for (const dir of [undefined, '', 'w/cr-1', null]) {
    const { deps } = harness({ ensureWorktree: () => ({ dir, branch: 'soma/cr-1', base_sha: 'sha' }) });
    assert.throws(() => s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps),
      /no absolute worktree directory/, `dir ${JSON.stringify(dir)} must be refused`);
  }
});

test('newSession gets the argv, the scrubbed env and the lead transcript path', () => {
  const { deps, calls } = harness();
  const r = s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps);
  const spec = calls.newSession[0];
  assert.equal(spec.name, 'lead-cr-1');
  assert.equal(spec.logPath, logPath('cr-1'));
  assert.equal(argAfter(spec.argv, '--settings'), join(leadDir('cr-1'), 'settings.launch.json'));
  assert.equal(argAfter(spec.argv, '--mcp-config'), '/m.json');
  assert.equal(argAfter(spec.argv, '--append-system-prompt-file'), '/std.md');
  assert.equal(spec.argv[spec.argv.length - 1], 'do x');
  assert.equal(spec.env.SOMA_LEAD_NAME, 'cr-1');
  assert.equal(spec.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(r.tmux_target, spec.name);
  // remain-on-exit is set at window scope on the session tmux just made. Aimed anywhere else
  // it silently succeeds and the pane vanishes on death, so the watchdog's capturePane finds
  // no death scene and every dead lead reads as "gone, cause unknown".
  assert.deepEqual(calls.remain, [spec.name], 'the preserved window must be the one the lead runs in');
});

/**
 * The half of the row-uuid fix that lives here: the uuid the fleet row records has to be the uuid
 * the transcript is named after, or `readUsage` finds nothing and the lead runs uncapped.
 */
test('the returned session_uuid is the one argv pins, and the one the gate discriminates on', () => {
  const { deps, calls } = harness({ uuid: () => 'deadbeef-0000-4000-8000-000000000000' });
  const r = s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps);
  const spec = calls.newSession[0];
  assert.equal(r.session_uuid, 'deadbeef-0000-4000-8000-000000000000');
  assert.equal(argAfter(spec.argv, '--session-id'), r.session_uuid,
    'a mismatch here is a transcript nobody can find, i.e. a lead with no token cap at all');
  assert.equal(spec.env.SOMA_LEAD_SESSION_UUID, r.session_uuid);
});

/**
 * `preTrust` must be told the environment the LEAD will run under, and the
 * path it answers with has to be the file that lead will read — otherwise the mark lands
 * in one `.claude.json` while the lead blocks on the trust dialog reading another.
 */
test('preTrust is handed the lead cwd and the lead env, and its answer is checked', () => {
  const { deps, calls } = harness();
  s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps);
  const [cwd, home, env] = calls.preTrust[0];
  assert.equal(cwd, '/w/cr-1', 'the mark is per-directory; the lead cwd is the only key claude looks up');
  assert.equal(home, '/Users/op', 'the lead HOME decides the default location of .claude.json');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/Users/op/.claude-work', 'the env that survives env -i is what decides which file claude reads');
  assert.equal(env.SOMA_LEAD_NAME, 'cr-1', 'the lead env itself, not the spawner\'s');
});

test('a trust mark written where the lead will not look fails the spawn instead of hanging it', () => {
  const { deps } = harness({ preTrust: () => '/Users/op/.claude/.claude.json' });
  assert.throws(
    () => s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps),
    /marked trust in .* but the lead will read/,
    'the wrong-file case is exactly the measured detached-pane hang, and it is otherwise silent',
  );
});

test('with no CLAUDE_CONFIG_DIR the expected trust file sits BESIDE the config dir, not inside it', () => {
  const env = { HOME: '/Users/op', PATH: '/usr/bin' };
  const { deps } = harness({ env, preTrust: () => '/Users/op/.claude.json' });
  assert.doesNotThrow(() => s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps),
    '$HOME/.claude.json is the default location; joining onto the config root would demand $HOME/.claude/.claude.json, which exists nowhere');
  const { deps: bad } = harness({ env, preTrust: () => '/Users/op/.claude/.claude.json' });
  assert.throws(() => s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, bad), /but the lead will read/);
});

/** A second spawnLead for one id is reachable by design. */
test('an existing tmux session refuses the spawn before anything is created', () => {
  const { deps, order, calls } = harness({ hasSession: (n) => { calls.hasSession.push(n); return true; } });
  assert.throws(
    () => s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps),
    /already has a live tmux session/,
    'without this, a spawnLead that threw after partial success re-queues the row and a second admitter double-spawns it',
  );
  assert.deepEqual(calls.hasSession, ['lead-cr-1']);
  assert.deepEqual(order, [], 'nothing may be created on the refusal path — no worktree, no trust mark, no session');
});

/**
 * The window between the pre-lock check and the launch is real: two admitters can both see
 * no session, and only the lock orders them. Re-checking under it turns that race into this
 * message instead of tmux's bare "duplicate session".
 */
test('a session that appears while waiting for the repo lock is refused under it', () => {
  let seen = 0;
  // False to the caller outside the lock, true once inside it — i.e. the other spawner won.
  const { deps, order } = harness({ hasSession: () => (seen++ > 0) });
  assert.throws(() => s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps), /already has a live tmux session/);
  assert.equal(seen, 2, 'the check must run again after the lock is held, not only before it');
  assert.deepEqual(order, ['lock', 'unlock'], 'the lock is taken and released, and nothing inside it is created');
});

test('the transcript directory exists before tmux is told to pipe into it', () => {
  const { deps, calls } = harness();
  s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps);
  // pipe-pane's `cat >> <logs>/cr-1.log` fails in the shell while tmux still exits 0, so a
  // missing directory is a lead running with no transcript and nothing saying so.
  assert.ok(existsSync(dirname(calls.newSession[0].logPath)),
    'the spawner is the only step that can guarantee logs/ exists by the time pipe-pane runs');
});

/** Both of these are new, loud failure modes and neither may be swallowed. */
test('ensureWorktree and preTrust failures propagate rather than becoming a half-spawn', () => {
  const stillRegistered = new Error('ensureWorktree(cr-1): /w/cr-1 is still registered in /repo');
  const { deps: a, calls: ca } = harness({ ensureWorktree: () => { throw stillRegistered; } });
  assert.throws(() => s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, a), /still registered/);
  assert.deepEqual(ca.newSession, [], 'no lead may start in a worktree that was never made');

  const drift = new Error('preTrust: a concurrent writer keeps dropping projects[/w/cr-1]');
  const { deps: b, calls: cb } = harness({ preTrust: () => { throw drift; } });
  assert.throws(() => s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, b), /concurrent writer keeps dropping/);
  assert.deepEqual(cb.newSession, [], 'an untrusted cwd is a detached lead hanging on a dialog; refuse instead');
});

test('preTrust runs once per spawn, immediately before that spawn, never batched', () => {
  const { deps, order } = harness();
  s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps);
  s.spawnLead({ id: 'cr-2', repo: 'r', brief: 'do y' }, deps);
  const trust = order.reduce((n, o) => n + (o === 'pretrust' ? 1 : 0), 0);
  assert.equal(trust, 2, 'the file is last-writer-wins against claude\'s own rewrites, so one mark cannot cover two spawns');
  assert.deepEqual(order, [...FULL_ORDER, ...FULL_ORDER], 'each spawn re-marks between its own worktree and its own tmux start');
});

test('the worktree guard file is written before the lead starts, denying this machine\'s own MCP servers', () => {
  const { deps, calls } = harness({ enumerateUserMcpServers: () => ['kite', 'mcp_server_mysql'] });
  s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps);
  const [dir, opts] = calls.guardrails[0];
  assert.equal(dir, '/w/cr-1');
  assert.deepEqual(opts.mcpDenies, ['kite', 'mcp_server_mysql'],
    'an explicit [] makes settings-gen refuse; a wrong list writes a file that reads as guarded and denies nothing');
  assert.deepEqual(opts.teammateAllow, [], 'the operator\'s exemptions, from soma.json');
});

test('the base branch is the task\'s, then the repo\'s, then develop', () => {
  const seen = [];
  const mk = (over) => harness({ ensureWorktree: (a) => { seen.push(a); return { dir: '/w/cr-1', branch: 'b', base_sha: 's' }; }, ...over });
  s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'b', base_branch: 'release/9' }, mk().deps);
  s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'b' }, mk().deps);
  s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'b' }, mk({ loadConfig: () => ({ ...CFG, repos: { r: { path: '/repo' } } }) }).deps);
  assert.deepEqual(seen.map((a) => a.base), ['release/9', 'develop', 'develop']);
  assert.deepEqual(seen.map((a) => a.repoPath), ['/repo', '/repo', '/repo']);
  assert.deepEqual(seen.map((a) => a.taskId), ['cr-1', 'cr-1', 'cr-1']);
});

test('a repo missing from soma.json is refused by name, before any git runs', () => {
  const { deps, order } = harness({ loadConfig: () => ({ ...CFG, repos: {} }) });
  assert.throws(() => s.spawnLead({ id: 'cr-1', repo: 'nope', brief: 'b' }, deps), /is not configured in soma\.json/);
  assert.deepEqual(order, [], 'nothing, including the repo lock, is taken for a repo that does not exist');
});

/**
 * The cwd is built from the repo key by `paths.worktreeDir`, and `resumeLead` never goes
 * near `ensureWorktree` — which is where the only other check on it lives. A row carrying
 * `repo: '../../..'` would resume a permission-bypassed session outside `$SOMA_HOME`.
 */
test('a repo key that could climb out of the state root is refused by both entry points', () => {
  // The message must be the SHAPE refusal, not "is not configured in soma.json" — that
  // sibling guard also fires for an unknown key, so a regex matching either would pass with
  // the shape check deleted. Measured: it did.
  const cases = [
    [undefined, /repo must be a non-empty string/],
    ['', /repo must be a non-empty string/],
    ['../../etc', /is not a usable path component/],
    ['a/../../b', /is not a usable path component/],
    ['-x', /is not a usable path component/],
    ['./x', /is not a usable path component/],
  ];
  for (const [repo, why] of cases) {
    const { deps: a, order: oa } = harness();
    assert.throws(() => s.spawnLead({ id: 'cr-1', repo, brief: 'b' }, a), why, `spawnLead ${JSON.stringify(repo)}`);
    assert.deepEqual(oa, [], 'nothing may be created for a repo key that is not a path component');
    const { deps: b, order: ob } = harness();
    assert.throws(() => s.resumeLead({ ...RESUMABLE, repo }, b), why, `resumeLead ${JSON.stringify(repo)}`);
    assert.deepEqual(ob, []);
  }
});

test('spawnLead forwards the configured teammate_effort rather than assuming inherit', () => {
  const { deps, calls } = harness({ loadConfig: () => ({ ...CFG, teammate_effort: 'high' }) });
  s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps);
  assert.ok(!('CLAUDE_CODE_EFFORT_LEVEL' in calls.newSession[0].env),
    'a spawner that hard-codes inherit makes soma.json teammate_effort dead config');
  assert.equal(argAfter(calls.newSession[0].argv, '--effort'), 'max', 'and the lead itself is still pinned');
});

test('a bad task id is refused before a worktree, a trust mark or a session exists', () => {
  for (const id of [undefined, '', 'cr 1', '../evil', 'CR-1']) {
    const { deps, order } = harness();
    assert.throws(() => s.spawnLead({ id, repo: 'r', brief: 'b' }, deps), /is not a usable lead id/, `${JSON.stringify(id)}`);
    assert.deepEqual(order, [], 'a refusal must come before the repo lock, not after a worktree');
  }
});

test('spawnLead refuses a partial dep set instead of silently reaching for the real tmux', () => {
  assert.throws(
    () => s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'b' }, { uuid: () => 'u1' }),
    /spawnLead: these dependencies are missing/,
    'a merge-with-defaults would hand a test the real tmux and the real git',
  );
});

test('the standing brief is composed for this task, and the task packet is not duplicated into it', () => {
  const { deps, calls } = harness();
  const task = { id: 'cr-1', repo: 'r', brief: 'do x', verify_hint: 'npm test' };
  s.spawnLead(task, deps);
  assert.equal(calls.standing[0].id, 'cr-1');
  assert.equal(calls.standing[0].base_branch, 'develop', 'the resolved base, not the absent field: the brief tells the lead what its worktree was cut from');
  assert.ok(!calls.standing[0].resume, 'a fresh spawn is not a resume');
});

// --- the teammate guard hook, registered outside the worktree ----------------
//
// The Critical this section exists for: `writeWorktreeGuardrails` registers the teammate
// PreToolUse hook INSIDE `<worktree>/.claude/settings.local.json`, i.e. inside the file the
// hook exists to defend. A bypassed teammate can empty that file (`tee`, `cp /dev/null`,
// `dd of=`, `install -m644` all measured as running), an emptied file fails OPEN, and claude
// re-reads it mid-session — so one uncovered write idiom removes the enforcement itself.
// These pins are on the SECOND registration, the one under the state root, which no state of
// the worktree file can reach.

test('--settings appears exactly once, because claude takes the LAST one and drops the rest', () => {
  const { deps, calls } = harness();
  s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps);
  // Observed on Claude Code 2.1.220: the settings loader keeps only the last `--settings`
  // value, so a second flag does not merge with the first — it REPLACES it, silently.
  // Registering the guard as an extra flag would drop the lead's own settings file (model
  // pin, heartbeat, Stop hook) with nothing to say so, which is why the guard is merged into
  // one file instead.
  assert.equal(countOf(calls.newSession[0].argv, '--settings'), 1,
    'two --settings flags are not merged; the earlier one is discarded');
});

test('the --settings file lives under the state root, never inside the worktree it defends', () => {
  const { deps, calls } = harness();
  const r = s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps);
  const fp = argAfter(calls.newSession[0].argv, '--settings');
  assert.equal(fp, join(leadDir('cr-1'), 'settings.launch.json'));
  assert.ok(fp.startsWith(`${SOMA_HOME()}/`), 'the whole point is that it is not reachable from the worktree');
  assert.ok(!fp.startsWith(`${r.cwd}/`), 'a registration inside the lead cwd is the defect, not the fix');
});

test('the launch settings register the teammate gate hook on every tool', () => {
  const { deps, calls } = harness();
  s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps);
  const entries = launchSettingsOf(calls.newSession[0]).hooks.PreToolUse;
  // The retired --session-guard switch must not come back on ANY registration.
  for (const e of entries) for (const h of e.hooks ?? []) assert.ok(!h.command.includes('--session-guard'), h.command);
  // `withTeammateGuard` APPENDS when the base lacks the current guard, so the twin is the LAST
  // entry — and it is always appended here, because this fixture's own gate entry carries a fake
  // install path and never deep-equals the guard. Pinned by deep equality against the real guard:
  // the old `guard.length >= 1` + path regex did not flip even with the append deleted outright
  // (measured 2026-09-07), because the fixture's fake-path entry satisfied the regex on its own.
  const twin = entries.at(-1);
  assert.deepEqual(twin, s.withTeammateGuard({}).hooks.PreToolUse[0],
    'the appended teammate-guard registration is gone — the last entry is not the current guard');
  assert.equal(twin.matcher, '*',
    'a narrowed matcher stops the gate being ASKED — and the breaker is an every-tool rule');
  const [hook] = twin.hooks;
  assert.equal(hook.type, 'command');
  // Absolute and inside the install: a cwd-relative hook command is resolved against the
  // session's own cwd, and a teammate's cwd is not the spawner's.
  assert.match(hook.command, /^node '\/.*\/bin\/hooks\/lead-gate\.mjs'$/,
    'single-quoted so an install path containing a space is one word to /bin/sh');
});

test('the launch settings ADD the guard rather than displacing any lead pin', () => {
  const { deps, calls } = harness();
  s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps);
  const launch = launchSettingsOf(calls.newSession[0]);
  assert.equal(launch.model, 'opus', 'the model pin is the lead settings file\'s, and must survive the merge');
  // ⚠ NOT "the lead's no-code property", which is what this message used to claim. The
  // launch file is the value of `--settings`, and `--settings` is inherited by every
  // split-pane teammate (measured, claude 2.1.220 — see the `writeLaunchSettings` header).
  // So whatever `permissions` lands here binds the WHOLE FLEET. This assertion pins the
  // composition — an arbitrary key survives the merge verbatim — against a FIXTURE that
  // still carries one; the real generator now writes none, and that is asserted in
  // `test/settings-gen.test.mjs`, not inferred from here.
  assert.deepEqual(launch.permissions, LEAD_SETTINGS.permissions,
    'a permissions block in the lead settings file survives the merge verbatim — and therefore reaches every teammate, which is why the generator writes none');
  assert.deepEqual(launch.hooks.PostToolUse, LEAD_SETTINGS.hooks.PostToolUse, 'the heartbeat is what the stall detector reads');
  assert.deepEqual(launch.hooks.Stop, LEAD_SETTINGS.hooks.Stop, 'the Stop hook is the turn-end event AND the harness gate');
  // The lead's own PreToolUse entry is the one that must survive an ARRAY merge rather than
  // an assignment: overwriting hooks.PreToolUse would delete the lead's gate and the
  // BUDGET_TRIPPED breaker with it, while still passing every "the guard is registered" test.
  //
  // These two lines pin that there are TWO entries and which one is `[0]`. They say nothing
  // about **what each entry denies**, and the difference is the whole of the two-registration
  // defect: two registrations are "defence in depth for free" only while
  // `deny(reg[0]) ⊆ deny(reg[1])` for every input, and a mutation that makes `[0]` *stricter*
  // than `[1]` leaves both assertions below green while a deny from the stricter-and-wrong entry
  // wedges the session. That subset relation is asserted in `test/hooks.test.mjs` → *"the
  // write-idiom arm discriminates by session id under BOTH registrations"*; it is the only test
  // that can see it, and it is not this one.
  assert.deepEqual(launch.hooks.PreToolUse[0], LEAD_SETTINGS.hooks.PreToolUse[0],
    'the lead\'s own gate entry must still be there, first');
  // Append-when-different: this fixture's gate entry carries the fake path `/i/bin/…`, so it is
  // NOT the current guard and the twin is appended alongside it — two entries. Against the REAL
  // generator the base already carries the guard and the launch file composes to ONE entry; that
  // is pinned below ("AGAINST THE REAL GENERATOR: the launch file registers the gate exactly once").
  assert.equal(launch.hooks.PreToolUse.length, 2,
    'append-when-different: the fixture gate is not the current guard, so the twin joins it');
});

/**
 * The composition survives a lead settings file with no `permissions` block — AND the lead is
 * no longer edit-banned on argv.
 *
 * The settings-file deny was removed long ago because `--settings` reaches every split-pane
 * teammate; the lead's own ban then rode `--disallowedTools` on argv, which teammates do NOT
 * inherit. That lead-only ban has now been LIFTED — a lead's Edit/Write/NotebookEdit surface
 * matches its teammates' — so this test pins the two things that must still hold: a lead
 * settings file carrying no `permissions` still composes and launches, and the argv it
 * produces carries NO `--disallowedTools`.
 *
 * The settings file here is a STUB with the key removed by hand, so a failure is attributable
 * to the spawner rather than to what `settings-gen` happens to emit today.
 */
test('a lead settings file with no permissions key composes, and argv carries no edit ban', () => {
  const { deps, calls } = harness({
    writeLeadSettings: (id) => writeFakeLeadSettings(id, { model: 'fable', hooks: LEAD_SETTINGS.hooks }),
  });
  s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps);
  const spec = calls.newSession[0];
  // The composition survives a settings file with no `permissions` — `withTeammateGuard`
  // spreads rather than requiring the key, so removing the deny cannot break the launch.
  const launch = launchSettingsOf(spec);
  assert.equal(launch.model, 'fable', 'the model pin still lands with no permissions key present');
  assert.equal(launch.permissions, undefined, 'nothing invents a permissions block that was not there');
  assert.equal(launch.hooks.PreToolUse.length, 2,
    'append-when-different: the fixture gate (fake path) is not the current guard, so the teammate guard is still composed on beside it');
  // And no edit ban on argv: the lead-only ban is lifted, so a lead's Edit/Write/NotebookEdit
  // surface now matches its teammates'.
  assert.equal(spec.argv.indexOf('--disallowedTools'), -1,
    'buildLeadArgv must not re-impose the lifted edit ban via --disallowedTools');
});

/**
 * AGAINST THE REAL GENERATOR: nobody is edit-banned — the lead's surface matches a teammate's.
 *
 * The old defect was a `permissions.deny` in the lead's settings file, which every split-pane
 * teammate inherits through `--settings` — a fleet that ran perfectly and committed nothing.
 * That deny was removed; the lead then carried its own ban on `--disallowedTools` and in the
 * session-guard hook's `isLead` arm. Both of those have now been LIFTED, so this test pins the
 * end state across all three tool names and both carriers:
 *
 *   - the fleet-wide `--settings` file carries no bare `Edit`/`Write`/`NotebookEdit` deny;
 *   - the argv carries no `--disallowedTools`;
 *   - the session-guard hook allows the edit tools for BOTH a teammate AND the lead.
 *
 * It still reaches into `hooks/lead-gate.mjs` from the spawner's suite because the hook is the
 * carrier the lead's edit surface used to depend on. Arm (b) and its `--session-guard` switch
 * are gone outright; these calls pin the end state — the gate takes no view on an edit tool
 * for either role, under any registration.
 */
test('the real generator edit-bans no one: lead and teammate both keep the edit tools', async () => {
  const { writeLeadSettings } = await import('../bin/lib/settings-gen.mjs');
  const { evaluateGate } = await import('../bin/hooks/lead-gate.mjs');

  // What `--settings` will actually point at: the real lead settings file plus the guard.
  // A teammate loads this whole object, so a `deny` anywhere in it is a teammate with no hands.
  const launch = s.withTeammateGuard(JSON.parse(readFileSync(writeLeadSettings('cr-ban'), 'utf8')));
  const launchDeny = launch.permissions?.deny ?? [];
  const argv = s.buildLeadArgv({ id: 'cr-ban', sessionUuid: 'LEAD', brief: 'b',
    settingsPath: '/s.json', mcpPath: '/m.json', standingPath: '/std.md' });

  // The lead-only edit ban is lifted, so argv carries no --disallowedTools at all.
  assert.equal(argv.indexOf('--disallowedTools'), -1,
    'buildLeadArgv still emits --disallowedTools — the lead-only edit ban was supposed to be lifted');

  for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
    // A teammate keeps this tool: nothing in the fleet-wide file takes it away…
    assert.equal(launchDeny.includes(tool), false,
      `the --settings file denies ${tool}; every split-pane teammate inherits that file, so the fleet cannot write code`);
    // …and the hook, which every teammate DOES run from cwd, allows it for a non-lead session.
    assert.notEqual(evaluateGate({ tool_name: tool, session_id: 'TEAMMATE', tool_input: {} },
      { SOMA_LEAD_SESSION_UUID: 'LEAD' }, () => false).permissionDecision, 'deny',
      `the gate denies ${tool} to a TEAMMATE — teammates are a lead's only hands`);
    // …and the LEAD now keeps it too — its edit surface matches a teammate's.
    assert.notEqual(evaluateGate({ tool_name: tool, session_id: 'LEAD', tool_input: {} },
      { SOMA_LEAD_SESSION_UUID: 'LEAD' }, () => false).permissionDecision, 'deny',
      `the gate still denies ${tool} to the LEAD — the edit ban was supposed to be lifted`);
  }
});

test('the launch settings file is on disk and parses before tmux is told to start', () => {
  let onDisk = null;
  const { deps } = harness({
    newSession: (spec) => {
      const fp = argAfter(spec.argv, '--settings');
      onDisk = existsSync(fp) ? readFileSync(fp, 'utf8') : null;
    },
  });
  s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps);
  // claude reads --settings at start-up, so a file published after the session is created is
  // a lead running with no guard registration at all and nothing saying so.
  assert.notEqual(onDisk, null, 'the file must exist by the time tmux launches claude');
  assert.doesNotThrow(() => JSON.parse(onDisk), 'a half-written settings file is a lead with no pins');
});

test('the worktree registration is kept as well, so both copies fire', () => {
  const { deps, calls } = harness();
  s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps);
  // Hooks MERGE — a worktree-local file can only ADD, never remove a higher-scope one
  // (measured against five shapes of the local file including zero bytes). So keeping the
  // in-worktree registration costs nothing and still fires in the normal case; the external
  // one is the copy that survives erasure.
  assert.equal(calls.guardrails.length, 1, 'removing the in-worktree registration would drop the deny rules with it');
  assert.equal(calls.guardrails[0][0], '/w/cr-1');
});

/**
 * The two registrations must be BYTE-IDENTICAL, and that is a cost pin rather than a
 * correctness one — which is why it needs stating, because the cost is invisible.
 *
 * Measured live against a real split-pane teammate with the same hook registered in both the
 * external `--settings` file and the worktree file: when the two command strings differ,
 * **both fire** (each recorded the same tool call, and both denied it — cleanly, one refusal,
 * no double prompt). When they are identical, the hook runs **once** — measured 2026-09-07 on
 * claude 2.1.263 (`-p` mode, 13/13 runs, claude-side `hook_started` events and a hook-side
 * counter file agreeing in every run): the dedupe key is the command STRING, and identical
 * commands collapsed to one run across two entries in one file, across matchers `Bash` + `*`,
 * and across `--settings` + the cwd `.claude/settings.local.json`, while two DISTINCT commands
 * in one file ran twice (the control that shows the second registration loads at all). So
 * keeping the in-worktree registration is free only while the strings match; one
 * character of drift silently doubles every teammate's per-tool-call hook cost, and a node
 * spawn is ~20-26 ms measured on this machine, paid on every tool call by every teammate.
 *
 * If this test reds, nothing is broken — the two generators drifted and the fleet just got
 * slower. Re-sync them; do not delete the pin.
 */
test('the external guard is byte-identical to the in-worktree one, so claude runs one hook', (t) => {
  mkdirSync(SOMA_HOME(), { recursive: true });
  const dir = mkdtempSync(join(SOMA_HOME(), 'guardpin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Options passed explicitly so nothing reads soma.json or this machine's real MCP servers.
  const fp = writeWorktreeGuardrails(dir, { mcpDenies: ['probe'], teammateAllow: [], home: join(dir, 'nohome'), env: {} });
  const inWorktree = JSON.parse(readFileSync(fp, 'utf8')).hooks.PreToolUse;
  const external = s.withTeammateGuard({}).hooks.PreToolUse;
  assert.equal(inWorktree.length, 1, 'settings-gen still writes exactly one PreToolUse entry');
  assert.deepEqual(external[0], inWorktree[0],
    'the same hook, same matcher, same command string — claude dedupes by command string (measured 2026-09-07, 2.1.263), so this is what makes the second registration free');
});

test('a lead settings file that cannot be read or parsed fails the spawn loudly', () => {
  // Fail-open here means a lead launched with a settings file that has the guard hook and
  // none of the pins, or with no settings at all — both look exactly like a healthy lead.
  // Each regex names the file or the field, so no SIBLING refusal can satisfy it — the two
  // object checks (`writeLaunchSettings`'s, which names the path, and `withTeammateGuard`'s,
  // which names the argument) would otherwise both match a bare /must contain a JSON object/,
  // and deleting either would still pass.
  const cases = [
    ['/nowhere/s.json', /\bspawnLead\(cr-1\): could not read the lead settings file \/nowhere\/s\.json/],
    [() => writeFakeLeadSettings('cr-1', '{ not json'), /settings\.json is not valid JSON/],
    [() => writeFakeLeadSettings('cr-1', '[]'), /settings\.json must contain a JSON object, got array/],
    [() => writeFakeLeadSettings('cr-1', 'null'), /settings\.json must contain a JSON object, got null/],
    [() => writeFakeLeadSettings('cr-1', JSON.stringify({ hooks: [] })), /settings\.hooks must be a JSON object, got array/],
    [() => writeFakeLeadSettings('cr-1', JSON.stringify({ hooks: { PreToolUse: 'x' } })), /settings\.hooks\.PreToolUse must be an array/],
  ];
  for (const [make, why] of cases) {
    const { deps, calls } = harness({ writeLeadSettings: typeof make === 'function' ? make : () => make });
    assert.throws(() => s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps), why, `${String(make).slice(0, 60)}`);
    assert.deepEqual(calls.newSession, [], 'no lead may start with a settings file the spawner could not compose');
  }
});

test('a lead settings file with no hooks at all still gets the guard', () => {
  const { deps, calls } = harness({ writeLeadSettings: (id) => writeFakeLeadSettings(id, { model: 'fable' }) });
  s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps);
  const launch = launchSettingsOf(calls.newSession[0]);
  assert.equal(launch.model, 'fable');
  assert.equal(launch.hooks.PreToolUse.length, 1, 'an absent hooks block is a file to add to, not a reason to refuse');
});

/**
 * `withTeammateGuard` is exported so the merge can be pinned without a spawn, and because a
 * reviewer reading `buildLeadArgv` should be able to find the one function that decides what
 * every session in this lead's fleet loads.
 */
/**
 * The exported function's OWN guard, and it is a separate test because the only caller
 * inside this module refuses a non-object first — so a mutation that deletes this guard is
 * invisible through `spawnLead`. Measured: it survived the whole suite until this existed.
 * A settings file that is an array or a string is one claude loads and silently ignores,
 * which is a lead and a fleet running with no hook and no pins at all.
 */
test('withTeammateGuard refuses anything that is not a settings object', () => {
  for (const junk of [undefined, null, [], 'x', 7, true]) {
    assert.throws(() => s.withTeammateGuard(junk), /withTeammateGuard: settings must be a JSON object/,
      `${JSON.stringify(junk) ?? 'undefined'} must be refused rather than composed onto`);
  }
});

test('withTeammateGuard never mutates its input and never drops a foreign event', () => {
  const input = { model: 'fable', hooks: { SessionStart: [{ matcher: '', hooks: [] }] } };
  const frozen = JSON.stringify(input);
  const out = s.withTeammateGuard(input);
  assert.equal(JSON.stringify(input), frozen, 'the caller\'s object is settings-gen\'s output, read elsewhere');
  assert.deepEqual(out.hooks.SessionStart, input.hooks.SessionStart, 'an event this module knows nothing about must survive');
  assert.equal(out.hooks.PreToolUse.length, 1);
});

// --- the twin is appended only when the base lacks the current guard ------------
//
// `withTeammateGuard` used to append the twin UNCONDITIONALLY. The base `writeLeadSettings`
// publishes already carries the byte-identical entry, so every launch file registered the gate
// twice. Measured 2026-09-07 (claude 2.1.263, 13/13 runs, claude-side hook events and a
// hook-side counter agreeing in every run): claude dedupes hook executions by COMMAND STRING,
// so the twin cost zero extra gate runs — clutter, not a defect. The composition now appends
// only when no existing entry deep-equals the current guard.
//
// These pins need the REAL guard. The `LEAD_SETTINGS` fixture's gate carries a fake install
// path, so it never deep-equals the guard and every fixture-based test above composes to two
// entries with or without the dedupe (measured: the dedupe flipped zero of them).
//
// Three states, told apart by message: deduped (pass) · appended twice (fail, "registers the
// gate N times") · nothing appended at all (fail, "could not observe" — a `1` with the append
// deleted is indistinguishable from a dedupe unless the append onto an EMPTY base is pinned
// alongside, which `currentGuard()` does on every call).

/** The current guard entry, exactly as `withTeammateGuard` appends it onto an empty base. */
const currentGuard = () => {
  const entries = s.withTeammateGuard({}).hooks.PreToolUse;
  assert.equal(entries.length, 1,
    `could not observe: withTeammateGuard({}) yields ${entries.length} entries, not 1 — with the append gone, a "1" below would not mean "deduped"`);
  return entries[0];
};

test('AGAINST THE REAL GENERATOR: the launch file registers the gate exactly once', async () => {
  const { writeLeadSettings } = await import('../bin/lib/settings-gen.mjs');
  const guard = currentGuard();
  const { deps, calls } = harness({ writeLeadSettings });
  s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps);
  // Precondition, so a `1` below means "deduped" and not "the base carries no gate any more":
  // the base the real generator published has exactly one gate entry, and it IS the guard.
  const base = JSON.parse(readFileSync(join(leadDir('cr-1'), 'settings.json'), 'utf8')).hooks.PreToolUse;
  assert.deepEqual(base, [guard],
    'could not observe dedupe: the real base no longer carries exactly the current guard — the two generators drifted (test/settings-gen.test.mjs owns what the generator writes; re-sync them, then this pin means something again)');
  const launch = launchSettingsOf(calls.newSession[0]).hooks.PreToolUse;
  assert.equal(launch.length, 1,
    `the launch file registers the gate ${launch.length} times — the base already carries the current guard, so the twin must not be appended (before the fix: 2)`);
  assert.deepEqual(launch[0], guard, 'the one entry is the current guard, not something else that happens to be alone');
});

test('withTeammateGuard is idempotent: applying it twice registers the gate once', () => {
  const guard = currentGuard();
  const once = s.withTeammateGuard({ model: 'fable' });
  const twice = s.withTeammateGuard(once);
  assert.deepEqual(once.hooks.PreToolUse, [guard], 'one application onto a guard-less base appends exactly the guard');
  assert.equal(twice.hooks.PreToolUse.length, 1,
    `a second application appended again — ${twice.hooks.PreToolUse.length} entries where 1 is right (before the fix: 2 here, 3 onto the real base)`);
  assert.deepEqual(twice, once, 'and re-application changes nothing else about the settings');
});

test('a base carrying only the retired --session-guard twin gets the current guard appended after it', () => {
  const guard = currentGuard();
  const flagged = structuredClone(guard);
  flagged.hooks[0].command += ' --session-guard';
  assert.notDeepEqual(flagged, guard, 'fixture sanity: the flagged entry must differ from the guard, or this test measures nothing');
  const out = s.withTeammateGuard({ hooks: { PreToolUse: [flagged] } }).hooks.PreToolUse;
  assert.deepEqual(out, [flagged, guard],
    'append-when-different: a stale gate entry is not the current guard, so the guard is appended after it. Pre-08-06 leads carry that flagged twin until launch() rewrites their files; the gate ignores argv it does not know, so the stale entry keeps working meanwhile');
});

test('deep equality, not the command string, is the dedupe key: a narrowed-matcher twin does not suppress the guard', () => {
  const guard = currentGuard();
  const narrowed = { ...guard, matcher: 'Bash' };
  assert.equal(narrowed.hooks[0].command, guard.hooks[0].command, 'fixture sanity: same command string, different matcher');
  const out = s.withTeammateGuard({ hooks: { PreToolUse: [narrowed] } }).hooks.PreToolUse;
  assert.deepEqual(out, [narrowed, guard],
    'a same-command entry under matcher Bash is NOT the guard. Claude itself dedupes by command string regardless of matcher (measured), so mirroring that key here would let the narrowed entry stand alone and the BUDGET_TRIPPED breaker would stop being consulted for Read and Task — the round-3 hole settings-gen documents. Deep equality appends the * twin, and claude still runs one hook for Bash');
});

// --- resumeLead --------------------------------------------------------------

const RESUMABLE = Object.freeze({ id: 'cr-1', repo: 'r', brief: 'do x', lead_session_uuid: 'u-old' });

test('resumeLead re-attaches the recorded session in the task\'s existing worktree', () => {
  const { deps, calls } = harness();
  const r = s.resumeLead(RESUMABLE, deps);
  const spec = calls.newSession[0];
  assert.equal(r.session_uuid, 'u-old');
  assert.equal(argAfter(spec.argv, '--resume'), 'u-old');
  assert.equal(countOf(spec.argv, '--session-id'), 0);
  assert.equal(spec.cwd, worktreeDir('r', 'cr-1'), 'the worktree dir keeps the raw repo key and never gains a retry suffix');
  assert.equal(spec.name, 'lead-cr-1');
  assert.equal(spec.logPath, logPath('cr-1'));
  assert.match(spec.argv[spec.argv.length - 1], /soma_task\(\)/, 'the resume prompt has to re-orient a session that lost its team');
});

test('a resumed lead still carries the uuid its session guard is compared against', () => {
  const { deps, calls } = harness();
  s.resumeLead(RESUMABLE, deps);
  assert.equal(calls.newSession[0].env.SOMA_LEAD_SESSION_UUID, 'u-old',
    'a resume that dropped this leaves every shell write-idiom deny inert for the rest of the run');
  assert.equal(calls.newSession[0].env.CLAUDE_CODE_EFFORT_LEVEL, 'max');
  assert.equal(calls.newSession[0].env.ANTHROPIC_API_KEY, undefined);
});

/**
 * The guard file is re-read mid-session (measured), and a bypassed teammate emptied its
 * own with `tee`. A resume into a reused worktree is exactly the case where the file on
 * disk may already have been gutted, and where a server the operator added yesterday is
 * not yet denied.
 */
test('a resume rewrites the worktree guard file and re-marks trust', () => {
  const { deps, order, calls } = harness();
  s.resumeLead(RESUMABLE, deps);
  // `at` refuses an absent step, so neither of these can pass by comparing against -1.
  assert.ok(at(order, 'guardrails') < at(order, 'tmux'),
    'an emptied guard file fails OPEN to the operator\'s personal MCP servers, and claude reads the file at start');
  assert.ok(at(order, 'pretrust') < at(order, 'tmux'), 'preTrust runs before EACH spawn; a resume is a spawn');
  assert.equal(calls.preTrust[0][0], worktreeDir('r', 'cr-1'));
  assert.equal(calls.guardrails[0][0], worktreeDir('r', 'cr-1'));
});

/**
 * The refusal, not merely the call. The test above pins that a resume *runs* `preTrust`;
 * nothing pinned that a MISMATCH still fails the launch on this path — `if (marked !== expected
 * && !resume)` survived the whole suite. Same shape as the defect that motivated re-marking on
 * resume in the first place, one level down.
 *
 * And this is the path where it matters most: the mark is last-writer-wins against claude's own
 * rewrites of that file, so the mark made hours ago for the first spawn may simply not be there
 * any more. A resumed lead whose mark landed in the wrong `.claude.json` stops on `Quick safety
 * check …` in a detached pane with nobody to answer, until the watchdog gives up on it — which
 * is the measured failure, on the path a long fleet takes most often.
 */
test('a resume whose trust mark lands where the lead will not look is refused too', () => {
  const { deps, calls } = harness({ preTrust: () => '/Users/op/.claude/.claude.json' });
  assert.throws(
    () => s.resumeLead(RESUMABLE, deps),
    /marked trust in .* but the lead will read/,
    'a resume is a spawn: the mark it cannot see hangs it exactly as it would a fresh one',
  );
  assert.deepEqual(calls.newSession, [], 'no resumed lead may start against a mark that is invisible to it');
});

test('a composition failure on the resume path names resumeLead, not spawnLead', () => {
  const { deps, calls } = harness({ writeLeadSettings: () => '/nowhere/s.json' });
  // The module's own rule: an operator reading "spawnLead(cr-1)" after asking for a resume
  // goes looking in the wrong place. `refuseLive` takes the caller's name for this reason.
  assert.throws(() => s.resumeLead(RESUMABLE, deps), /\bresumeLead\(cr-1\): could not read the lead settings file/);
  assert.deepEqual(calls.newSession, []);
});

test('a resume gets the same external guard registration a fresh spawn does', () => {
  const { deps, calls } = harness();
  s.resumeLead(RESUMABLE, deps);
  const spec = calls.newSession[0];
  assert.equal(countOf(spec.argv, '--settings'), 1);
  assert.equal(argAfter(spec.argv, '--settings'), join(leadDir('cr-1'), 'settings.launch.json'));
  // A resume is the path most likely to be entering a worktree whose guard file was already
  // gutted, so it is the last path that may skip the registration that survives that.
  const entries = launchSettingsOf(spec).hooks.PreToolUse;
  assert.ok(entries.some((e) => e.hooks?.some((h) => /'\/.*\/bin\/hooks\/lead-gate\.mjs'$/.test(h.command))),
    'the appended gate registration must survive a resume');
  for (const e of entries) for (const h of e.hooks ?? []) assert.ok(!h.command.includes('--session-guard'), h.command);
});

test('resumeLead tells writeStanding it is a resume, so the re-orient rules are appended', () => {
  const { deps, calls } = harness();
  s.resumeLead(RESUMABLE, deps);
  assert.equal(calls.standing[0].resume, true);
  assert.equal(calls.standing[0].id, 'cr-1');
  // A resume launches in the recorded worktree, and the brief states that same directory.
  assert.equal(calls.standing[0].cwd, calls.newSession[0].cwd, 'a resumed lead must be told the cwd it was resumed in');
  assert.equal(calls.standing[0].cwd, worktreeDir('r', 'cr-1'));
});

test('a resume with no recorded session uuid is refused, not turned into a fresh spawn', () => {
  const { deps, order } = harness();
  assert.throws(() => s.resumeLead({ id: 'cr-1', repo: 'r', brief: 'b' }, deps),
    /has no recorded lead_session_uuid/,
    'resuming nothing would start a second lead on the same task under the same name');
  assert.deepEqual(order, []);
});

test('resumeLead refuses a live session and never creates a worktree of its own', () => {
  const { deps, order } = harness({ hasSession: () => true });
  assert.throws(() => s.resumeLead(RESUMABLE, deps), /already has a live tmux session/);
  assert.deepEqual(order, []);

  const { deps: ok, order: o2 } = harness();
  s.resumeLead(RESUMABLE, ok);
  assert.equal(o2.indexOf('worktree'), -1, 'ensureWorktree could cut a new branch and orphan the work being resumed');
});

test('resumeLead also runs inside the per-repo lock', () => {
  const { deps, order, calls } = harness();
  s.resumeLead(RESUMABLE, deps);
  assert.equal(order[0], 'lock');
  assert.equal(order[order.length - 1], 'unlock');
  assert.deepEqual(calls.lock, ['r']);
});

test('resumeLead refuses a partial dep set for the same reason spawnLead does', () => {
  assert.throws(() => s.resumeLead(RESUMABLE, { uuid: () => 'u' }), /resumeLead: these dependencies are missing/);
});

// --- seats: every seat's config dir reaches the guard enumeration (account rotation §3.3/3.4) ---

/** An enumeration stub that records what the spawner handed it. */
const recording = (seen) => (home, env, opts) => { seen.push({ home, env, opts }); return ['kite']; };

test('spawnLead hands the enumeration every seat\'s config dir as roots', () => {
  const seen = [];
  const { deps } = harness({
    enumerateUserMcpServers: recording(seen),
    loadConfig: () => ({ ...CFG, seats: [{ config_dir: '/seats/a', label: 'seat-a' }, { config_dir: '/seats/b', label: 'seat-b' }] }),
  });
  s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps);
  assert.equal(seen.length, 1, 'could not observe: the enumeration did not run exactly once per launch');
  assert.deepEqual(seen[0].opts?.roots, ['/seats/a', '/seats/b'],
    'a seat missing here is a seat whose personal MCP servers reach every worktree undenied');
});

test('resumeLead hands the same roots — a resume is a spawn, and it rewrites the guard file', () => {
  const seen = [];
  const { deps } = harness({
    enumerateUserMcpServers: recording(seen),
    loadConfig: () => ({ ...CFG, seats: [{ config_dir: '/seats/b', label: 'seat-b' }] }),
  });
  s.resumeLead(RESUMABLE, deps);
  assert.deepEqual(seen[0]?.opts?.roots, ['/seats/b'],
    'the resume path is the one most likely to re-enter a worktree whose guard file was gutted');
});

test('a config with no seats yields roots: [] on both entry points — today\'s fixed pair, unchanged', () => {
  const seen = [];
  s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, harness({ enumerateUserMcpServers: recording(seen) }).deps);      // CFG has no `seats` key
  s.resumeLead(RESUMABLE, harness({ enumerateUserMcpServers: recording(seen), loadConfig: () => undefined }).deps);         // resumeLead's `cfg ?? {}` path
  assert.deepEqual(seen.map((c) => c.opts?.roots), [[], []],
    'an absent seats key is DEFAULTS\' [] — not a throw, and not an undefined that settings-gen would have to guess at');
});

test('the fixed pair the enumeration reads is the SPAWNER\'s environment — the one whose root a teammate may inherit', () => {
  const seen = [];
  s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, harness({ enumerateUserMcpServers: recording(seen) }).deps);
  assert.equal(seen[0].home, '/Users/op', 'the spawner HOME, as preTrust already receives it');
  assert.deepEqual(seen[0].env, SPAWNER_ENV,
    'which root a teammate reads depends on whether CLAUDE_CONFIG_DIR survives ENV_ALLOW from exactly this environment, so this is the one to enumerate');
});

/**
 * THE SEAM, end to end through the real enumeration and the real writer: a server that exists
 * only in a third seat's `.claude.json` must land as a deny in the guard file the spawner
 * writes. Three states: `mcp__seat_c_only` present (pass) · absent (fail: the roots are not
 * threaded) · the precondition trips (could not observe: a fixed pair already knew the name,
 * so presence would prove nothing). `SPAWNER_ENV` points both fixed roots under `/Users/op`,
 * a home that exists on no machine this runs on, which is what makes the third seat the ONLY
 * source once the spawner enumerates from its own env.
 */
test('SEAM: a server registered only in a third seat\'s .claude.json is denied in the written worktree guard file', (t) => {
  // Hermetic against the OPERATOR's machine, in both directions the test could lie: the process
  // HOME and CLAUDE_CONFIG_DIR are pointed away for the duration, so neither the spawner's fixed
  // pair nor the writer's own fallback enumeration can find a real `~/.claude.json`. The server
  // is NOT named `kite` on purpose — `kite` is registered on the machine this ships on, and a
  // fixed pair that already knew the name would make the assertion pass with the roots deleted.
  const savedHome = process.env.HOME;
  const savedCfg = process.env.CLAUDE_CONFIG_DIR;
  const fakeHome = mkdtempSync(join(tmpdir(), 'home-'));
  const third = mkdtempSync(join(tmpdir(), 'seat-c-'));
  const wt = mkdtempSync(join(tmpdir(), 'wt-'));
  t.after(() => {
    process.env.HOME = savedHome;
    if (savedCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedCfg;
    for (const d of [fakeHome, third, wt]) rmSync(d, { recursive: true, force: true });
  });
  process.env.HOME = fakeHome;
  delete process.env.CLAUDE_CONFIG_DIR;
  writeFileSync(join(third, '.claude.json'), JSON.stringify({ mcpServers: { seat_c_only: {} } }));
  // The could-not-observe state, checked before the spawn: with no roots at all, neither the
  // spawner's pair nor the ambient pair knows the name — so presence below can only mean roots.
  assert.ok(!enumerateUserMcpServers(SPAWNER_ENV.HOME, SPAWNER_ENV).includes('seat_c_only')
    && !enumerateUserMcpServers().includes('seat_c_only'),
    'could not observe: a fixed pair already denies seat_c_only, so this test cannot tell roots from no roots');
  const { deps } = harness({
    ensureWorktree: () => ({ dir: wt, branch: 'soma/cr-1', base_sha: 'sha', reused: false, excluded: true }),
    writeWorktreeGuardrails,                 // the real writer, into a real throwaway worktree
    enumerateUserMcpServers,                 // the real enumeration — this call is the seam
    loadConfig: () => ({ ...CFG, seats: [{ config_dir: third, label: 'seat-c' }] }),
  });
  s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps);
  const deny = JSON.parse(readFileSync(join(wt, '.claude', 'settings.local.json'), 'utf8')).permissions.deny;
  // A PERSONAL deny is a bare `mcp__<server>` — no `__` after the server, no wildcard — the
  // same definition doctor's drift check uses; the standing named-tool denies are not it.
  const personal = deny.filter((d) => d.startsWith('mcp__') && !d.includes('*') && !d.slice(5).includes('__'));
  assert.ok(deny.includes('mcp__seat_c_only'),
    `seat-c's server reaches every teammate in this worktree; personal denies written: ${personal.join(', ') || '(none)'}`);
});

// --- the pins the rest of the system reads off this module --------------------

test('the module still exports the six names the rest of the system pins', () => {
  for (const name of ['ENV_ALLOW', 'buildLeadArgv', 'buildLeadEnv', 'spawnLead', 'resumeLead', 'withTeammateGuard']) {
    assert.ok(name in s, `${name} is missing; watchdog realDeps() imports it at module level`);
  }
  assert.equal(typeof s.spawnLead, 'function');
  assert.equal(typeof s.resumeLead, 'function');
});

test('spawnLead returns the four fields bus-tools and the watchdog both read', () => {
  const { deps } = harness();
  const r = s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps);
  assert.deepEqual(Object.keys(r).sort(), ['cwd', 'lead', 'session_uuid', 'tmux_target']);
  assert.equal(r.lead, 'cr-1');
});

// --- seats: a per-launch config dir ------------------------------------------------
//
// Account rotation (docs/superpowers/specs/2026-09-15-account-rotation-design.md §3.3) moves a
// lead off a seat whose usage window has closed by killing its session and resuming it under
// ANOTHER `CLAUDE_CONFIG_DIR`. Until now that variable reached a lead only by being copied from
// the spawner's own environment, so every lead sat on the spawner's seat. `spawnLead(task, deps,
// { configDir })` and `resumeLead(task, deps, { configDir })` name a seat for ONE launch, and the
// seat has to reach three places together or the lead hangs on a dialog nobody answers: the
// environment tmux hands claude, the `.claude.json` that `preTrust` marks, and the file
// `trustFileFor` says the lead will read. One `env` object carries all three; the tests below
// pin each thread on its own so that severing any one of them names itself.

/** A second seat, as the watchdog's rotate() hands it: absolute, and not the spawner's own. */
const SEAT_B = '/Users/op/.claude-seat-b';
const SEAT_B_FILE = `${SEAT_B}/.claude.json`;

test('buildLeadEnv: a per-launch configDir replaces the copied CLAUDE_CONFIG_DIR', () => {
  const env = s.buildLeadEnv({ id: 'cr-1', env: SPAWNER_ENV, configDir: SEAT_B });
  assert.equal(env.CLAUDE_CONFIG_DIR, SEAT_B,
    'the copied value is the spawner\'s own seat; a lead rotated onto another must not see it');
});

test('buildLeadEnv: the seat changes CLAUDE_CONFIG_DIR and no other name, so ENV_ALLOW is not widened', () => {
  const args = { id: 'cr-1', sessionUuid: 'u1', teammateEffort: 'inherit', env: SPAWNER_ENV };
  const { CLAUDE_CONFIG_DIR: seat, ...withSeat } = s.buildLeadEnv({ ...args, configDir: SEAT_B });
  const { CLAUDE_CONFIG_DIR: own, ...without } = s.buildLeadEnv(args);
  assert.notEqual(seat, own, 'fixture sanity: the seat must differ from the spawner\'s own dir, or this measures nothing');
  assert.deepEqual(withSeat, without, 'a seat is one variable replaced, not a second allow-list');
});

test('buildLeadEnv: configDir undefined is byte-identical to no configDir at all', () => {
  // What this pins, stated because it has already been misread once as an assertion that cannot
  // fail: the options parameter stays DESTRUCTURED IN THE SIGNATURE, where an absent key and a
  // present-undefined one are genuinely indistinguishable to the callee. A rewrite that starts
  // reading the container — any `Object.hasOwn(o, 'configDir')` branch — is exactly the change that
  // could make `configDir: undefined` stop meaning "the spawner's own seat", and it reddens here.
  // Measured: body-destructure plus such a marker => 1 failure, on this line. It is killable.
  const args = { id: 'cr-1', sessionUuid: 'u1', teammateEffort: 'inherit', env: SPAWNER_ENV };
  assert.deepEqual(s.buildLeadEnv({ ...args, configDir: undefined }), s.buildLeadEnv(args),
    'every caller that predates seats must land exactly where it did');
  assert.equal(s.buildLeadEnv({ ...args, configDir: undefined }).CLAUDE_CONFIG_DIR, '/Users/op/.claude-work');
});

test('buildLeadEnv: "" and null mean "no seat" — today\'s dir stays, and CLAUDE_CONFIG_DIR= is never forwarded', () => {
  // `''` is how soma spells unset (`soma up` forwards `VAR || ''`, and spawn.mjs drops empty
  // values for that reason); `null` is the fleet row's `seat: string | null` for a lead spawned
  // before seats existed. Both must mean TODAY'S seat, not "unset the variable": with no
  // CLAUDE_CONFIG_DIR the lead falls to `~/.claude`, which on the machine v1 ships to is a
  // stale root — a pane that renders and can never log in.
  for (const noSeat of ['', null]) {
    const env = s.buildLeadEnv({ id: 'cr-1', env: SPAWNER_ENV, configDir: noSeat });
    assert.equal(env.CLAUDE_CONFIG_DIR, '/Users/op/.claude-work',
      `configDir ${JSON.stringify(noSeat)} must leave the spawner's own seat in place`);
  }
  const bare = s.buildLeadEnv({ id: 'cr-1', env: { HOME: '/Users/op', PATH: '/usr/bin' }, configDir: '' });
  assert.ok(!('CLAUDE_CONFIG_DIR' in bare),
    'a set-but-empty variable is the one way soma (|| readers) and claude could disagree about "unset"');
});

test('buildLeadEnv refuses a configDir that is not an absolute path, by name', () => {
  for (const bad of ['seat-b', './seat-b', '~/.claude-seat-b', 7, true, {}, []]) {
    assert.throws(() => s.buildLeadEnv({ id: 'cr-1', env: SPAWNER_ENV, configDir: bad }),
      /buildLeadEnv: configDir must be an absolute path/,
      `${JSON.stringify(bad)}: preTrust would resolve it against the spawner's cwd and claude against the lead's — two files, one mark`);
  }
});

/** A harness whose preTrust reports the SEAT's file, so the agreement check passes and the seat can be read off the calls. */
const seatHarness = (over = {}) => harness(over, { trustFile: SEAT_B_FILE });

/** Both entry points, each with a task it accepts, so a thread pinned on one cannot silently miss the other. */
const ENTRY_POINTS = [
  ['spawnLead', (deps, opts) => s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps, opts)],
  ['resumeLead', (deps, opts) => s.resumeLead(RESUMABLE, deps, opts)],
];

test('a per-launch configDir reaches the environment tmux hands claude, on both entry points', () => {
  for (const [what, run] of ENTRY_POINTS) {
    const { deps, calls } = seatHarness();
    run(deps, { configDir: SEAT_B });
    assert.equal(calls.newSession[0].env.CLAUDE_CONFIG_DIR, SEAT_B,
      `${what}: env -i drops the variable, so this is the ONLY way the lead learns which seat it is on`);
  }
});

test('every spelling of "no seat" launches byte-identically to a call with no options at all', () => {
  const baseline = harness();
  s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, baseline.deps);
  for (const opts of [undefined, {}, { configDir: undefined }, { configDir: '' }, { configDir: null }]) {
    const { deps, calls } = harness();
    s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps, opts);
    assert.deepEqual(calls.newSession[0].env, baseline.calls.newSession[0].env, `options ${JSON.stringify(opts)} changed the lead env`);
    assert.deepEqual(calls.preTrust[0], baseline.calls.preTrust[0], `options ${JSON.stringify(opts)} changed what preTrust was told`);
  }
});

test('a configDir that is not an absolute path is refused by both entry points before anything is created', () => {
  for (const [what, run] of ENTRY_POINTS) {
    for (const bad of ['seat-b', '~/.claude-seat-b', 7]) {
      const { deps, order } = seatHarness();
      assert.throws(() => run(deps, { configDir: bad }), new RegExp(`${what}\\(cr-1\\): configDir must be an absolute path`), `${what} ${JSON.stringify(bad)}`);
      assert.deepEqual(order, [], `${what}: no lock, no worktree, no mark for a seat that cannot be right`);
    }
  }
});

test('a seat passed as a bare string instead of { configDir } is refused, not silently ignored', () => {
  for (const [what, run] of ENTRY_POINTS) {
    const { deps, order } = seatHarness();
    assert.throws(() => run(deps, SEAT_B), new RegExp(`${what}\\(cr-1\\): the last argument must be an options object`),
      `${what}: destructuring a string finds no configDir, and the "rotation" would land on the spawner's own seat`);
    assert.deepEqual(order, []);
  }
});

test('preTrust is handed the SEAT\'s environment, so the mark lands in the file the rotated lead will read', () => {
  for (const [what, run] of ENTRY_POINTS) {
    const { deps, calls } = seatHarness();
    run(deps, { configDir: SEAT_B });
    const [, home, env] = calls.preTrust[0];
    assert.equal(env.CLAUDE_CONFIG_DIR, SEAT_B,
      `${what}: pretrust.configPath joins onto env.CLAUDE_CONFIG_DIR — handed the spawner's env it marks the spawner's file`);
    assert.equal(home, '/Users/op', `${what}: a seat moves the config dir, not HOME`);
  }
});

test('AGAINST THE REAL preTrust: the mark lands in <configDir>/.claude.json and the spawner\'s own file is untouched', async (t) => {
  const { preTrust } = await import('../bin/lib/pretrust.mjs');
  mkdirSync(SOMA_HOME(), { recursive: true });
  const root = mkdtempSync(join(SOMA_HOME(), 'seats-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const own = join(root, 'orch');                      // the spawner's own config dir, seeded so "untouched" is observable
  mkdirSync(own);
  writeFileSync(join(own, '.claude.json'), JSON.stringify({ projects: {} }));
  const seat = join(root, 'seat-b');                   // does not exist yet: claude has never run under it; preTrust mkdirs it
  const { deps } = harness({ preTrust, env: { ...SPAWNER_ENV, HOME: root, CLAUDE_CONFIG_DIR: own } });
  s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps, { configDir: seat });
  const marked = JSON.parse(readFileSync(join(seat, '.claude.json'), 'utf8'));
  assert.equal(marked.projects['/w/cr-1']?.hasTrustDialogAccepted, true,
    'the SEAT\'s .claude.json must carry the mark — it is the one the rotated lead reads');
  assert.deepEqual(JSON.parse(readFileSync(join(own, '.claude.json'), 'utf8')), { projects: {} },
    'the spawner\'s own config gained nothing: marking both would be a guess about which file is live');
});

test('a preTrust that reports the seat\'s file is accepted: the two agree and the lead launches', () => {
  const { deps, calls } = harness({ preTrust: () => SEAT_B_FILE });
  assert.doesNotThrow(() => s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps, { configDir: SEAT_B }),
    'trustFileFor must follow the seat too, or every rotation is refused as a disagreement');
  assert.equal(calls.newSession.length, 1);
});

test('a preTrust that reports the spawner\'s file when a seat was named is refused, and the message names both files', () => {
  // The disagreement refusal predates seats; this pins that it still fires, in the NEW direction:
  // the mark in the spawner's own file, the lead about to read the seat's.
  const { deps, calls } = harness({ preTrust: () => '/Users/op/.claude-work/.claude.json' });
  assert.throws(() => s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps, { configDir: SEAT_B }),
    /marked trust in \/Users\/op\/\.claude-work\/\.claude\.json but the lead will read \/Users\/op\/\.claude-seat-b\/\.claude\.json/,
    'a mark the rotated lead cannot see is the measured detached-pane hang');
  assert.deepEqual(calls.newSession, [], 'nothing launches against a mark the lead will not find');
});

test('AGAINST THE REAL GENERATOR: the launch file carries autoContinueAtUsageLimit: true', async () => {
  const { writeLeadSettings } = await import('../bin/lib/settings-gen.mjs');
  const { deps, calls } = harness({ writeLeadSettings });
  s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps);
  // The floor under rotation: a lead the watchdog cannot rotate (no open seat, thrash bound, a
  // failed revert) still recovers on its own when its window reopens — but only if the boolean
  // reaches the file `--settings` actually points at, which is this composition and not the base.
  assert.equal(launchSettingsOf(calls.newSession[0]).autoContinueAtUsageLimit, true,
    'settings-gen writes it; writeLaunchSettings must carry it through — a composition that filtered keys would drop the floor silently');
});

// --- the option KEY, not just its container ---------------------
//
// MEASURED on the module before this check existed, with a full stub dep set: `{ config_dir }`,
// `{ seat }`, `{ CONFIGDIR }`, `{ configdir }` and `{ configDirs }` each launched with NO REFUSAL,
// on `CLAUDE_CONFIG_DIR = /Users/op/.claude-work` — the spawner's own seat — on BOTH entry points.
// A misspelled key is the bare-string case wearing an object: the rotation reports success, the
// lead lands back in the window that just closed, and the watchdog reads the next trip as thrash.
// Nothing downstream can catch it, which is why it has to be caught here: with no seat in the env,
// `preTrust` and `trustFileFor` both name the spawner's file and AGREE, so the one check that
// compares them passes.

test('an option key the contract does not name is refused by both entry points, and the refusal names it', () => {
  for (const [what, run] of ENTRY_POINTS) {
    for (const key of ['config_dir', 'seat', 'CONFIGDIR', 'configdir', 'configDirs']) {
      // The DEFAULT harness, whose preTrust stub reports the spawner's own file: with no refusal
      // the misspelled launch AGREES with itself and succeeds silently, which is the defect. A seat
      // harness would have hidden it behind the agreement check and reddened for the wrong reason.
      const { deps, order } = harness();
      assert.throws(() => run(deps, { [key]: SEAT_B }), (e) => {
        assert.ok(e instanceof TypeError, `${what} ${key}: a shape refusal is a TypeError, like every other one on this path`);
        assert.match(e.message, new RegExp(`^${what}\\(cr-1\\): unknown option key `),
          `${what} ${key}: the refusal names the caller, or an operator reading it after a resume goes looking in spawnLead`);
        assert.ok(e.message.includes(JSON.stringify(key)),
          `${what}: the refusal must NAME the offending key — "unknown option" alone sends the reader back to guess which: ${e.message}`);
        assert.ok(e.message.includes('"configDir"'),
          `${what} ${key}: and name the one it should have been, which is the whole remedy`);
        return true;
      });
      // Strictly stronger than "nothing launched": the harness logs every effect into `order`, so
      // an empty one says no lock was taken, no worktree cut, no trust mark made and no session
      // started on the spawner's own seat — which is what the un-fixed module did, five times over.
      assert.deepEqual(order, [], `${what} ${key}: fails CLOSED`);
    }
  }
});

test('an unknown key is refused even beside a correct configDir, and only the unknown one is named', () => {
  // The shape a future option arrives in: the seat is right, the extra key is a guess. Reading the
  // seat and dropping the rest would launch something the caller did not ask for and report success.
  const { deps, order } = seatHarness();
  assert.throws(
    () => s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps, { configDir: SEAT_B, seat: SEAT_B }),
    (e) => {
      assert.ok(!/unknown option keys/.test(e.message),
        `one unknown key is singular, or the message reads as if configDir were wrong too: ${e.message}`);
      assert.match(e.message, /unknown option key "seat"/, `the stray key, named: ${e.message}`);
      return true;
    },
  );
  assert.deepEqual(order, [], 'a correct seat beside a stray key still creates nothing');
});

test('several unknown keys at once are all named, not just the first', () => {
  const { deps } = harness();
  assert.throws(
    () => s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps, { seat: SEAT_B, config_dir: SEAT_B }),
    (e) => {
      assert.ok(e.message.includes('"seat"') && e.message.includes('"config_dir"'),
        `both keys, or the caller fixes one, re-runs, and hits the refusal again: ${e.message}`);
      assert.match(e.message, /unknown option keys /, 'plural when there are two, so the message does not read as "only this one"');
      return true;
    },
  );
});

test('the unknown-key refusal cannot fire for the shapes the contract DOES name', () => {
  // The false-positive direction, and the reason it gets its own test: this check now sits in front
  // of EVERY launch, so a refusal that fired on a legitimate shape would stop the whole fleet rather
  // than one rotation. `undefined` and `{}` are what the watchdog's launch wrappers pass when
  // `pick()` found no open seat; `{ configDir: null }` is the ROTATION_FAILED revert onto a lead
  // spawned before seats existed.
  for (const [what, run] of ENTRY_POINTS) {
    for (const opts of [undefined, {}, { configDir: SEAT_B }, { configDir: undefined }, { configDir: null }, { configDir: '' }]) {
      const seated = opts?.configDir === SEAT_B;
      // A no-seat spelling lands on the spawner's own file, which the SEAT harness's preTrust does
      // not report — so those run through the harness whose stub agrees with `trustFileFor` instead.
      const { deps, calls } = seated ? seatHarness() : harness();
      const where = `${what} ${JSON.stringify(opts ?? null)}`;
      assert.doesNotThrow(() => run(deps, opts), where);
      assert.equal(calls.newSession.length, 1, `${where}: launched`);
      assert.equal(calls.newSession[0].env.CLAUDE_CONFIG_DIR, seated ? SEAT_B : '/Users/op/.claude-work',
        `${where}: and landed exactly where the option says`);
    }
  }
});

// --- a refused seat that no serialiser can render ----------------
//
// MEASURED on the module before `describeSeat` existed: `configDir: 1n` died with
// `TypeError: Do not know how to serialize a BigInt` and a self-referential object with
// `Converting circular structure to JSON` — both thrown from inside the refusal's own template, so
// the named refusal never printed and the word `configDir` never reached the operator. It always
// failed closed, which is the only reason this was Minor. The fix is not "use String() instead":
// `String` has its own three blind spots, one of which (`{ toString() { throw } }`) the original
// expression got RIGHT, so swapping would have moved the hole rather than closed it.

/** Values whose only rendering is the one `JSON.stringify` refuses to produce. */
function unrenderables() {
  const circular = { seat: '/Users/op/.claude-seat-b' };
  circular.self = circular;
  return {
    bigint: 1n,
    circular,
    throwingToJSON: { toJSON() { throw new Error('toJSON exploded'); } },
    throwingToString: { toString() { throw new Error('toString exploded'); } },
    hostileProxy: new Proxy({}, { get() { throw new Error('every read throws'); } }),
    symbol: Symbol('seat-b'),
  };
}

test('a configDir JSON.stringify cannot serialise still gets the NAMED refusal, not a serialiser error', () => {
  const u = unrenderables();
  for (const [label, value, rendered] of [
    ['bigint', u.bigint, 'got bigint 1 '],
    ['a circular object', u.circular, 'got object [object Object] '],
    ['an object whose toJSON throws', u.throwingToJSON, 'got object [object Object] '],
  ]) {
    assert.throws(() => s.buildLeadEnv({ id: 'cr-1', env: SPAWNER_ENV, configDir: value }), (e) => {
      assert.match(e.message, /^buildLeadEnv: configDir must be an absolute path/,
        `${label}: the refusal has to survive its own message — a serialiser error names neither configDir nor buildLeadEnv, and the operator reads it as a bug in soma rather than in the seat they passed`);
      assert.ok(e.message.includes(rendered),
        `${label}: and still SAY what it got, or the refusal is correct and useless: ${e.message}`);
      return true;
    });
  }
});

test('the second renderer cannot throw either: String() has blind spots JSON.stringify does not', () => {
  // The reverse hole, which a bare `String(value)` first would have opened. `{ toString() { throw } }`
  // renders as `{}` through JSON.stringify — a case the pre-fix expression already handled — and a
  // revoked or hostile Proxy defeats BOTH renderers, which is the third state this has to have.
  const u = unrenderables();
  for (const [label, value, rendered] of [
    ['an object whose toString throws', u.throwingToString, 'got {} '],
    ['a Proxy that throws on every read', u.hostileProxy, 'got an unprintable object '],
    ['a symbol (String() renders it; `${}` would throw)', u.symbol, 'got symbol Symbol(seat-b) '],
  ]) {
    assert.throws(() => s.buildLeadEnv({ id: 'cr-1', env: SPAWNER_ENV, configDir: value }), (e) => {
      assert.match(e.message, /^buildLeadEnv: configDir must be an absolute path/, `${label}: ${e.message}`);
      assert.ok(e.message.includes(rendered), `${label}: ${e.message}`);
      return true;
    });
  }
});

test('an unrenderable configDir fails CLOSED on both entry points, exactly like a relative one', () => {
  const u = unrenderables();
  for (const [what, run] of ENTRY_POINTS) {
    for (const [label, value] of [['bigint', u.bigint], ['a hostile Proxy', u.hostileProxy]]) {
      const { deps, order } = seatHarness();
      // No `^`: a bare RegExp in assert.throws is matched against `String(err)`, which starts
      // `TypeError: `. The caller's own name is still pinned, one character in.
      assert.throws(() => run(deps, { configDir: value }),
        new RegExp(`TypeError: ${what}\\(cr-1\\): configDir must be an absolute path`), `${what} ${label}`);
      assert.deepEqual(order, [], `${what} ${label}: a seat nothing can even print creates nothing`);
    }
  }
});

// --- the seat a launch LANDS on is a root too, listed in the pool or not -----
//
// `launch()` enumerated `roots: seatRoots(cfg)` — the POOL — and a comment three lines above
// stated the launch's own seat as a fact: "the seat this launch lands on (`configDir`) is
// already one of `seatRoots(cfg)`". Nothing enforced it. `seatConfigDir` checks that the path
// is absolute and nothing else, so a `configDir` outside `cfg.seats` launched a lead under a
// config dir whose `.claude.json` had contributed no denies: MEASURED on the unfixed module,
// `spawnLead(task, deps, { configDir: <dir not in cfg.seats> })` wrote `personal denies: []`
// while the lead ran with `CLAUDE_CONFIG_DIR` pointing at a seat holding `rogue_seat_server`.
// Every teammate in that worktree mounts it undenied — the exact hole the seat enumeration exists
// to close, reached through the one input it chose not to feed into `roots`.
//
// Reachable the moment `rotate()` names a seat, and in the window where the pool
// changes between `pick()` and `launch`'s own `deps.loadConfig()`. Fixed here because no later
// change was scheduled to touch this block of `launch()`. `roots` is now the pool UNION the
// launch: a superset is the safe direction on a deny list, and refusing an unlisted seat would
// instead fail a rotation closed on a config race.

test('the seat a launch lands on is enumerated even when soma.json does not list it', () => {
  for (const [what, run] of ENTRY_POINTS) {
    const seen = [];
    const { deps } = seatHarness({
      enumerateUserMcpServers: recording(seen),
      loadConfig: () => ({ ...CFG, seats: [{ config_dir: '/seats/a', label: 'seat-a' }] }),
    });
    run(deps, { configDir: SEAT_B });
    assert.deepEqual(seen[0]?.opts?.roots, ['/seats/a', SEAT_B],
      `${what}: the pool is what soma.json says, the launch is where the lead actually lands`
      + ' — a seat missing here is a seat whose personal servers reach every teammate in that worktree undenied');
  }
});

test('a launch seat the pool already holds is not read twice, and does not reorder the pool', () => {
  const seen = [];
  const { deps } = seatHarness({
    enumerateUserMcpServers: recording(seen),
    loadConfig: () => ({ ...CFG, seats: [{ config_dir: SEAT_B, label: 'seat-b' }, { config_dir: '/seats/a', label: 'seat-a' }] }),
  });
  s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps, { configDir: SEAT_B });
  assert.deepEqual(seen[0]?.opts?.roots, [SEAT_B, '/seats/a'],
    'a rotation onto a seat the pool already holds is the COMMON case; a duplicated root is a second read of the same files and a list that changed for no reason');
});

/**
 * THE SEAM, end to end through the real enumeration and the real writer: a lead launched
 * on a seat the pool does not list still gets that seat's servers denied in the guard file its
 * teammates inherit. Three states: `mcp__rogue_seat_server` present (pass) · absent (fail: the
 * launch's own seat is not in `roots`) · the precondition trips (could not observe: a fixed pair
 * already knew the name). `CFG` carries NO `seats` key here on purpose — the pool is empty, so
 * the only way the name can reach the file is the launch's own `configDir`.
 */
test('SEAM: a launch on a seat outside the pool still denies that seat\'s servers in the guard file', (t) => {
  const savedHome = process.env.HOME;
  const savedCfg = process.env.CLAUDE_CONFIG_DIR;
  const fakeHome = mkdtempSync(join(tmpdir(), 'home-'));
  const rogue = mkdtempSync(join(tmpdir(), 'seat-rogue-'));
  const wt = mkdtempSync(join(tmpdir(), 'wt-'));
  t.after(() => {
    process.env.HOME = savedHome;
    if (savedCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedCfg;
    for (const d of [fakeHome, rogue, wt]) rmSync(d, { recursive: true, force: true });
  });
  process.env.HOME = fakeHome;
  delete process.env.CLAUDE_CONFIG_DIR;
  writeFileSync(join(rogue, '.claude.json'), JSON.stringify({ mcpServers: { rogue_seat_server: {} } }));
  assert.ok(!enumerateUserMcpServers(SPAWNER_ENV.HOME, SPAWNER_ENV).includes('rogue_seat_server')
    && !enumerateUserMcpServers().includes('rogue_seat_server'),
    'could not observe: a fixed pair already denies rogue_seat_server, so this test cannot tell a threaded launch seat from an unthreaded one');
  const { deps } = harness({
    ensureWorktree: () => ({ dir: wt, branch: 'soma/cr-1', base_sha: 'sha', reused: false, excluded: true }),
    writeWorktreeGuardrails,                 // the real writer, into a real throwaway worktree
    enumerateUserMcpServers,                 // the real enumeration — this call is the seam
    loadConfig: () => CFG,                   // the pool is EMPTY: CFG has no `seats` key
  }, { trustFile: join(rogue, '.claude.json') });
  s.spawnLead({ id: 'cr-1', repo: 'r', brief: 'do x' }, deps, { configDir: rogue });
  const deny = JSON.parse(readFileSync(join(wt, '.claude', 'settings.local.json'), 'utf8')).permissions.deny;
  const personal = deny.filter((d) => d.startsWith('mcp__') && !d.includes('*') && !d.slice(5).includes('__'));
  assert.ok(deny.includes('mcp__rogue_seat_server'),
    `the lead launches under ${rogue} and every teammate in this worktree mounts its servers; personal denies written: ${personal.join(', ') || '(none)'}`);
});
