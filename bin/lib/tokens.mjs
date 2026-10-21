/**
 * Token accounting and model-deviation detection, read off a lead's Claude Code transcript.
 *
 * This is what the watchdog measures with. Per-lead token budgets are the fleet's only
 * real spend control, so `readUsage` returning zero is not a degraded reading — it is the
 * breaker silently welded open. Three properties follow from that, and each one is a test
 * in `test/tokens.test.mjs`:
 *
 * - **The transcript root comes from `claudeConfigRoot()`, never from `~/.claude`.**
 *   Claude Code writes transcripts to `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<uuid>.jsonl`
 *   when that variable is set, and it *is* set on the machine this ships to. A stale
 *   `~/.claude/projects` also still exists there, so guessing `~/.claude` does not fail
 *   loudly with ENOENT: it finds a real directory, finds no matching uuid, and reports
 *   zero for every lead. See the comment on `claudeConfigRoot` in `paths.mjs`.
 *
 * - **Nothing here throws.** A lead's transcript is *being appended to while we read it*,
 *   so a truncated final line is the normal case, not corruption. Add a missing file, an
 *   unreadable file, a directory where a file belongs, a projects root that is a file, and
 *   a malformed line, and every one of them has to come back as a usable number instead of
 *   killing the tick — one bad lead must not stop the other nine from being metered.
 *
 * - **The transcript is streamed, not slurped.** The watchdog calls this once per live lead on
 *   every 30 s tick and a transcript can reach tens of MB (26 MB observed). `readFileSync`
 *   + `split('\n')` allocates the file twice over, once as a string and once as an array
 *   of lines: measured 101 ms and ~80 MB of heap on that 26 MB file, against 45 ms and
 *   ~35 MB for the 256 KB chunked read below. Both produce byte-identical results, which
 *   `'a chunked read agrees with a whole-file read on the same bytes'` pins.
 *
 * `readUsage` is deliberately synchronous: the watchdog tick is a straight line, and
 * `checkBudget(usage, cls)` in `wd/budget.mjs` consumes the return value directly.
 *
 * ## Which function to call, because they measure different things
 *
 * - **`readDirUsage(cwd)` is the budget meter.** It sums a lead *and its team*, because
 *   teammate turns go to their own transcripts — `isSidechain` is true on 0 of 38 799 real
 *   rows. **Its correctness depends on the spawner setting the lead's own cwd to the lead's
 *   worktree** (a required item for `spawn.mjs`); read that function's doc before trusting a
 *   surprising number.
 * - **`readUsage(uuid)` is one session.** Use it for `live_context`, which is instantaneous and
 *   per-session, and cannot be summed across a team.
 * - **`est_tokens` is cumulative spend. `live_context` is current context.** They correlate
 *   early and then diverge without bound, and conflating them is what made the resume guard
 *   dead code — `est_tokens` crosses any context-sized threshold within a handful of turns.
 *
 * ## est_tokens is a calibrated number, not an estimate to improve
 *
 * `est_tokens` is the weighted sum in `USAGE_FIELDS.counted`, rounded *per field per turn*:
 * `input*1 + output*1 + cache_read*0.1 + cache_creation*1`. The shipped `tokens_cap` values
 * are calibrated to exactly that arithmetic, so **a weight here and a cap there move
 * together or not at all.**
 *
 * `cache_creation_input_tokens` is counted on a lead ruling, against an audit of the
 * operator's real transcripts (181 files, 19 604 assistant rows): it totals 353 215 715
 * against 631 412 492 for the other three terms combined — 56 % — and it is present on
 * 100 % of assistant rows. Omitting it let a `standard`-class lead (`tokens_cap: 1_500_000`)
 * run to roughly twice its cap before the breaker tripped.
 *
 * **Weight 1.0, and 1.25 was considered and rejected on the data.** 1.25 is the published
 * multiplier for a *5-minute* cache write, and the intuition was that over-counting is the
 * safe direction for a breaker. But 67.8 % of real cache-creation volume is
 * `ephemeral_1h`, which bills at 2.0x, not 1.25x — so a flat 1.25 is not "the real
 * multiplier", it is the minority multiplier applied to everything, a cost model that gets
 * two-thirds of its own input wrong. The two honest options are this one — a throughput
 * count in tokens, with cache reads discounted because they are cheap — or a genuine
 * two-term cost model reading `cache_creation.ephemeral_{5m,1h}_input_tokens` at 1.25 and
 * 2.0, which lands 27.2 % above this and needs the nested object. Anyone reopening it
 * should reopen it as that, not as a flat multiplier.
 *
 * ## The field-set guard
 *
 * Missing `cache_creation_input_tokens` was a 2x budget error that no test could have
 * caught, because nothing anywhere asserted that the fields we account for are the fields
 * Claude Code actually emits. `USAGE_FIELDS` now classifies **every** observed key as
 * either counted (with a weight) or ignored (with a written reason), anything outside both
 * sets comes back in `unknown_usage_fields`, and a test walks the operator's real
 * transcripts asserting that list is empty. When a future version adds a token-bearing
 * field, that test fails and this comment is why.
 */
import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { claudeConfigRoot } from './paths.mjs';

/** `\n`. Safe to scan for on raw bytes: no UTF-8 continuation byte is < 0x80. */
const NEWLINE = 0x0a;

/** Read granularity. Beat 1 MB by 1.5x on the 26 MB transcript — smaller slices stay in cache. */
const DEFAULT_CHUNK = 256 * 1024;

/** A line longer than this is dropped rather than buffered. Real rows top out near 1 MB. */
const DEFAULT_MAX_LINE = 16 * 1024 * 1024;

/**
 * Every `message.usage` key Claude Code is known to emit, and what this module does with it.
 *
 * Exhaustive against an audit of 19 604 real assistant rows across 181 transcripts — a full
 * nested leaf walk, not a spot check — plus the two fields later Claude Code versions added,
 * `output_tokens_details` and `fallback_credit`, each caught by the guard and classified on its
 * own measurement. Anything not in here surfaces as `unknown_usage_fields`, which is the guard
 * described in the module header.
 *
 * **`counted` weights are what the shipped `tokens_cap` values are calibrated to.** Changing one
 * silently retunes every budget class. See the module header before you do.
 */
