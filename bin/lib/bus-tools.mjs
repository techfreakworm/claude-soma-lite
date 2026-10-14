/**
 * The bus tool handlers — part 1: what a lead can say, and how the orchestrator
 * hears it.
 *
 * `soma-bus.mjs` is the process Claude Code launches as an MCP server;
 * `jsonrpc.mjs` is the wire under it; this is the behaviour. Three tools are all a
 * lead gets — report, re-orient, checkpoint — because a lead is a worker that
 * talks, not an operator: it cannot spawn, kill, or read anyone else's mail.
 *
 * Nothing here imports anything. Every effect arrives as `ctx.deps`, so a handler
 * is a function of its arguments and its stubs: `test/bus-tools.lead.test.mjs`
 * drives the whole lead surface with no fleet, no tmux, no filesystem, no lease.
 * `soma-bus.mjs` injects the real modules (`events.appendEvent`, `lease.readLease`,
 * `tmux.sendKeys`, `notify.notify`, `harness.validateHarnessReport`, a `taskFor`
 * over `fleet.readFleet`) and nothing about the wiring changes what these
 * functions mean.
 *
 * Four contracts the transport imposes, in the order they bite:
 *
 *   Return data, never surprises. A handler's result is `JSON.stringify`d into the
 *   tool reply, and a thrown message reaches the model *verbatim* as a -32000. So
 *   an expected failure — a bad type, a refused HARNESS, a missing task row — is a
 *   `{ok:false, error}` value with no path, no home directory and no secret in it,
 *   and only a genuinely broken machine (a failed append) is allowed to throw.
 *
 *   Await everything. `tools/call` is serialized, so one handler that never
 *   settles parks every later tool call for the life of the process — and a
 *   *floating* promise (an unawaited effect, a rejection nobody catches) kills the
 *   bus outright. Every dep call in a handler is awaited even though the real ones
 *   are synchronous, which also makes an async dep merely slower rather than
 *   silently wrong.
 *
 *   Keep the line bounded. `events.appendEvent` needs no lock because one event is
 *   one small `write(2)` at the end of an `O_APPEND` file; that argument is only
 *   true while payloads are bounded, and the model writing them is the one thing
 *   here with an unbounded output. So the caps below are not hygiene, they are the
 *   log's atomicity invariant, applied before an append can see the payload.
 *
 *   Push is a courtesy. A report is delivered the moment it is on the log — the
 *   orchestrator pulls it with `soma_inbox`, the UserPromptSubmit hook injects it,
 *   and the watchdog batches what it missed. `wake()` is only the fast path, so it
 *   is wrapped tight enough that a dead pane, an unreadable lease or a broken
 *   notifier cannot turn a stored report into a failed tool call.
 */

/** The six a lead may file. Everything else in the schema is written by the watchdog. */
const REPORT_TYPES = new Set(['STARTED', 'HARNESS', 'MILESTONE', 'NEEDS_INPUT', 'COMPLETED', 'ERROR']);

/**
 * The four that interrupt a human.
 *
 * Three of them also interrupt the *orchestrator*: a lead blocked on a question, a
 * lead that died, and a lead that finished are the events whose value decays in
 * minutes. Everything else (STARTED, HARNESS, MILESTONE) is progress the watchdog's
 * next tick will carry in one batch — pushing those would spend an orchestrator turn
 * per lead per milestone, typed into its composer, which is how a fleet of eight
 * leads talks its supervisor to death.
 *
 * The fourth is the fleet's, not a lead's: BACKPRESSURE is the org spend cap
 * (account-rotation design §3.8) — every seat closed at once, admission frozen, and
 * no rotation, revival or auto-continue can help. It is the one event where only a
 * human can act. It carries no lead, so the wake line names the fleet; and a lead
 * still cannot file it — `REPORT_TYPES` is unchanged. The watchdog does not call
 * `wake`: its spend-cap BACKPRESSURE reaches the orchestrator as a toast and on the
 * next `soma_inbox` drain.
 */
const URGENT = new Set(['NEEDS_INPUT', 'ERROR', 'COMPLETED', 'BACKPRESSURE']);

/** Fleet-wide floor between two pushes, measured on `state/last-wake`'s mtime. */
const WAKE_DEBOUNCE_MS = 30_000;

/**
 * A lead id, and therefore a stream name: `events/<lead>.ndjson`.
 *
 * Mirrors `fleet.mjs`'s (unexported) `ID_RE` rather than importing it, because this
 * module stays dependency-free. Enforced here for two separate reasons: an id that
 * is not a filename is a path-traversal (`SOMA_LEAD_NAME=../../etc/x`), and an
 * *absent* one is worse than an error — `appendEvent(undefined, …)` would quietly
 * fill `events/undefined.ndjson`, a stream no inbox sweeps, and the lead would
 * report into a void that looks exactly like success.
 */
const LEAD_RE = /^[a-z][a-z0-9-]{0,63}$/;

/** `orch` is the orchestrator's own stream; a lead may not write to it. */
const RESERVED_STREAMS = new Set(['orch']);

/**
 * The field limits, ported from soma.
 *
 * `summary` and `question` are the two the design names, and they are the two a
 * model actually inflates: prose it wrote for a human. The rest of the walk below
 * exists so that the *bound* is a bound rather than a hope — a 5000-key object or
 * a list of 5000 paths is the same unbounded line as a 5000-word summary.
 *
 * - `MAX_FIELD` — any string the design did not name (a `traceback`, a
 *   `plan_summary`, a `verify_command`). No field may exceed the largest named cap.
 * - `MAX_ITEM` / `MAX_ITEMS` — an array entry is a path, a url or a bullet, and
 *   ten of them are a list; ten of them at `MAX_FIELD` would be five summaries.
 * - `MAX_FIELDS` / `MAX_DEPTH` — a report is a flat record with a nested plan at
 *   worst. The depth cap is also what makes the walk terminate on a cyclic object.
 * - `MAX_KEY` — a field *name* reaches the line too, and it is the one string the
 *   walk cannot truncate without renaming the field, so an absurd one drops the
 *   field instead. `plan_summary` is the longest name the schema has.
 * - `MAX_PAYLOAD` — the backstop that makes the total finite: every surviving node
 *   spends what it costs on the line, so the node count and the character count are
 *   both bounded whatever shape arrives. Comfortably above any real report
 *   (measured: a COMPLETED with paths and followups is 0.6 KB on the line, a full
 *   HARNESS 1.8 KB, an ERROR with a maxed traceback 2.2 KB) and comfortably below
 *   anything that could tear an append: **8.3 KB**, measured over twenty shapes —
 *   deep, wide, cyclic, 10k-entry, and escape-amplified in both the values and the
 *   *keys*. That last one is why keys are charged at escaped width below; charging
 *   them raw left the same walk with a 47 KB worst case, which is a bound, but not
 *   the bound this file tells `events.mjs` it is keeping.
 */
const LIMITS = { summary: 2000, question: 500 };
const MAX_FIELD = 2000;
const MAX_ITEM = 512;
const MAX_ITEMS = 10;
const MAX_FIELDS = 32;
const MAX_KEY = 128;
const MAX_DEPTH = 4;
const MAX_PAYLOAD = 8192;

/** Longest fragment of a rejected value we will quote back at the model. */
const MAX_QUOTE = 40;

/**
 * The orchestrator side's own bounds. Same argument as the payload caps above, one
 * layer out: everything below either reaches a *model's* context window (a tool
 * result), a *pane* (send-keys), or `fleet.json` (a task row), and the writer at
 * the other end is a model or an operator typing prose.
 *
 * - `INBOX_*` — 50 events is the design's default page; 200 is the ceiling, because
 *   `limit: 1e9` would otherwise hand the whole log to the model in one reply.
 * - `TRANSCRIPT_*` — a pane transcript is unbounded by nature (it is a tty capture
 *   with escape sequences in it), so both the line count and the character count
 *   are capped, and the *tail* is what survives: the death scene is at the end.
 * - `MAX_ENQUEUE` / `MAX_BRIEF` — a task row is written once and read by every
 *   process forever. 16 KiB is far above any real brief (and far below `ARG_MAX`,
 *   which matters because the spawner passes the brief on the lead's command line).
 * - `MAX_ECHO` — anything read back out of shared state (a task id from a `skipped`
 *   row, a hand-edited lease's session id, a pane title) before it is quoted into a
 *   reply. State is not a trusted input: `fleet.json` and `orch.lease` are files an
 *   operator can edit and a model can fill.
 */
const INBOX_LIMIT_DEFAULT = 50;
const INBOX_LIMIT_MAX = 200;
const TRANSCRIPT_LINES_DEFAULT = 120;
const TRANSCRIPT_LINES_MAX = 500;
const TRANSCRIPT_CHARS_MAX = 40_000;
const MAX_ENQUEUE = 200;
const MAX_BRIEF = 16_384;
const MAX_ECHO = 64;
const MAX_TITLE = 200;
const MAX_URL = 512;
const MAX_PANES = 8;

/** How often a tool call is allowed to cost a lease write. See `beat()`. */
const HEARTBEAT_FLOOR_MS = 60_000;

/** `soma_queue`'s vocabulary. `status` reads; the other two write. */
const QUEUE_ACTIONS = new Set(['pause', 'resume', 'status']);

/**
 * A harness id as the registry spells it (`prompts/harnesses.json`, H1-H6).
 *
 * Only used when no validator is wired — see `canonicalHarness`. Mirrored rather
 * than imported for the same reason `LEAD_RE` is: this module has no dependencies.
 */
const HARNESS_ID_RE = /^H[1-9][0-9]?$/;

/** The orchestrator's stream, and its cursor. Deliberately not `orch-inject`. */
const ORCH_STREAM = 'orch';

/** tmux server soma keeps its sessions on, when the environment does not say. */
const DEFAULT_TMUX_SOCKET = 'soma';

/**
 * The tmux server this bus talks to: `SOMA_TMUX_SOCKET` from the env it was handed, else the
 * default, with `''` read as unset the way every soma reader reads it.
 *
 * ONE spelling, shared by `wake()` (which compares it with the lease's socket before typing) and
 * the orchestrator's `socket()` (which writes it into the lease), because those two answers must
 * agree: a lease written with one spelling and checked against another could refuse every wake on
 * its own server, or clear one for another. It mirrors `tmux.mjs`'s own resolution
 * (`process.env.SOMA_TMUX_SOCKET || 'soma'`) rather than importing it: this module imports
 * nothing, and a bus is handed its env rather than owning one.
 */
const busSocket = (env) => (nonEmpty(env?.SOMA_TMUX_SOCKET) ? env.SOMA_TMUX_SOCKET : DEFAULT_TMUX_SOCKET);

/**
 * The terminal event types, and what a task row becomes when one arrives.
 *
 * Design §185: "the bus flips the task row on terminal events … so a finished lead
 * frees its slot immediately". This is that, and it is load-bearing rather than
 * bookkeeping: `fleet.countActive` counts only `spawned`, so a lead that finished
 * and whose row still says `spawned` occupies its slot forever — at `max_leads: 2`,
 * two COMPLETEDs mean every later spawn is refused "at max_leads" with nothing
 * running at all, and the watchdog's linger reap and its FLEET_DRAINED /
 * FLEET_SETTLED detection all read the same terminal set and so never fire either.
 *
 * `NEEDS_INPUT -> blocked` is deliberately **not** here. It is the one flip with a
 * clock attached: writing `blocked` frees the admission slot the instant it lands,
 * and the design gives a blocked lead `blocked_slot_minutes` (120) of grace first.
 * That belongs to the watchdog, which has a tick; this module only ever sees an
 * event that already happened.
 */
const TERMINAL_STATUS = new Map([['COMPLETED', 'done'], ['ERROR', 'failed'], ['GAVE_UP', 'failed']]);

/**
 * The states a terminal event may move a row *out of*.
 *
 * Not "anything non-terminal", for two separate reasons. A `queued` row was never
 * spawned, so a terminal event against it is a log that predates the row (a rebuilt
 * fleet, a re-queued id) and closing it would silently drop work nobody did. And
 * `done`/`failed`/`skipped` are left alone so the fold cannot undo a decision: a
 * `soma_kill` sets `failed` while the lead's own COMPLETED may still be sitting
 * unread in the log, and draining the inbox must not reverse the operator.
 *
 * `blocked` is included because a lead that answered its question and finished has
 * to be able to reach `done` — otherwise the fleet never drains and never settles.
 */
const FLIPPABLE = new Set(['spawned', 'blocked']);

/** The most rows one `soma_status` reply will carry. Excess is counted, never hidden. */
const MAX_ROWS = 200;

/** What an inbox drain reports when it changed nothing. Frozen: it is shared. */
const NOTHING_FOLDED = Object.freeze({ folded: 0, terminal: 0 });

/**
 * A tmux session name soma could have written: `lead-task-42`, or `lead-task-42-r2`
 * when a worktree retry suffixed it.
 *
 * Applied to `task.tmux_session` on the way *out* of the checkpoint, which is a file
 * an operator can edit and a model can fill. Two things it stops. A value shaped like
 * a path reaches a model through `tmux_target` and through send-keys refusals — the
 * discipline this module states about its own error strings. And a value shaped like a
 * *pane* (`%1`) is a different kind of tmux target altogether: `tmux.sendKeys` passes
 * a `%`-prefixed argument straight through as a pane id, so a row reading
 * `tmux_session: '%1'` would type the orchestrator's own answer into the
 * orchestrator's own composer. No `%`, no `:`, no `/`, no whitespace.
 */
const TMUX_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A task row that has finished, one way or another. */
const TERMINAL_STATES = new Set(['done', 'failed', 'skipped']);

/** The two a not-yet-promoted session gets: take the fleet, or look at it. */
const CANDIDATE_TOOLS = ['soma_adopt', 'soma_status'];

/**
 * `String(value)`, or `''` if that throws.
 *
 * `String()` is not total: an object whose `toString` throws takes the caller with
 * it. Unreachable for a payload that arrived over the wire (`JSON.parse` yields
 * only plain data), reachable the moment anything calls these handlers in-process.
 */
const text = (value) => {
  try {
    return String(value);
  } catch {
    return '';
  }
};

/**
 * The canonical form of a report type, or null if it is not one of the six.
 *
 * Case and surrounding space are forgiven because the type is a constant a model
 * types from memory, and a rejected `completed` costs the lead a whole turn to
 * learn what it already meant. What is stored is always the canonical spelling —
 * every consumer (watchdog, digest, `soma_status`) matches on exact strings.
 */
const canonicalType = (type) => {
  if (typeof type !== 'string') return null;
  const kind = type.trim().toUpperCase();
  return REPORT_TYPES.has(kind) ? kind : null;
};

/** A payload is an object — not a string, not an array, not null. */
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Neutralize a promise a synchronous-by-contract dep handed back.
 *
 * `wake()` returns void, so it cannot await anything; a dep that returns a promise
 * would leave it floating, and one rejection nobody caught ends the bus process
 * under Node's default `--unhandled-rejections=throw`. Attaching an ignoring
 * handler costs nothing and removes the whole failure class — the effect still
 * happens, its outcome is simply not this function's business.
 */
const fireAndForget = (result) => {
  if (result && typeof result.then === 'function') result.then(() => {}, () => {});
};

