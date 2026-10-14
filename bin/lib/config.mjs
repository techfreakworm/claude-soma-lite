/**
 * `soma.json` — the governance dials, and the loader that merges them over DEFAULTS.
 *
 * DEFAULTS below is the constitution: admission (`max_leads`, `stagger_s`, `tick_ms`),
 * the reaper windows (`linger_minutes`, `blocked_slot_minutes`, `stall_minutes`,
 * `settle_minutes`), the per-harness budget classes, and the two security allowlists
 * (`teammate_mcp_allow`, `env_allow`). Every value in it is an operator decision that
 * something downstream reads *by name*, so the literal is the spec — renaming a key
 * here silently disarms whichever governor read it.
 *
 * Three properties are load-bearing, and each one is a test in `test/config.test.mjs`:
 *
 * - **soma.json is an overlay, not a snapshot.** The file holds only what the operator
 *   changed; code owns everything else. `writeConfig` therefore persists the *patched
 *   overlay*, not the merged result. Writing the merged result would pin today's
 *   defaults into the file forever, so a later soma that lowers `max_leads` after a
 *   rate-limit incident, or retunes a budget class, would be silently shadowed by a
 *   snapshot nobody remembers writing. Unknown keys are preserved for the mirror-image
 *   reason `readFleet` spreads them: an older soma must not eat a newer file's settings.
 *   The single exception is `LEGACY_KEYS` — keys soma itself retired, which are stripped
 *   from the *merged config* (never from the file) and warned about, because a retired key
 *   is not an unknown one: it has a known consumer and known-wrong units. See its doc.
 *
 * - **A merged config shares no structure with DEFAULTS.** `loadConfig` deep-copies, so
 *   a consumer that normalizes a value in place cannot rewrite the defaults for every
 *   later caller in the same process — the watchdog calls `loadConfig()` on every 30 s
 *   tick and would otherwise be reading another module's edits. DEFAULTS is deep-frozen
 *   so the attempt throws instead of taking effect.
 *
 * - **An unreadable soma.json throws.** Reading `max_leads: 3` as 10 because the file
 *   lost a brace is the worst outcome on the menu: the operator's cap is gone and the
 *   fleet ramps to ten leads anyway. That is only safe to insist on because soma's own
 *   writes are tmp+rename, so soma can never be the thing that truncates the file. A
 *   `seats` that is not an array throws the same way (see `validated`).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { p } from './paths.mjs';

/** Deep-freeze `value` in place and return it. Frozen ⇒ a stray write throws. */
const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object') for (const k of Object.keys(value)) deepFreeze(value[k]);
  return Object.freeze(value);
};