export const USAGE_FIELDS = Object.freeze({
  counted: Object.freeze({
    input_tokens: 1,
    output_tokens: 1,
    // Cache reads bill at a tenth of base input and dominate raw volume (5.8 billion tokens
    // across the corpus, 9x everything else put together). At 1.0 they would be the only
    // term that matters and every class would trip on turn one.
    cache_read_input_tokens: 0.1,
    // Counted on a lead ruling. 353 215 715 real tokens, 56% of the other three terms,
    // on 100% of rows. See the module header for why 1.0 rather than 1.25.
    cache_creation_input_tokens: 1,
  }),
  ignored: Object.freeze({
    cache_creation:
      'the 5m/1h breakdown OF cache_creation_input_tokens (32.2%/67.8% of it in the real '
      + 'corpus); counting it as well would double the largest term in the formula',
    server_tool_use:
      'request counts, not tokens — web_search_requests and web_fetch_requests, both 0 '
      + 'across the whole corpus; their token cost already lands in the four counted fields',
    service_tier: 'routing metadata, a string or null; carries no volume',
    inference_geo: 'routing metadata, a string or null; carries no volume',
    // Corrected after measurement. The first version of this reason said "carries no token
    // count of its own", which is false — and the guard could not catch it, because the key
    // WAS classified, just wrongly. A classification is only as good as its stated reason.
    iterations:
      'a per-API-call breakdown, one entry per attempt: 22 of 20 709 real rows have two. The '
      + 'parent usage reports the LAST call, not the sum, so adding these would double-count a '
      + 'retried prompt (and ignoring them under-counts spend by 0.68%, measured)',
    speed: 'routing metadata, a string or null; carries no volume',
    // The field-set guard did its job: Claude Code started emitting this and the test refused
    // to guess. Classified on measurement, not on the name.
    //
    // `{thinking_tokens: N}` — a breakdown OF `output_tokens`, which is already counted at
    // weight 1. Measured across the operator's real corpus: **15 903 assistant rows carry it,
    // and in ZERO of them does thinking_tokens exceed output_tokens** — it is a strict subset.
    // In aggregate it is 43.4% of all output volume (9 839 195 of 22 689 787), so adding it to
    // `counted` would inflate every projection by nearly half the output term and silently
    // invalidate every calibrated `tokens_cap`. Same shape as `cache_creation` above:
    // a details object beside the total it details.
    output_tokens_details:
      'the thinking_tokens breakdown OF output_tokens (43.4% of it across 15 903 real rows, '
      + 'and never exceeding it in any row); output_tokens already counts these, so counting '
      + 'them again would inflate the output term by ~43%',
    // Caught by the guard the same way, and classified on measurement, not on the name. Claude
    // Code 2.1.294 to 2.1.296 write it, and across the operator's real transcripts **24 938 rows
    // carry it and every one of them holds `null`**: there is no volume in it to count. What a
    // redeemed fallback credit does to usage is documented, and it lands in fields already
    // counted: the retry reports `cache_creation_input_tokens` lower and `cache_read_input_tokens`
    // higher by the same amount, so the credit already moves `est_tokens` through those two
    // weights. A non-null value has never been observed, so this reason says nothing about one:
    // the day it appears, measure what it holds before trusting this classification.
    fallback_credit:
      'null on every real row that carries it (24 938 rows, Claude Code 2.1.294-2.1.296), so no '
      + 'volume observed; a redeemed credit already shows in the counted cache fields '
      + '(cache_creation_input_tokens down, cache_read_input_tokens up by as much); re-measure '
      + 'if it is ever non-null',
  }),
});

/**
 * Flat set of every classified key, for the unknown-field check on the hot path.
 *
 * The mutators are refused rather than merely frozen. `Object.freeze` on a Set freezes its
 * *properties*, not its contents — `Object.freeze(new Set()).add(x)` succeeds — so this
 * exported set was mutable from anywhere in the process. It is the guard that reports usage
 * keys nobody has classified, i.e. the thing meant to catch the *next*
 * `cache_creation_input_tokens` before it becomes another 2x budget error, and one stray
 * `.add()` would disarm it for that key silently and permanently. `USAGE_FIELDS` is the place
 * to add a field; there is no legitimate caller of `.add` here.
 */
export const KNOWN_USAGE_FIELDS = (() => {
  const known = new Set([...Object.keys(USAGE_FIELDS.counted), ...Object.keys(USAGE_FIELDS.ignored)]);
  for (const method of ['add', 'delete', 'clear']) {
    known[method] = () => {
      throw new TypeError(`KNOWN_USAGE_FIELDS is immutable — classify the field in USAGE_FIELDS instead (.${method}() refused)`);
    };
  }
  return Object.freeze(known);
})();

/** `[key, weight]` pairs, hoisted out of the per-row loop. */
const COUNTED = Object.entries(USAGE_FIELDS.counted);

/**
 * The three usage fields that partition one API call's prompt — i.e. **live context**.
 *
 * `output_tokens` is deliberately absent: it is what came back, not what was sent. Validated
 * across 20 672 real turns — the sum peaks at 999,643 with **zero** turns above 1,000,000, so
 * these three do partition the prompt rather than overlapping, and the effective window is
 * ~1 M. (Multi-call rows are safe here too: the parent `usage` reports the *last* call, which
 * is exactly the latest prompt. See `USAGE_FIELDS.ignored.iterations`.)
 */
const PROMPT_FIELDS = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];

/** Shipped fallbacks for `resumeContextLimit`. See its doc for why the fraction is the dial. */
const DEFAULT_RESUME_FRACTION = 0.7;
const DEFAULT_CONTEXT_WINDOW = 1_000_000;

/**
 * Most transcripts `readDirUsage` will read from one directory before it stops and says so.
 *
 * A lead's directory holds the lead plus at most `team_size_max` teammates, so 64 is far above
 * any correct case. It exists for the *incorrect* case: if the spawner does not set the lead's
 * cwd to its worktree (see the module header), every lead lands in a shared directory that can
 * hold tens of multi-MB transcripts, and an unbounded read there would cost seconds per lead
 * per tick. Whatever it declines to read is reported in `transcripts_skipped`, never dropped
 * silently — a silent cap reads as "covered everything".
 */