/** A non-empty string — the only shape an id, a pane or a session name may have. */
const nonEmpty = (value) => typeof value === 'string' && value !== '';

/**
 * The pane gate (added after leads were found stalled on prompts nobody saw): what a typist
 * reads before it types, and the readings it refuses on.
 *
 * Measured on a live Claude Code permission dialog: `send-keys -l -- '<text>'` changed nothing
 * on screen (swallowed) and the following `send-keys Enter` selected the highlighted `1. Yes`
 * and RAN the pending command. Into a bare `zsh` pane the same idiom EXECUTED the text
 * (`zsh: command not found: Operator:`, a symptom seen live); into a dead pane both calls exited
 * 0, so `landed()` reports delivery into a corpse. So `soma_send` and `wake()` take a reading
 * first, through ONE injected dep — `deps.paneReading(target, panes?)` → `{state, fine, kind,
 * cmd, source, why}`, `soma-bus.mjs` builds it from `wd/pane-state.readPane` — because this
 * module stays import-free and consumes readings, never classifiers.
 *
 * A `blocked_on_prompt` reading carries a `kind`: `permission` (the measured approval), `trust`,
 * `question` (an AskUserQuestion — the lead is asking the operator something, measured live on a
 * spawned lead that the previous gate typed into as `unrecognised`), or `unknown` (a dialog footer
 * with no composer on screen and no question the classifier knows). All four are the same
 * select-list UI with one option highlighted, so all four refuse the same way; the sentence names
 * the kind so the orchestrator can tell "answer at the pane" from "approve at the pane".
 *
 * Three kinds of reading, and each is handled as itself: a HAZARD (`blocked_on_prompt`,
 * `dead_shell`, `dead_pane`, `absent`) refuses; `unobservable` (the pane could not be read)
 * ALSO refuses, because typing blind into a dialog is the unrecoverable direction and a retry is
 * the recoverable one — `soma resume`'s "UNMEASURED refuses exactly like LIVE does"; and a bus
 * with NO reader wired (`source: null`) types as it always did and says the pane was not checked,
 * so an old wiring degrades visibly rather than refusing everything. `unrecognised` is a reading
 * (the screen was seen, it matched nothing) and not a measured hazard: typed, with the reading
 * attached, so a Claude Code wording change cannot teach callers to pass `force` by habit.
 *
 * Every sentence below is path-free by construction (the dialog's excerpt quotes absolute
 * paths and stays in the event log), and `why` is passed through only when it carries none.
 */
/** The dialog kinds in words — path-free, slash-free (the question footer itself carries a slash). */
const dialogWord = (kind) => (kind === 'permission' ? 'permission dialog'
  : kind === 'trust' ? 'trust dialog'
    : kind === 'question' ? 'question dialog (AskUserQuestion: the lead is asking the operator something)'
      : 'dialog of a kind the classifier cannot name (a dialog footer with no composer on screen)');

const PANE_HAZARDS = new Map([
  ['blocked_on_prompt', (lead, r) => `${lead}'s pane is showing a ${dialogWord(r.kind)}: typing into it would answer it BLIND — the literal is swallowed and the Enter selects the highlighted option, which on a permission dialog is the Yes that APPROVES the pending command (measured). A human answers it at the pane (soma attach ${lead}); pass force:true only after looking`],
  ['dead_shell', (lead, r) => `${lead}'s pane is a bare shell (${r.cmd ?? 'unknown'}), not claude: the message would EXECUTE as a shell command. The lead is gone — soma_kill it, then re-queue it or soma_resume it; force:true types anyway`],
  ['dead_pane', (lead) => `${lead}'s pane is dead (claude exited; tmux keeps the death scene): send-keys would report success into a corpse. soma_resume it; force:true types anyway`],
  ['absent', (lead) => `${lead} has no pane on the soma tmux server: nothing to type into. soma_resume it if it should be running`],
  ['unobservable', (lead, r) => `${lead}'s pane could not be read (${r.why}), so this bus cannot rule out a permission dialog and nothing was typed. Retry, or pass force:true after looking at the pane`],
]);

/** Why `wake()` withheld its push — the toast carries it, since the toast is what reaches a human. */
const WAKE_HOLDS = new Map([
  ['blocked_on_prompt', (r) => `the orchestrator's pane is on a ${dialogWord(r.kind)} and the Enter would answer it blind`],
  ['dead_shell', (r) => `the orchestrator's pane is a bare shell (${r.cmd ?? 'unknown'}) and the wake would execute as a command`],
  ['dead_pane', () => 'the orchestrator\'s pane is dead'],
  ['absent', () => 'the orchestrator\'s pane is gone from the soma tmux server'],
  ['unobservable', (r) => `the orchestrator's pane could not be read (${r.why})`],
]);

/**
 * A tmux socket name as the wake toast may print it, or a placeholder. Only a name shaped like one
 * is quoted (`TMUX_NAME_RE`'s class: no slash, at most 64 characters), because the lease's half
 * comes out of a file an operator can edit and a model can fill, and the toast stays path-free
 * and bounded whatever that file says.
 */
const socketWord = (name) => (typeof name === 'string' && TMUX_NAME_RE.test(name) ? name : '(name not shown)');

/** The reading when a bus has no pane reader at all: not a verdict of any kind, and said so. */
const UNREAD_PANE = Object.freeze({ state: null, fine: null, kind: null, cmd: null, source: null, why: 'this bus has no pane reader wired' });

/** A reading that could not be taken, with a cause that carries no path. */
const unreadable = (why) => ({ state: 'unobservable', fine: 'unobservable', kind: null, cmd: null, source: 'live', why });

/** A reader's answer, bounded and path-scrubbed; anything unusable is `unobservable`, never alive. */
const shapeReading = (r) => {
  if (!isRecord(r) || !nonEmpty(r.state)) return unreadable('the pane reader answered nothing usable');
  const why = nonEmpty(r.why) && !/[/\\]/.test(r.why) ? r.why.slice(0, 160) : (nonEmpty(r.why) ? 'the pane reader failed' : null);
  return {
    state: r.state.slice(0, 32),
    fine: cut(r.fine, 32),
    kind: cut(r.kind, 32),
    cmd: nonEmpty(r.cmd) ? r.cmd.split('/').pop().slice(0, 32) : null,
    source: r.source === null ? null : 'live',
    why,
  };
};

/**
 * The reading `wake()` takes — SYNCHRONOUSLY, because `wake()` is void and cannot await. A reader
 * that hands back a promise is neutralised (`fireAndForget`) and read as "could not be read":
 * the conservative direction, never a licence to type.
 */
const wakePaneReading = (deps, target) => {
  if (typeof deps?.paneReading !== 'function') return UNREAD_PANE;
  try {
    const r = deps.paneReading(target);
    if (r && typeof r.then === 'function') {
      fireAndForget(r);
      return unreadable('the pane reader answered asynchronously');
    }
    return shapeReading(r);
  } catch {
    return unreadable('the pane reader threw');
  }
};

/** `value` cut to `limit` characters, or null if it is not a usable string. */
const cut = (value, limit) => (nonEmpty(value) ? value.slice(0, limit) : null);

/**
 * The rotation window, MIRRORED from `fleet.ROTATION_WINDOW_MS` because this module imports
 * nothing (the same arrangement as `TMUX_NAME_RE` and `LEAD_RE`). Change both or neither.
 */
const ROTATION_WINDOW_MS = 3_600_000;

/**
 * Rotations in the last hour, counted HERE against the clock rather than read off the row's
 * length: the row is pruned on write, so between writes its list can hold stamps older than
 * the window. `0`, not `null`, for a row with no list — "none" is a measurement here.
 */
const rotationsLastHour = (rotations, now = Date.now()) => (Array.isArray(rotations)
  ? rotations.filter((t) => Number.isFinite(t) && t > now - ROTATION_WINDOW_MS).length
  : 0);

/** The most seats one `soma_status` reply names per bucket. */
const MAX_SEATS = 32;
const seatLabels = (rows) => (Array.isArray(rows) ? rows : []).slice(0, MAX_SEATS).map((x) => cut(x?.label, 32)).filter((l) => l !== null);
const unreadableSeats = () => ({ configured: null, open: [], closed: [], unverified: [], unreadable: true });

/**
 * The seat pool for the reply, SHAPED rather than spread (as `backpressure` is): every row of
 * the summary carries the seat's `config_dir`, which is a path, and a path must not reach the
 * model. Labels only; a non-record reads as unreadable, never as an empty pool.
 *
 * `unreadable` has THREE states here, not two: `true` is the third state, `false` or an absent
 * key is a real reading, and anything else is a reader this function cannot interpret — which
 * is no evidence that the pool WAS read, so it reads unreadable too, for the reason a non-record
 * does. And an unreadable pool names no seat: the buckets go empty, because "nothing is claimed
 * open" is the entire content of the third state (`seats-summary`'s header promises the same
 * upstream). `configured` survives it — a count can be known when the state is not.
 */
const shapeSeats = (s) => {
  if (!isRecord(s)) return unreadableSeats();
  const configured = Number.isInteger(s.configured) ? s.configured : null;
  const read = s.unreadable === false || s.unreadable === undefined;
  if (!read) return { ...unreadableSeats(), configured };
  return {
    configured,
    open: seatLabels(s.open),
    closed: (Array.isArray(s.closed) ? s.closed : []).slice(0, MAX_SEATS).map((x) => ({
      label: cut(x?.label, 32),
      closed_until: Number.isFinite(x?.closed_until) ? x.closed_until : null,
      closed_reason: cut(x?.closed_reason, 32),
    })),
    unverified: seatLabels(s.unverified),
    unreadable: false,
  };
};

/** The house refusal: a value the model reads, never a thrown message. */
const refuse = (error) => ({ ok: false, error });

/** A rejected value, quoted and clamped — so a refusal cannot echo a novel back. */
const quote = (value) => JSON.stringify(text(value).slice(0, MAX_QUOTE));

/** errno-shaped, so it cannot be a sentence, a path or a secret. */
const ERRNO_RE = /^[A-Z][A-Z0-9_]{1,31}$/;

/**
 * ` (EACCES)`, or nothing.
 *
 * The one part of a failure this module will forward. `node:fs`, `git` and `tmux`
 * all put absolute paths in `err.message` and the transport hands a message to the
 * model verbatim, so the message stays in the process — but a bare "it failed" is
 * not diagnosable, and an errno is the half that carries the diagnosis without
 * carrying the filesystem.
 */
const codeOf = (e) => (typeof e?.code === 'string' && ERRNO_RE.test(e.code) ? ` (${e.code})` : '');

/**
 * `value` as one submittable line.
 *
 * Two separate hazards, both about `tmux send-keys -l` typing into a *live* Claude
 * Code composer:
 * - a newline in the text is a keypress, so a three-line answer would be submitted
 *   as three prompts and the lead would answer the first fragment before it had
 *   seen the rest. One line is one turn.
 * - an ESC byte is the Escape *key*, which is Claude Code's interrupt — so an
 *   answer containing an ANSI sequence (pasted test output, a coloured diff) could
 *   cancel the very turn it was meant to unblock. C0 controls and DEL go too.
 */
const oneLine = (value) => (value === null || value === undefined ? '' : text(value))
  .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * A caller-supplied count, bounded: `def` unless it is a whole number at least 1,
 * and never above `max`. A numeric string is honored — the model types the args.
 */
const bounded = (value, def, max) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : def;
};

/**
 * Did an effect land? `false`, `null` and `undefined` say no; anything else yes.
 *
 * `tmux.sendKeys` and `tmux.killSession` answer with a boolean, and an *unwired*
 * dep answers with `undefined` — which must read as "not delivered", because
 * `soma_send` reporting a dropped answer as delivered is how a NEEDS_INPUT lead
 * waits forever for a reply the operator believes it sent. Anything else counts as
 * success so a recording test stub (`push()` returns a number) is not a failure.
 */
const landed = (result) => result !== false && result !== null && result !== undefined;

/**
 * A bounded, JSON-shaped copy of `payload`, plus whether anything was cut.
 *
 * A copy, not an edit: the argument belongs to the caller (it is the `arguments`
 * object the transport parsed), and a handler that rewrites its own input is a
 * surprise waiting for the first caller that reuses it.
 *
 * One `budget` is threaded through the walk, and every surviving node spends at
 * least one unit of it — so both the character count and the *node* count are
 * bounded, and the result is finite for any input: an object 10,000 levels deep, a
 * list of a million paths, a lattice of empty arrays, a structure that points at
 * itself. `clamped` is reported back to the lead rather
 * than written into the payload, so a truncated report is something its author can
 * act on (send a shorter summary) without the stored record growing a field the
 * lead never wrote.
 */
function clampPayload(payload) {
  let budget = MAX_PAYLOAD;
  let clamped = false;

  /**
   * `value` cut to its field limit, and then to whatever is left of the line.
   *
   * Measured at its *escaped* width, because that is the width it occupies on the
   * line: a newline is two characters there and an ANSI escape is six. This is not
   * a pathological case — a traceback of coloured test output is inside the
   * 2000-character cap and six times longer than the same length of prose — and the
   * budget is a promise about the line, so the line is what gets measured.
   *
   * The loop shrinks by the ratio it overshot by, which lands in one or two passes
   * and terminates regardless: the length strictly decreases every iteration.
   */
  const cap = (value, limit) => {
    let s = value.length > limit ? value.slice(0, limit) : value;
    let width = JSON.stringify(s).length;
    while (width > budget && s.length > 0) {
      s = s.slice(0, Math.floor(s.length * (budget / width)));
      width = JSON.stringify(s).length;
    }
    if (s.length < value.length) clamped = true;
    budget -= width;
    return s;
  };

  const walk = (value, limit, depth) => {
    // Out of budget, or nested deeper than a report has business being: the field
    // is dropped rather than truncated, because half a structure is not a smaller
    // structure — and because this is the branch a cycle terminates on.
    if (budget <= 0 || depth > MAX_DEPTH) {
      clamped = true;
      return undefined;
    }
    // Every node that survives costs what it costs on the line — which is the whole
    // of why this is a bound. Charging only the *content* would leave shape free,
    // and shape is not free: ten nested ten-entry arrays of nothing at all
    // serialize to a hundred thousand `[]`s without a character of payload in them,
    // and `null,` is five characters however cheap it looks.
    budget -= 1; // the comma or colon this node sits behind
    if (typeof value === 'string') return cap(value, limit);
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      budget -= text(value).length;
      return value;
    }
    if (Array.isArray(value)) {
      budget -= 2; // its brackets
      if (value.length > MAX_ITEMS) clamped = true;
      const out = [];
      for (const entry of value.slice(0, MAX_ITEMS)) {
        const kept = walk(entry, MAX_ITEM, depth + 1);
        if (kept !== undefined) out.push(kept);
      }
      return out;
    }
    if (typeof value === 'object') {
      budget -= 2; // its braces
      const keys = Object.keys(value);
      if (keys.length > MAX_FIELDS) clamped = true;
      const entries = [];
      for (const key of keys.slice(0, MAX_FIELDS)) {
        // The key is the one string on the line the walk cannot shorten — renaming
        // a field loses it more thoroughly than dropping it does.
        if (key.length > MAX_KEY) {
          clamped = true;
          continue;
        }
        // Charged at escaped width, exactly like the values are, plus the colon
        // that follows it — the per-node charge below covers a comma, not both. A
        // key is a string on the line like any other, so a name of control
        // characters is six times wider there than in memory, and a budget that
        // recorded the raw width would under-charge it sixfold: measured, keys
        // alone took the worst line from 8.4 KB to 47 KB.
        budget -= JSON.stringify(key).length + 1;
        const named = Object.hasOwn(LIMITS, key); // hasOwn, not `in`: `'constructor' in LIMITS` is true
        const raw = value[key];
        // The two named fields are prose — the operator reads them in a toast and
        // the digest slices them — so they are stored as text whatever the lead
        // sent. Everything else keeps its JSON shape.
        const kept = named && raw != null && typeof raw !== 'string'
          ? cap(text(raw), LIMITS[key])
          : walk(raw, named ? LIMITS[key] : MAX_FIELD, depth + 1);
        if (kept !== undefined) entries.push([key, kept]);
      }
      // fromEntries, never `out[key] = …`: a payload off the wire can own the key
      // `__proto__`, and plain assignment would set this object's prototype instead
      // of storing the field — which JSON.stringify then drops, losing it silently.
      return Object.fromEntries(entries);
    }
    // undefined, function, symbol, bigint. JSON.stringify drops the first three
    // inside an object and *throws* on the last, so none of them reach the line.
    clamped = true;
    return undefined;
  };

  return { payload: walk(payload, MAX_FIELD, 0), clamped };
}

