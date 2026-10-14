import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS } from '../bin/lib/config.mjs';

/**
 * Every name on `Object.prototype` that a caller-supplied key could collide with.
 *
 * This build has already shipped one registry indexed `reg[id]` by truthiness, which
 * reported every one of these as present and resolved to *no* budget class — a lead
 * running with no circuit breaker in a fleet whose entire safety model is that breaker.
 * Each function below that indexes a container by a caller-supplied key (task id, lead
 * id, task status) is therefore tested against all five.
 */
const PROTO_KEYS = ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty'];

test('reconcile flags spawned-but-absent leads dead', async () => {
  const { reconcile } = await import('../bin/lib/wd/reconcile.mjs?' + Date.now());
  const fleet = { tasks: [{ id: 'a', status: 'spawned' }, { id: 'b', status: 'spawned' }, { id: 'c', status: 'done' }] };
  const r = reconcile(fleet, new Set(['lead-a']));   // only a is alive
  assert.deepEqual(r.deadLeads, ['b']);
});

// The ONLY one of the six original tests this build has had to change, and the change is
// forced: `cfg.resume_token_guard` no longer exists (a units fix removed the key rather than
// redefining it) and the judged field is no longer `est_tokens`. Three assertions, three
// verdicts, same shape and same name — `resume_token_guard: 200000` became the real config
// (limit 700_000 via resumeContextLimit) and `est_tokens` became `live_context`.
test('planRevival: giveup after 3 attempts, fresh when context saturated, else resume', async () => {
  const { planRevival } = await import('../bin/lib/wd/revive.mjs?' + Date.now());
  const cfg = DEFAULTS;                                   // resumeContextLimit(DEFAULTS) === 700_000
  assert.equal(planRevival({ attempts: 3 }, { live_context: 10 }, cfg), 'giveup');
  assert.equal(planRevival({ attempts: 1 }, { live_context: 800_000 }, cfg), 'fresh');
  assert.equal(planRevival({ attempts: 1 }, { live_context: 10 }, cfg), 'resume');
});

test('checkBudget warns at 80%, trips at 100%', async () => {
  const { checkBudget } = await import('../bin/lib/wd/budget.mjs?' + Date.now());
  const cls = { tokens_cap: 1000, turn_cap: 10, wall_ms: 0 };
  assert.equal(checkBudget({ est_tokens: 500, turns: 1 }, cls), null);
  assert.equal(checkBudget({ est_tokens: 850, turns: 1 }, cls), 'warn');
  assert.equal(checkBudget({ est_tokens: 1000, turns: 1 }, cls), 'trip');
  assert.equal(checkBudget({ est_tokens: 1, turns: 10 }, cls), 'trip');   // turn cap
});

test('detectStorm needs corroboration (2 panes OR 1 pane + transcript)', async () => {
  const { detectStorm } = await import('../bin/lib/wd/backpressure.mjs?' + Date.now());
  assert.equal(detectStorm([{ lead: 'a', paneHit: true, transcriptHit: false }]).frozen, false); // 1 pane only
  assert.equal(detectStorm([{ lead: 'a', paneHit: true, transcriptHit: true }]).frozen, true);    // pane + transcript
  assert.equal(detectStorm([{ lead: 'a', paneHit: true }, { lead: 'b', paneHit: true }]).frozen, true); // 2 panes
});

test('nextAdmission honors max_leads, stagger, and backpressure', async () => {
  const { nextAdmission } = await import('../bin/lib/wd/admission.mjs?' + Date.now());
  const cfg = { max_leads: 2, stagger_s: 90 };
  const fleet = { tasks: [{ id: 'a', status: 'queued' }], last_spawn_at: null };
  assert.equal(nextAdmission(fleet, cfg, 1000, false), 'a');
  assert.equal(nextAdmission(fleet, cfg, 1000, true), null);                       // frozen
  assert.equal(nextAdmission({ ...fleet, last_spawn_at: 1000 }, cfg, 1000 + 10_000, false), null); // within stagger
});

test('settlement distinguishes drained from settled', async () => {
  const { settlement } = await import('../bin/lib/wd/settle.mjs?' + Date.now());
  const cfg = { settle_minutes: 30 };
  const drained = { tasks: [{ status: 'done' }, { status: 'failed' }] };
  assert.equal(settlement(drained, 0, 0, cfg), 'drained');
  const settled = { tasks: [{ status: 'done' }, { status: 'blocked' }] };
  assert.equal(settlement(settled, 0, 31 * 60 * 1000, cfg), 'settled');
  assert.equal(settlement(settled, 0, 5 * 60 * 1000, cfg), null);   // too soon
});

// ─────────────────────────── reconcile ───────────────────────────

test('reconcile only judges spawned rows, and judges Object.prototype-named ids like any other', async () => {
  const { reconcile } = await import('../bin/lib/wd/reconcile.mjs?proto-' + Date.now());
  // Every task id here is a legal fleet id or a name that only a truthiness-indexed
  // registry would confuse for a live session. Half are alive, half are not.
  const fleet = {
    tasks: [
      ...PROTO_KEYS.map((id) => ({ id, status: 'spawned' })),
      { id: 'queued-one', status: 'queued' },     // never had a session; not dead
      { id: 'done-one', status: 'done' },         // finished; slot already freed
      { id: 'blocked-one', status: 'blocked' },   // waiting on a human, alive or not
      { id: 'failed-one', status: 'failed' },
      { id: 'skipped-one', status: 'skipped' },
    ],
  };
  const alive = new Set(['lead-constructor', 'lead-valueOf']);
  const r = reconcile(fleet, alive);
  assert.deepEqual(r.deadLeads, ['toString', '__proto__', 'hasOwnProperty']);
  // A hand-edited checkpoint can carry a hole in `tasks`. A hole is "not spawned", not a
  // crash: a throw here reconciles NOTHING, for every lead, on every tick.
  assert.deepEqual(reconcile({ tasks: [null, { id: 'a', status: 'spawned' }, undefined] }, new Set()).deadLeads, ['a']);
});

test('reconcile proposes no status transition — a missing session is not a verdict', async () => {
  const { reconcile } = await import('../bin/lib/wd/reconcile.mjs?updates-' + Date.now());
  const fleet = { tasks: [{ id: 'a', status: 'spawned' }, { id: 'b', status: 'spawned' }] };
  const r = reconcile(fleet, new Set(['lead-a']));
  // `updates` re-affirms `spawned`; it must never move the row to failed/skipped here,
  // because planRevival still owes this lead three attempts before anything gives up.
  assert.deepEqual(r.updates, [{ id: 'b', status: 'spawned' }]);
  for (const u of r.updates) {
    assert.equal(u.status, fleet.tasks.find((t) => t.id === u.id).status, 'reconcile must not transition a row');
  }
});

test('reconcile refuses a liveness container that is not a Set', async () => {
  const { reconcile } = await import('../bin/lib/wd/reconcile.mjs?container-' + Date.now());
  const fleet = { tasks: [{ id: 'a', status: 'spawned' }] };
  // A plain object indexed by session name answers `true` for every Object.prototype
  // key, so the structural requirement is enforced rather than trusted. Matched on the
  // guard's own wording: `aliveSessions.has is not a function` would satisfy a looser
  // pattern by accident, and then this test would pin nothing.
  assert.throws(() => reconcile(fleet, { 'lead-a': true }), /must be a Set or Map/);
  assert.throws(() => reconcile(fleet, ['lead-a']), /must be a Set or Map/);
  assert.throws(() => reconcile(fleet, undefined), /must be a Set or Map/);
  assert.throws(() => reconcile({ tasks: null }, new Set()), /fleet\.tasks must be an array/);
  // A Map is a legitimate container: same `.has`, same no-prototype-keys guarantee.
  assert.deepEqual(reconcile(fleet, new Map([['lead-a', 1]])).deadLeads, []);
});