const DEFAULT_MAX_TRANSCRIPTS = 64;

/** `value` if it is a usable non-empty string, else null. Junk must not reach `resolve()`. */
const str = (value) => (typeof value === 'string' && value !== '' ? value : null);

/**
 * Claude Code's placeholder model on locally-synthesised assistant rows.
 *
 * Observed live: a lead that cannot authenticate, or that hits an API error, gets an
 * assistant row with `model: '<synthetic>'` and all-zero usage written on its behalf.
 * It appears 23 times across the operator's corpus. Reporting it as `last_model` would
 * raise a *model deviation* alarm against `--model opus` for what is actually an auth or
 * API failure — a different fault, with a different fix. It stays out of `last_model` and
 * stays visible in `models`.
 */
const SYNTHETIC_MODEL = '<synthetic>';

/**
 * `value` if it is a usable token count, else 0.
 *
 * Not the same as `value || 0`: a usage field arriving as the *string* `'100'` would make
 * `0 + '100'` the string `'0100'`, and `est_tokens` would leave here as text for
 * `checkBudget` to compare against a number. Observed non-numeric siblings in the real
 * schema (`service_tier: null`, `cache_creation: {...}`, `speed: null`) show the shape is
 * not all-integers, so this is cheap insurance against the next field that changes type.
 */
const count = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** A reading that found nothing. The shape is identical whether we failed or the file was empty. */
const zeroUsage = (transcript = null, uuid = null) => ({
  turns: 0,
  last_model: null,
  est_tokens: 0,
  models: [],
  raw: Object.fromEntries(COUNTED.map(([field]) => [field, 0])),
  bad_lines: 0,
  unknown_usage_fields: [],
  live_context: 0,
  zero_tail_rows: 0,
  transcript,
  uuid,
});

/**
 * Absolute path of the directory holding Claude Code's per-project transcript dirs.
 *
 * Three ways in, most specific first, because the callers want different things:
 *
 * - `configRoot` — *this directory is the config root.* `projects` is appended and nothing
 *   else. This is what the watchdog wants when it has been told a root explicitly.
 * - `home` — *this directory is a HOME*, so its config root is `<home>/.claude`. The
 *   original tests hand over a temp dir of this shape, and so would anything reasoning
 *   about another user's account.
 * - neither — `claudeConfigRoot(env)`, i.e. `$CLAUDE_CONFIG_DIR` then `$HOME/.claude`.
 *
 * The two are separate parameters rather than one overloaded path precisely because
 * `<x>/.claude/projects` and `<x>/projects` are both plausible readings of a bare
 * directory argument, and picking the wrong one is the silent-zero failure this module
 * exists to prevent. Both are `resolve`d for the same reason `SOMA_HOME()` is.
 *
 * Non-string arguments are *ignored*, not passed to `resolve()`. `resolve(42)` throws a
 * TypeError, and this sits on the watchdog's 30 s tick: if a home is read out of a meta file
 * and a serialisation bug leaves a number or a null there, an unguarded throw here stops
 * metering for **every lead at once**, not just the one with the bad field. Ignoring the junk
 * falls through to the environment, which is both non-fatal and the more likely intent.
 */
export function transcriptRoot(opts = {}) {
  const o = opts !== null && typeof opts === 'object' ? opts : {};
  const configRoot = str(o.configRoot);
  const home = str(o.home);
  const env = o.env !== null && typeof o.env === 'object' ? o.env : process.env;
  if (configRoot) return join(resolve(configRoot), 'projects');
  if (home) return join(resolve(home), '.claude', 'projects');
  return join(claudeConfigRoot(env), 'projects');
}

/**
 * Claude Code's transcript directory name for a working directory.
 *
 * **Derived from measurement, not from a guess.** Checked against 220 real (cwd, directory)
 * pairs taken from the `cwd` field Claude Code records in its own transcript rows:
 * `cwd.replace(/[^A-Za-z0-9]/g, '-')` reproduced the containing directory name **220/220**.
 * Two rival rules each scored 218/220 and are wrong in ways that matter — keeping `_`
 * (a real pair maps `m_0rzy…` to `m-0rzy…`) and replacing only `/` and `.`. Lowercasing
 * scored 35/220, so **case is preserved.** Each separator produces its own dash, which is
 * why `/x/.hidden` becomes `-x--hidden`.
 *
 * **`realpathSync` first, and this is load-bearing.** Verified behaviourally: a run with cwd
 * `/tmp/soma-t21-wd2-UG9Qec` wrote its transcript under `-private-tmp-soma-t21-wd2-UG9Qec`,
 * because macOS `/tmp` is a symlink to `/private/tmp` and Claude Code resolves before
 * slugifying. Slugifying the string soma *built* would therefore find no transcripts at all —
 * harmless while `SOMA_HOME` sits under `$HOME`, silently fatal for a `/tmp` test root.
 * An unresolvable path still slugifies (the directory may not exist yet); it must not throw.
 */