/**
 * Tell the orchestrator something happened.
 *
 * Two channels, two policies, and both of them best-effort:
 *
 * - send-keys into the lease's pane, debounced fleet-wide to one per 30 s, and only
 *   when the lease's tmux server is this bus's own. This types a line into a live
 *   Claude Code composer and submits it, so it is a turn spent on the
 *   orchestrator's behalf: worth it for the four urgent types, ruinous per
 *   milestone across eight leads. The message says who and what, so the
 *   orchestrator can decide whether to read its inbox at all.
 * - a desktop toast, always, for the same four types — even when the pane wake
 *   landed, because an orchestrator session with a pushed prompt is still an
 *   orchestrator nobody is looking at.
 *
 * Void, and quiet. Everything is inside a try (two of them, so a broken pane does
 * not cost the operator an urgent toast) because the report this is announcing is
 * already durable: a wake that throws here would turn a stored event into a failed
 * tool call, and a lead that believes its report was lost files it again.
 */
export function wake(ctx, event) {
  const { deps, env } = ctx;
  const type = event?.type;
  // Everything that is not urgent leaves without touching a single effect — not
  // even the lease read. This is the design's "NEEDS_INPUT, ERROR and COMPLETED
  // wake immediately (debounced); everything else batches into the watchdog's next
  // tick" — to which account rotation's §3.8 adds the fleet's BACKPRESSURE, and
  // nothing else — and it is what the spec test measures: a HARNESS followed by a
  // COMPLETED is one send-keys, not two.
  if (!URGENT.has(type)) return;
  // Three states, not two, because the line has to say whose alarm this is and `fleet` is a
  // positive claim — every seat closed, admission frozen, act now. A fleet-level event
  // (BACKPRESSURE) carries no `lead` and gets that claim; a lead's event is named; and an
  // event whose `lead` is PRESENT but not a readable name is neither, so it says so instead
  // of borrowing the fleet's alarm. Unreachable from the one call site — `soma_report` has
  // already matched `SOMA_LEAD_NAME` against `LEAD_RE` — which is why the third arm renders
  // rather than throws: if it ever happens, this line is the operator's only clue.
  let who = 'fleet';
  if (event?.lead != null) who = nonEmpty(event.lead) ? event.lead : 'an unnamed lead';
  const summary = `[soma] ${who} ${type}`;
  let held = null;

  try {
    const lease = deps.readLease();
    if (lease && lease.wake === 'tmux' && deps.lastWakeAgeMs() > WAKE_DEBOUNCE_MS) {
      // The server before the pane (issue #1). `sendKeys` talks to THIS bus's server, and a pane
      // id is a small per-server counter, so on any other server the lease's pane names a
      // stranger: in the field, two fleets' orchestrators both sat in `%40` of their own servers
      // and one fleet's wakes were typed into the other's. Checked ahead of the pane gate because
      // the gate reads that pane id on this server too, so it would judge the stranger's pane and
      // could clear it for typing. A lease that records no socket keeps the old behaviour, the
      // rule `demote()` follows: there is nothing to compare.
      const ours = busSocket(env);
      if (nonEmpty(lease.tmux_socket) && lease.tmux_socket !== ours) {
        held = `the orchestrator's pane is on tmux server ${socketWord(lease.tmux_socket)}, not this bus's ${socketWord(ours)}`;
      } else {
        // Look before typing (the pane gate): the orchestrator's pane is a pane too, and this is
        // the same literal-then-Enter idiom that approved a live permission dialog when measured.
        // A hazard or an unreadable pane withholds the push — the pull path (the inject hook,
        // `soma_inbox`) still carries the event — and the toast below says why.
        const pane = wakePaneReading(deps, lease.tmux_pane);
        held = WAKE_HOLDS.get(pane.state)?.(pane) ?? null;
        if (held === null) {
          // Stamped before the send, not after: the debounce is a rate limit on
          // *attempts*, so a pane that has gone away (or a tmux call that throws)
          // costs one pair of send-keys per 30 s rather than one per report. Optional
          // because only the real wiring owns `state/last-wake`; a stub without it
          // simply never debounces.
          fireAndForget(deps.stampWake?.());
          fireAndForget(deps.sendKeys(lease.tmux_pane, `${summary}. Call soma_inbox.`));
        }
      }
    }
  } catch {
    // The pull path still has the event; latency degrades, correctness does not.
  }

  try {
    fireAndForget(deps.notify('soma', held === null ? summary : `${summary} — not typed: ${held}`));
  } catch {
    // `notify.notify` never throws by contract. This is for everyone else's.
  }
}

/**
 * The lead's three tools, as a live Map the transport lists and dispatches from.
 *
 * `ctx.env.SOMA_LEAD_NAME` is both the identity and the stream: a lead reports
 * into its own file, which is what lets the orchestrator sweep one stream per task
 * row and lets a cursor mean "everything I have read from this lead".
 */
export function leadTools(ctx) {
  const { env, deps } = ctx;
  const id = env?.SOMA_LEAD_NAME;
  const tools = new Map();

  /**
   * The identity check, run per call rather than once at build time: `soma-bus.mjs`
   * builds this Map before it knows whether the environment is sane, and a
   * refusal a model can read beats a `TypeError` from three frames down.
   */
  const badLead = () => {
    if (typeof id === 'string' && LEAD_RE.test(id) && !RESERVED_STREAMS.has(id)) return null;
    return { ok: false, error: 'SOMA_LEAD_NAME is not a usable lead id; this session was not spawned as a soma lead' };
  };

  /**
   * Append to the lead's own stream — `{stored}`, or `{error}` if the log refused.
   *
   * The one dep here that opens a file, and so the one whose failure a model must
   * not read: `node:fs` puts the *absolute path* it could not open into
   * `err.message` (EACCES on a root owned by another user, EISDIR, ENOENT under a
   * wiped state root, ENOSPC), and the transport hands a thrown message to the model
   * verbatim as a -32000. So the failure becomes a value and the path stays in the
   * process — the lead learns its report did not land, which is all it can act on,
   * and the operator diagnoses a broken `$SOMA_HOME` with `soma doctor` rather than
   * through a worker's context window.
   */
  const store = async (event) => {
    try {
      return { stored: await deps.appendEvent(id, event) };
    } catch {
      return { error: 'the event log could not be written' };
    }
  };

  /**
   * `soma_report(type, payload)` — the lead → orchestrator channel, and the only
   * way anything a lead does becomes visible to the fleet.
   */
  tools.set('soma_report', async (args) => {
    const { type, payload } = args ?? {};
    const refusal = badLead();
    if (refusal) return refusal;

    const kind = canonicalType(type);
    if (!kind) {
      return {
        ok: false,
        // Quoted so an empty or whitespace type is visible, and clamped because
        // this string is rendered to the model exactly as written.
        error: `unknown report type ${JSON.stringify(text(type).slice(0, MAX_QUOTE))}; expected one of ${[...REPORT_TYPES].join(', ')}`,
      };
    }
    if (payload !== undefined && !isRecord(payload)) {
      return { ok: false, error: 'payload must be an object of fields, e.g. {"summary": "..."}' };
    }
    const fields = payload ?? {};

    // First, and against what the lead actually sent: HARNESS is simultaneously
    // the plan of record and the budget reservation the watchdog binds a circuit
    // breaker to, so an incomplete one must not become an event at all — and a
    // rule about a field's content must not be satisfiable by a truncated copy.
    if (kind === 'HARNESS') {
      const verdict = await deps.validateHarnessReport(fields);
      if (!verdict?.ok) return { ok: false, error: verdict?.error ?? 'invalid HARNESS report' };
    }

    const { payload: bounded, clamped } = clampPayload(fields);
    const { stored, error } = await store({ type: kind, payload: bounded, lead: id });
    // Nothing stored, so nobody is woken: a wake for an event the orchestrator
    // cannot then read in its inbox is a turn spent on nothing.
    if (error) return { ok: false, error };
    wake(ctx, { lead: id, type: kind });
    // `delivered` is a claim about the log, not about the pane: the event is on
    // the orchestrator's three delivery paths the moment the append returns, and
    // this line is only reached if it did.
    return { stored_id: stored?.id ?? null, delivered: true, clamped };
  });

  /**
   * `soma_task()` — re-orientation. A resumed or compacted lead has lost the brief
   * it was spawned with; this is how it gets it back without an operator retyping
   * it, which is why the PostCompact hook's injected line names this tool.
   */
  tools.set('soma_task', async () => {
    const refusal = badLead();
    if (refusal) return refusal;
    const task = await deps.taskFor(id);
    // A lead with no row is a real state (a fleet rebuilt, a hand-edited
    // fleet.json), and answering it with six nulls invites the lead to invent a
    // task. Say so instead — it can ask the orchestrator.
    if (typeof task?.id !== 'string' || task.id === '') {
      return { ok: false, error: `no task row for lead ${id}; ask the orchestrator to re-enqueue it` };
    }
    return {
      task_id: task.id,
      brief: task.brief ?? null,
      repo: task.repo ?? null,
      base_branch: task.base_branch ?? null,
      source_ref: task.source?.ref ?? null,
      verify_hint: task.verify_hint ?? null,
    };
  });

  /**
   * `soma_checkpoint(note)` — a cheap progress marker that doubles as the "this
   * lead is still working" evidence the watchdog reads out of the event log.
   *
   * Cheap is the whole point: leads are told to call it liberally, so it appends
   * and returns. No wake, no lease read, no toast — a checkpoint that spent an
   * orchestrator turn would be a checkpoint nobody could afford to call.
   */
  tools.set('soma_checkpoint', async (args) => {
    const refusal = badLead();
    if (refusal) return refusal;
    const { note = '' } = args ?? {};
    const { payload } = clampPayload({ note, checkpoint: true });
    // Through the same guard as a report, for the same reason: this is the other
    // handler that opens the log, so it is the other one that could hand a model
    // the absolute path of a file it could not write.
    const { error } = await store({ type: 'MILESTONE', payload, lead: id });
    return error ? { ok: false, error } : { ok: true };
  });

  return tools;
}

/**
 * ===========================================================================
 * Part 2 — the control plane: what an orchestrator may do, and what a session
 * that has not been promoted yet may ask.
 * ===========================================================================
 *
 * Twelve tools, and between them they are the entire operator loop: take the
 * fleet, put work in it, start and stop leads, read the mail, answer a question,
 * hand the fleet back. Same shape as the lead half — pure, `ctx.deps` for every
 * effect, no imports — so this whole surface is driven in
 * `test/bus-tools.orch.test.mjs` with no lease, no tmux, no fleet on disk.
 *
 * Six things here are load-bearing, and each one is a bug that was reached for
 * and is now closed:
 *
 *   **Every call heartbeats.** `lease.leaseStale` is true past a ten-minute
 *   heartbeat *even for a holder whose pane is alive*, and the stamp is
 *   holder-keyed, so nothing but the holder can refresh it. An orchestrator that
 *   thinks for eleven minutes and then acts would otherwise be stealable by the
 *   next session to run `/soma-promote` — no force, no DEMOTED notice, two
 *   orchestrators. So `beat()` runs before every handler, floored to one lease
 *   write a minute so it is not a write+rename per tool call.
 *
 *   **Adoption decides staleness itself.** `acquireLease` deliberately does not
 *   probe tmux; "grant freely when the recorded pane is gone" is composed here,
 *   as `force || leaseStale(readLease(), hasPane)`. Passing the caller's `force`
 *   straight through would make `soma_adopt` refuse a *dead* holder — and the
 *   `/soma-promote` skill tells the operator that a refusal proves the holder is
 *   live, so the refusal has to be worth that claim. When it cannot be (no
 *   staleness dep wired), the refusal says so rather than asserting it.
 *
 *   **The demotion notice goes to the record the grant displaced.** `stolen_from`
 *   comes back from inside the lock; a second `readLease()` after the steal can
 *   already name a third session, and typing "you have been demoted" into an
 *   innocent third pane is worse than not typing it at all.
 *
 *   **Task rows change through `updateFleet` only.** read-then-write drops
 *   whatever the watchdog committed in between, and the watchdog writes the same
 *   file every 30 s. `soma_spawn`'s admit-and-mark is one transaction for the
 *   stronger version of the same reason: two admitters (this bus and the
 *   watchdog's tick) must not both admit past `max_leads`.
 *
 *   **Nothing this file returns can be unbounded.** A tool result is context in
 *   somebody's model, and the strings here come from `fleet.json`, `orch.lease`,
 *   pane titles and the operator — none of which is a trusted input. Text that
 *   goes *out* to a pane or into a task row goes through `clampPayload`, the same
 *   audited walk the lead half uses.
 *
 *   **No refusal names a file.** `node:fs`, `git` and `tmux` all put absolute
 *   paths in `err.message`, and the transport hands a thrown message to the model
 *   verbatim. Every dep call that can fail is caught; what comes back is a
 *   sentence plus an errno, and the path stays in the process.
 *
 *   **The lease is the licence, re-checked on every call.** Seven of the twelve tools
 *   refuse a caller that no longer holds the orchestrator lease (see `notHolder` and
 *   `def`'s `open` flag); the five exceptions are `soma_adopt`, `soma_release` and the
 *   three pure readers, each argued at its own `def`. This is not belt-and-braces over
 *   the role gate: the tool Map is upgraded in place on adopt and **never downgraded**
 *   (`soma-bus.main`), so the presence of a tool is not evidence the caller may use it,
 *   and the handler is the only place the question can be asked.
 *
 * Optional deps, and what each one costs when `soma-bus.mjs` has not wired it: `heartbeat`
 * (a live orchestrator becomes stealable after 10 min), `readLease` (⚠ **without it no
 * session can be shown to hold the lease, so every gated tool refuses** — it is wired in
 * `realDeps()` and is no longer optional in practice), `leaseStale`/
 * `hasPane` (a dead holder must wait out its heartbeat instead of being adopted
 * over instantly), `paneOnServer` (no pane can be proven to be on soma's server, so
 * every adopt claims notify wake and the heartbeat repairs no pane), `updateFleet`
 * (`soma_spawn` refuses outright — it will not admit
 * non-transactionally), `admit`+`loadConfig` (no `max_leads` gate on a manual
 * spawn; no repo validation at intake; no budget percentage), `eventStreams` (the
 * inbox falls back to every task row plus `orch`), `heartbeatAgeMs`, `listPanes`,
 * `queuePaused`/`setQueuePaused`, `backpressureState`, `tailLog`, `buildDigest`,
 * `resumeLead`, `readUsage`, `validateHarnessReport` (each degrades to a null
 * column or an honest refusal, never to a lie).
 */