export const DEFAULTS = deepFreeze({
  max_leads: 10,               // decision D3
  stagger_s: 90,
  tick_ms: 30000,
  linger_minutes: 45,
  blocked_slot_minutes: 120,
  stall_minutes: 20,
  settle_minutes: 30,
  team_size_max: 3,
  teammate_effort: 'inherit',  // decision D2
  notify_policy: 'full',
  tested_claude: { min: '2.1.178', max: '2.1.999' },
  // Revival guard, expressed as a FRACTION of the model's context window rather than an
  // absolute. MEASURED: the absolute this replaces (`resume_token_guard: 200000`) was a *spend*
  // number read as a *context* number, so against the ~1M window it fired at 20% full and
  // refused a resume for 44% of real sessions — "resume first" was dead policy. An absolute
  // cannot be right for two window sizes at once; a fraction can. Derive the number with
  // `resumeContextLimit(cfg)` from `lib/tokens.mjs`, never by multiplying these by hand.
  // 0.7 -> 700,000 here. Compaction fires at ~994k and lands at ~80k (7-9%, eight events), so
  // 0.7 leaves ~300k of working headroom and a lead that already compacted resumes cheaply.
  resume_context_fraction: 0.7,
  // ESTABLISHED for the pinned model, having been inferred from a different one: this figure was
  // chosen off fable-5 (observed to 833,935, never above 900k across 3,508 real turns, never
  // compacting). Leads are pinned to `opus` now, both opus models were observed reaching ~999.6k,
  // and claude 2.1.x reports `contextWindow: 1000000` for claude-opus-5 outright (measured
  // 2026-08-17). If a lead is ever pinned to a smaller-window model, change this, not the fraction.
  resume_context_window: 1000000,
  // Budget classes. WHAT IS MEASURED AND WHAT IS ESTIMATED, because an inherited number nobody
  // had checked is what made every one of these wrong before:
  //
  // - MEASURED, n=21 real one-ticket sessions: est_tokens median 3,745,468, p95 7,629,704,
  //   max 8,025,103; turns median 134, max 254. The previous caps (300k/1.5M/2M/3M/500k with
  //   turn_caps 30-80) would have killed 100% of them, on BOTH caps, in every class.
  // - MEASURED: est_tokens ~ turns^1.23, and per-turn cost rises 1.45x within a session. Turns
  //   track spend POORLY, which is why turn_cap is no longer a budget (see below).
  // - ESTIMATED: tokens_cap here is p95-of-population + headroom, then multiplied by ~2.5x
  //   because the meter reads a whole slug DIRECTORY (lead + team), not one session. That
  //   multiplier is an ESTIMATE IN A 1.5x-4x BAND, resting on n=1 directory of the right shape.
  //   IF THE TRUE MULTIPLIER IS 4x, `standard` SHOULD BE 32,000,000, NOT 20,000,000. The
  //   measurement that settles it is in the bring-up procedure: run one real lead on one real
  //   ticket with a real team and report both its own transcript total and its directory total.
  // - Deliberately LOOSE, on the rule that a breaker which never fires is recoverable and one
  //   that fires on every lead is not. Fleet exposure is shown at `soma up` rather than hidden
  //   here; `projectFleetSpend(cfg)` in `lib/tokens.mjs` computes it.
  //
  // - CAVEAT ON `research`, MEASURED AS n=0: **its numbers are a FLOOR, not a calibration.** No
  //   research-shaped session exists in the corpus, so 5,000,000 is "comfortably above the p75
  //   of all sessions" and nothing more. Do not read it as a percentile of anything observed.
  //
  // `turn_cap` IS A RUNAWAY-LOOP BACKSTOP, NOT A BUDGET. It exists to stop a lead spinning in a
  // retry loop, not to price work — `est_tokens ~ turns^1.23` is why turns price work badly. It
  // is deliberately NOT scaled by the directory multiplier, because a lead's own turns do not
  // multiply when it delegates: its teammates have their own.
  //
  // THE RULE, AND IT IS TRUE OF EVERY VALUE BELOW:
  //     turn_cap = 2 x the observed max turn count (254), rounded UP to the next 100  ->  600
  // for every class that has a live backstop. **Deliberately no ladder**, and that is the
  // substantive change rather than an oversight: `est_tokens ~ turns^1.23`, so a per-class turn
  // LADDER only pretends turns price work. Class differentiation belongs in `tokens_cap` and
  // `wall_ms`, which do. A loop is a loop whichever harness is running.
  //
  // - **254** — MEASURED: the max turn count across n=21 real one-ticket sessions (median 134).
  //   Doubling it is the headroom, and it is not generous: the one session in the corpus
  //   structurally identifiable as a *delegating* orchestrator read 254 turns when first
  //   measured and 285 while still running when measured again, so 254 is a FLOOR on the
  //   observed max, not a ceiling. 600 clears it by 2.36x.
  //   THE PREVIOUS VALUES DID NOT CLEAR IT AT ALL: 120/250/300/400 were documented as "~1.3x the
  //   observed max" while measuring 0.47x / 0.98x / 1.18x / 1.57x of it. `standard: 250` sat
  //   UNDER 254 — it would have killed the very session the calibration named as the closest
  //   structural analogue to a delegating lead. A backstop set below the observed maximum is not
  //   a backstop; it is the budget, wearing a backstop's documentation.
  //
  // - THE PROPERTY THAT MAKES IT A BACKSTOP, and it is checked in `test/config.test.mjs` rather
  //   than asserted here in prose: **`tokens_cap` must bind before `turn_cap` at observed cost.**
  //   The implied per-turn allowance `tokens_cap / turn_cap` is 8,333 / 33,333 / 41,667 / 63,333
  //   across the four classes, against a MEASURED directory cost of **~177,000 est_tokens per
  //   LEAD turn** (n=1: the one real lead-shaped directory, 29,918,461 est over its lead's 169
  //   own turns; a later live re-read of the same growing directory measured ~232,000, so the
  //   measured band is ~177,000–232,000 and 145,000 is a CHOSEN FLOOR beneath both).
  //   THE PROVENANCE OF THAT FLOOR, CORRECTED: this comment used to say "the same figure read
  //   145,961 at an earlier snapshot of the same growing directory", which presented 145,961 as
  //   a *reading*. It is not one. It is a CROSS-SNAPSHOT COMPOSITION — an earlier snapshot's
  //   5-transcript directory total divided by the CURRENT snapshot's lead turn count — so it
  //   was never the per-turn cost of any single observed state. Same family as the 50,000
  //   near-miss, and worth correcting even though the direction is conservative and the live
  //   232,000 puts the assertion safe by a wide margin: a number whose stated provenance is
  //   false is a number the next person will re-derive the same wrong way. Use 145,000 because
  //   it is deliberately below the observed band, not because anything measured it.
  //   Even at that floor `tokens_cap` binds first
  //   in every class by 2.3x or better, so `turn_cap` now fires only when turns are abnormally
  //   CHEAP — the retry-loop signature it exists for. The previous values inverted exactly this:
  //   `standard`'s implied allowance was 20M/250 = 80,000 against a per-session median of
  //   20,504, so turns bound roughly 4x before tokens and `turn_cap` was quietly doing the
  //   budget's job while being documented as a backstop.
  //
  // - Worth knowing when reading those numbers: a DELEGATING lead's own turns are expensive.
  //   MEASURED: 53,155 est_tokens per turn on that lead's own transcript, **2.6x the 20,504
  //   corpus-wide per-session median**, because delegating means reading every teammate's
  //   report. Do not size a lead from the median session.
  //
  // WHAT `turn_cap` IS COMPARED AGAINST — getting this wrong re-creates the `resume_token_guard`
  // bug in a different unit, a per-lead number read as a per-team one:
  // **the LEAD's own session turns**, i.e. `readDirUsage(cwd).sessions.find(s => s.uuid === leadUuid).turns`.
  // NOT `readDirUsage().turns`, which is the DIRECTORY SUM over the lead and its whole team.
  // MEASURED on that same directory: **912 directory turns against the lead's own 169 — 5.4x.**
  // Compared against the directory sum, a 600 turn_cap fires at ~111 lead turns: below the
  // observed one-ticket MEDIAN of 134, and below that analogue lead's own 169, so it would kill
  // the very session this was calibrated on. `tokens_cap` is the directory figure; `turn_cap` is
  // not. They are read off the same call and they are not the same subject.
  budgets: {
    research: { tokens_cap: 5000000,  turn_cap: 600, wall_ms: 2 * 3600 * 1000 },
    standard: { tokens_cap: 20000000, turn_cap: 600, wall_ms: 8 * 3600 * 1000 },
    iterate:  { tokens_cap: 38000000, turn_cap: 600, wall_ms: 12 * 3600 * 1000 },
    review:   { tokens_cap: 25000000, turn_cap: 600, wall_ms: 10 * 3600 * 1000 },
    // `turn_cap: 0` disables the turn backstop, and for this class that is deliberate rather
    // than an omission: a babysit lead is a long-lived watcher with many cheap turns over an
    // unbounded wall, so turns are the wrong axis for it entirely. `tokens_cap` and the reaper
    // windows are what bound it. This is the one class the rule above does not apply to.
    babysit:  { tokens_cap: 8000000,  turn_cap: 0,   wall_ms: 0 },
  },
  repos: {},                   // { '<repo>': { path, base_branch, verify_hint } }
  teammate_mcp_allow: [],
  env_allow: [],
  // Account rotation (design 2026-09-15 §2): the seat pool. Each entry is a Claude Code config
  // dir — `{ config_dir: string /* absolute or ~-prefixed */, label: string }` — whose `projects/`
  // is a symlink into the fleet's shared transcript tree, so any seat can resume any lead. Empty
  // means one account and no rotation, which is every fleet that existed before this key. An
  // ARRAY, so it replaces rather than merges (see `deepMerge`): removing a seat from soma.json must
  // remove it from the pool. `loadConfig()` checks exactly one thing about it: that it IS an array
  // (see `validated`), because a non-array was read two ways — as "no seats" by the watchdog's seat
  // pick, as an error by the spawner. It does not judge the entries: `lib/seats.mjs` does, at every
  // seat pick and before anything is spent (it resolves `~`, and refuses `''` and an entry that is
  // not an object), and `soma doctor` names a bad one.
  seats: [],
});