test('reconcile leaves a lead that is still launching alone, and only while its mark is inside the bound', async () => {
  const { reconcile } = await import('../bin/lib/wd/reconcile.mjs?launching-' + Date.now());
  const { LAUNCH_GRACE_MS } = await import('../bin/lib/fleet.mjs');
  const now = 1_440_433_800_000;
  const fleet = {
    tasks: [
      // soma_spawn claimed this row and is thirty seconds into its fetch, outside the fleet lock: no
      // session yet, and none missing. Revived here, it is killed and respawned under the spawner.
      { id: 'starting', status: 'spawned', launching_at: now - 30_000 },
      // The control that proves the bound: the same row once the mark is LAUNCH_GRACE_MS old is
      // dead to reconcile again, and its slot comes back through revival like any dead lead's.
      { id: 'expired', status: 'spawned', launching_at: now - LAUNCH_GRACE_MS },
      // Unmarked rows read exactly as before: one whose mark was cleared, and one from before the mark.
      { id: 'cleared', status: 'spawned', launching_at: null },
      { id: 'legacy', status: 'spawned' },
      // A live session beats the mark; a queued row is never judged.
      { id: 'up', status: 'spawned', launching_at: now - 30_000 },
      { id: 'queued-one', status: 'queued', launching_at: now - 30_000 },
    ],
  };
  const r = reconcile(fleet, new Set(['lead-up']), now);
  assert.deepEqual(r.deadLeads, ['expired', 'cleared', 'legacy']);
  assert.deepEqual(r.updates.map((u) => u.id), ['expired', 'cleared', 'legacy'], 'a launching row is not re-affirmed either');
  // No clock, no grace: the contract every caller had before the mark existed.
  assert.deepEqual(reconcile(fleet, new Set(['lead-up'])).deadLeads, ['starting', 'expired', 'cleared', 'legacy']);
});

// ─────────────────────────── revive ───────────────────────────

test('planRevival judges LIVE CONTEXT and is indifferent to cumulative spend', async () => {
  const { planRevival } = await import('../bin/lib/wd/revive.mjs?field-' + Date.now());
  const cfg = DEFAULTS;                                   // limit 700_000
  // THE inversion this replaces, and it is the ordinary shape of a long-running lead, not a
  // corner case. Claude Code auto-compacts at the window: measured over real events it fires
  // near a full window and lands at under a tenth of the peak, every time. So a
  // lead a hundred turns deep genuinely sits near 80k of live context while its cumulative
  // spend is in the millions, and it is CHEAP to resume. The old comparison refused it.
  assert.equal(planRevival({ attempts: 0 }, { est_tokens: 2_000_000, live_context: 50_000 }, cfg), 'resume');
  assert.equal(planRevival({ attempts: 0 }, { est_tokens: 999_999_999, live_context: 0 }, cfg), 'resume');
  // Numbers of the size a real transcript shows, both fields off the same reading: est_tokens
  // ~120M vs live_context ~600k. A 200x ratio — the units bug in one line. Under the
  // old comparison this lead fresh-spawned; it has 100k of headroom left and should resume.
  assert.equal(planRevival({ attempts: 0 }, { est_tokens: 120_000_000, live_context: 600_000 }, cfg), 'resume');
  // ...and the mirror: trivial spend, saturated right now. Spend cannot buy a resume and
  // cannot deny one — only the context number moves this verdict.
  assert.equal(planRevival({ attempts: 0 }, { est_tokens: 10, live_context: 800_000 }, cfg), 'fresh');
  assert.equal(planRevival({ attempts: 0 }, { live_context: 800_000 }, cfg), 'fresh');   // est_tokens absent entirely
  assert.equal(planRevival({ attempts: 0 }, { live_context: 10 }, cfg), 'resume');
  // The limit is DERIVED from config through tokens.mjs, never hardcoded here: a smaller
  // window has to move the boundary, or `resume_context_window` is decoration.
  const tight = { resume_context_fraction: 0.7, resume_context_window: 200_000 };   // limit 140_000
  assert.equal(planRevival({ attempts: 0 }, { live_context: 140_000 }, tight), 'fresh');
  assert.equal(planRevival({ attempts: 0 }, { live_context: 139_999 }, tight), 'resume');
  // A cfg with neither key is not a disarmed governor: `resumeContextLimit` owns the shipped
  // fallback (0.7 x 1M), so the comparison still fires. This is why there is no local default
  // and no fallback to the old key — the one function that knows the number answers for it.
  assert.equal(planRevival({ attempts: 0 }, { live_context: 800_000 }, {}), 'fresh');
  assert.equal(planRevival({ attempts: 0 }, { live_context: 600_000 }, {}), 'resume');
  // A derived limit of 0 or less would make EVERY revival 'fresh' — resume-first silently
  // deleted, which is the failure this module family exists to refuse. Reachable today only
  // through a negative window/fraction, which `resumeContextLimit` passes through.
  assert.throws(() => planRevival({ attempts: 0 }, { live_context: 1 }, { resume_context_window: -1 }), /non-positive context limit/);
  assert.throws(() => planRevival({ attempts: 0 }, { live_context: 1 }, { resume_context_fraction: -0.7 }), /non-positive context limit/);
});

test('planRevival: attempt and saturation boundaries', async () => {
  const { planRevival } = await import('../bin/lib/wd/revive.mjs?bounds-' + Date.now());
  const cfg = DEFAULTS;                                   // limit 700_000
  assert.equal(planRevival({ attempts: 2 }, { live_context: 10 }, cfg), 'resume');    // third attempt allowed
  assert.equal(planRevival({ attempts: 4 }, { live_context: 10 }, cfg), 'giveup');    // past the cap
  assert.equal(planRevival({}, { live_context: 10 }, cfg), 'resume');                 // absent attempts = none yet
  assert.equal(planRevival({ attempts: 3 }, { live_context: 999_999 }, cfg), 'giveup'); // giveup outranks fresh
  assert.equal(planRevival({ attempts: 0 }, { live_context: 699_999 }, cfg), 'resume'); // one token under the limit
  assert.equal(planRevival({ attempts: 0 }, { live_context: 700_000 }, cfg), 'fresh');  // exactly at it
  assert.equal(planRevival({ attempts: 0 }, null, cfg), 'resume');                    // no session to read
  // Present-but-unreadable is a caller bug, and reading it as 0 would resume a
  // context we could not measure / retry a lead forever.
  assert.throws(() => planRevival({ attempts: 'many' }, { live_context: 1 }, cfg), /attempts/);
  assert.throws(() => planRevival({ attempts: -1 }, { live_context: 1 }, cfg), /attempts/);
  assert.throws(() => planRevival({ attempts: 0 }, { live_context: 'lots' }, cfg), /live_context must be a non-negative/);
  // `fleet.json` is hand-editable, so a numeric STRING attempt count is honoured rather than
  // refused — the same tolerance `fleet.admit` gives `max_leads`. (Until this round the
  // tolerance was exercised only through the removed `resume_token_guard: '200000'`; with
  // that key gone, `attempts` is its one remaining consumer and pins it here.)
  assert.equal(planRevival({ attempts: '2' }, { live_context: 10 }, cfg), 'resume');
  assert.equal(planRevival({ attempts: '3' }, { live_context: 10 }, cfg), 'giveup');
});

test('planRevival reads zero_tail_rows without letting it move the verdict', async () => {
  const { planRevival } = await import('../bin/lib/wd/revive.mjs?tail-' + Date.now());
  const cfg = DEFAULTS;
  // `zero_tail_rows > 0` means the lead died ABNORMALLY: an API or auth error wrote trailing
  // assistant rows carrying no usage (a few real sessions end this way, masking their real
  // context, which `live_context` already sees past by skipping the zero tail).
  // It is deliberately NOT a fourth axis — see the module header. Same attempts and same live
  // context must yield the same word whatever it says, so a future branch on it is a decision
  // someone has to make on purpose rather than inherit.
  for (const zero_tail_rows of [0, 1, 4, 99]) {
    assert.equal(planRevival({ attempts: 0 }, { live_context: 50_000, zero_tail_rows }, cfg), 'resume');
    assert.equal(planRevival({ attempts: 0 }, { live_context: 800_000, zero_tail_rows }, cfg), 'fresh');
    assert.equal(planRevival({ attempts: 3 }, { live_context: 10, zero_tail_rows }, cfg), 'giveup');
  }
  // ...and it cannot be used as the context reading either, however tempting the name.
  assert.throws(() => planRevival({ attempts: 0 }, { zero_tail_rows: 3 }, cfg), /live_context is missing/);
});