export function slugForCwd(cwd) {
  const raw = str(cwd);
  if (!raw) return null;
  let path;
  try {
    path = realpathSync(resolve(raw));
  } catch {
    path = resolve(raw); // not created yet, or unreadable — slugify what we were given
  }
  return path.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * `<root>/<some-project-slug>/<uuid>.jsonl`, or null.
 *
 * The project dir is a slug of the lead's cwd, which the watchdog would have to
 * re-derive to guess — so scan instead. It is one `statSync` per project dir (about 20 on
 * the operator's machine) and it is honest about not knowing the lead's cwd.
 *
 * `isFile()` rather than a bare existence check: a *directory* named `<uuid>.jsonl` would
 * otherwise be handed on and read as an empty transcript, i.e. reported as zero tokens.
 */
function findTranscript(uuid, root) {
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return null; // root missing, root is a file, or root unreadable — all just "no transcript"
  }
  for (const proj of entries) {
    const fp = join(root, proj, `${uuid}.jsonl`);
    try {
      if (statSync(fp).isFile()) return fp;
    } catch { /* not in this project dir */ }
  }
  return null;
}

/**
 * True if `uuid` is a plain filename component.
 *
 * The watchdog reads session uuids out of its own state files, so this is not a hostile
 * input — but `readUsage(undefined)` would otherwise stat `undefined.jsonl`, and a value
 * containing a separator would let a lookup wander outside the projects root. Both are
 * "no transcript", which is what the caller can already handle.
 */
const isPlainName = (uuid) =>
  typeof uuid === 'string' && uuid !== '' && uuid !== '.' && uuid !== '..' && !/[/\\]/.test(uuid);

/**
 * Fold one transcript line into `acc`. Returns nothing; `acc` is mutated.
 *
 * Anything that is not an assistant row is skipped without being counted as damage —
 * a transcript is mostly user rows, `queue-operation` rows and `file-history-snapshot`
 * rows, and calling those corrupt would make `bad_lines` useless as a signal. A blank
 * line is not damage either: every transcript ends with one.
 *
 * `text === null` is `streamLines` reporting a line it refused to buffer past `maxLine`
 * (see there): unreadable in exactly the way a line `JSON.parse` rejects is, counted the
 * same way, and there is nothing to parse.
 */
function foldLine(text, acc) {
  if (text === null) {
    acc.bad_lines += 1;
    return;
  }
  if (text.trim() === '') return;
  let row;
  try {
    row = JSON.parse(text);
  } catch {
    acc.bad_lines += 1; // malformed, or the final line of a file still being appended to
    return;
  }
  const message = row?.message;
  if (!message || typeof message !== 'object' || message.role !== 'assistant') return;

  acc.turns += 1;
  if (typeof message.model === 'string' && message.model !== '') {
    acc.models.add(message.model);
    if (message.model !== SYNTHETIC_MODEL) acc.last_model = message.model;
  }

  const usage = message.usage;
  if (!usage || typeof usage !== 'object') {
    acc.zero_tail_rows += 1; // no usage at all is no context reading either
    return;
  }
  for (const [field, weight] of COUNTED) {
    const value = count(usage[field]);
    acc.raw[field] += value;
    // Rounded per field per turn, not on the total: the shipped caps are calibrated to this
    // exact form, so a weight change stays a one-constant edit in USAGE_FIELDS.
    acc.est_tokens += Math.round(value * weight);
  }

  // Live context, kept separate from cumulative spend. The two correlate early and then
  // diverge without bound, and conflating them is what made the resume guard dead code.
  //
  // A zero-prompt row is an ERROR, NOT A CONTEXT CHANGE. Claude Code writes an all-zero
  // '<synthetic>' row when a turn never reached the API — which is precisely how a lead dies,
  // and precisely the population a revival decision runs on. 6 of 209 real sessions end on
  // one, two of them masking live context of 113,229 and 125,993; a lead that died at 800 k
  // would report 0, be resumed, and immediately compact. So carry the last row that had a
  // real reading, and count the ones skipped — that count is itself the "died abnormally"
  // signal, and it is information a revival decision wants anyway. (The same trap invalidated
  // a first attempt at compaction detection, which counted 17 events where there were 8.)
  let prompt = 0;
  for (const field of PROMPT_FIELDS) prompt += count(usage[field]);
  if (prompt > 0) {
    acc.live_context = prompt;
    acc.zero_tail_rows = 0;
  } else {
    acc.zero_tail_rows += 1;
  }

  // The guard. A key nobody has classified is reported, never guessed at — see the header.
  for (const key of Object.keys(usage)) if (!KNOWN_USAGE_FIELDS.has(key)) acc.unknown.add(key);
}

/**
 * Stream `fp` line by line into `acc`, reading `chunkSize` bytes at a time.
 *
 * Lines are assembled from raw bytes rather than decoded per chunk: a 3- or 4-byte UTF-8
 * character straddling a chunk boundary would otherwise decode as two replacement
 * characters and break the JSON around it. Scanning for `0x0a` on bytes is safe because
 * UTF-8 continuation bytes are all >= 0x80.
 *
 * Whatever has been counted when a read throws is kept. A lead's transcript can be
 * truncated, rotated or made unreadable underneath us; half a reading beats none, and
 * beats an exception on the watchdog's hot path.
 *
 * `fold(text, acc)` is the per-line consumer and defaults to the meter's `foldLine`.
 * `readTailRows` hands over a row collector instead, so the meter and the limit classifier
 * share ONE open/read/line-split/decode path and cannot disagree about which bytes are a
 * line — the over-long-line drop and the torn-tail rule are the same code for both.
 *
 * **A dropped line is handed to the fold as `null`, never counted in here.** The two folds
 * have to answer a dropped line differently — the meter counts it, the tail reader must put a
 * `null` IN ITS PLACE so the classifier can see that a row is missing — and an `acc.bad_lines
 * += 1` in this function can only do the first. It did, and the tail reader's rows silently
 * lost the line: a healthy row that had ended a rate-limit window vanished out of the tail, the
 * rate_limit row before it read as the newest state, and the watchdog killed a lead that had
 * already recovered.
 */
function streamLines(fp, acc, chunkSize, maxLine, fold = foldLine) {
  let fd;
  try {
    fd = openSync(fp, 'r');
  } catch {
    return; // vanished or unreadable between the stat and here
  }
  try {
    const buf = Buffer.allocUnsafe(chunkSize);
    let tail = null;      // bytes of a line the previous chunk cut in half
    let dropping = false; // inside an over-long line: discard to the next newline
    for (;;) {
      let n;
      try {
        n = readSync(fd, buf, 0, chunkSize, null);
      } catch {
        return; // EISDIR, EIO, a truncating writer — keep what we have
      }
      if (n === 0) break;
      let start = 0;
      for (;;) {
        const nl = buf.indexOf(NEWLINE, start);
        if (nl === -1 || nl >= n) break; // -1, or a stale newline past the bytes just read
        if (dropping) {
          dropping = false; // this newline ends the line we gave up on
        } else if (tail) {
          fold(Buffer.concat([tail, buf.subarray(start, nl)]).toString('utf8'), acc);
          tail = null;
        } else if (nl > start) {
          fold(buf.toString('utf8', start, nl), acc); // `nl === start` is a bare `\n\n`
        }
        start = nl + 1;
      }
      if (start < n && !dropping) {
        const rest = buf.subarray(start, n);
        tail = tail ? Buffer.concat([tail, rest]) : Buffer.from(rest);
        if (tail.length > maxLine) {
          // Refuse to grow a buffer without bound for one absurd line. Drop its bytes, tell the
          // fold (see the header: `null` is a line that was here and could not be read), and
          // resync at the next newline so the rows after it are still read.
          fold(null, acc);
          tail = null;
          dropping = true;
        }
      }
    }
    if (tail && tail.length > 0) fold(tail.toString('utf8'), acc); // unterminated final line
  } finally {
    try { closeSync(fd); } catch { /* nothing left to do about it */ }
  }
}

/**
 * Token spend, turn count and model history for one lead's session.
 *
 * @param {string} sessionUuid          Session uuid; the transcript is `<uuid>.jsonl`.
 * @param {string|null} [home]          A HOME directory whose `.claude` to read. Wins over
 *                                      `$CLAUDE_CONFIG_DIR`. Pass null to use the env.
 * @param {object}  [opts]
 * @param {string|null} [opts.configRoot]  A config root directly (no `.claude` appended).
 *                                         Wins over `home`.
 * @param {object}  [opts.env]             Environment to read `CLAUDE_CONFIG_DIR` from.
 * @param {number}  [opts.chunkSize]       Read granularity. Overridable so tests can force
 *                                         lines and multi-byte characters to straddle a
 *                                         boundary without writing a 26 MB fixture.
 * @param {number}  [opts.maxLine]         Longest single line buffered before it is dropped.
 * @returns {{
 *   turns: number,          // assistant rows, including '<synthetic>' ones — against turn_cap
 *   last_model: string|null,// last real model id; '<synthetic>' excluded. Deviation check.
 *   est_tokens: number,     // the USAGE_FIELDS.counted weighted sum, rounded per field per
 *                           // turn: input*1 + output*1 + cache_read*0.1 + cache_creation*1
 *   models: string[],       // every distinct model id seen, sorted. Catches a *reverted* fallback
 *   raw: { input_tokens: number, output_tokens: number,
 *          cache_read_input_tokens: number, cache_creation_input_tokens: number },
 *   bad_lines: number,      // unparseable lines. 1 is normal on a live file; many means drift
 *   unknown_usage_fields: string[], // usage keys this module does not classify. See the header
 *   live_context: number,   // CURRENT context: the last row's prompt. NOT cumulative — see below
 *   zero_tail_rows: number, // assistant rows after it with no prompt reading. >0 ⇒ died abnormally
 *   transcript: string|null,// the file actually read, so a zero reading is diagnosable
 *   uuid: string|null       // the session this reading is for
 * }}
 */
export function readUsage(sessionUuid, home = null, opts = {}) {
  const o = opts !== null && typeof opts === 'object' ? opts : {};
  if (!isPlainName(sessionUuid)) return zeroUsage();

  const fp = findTranscript(sessionUuid, transcriptRoot({ home, configRoot: o.configRoot, env: o.env }));
  if (!fp) return zeroUsage(null, sessionUuid);

  return readTranscript(fp, sessionUuid, o);
}

/** Read one transcript file. Shared by `readUsage` and `readDirUsage` so they cannot diverge. */
function readTranscript(fp, uuid, opts) {
  const chunkSize = typeof opts.chunkSize === 'number' ? opts.chunkSize : DEFAULT_CHUNK;
  const maxLine = typeof opts.maxLine === 'number' ? opts.maxLine : DEFAULT_MAX_LINE;
  const acc = { ...zeroUsage(fp, uuid), models: new Set(), unknown: new Set() };
  streamLines(fp, acc, Math.max(1, chunkSize | 0), Math.max(1024, maxLine | 0));
  const { unknown, ...out } = acc;
  return { ...out, models: [...acc.models].sort(), unknown_usage_fields: [...unknown].sort() };
}

/** How many trailing rows `readTailRows` keeps when the caller does not say. */
const DEFAULT_TAIL_ROWS = 40;

/**
 * The parsed values of the last `last` non-blank lines of one session's transcript, oldest
 * first — what the watchdog's limits phase hands `classifyLimit`.
 *
 * **Same file, same reader as `readUsage`.** `findTranscript` locates it and `streamLines`
 * reads it, with a row collector in place of the usage fold. A second reader — a seek to the
 * end of the file and a split on the last newline — would be a second implementation of the
 * projects-root rule, the symlinked shared tree, the uuid guard and the torn-tail rule, and the
 * two would drift; the account-rotation design makes the transcript the ONLY limit signal, so
 * the classifier must read exactly the file the meter meters. The read is front-to-back for the
 * same reason and is priced like the meter's (45 ms on a 26 MB transcript), once per spawned
 * lead per tick, beside a meter that already reads the lead's whole directory.
 *
 * Only the last `last` non-blank lines are parsed, and what they parse to is handed over as
 * parsed — including `[]`, `1`, `null`, `"x"` — because the classifier owns what a non-object
 * entry means (older than the last assistant row: history; newer: `unobservable`). A line that
 * could not be read is counted in `bad_lines` and placed as `null` IN ITS PLACE — the torn
 * final line of a live file is the normal case, and it is exactly the line the classifier must
 * know about, since it may be the healthy row that would make a rate_limit row before it `none`.
 * The one exception is the FIRST kept line, which is dropped: that is `classifyLimit`'s caller
 * contract, stated for a reader whose window can open mid-line. On this front-to-back reader the
 * first kept line is always whole, so the branch is the contract's shape rather than a case this
 * reader produces — kept so the contract has one spelling.
 *
 * **"Could not be read" is two things, and BOTH get the `null`**: a line `JSON.parse` rejects,
 * and a line `streamLines` refused to buffer because it is longer than `maxLine`. The second
 * used to be counted in `bad_lines` and never placed, which is not a smaller version of the
 * first but its opposite — the row silently vanished and the row before it became the newest,
 * so a 16 MB healthy row (one `Read` of a large file is enough) turned a recovered lead into a
 * `seat_window` verdict and got it killed mid-turn. Counting one and placing the other would be
 * the same defect wearing a count.
 *
 * `bad_lines` here is therefore the count of unreadable lines **inside the kept tail**, not in
 * the whole file — a drop that falls out of the window falls out of the count, because this
 * number's one consumer asks "is the tail I am about to classify torn?". `readUsage`'s
 * `bad_lines` is the whole file's, which is the right answer to its own question.
 *
 * Nothing here throws, for the meter's reasons: a missing transcript, a bad uuid and an
 * unreadable file all come back as `rows: []` with `transcript: null` or the path, so a caller
 * can tell "no file" from "a file with nothing in it".
 *
 * @param {string} sessionUuid  Session uuid; the transcript is `<uuid>.jsonl`.
 * @param {object} [opts]       `last` (lines to keep, default 40), plus `readUsage`'s `home`,
 *                              `configRoot`, `env`, `chunkSize`, `maxLine`.
 * @returns {{ rows: unknown[], bad_lines: number, transcript: string|null, uuid: string|null }}
 */
export function readTailRows(sessionUuid, opts = {}) {
  const o = opts !== null && typeof opts === 'object' ? opts : {};
  const last = typeof o.last === 'number' && Number.isFinite(o.last) && o.last >= 1 ? Math.floor(o.last) : DEFAULT_TAIL_ROWS;
  const out = { rows: [], bad_lines: 0, transcript: null, uuid: isPlainName(sessionUuid) ? sessionUuid : null };
  if (out.uuid === null) return out;
  const fp = findTranscript(sessionUuid, transcriptRoot({ home: o.home, configRoot: o.configRoot, env: o.env }));
  if (!fp) return out;
  out.transcript = fp;

  const chunkSize = typeof o.chunkSize === 'number' ? o.chunkSize : DEFAULT_CHUNK;
  const maxLine = typeof o.maxLine === 'number' ? o.maxLine : DEFAULT_MAX_LINE;
  // Raw lines first, parse after: only the kept tail is ever JSON.parsed, so this costs the
  // meter's line walk and not the meter's per-row parse.
  const kept = [];
  // `null` from `streamLines` is a line it dropped for being longer than `maxLine`: kept in the
  // window as a placeholder, so a drop INSIDE the tail becomes a `null` row and one that scrolls
  // out of the window is forgotten along with the lines around it.
  const collect = (text) => {
    if (text !== null && text.trim() === '') return;
    kept.push(text);
    if (kept.length > last) kept.shift();
  };
  streamLines(fp, out, Math.max(1, chunkSize | 0), Math.max(1024, maxLine | 0), collect);
  for (let i = 0; i < kept.length; i++) {
    const value = parseKept(kept[i]);
    if (value === UNREADABLE_LINE) {
      out.bad_lines += 1;                 // malformed, over-long, or the final line of a file still being appended to
      if (i > 0) out.rows.push(null);     // in its place; a LEADING torn line is dropped (see above)
      continue;
    }
    out.rows.push(value);
  }
  return out;
}

/** What a line that could not be read parses to. A Symbol, so no JSON value can impersonate it. */
const UNREADABLE_LINE = Symbol('unreadable line');

/** One kept line's value, or `UNREADABLE_LINE` — for a dropped line (`null`) and for bad JSON alike. */
function parseKept(line) {
  if (line === null) return UNREADABLE_LINE;  // over-long: `streamLines` has the bytes, and dropped them
  try {
    return JSON.parse(line);
  } catch {
    return UNREADABLE_LINE;
  }
}

/**
 * Spend for a lead **and its whole team**, by summing every transcript under the lead's
 * working directory slug.
 *
 * ## Why a directory and not the lead's own transcript
 *
 * Teammate turns are not written into the spawning session's transcript. Measured:
 * `isSidechain` is present on 38 799 real rows and **true on zero of them** — every agent gets
 * its own `<uuid>.jsonl`. A lead-only meter therefore cannot see what its team spends, which
 * on one real directory was **60.3 %** of the work done there. A spend control blind to most
 * of the spend is not a spend control, and it is blind to exactly the part a lead exists to do.
 *
 * Teammates inherit the cwd of whoever spawned them, so they land in the *lead's* slug
 * directory, and soma gives every lead its own worktree — so the directory is the lead plus
 * its team and nothing else.
 *
 * ## THIS DEPENDS ON THE SPAWNER, and the dependency is not local to this module
 *
 * **The spawner must set the lead's own cwd to the lead's worktree** (a required item for
 * `spawn.mjs`). If a lead is launched with cwd = the repo root and merely *told* to work in a
 * worktree, every lead in the fleet shares one slug directory and this function reports the whole
 * fleet's spend as each lead's — tripping all ten breakers at once. That failure is larger
 * than the one this function fixes, so if you are debugging a fleet that trips instantly,
 * check `dir` in the return value before you check anything here.
 *
 * ## Two behaviours that are deliberate rather than bugs
 *
 * - **An operator opening the lead's worktree by hand is counted too.** Their session lands in
 *   the same slug directory and there is no way to tell it apart. That over-counts, which
 *   trips the breaker *early* — the safe direction — and the worktree is the lead's anyway.
 * - **There is no `live_context` on the result.** Summing live context across sessions is
 *   meaningless: it is an instantaneous per-session reading, and a revival decision concerns
 *   one specific session. Take it from `sessions.find(s => s.uuid === leadUuid).live_context`.
 *
 * @param {string} cwd    The lead's working directory — normally `worktreeDir(repo, id)`.
 * @param {object} [opts] As `readUsage`, plus `maxTranscripts` (see `DEFAULT_MAX_TRANSCRIPTS`).
 * @returns {{
 *   turns: number, est_tokens: number, models: string[], raw: object,
 *   bad_lines: number, unknown_usage_fields: string[],
 *   last_model: string|null,      // the newest transcript in the directory THAT HAS ONE
 *   transcripts: number,          // files actually read
 *   transcripts_skipped: number,  // files declined by maxTranscripts — never silently dropped
 *   dir: string|null,             // the slug directory, so a zero reading is diagnosable
 *   sessions: object[]            // per-session readings, newest first. live_context lives here
 * }}
 */
export function readDirUsage(cwd, opts = {}) {
  const o = opts !== null && typeof opts === 'object' ? opts : {};
  const slug = slugForCwd(cwd);
  const empty = {
    ...zeroUsage(), dir: null, transcripts: 0, transcripts_skipped: 0, sessions: [],
  };
  delete empty.live_context;  // a directory has no single live context — see the doc above
  delete empty.zero_tail_rows;
  delete empty.transcript;
  delete empty.uuid;
  if (!slug) return empty;

  const dir = join(transcriptRoot({ home: o.home, configRoot: o.configRoot, env: o.env }), slug);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return { ...empty, dir }; // no directory yet: a lead that has not written a turn
  }

  // Newest first, so a bounded read keeps the transcripts that are actually live.
  const files = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const fp = join(dir, name);
    try {
      const st = statSync(fp);
      if (st.isFile()) files.push({ fp, uuid: name.slice(0, -6), mtime: st.mtimeMs });
    } catch { /* vanished mid-scan */ }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const limit = typeof o.maxTranscripts === 'number' && o.maxTranscripts > 0
    ? Math.floor(o.maxTranscripts) : DEFAULT_MAX_TRANSCRIPTS;
  const read = files.slice(0, limit);

  const out = { ...empty, dir, transcripts: read.length, transcripts_skipped: files.length - read.length };
  const models = new Set();
  const unknown = new Set();
  for (const f of read) {
    const one = readTranscript(f.fp, f.uuid, o);
    out.sessions.push(one);
    out.turns += one.turns;
    out.est_tokens += one.est_tokens;
    out.bad_lines += one.bad_lines;
    for (const [field] of COUNTED) out.raw[field] += one.raw[field];
    for (const m of one.models) models.add(m);
    for (const k of one.unknown_usage_fields) unknown.add(k);
  }
  out.models = [...models].sort();
  out.unknown_usage_fields = [...unknown].sort();
  // `last_model` is the newest transcript's, not a merge: the question it answers is "what is
  // this lead running on *now*", and `models` already carries everything anyone ever used.
  //
  // Precisely: the newest transcript **that has one**, which is not the same as "the newest
  // transcript". A session holding only `<synthetic>` rows — a teammate that never got past
  // login — has `last_model: null`, and so does one with no assistant rows yet. Taking the
  // newest transcript's value unconditionally would let either of those blank the reading, and
  // `null` here means "not deviating" to `modelDeviation`: a fleet-wide false CLEAN, from the
  // one session that failed hardest. `sessions` is newest-first (the sort above), so `find`
  // walks back only as far as it must.
  out.last_model = out.sessions.find((s) => s.last_model !== null)?.last_model ?? null;
  return out;
}