const configPath = () => p('soma.json');

/** A value the merge walks into. Arrays are values, not containers — see `deepMerge`. */
const isMergeable = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * `value`'s own keys, minus `__proto__`.
 *
 * `JSON.parse('{"__proto__": {...}}')` keeps `__proto__` as an own enumerable key, and
 * `target.__proto__ = v` runs the Object.prototype *setter* rather than defining a
 * property. Copy such a key across and the config you hand back reports
 * `cfg.max_leads === 1` while `Object.keys(cfg)` and `JSON.stringify(cfg)` show nothing
 * of the sort — a forged governance value that survives no round-trip and appears in no
 * diff. Nothing legitimate is lost by dropping it: `__proto__` is not a config key.
 */
const keysOf = (value) => Object.keys(value).filter((k) => k !== '__proto__');

/** Structural copy. Objects and arrays are rebuilt; scalars are already immutable. */
function copy(value) {
  if (Array.isArray(value)) return value.map(copy);
  if (isMergeable(value)) {
    const out = {};
    for (const k of keysOf(value)) out[k] = copy(value[k]);
    return out;
  }
  return value;
}

/**
 * `over` layered on `base`: nested objects merge recursively, everything else replaces.
 *
 * Arrays replace wholesale on purpose. `env_allow` and `teammate_mcp_allow` are the two
 * security boundaries in this file — the env scrub and the teammate MCP deny list — and
 * an element-wise merge would make them impossible to *shrink*: an entry added once
 * could never be revoked by editing the config.
 *
 * Neither argument is read after the copy and neither is mutated, so the result shares
 * no structure with DEFAULTS or with the parsed file.
 */