// ─────────────────────────── budget ───────────────────────────

test('checkBudget binds the five real budget classes from DEFAULTS', async () => {
  const { checkBudget } = await import('../bin/lib/wd/budget.mjs?classes-' + Date.now());
  const b = DEFAULTS.budgets;
  assert.deepEqual(Object.keys(b).sort(), ['babysit', 'iterate', 'research', 'review', 'standard']);
  for (const [name, cls] of Object.entries(b)) {
    assert.equal(checkBudget({ est_tokens: 0, turns: 0 }, cls), null, `${name} must not fire on a fresh lead`);
    assert.equal(checkBudget({ est_tokens: cls.tokens_cap * 0.8, turns: 0 }, cls), 'warn', `${name} warn at 80%`);
    assert.equal(checkBudget({ est_tokens: cls.tokens_cap, turns: 0 }, cls), 'trip', `${name} trip at 100%`);
    assert.equal(checkBudget({ est_tokens: cls.tokens_cap * 0.8 - 1, turns: 0 }, cls), null, `${name} quiet under 80%`);
  }
  // Turn caps are DERIVED from the class, never restated here. The caps are operator-facing
  // config and they move — a units fix re-based every one of them by 10-16x — so a
  // test that hardcodes `turns: 30` stops testing the turn cap and starts testing an old
  // number. Semantics get pinned instead: trip AT the cap, quiet one turn under it.
  for (const [name, cls] of Object.entries(b)) {
    if (!cls.turn_cap) continue;                                   // babysit has none, by design
    assert.equal(checkBudget({ est_tokens: 1, turns: cls.turn_cap }, cls), 'trip', `${name} trips at its turn cap`);
    assert.equal(checkBudget({ est_tokens: 1, turns: cls.turn_cap - 1 }, cls), null, `${name} quiet one turn under`);
  }
});

test('checkBudget: a 0 cap is "no cap" and an absent cap is too — deliberately, not accidentally', async () => {
  const { checkBudget } = await import('../bin/lib/wd/budget.mjs?zero-' + Date.now());
  // babysit is the real class that exercises this: a token cap, NO turn cap, NO wall cap.
  // Its cap VALUE is read from the class for the reason above; what is pinned here is the
  // structural claim that this is the class shipping 0 for the other two.
  const babysit = DEFAULTS.budgets.babysit;
  assert.equal(babysit.turn_cap, 0);
  assert.equal(babysit.wall_ms, 0);
  assert.ok(babysit.tokens_cap > 0, 'babysit must still carry the one cap it has');
  assert.equal(checkBudget({ est_tokens: babysit.tokens_cap * 0.8, turns: 10_000 }, babysit), 'warn'); // turns cannot trip it
  assert.equal(checkBudget({ est_tokens: babysit.tokens_cap - 1, turns: 1e9 }, babysit), 'warn');
  assert.equal(checkBudget({ est_tokens: babysit.tokens_cap, turns: 0 }, babysit), 'trip');            // tokens still do
  // wall_ms: 0 means no wall-clock cap even with a clock a year past the spawn.
  assert.equal(checkBudget({ est_tokens: 0, turns: 0 }, babysit, { now: 365 * 24 * 3600 * 1000, startedAt: 0 }), null);
  // An absent key reads the same as 0 — and cannot disable a cap that IS present.
  assert.equal(checkBudget({ est_tokens: 999, turns: 1e9 }, { tokens_cap: 1000 }, { now: 1e12, startedAt: 0 }), 'warn');
  assert.equal(checkBudget({ est_tokens: 0, turns: 5 }, { turn_cap: 5 }), 'trip');
  // ...and a class with NO token cap gives no token verdict at any spend. Without the
  // `tokens_cap > 0` guard this is `est / 0` — Infinity — so every lead on a turn-capped
  // class would trip at its first token, gated by a cap that does not exist.
  assert.equal(checkBudget({ est_tokens: 1e9, turns: 1 }, { turn_cap: 5 }), null);
  assert.equal(checkBudget({ est_tokens: 1e9, turns: 1 }, { tokens_cap: 0, turn_cap: 5 }), null);
  assert.equal(checkBudget({ est_tokens: 1e9, turns: 1 }, { wall_ms: 60_000 }, { now: 0, startedAt: 0 }), null);
  // Usage is evidence, not governance — but only `null` means "no session to read". A
  // reading that lost a field is a contract violation, never a lead at 0% of its budget.
  assert.equal(checkBudget(null, DEFAULTS.budgets.standard), null);
  assert.throws(() => checkBudget({}, DEFAULTS.budgets.standard), /usage\.est_tokens is missing/);
  assert.throws(() => checkBudget({ est_tokens: 0 }, DEFAULTS.budgets.standard), /usage\.turns is missing/);
  assert.throws(() => checkBudget('lots', DEFAULTS.budgets.standard), /readUsage\(\) object or null/);
  assert.throws(() => checkBudget({ est_tokens: 'lots', turns: 0 }, DEFAULTS.budgets.standard), /est_tokens/);
  assert.throws(() => checkBudget({ est_tokens: 0, turns: [] }, DEFAULTS.budgets.standard), /turns/);
});

test('checkBudget refuses a class with no enforceable cap rather than run a lead breakerless', async () => {
  const { checkBudget } = await import('../bin/lib/wd/budget.mjs?breakerless-' + Date.now());
  const usage = { est_tokens: 1e9, turns: 1e9 };
  assert.throws(() => checkBudget(usage, { tokens_cap: 0, turn_cap: 0, wall_ms: 0 }), /no enforceable cap/);
  assert.throws(() => checkBudget(usage, {}), /no enforceable cap/);
  // Matched on wording unique to the cls-must-be-an-object guard. `/budget class/` alone
  // is satisfied by a SIBLING in the same function — "budget class has no enforceable cap
  // (tokens_cap / turn_cap / wall_ms all 0 or absent)" — so with that guard deleted, a
  // string `cls` still throws, still matches, and the assertion pins nothing. (The `null`
  // case does not need the tightening: it reaches `Object.hasOwn(null, …)` and throws
  // "Cannot convert undefined or null to object". Tightened anyway, same rule.)
  assert.throws(() => checkBudget(usage, null), /budget class must be an object/);
  assert.throws(() => checkBudget(usage, 'standard'), /budget class must be an object/);
  // Caps are read with Object.hasOwn, so a class whose caps live on its prototype has
  // none of its own and is refused — it cannot pass itself off as governed.
  assert.throws(() => checkBudget(usage, Object.create(DEFAULTS.budgets.standard)), /no enforceable cap/);
  // A malformed cap is refused too; coercing `null`/`''`/`[]` to 0 would silently disarm it.
  // `null` and `'lots'` coerce to 0, which makes this class capless — so a bare
  // /tokens_cap/ is answered by the capless sibling above (its message lists all three cap
  // names) and cannot see the cap check at all. Matched on the cap check's own wording.
  assert.throws(() => checkBudget(usage, { tokens_cap: null }), /cls\.tokens_cap must be a non-negative/);
  assert.throws(() => checkBudget(usage, { tokens_cap: -1 }), /tokens_cap/);
  assert.throws(() => checkBudget(usage, { tokens_cap: 'lots' }), /cls\.tokens_cap must be a non-negative/);
  // ...and the case the capless sibling can NEVER answer, which is the one that matters: a
  // malformed cap on a class that still carries OTHER enforceable caps. Nothing else stands
  // between a hand-edited `tokens_cap: null` and a lead whose token cap reads as "no cap"
  // while the class still reports governed — the capless refusal does not fire here.
  const governed = { turn_cap: 50, wall_ms: 8 * 3600 * 1000 };
  assert.throws(() => checkBudget(usage, { ...governed, tokens_cap: null }), /cls\.tokens_cap must be a non-negative/);
  assert.throws(() => checkBudget(usage, { ...governed, tokens_cap: '' }), /cls\.tokens_cap must be a non-negative/);
  assert.throws(() => checkBudget(usage, { ...governed, tokens_cap: [] }), /cls\.tokens_cap must be a non-negative/);
  assert.throws(() => checkBudget(usage, { tokens_cap: 1000, turn_cap: [], wall_ms: 0 }), /cls\.turn_cap must be a non-negative/);
  // The refusal has to survive rendering the value it is refusing: JSON.stringify throws
  // on a BigInt and on a hostile toJSON, which would replace the diagnostic with noise.
  assert.throws(() => checkBudget(usage, { tokens_cap: 10n }), /tokens_cap/);
  assert.throws(() => checkBudget(usage, { tokens_cap: { toJSON() { throw new Error('boom'); } } }), /tokens_cap/);
  assert.equal(checkBudget({ est_tokens: 1500, turns: 0 }, { tokens_cap: '1000' }), 'trip'); // hand-edited string
});