/**
 * The live-context ceiling above which a dead lead should be restarted rather than resumed.
 *
 * **The fraction is the configured dial and the absolute is derived**, because an absolute is
 * exactly what produced the bug this replaces: `resume_token_guard: 200000` was a *spend*
 * number being read as a *context* number, and against the observed ~1 M window it fired at
 * 20 % full — refusing a resume for 44 % of real sessions and making "resume first" dead
 * policy. An absolute cannot be right for two window sizes at once: pin a lead to a
 * 200 k-window model and an absolute 700 k never fires at all, the identical bug with the sign
 * flipped.
 *
 * Why ~0.7 rather than something tighter: Claude Code **auto-compacts** at the window limit.
 * Measured over eight real compaction events, it fires at a prompt of median 993,955 and lands
 * at median 79,946 — **7–9 % of peak, on all eight**. So a resumed near-full lead does not
 * crash, it compacts; the guard's real job is economic, not safety. Declining to resume is
 * about not paying ~1 M of cache_read for context that is about to be discarded, and 0.7
 * leaves ~300 k of headroom to make progress in. It also means a lead that *already* compacted
 * sits near 80 k and is cheap to resume — the inversion a cumulative figure gets backwards.
 *
 * `resume_context_window` is **established for the model leads are now pinned to, and was not
 * when this number was chosen.** It was inferred from fable-5, which was observed to 833,935 and
 * never above 900 k in 3 508 real turns without ever compacting — so fable's window was "certainly
 * above 834 k and almost certainly 1 M". Leads are pinned to `opus` now, and both opus models were
 * observed reaching ~999.6 k; claude 2.1.x reports `contextWindow: 1000000` for `claude-opus-5`
 * outright (measured 2026-08-17 via `-p --output-format json`). So 1 M is the pinned model's real
 * window rather than an inference about a different one. Keep the fable figures: they are what the
 * corpus holds, and a lead re-pinned to a smaller-window model needs this number changed, not the
 * fraction.
 */