export function orchTools(ctx) {
  const { env, deps } = ctx ?? {};
  const tools = new Map();
  const has = (name) => typeof deps?.[name] === 'function';

  /**
   * Who this session is — and it has to be the *same string the hooks see*.
   *
   * `orch-inject.mjs` decides whether to inject the fleet's mail into a prompt by
   * comparing its hook payload's `session_id` against `lease.session_id`, with the
   * recorded pane only as a fallback. So the identity written here is a contract with
   * that hook, and getting it wrong is silent: a `wake: 'notify'` holder promoted
   * outside tmux has no pane for the fallback arm to match, so it would be injected
   * *never* — blind to its own fleet, on the one delivery path that does not need a
   * pane, and with no error anywhere.
   *
   * Measured on Claude Code 2.1.220 rather than assumed (a throwaway hook that dumps
   * its stdin, beside an MCP server that dumps its environment, in one run):
   *
   *   hook payload session_id           11111111-1111-1111-1111-111111111111
   *   MCP server CLAUDE_CODE_SESSION_ID 11111111-1111-1111-1111-111111111111   <- same string
   *   MCP server CLAUDE_SESSION_ID      undefined
   *   the parent session's own          22222222-2222-2222-2222-222222222222   <- overwritten, so it is per-session
   *
   * Two facts fall out. The id *is* reachable from inside the bus process, so no
   * reconcile-from-the-first-hook dance is needed; and it is spelled
   * `CLAUDE_CODE_SESSION_ID`, not the `CLAUDE_SESSION_ID` the originally planned
   * entrypoint read — which is undefined, i.e. a bus with no `SOMA_SESSION_ID` exported
   * would have had no identity at all.
   *
   * Harness first, override second, on purpose: the harness value is the only one
   * that can satisfy the hook contract, so an override can only ever be *wrong* while
   * it is present. `SOMA_SESSION_ID` stays as the fallback for the degraded cases —
   * a test, a hand-run bus, a future Claude Code that renames the variable — and when
   * neither is set `soma_adopt` refuses rather than writing a lease no hook can match.
   */
  const sessionId = () => {
    if (nonEmpty(env?.CLAUDE_CODE_SESSION_ID)) return env.CLAUDE_CODE_SESSION_ID;
    return nonEmpty(env?.SOMA_SESSION_ID) ? env.SOMA_SESSION_ID : null;
  };

  /** Which of the two the identity came from — `null` when there is no identity. */
  const sessionIdSource = () => {
    if (nonEmpty(env?.CLAUDE_CODE_SESSION_ID)) return 'claude-code';
    return nonEmpty(env?.SOMA_SESSION_ID) ? 'soma-env' : null;
  };

  /**
   * The tmux server this session's panes live on — `busSocket`, the one spelling `wake()` uses too.
   *
   * It is written into the lease on purpose, because a pane id only means something on the server
   * that numbered it, and the lease's `degraded` check only looks at the pane. A `wake: 'tmux'`
   * claim without its server leaves each reader to assume its own: the socket split-brain measured
   * while building `tmux.mjs` (a watchdog on the wrong server declares every lead dead), arriving
   * through the lease. The two readers that type into the lease's pane, `wake()` and `demote()`,
   * compare it with their own socket and do not type across servers; a lease that records no socket
   * gives them nothing to compare, and they type on their own server as they always did.
   */
  const socket = () => busSocket(env);

  /** This session's tmux pane as its environment states it, or null outside tmux. Unproven: see `provenPane`. */
  const paneOf = () => (nonEmpty(env?.SOMA_TMUX_PANE) ? env.SOMA_TMUX_PANE : null);

  /**
   * This session's pane, PROVEN to be on this bus's own tmux server, or null (issue #2).
   *
   * A pane id is a small per-server counter, so `$TMUX_PANE` alone cannot say which server it
   * means. A session promoted in the operator's everyday tmux offers that server's `%3`, and on
   * soma's server `%3` is a lead or a teammate: recorded as a keystroke target, every urgent wake
   * went to that stranger. So the pane is offered to `paneOnServer` together with the session's
   * `$TMUX`, and only a `true` makes it this session's pane. Anything else is null — a session
   * outside tmux, one in another server, no server, a missing pane, a verifier that throws, and no
   * verifier wired at all — because null is the notify claim: toasts and pull delivery, never a
   * keystroke into an unproven pane.
   *
   * One spelling, shared by `claimOf` (which writes it) and `beat` (which repairs it): two could
   * disagree about what this session's pane is, and the repair would then fight the claim. It costs
   * one tmux round trip, so `soma_adopt` takes it once per call and `beat` at most once a minute.
   */
  const provenPane = async () => {
    const pane = paneOf();
    if (pane === null || !has('paneOnServer')) return null;
    try {
      return (await deps.paneOnServer(pane, env?.TMUX)) === true ? pane : null;
    } catch {
      return null;
    }
  };

  /**
   * Stamp the lease, at most once a minute — the whole reason this wrapper exists.
   *
   * `leaseStale` is true past a ten-minute heartbeat *even for a holder whose pane
   * is alive*, and only the holder can refresh its own stamp, so without this an
   * orchestrator that spends eleven minutes thinking is silently stealable by the
   * next `/soma-promote` — no force, no DEMOTED notice, two orchestrators on one
   * queue. The bus is a passive server, so "every tool call" is the only clock it
   * has: after any call the stamp is at most a minute old, which turns the ten
   * minute window into "ten minutes since this orchestrator last did anything".
   *
   * The floor is read off the *lease*, not kept in this process, and that is
   * deliberate on both sides:
   * - an in-process floor cannot see a stamp that changed underneath it (a steal
   *   and a re-adopt, the inject hook's own refresh, an operator's edit), so it
   *   would skip writes that were genuinely needed;
   * - `readLease` is a lock-free read of one small file, while `heartbeat` is a
   *   read-modify-write *inside the fleet lock* — the same lock the watchdog needs
   *   every 30 s. Skipping the write is worth a read.
   *
   * Which also means a session that does not hold the lease never touches the lock
   * at all: `heartbeat` would no-op for it anyway, and every candidate session on
   * the machine carries `soma_status`.
   */
  const beat = async (current) => {
    const sid = sessionId();
    if (!sid || !has('heartbeat')) return;
    if (current?.session_id !== sid) return;
    if (Number.isFinite(current.heartbeat_at) && Date.now() - current.heartbeat_at < HEARTBEAT_FLOOR_MS) return;
    try {
      // The pane travels with the stamp: see `lease.heartbeat`. A resumed session keeps its
      // session id and gets a NEW pane id, so the holder's own environment is the only place
      // the truth lives, and a heartbeat is the only thing that happens often enough to carry
      // it. `provenPane()` is the same proof `claimOf()` uses, so the repair cannot disagree
      // with the claim it is repairing — and a session resumed into another tmux server offers
      // null, which `lease.heartbeat` leaves alone, rather than a pane id that means a stranger
      // on soma's server. This floor is what keeps the proof to one tmux call a minute.
      await deps.heartbeat(sid, { pane: await provenPane() });
    } catch {
      // The lease keeps its previous stamp; the next call tries again. A busy fleet
      // lock is not a reason to fail the operator's actual request.
    }
  };

  /**
   * DOES THIS SESSION STILL HOLD THE LEASE? `null` if it does; the refusal if it does not.
   *
   * ⚠ **Eleven of the twelve tools used to never ask.** `beat()` above computed exactly
   * this comparison — `current?.session_id !== sid` — and threw it away, using it only to
   * decide whether to stamp a heartbeat and then `return`ing silently while `def` went on
   * to `await handler(...)`. Measured live, two sessions, real `lease.mjs` and `fleet.mjs`:
   * after B force-stole the lease, A **still enqueued a row, still called `killSession` on
   * a live lead, still typed orders into a lead's pane and still paused the queue.**
   * `soma_release` was the only one of twelve that compared the holder.
   *
   * That is not a small hole. The single-holder lease is the mechanism the entire
   * promotion design rests on, and `force: true` is gated on operator assent *precisely
   * because* stealing is destructive — so the operator was assenting to a steal that did
   * not bind the session it stole from. Spec §15 #11 bounds the residual to "the window
   * between steal and next call"; without this it was unbounded, and two compensating
   * controls the design names are absent or advisory (the DEMOTED send-keys notice is a
   * prompt a model may ignore, and "cuts that session off the event feed" depends on the
   * `UserPromptSubmit` inject hook, which nothing installs).
   *
   * **The refusal names the holder**, the way `soma_release` does, because "you were
   * demoted" is only actionable with "by whom, and how long ago" attached — and because a
   * demoted orchestrator's next move is either to stop or to re-adopt, and it cannot
   * choose without knowing whether the holder is live.
   *
   * **An unreadable lease refuses.** `leaseOf` answers `null` for a torn read, an EACCES
   * or an unwired dep, and this treats that as "not the holder". Fail-closed is the right
   * direction for a control plane whose gated tools kill sessions and type into panes, and
   * it strands nobody: `soma_adopt` is open, and adopting over an unreadable lease is
   * exactly the recovery the operator wants.
   */
  const notHolder = (current) => {
    const sid = sessionId();
    if (sid && isRecord(current) && current.session_id === sid) return null;
    return {
      ...refuse('this session does not hold the orchestrator lease, so it may not drive the fleet — it was released, or another session adopted it, which is what a forced adopt does to a session that is still running. Nothing was done. The current holder is in `holder`; soma_status and soma_transcript still work, and soma_adopt takes the lease back (forcing it is the operator\'s call)'),
      holder: shapeHolder(current),
    };
  };

  /**
   * Register one tool: heartbeat, then the work, then a net.
   *
   * The net is the last line of defence, not the mechanism — every *expected*
   * failure below is already a `{ok:false, error}` value. What it catches is a
   * defect (a dep that is not a function, a shape nothing anticipated), and it
   * exists because the alternative is a -32000 carrying a message this module has
   * spent its whole length keeping filesystem paths out of. The error's *name* is
   * safe to forward and is the only clue that survives.
   */
  /**
   * A lead — or anything that inherited a lead's environment — may not use the
   * control plane at all. Design §6/§9 says "soma_adopt refuses them via inherited
   * SOMA_LEAD_NAME"; this widens it to every tool because soma_spawn is the one that
   * matters most: a lead that can spawn leads is a fork bomb of Claude Code sessions
   * on one subscription, and its children inherit the same power.
   *
   * Redundant today — buildTools hands a lead leadTools, which has none of these —
   * and that is the point. The role gate is one env var read in a file this module
   * does not own, so this is the layer that does not depend on it being right. It
   * also covers a teammate, which loads the *candidate* bus and would otherwise
   * reach soma_adopt and soma_status for real.
   */
  const leadTainted = () => (nonEmpty(env?.SOMA_LEAD_NAME)
    ? refuse(`this session belongs to lead ${quote(env.SOMA_LEAD_NAME)}: a lead — or a teammate that inherited its environment — may not use the orchestrator tools.`
      + ' If this really is an operator session, unset SOMA_LEAD_NAME and start a new one')
    : null);

  /**
   * Register one tool: role gate, **holder gate**, heartbeat, the work, then a net.
   *
   * `open: true` is the *exception* and every one of the five is argued at its own
   * `def`. The default is closed on purpose: a thirteenth tool added later is gated
   * unless someone consciously opens it, which is the opposite of how the first twelve
   * arrived (eleven of them ungated, by omission rather than by decision).
   *
   * The lease is read **once** per call and handed to both gates. `beat()` used to read
   * it itself, so this costs nothing new — the comparison it already made is simply no
   * longer discarded.
   */
  const def = (name, handler, { open = false } = {}) => {
    tools.set(name, async (args) => {
      const tainted = leadTainted();
      if (tainted) return tainted;
      const current = await leaseOf();
      if (!open) {
        const demoted = notHolder(current);
        if (demoted) return demoted;
      }
      await beat(current);
      try {
        return await handler(isRecord(args) ? args : {});
      } catch (e) {
        return refuse(`soma ${name} failed unexpectedly (${text(e?.name).slice(0, 32) || 'Error'}); this is a bus defect, not a fleet state`);
      }
    });
  };

  // -------------------------------------------------------------------------
  // Readers. Every one of them answers "I do not know" rather than throwing:
  // these are the deps that touch a filesystem the operator can break.
  // -------------------------------------------------------------------------

  /** The checkpoint, or null if it could not be read (torn, EACCES, unwired). */
  const fleetOf = async () => {
    try {
      const fleet = await deps?.readFleet?.();
      return isRecord(fleet) && Array.isArray(fleet.tasks) ? fleet : null;
    } catch {
      return null;
    }
  };

  const rowOf = async (id) => {
    const fleet = await fleetOf();
    return fleet ? fleet.tasks.find((t) => t?.id === id) ?? null : null;
  };

  const configOf = async () => {
    if (!has('loadConfig')) return null;
    try {
      const cfg = await deps.loadConfig();
      return isRecord(cfg) ? cfg : null;
    } catch {
      return null;
    }
  };

  /**
   * The config for a tool about to LAUNCH a lead: `{ cfg, error: null }`, or `{ cfg: null, error }`
   * when `loadConfig` threw.
   *
   * `configOf`'s null is right for a reader — `soma_status` and the intake check act on nothing —
   * and wrong here: a soma.json the loader refuses (it does not parse, or holds a `seats` that is
   * not an array) read as "no config" skipped `soma_spawn`'s `max_leads` gate, claimed the row and
   * stamped the stagger clock, and sent `soma_resume` seat-blind, both failing only at the
   * spawner's own read of the same file. So a throw is a refusal, before anything is picked or
   * claimed. A fixed sentence, because the loader's names the file's path, which this bus never
   * echoes. `loadConfig` unwired stays `cfg: null`, as `configOf` has it.
   */
  const configToLaunch = async () => {
    if (!has('loadConfig')) return { cfg: null, error: null };
    try {
      const cfg = await deps.loadConfig();
      return { cfg: isRecord(cfg) ? cfg : null, error: null };
    } catch {
      return {
        cfg: null,
        error: 'soma.json could not be loaded: it does not parse, or holds a value soma refuses, such as a seats that is not an array; nothing was claimed or launched. Run soma doctor in a shell to see which',
      };
    }
  };

  /**
   * The seat a manual launch goes onto (account rotation, design §4): `{ seat, error: null }`
   * with `seat` a Seat or null, or `{ seat: null, error }`.
   *
   * `cfg.seats` empty or absent is one account and no rotation — `seat: null`, `{}` to the
   * spawner — which is every fleet before seats existed; `pickSeat` unwired is the same answer,
   * so an old bus wiring degrades to seat-blind launches that `soma_status` shows as `seat: null`.
   * Every configured seat closed or unverified is a REFUSAL, not a launch onto whichever seat this
   * bus process runs under: that dir is a seat too, and may be the very account that just closed.
   * The watchdog holds silently in the same case; a hand-run launch gets a sentence.
   */
  const seatFor = async (cfg) => {
    if (!(Array.isArray(cfg?.seats) && cfg.seats.length > 0) || !has('pickSeat')) return { seat: null, error: null };
    let seat;
    try {
      seat = await deps.pickSeat(Date.now(), cfg);
    } catch (e) {
      return { seat: null, error: `soma.json.seats could not be read, so no seat can be picked${codeOf(e)}; run soma doctor` };
    }
    if (!isRecord(seat) || !nonEmpty(seat.config_dir)) {
      return {
        seat: null,
        error: `every configured seat is closed or unverified (${cfg.seats.length} in soma.json), so the lead would hit the same limit on its first turn;`
          + ' soma_status shows each seat\'s reset time — retry after the earliest, or leave it queued for the watchdog',
      };
    }
    return { seat, error: null };
  };
  /** The spawner's options object: `{configDir}` for a picked seat, `{}` for the spawner's own env. */
  const launchOptsFor = (seat) => (seat === null ? {} : { configDir: seat.config_dir });
  /** The label the row and the reply carry — never the config_dir, which is a path. */
  const seatLabelOf = (seat) => (seat === null ? null : cut(seat.label, 32));

  const leaseOf = async () => {
    try {
      return (await deps?.readLease?.()) ?? null;
    } catch {
      return null;
    }
  };

  /**
   * Is `lease` free for the taking? `null` means "cannot tell" — which is a third
   * answer on purpose, because "cannot tell" must never be reported as "alive".
   */
  const staleOf = async (lease) => {
    if (!lease) return true; // no orchestrator at all is the stalest lease of the lot
    if (!has('leaseStale')) return null;
    try {
      // `leaseStale` throws unless it is handed a predicate, and a pane probe is a
      // dep this module may not have. Assuming the pane is there is the lenient
      // direction: staleness then rests on the heartbeat alone, so a crashed holder
      // costs one 10-minute wait instead of one silent steal.
      const verdict = await deps.leaseStale(lease, has('hasPane') ? deps.hasPane : () => true);
      // A boolean or nothing. Coercing with !! would read truthy garbage from a
      // mis-wired dep as STALE and hand the fleet to the next caller with no force
      // and no DEMOTED notice. Unknown is the direction that refuses.
      return typeof verdict === 'boolean' ? verdict : null;
    } catch {
      return null;
    }
  };

  /** A tmux session that exists, positively confirmed. Anything else is absent. */
  const sessionAlive = async (target) => {
    try {
      return (await deps?.hasSession?.(target)) === true;
    } catch {
      return false;
    }
  };

  /** Every field of a lease record, bounded — the file is hand-editable. */
  const shapeHolder = (lease) => (isRecord(lease)
    ? {
      session_id: cut(lease.session_id, MAX_ECHO),
      tmux_pane: cut(lease.tmux_pane, MAX_ECHO),
      tmux_socket: cut(lease.tmux_socket, MAX_ECHO),
      wake: lease.wake === 'tmux' ? 'tmux' : 'notify',
      lease_seq: Number.isInteger(lease.lease_seq) ? lease.lease_seq : null,
      heartbeat_age_ms: Number.isFinite(lease.heartbeat_at) ? Math.max(0, Date.now() - lease.heartbeat_at) : null,
    }
    : null);

  /**
   * The tmux session a lead is in: what the spawner recorded when that is a session
   * name, else the name the spawner would have used. See `TMUX_NAME_RE` — the
   * recorded value is read out of the checkpoint, so it is validated rather than
   * trusted, both because it becomes a tmux target and because it reaches a model.
   */
  const targetOf = (task) => (nonEmpty(task?.tmux_session) && TMUX_NAME_RE.test(task.tmux_session)
    ? task.tmux_session
    : `lead-${task?.id}`);

  /** An id that is safe as a filename, a stream and a tmux target. */
  const badId = (id, what) => (nonEmpty(id) && LEAD_RE.test(id) && !RESERVED_STREAMS.has(id)
    ? null
    : refuse(`${what} must be a task id like "task-42" — lowercase letters, digits and dashes — not ${quote(id)}`));

  /**
   * Append to the orchestrator's own stream. `{ok}`, never a throw, never a path:
   * the orch-side twin of `leadTools`' `store()`, and for the same reason.
   */
  const logOrch = async (event) => {
    try {
      await deps?.appendEvent?.(ORCH_STREAM, event);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * How much mail is waiting — counted, never consumed. `soma_inbox` is the only
   * thing that moves the cursor, so an adopting orchestrator can be told there are
   * three unread events and still read all three.
   */
  const unreadCount = async () => {
    try {
      const waiting = await deps?.unread?.(ORCH_STREAM, await streamsOf());
      return Array.isArray(waiting) ? waiting.length : null;
    } catch {
      return null;
    }
  };

  /** Streams the orchestrator's inbox sweeps: every lead's, plus its own. */
  const streamsOf = async () => {
    if (has('eventStreams')) {
      try {
        const streams = await deps.eventStreams();
        if (Array.isArray(streams)) return streams;
      } catch {
        // fall through to the fleet — an inbox that sweeps nothing reads as "no
        // news", which is indistinguishable from a working fleet going quiet.
      }
    }
    const fleet = await fleetOf();
    const ids = fleet ? fleet.tasks.map((t) => t?.id).filter((id) => nonEmpty(id)) : [];
    return [...ids, ORCH_STREAM];
  };

  // -------------------------------------------------------------------------
  // soma_adopt / soma_release — the lease
  // -------------------------------------------------------------------------

  /**
   * What this session claims when it takes the fleet. Field by field, because the
   * lease record's shape is a contract four other readers depend on.
   *
   * Keystroke wakes only for a pane proven to be on this bus's server (`provenPane`); anything
   * else claims `notify`, with no pane and no socket, and the adopt reply then says
   * `degraded_wake: true`. Async because the proof is a tmux round trip, so `soma_adopt` takes
   * the claim ONCE and reuses it for the comparison, the grant and the reply.
   */
  const claimOf = async () => {
    const pane = await provenPane();
    const wake = pane ? 'tmux' : 'notify';
    return { session_id: sessionId(), tmux_socket: wake === 'tmux' ? socket() : null, tmux_pane: pane, wake };
  };

  /**
   * Tell the session we just displaced that it is no longer the orchestrator.
   *
   * Best-effort and typed into `stolen_from`'s pane, not into the current lease's:
   * see the header. Skipped when the displaced holder has no pane (a `notify`
   * holder) or lives on another tmux server, since send-keys always talks to ours
   * and a matching pane id on the wrong server is a stranger's terminal.
   */
  const demote = async (stolen, seq) => {
    if (!isRecord(stolen)) return { sent: false, reason: 'nobody was displaced' };
    // A session re-adopting its own lease has displaced nobody, and typing "you have
    // been demoted" into the caller's own composer would spend its next turn on a
    // notice about itself.
    if (stolen.session_id === sessionId()) return { sent: false, reason: 'the displaced record was this session\'s own' };
    if (!nonEmpty(stolen.tmux_pane)) return { sent: false, reason: 'the displaced holder has no pane to type into' };
    if (nonEmpty(stolen.tmux_socket) && stolen.tmux_socket !== socket()) {
      return { sent: false, reason: 'the displaced holder is on a different tmux server' };
    }
    const line = oneLine(`[soma] DEMOTED: session ${text(sessionId()).slice(0, MAX_ECHO)} adopted the orchestrator lease`
      + ` (seq ${Number.isInteger(seq) ? seq : '?'}). You are no longer the orchestrator; call soma_adopt to take it back.`);
    try {
      return landed(await deps?.sendKeys?.(stolen.tmux_pane, line))
        ? { sent: true }
        : { sent: false, reason: 'the displaced holder\'s pane did not accept the notice' };
    } catch {
      return { sent: false, reason: 'the notice could not be typed into the pane' };
    }
  };

  def('soma_adopt', async ({ force = false } = {}) => {
    const sid = sessionId();
    if (!sid) {
      // `acquireLease` throws a TypeError on a claim with no session id. Refusing
      // first turns that into something the model can act on, and stops a lease
      // being written that `readLease` would then read as "no holder".
      return {
        adopted: false,
        error: 'this bus process has no session identity: neither CLAUDE_CODE_SESSION_ID (which Claude Code sets for its own child processes)'
          + ' nor SOMA_SESSION_ID is set, so nothing can be recorded as the lease holder and the inject hook could not recognise it. Run soma doctor',
      };
    }

    const current = await leaseOf();
    // Taken ONCE and reused below for the comparison, the grant and the reply: the claim costs a
    // tmux round trip now (`provenPane`), and three proofs could also answer three ways.
    const claim = await claimOf();

    /**
     * Already ours, and the record still describes us: an idempotent success.
     *
     * Going through `acquireLease` would bump `lease_seq` — the receipt a displaced
     * holder compares to tell "still mine" from "stolen while I was thinking" — for
     * a promotion that displaced nobody. The `/soma-promote` skill is expected to
     * call `soma_adopt` on a session that may already hold the lease, and a resumed
     * or compacted orchestrator will call it again; neither is a generation change.
     * The heartbeat has already been stamped by the wrapper above.
     */
    const mine = !!current && current.session_id === sessionId();
    if (mine) {
      if (current.wake === claim.wake && (current.tmux_pane ?? null) === claim.tmux_pane
        && (current.tmux_socket ?? null) === claim.tmux_socket) {
        return {
          adopted: true,
          already_held: true,
          lease_seq: Number.isInteger(current.lease_seq) ? current.lease_seq : null,
          wake: claim.wake,
          degraded_wake: claim.wake !== 'tmux',
          forced: false,
          stolen_from: null,
          demoted_notice: null,
          unread_count: await unreadCount(),
          session_id_source: sessionIdSource(),
        };
      }
      // The record disagrees with this session's environment (it was promoted
      // outside tmux and is now inside a pane, or its pane id changed across a
      // reattach, or its pane can no longer be proven to be on soma's server), so it
      // is rewritten rather than left describing a wake path that goes nowhere — or
      // into somebody else's pane.
    }

    const stale = await staleOf(current);
    // `mine` forces too: a session's own record is its own to rewrite, and a live
    // `notify` holder that has since gained a pane is not stale — so without this it
    // could never repair a lease describing a wake path it no longer has.
    const forced = force === true || stale === true || mine;

    let grant;
    try {
      grant = await deps.acquireLease(claim, { force: forced });
    } catch (e) {
      return { adopted: false, error: `the orchestrator lease could not be claimed; the fleet lock is unavailable${codeOf(e)}` };
    }

    if (grant?.ok !== true) {
      const proven = stale === false;
      return {
        adopted: false,
        holder: shapeHolder(grant?.holder ?? current),
        holder_live: proven ? true : null,
        error: proven
          ? 'the fleet already has a live orchestrator (its pane is present, or it heartbeated within the last ten minutes); adopting would demote it, so pass force:true only if the operator says to'
          : 'the fleet already has an orchestrator, and this bus could not check whether it is still alive — so the refusal does not prove liveness. Look at soma_status, then pass force:true only if the operator says to',
      };
    }

    const demoted = grant.stolen_from ? await demote(grant.stolen_from, grant.lease_seq) : null;
    return {
      adopted: true,
      lease_seq: Number.isInteger(grant.lease_seq) ? grant.lease_seq : null,
      wake: claim.wake,
      degraded_wake: grant.degraded === true,
      // "we took it from somebody else", not "we passed a flag": every first
      // adoption of a free fleet passes force (a null lease is a stale lease) and so
      // does every rewrite of our own record, and reporting either as a forced steal
      // would read as though something had been taken from someone.
      forced: !!current && !mine && forced,
      stolen_from: shapeHolder(grant.stolen_from),
      demoted_notice: demoted,
      unread_count: await unreadCount(),
      // 'claude-code' means the recorded identity is the one the inject hook compares
      // against; 'soma-env' means it is an override, and injection will only reach
      // this session through the lease's pane.
      session_id_source: sessionIdSource(),
    };
  }, {
    // OPEN — this is how a session ACQUIRES the lease. Gating it on already holding one
    // would make promotion impossible and demotion permanent, and it is the documented
    // way back for a session this gate has just refused.
    open: true,
  });

  def('soma_release', async () => {
    const sid = sessionId();
    if (!sid) return { released: false, error: 'this bus process has no session identity (neither CLAUDE_CODE_SESSION_ID nor SOMA_SESSION_ID), so it cannot be holding anything to give back' };
    let result;
    try {
      result = await deps.releaseLease(sid);
    } catch (e) {
      return { released: false, error: `the lease could not be released; the fleet lock is unavailable${codeOf(e)}` };
    }
    if (result?.released !== true) {
      // Both "there is no lease" and "you were force-stolen from": a demoted
      // session may not unmount the orchestrator that replaced it.
      return { released: false, holder: shapeHolder(await leaseOf()), error: 'this session does not hold the orchestrator lease, so it cannot hand it back' };
    }
    const fleet = await fleetOf();
    const running = fleet ? fleet.tasks.filter((t) => t?.status === 'spawned').length : null;
    return {
      released: true,
      leads_running: running,
      note: running ? 'those leads keep running; nothing answers a NEEDS_INPUT until some session adopts the fleet' : null,
    };
  }, {
    // OPEN — it compares the holder itself, eight lines up, and answers with a richer
    // shape than the generic refusal (`released: false` plus the holder, so a demoted
    // session learns it may not unmount the orchestrator that replaced it). Routing it
    // through the generic gate would replace a specific, tested answer with a general one.
    open: true,
  });

  // -------------------------------------------------------------------------
  // soma_enqueue / soma_queue — the backlog
  // -------------------------------------------------------------------------

  /** Repo names the operator has configured, or null when nothing is configured. */
  const knownRepos = (repos) => {
    if (!isRecord(repos)) return null;
    const names = Object.keys(repos);
    // An unconfigured fleet validates nothing: refusing every task on a fresh
    // install would make the first `soma_enqueue` impossible, and the spawner
    // reports an unknown repo with a real diagnosis anyway.
    return names.length ? new Set(names) : null;
  };

  /**
   * The budget classes soma.json defines, or null when there is nothing to check a pin against.
   *
   * A class counts only as an own key whose value is a record of caps: the rule the watchdog binds
   * a pinned class by and `harness.readBudgets` prices a harness by, so a class this door admits is
   * one the breaker can bind. Null, validating nothing, for the reason `knownRepos` gives.
   */
  const knownBudgetClasses = (budgets) => {
    if (!isRecord(budgets)) return null;
    const names = Object.keys(budgets).filter((name) => isRecord(budgets[name]));
    return names.length ? new Set(names) : null;
  };

  def('soma_enqueue', async ({ tasks } = {}) => {
    if (!Array.isArray(tasks)) {
      return refuse('tasks must be an array of task objects, e.g. [{"id":"task-42","title":"…","repo":"…","brief":"…"}]');
    }
    if (tasks.length > MAX_ENQUEUE) {
      return refuse(`${tasks.length} tasks in one call is more than a backlog; send at most ${MAX_ENQUEUE} per call`);
    }
    // One read of soma.json for every use: the repo names and budget classes gate intake below,
    // and the repo map itself goes to `enqueue`, which never reads the config and needs it for a
    // repo's `verify_hint`.
    const cfg = await configOf();
    const repos = cfg?.repos;
    const known = knownRepos(repos);
    const classes = knownBudgetClasses(cfg?.budgets);
    const rejected = [];
    const accepted = [];
    for (const task of tasks) {
      if (!isRecord(task)) {
        rejected.push({ id: null, reason: 'not-an-object' });
        continue;
      }
      const id = cut(task.id, MAX_ECHO);
      // `fleet`'s id regex permits `orch`, which is the orchestrator's own event
      // stream — a task by that name would file its reports into the inbox's own
      // file. Refused at the only door into the fleet.
      if (RESERVED_STREAMS.has(task.id)) {
        rejected.push({ id, reason: 'reserved-id' });
        continue;
      }
      if (typeof task.brief === 'string' && task.brief.length > MAX_BRIEF) {
        rejected.push({ id, reason: 'brief-too-long' });
        continue;
      }
      if (known && !known.has(task.repo)) {
        rejected.push({ id, reason: 'unknown-repo' });
        continue;
      }
      // The watchdog prices a lead at its pinned class from the first tick, and passes over a pin
      // it cannot bind without a word whenever the lead's harness prices it. A typo has to be
      // caught here, or the pin is simply never applied. `classes` holds only names, so a pin
      // that is not a string at all fails the same `has`.
      if (classes && task.budget_class !== undefined && task.budget_class !== null && !classes.has(task.budget_class)) {
        rejected.push({ id, reason: 'unknown-budget-class' });
        continue;
      }
      accepted.push(task);
    }

    let result = { queued: [], skipped: [] };
    if (accepted.length) {
      try {
        result = (await deps.enqueue(accepted, { repos })) ?? result;
      } catch (e) {
        return refuse(`the fleet checkpoint could not be updated${codeOf(e)}`);
      }
    }
    // `enqueue` echoes back the id it rejected, and an id it rejected is by
    // definition one it did not validate — so it is bounded here, not there.
    const fromFleet = Array.isArray(result.skipped)
      ? result.skipped.map((row) => ({ id: cut(row?.id, MAX_ECHO), reason: cut(row?.reason, MAX_ECHO) }))
      : [];
    const out = { queued: Array.isArray(result.queued) ? result.queued : [], skipped: [...fromFleet, ...rejected] };
    if (known && rejected.some((row) => row.reason === 'unknown-repo')) out.known_repos = [...known].slice(0, 50);
    if (classes && rejected.some((row) => row.reason === 'unknown-budget-class')) out.known_budget_classes = [...classes].slice(0, 50);
    return out;
  });

  def('soma_queue', async ({ action = 'status' } = {}) => {
    const verb = text(action).trim().toLowerCase();
    if (!QUEUE_ACTIONS.has(verb)) {
      return refuse(`unknown queue action ${quote(action)}; expected pause, resume or status`);
    }
    let set = null;
    if (verb !== 'status') {
      // Reporting `{paused:true}` for a switch nobody wrote would freeze the queue
      // only in the orchestrator's head, while the watchdog kept admitting.
      if (!has('setQueuePaused')) {
        return refuse('this bus cannot pause admission: no queue switch is wired, and reporting a pause that was never written would only freeze the queue in this conversation');
      }
      try {
        await deps.setQueuePaused(verb === 'pause');
        set = verb === 'pause';
      } catch (e) {
        return refuse(`the queue switch could not be written${codeOf(e)}`);
      }
    }
    let paused = set;
    if (has('queuePaused')) {
      try {
        paused = (await deps.queuePaused()) === true;
      } catch {
        // keep what we just set; a read failure is not a state change
      }
    }
    const fleet = await fleetOf();
    return {
      paused: paused ?? null,
      queued: fleet ? fleet.tasks.filter((t) => t?.status === 'queued').length : null,
      active: fleet ? fleet.tasks.filter((t) => t?.status === 'spawned').length : null,
    };
  });

  // -------------------------------------------------------------------------
  // soma_spawn — admission
  // -------------------------------------------------------------------------

  def('soma_spawn', async ({ task_id } = {}) => {
    const bad = badId(task_id, 'task_id');
    if (bad) return bad;
    if (!has('spawnLead')) return refuse('this bus cannot spawn leads: no spawner is wired');
    if (!has('updateFleet')) {
      return refuse('this bus cannot admit a task safely: the transactional fleet writer is not wired, and an unlocked read-modify-write would let this bus and the watchdog both spawn past max_leads');
    }
    const loaded = await configToLaunch();
    if (nonEmpty(loaded.error)) return refuse(loaded.error);
    const { cfg } = loaded;
    // Onto an open seat, picked BEFORE the claim so a refusal leaves the row queued and creates
    // nothing (see `seatFor`).
    const picked = await seatFor(cfg);
    if (nonEmpty(picked.error)) return refuse(picked.error);
    const seat = seatLabelOf(picked.seat);

    /**
     * Admission and the row flip, in one transaction.
     *
     * Both halves have to be inside it: two admitters checking capacity and then
     * separately marking a row can each see a slot and both take it. `admit`
     * returning null is exactly "at capacity" here, because the branch above has
     * already established that this task is queued — so "nothing to admit" is not
     * one of the answers it can mean. `setTaskStatus` nests safely (it shares this
     * snapshot and publishes once) and is also what stamps `last_spawn_at`, the
     * stagger clock, which is why nothing below touches that field.
     *
     * The claim also writes the LAUNCH MARK, `launching_at`. The spawn below runs outside
     * the lock and creates the tmux session last, after a fetch allowed two minutes, so
     * until it records the session this row is `spawned` with no session: a dead lead to
     * both status reports, and to a watchdog tick that lands in the window, which would
     * revive it under this spawner. The mark is what they read as "still starting"
     * instead (`fleet.launching`, bounded); the record below clears it, and so does the
     * requeue if the spawn fails.
     */
    let claimed;
    try {
      claimed = await deps.updateFleet((fleet) => {
        const rows = Array.isArray(fleet?.tasks) ? fleet.tasks : [];
        const task = rows.find((t) => t?.id === task_id);
        if (!task) return { error: `no task ${quote(task_id)} in the fleet; enqueue it first` };
        if (task.status === 'spawned') return { error: `task ${quote(task_id)} is already spawned` };
        if (task.status !== 'queued') return { error: `task ${quote(task_id)} is ${quote(task.status)}, not queued; re-queue it before spawning` };
        if (cfg && has('admit')) {
          let room;
          try {
            room = deps.admit(fleet, cfg);
          } catch {
            return { error: 'max_leads in soma.json is not a non-negative integer, so admission cannot be judged; fix it and try again' };
          }
          if (room === null) {
            const active = rows.filter((t) => t?.status === 'spawned').length;
            return { error: `the fleet is at max_leads (${active} running); wait for a lead to finish or raise max_leads` };
          }
        }
        deps.setTaskStatus(task_id, 'spawned');
        task.launching_at = Date.now();
        return { task: { ...task } };
      });
    } catch (e) {
      return refuse(`the fleet checkpoint could not be updated${codeOf(e)}`);
    }
    if (nonEmpty(claimed?.error)) return refuse(claimed.error);
    if (!isRecord(claimed?.task)) return refuse(`task ${quote(task_id)} could not be claimed for spawning`);

    // Outside the lock, deliberately: a spawn is a git worktree, a settings write
    // and a tmux server round trip, and the fleet lock is what the watchdog needs
    // every 30 s. It is inside the *serialized* tools/call queue, so a slow spawn
    // delays this session's later tool calls and nothing else.
    let spawn;
    try {
      spawn = await deps.spawnLead(claimed.task, launchOptsFor(picked.seat));
    } catch (e) {
      let requeued = false;
      try {
        // Back in the queue and no longer starting, in one write: a row that kept the mark would
        // read `starting` for nothing, and one that lost it first would read dead for a moment.
        await deps.updateFleet((fleet) => {
          deps.setTaskStatus(task_id, 'queued');
          const task = (Array.isArray(fleet?.tasks) ? fleet.tasks : []).find((t) => t?.id === task_id);
          if (task) task.launching_at = null;
          return true;
        });
        requeued = true;
      } catch {
        // the watchdog's reconcile is the backstop: the mark stays, so it waits out the bound and
        // then revives the row like any dead lead
      }
      return {
        ok: false,
        spawned: false,
        requeued,
        error: `the lead could not be spawned${codeOf(e)}; ${requeued ? 'the task is queued again' : 'the task row still says spawned, and the watchdog will reconcile it'}.`
          + ' The reason is withheld here because a spawn failure names filesystem paths — run soma doctor',
      };
    }

    /**
     * Record what the spawner minted. Nothing else in v1 does, and three things
     * read it: `tokens.readUsage(t.lead_session_uuid)` (so the watchdog's budget
     * breaker has a transcript to price), `soma_resume` (`claude --resume <uuid>`),
     * and every tmux target that must survive a worktree retry suffix.
     */
    const uuid = cut(spawn?.session_uuid, MAX_ECHO);
    const target = cut(spawn?.tmux_target, MAX_ECHO) ?? `lead-${task_id}`;
    let recorded = false;
    try {
      recorded = (await deps.updateFleet((fleet) => {
        const task = (Array.isArray(fleet?.tasks) ? fleet.tasks : []).find((t) => t?.id === task_id);
        if (!task) return false;
        if (uuid) task.lead_session_uuid = uuid;
        task.tmux_session = target;
        // The seat this launch went onto (its soma.json label, or null for the spawner's own
        // env): what the watchdog's limits phase closes on this lead's next limit hit. Same write
        // as the uuid, so the row cannot say "spawned on seat-b" with no session, or the reverse.
        task.seat = seat;
        // The session exists now, so the launch mark the claim wrote goes, in the same write as
        // the target: liveness is the session's from here on.
        task.launching_at = null;
        // `updated` is deliberately NOT stamped here. It is the clock the terminal
        // guard reads, and the `spawned` transition a few lines above already moved
        // it — earlier, which is the direction that cannot strand an event. Stamping
        // it again here would decline a terminal report filed at or before this write
        // *permanently*, leaving the row `spawned` and its slot held forever.
        return true;
      })) === true;
    } catch {
      recorded = false;
    }

    return {
      spawned: true,
      lead: cut(spawn?.lead, MAX_ECHO) ?? task_id,
      task_id,
      tmux_target: target,
      session_uuid: uuid,
      cwd: cut(spawn?.cwd, 512),
      seat,
      recorded,
      ...(recorded ? {} : { warning: 'the session id could not be written to the fleet checkpoint, so token accounting and resume will not find this lead until the watchdog reconciles it' }),
    };
  });

  // -------------------------------------------------------------------------
  // soma_status — one row per lead
  // -------------------------------------------------------------------------

  const usageOf = async (task) => {
    if (!nonEmpty(task?.lead_session_uuid) || !has('readUsage')) return {};
    try {
      const usage = await deps.readUsage(task.lead_session_uuid);
      return isRecord(usage) ? usage : {};
    } catch {
      return {}; // a half-written transcript must not take the whole status down
    }
  };

  /** The token cap this task is priced against, from the config's own numbers. */
  const capOf = (task, cfg) => {
    const budgets = cfg?.budgets;
    // hasOwn, not `in`: a budget class named `constructor` would otherwise resolve
    // through Object.prototype and price a lead against a function.
    if (!isRecord(budgets) || !nonEmpty(task?.budget_class) || !Object.hasOwn(budgets, task.budget_class)) return null;
    const cap = budgets[task.budget_class]?.tokens_cap;
    return Number.isFinite(cap) && cap > 0 ? cap : null;
  };

  const teamOf = async (target) => {
    if (!has('listPanes')) return [];
    try {
      const panes = await deps.listPanes(target);
      return Array.isArray(panes)
        ? panes.slice(0, MAX_PANES).map((pane) => ({ title: cut(pane?.title, 60) ?? '', dead: pane?.dead === true }))
        : [];
    } catch {
      return [];
    }
  };

  const heartbeatAgeOf = async (id) => {
    if (!has('heartbeatAgeMs')) return null;
    try {
      const age = await deps.heartbeatAgeMs(id);
      // Clamped at zero: the event log's `ts` is a monotonic stamp that can run
      // ahead of the wall clock after a backward NTP step, and a negative age
      // reads as "the future" to every consumer.
      return Number.isFinite(age) ? Math.max(0, age) : null;
    } catch {
      return null;
    }
  };

  /**
   * The pane behind `target`, read live through the injected reader; `UNREAD_PANE` when this bus
   * has none. `panes` is a listing already taken this call, so `soma_status` lists once.
   */
  const paneReadingOf = async (target, panes) => {
    if (!has('paneReading')) return UNREAD_PANE;
    try {
      return shapeReading(await deps.paneReading(target, panes));
    } catch {
      return unreadable('the pane reader threw');
    }
  };

  /** One pane listing for a whole `soma_status`; `null` when it could not be taken, `undefined` when unwired. */
  const paneListing = async () => {
    if (!has('paneStates')) return undefined;
    try {
      const panes = await deps.paneStates();
      return panes === null || panes === undefined ? null : panes;
    } catch {
      return null;
    }
  };

  /**
   * Is this row a lead that is still being launched? Asked through the injected predicate
   * (`fleet.launching`, which `soma-bus.mjs` wires) because this module imports nothing: the ONE
   * the watchdog's reconcile and `soma status` read too, so the three judge a row by one rule.
   * No predicate wired, or one that throws, answers no — the answer every row got before the mark.
   */
  const launchingNow = async (task) => {
    if (!has('launching')) return false;
    try {
      return (await deps.launching(task, Date.now())) === true;
    } catch {
      return false;
    }
  };

  const statusRow = async (task, cfg, panes) => {
    const target = targetOf(task);
    const running = task?.status === 'spawned';
    // A queued row never had a session, so there is no pane to read and nothing is claimed.
    const pane = task?.status === 'queued' ? UNREAD_PANE : await paneReadingOf(target, panes);
    const readLive = pane.source === 'live';
    // Liveness from the PANE when it can be read (added after leads sat unseen as bare shells):
    // `sessionAlive` is a session-NAME probe, and a dead pane and a bare shell both answered
    // "alive" to it. Five values now. `unknown` when the pane could not be observed, never
    // `absent` — a tmux hiccup must not render a working lead as gone. And `starting` for a lead
    // whose spawn has claimed the row and not yet made its session: the claim comes first and the
    // session last, after a fetch allowed two minutes, and for that whole window the row read
    // exactly like a lead that had died. Only a pane that reads ABSENT (or, with no reader, a
    // session that is not there) can be starting, so `unknown` still wins, and a dead pane or a
    // bare shell is never dressed up as a launch. A bus with no reader keeps the name probe, so
    // an old wiring degrades to the old answer rather than to no answer.
    let liveness;
    if (!running) liveness = 'not-running';
    else if (readLive) {
      liveness = pane.state === 'alive' || pane.state === 'blocked_on_prompt' || pane.state === 'unrecognised'
        ? 'alive'
        : pane.state === 'unobservable' ? 'unknown'
          : pane.state === 'absent' && (await launchingNow(task)) ? 'starting' : 'absent';
    } else {
      liveness = (await sessionAlive(target)) ? 'alive' : (await launchingNow(task)) ? 'starting' : 'absent';
    }
    const live = liveness === 'alive';
    const recordedState = cut(task?.pane_state, 32);
    const usage = await usageOf(task);
    const cap = capOf(task, cfg);
    const est = Number.isFinite(usage.est_tokens) ? usage.est_tokens : null;
    return {
      lead: task.id,
      task_id: task.id,
      title: cut(task.title, MAX_TITLE),
      repo: cut(task.repo, MAX_ECHO),
      status: cut(task.status, 32),
      // `alive`, `starting`, `absent`, `unknown` or `not-running` (see above). Never two values: a
      // done or blocked lead is not "absent", and reading it as absent is what makes an operator
      // revive something that finished; a lead still starting is not either, and reading it as
      // absent is what makes one kill a lead in the middle of its launch.
      liveness,
      // What the pane is doing, beside what `status` says — live when this bus can read panes,
      // else the watchdog's recorded word. NO excerpt here: the dialog text carries absolute
      // paths, and nothing in a status row may reach the model with one.
      pane_state: readLive ? pane.state : recordedState,
      pane_fine: readLive ? pane.fine : null,
      pane_kind: readLive ? pane.kind : cut(task?.pane_kind, 32),
      pane_cmd: readLive ? pane.cmd : (nonEmpty(task?.pane_cmd) ? task.pane_cmd.split('/').pop().slice(0, 32) : null),
      pane_state_source: readLive ? 'live' : (recordedState === null ? null : 'recorded'),
      // The watchdog's clock: how long its census has seen the RECORDED state. Null until a
      // census has run against this row.
      pane_state_age_ms: Number.isFinite(task?.pane_state_since) ? Math.max(0, Date.now() - task.pane_state_since) : null,
      // The seat this lead runs under (account rotation): the LABEL only — a seat's config_dir
      // is a path, and no path reaches the model from a status row. Null for a row spawned
      // before seats existed or with none configured.
      seat: cut(task?.seat, 32),
      // Three per hour is the watchdog's thrash bound (`MAX_ROTATIONS_PER_HOUR`); this is how
      // the orchestrator sees a lead approaching it.
      rotations_last_hour: rotationsLastHour(task?.rotations),
      harness: cut(task.harness, 32),
      budget_class: cut(task.budget_class, 32),
      turns: Number.isFinite(usage.turns) ? usage.turns : null,
      est_tokens: est,
      budget_pct: cap !== null && est !== null ? Math.round((est / cap) * 100) : null,
      // A fallback off the pinned model is detected, not prevented: this column is how the
      // orchestrator and the digest see that it happened. NOTE that with leads pinned to
      // `opus` the within-family case (Opus 5 -> Opus 4.5) satisfies the pin and so reaches
      // no MODEL_DEVIATION event — this column is then the ONLY place it is visible. See the
      // blind-spot note on `spawn.LEAD_MODEL`.
      model: cut(usage.last_model, MAX_ECHO),
      heartbeat_age_ms: await heartbeatAgeOf(task.id),
      attempts: Number.isInteger(task.attempts) ? task.attempts : 0,
      pr_url: cut(task.pr_url, MAX_URL),
      tmux_target: target,
      team: live ? await teamOf(target) : [],
    };
  };

  def('soma_status', async ({ lead } = {}) => {
    const fleet = await fleetOf();
    if (!fleet) return refuse('the fleet checkpoint could not be read; it may be corrupt or unreadable — run soma doctor');
    const want = nonEmpty(lead) ? lead : null;
    const cfg = await configOf();

    /**
     * Which rows survive the cap, in the order they earn it.
     *
     * Every field is bounded, but a reply is rows × fields, so a checkpoint with
     * hundreds of rows needs a ceiling — and applying that ceiling in *checkpoint
     * order* is how a fleet with 200 finished tasks ahead of 3 running leads answers
     * "what is running" with 200 finished tasks. So: what is running or blocked
     * first, then what has finished, and queued rows last because they are already
     * listed by id in `queue`. Whatever falls off is counted in `rows_omitted`, never
     * dropped quietly.
     */
    const rank = (task) => {
      if (task.status === 'queued') return 2;
      return TERMINAL_STATES.has(task.status) ? 1 : 0;
    };
    const candidates = fleet.tasks
      .filter((task) => isRecord(task) && nonEmpty(task.id) && (!want || task.id === want))
      .map((task, index) => ({ task, index }))
      .sort((a, b) => rank(a.task) - rank(b.task) || a.index - b.index);
    const omitted = Math.max(0, candidates.length - MAX_ROWS);
    const kept = candidates.slice(0, MAX_ROWS).sort((a, b) => a.index - b.index);
    // One pane listing for the whole reply (measured p50 3.9 ms), then one screen capture per
    // live non-shell pane inside `paneReading` — not one listing per row.
    const panes = await paneListing();
    const rows = [];
    for (const { task } of kept) rows.push(await statusRow(task, cfg, panes));
    if (want && rows.length === 0) return refuse(`no task ${quote(lead)} in the fleet`);

    // A Map, not an object literal: a hand-edited status of `__proto__` would
    // otherwise be counted onto the prototype and vanish from the reply.
    const counts = new Map();
    for (const task of fleet.tasks) {
      const key = cut(task?.status, 32) ?? 'unknown';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    // Three states, like `seats` below and like `soma status`'s own arm. Every way of NOT
    // observing the record answers the same way — the reader threw, the reader answered something
    // that is not a record, or this bus has no reader wired — because none of them is evidence
    // that admission is open, which is the claim `{active: false}` alone makes to an orchestrator
    // deciding whether to enqueue. `why` stays out: the cause is in the watchdog's log and in
    // `soma status`; this reply carries the state.
    const unreadableBackpressure = () => ({ active: false, reason: null, since: null, until: null, unreadable: true });
    let backpressure = unreadableBackpressure();
    if (has('backpressureState')) {
      try {
        const state = await deps.backpressureState();
        // Shaped, not spread: the real record carries an `evidence` array of scraped
        // pane lines, which is neither the orchestrator's business nor small.
        backpressure = isRecord(state)
          ? {
            active: state.active === true,
            reason: cut(state.reason, MAX_TITLE),
            since: Number.isFinite(state.since) ? state.since : null,
            until: Number.isFinite(state.until) ? state.until : null,
            // The third state, when the reader itself says so: a record that could not be read is
            // not "not frozen". Absent on a clean record, so the shape every consumer matches is
            // unchanged — that four-field shape is the contract, and only it means "observed".
            ...(state.unreadable === true ? { unreadable: true } : {}),
          }
          : unreadableBackpressure();
      } catch {
        backpressure = unreadableBackpressure();
      }
    }

    let queue_paused = null;
    if (has('queuePaused')) {
      try {
        queue_paused = (await deps.queuePaused()) === true;
      } catch {
        queue_paused = null;
      }
    }

    // The seat pool (account rotation). Three states: `null` when this bus has no reader wired
    // (an old wiring degrades to "not reported", not to "no seats"), `unreadable: true` when the
    // reader threw or said so, else the buckets — labels only, see `shapeSeats`.
    let seats = null;
    if (has('seatsSummary')) {
      try {
        seats = shapeSeats(await deps.seatsSummary());
      } catch {
        seats = unreadableSeats();
      }
    }

    const holder = await leaseOf();
    return {
      // Everything that has ever been spawned, including done, failed and blocked:
      // "7 done, 1 failed, 2 need you" is a fleet report, and dropping the terminal
      // rows would make a settled fleet look empty.
      leads: rows.filter((row) => want !== null || row.status !== 'queued'),
      rows_omitted: omitted,
      // Bounded in both directions: how many ids, and how long an id may be. A
      // hand-edited checkpoint's id is a string like any other out of that file.
      queue: fleet.tasks.filter((t) => t?.status === 'queued').slice(0, MAX_ROWS * 5).map((t) => cut(t.id, MAX_ECHO)),
      counts: Object.fromEntries(counts),
      queue_paused,
      backpressure,
      seats,
      watchdog_alive: await sessionAlive('soma-watchdog'),
      lease: shapeHolder(holder),
      lease_stale: await staleOf(holder),
    };
  }, {
    // OPEN — a pure reader, and the one tool every candidate session on the machine
    // carries. It writes nothing and advances no cursor; a demoted session using it to
    // find out who took the lease is the *desired* behaviour, not a leak.
    open: true,
  });

  // -------------------------------------------------------------------------
  // soma_inbox — the mail, and the three things it folds into the checkpoint:
  // the harness, the PR url, and the end of a lead's life
  // -------------------------------------------------------------------------

  /**
   * The registry's spelling of the harness a lead declared, or null.
   *
   * The validator is asked because it is the thing that owns the registry, and it
   * returns the canonical pair — a lead writes `harness_id: "H2 — the suite already
   * runs"` and the row must say `H2`, because `soma_status` shows that string and the
   * watchdog prices a breaker by it whenever the lead's own stream cannot be read. A
   * refusal means no fold at all: a wrong harness on the row is worse than a null
   * one, since it would bind the budget breaker to the wrong class.
   */
  const canonicalHarness = async (payload) => {
    if (has('validateHarnessReport')) {
      try {
        const verdict = await deps.validateHarnessReport(payload);
        if (verdict?.ok !== true || !nonEmpty(verdict.harness_id)) return null;
        const out = { harness: cut(verdict.harness_id, 32) };
        if (nonEmpty(verdict.budget_class)) out.budget_class = cut(verdict.budget_class, 32);
        return out;
      } catch {
        return null;
      }
    }
    // No validator wired: accept only something already shaped like a registry id,
    // never a free-form spelling.
    const raw = text(payload?.harness_id);
    return HARNESS_ID_RE.test(raw) ? { harness: raw } : null;
  };

  /**
   * When an event happened, in the same milliseconds `task.updated` is stamped in.
   *
   * `events.mjs` guarantees a record's `ts` is exactly the numeric prefix of its own
   * id, so a line hand-written without one can still be placed in time. A line that
   * cannot be placed at all returns null — and then closes nothing.
   */
  const stampOf = (event) => {
    if (Number.isFinite(event?.ts)) return event.ts;
    const parsed = Number.parseInt(text(event?.id).slice(0, 13), 10);
    return Number.isFinite(parsed) ? parsed : null;
  };

  /**
   * May an event stamped `at` decide the fate of a row last written at `updated`?
   *
   * This is the guard that makes a terminal flip safe against **re-delivery**, which
   * is a designed-for state rather than an anomaly: `soma_inbox` only advances its
   * cursor after a successful `writeCursor`, and it reports `marked_read: false` when
   * that fails, so the same COMPLETED legitimately arrives twice. Between the two
   * deliveries the operator may have run `soma_resume` — and closing a row whose lead
   * is *live* frees its slot (over-admission) and hands it to the watchdog's
   * `linger_minutes` reap, which kills tmux-alive `done` leads. That is live work
   * destroyed by a stale line in a log.
   *
   * A row with no usable `updated` (hand-written) is allowed to close, because a fleet
   * that cannot reach a terminal state never drains and never settles. `>=` rather than
   * `>` for the same reason: at equal stamps the order genuinely is not knowable, and
   * the two ways to be wrong are not symmetric — declining costs a slot held **forever**
   * (the row stays `spawned` and every re-delivery declines again), while closing costs
   * one row closed a millisecond early, which the watchdog's reconcile can still see.
   */
  const decidesFateOf = (at, updated) => (Number.isFinite(updated) ? Number.isFinite(at) && at >= updated : true);

  /** Does this row disagree with what the events say? */
  const foldNeeded = (task, patch) => !!task && !!patch && (
    (nonEmpty(patch.harness) && task.harness !== patch.harness)
    || (nonEmpty(patch.budget_class) && !nonEmpty(task.budget_override) && task.budget_class !== patch.budget_class)
    || (nonEmpty(patch.pr_url) && task.pr_url !== patch.pr_url)
    || (nonEmpty(patch.status) && FLIPPABLE.has(task.status) && task.status !== patch.status
      && decidesFateOf(patch.at, task.updated)));

  /**
   * Fold what the mail durably means onto the task rows: the harness, the PR url, and
   * the end of a lead's life.
   *
   * All three are read from `fleet.json` by processes that never see the event log —
   * `soma_status`, the watchdog's budget breaker, its reaper and its settlement, the
   * digest — and until this module wrote them, nothing in v1 did. The inbox drain is
   * where the orchestrator sees these events, so this is where they land:
   * idempotently, in one transaction, and only when the checkpoint actually disagrees,
   * because `updateFleet` publishes unconditionally and a no-op fold would cost a
   * write+rename on every inbox call.
   *
   * Two different kinds of write, and the difference is the whole of `allowTerminal`:
   *
   * - `harness`, `budget_class` and `pr_url` are *facts a lead reported*. They are
   *   monotonic, they only ever get displayed or priced, and nothing reaps on them —
   *   so a read-only peek may as well record them.
   * - `status` is a *lifecycle decision* with a reaper attached: it frees an
   *   admission slot and makes the watchdog's `linger_minutes` pass eligible to kill
   *   the session. A caller that asked not to consume its mail (`mark_read: false`)
   *   has not asked for that, and must not get it.
   *
   * `NEEDS_INPUT → blocked` is the one flip that stays with the watchdog: writing
   * `blocked` frees the slot the instant it lands, and the design gives a blocked lead
   * `blocked_slot_minutes` of grace first — a clock this bus does not have.
   */
  const foldEvents = async (events, allowTerminal) => {
    if (!has('updateFleet') || !events.length) return NOTHING_FOLDED;
    const patches = new Map();
    for (const event of events) {
      const id = event?.lead;
      if (!nonEmpty(id) || !LEAD_RE.test(id) || RESERVED_STREAMS.has(id)) continue;
      const payload = isRecord(event.payload) ? event.payload : {};
      if (event.type === 'HARNESS') {
        const harness = await canonicalHarness(payload);
        if (harness) patches.set(id, { ...(patches.get(id) ?? {}), ...harness });
      } else if (event.type === 'COMPLETED' && nonEmpty(payload.pr_url)) {
        patches.set(id, { ...(patches.get(id) ?? {}), pr_url: cut(payload.pr_url, MAX_URL) });
      }
      // Collected after the pr_url branch and in event order, so a lead that
      // reported COMPLETED and then ERROR ends `failed`: the last terminal event
      // in the log is the one that happened last. `at` rides along with it, because
      // the flip is only allowed to be about an event newer than the row.
      const status = allowTerminal ? TERMINAL_STATUS.get(event.type) : null;
      if (status) patches.set(id, { ...(patches.get(id) ?? {}), status, at: stampOf(event) });
    }
    if (!patches.size) return NOTHING_FOLDED;

    const fleet = await fleetOf();
    if (!fleet || !fleet.tasks.some((task) => foldNeeded(task, patches.get(task?.id)))) return NOTHING_FOLDED;
    try {
      const folded = await deps.updateFleet((live) => {
        let count = 0;
        let terminal = 0;
        for (const task of Array.isArray(live?.tasks) ? live.tasks : []) {
          const patch = patches.get(task?.id);
          if (!foldNeeded(task, patch)) continue;
          if (nonEmpty(patch.harness)) task.harness = patch.harness;
          // The class follows the lead's newest harness unless the operator pinned one
          // at enqueue, in `budget_override`, which only `fleet.enqueue` writes. The row's
          // own `budget_class` cannot be that test: this fold used to keep the class of
          // the FIRST report forever, so after an H1 -> H4 supersede the row read
          // `standard` whether an operator had chosen it or not.
          if (nonEmpty(patch.budget_class) && !nonEmpty(task.budget_override)) task.budget_class = patch.budget_class;
          if (nonEmpty(patch.pr_url)) task.pr_url = patch.pr_url;
          // Assigned rather than routed through `setTaskStatus`: this is already
          // inside the transaction the whole fold shares, so it saves a nested lock
          // acquisition and a TASK_STATES round trip, and it keeps the metadata and
          // the status behind one guard in one place. `setTaskStatus` would be
          // *equally safe* — it stamps `last_spawn_at` only on a genuine transition
          // *into* `spawned` (`fleet.mjs`: `status === 'spawned' && !wasSpawned`), so
          // a done/failed write can never re-arm the 90 s stagger. Stated because an
          // earlier version of this comment claimed otherwise.
          // Re-checked here, not merely in `foldNeeded`: that ran against a
          // lock-free snapshot, and the other clauses can open this transaction on
          // their own. The reachable case is the normal lead sequence — a killed
          // lead whose unread mail carries the HARNESS the row does not have yet
          // *and* its own COMPLETED: the harness clause gets us in here, and only
          // this line keeps the operator's kill.
          if (nonEmpty(patch.status) && FLIPPABLE.has(task.status) && task.status !== patch.status
            && decidesFateOf(patch.at, task.updated)) {
            task.status = patch.status;
            // Stamped *only* here, never for a metadata-only fold, and that is not
            // tidiness: `updated` is what `decidesFateOf` reads, and `fleet.mjs` only
            // ever moves it on a status change. A display-only write that bumped it
            // would make the row look newer than the very COMPLETED being folded, and
            // the flip would then decline itself — measured, on the drain that follows
            // a peek. So `updated` keeps its house meaning: when the row's state last
            // changed.
            task.updated = Date.now();
            terminal += 1;
          }
          count += 1;
        }
        return { folded: count, terminal };
      });
      return { folded: Number.isInteger(folded?.folded) ? folded.folded : 0, terminal: Number.isInteger(folded?.terminal) ? folded.terminal : 0 };
    } catch {
      // The mail is still delivered; the fold is a convenience, not the message. The
      // slot is not lost either — the watchdog's reconcile is the other half of this.
      return NOTHING_FOLDED;
    }
  };

  /**
   * ⚠ **NOT `open`, and it is the one that looks like it should be.** "Read the mail"
   * reads as a reader, but this tool is the fleet's most consequential writer after
   * `soma_spawn`: `foldEvents` above **flips task rows to terminal statuses** inside a
   * checkpoint transaction, and `writeCursor(ORCH_STREAM, …)` advances a cursor keyed by
   * **consumer role, not by session** (`events.mjs`). So a demoted orchestrator draining
   * its inbox does two things to the session that displaced it: it closes rows out from
   * under it, and **the true holder never sees those events at all** — they are marked
   * read by a session that no longer speaks for the fleet. `mark_read` defaults to
   * `true`, so the destructive spelling is the one a model reaches by typing nothing.
   */
  def('soma_inbox', async ({ mark_read = true, limit = INBOX_LIMIT_DEFAULT } = {}) => {
    let waiting;
    try {
      waiting = await deps.unread(ORCH_STREAM, await streamsOf());
    } catch (e) {
      return refuse(`the event log could not be read${codeOf(e)}`);
    }
    if (!Array.isArray(waiting)) waiting = [];
    const events = waiting.slice(0, bounded(limit, INBOX_LIMIT_DEFAULT, INBOX_LIMIT_MAX));
    // A peek records facts and closes nothing — see foldEvents.
    const { folded, terminal } = await foldEvents(events, mark_read !== false);

    let marked = false;
    // The cursor lands on the last event of the *slice*, never of the sweep: the
    // sweep is id-ordered, so nothing dropped past the limit can hold an id below
    // the one recorded, and those events come back on the next call.
    const lastId = events.length ? events[events.length - 1]?.id : null;
    if (mark_read !== false && nonEmpty(lastId)) {
      try {
        // `orch`, this consumer's own cursor. The UserPromptSubmit inject hook
        // keeps a separate `orch-inject` cursor on purpose — collapsing the two
        // would make an injected notice consume the mail it is announcing, and
        // soma_inbox would answer "nothing new" right after the nudge to read it.
        await deps.writeCursor(ORCH_STREAM, lastId);
        marked = true;
      } catch {
        marked = false; // a lost cursor re-delivers events; it never skips them
      }
    }
    return {
      events,
      returned: events.length,
      remaining: Math.max(0, waiting.length - events.length),
      marked_read: marked,
      folded,
      // How many rows this drain moved to a terminal status — i.e. how many lead
      // slots it freed. Zero is the normal answer; it is only non-zero on the drain
      // that carries a COMPLETED, an ERROR or a GAVE_UP.
      terminal,
    };
  });

  // -------------------------------------------------------------------------
  // soma_send / soma_kill / soma_resume — intervening
  // -------------------------------------------------------------------------

  def('soma_send', async ({ lead, message, force = false } = {}) => {
    const bad = badId(lead, 'lead');
    if (bad) return bad;
    const line = oneLine(message);
    if (line === '') return refuse('message must be a non-empty string; this is typed into the lead\'s composer and submitted');
    const task = await rowOf(lead);
    if (!task) return refuse(`no task ${quote(lead)} in the fleet`);

    // The same audited walk the lead half uses, for the same reason: this string is
    // operator- or model-authored, and it is about to become an argv to send-keys.
    const { payload, clamped } = clampPayload({ message: line });
    const text_out = typeof payload?.message === 'string' ? payload.message : '';
    const target = targetOf(task);
    if (!has('sendKeys')) {
      return { delivered: false, clamped, error: 'this bus cannot type into panes: no tmux wiring, so nothing was sent and nothing is known about the lead' };
    }

    // The pane gate — see `PANE_HAZARDS`. Read live, right before the keystrokes, because the
    // watchdog's recorded `pane_state` is up to a tick old and a dialog can appear in 3 s.
    const pane = await paneReadingOf(target);
    const hazard = PANE_HAZARDS.get(pane.state);
    if (hazard !== undefined && force !== true) {
      return {
        delivered: false,
        refused: true,
        clamped,
        tmux_target: target,
        pane_state: pane.state,
        pane_kind: pane.kind,
        error: hazard(lead, pane),
      };
    }
    const warning = pane.source === null
      ? `pane not checked: ${pane.why}`
      : hazard !== undefined
        ? `forced past a ${pane.state} reading; whatever that pane was showing has now been typed into`
        : pane.state === 'unrecognised'
          ? 'the pane was read but its screen matched no known Claude Code state (unrecognised); typed anyway'
          : null;
    /**
     * Three outcomes, and three different things known.
     *
     * The one message this replaced asserted "no live pane" even when the send-keys
     * call itself had failed — a diagnosis stated as a fact, which is exactly what
     * the holder_live three-state exists to avoid elsewhere in this file, and it
     * then advised a soma_resume that could be precisely the wrong move.
     */
    let delivered = false;
    let threw = false;
    try {
      delivered = landed(await deps.sendKeys(target, text_out));
    } catch {
      threw = true;
    }
    if (threw) {
      return { delivered: false, clamped, error: `the send-keys call failed, so nothing was typed into ${target} and this bus cannot tell whether ${lead} is still there. Check soma_status` };
    }
    if (!delivered) {
      return {
        delivered: false,
        clamped,
        error: `tmux would not type into ${target}: that pane is gone, or the soma tmux server is not running. ${lead} is ${cut(task.status, 32) ?? 'in no recorded state'} — check soma_status, and soma_resume it if it should be running`,
      };
    }
    return {
      delivered: true,
      clamped,
      chars: text_out.length,
      tmux_target: target,
      pane_state: pane.state,
      pane_fine: pane.fine,
      pane_kind: pane.kind,
      ...(warning === null ? {} : { warning }),
    };
  });

  def('soma_kill', async ({ lead, reason = '' } = {}) => {
    const bad = badId(lead, 'lead');
    if (bad) return bad;
    const task = await rowOf(lead);
    // Refused rather than passed to `setTaskStatus`, which throws on an unknown id:
    // `soma_kill cr-99` must not report success having killed nothing.
    if (!task) return refuse(`no task ${quote(lead)} in the fleet`);

    const { payload } = clampPayload({ reason: oneLine(reason) });
    const why = typeof payload?.reason === 'string' ? payload.reason : '';
    const target = targetOf(task);

    // The kill first, because it is what the operator asked for; then the row, so a
    // failed row-write leaves a dead session the watchdog reconciles rather than a
    // "failed" row beside a live lead.
    let killed = false;
    try {
      killed = landed(await deps.killSession(target));
    } catch {
      killed = false;
    }
    let status_set = false;
    try {
      await deps.setTaskStatus(lead, 'failed');
      status_set = true;
    } catch {
      status_set = false;
    }
    const logged = await logOrch({ type: 'KILLED', payload: { lead, reason: why }, lead });
    return {
      killed,
      status_set,
      logged,
      tmux_target: target,
      ...(status_set ? {} : { error: 'the session was killed but the task row could not be updated; the watchdog will reconcile it' }),
    };
  });

  def('soma_resume', async ({ lead, force = false } = {}) => {
    const bad = badId(lead, 'lead');
    if (bad) return bad;
    if (!has('resumeLead')) return refuse('this bus cannot resume leads: no spawner is wired');
    const task = await rowOf(lead);
    if (!task) return refuse(`no task ${quote(lead)} in the fleet`);
    if (!nonEmpty(task.lead_session_uuid)) {
      return refuse(`task ${quote(lead)} has no recorded Claude session to resume; spawn it with soma_spawn instead`);
    }
    const target = targetOf(task);
    // `force` here means "I know it still looks alive" and nothing more — it never
    // kills. Two Claude Code sessions resumed onto one worktree would edit the same
    // files with two different plans, so the default is to refuse and say how.
    if (force !== true && await sessionAlive(target)) {
      return {
        resumed: false,
        error: `${lead} is still alive; resuming would put a second Claude session on its worktree. Use soma_kill first, or pass force:true if you know its session is gone`,
      };
    }

    // Onto an open seat (see `seatFor`), picked BEFORE anything is done, so a refusal leaves the
    // row and its dead pane exactly as they were. Not necessarily the seat it died on: the pool
    // says which is open now.
    const loaded = await configToLaunch();
    if (nonEmpty(loaded.error)) return refuse(loaded.error);
    const { cfg } = loaded;
    const picked = await seatFor(cfg);
    if (nonEmpty(picked.error)) return refuse(picked.error);
    const seat = seatLabelOf(picked.seat);

    let resumed;
    try {
      resumed = await deps.resumeLead(task, launchOptsFor(picked.seat));
    } catch (e) {
      return { resumed: false, error: `the lead could not be resumed${codeOf(e)}; run soma doctor for the reason` };
    }

    // A revived lead occupies a slot again, and this transition is what re-arms the
    // 90 s stagger — a resume is a spawn as far as the load on the subscription goes.
    let status_set = false;
    try {
      await deps.setTaskStatus(lead, 'spawned');
      status_set = true;
    } catch {
      status_set = false;
    }
    const uuid = cut(resumed?.session_uuid, MAX_ECHO) ?? cut(task.lead_session_uuid, MAX_ECHO);
    if (has('updateFleet')) {
      try {
        await deps.updateFleet((fleet) => {
          const row = (Array.isArray(fleet?.tasks) ? fleet.tasks : []).find((t) => t?.id === lead);
          if (!row) return false;
          // Metadata only, so the clock stays where `setTaskStatus('spawned')` just
          // put it: `updated` is written by a lifecycle change and by nothing else.
          if (uuid && uuid !== task.lead_session_uuid) row.lead_session_uuid = uuid;
          // The seat this resume went onto — its soma.json label, or null for the spawner's
          // own env — is what the watchdog's limits phase closes on this lead's next limit hit.
          // Written on every resume, because a row that still names the seat the lead DIED on
          // would close the wrong account.
          row.seat = seat;
          return true;
        });
      } catch {
        // status still says spawned; the uuid and the seat on the row are the previous ones
      }
    }
    return { resumed: true, lead, session_uuid: uuid, tmux_target: target, status_set, seat };
  });

  // -------------------------------------------------------------------------
  // soma_transcript / soma_digest — looking
  // -------------------------------------------------------------------------

  def('soma_transcript', async ({ lead, lines = TRANSCRIPT_LINES_DEFAULT } = {}) => {
    const bad = badId(lead, 'lead');
    if (bad) return bad;
    // An empty string would read as "the lead printed nothing", which is a fact
    // about the lead rather than about this bus, and it sends the orchestrator down
    // the wrong path entirely.
    if (!has('tailLog')) return refuse('this bus cannot read lead transcripts: no log reader is wired');
    const want = bounded(lines, TRANSCRIPT_LINES_DEFAULT, TRANSCRIPT_LINES_MAX);
    let raw;
    try {
      raw = await deps.tailLog(lead, want);
    } catch (e) {
      return refuse(`the transcript could not be read${codeOf(e)}`);
    }
    const full = text(raw ?? '');
    const truncated = full.length > TRANSCRIPT_CHARS_MAX;
    // The tail, not the head: a lead's death scene is at the end of its pane.
    const out = truncated ? full.slice(full.length - TRANSCRIPT_CHARS_MAX) : full;
    return { text: out, lines: want, chars: out.length, truncated };
  }, {
    // OPEN — a pure reader: `tailLog` reads a pane's scrollback and mutates nothing.
    open: true,
  });

  def('soma_digest', async () => {
    if (!has('buildDigest')) return refuse('the digest composer is not available in this build');
    try {
      const digest = await deps.buildDigest();
      return isRecord(digest) ? digest : { digest: text(digest) };
    } catch (e) {
      return refuse(`the digest could not be built${codeOf(e)}`);
    }
  }, {
    // OPEN — a pure reader by construction as well as by intent: `buildDigest` is an
    // undeclared v1.x gap, so today this tool refuses before it does anything at all.
    // ⚠ If a composer is ever wired here and it WRITES the digest to disk, this `open`
    // is wrong and must go — a digest file is shared state.
    open: true,
  });

  return tools;
}

/**
 * What a session that has not been promoted can see: take the fleet, or look at it.
 *
 * This is the surface every interactive Claude Code session on the machine carries,
 * because `soma init` registers the bus at user scope in candidate role — which is
 * what makes promotion need no restart and no mid-session MCP mounting. The other
 * ten tools are absent rather than refusing, so an unpromoted session's tool list
 * does not advertise a control plane it may not touch.
 *
 * Built by *selecting* from `orchTools`, never by re-implementing: the two handlers
 * a candidate gets are the same functions, sharing the same heartbeat clock, so
 * `soma_adopt` cannot drift between the role that uses it and the role that
 * documents it.
 */
export function candidateTools(ctx) {
  const full = orchTools(ctx);
  const tools = new Map();
  for (const name of CANDIDATE_TOOLS) tools.set(name, full.get(name));
  return tools;
}