test('checkBudget enforces the wall clock only when the caller supplies one', async () => {
  const { checkBudget } = await import('../bin/lib/wd/budget.mjs?wall-' + Date.now());
  const research = DEFAULTS.budgets.research;        // 2 h
  assert.equal(research.wall_ms, 2 * 3600 * 1000);
  assert.equal(checkBudget({ est_tokens: 0, turns: 0 }, research, { startedAt: 0, now: research.wall_ms }), 'trip');
  assert.equal(checkBudget({ est_tokens: 0, turns: 0 }, research, { startedAt: 0, now: research.wall_ms - 1 }), null);
  assert.equal(checkBudget({ est_tokens: 0, turns: 0 }, research), null);   // no clock ⇒ wall cap not evaluated
  const fresh = { est_tokens: 0, turns: 0 };
  assert.throws(() => checkBudget(fresh, research, { startedAt: 0 }), /clock\.now/);
  assert.throws(() => checkBudget(fresh, research, { now: 0, startedAt: 'x' }), /clock\.startedAt/);
});

test('checkBudget judges est_tokens — the weighted total — and never a raw field', async () => {
  const { checkBudget } = await import('../bin/lib/wd/budget.mjs?field-' + Date.now());
  const { planRevival } = await import('../bin/lib/wd/revive.mjs?field-' + Date.now());
  const cls = { tokens_cap: 1000, turn_cap: 10, wall_ms: 0 };
  const cfg = DEFAULTS;
  // `est_tokens` originally omitted cache_creation_input_tokens — 56% of real volume — so
  // a lead burned ~2x its cap before this function said 'trip'. The fix belongs in the
  // measurement, so these two pin WHICH field carries the verdict: an under-counted input
  // reaching a correct comparison is exactly how that breaker looked like it worked.
  const overCap = {
    turns: 1, last_model: 'claude-fable-5', est_tokens: 1000,
    raw: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    models: ['claude-fable-5'],
  };
  assert.equal(checkBudget(overCap, cls), 'trip', 'must trip on est_tokens even though raw is tiny');
  const rawHeavy = {
    turns: 1, last_model: 'claude-fable-5', est_tokens: 10,
    raw: { input_tokens: 1e9, output_tokens: 1e9, cache_read_input_tokens: 1e9, cache_creation_input_tokens: 1e9 },
    models: ['claude-fable-5'],
  };
  assert.equal(checkBudget(rawHeavy, cls), null, 'must not re-derive a total from raw');
  // The two consumers now read DIFFERENT fields off the same reading, and that separation is
  // the point: `est_tokens` is spend (this function), `live_context` is current context
  // (planRevival). Neither may be substituted for the other, so the same object that trips
  // the breaker on spend must not move the revival verdict, and vice versa.
  assert.equal(planRevival({ attempts: 0 }, { ...overCap, live_context: 10 }, cfg), 'resume', 'a spend trip is not a context verdict');
  assert.equal(planRevival({ attempts: 0 }, { ...rawHeavy, live_context: 800_000 }, cfg), 'fresh');
  assert.equal(checkBudget({ est_tokens: 10, turns: 1, live_context: 999_999 }, cls), null, 'live context cannot trip the breaker');
  // Turns come from `turns`, not from models[].length or a raw row count.
  assert.equal(checkBudget({ ...overCap, est_tokens: 0, turns: 1, models: new Array(30).fill('m') }, cls), null);
  assert.equal(checkBudget({ ...overCap, est_tokens: 0, turns: 10, models: ['m'] }, cls), 'trip');
  // Keys tokens.mjs adds later must not change a verdict or break the read. The last two
  // are adversarial on purpose: a versioned twin of the field this function judges, and a
  // key named like a CAP sitting on the usage object rather than on the class.
  assert.equal(checkBudget({ est_tokens: 500, turns: 1, deviation: {}, whatever_v2: [1], est_tokens_v2: 9e9, tokens_cap: 0 }, cls), null);
  // A usage object that lost the field it judges is a contract violation in BOTH consumers —
  // `readUsage` always reports both, so 0 here would be a number nobody measured. Each
  // consumer names ITS OWN field: a spend-only reading is not a context reading.
  assert.throws(() => planRevival({ attempts: 0 }, {}, cfg), /live_context is missing/);
  assert.throws(() => planRevival({ attempts: 0 }, { est_tokens: 5_000_000, turns: 3 }, cfg), /live_context is missing/);
  assert.throws(() => planRevival({ attempts: 0 }, 'lots', cfg), /readUsage\(\) object or null/);
  // The mistake that shape makes possible, and it is a real one: `readDirUsage` reports
  // `est_tokens` for a whole directory but DELETES `live_context`, because a directory has no
  // single live context. Handing that aggregate to a per-session revival decision is now
  // refused by name — under the old comparison it read as a perfectly good spend number.
  const dirReading = { turns: 9, est_tokens: 5_000_000, models: [], raw: {}, dir: '/x', transcripts: 3, bad_lines: 0 };
  assert.throws(() => planRevival({ attempts: 0 }, dirReading, cfg), /live_context is missing/);
  // And a reading whose fields live on a prototype is not a reading: read with
  // Object.hasOwn, so a forged usage can zero neither the breaker nor the resume guard.
  assert.throws(() => checkBudget(Object.create({ est_tokens: 0, turns: 0 }), cls), /usage\.est_tokens is missing/);
  assert.throws(() => checkBudget(Object.create({ turns: 0 }, { est_tokens: { value: 0, enumerable: true } }), cls), /usage\.turns is missing/);
  assert.throws(() => planRevival({ attempts: 0 }, Object.create({ live_context: 0 }), cfg), /live_context is missing/);
});

test('tripPath names <SOMA_HOME>/leads/<id>/BUDGET_TRIPPED and refuses an id that could leave it', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'soma-wd-'));
  const saved = process.env.SOMA_HOME;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (saved === undefined) delete process.env.SOMA_HOME;
    else process.env.SOMA_HOME = saved;
  });
  process.env.SOMA_HOME = home;
  const { tripPath } = await import('../bin/lib/wd/budget.mjs?trip-' + Date.now());
  // The path the PreToolUse gate hook (bin/hooks/lead-gate.mjs) probes on every tool
  // call, for the lead *and* its teammates. Get it wrong and the breaker has no teeth.
  assert.equal(tripPath('task-1'), join(home, 'leads', 'task-1', 'BUDGET_TRIPPED'));
  assert.equal(tripPath('constructor'), join(home, 'leads', 'constructor', 'BUDGET_TRIPPED')); // a legal task id
  for (const id of PROTO_KEYS.filter((k) => k !== 'constructor')) {
    assert.throws(() => tripPath(id), /task id/, `${id} is not a legal task id`);
  }
  for (const id of ['../../etc', 'a/b', 'a.b', '', 'CR-1', null, undefined, 42]) {
    assert.throws(() => tripPath(id), /task id/, `${JSON.stringify(id)} must never name a path`);
  }
});