export function resumeContextLimit(cfg) {
  const o = cfg !== null && typeof cfg === 'object' ? cfg : {};
  const fraction = count(o.resume_context_fraction) || DEFAULT_RESUME_FRACTION;
  const window = count(o.resume_context_window) || DEFAULT_CONTEXT_WINDOW;
  return Math.round(fraction * window);
}

/**
 * Worst-case fleet spend implied by a config, for `soma up` to show before the queue opens.
 *
 * The arithmetic lives here rather than in the CLI so that `soma.mjs` only has to print it, and
 * so it is testable without a terminal. **The worst case is the largest budget class, not the
 * typical one** — any admitted lead may be any class, so `max_leads × max(tokens_cap)` is the
 * number that can actually happen.
 *
 * It exists because the honest figure is uncomfortable and belongs in front of the operator
 * rather than inside a default: at the shipped caps, one full fleet run can spend a fifth of
 * everything measured in the corpus these caps were calibrated from. The levers that bound it
 * without breaking leads are `max_leads` and the wall clock — a `tokens_cap` low enough to feel
 * safe is one that guarantees no lead ever finishes, which is the failure that produced these
 * numbers in the first place.
 *
 * **It throws on a `max_leads` its enforcer would not accept**, rather than reading it as 0. A 0
 * here is the warning that lies: `max_leads: "ten"` once projected "0 leads × … = 0" and asked to
 * open the queue to 0 leads, and `"10"` did the same while admission started ten. So it is read
 * as `fleet.admit` reads it — a non-negative integer, tolerating a numeric string — and anything
 * else is named.
 *
 * **It throws on a `tokens_cap` the breaker would not accept**, too, read as `wd/budget.mjs` reads
 * it: a non-negative number, tolerating a numeric string. `"60000000"` was enforced at 60M but
 * projected as 0, so the worst case left that class out. A class with no `tokens_cap` of its own
 * projects as 0, as `checkBudget` reads it: not token-capped.
 *
 * **The classes are ordered by `tokens_cap`, not by `fleet_total`** (#69). For any `max_leads`
 * above 0 the two orders are the same, but at `max_leads: 0` every total ties at 0, and the name
 * tie-break named `babysit` as the largest class in place of `iterate`.
 */