function deepMerge(base, over) {
  const out = copy(base);
  for (const k of keysOf(over ?? {})) {
    out[k] = isMergeable(over[k]) && isMergeable(out[k]) ? deepMerge(out[k], over[k]) : copy(over[k]);
  }
  return out;
}

/**
 * The operator's overlay: `soma.json` parsed, or `{}` if it was never written.
 *
 * Both failures name the file, because the state root holds several hand-editable JSON
 * files and a bare `SyntaxError: Unexpected end of JSON input` says nothing about which
 * one. The shape check is not pedantry: `[]`, `42` and `null` all parse, and merging
 * them would either graft numeric keys onto the config or quietly yield plain DEFAULTS.
 */
function readOverlay() {
  let raw;
  try {
    raw = readFileSync(configPath(), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new SyntaxError(`${configPath()} is not valid JSON: ${e.message}`, { cause: e });
  }
  if (!isMergeable(parsed)) {
    throw new Error(`${configPath()} must contain a JSON object, got ${Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed}`);
  }
  return parsed;
}

/**
 * Keys a previous soma read by name that no longer exist, and why carrying one forward is worse
 * than losing it.
 *
 * **This is the one exception to "unknown keys are preserved", and it needs one.** That rule
 * exists so an older soma does not eat a newer file's settings, and every genuinely unknown key
 * still survives the merge untouched. But a key that soma itself *retired* is not unknown: it
 * has a known meaning, a known consumer, and — for the entry below — known-wrong units. Because
 * `loadConfig` is `deepMerge(DEFAULTS, readOverlay())`, an operator soma.json that already
 * carries `resume_token_guard: 200000` keeps it on the merged config, so a consumer written for
 * the old key reads a cumulative-spend number as a live-context number and reproduces the
 * original bug verbatim and silently — **on exactly the machines where someone bothered to tune
 * that dial.** Deleting the key from DEFAULTS protected the default population and left the
 * tuned one exposed, which is the wrong way round.
 *
 * It is *removed from the merged config*, not from the file. Rewriting the operator's overlay
 * would break the same "overlay, not snapshot" property; the warning tells them to delete it.
 *
 * Note also what the removal from DEFAULTS does NOT buy, because it was claimed as a reason:
 * a missing key is not a compile-time notice in JavaScript. `cfg.resume_token_guard` is
 * `undefined`, and `live_context >= undefined` is `false` — silently, forever. That failure at
 * least errs safe (it never refuses a resume); this hazard does not.
 */
export const LEGACY_KEYS = Object.freeze({
  resume_token_guard:
    'replaced by resume_context_fraction x resume_context_window — derive the number with '
    + 'resumeContextLimit(cfg) from lib/tokens.mjs. The old key held a CUMULATIVE SPEND figure '
    + 'but was compared against CURRENT CONTEXT, two quantities that diverge without bound '
    + '(200x apart on one real transcript), which made "resume first" dead policy. Delete it '
    + 'from soma.json.',
});

/** Keys already warned about, so a 30 s watchdog tick does not reprint on every loop. */
const warnedLegacy = new Set();

/**
 * Strip every retired key from a merged config, warning once per key per process.
 *
 * Warned rather than dropped in silence: the operator tuned that dial for a reason, and the
 * number they chose no longer means what they meant. Deduped per process because the watchdog
 * calls `loadConfig()` every tick and a line every 30 s is noise nobody reads.
 */
function dropLegacyKeys(cfg) {
  for (const key of Object.keys(LEGACY_KEYS)) {
    if (!Object.hasOwn(cfg, key)) continue;
    delete cfg[key];
    if (warnedLegacy.has(key)) continue;
    warnedLegacy.add(key);
    process.stderr.write(`soma: ignoring retired ${configPath()} key "${key}" — ${LEGACY_KEYS[key]}\n`);
  }
  return cfg;
}

/**
 * `cfg`, or a throw naming the file, the key and the shape it wants, for a value its readers
 * would read two ways.
 *
 * `seats` must be an array. Read as "no seats", a non-array let the watchdog's seat pick wave a
 * dead lead through to a relaunch that reads the same value through `seats.loadSeats` and
 * throws — after the pane was killed and the revival attempt charged. Its entries are not
 * judged here: that is `loadSeats`' job, and `soma doctor` names a bad one.
 *
 * `max_leads` must be a non-negative integer. A hand-edited numeric string (`"10"`, `" 4 "`) is
 * the one string worth keeping, read with `fleet.admit`'s parse and handed back as the number, so
 * every reader sees the same value. Anything else (`"ten"`, `""`, `null`, `2.5`) is refused rather
 * than coerced, because a value two readers read two ways is a spend gate that lies: the
 * projection read `"10"` as 0 while admission read it as 10, so `soma up` asked to open the queue
 * to 0 leads and ten started.
 *
 * A budget class's own `tokens_cap`, when it is a numeric string the breaker would accept
 * (`"60000000"`, `"2e3"`), is handed back as its number, by `wd/budget.mjs`' `reqNum` rule. It has
 * three readers — the breaker, the spend projection and `soma_status` — and `"60000000"` was
 * enforced at 60M while the projection read it as 0, so the worst case `soma up` asked about left
 * that class out. **Anything else is left as it is, not refused here**: a cap belongs to one class,
 * and the breaker refuses it per lead, inside the meter's own try, so a typo in one class stops
 * only that class's breakers. Refused here, it would skip every tick and leave the whole fleet with
 * no breaker, admission or revival. A class with no `tokens_cap` of its own, and a `budgets` or
 * class that is not an object, is likewise left to its readers.
 *
 * The cost, stated because it is the same one `seats` already pays: the watchdog's `tick()` calls
 * `loadConfig()` on its first line, outside every phase's try, so while soma.json holds a refused
 * value no tick runs — and the budget breakers of leads already running are skipped until the
 * file is fixed.
 */
function validated(cfg) {
  const pool = cfg.seats;
  if (!Array.isArray(pool)) {
    const got = pool === null ? 'null' : typeof pool === 'object' ? 'an object' : JSON.stringify(pool);
    throw new Error(`${configPath()}: seats must be an array of { "config_dir": …, "label": … } entries, or [] (or no seats key) for no rotation, got ${got}`);
  }
  cfg.max_leads = counted('max_leads', cfg.max_leads);
  if (isMergeable(cfg.budgets)) {
    for (const name of keysOf(cfg.budgets)) {
      const cls = cfg.budgets[name];
      if (isMergeable(cls) && Object.hasOwn(cls, 'tokens_cap')) {
        cls.tokens_cap = asCap(cls.tokens_cap);
      }
    }
  }
  return cfg;
}

/**
 * `raw` as a non-negative integer, or a throw naming the file and `key`. A trimmed, non-empty
 * numeric string is read by `Number(raw)`, exactly as `fleet.admit` reads it, so the value handed
 * back is the one it would have computed.
 */
function counted(key, raw) {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${configPath()}: ${key} must be a non-negative integer (a numeric string such as "10" is read as its number), got ${shown(raw)}`);
  }
  return n;
}

/**
 * `raw` as its number when it is a trimmed, non-empty string `wd/budget.mjs`' `reqNum` would accept
 * (`Number(raw)` finite and non-negative), so the value handed back is the one the breaker would
 * have enforced. Anything else comes back untouched, for the breaker to refuse by name.
 */
function asCap(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return raw;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : raw;
}

/**
 * A value for an error message: quoted if a string, named by type if not. Not a bare
 * `JSON.stringify`, which throws on a BigInt — an error path that fails while explaining itself.
 */
const shown = (v) =>
  typeof v === 'string' ? JSON.stringify(v) : v !== null && typeof v === 'object' ? (Array.isArray(v) ? 'an array' : 'an object') : String(v);

/**
 * The effective config: DEFAULTS with `soma.json` layered over it.
 *
 * Re-read on every call, deliberately. `soma-watchdog` takes its next `tick_ms` from a
 * fresh `loadConfig()` each loop and admission re-reads `max_leads` every tick, so an
 * operator editing soma.json mid-run — the documented way to dial the fleet down when
 * limits bite — takes effect on the next tick rather than after a restart.
 */
export const loadConfig = () => validated(dropLegacyKeys(deepMerge(DEFAULTS, readOverlay())));

/**
 * Layer `patch` onto the overlay, publish it, and return the new effective config.
 *
 * Three notes for callers:
 * - The merge means a patch can add or override a key but never *remove* one; deleting
 *   a repo or an allowlist entry is an edit to soma.json (or a patch that sets the
 *   whole array/object to its new value, since those replace rather than merge).
 * - Patch values are JSON data: objects, arrays, strings, numbers, booleans, null. An
 *   object carrying its own `toJSON` (a `Date`, say) is copied structurally, not by that
 *   method, so pass the string you want on disk.
 * - Concurrent writers are last-write-wins, not serialized. That is fine while the
 *   writers are `soma init` and the canary's version stamp — rare, and tmp+rename means
 *   a loser loses its own update, never the file. A hot config writer would need this
 *   wrapped in `fleet.withFleetLock`, the way `lease.mjs` does.
 *
 * A non-object patch is refused rather than coerced: `Object.keys(5)` is `[]`, so an
 * unguarded merge would report success having written nothing.
 */
export function writeConfig(patch) {
  if (patch !== undefined && patch !== null && !isMergeable(patch)) {
    throw new TypeError(`writeConfig: patch must be an object, got ${Array.isArray(patch) ? 'array' : typeof patch}`);
  }
  const overlay = deepMerge(readOverlay(), patch);
  const body = JSON.stringify(overlay, null, 2) + '\n';
  const fp = configPath();
  const tmp = `${fp}.${process.pid}.tmp`;
  // tmp+rename is the house publish idiom (`writeFleet`, `writeCursor`): readers see
  // the old file or the new one. The pid keeps two writers out of one scratch file, and
  // the ENOENT retry self-heals a state root that was never `ensureTree()`d or was
  // wiped from under a running fleet — the same one-mkdir cost as the sibling modules.
  try {
    writeFileSync(tmp, body);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    mkdirSync(dirname(tmp), { recursive: true });
    writeFileSync(tmp, body);
  }
  renameSync(tmp, fp);
  return dropLegacyKeys(deepMerge(DEFAULTS, overlay));
}