test('warnPath names <SOMA_HOME>/leads/<id>/BUDGET_WARNED, beside the trip flag, and refuses the same ids', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'soma-wd-'));
  const saved = process.env.SOMA_HOME;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (saved === undefined) delete process.env.SOMA_HOME;
    else process.env.SOMA_HOME = saved;
  });
  process.env.SOMA_HOME = home;
  const { warnPath } = await import('../bin/lib/wd/budget.mjs?warn-' + Date.now());
  // The watchdog writes this at the 80% verdict and the gate hook renames it to
  // BUDGET_WARNED.delivered on the lead's next allowed tool call. The gate derives the path on
  // its own (it imports nothing), so a flag written anywhere else is a warning nobody delivers.
  assert.equal(warnPath('task-1'), join(home, 'leads', 'task-1', 'BUDGET_WARNED'));
  assert.equal(warnPath('constructor'), join(home, 'leads', 'constructor', 'BUDGET_WARNED'));
  // The refusal names its own function, so an operator reading WATCHDOG_ERROR can tell the two
  // flags apart.
  const refused = { name: 'TypeError', message: /^warnPath: .* is not a legal task id/ };
  for (const id of PROTO_KEYS.filter((k) => k !== 'constructor')) {
    assert.throws(() => warnPath(id), refused, `${id} is not a legal task id`);
  }
  for (const id of ['../../etc', 'a/b', 'a.b', '', 'CR-1', null, undefined, 42]) {
    assert.throws(() => warnPath(id), refused, `${JSON.stringify(id)} must never name a path`);
  }
});

// ─────────────────────────── backpressure ───────────────────────────

test('detectStorm needs two DISTINCT leads, not two signals from one', async () => {
  const { detectStorm } = await import('../bin/lib/wd/backpressure.mjs?distinct-' + Date.now());
  // "matches in two distinct leads' panes within one tick" (design §11). Two scrapes of
  // one pane is one lead's opinion — and a lead may well be working a ticket about 429 logs.
  assert.equal(detectStorm([{ lead: 'a', paneHit: true }, { lead: 'a', paneHit: true }]).frozen, false);
  assert.equal(detectStorm(PROTO_KEYS.map((lead) => ({ lead, paneHit: true }))).frozen, true);
  assert.equal(detectStorm([{ lead: '__proto__', paneHit: true }, { lead: '__proto__', paneHit: true }]).frozen, false);
  assert.equal(detectStorm([{ lead: 'constructor', paneHit: true }, { lead: 'toString', paneHit: true }]).frozen, true);
  assert.equal(detectStorm([{ lead: '__proto__', paneHit: true, transcriptHit: true }]).frozen, true);
  // The transcript stanza must corroborate its OWN lead's pane, not somebody else's.
  assert.equal(detectStorm([{ lead: 'a', paneHit: true }, { lead: 'b', transcriptHit: true }]).frozen, false);
  assert.equal(detectStorm([{ lead: 'a', transcriptHit: true }]).frozen, false);
  // ...and it must arrive on the SAME ROW. One row per lead is the documented contract
  // (see the signature): corroboration split across two rows for one lead does not
  // freeze, where the same evidence combined into one row does. Off-contract, and it
  // fails toward not-freezing — but pinned here so whoever writes the pane scraper reads
  // the contract off a test rather than discovering it as a missed storm.
  assert.equal(detectStorm([{ lead: 'a', paneHit: true }, { lead: 'a', transcriptHit: true }]).frozen, false);
  assert.equal(detectStorm([{ lead: 'a', paneHit: true, transcriptHit: true }]).frozen, true);
  // Evidence is one row per corroborating lead, deduped, in first-seen order, and empty
  // when nothing froze — `soma thaw` reads it, and a false freeze stalls all ten leads.
  const storm = detectStorm([{ lead: 'b', paneHit: true }, { lead: 'a', paneHit: true }, { lead: 'b', paneHit: true }]);
  assert.deepEqual(storm.evidence, [{ lead: 'b' }, { lead: 'a' }]);
  assert.deepEqual(detectStorm([{ lead: 'a', paneHit: true }]).evidence, []);
});

test('detectStorm fails toward not-freezing on unusable input', async () => {
  const { detectStorm } = await import('../bin/lib/wd/backpressure.mjs?tolerant-' + Date.now());
  // Deliberate asymmetry: a throwing detector would freeze admission on every tick, so
  // garbage from the scraper reads as "no evidence this tick" and the next tick re-reads.
  for (const bad of [undefined, null, 'a', 42, { lead: 'a', paneHit: true }]) {
    assert.equal(detectStorm(bad).frozen, false);
    assert.deepEqual(detectStorm(bad).evidence, []);
  }
  // An unattributable pane hit cannot corroborate anything, and two of them are not
  // two leads — otherwise a scraper that forgot `lead` would freeze the whole fleet.
  assert.equal(detectStorm([{ paneHit: true }, { paneHit: true }]).frozen, false);
  // ...but that line alone is satisfied by the DEDUP, not by the attribution guard:
  // `Set.add(undefined)` twice is size 1, so it passes with the guard deleted too. These
  // are the inputs that can tell the difference, and every one of them freezes all ten
  // leads (until an operator runs `soma thaw`) the moment that guard goes:
  assert.equal(detectStorm([{ paneHit: true, transcriptHit: true }]).frozen, false);          // corroborates nobody
  assert.equal(detectStorm([{ paneHit: true }, { lead: 'a', paneHit: true }]).frozen, false);  // one real lead, not two
  assert.equal(detectStorm([{ lead: '', paneHit: true, transcriptHit: true }]).frozen, false); // '' is not a lead id
  assert.equal(detectStorm([{ lead: null, paneHit: true }, { lead: 'a', paneHit: true }]).frozen, false);
  // Every unattributable shape, in both corroboration paths, and out of `evidence` too —
  // `soma thaw` reads `evidence`, and `{}` / `{lead: null}` name no lead to ignore.
  for (const lead of [undefined, null, '', 42, {}, ['a']]) {
    const label = `lead: ${JSON.stringify(lead)}`;
    assert.deepEqual(detectStorm([{ lead, paneHit: true, transcriptHit: true }]), { frozen: false, evidence: [] }, label);
    assert.deepEqual(detectStorm([{ lead, paneHit: true }, { lead, paneHit: true }]), { frozen: false, evidence: [] }, label);
    assert.deepEqual(detectStorm([{ lead, paneHit: true }, { lead: 'a', paneHit: true }]), { frozen: false, evidence: [] }, label);
  }
  assert.equal(detectStorm([null, { lead: 'a', paneHit: true }, 7, { lead: 'b', paneHit: true }]).frozen, true);
  // Tolerance is a PROPERTY of this function, not a list of shapes it happens to know:
  // an adversarial row throws through the enumerated guards, and a throw here freezes
  // admission every tick, permanently — worse than the false freeze the guards prevent.
  const throwingGetter = [{ lead: 'a', get paneHit() { throw new Error('boom'); } }];
  assert.deepEqual(detectStorm(throwingGetter), { frozen: false, evidence: [] });
  assert.deepEqual(detectStorm([new Proxy({}, { get() { throw new Error('boom'); } })]), { frozen: false, evidence: [] });
  const throwingIterator = [{ lead: 'a', paneHit: true }];
  throwingIterator[Symbol.iterator] = () => { throw new Error('boom'); };
  assert.deepEqual(detectStorm(throwingIterator), { frozen: false, evidence: [] });
  // Evidence gathered BEFORE an unreadable row is real evidence and still counts; what
  // comes after is lost, which fails toward not-freezing — this module's safe direction.
  const tail = [{ lead: 'a', paneHit: true }, { lead: 'b', paneHit: true }, { get paneHit() { throw new Error('boom'); } }];
  assert.deepEqual(detectStorm(tail), { frozen: true, evidence: [{ lead: 'a' }, { lead: 'b' }] });
  const head = [{ get paneHit() { throw new Error('boom'); } }, { lead: 'a', paneHit: true }, { lead: 'b', paneHit: true }];
  assert.deepEqual(detectStorm(head), { frozen: false, evidence: [] });
  // `signals` is an ARRAY; any other container is not evidence. Without this the array
  // check is indistinguishable from the catch above, which iterates a Set quite happily.
  assert.deepEqual(detectStorm(new Set([{ lead: 'a', paneHit: true }, { lead: 'b', paneHit: true }])), { frozen: false, evidence: [] });
});