export function projectFleetSpend(cfg) {
  const o = cfg !== null && typeof cfg === 'object' ? cfg : {};
  const maxLeads = spendNum('max_leads', o.max_leads);
  const budgets = o.budgets !== null && typeof o.budgets === 'object' ? o.budgets : {};
  const classes = Object.entries(budgets)
    .map(([name, cls]) => {
      const cap = cls !== null && typeof cls === 'object' && Object.hasOwn(cls, 'tokens_cap')
        ? spendCap(`budgets.${name}.tokens_cap`, cls.tokens_cap)
        : 0;
      return { name, tokens_cap: cap, fleet_total: cap * maxLeads };
    })
    .sort((a, b) => b.tokens_cap - a.tokens_cap || a.name.localeCompare(b.name));
  const worst = classes[0] ?? { name: null, tokens_cap: 0, fleet_total: 0 };
  const n = (v) => v.toLocaleString('en-US');
  const standard = classes.find((c) => c.name === 'standard');
  const lines = [
    `Fleet worst case: ${maxLeads} leads × ${n(worst.tokens_cap)} est_tokens`
    + `${worst.name ? ` (${worst.name}, the largest budget class)` : ''} = ${n(worst.fleet_total)} est_tokens.`,
  ];
  if (standard && standard !== worst) {
    lines.push(`All-standard case: ${maxLeads} × ${n(standard.tokens_cap)} = ${n(standard.fleet_total)}.`);
  }
  lines.push('Budgets meter each lead AND its team, and are deliberately loose so a breaker'
    + ' never fires on ordinary work. Lower max_leads to lower this.');
  return { max_leads: maxLeads, classes, worst, message: lines.join('\n') };
}