// ─────────────────────────── admission ───────────────────────────

test('nextAdmission holds the stagger for stagger_s SECONDS, at the boundary', async () => {
  const { nextAdmission } = await import('../bin/lib/wd/admission.mjs?stagger-' + Date.now());
  const cfg = { max_leads: 10, stagger_s: 90 };
  const fleet = { tasks: [{ id: 'a', status: 'queued' }], last_spawn_at: 1_000_000 };
  const at = (elapsedMs) => nextAdmission(fleet, cfg, fleet.last_spawn_at + elapsedMs, false);
  assert.equal(at(90_000 - 1), null, 'one millisecond short of the stagger must still hold');
  assert.equal(at(90_000), 'a', 'exactly at the stagger, admission opens');
  assert.equal(at(90_000 + 1), 'a');
  assert.equal(at(90), null, 'stagger_s is seconds — 90 ms elapsed is not 90 s');
  assert.equal(at(-1), null, 'a future last_spawn_at holds admission, never opens it');
  assert.equal(nextAdmission(fleet, { ...cfg, stagger_s: 0 }, fleet.last_spawn_at, false), 'a'); // 0 = no stagger
});

test('nextAdmission reads last_spawn_at 0 as a timestamp and absent as never-spawned', async () => {
  const { nextAdmission } = await import('../bin/lib/wd/admission.mjs?epoch-' + Date.now());
  const cfg = { max_leads: 10, stagger_s: 90 };
  const tasks = [{ id: 'a', status: 'queued' }];
  // `last_spawn_at: 0` is the synthetic fleet every watchdog test writes; a falsy check
  // would skip the stagger for it and hide an inverted comparison behind a passing suite.
  assert.equal(nextAdmission({ tasks, last_spawn_at: 0 }, cfg, 10_000, false), null);
  assert.equal(nextAdmission({ tasks, last_spawn_at: 0 }, cfg, 90_000, false), 'a');
  assert.equal(nextAdmission({ tasks, last_spawn_at: null }, cfg, 0, false), 'a');   // never spawned
  assert.equal(nextAdmission({ tasks }, cfg, 0, false), 'a');
  assert.throws(() => nextAdmission({ tasks, last_spawn_at: 'soon' }, cfg, 10, false), /last_spawn_at/);
  assert.throws(() => nextAdmission({ tasks, last_spawn_at: 0 }, cfg, 'now', false), /now/);
});

test('nextAdmission refuses dead stagger config and a non-boolean freeze flag', async () => {
  const { nextAdmission } = await import('../bin/lib/wd/admission.mjs?config-' + Date.now());
  const fleet = { tasks: [{ id: 'a', status: 'queued' }], last_spawn_at: 1000 };
  // A renamed/dropped key would make `now - last < NaN` false and spawn ten leads into
  // the same second. Loud on the first tick, storm or no storm.
  assert.throws(() => nextAdmission(fleet, { max_leads: 10 }, 2000, false), /stagger_s/);
  assert.throws(() => nextAdmission(fleet, { max_leads: 10, stagger_s: '' }, 2000, false), /stagger_s/);
  assert.throws(() => nextAdmission(fleet, { max_leads: 10 }, 2000, true), /stagger_s/);
  assert.equal(nextAdmission(fleet, { max_leads: 10, stagger_s: '90' }, 1000 + 90_000, false), 'a');
  // `nextAdmission(fleet, cfg, now, storm)` instead of `storm.frozen` is one keystroke
  // away and would freeze admission forever, silently.
  assert.throws(() => nextAdmission(fleet, { max_leads: 10, stagger_s: 90 }, 2000, { frozen: false }), /boolean/);
  assert.throws(() => nextAdmission(fleet, { max_leads: 10, stagger_s: 90 }, 2000, undefined), /boolean/);
});

test('nextAdmission delegates capacity to fleet.admit, which counts only spawned leads', async () => {
  const { nextAdmission } = await import('../bin/lib/wd/admission.mjs?cap-' + Date.now());
  const cfg = { max_leads: 2, stagger_s: 90 };
  const full = { tasks: [{ id: 'a', status: 'spawned' }, { id: 'b', status: 'spawned' }, { id: 'c', status: 'queued' }], last_spawn_at: null };
  assert.equal(nextAdmission(full, cfg, 1e6, false), null, 'at capacity');
  const freed = { ...full, tasks: [{ id: 'a', status: 'done' }, { id: 'b', status: 'blocked' }, { id: 'c', status: 'queued' }] };
  assert.equal(nextAdmission(freed, cfg, 1e6, false), 'c', 'done and blocked hold no slot');
  assert.equal(nextAdmission({ tasks: [{ id: 'a', status: 'done' }], last_spawn_at: null }, cfg, 1e6, false), null);
  assert.throws(() => nextAdmission(full, { stagger_s: 90 }, 1e6, false), /max_leads/);
});

test('nextAdmission names a malformed fleet.tasks rather than let fleet.admit trip over it', async () => {
  const { nextAdmission } = await import('../bin/lib/wd/admission.mjs?tasks-' + Date.now());
  const cfg = { max_leads: 2, stagger_s: 90 };
  const err = (fleet, frozen = false) => {
    try { nextAdmission(fleet, cfg, 1000, frozen); } catch (e) { return e.message; }
    throw new Error('expected nextAdmission to throw');
  };
  // Matched on the guard's OWN wording. `fleet.admit` reaches `tasks` through
  // `countActive`, so without the guard `{tasks: 'none'}` throws
  // `fleet.tasks.filter is not a function` — which contains "fleet.tasks", so a looser
  // /fleet\.tasks/ would be satisfied by the very absence it is meant to catch.
  for (const bad of [null, undefined, 'none', 42, {}, new Set(), new Map()]) {
    assert.match(err({ tasks: bad, last_spawn_at: null }), /nextAdmission: fleet\.tasks must be an array/);
    assert.doesNotMatch(err({ tasks: bad, last_spawn_at: null }), /is not a function|Cannot read properties/);
  }
  assert.match(err({ tasks: null }), /must be an array, got null/);
  assert.match(err({}), /must be an array, got undefined/);
  assert.match(err(null), /must be an array, got undefined/);
  // Loud on the first tick, storm or no storm: a malformed checkpoint is not something to
  // discover after a thaw, and every branch of this function needs `tasks`.
  assert.match(err({ tasks: null }, true), /nextAdmission: fleet\.tasks must be an array/);
  assert.equal(nextAdmission({ tasks: [], last_spawn_at: null }, cfg, 1000, false), null);   // empty is legal
});

// ─────────────────────────── settle ───────────────────────────

test('settlement: an empty fleet has not drained, and an unknown status is not terminal', async () => {
  const { settlement } = await import('../bin/lib/wd/settle.mjs?unknown-' + Date.now());
  const cfg = { settle_minutes: 30 };
  const hour = 60 * 60 * 1000;
  // Never started is not the same as finished: `[].every()` is true, and firing
  // FLEET_DRAINED at `soma up` would digest-and-toast a fleet with no work in it.
  assert.equal(settlement({ tasks: [] }, 0, hour, cfg), null);
  // A status this soma does not know — a hand-edited checkpoint, a newer soma's enum, or
  // an Object.prototype name against a truthiness-indexed set — is never counted as
  // finished or rested. Declaring a fleet drained over a live lead is unrecoverable.
  assert.equal(settlement({ tasks: PROTO_KEYS.map((status) => ({ status })) }, 0, hour, cfg), null);
  for (const status of [...PROTO_KEYS, 'paused', undefined]) {
    assert.equal(settlement({ tasks: [{ status: 'done' }, { status }] }, 0, hour, cfg), null, `${status} is not terminal`);
  }
  assert.equal(settlement({ tasks: [{ status: 'done' }, { status: 'spawned' }] }, 0, hour, cfg), null);
  assert.equal(settlement({ tasks: [{ status: 'done' }, { status: 'queued' }] }, 0, hour, cfg), null);
  // A hole in `tasks` is an unknown status, not a crash — same reason as `reconcile`: a
  // throw costs the verdict entirely, and this one ends the run.
  assert.equal(settlement({ tasks: [{ status: 'done' }, null] }, 0, hour, cfg), null);
  assert.equal(settlement({ tasks: [null] }, 0, hour, cfg), null);
  assert.equal(settlement({ tasks: [{ status: 'skipped' }] }, 0, 0, cfg), 'drained');
  assert.equal(settlement({ tasks: [{ status: 'done' }, { status: 'blocked' }] }, 0, hour, cfg), 'settled');
});

test('settlement: the quiet window is settle_minutes MINUTES, and dead config is refused', async () => {
  const { settlement } = await import('../bin/lib/wd/settle.mjs?window-' + Date.now());
  const cfg = { settle_minutes: 30 };
  const rested = { tasks: [{ status: 'done' }, { status: 'blocked' }] };
  const win = 30 * 60 * 1000;
  assert.equal(settlement(rested, 1_000_000, 1_000_000 + win - 1, cfg), null);
  assert.equal(settlement(rested, 1_000_000, 1_000_000 + win, cfg), 'settled');
  assert.equal(settlement(rested, 1_000_000, 1_000_000 + 30, cfg), null, 'settle_minutes is minutes, not ms');
  assert.equal(settlement(rested, 1_000_000, 999_999, cfg), null, 'clock skew never settles a fleet');
  assert.equal(settlement(rested, 0, 0, { settle_minutes: 0 }), 'settled', '0 minutes = settle as soon as it rests');
  // Drained outranks settled: it is the stronger statement and needs no quiet window.
  assert.equal(settlement({ tasks: [{ status: 'done' }] }, 1e12, 0, cfg), 'drained');
  // A lost key would leave the 7-done-3-blocked fleet reporting nothing, forever.
  assert.throws(() => settlement(rested, 0, win, {}), /settle_minutes/);
  assert.throws(() => settlement(rested, 0, win, { settle_min: 30 }), /settle_minutes/);
  assert.throws(() => settlement(rested, null, win, cfg), /lastEventTs/);
  assert.throws(() => settlement(rested, 0, undefined, cfg), /now/);
  assert.throws(() => settlement({ tasks: 'none' }, 0, win, cfg), /fleet\.tasks/);
  // Both timestamps are validated EAGERLY, before the `drained` branch that needs
  // neither. The cost is real and deliberate (see the module header): an unreadable
  // `lastEventTs` suppresses a FLEET_DRAINED and its final digest rather than answer on a
  // tick whose clock cannot be read. Pinned so the trade stays a decision, not a drift.
  const drained = { tasks: [{ status: 'done' }, { status: 'skipped' }] };
  assert.equal(settlement(drained, 0, 0, cfg), 'drained');
  assert.throws(() => settlement(drained, null, win, cfg), /settlement: lastEventTs/);
  assert.throws(() => settlement(drained, undefined, win, cfg), /settlement: lastEventTs/);
  assert.throws(() => settlement(drained, 0, undefined, cfg), /settlement: now/);
  assert.throws(() => settlement(drained, 0, win, {}), /settle_minutes/);
});

// ─────────────────────────── backpressure: the record ───────────────────────────

/** A throwaway state root with `state/`, made current; the previous root is restored after `t`. */
const bpHome = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'soma-bp-'));
  const saved = process.env.SOMA_HOME;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (saved === undefined) delete process.env.SOMA_HOME;
    else process.env.SOMA_HOME = saved;
  });
  process.env.SOMA_HOME = home;
  mkdirSync(join(home, 'state'), { recursive: true });
  return home;
};
/** The sample clock, in ms: the limit fixture's `resetsAt` 1440433800 s = 2015-08-24T16:30:00Z. */
const T0 = 1_440_433_800_000;

test('readBackpressure answers three states — no file, a record, unreadable — and never throws', async (t) => {
  const home = bpHome(t);
  const { backpressurePath, readBackpressure } = await import('../bin/lib/wd/backpressure.mjs?read-' + Date.now());
  assert.equal(backpressurePath(), join(home, 'state', 'backpressure.json'), 'the one spelling, under THIS root');
  // 1. Absent is "not frozen" and carries no `unreadable`: the bus has always rendered it so.
  assert.deepEqual(readBackpressure(), { active: false });
  // 2. A record reads back as written. The reader does not reshape; the bus fold does.
  writeFileSync(backpressurePath(), JSON.stringify({ active: true, reason: 'storm', since: T0, until: null }));
  assert.deepEqual(readBackpressure(), { active: true, reason: 'storm', since: T0, until: null });
  writeFileSync(backpressurePath(), JSON.stringify({ active: true, reason: 'storm' }));
  assert.equal(readBackpressure().active, true, 'a partial hand-written record is still a record');
  // 3. Unreadable is the THIRD state, not a quiet `{active: false}`: torn JSON, the wrong shape, EISDIR.
  for (const bad of ['{ not json', '', '[]', '"x"', 'null', '42', '{}', '{"active":"yes"}', '{"active":1}']) {
    writeFileSync(backpressurePath(), bad);
    const r = readBackpressure();
    assert.equal(r.active, false, `active for ${JSON.stringify(bad)}`);
    assert.equal(r.unreadable, true, `unreadable for ${JSON.stringify(bad)}`);
    assert.equal(typeof r.why, 'string', `why for ${JSON.stringify(bad)}`);
  }
  rmSync(backpressurePath());
  mkdirSync(backpressurePath());
  const dir = readBackpressure();
  assert.equal(dir.unreadable, true);
  assert.match(dir.why, /EISDIR/, 'a non-ENOENT read error names its code');
  // `why` reaches a model through soma_status's dep and an operator through the CLI: no absolute path.
  assert.doesNotMatch(dir.why, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('writeBackpressure writes the four-field record and nothing else; clearBackpressure writes exactly {active:false}', async (t) => {
  const home = bpHome(t);
  const { backpressurePath, clearBackpressure, readBackpressure, writeBackpressure } = await import('../bin/lib/wd/backpressure.mjs?write-' + Date.now());
  const rec = writeBackpressure({ active: true, reason: 'storm', since: T0, until: null, evidence: [{ lead: 'a' }] });
  // Field by field, as `lease.writeLease` writes: `evidence` is neither the orchestrator's business nor small.
  assert.deepEqual(rec, { active: true, reason: 'storm', since: T0, until: null });
  assert.deepEqual(readBackpressure(), { active: true, reason: 'storm', since: T0, until: null });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(backpressurePath(), 'utf8'))), ['active', 'reason', 'since', 'until']);
  // The OTHER writer — the limits phase's spend cap — comes through the same function, so "the two
  // writers produce the same shape" is a property of the writer, not a coincidence of two call sites.
  writeBackpressure({ active: true, reason: 'org_level_disabled_until', since: T0 + 1, until: null });
  assert.deepEqual(Object.keys(readBackpressure()), ['active', 'reason', 'since', 'until']);
  // Any non-empty reason with a known end: the writer vets shape, not vocabulary — which reasons the
  // tick writes (`storm`, `org_level_disabled_until`) is the tick's business, not this function's.
  writeBackpressure({ active: true, reason: 'org_spend_cap_reached', since: T0 + 2, until: T0 + 3 });
  assert.deepEqual(readBackpressure(), { active: true, reason: 'org_spend_cap_reached', since: T0 + 2, until: T0 + 3 });
  assert.deepEqual(clearBackpressure(), { active: false });
  assert.equal(readFileSync(backpressurePath(), 'utf8'), '{\n  "active": false\n}\n', 'the cleared record is the contract\'s, byte for byte');
  assert.deepEqual(readBackpressure(), { active: false });
  // A state root wiped under a running watchdog must not weld the writer shut: `withFleetLock`
  // creates `state/` on the way in to the lock, which is why (as in `writeLease`) there is no
  // second ENOENT self-heal here.
  rmSync(join(home, 'state'), { recursive: true, force: true });
  writeBackpressure({ active: true, reason: 'storm', since: T0, until: null });
  assert.equal(readBackpressure().active, true, 'written into a re-created state/');
});