/**
 * A config count for the spend projection: a non-negative integer, tolerating the one string worth
 * keeping. The same rule as `fleet.admit`, and deliberately not `count()`, which turns every
 * refusal into a 0 nobody sees.
 */
function spendNum(key, raw) {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(`projectFleetSpend: ${key} must be a non-negative integer, got ${show(raw)}`);
  }
  return n;
}

/**
 * A budget cap for the spend projection: a non-negative finite number, tolerating the one string
 * worth keeping. The same rule as the breaker's (`wd/budget.mjs` `reqNum`), not an integer one: a
 * cap need not be whole.
 */
function spendCap(key, raw) {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    throw new TypeError(`projectFleetSpend: ${key} must be a non-negative number, got ${show(raw)}`);
  }
  return n;
}

/**
 * A value for an error message: quoted if a string, named by type if not. Not `JSON.stringify`,
 * which throws on a BigInt and on a hostile `toJSON` — the same helper as `wd/budget.mjs`.
 */
const show = (v) =>
  typeof v === 'string' ? JSON.stringify(v) : v !== null && typeof v === 'object' ? (Array.isArray(v) ? 'array' : 'object') : String(v);

/**
 * Hyphen-delimited segments of a model id or pin, lowercased. `'claude-Opus-5'` → `['claude','opus','5']`.
 */
const segments = (value) => String(value).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * True if model id `id` satisfies the pin `pin`.
 *
 * The rule is *contiguous segment containment*, and both simpler rules are wrong on a real id:
 *
 * - `startsWith` fails the normal case. `--model opus` resolves to `claude-opus-5`, so the
 *   pin is an infix, and every correctly-pinned lead in the fleet would report as deviating.
 * - `includes` matches across segment boundaries: the pin `'us'` would be satisfied by
 *   `claude-opus-5`, so a real fallback would report as clean.
 *
 * Segment containment handles both, plus the dated-suffix case that made this necessary —
 * `claude-haiku-4-5` must accept the observed id `claude-haiku-4-5-20251001`.
 */
function matchesPin(id, pin) {
  const have = segments(id);
  const want = segments(pin);
  if (want.length === 0) return true;
  for (let i = 0; i + want.length <= have.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (have[i + j] !== want[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Whether a lead has drifted off the model it was pinned to.
 *
 * Lives here rather than in the watchdog so the matching rule above is written once. Every
 * caller that re-derives it gets one of the two wrong answers in `matchesPin`'s comment.
 *
 * Judged against `usage.models` (every id the session ever used), not only `last_model`: a
 * lead that fell back to opus for thirty turns and then reverted is a real fleet defect and
 * is invisible to `last_model` alone. `deviated` is the *now* state, so it is the actionable
 * one; `unexpected` is the ever state.
 *
 * `synthetic` is separate from both and is not deviation. Claude Code writes an assistant
 * row with `model: '<synthetic>'` when a turn never reached the API at all — an
 * unauthenticated lead, or an API error. Observed live, 23 times across the real corpus.
 * Reporting that as model deviation points the operator at the wrong fault.
 *
 * Never throws: it is called from the same watchdog tick as `readUsage`.
 *
 * @param {object} usage        A `readUsage()` return value. Junk is tolerated.
 * @param {string|null} pinnedModel  What the lead was launched with, e.g. `'opus'`.
 * @returns {{ pinned: string|null, last_model: string|null, deviated: boolean,
 *             unexpected: string[], synthetic: boolean }}
 */
export function modelDeviation(usage, pinnedModel) {
  const models = Array.isArray(usage?.models) ? usage.models.filter((m) => typeof m === 'string') : [];
  const lastModel = typeof usage?.last_model === 'string' ? usage.last_model : null;
  const synthetic = models.includes(SYNTHETIC_MODEL);
  const pinned = typeof pinnedModel === 'string' && pinnedModel.trim() !== '' ? pinnedModel : null;

  // Nothing pinned means nothing to deviate from — an unpinned lead is not a defect.
  if (!pinned) return { pinned: null, last_model: lastModel, deviated: false, unexpected: [], synthetic };

  return {
    pinned,
    last_model: lastModel,
    deviated: lastModel !== null && lastModel !== SYNTHETIC_MODEL && !matchesPin(lastModel, pinned),
    unexpected: models.filter((m) => m !== SYNTHETIC_MODEL && !matchesPin(m, pinned)).sort(),
    synthetic,
  };
}