test('writeBackpressure refuses an off-shape record by field, and writes nothing when it refuses', async (t) => {
  const home = bpHome(t);
  const { MIN_EPOCH_MS, STORM_REASON, backpressurePath, writeBackpressure } = await import('../bin/lib/wd/backpressure.mjs?shape-' + Date.now());
  assert.equal(MIN_EPOCH_MS, 1e12, 'rotation-events.mjs\'s ONE bound, re-exported here: the builders and the writer refuse the same number because it is the same binding');
  assert.equal(STORM_REASON, 'storm', 'the reason the tick writes and soma thaw refuses — one spelling, exported');
  const ok = { active: true, reason: 'storm', since: T0, until: null };
  for (const [bad, re] of [
    [{ ...ok, active: false }, /active must be true/],
    [{ reason: 'storm', since: T0, until: null }, /active must be true/],
    [{ ...ok, reason: '' }, /reason must be a non-empty string/],
    [{ ...ok, reason: 7 }, /reason must be a non-empty string/],
    // The units bug, refused at the writer: `quotaLimits.resetsAt` arrives in SECONDS (1440433800 is
    // the fixture's value) and the classifier is the one conversion site — a seconds value here
    // would be a record every reader renders as January 1970 and every comparison with Date.now()
    // gets wrong.
    [{ ...ok, since: 1_440_433_800 }, /since must be epoch MILLISECONDS/],
    [{ ...ok, since: 'now' }, /since must be epoch MILLISECONDS/],
    [{ active: true, reason: 'storm', since: T0 }, /until must be epoch MILLISECONDS .* or null/],
    [{ ...ok, until: 1_440_433_800 }, /until must be epoch MILLISECONDS/],
    [null, /state must be an object/], [[], /state must be an object/], ['frozen', /state must be an object/],
  ]) {
    assert.throws(() => writeBackpressure(bad), re, JSON.stringify(bad));
    assert.equal(existsSync(backpressurePath()), false, `nothing written for ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(readdirSync(join(home, 'state')).filter((n) => n.endsWith('.tmp')), [], 'and no scratch either');
});

test('the record is published by tmp+rename under the fleet lock, and the lock is released', async (t) => {
  const home = bpHome(t);
  const { backpressurePath, clearBackpressure, writeBackpressure } = await import('../bin/lib/wd/backpressure.mjs?lock-' + Date.now());
  const rec = { active: true, reason: 'storm', since: T0, until: null };
  writeBackpressure(rec);
  const ino = statSync(backpressurePath()).ino;
  writeBackpressure({ ...rec, since: T0 + 1 });
  // `writeFileSync` reuses the inode; a rename installs a new one. That is what lets the lock-free
  // readers (`soma_status`, the CLI) see a whole old record or a whole new one, never half.
  assert.notEqual(statSync(backpressurePath()).ino, ino, 'published by rename, not truncate-and-write');
  assert.deepEqual(readdirSync(join(home, 'state')).filter((n) => n.endsWith('.tmp')), [], 'tmp+rename leaves no scratch behind');
  assert.equal(existsSync(join(home, 'state', 'fleet.lock')), false, 'every write releases the fleet lock');
  clearBackpressure();
  assert.equal(existsSync(join(home, 'state', 'fleet.lock')), false, 'and so does every clear');

  // A live holder is waited on, then refused — never written past. This process's own pid is a
  // live pid the lock instance has NOT recorded as held, so it reads as another writer.
  writeFileSync(join(home, 'state', 'fleet.lock'), `${process.pid}\n`);
  const before = readFileSync(backpressurePath(), 'utf8');
  // Timed, because `timeoutMs` is otherwise unfalsifiable: a writer that never forwarded it would
  // still throw /fleet.lock/ — just after `withFleetLock`'s 5 s default instead of 150 ms, and both
  // `assert.throws` below would stay green through the whole regression. Measured: the pair takes
  // ~300 ms when the option is forwarded and >10 s when it is not, so 3 s is a 10x-either-way bound.
  const t0 = Date.now();
  assert.throws(() => writeBackpressure({ ...rec, since: T0 + 2 }, { timeoutMs: 150 }), /fleet\.lock/);
  assert.throws(() => clearBackpressure({ timeoutMs: 150 }), /fleet\.lock/);
  assert.ok(Date.now() - t0 < 3000, `timeoutMs must reach withFleetLock; two 150 ms waits took ${Date.now() - t0} ms`);
  assert.equal(readFileSync(backpressurePath(), 'utf8'), before, 'a refused write changed nothing');
  rmSync(join(home, 'state', 'fleet.lock'));

  // Re-entrant with `updateFleet`, so a caller that changes the fleet and the freeze in one breath
  // does not queue behind itself. `fleet.mjs` is imported WITHOUT a tag on purpose: it must be the
  // instance `backpressure.mjs` itself imported, or the two copies see each other's lock as a stranger's.
  const { updateFleet } = await import('../bin/lib/fleet.mjs');
  assert.equal(updateFleet(() => { writeBackpressure(rec, { timeoutMs: 150 }); return 'both'; }), 'both');
});

test('MIN_EPOCH_MS is rotation-events.mjs\'s binding re-exported here, not a copy of its value', async () => {
  // The value assertion in the shape test above says "…because it is the same binding" — and it
  // tests the VALUE. No value assertion can tell a re-export from a copy: replacing the import
  // with `const MIN_EPOCH_MS = 1e12;` leaves the whole suite green (measured, 1250/1250). That
  // copy IS the drift — the event builder and the record writer drifting apart on units, which is
  // the one thing "defined ONCE, there" exists to prevent — so the claim is pinned where it
  // lives: in the source, in the same idiom `soma-bus.mjs`'s path pin uses.
  const BP_SRC = readFileSync(new URL('../bin/lib/wd/backpressure.mjs', import.meta.url), 'utf8');
  assert.match(BP_SRC, /from '\.\/rotation-events\.mjs'/,
    'the bound must come from the module that defines it, by that exact specifier — a `?query` copy is a second module instance');
  assert.doesNotMatch(BP_SRC, /\bMIN_EPOCH_MS\b[ \t]*=(?!=)/,
    'this module never defines its own bound: it imports rotation-events.mjs\'s and re-exports it');
  // The control, and it is not decoration: the assertion above is a claim about an ABSENCE, and an
  // absence proves nothing unless the same pattern is shown to fire where the definition really is.
  // A typo in it would otherwise read as full coverage.
  const RE_SRC = readFileSync(new URL('../bin/lib/wd/rotation-events.mjs', import.meta.url), 'utf8');
  assert.match(RE_SRC, /\bMIN_EPOCH_MS\b[ \t]*=(?!=)/,
    'the definition pattern must fire on the module that owns the ONE definition');
});
