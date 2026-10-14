/**
 * Pane state — what a lead's tmux pane is actually doing, read from tmux alone.
 *
 * `status` (fleet.mjs `TASK_STATES`) is the LIFECYCLE word: it is what `countActive`, `METERED`,
 * `settle.TERMINAL`, the bus's `FLIPPABLE`, the CLI's `ANSWERABLE`/`RETRYABLE` all key on, and it
 * says what the fleet has decided about a task. It cannot say what the pane is showing, and the
 * two disagree in exactly the cases that cost the operator days: a `done` row whose lead has sat
 * 38 hours on a permission dialog, a `blocked` row whose "lead" is the bare `zsh` tmux-resurrect
 * recreated after a reboot. So the pane's state is a SECOND vocabulary, carried beside `status`
 * on the row as `pane_state`, and never written into `status` — a prompt-blocked lead still holds
 * a live claude and its slot; a dead shell on a `done` row is nobody's slot at all.
 *
 * Three kinds of answer, and the tick treats them differently:
 *
 * - a VERDICT — `working`, `idle`, `idle_draft`, `blocked_on_prompt`, `dead_shell`, `dead_pane`,
 *   `absent` — something tmux or the frame positively showed;
 * - a NON-VERDICT — `unobservable`: the pane could not be read (no listing, a failed or blank
 *   capture, unusable input). It is never reported as alive and never as dead, and the tick does
 *   not let it overwrite a verdict it already holds. A tmux hiccup must not mark a lead blocked or
 *   dead, and it must not clear an alarm either;
 * - a SHRUG — `unrecognised`: read fine, matched nothing. Reported, never acted on. The
 *   `soma-watchdog` session reads `node`, a claude launched from inside a shell reads the same
 *   version string a spawned one does (measured), and install shapes change — so "not the claude
 *   version string" is NOT dead here. Only a positive shell match is.
 *
 * Rule ORDER is load-bearing: dead_pane → dead_shell → blocked_on_prompt → working → idle →
 * unrecognised. The pane flag outranks the screen (a dead pane still paints its last frame,
 * including a dialog); a shell outranks the screen (its scrollback can quote anything); the
 * dialog is judged BEFORE `working` because at the dialog the title glyph is `✳` (measured) while
 * a stale spinner is conceivable for one tick.
 *
 * The composer status line is Claude Code's mode indicator — `⏵⏵ bypass permissions on …`,
 * `⏵⏵ auto mode on …` — and it is read from the LAST non-blank line of the frame only. Three
 * live wordings were measured on 2026-09-07 and one of them (`⏵⏵ bypass permissions on · 5 shells,
 * 1 monitor · ← for agents · ↓ to manage`, drawn when background shells run) carries no
 * `(shift+tab to cycle)` hint, so a match on that hint read the `soma` orchestrator's idle pane
 * as `unrecognised` and, worse, lost the dialog rule's exclusion signal on it. The `⏵⏵` prefix is
 * what all three share. LAST line, not anywhere: a lead that cats these fixtures has a status
 * line in its transcript, and if it then hits a dialog the dialog is drawn last — a match anywhere
 * would call that pane idle and let `soma_send` approve the pending command. On every measured
 * composer frame (7 live, plus the probe's) the status line IS the last line; on every measured
 * dialog the footer is. If Claude Code ever draws a line below the status line, idle reads as
 * `unrecognised` — visible in `soma status` as `other`, never a silent approval.
 *
 * The dialog VERDICT needs TWO signals — the footer `Esc to cancel` present, and the composer
 * status line ABSENT. Never a single-string grep: a lead's own transcript can put every dialog
 * string on screen above a live composer (the operator's backlog has tickets about this dialog),
 * and the composer status line is what settles it. Same corroboration discipline as
 * `wd/backpressure.mjs`. The question line decides only the KIND (`permission` / `trust` /
 * `question` / `unknown`): requiring a KNOWN question for the verdict is what let a live lead's
 * AskUserQuestion dialog through as `unrecognised` — its footer says `Enter to select`, not the
 * `Enter to confirm` this file had inferred — and both send gates typed into it. A dialog footer
 * with no composer on screen is a dialog whatever it asks; when the kind cannot be named, it is
 * `unknown` and still refused.
 *
 * Measured, 2026-09-07, Claude Code 2.1.259/2.1.263 on tmux 3.6a — every string below is copied
 * from a captured frame, not remembered:
 *   permission dialog   ` Do you want to proceed?` / ` ❯ 1. Yes` / `   2. No` / ` Esc to cancel · Tab to amend`
 *   trust dialog        ` Quick safety check: …` / ` ❯ No, exit` / ` Enter to confirm · Esc to cancel`
 *   AskUserQuestion     `❯ 1. Yes — …` / `  2. …` / `  4. Type something.` / `────` / `  5. Chat about this` /
 *                       `Enter to select · Tab/Arrow keys to navigate · Esc to cancel` (live lead, 2.1.263)
 *   idle composer       `❯ ` (glyph + U+00A0) between two rules — the TOP rule carries the `--name`:
 *                       `──── lead-task-2 ─` (LIVE shape, placeholder name; `… soma-orch ─` on an orchestrator) —
 *                       then the status line — one of (LIVE 2026-09-07):
 *                       `  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents             /rc` (leads, 2.1.259)
 *                       `  ⏵⏵ bypass permissions on · 5 shells, 1 monitor · ← for agents · ↓ to manage … /rc` (orch, 2.1.263)
 *                       `  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents … /rc` (orch, 2.1.258)
 *   working             title `◐ …`/`◑ …`; status line gains ` · esc to interrupt`
 *   bare shell          pane_dead=0, pane_current_command=zsh (what tmux-resurrect restores a lead as)
 *   dead pane           pane_dead=1, pane_current_command=env, last line `Pane is dead (status 0, …)`
 * Inferred, NOT measured, and named as such: a non-Bash permission dialog (`Do you want to make
 * this edit …`, hence the `Do you want to` prefix rather than the full sentence), and the
 * normal-mode composer status `? for shortcuts` (only ever an EXCLUSION signal here, so a wrong
 * guess makes the dialog rule stricter, never looser). RETIRED inference: `Enter to confirm` with
 * neither the permission question nor the trust header was taken for the AskUserQuestion dialog;
 * measured, that dialog says `Enter to select`, so the `Enter to confirm` shape is a dialog of
 * `unknown` kind — blocked, refused, and named as unknown.
 *
 * Pure. `classifyPane` never throws — it runs once per lead per tick, and a throw would cost every
 * other lead its census; unusable input reads as `unobservable`, never as alive. `takeCensus` is
 * the loop over a fleet with the two readers injected, so the tick, the CLI and the bus share one
 * census and cannot disagree about a pane.
 */

/** Programs that mean "the lead is gone and a shell took its pane". A denylist, on purpose. */
export const SHELLS = new Set(['zsh', 'bash', 'sh', 'dash', 'fish', 'ksh', 'tcsh', 'csh']);

/** The title's first glyph while a turn is running. `✳` is NOT one: it is the finished-turn glyph. */
export const SPINNERS = new Set(['◐', '◑', '◒', '◓']);

export const DIALOG_FOOTER = 'Esc to cancel';
export const PERMISSION_Q = 'Do you want to proceed?';
/** A question line at line start. Prefix-matched so the Edit-tool wording (unmeasured) is a question too. */
export const PERMISSION_Q_RE = /^\s*Do you want to\b/m;
export const TRUST_HDR = 'Quick safety check';
export const QUESTION_FOOTER = 'Enter to confirm';
/** The AskUserQuestion footer's first words (measured live 2026-09-07). Names `kind: question`. */
export const SELECT_FOOTER = 'Enter to select';
/**
 * The composer status line — the `⏵⏵` mode indicator at line start (all three live wordings), or
 * the inferred normal-mode `? for shortcuts`. Tested against the LAST non-blank line only
 * (`statusLineIndex`). Its presence means the composer is on screen, so no dialog is up.
 */
export const COMPOSER_STATUS_RE = /^\s*⏵⏵ |\? for shortcuts/;
export const WORKING_HINT = 'esc to interrupt';
export const COMPOSER_GLYPH = '❯';

/** How many lines the census asks `capturePane` for. The fleet's panes are 24 rows; padding is stripped. */
export const CENSUS_LINES = 40;
/** `tmux.defaultRun`'s SIGKILL timeout. One capture that takes this long stops the tick's remaining captures. */
export const CAPTURE_TIMEOUT_MS = 5000;

export const FINE_STATES = new Set([
  'working', 'idle', 'idle_draft', 'blocked_on_prompt', 'dead_shell', 'dead_pane', 'absent', 'unobservable', 'unrecognised',
]);
export const COARSE_STATES = new Set([
  'alive', 'blocked_on_prompt', 'dead_shell', 'dead_pane', 'absent', 'unobservable', 'unrecognised',
]);

const COARSE = new Map([
  ['working', 'alive'], ['idle', 'alive'], ['idle_draft', 'alive'],
  ['blocked_on_prompt', 'blocked_on_prompt'], ['dead_shell', 'dead_shell'], ['dead_pane', 'dead_pane'],
  ['absent', 'absent'], ['unobservable', 'unobservable'], ['unrecognised', 'unrecognised'],
]);

/** The persisted word for a fine state. An unknown word is `unrecognised`, never `alive`. */
export const coarseOf = (fine) => COARSE.get(fine) ?? 'unrecognised';

const verdict = (fine, { kind = null, draft = null } = {}) => ({ fine, coarse: coarseOf(fine), kind, draft });

/** Only tmux's literal `1` (or its boolean/number spelling) is dead — `liveSessions`' rule. */
const isDead = (flag) => flag === true || flag === 1 || flag === '1';

/** `/bin/zsh`, `-zsh` (login form) and `zsh` are one shell. */
const shellName = (cmd) => String(cmd).split('/').pop().replace(/^-/, '').toLowerCase();

/** Is `pane_current_command` a shell? Positive match only. */
export const isShell = (cmd) => typeof cmd === 'string' && cmd !== '' && SHELLS.has(shellName(cmd));

/**
 * A horizontal rule as Claude Code draws it around the composer: plain `────`, or — on a session
 * started with `--name`, which is every lead and both orchestrators — the name set INTO the top
 * rule: `──── lead-task-2 ─` (shape measured live, 2026-09-07). Without the second shape the
 * composer is never located on this fleet and `idle_draft` cannot fire.
 */
const isRule = (line) => /^─{3,}(?: \S.*? ─)?\s*$/.test(line);

/**
 * The index of the composer status line, or -1. It is the LAST non-blank line or it is nowhere:
 * a status line quoted higher up in the transcript is text, not the composer (see the header).
 */
function statusLineIndex(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === '') continue;
    return COMPOSER_STATUS_RE.test(lines[i]) ? i : -1;
  }
  return -1;
}

/**
 * Is there text in the composer? `true`/`false`, or `null` when the composer could not be located
 * (a status line with no rules above it) — a third answer, not a guess.
 *
 * The composer is the block between the two rules directly above the status line; its first line
 * starts with `❯`, and a long draft wraps onto continuation lines (measured, frame 191).
 */
function composerDraft(lines, status) {
  if (status < 1 || !isRule(lines[status - 1])) return null;
  let top = -1;
  for (let i = status - 2; i >= 0; i--) {
    if (isRule(lines[i])) { top = i; break; }
  }
  if (top < 0) return null;
  const body = lines.slice(top + 1, status - 1);
  if (body.length === 0 || !body[0].startsWith(COMPOSER_GLYPH)) return null;
  const text = [body[0].slice(COMPOSER_GLYPH.length), ...body.slice(1)].join('\n').trim();
  return text !== '';
}

/**
 * Classify one pane: `{fine, coarse, kind, draft}`.
 *
 * @param {{dead?: unknown, cmd?: unknown, title?: unknown, frame?: unknown}} pane
 *   `dead`/`cmd`/`title` as `tmux.paneStates` reports them; `frame` the visible screen from
 *   `capturePane`, or null when it was not (or could not be) read.
 */
export function classifyPane(pane) {
  try {
    if (pane === null || typeof pane !== 'object' || Array.isArray(pane)) return verdict('unobservable');
    const { dead, cmd, title, frame } = pane;
    if (isDead(dead)) return verdict('dead_pane');
    if (isShell(cmd)) return verdict('dead_shell');
    // A live, non-shell pane with no readable screen is not a verdict of any kind.
    if (typeof frame !== 'string' || frame.trim() === '') return verdict('unobservable');

    const lines = frame.split('\n');
    const statusIdx = statusLineIndex(lines);
    const hasComposerStatus = statusIdx >= 0;
    const hasFooter = frame.includes(DIALOG_FOOTER);
    // Two signals for the verdict; the question line names the kind and nothing more.
    if (hasFooter && !hasComposerStatus) {
      const kind = PERMISSION_Q_RE.test(frame) ? 'permission'
        : frame.includes(TRUST_HDR) ? 'trust'
          : frame.includes(SELECT_FOOTER) ? 'question'
            : 'unknown';
      return verdict('blocked_on_prompt', { kind });
    }

    const t = typeof title === 'string' ? title : '';
    const glyph = t === '' ? '' : String.fromCodePoint(t.codePointAt(0));
    if (SPINNERS.has(glyph) || frame.includes(WORKING_HINT)) return verdict('working');

    if (hasComposerStatus) {
      const draft = composerDraft(lines, statusIdx);
      return verdict(draft === true ? 'idle_draft' : 'idle', { draft });
    }
    return verdict('unrecognised');
  } catch {
    // A Proxy, a throwing getter, a frame whose `includes` was replaced: not evidence of anything.
    return verdict('unobservable');
  }
}

/** One line for whatever was thrown, without `e.message` on a `throw null`. */
const reason = (e) => {
  try {
    const m = e?.message;
    return typeof m === 'string' && m !== '' ? m : String(e);
  } catch {
    return 'unknown error';
  }
};

/** Read the injected clock, tolerating one that throws or answers nonsense. */
const clock = (now) => {
  try {
    const n = now();
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
};

/**
 * Classify every row's pane in one pass: `Map<rowId, record>`.
 *
 * `record` = `{name, fine, coarse, kind, draft, cmd, pid, title, frame, error}` — the verdict plus
 * the pane facts the events carry, plus the frame (for a bounded excerpt) and a one-line `error`
 * when the frame could not be read and why.
 *
 * Cost discipline, measured on a 2-session server: `list-panes -a` p50 3.9 ms once, then
 * `capture-pane -p` p50 4.2 ms per LIVE NON-SHELL pane only — a shell, a corpse and a missing
 * session are classified from the listing alone. Each capture is bounded by `tmux.defaultRun`'s
 * 5 s SIGKILL, so on a wedged server the first capture that takes that long stops every later one
 * this pass (`timeoutMs`), and the skipped rows read `unobservable` with the reason — never
 * `alive`, and never N x 5 s.
 *
 * Never throws. A row it cannot name is skipped; a hostile container yields an empty Map. The
 * caller owns the error-reporting path (the tick's `WATCHDOG_ERROR{where:'pane_census'}`).
 *
 * @param {Array<{id: string, name: string}>} rows the lead id and its tmux session name
 * @param {{panes: Map|null, capture?: (name: string, lines: number) => string, now?: () => number,
 *          lines?: number, timeoutMs?: number}} opts
 *   `panes` is `tmux.paneStates()`'s Map, or `null` when tmux could not be listed, or listed
 *   nothing it could parse — then every row is `unobservable` and nothing is captured.
 */
export function takeCensus(rows, opts) {
  const out = new Map();
  let panes = null;
  let capture = null;
  let now = () => 0;
  let lines = CENSUS_LINES;
  let timeoutMs = CAPTURE_TIMEOUT_MS;
  try {
    ({ panes = null, capture = null, now = () => 0, lines = CENSUS_LINES, timeoutMs = CAPTURE_TIMEOUT_MS } = opts ?? {});
  } catch {
    return out;
  }
  if (!Array.isArray(rows)) return out;
  const listed = panes !== null && panes !== undefined && typeof panes.get === 'function';
  let tripped = false;

  for (const r of rows) {
    let id;
    let name;
    try {
      id = r?.id;
      name = r?.name;
    } catch {
      continue;
    }
    if (typeof id !== 'string' || id === '' || typeof name !== 'string' || name === '') continue;
    const base = { name, cmd: null, pid: null, title: null, frame: null, error: null };
    if (!listed) {
      out.set(id, { ...base, ...verdict('unobservable') });
      continue;
    }
    let pane;
    try {
      pane = panes.get(name);
    } catch {
      pane = undefined;
    }
    if (pane === null || pane === undefined || typeof pane !== 'object') {
      out.set(id, { ...base, ...verdict('absent') });
      continue;
    }
    const facts = {
      cmd: typeof pane.cmd === 'string' ? pane.cmd : null,
      pid: Number.isInteger(pane.pid) ? pane.pid : null,
      title: typeof pane.title === 'string' ? pane.title : null,
    };
    let frame = null;
    let error = null;
    if (!isDead(pane.dead) && !isShell(pane.cmd)) {
      if (tripped) {
        error = `capture skipped: an earlier capture this pass hit the ${timeoutMs} ms tmux timeout`;
      } else if (typeof capture !== 'function') {
        error = 'capture unavailable: no pane reader was wired';
      } else {
        const t0 = clock(now);
        try {
          const got = capture(name, lines);
          frame = typeof got === 'string' ? got : null;
        } catch (e) {
          error = `capture threw: ${reason(e)}`;
        }
        if (clock(now) - t0 >= timeoutMs) tripped = true;
      }
    }
    const cls = classifyPane({ dead: pane.dead, cmd: pane.cmd, title: pane.title, frame });
    out.set(id, { ...base, ...facts, frame, error, ...cls });
  }
  return out;
}

/** A thenable cannot be read by a synchronous caller; it is "not read", not a value. */
const isThenable = (v) => v !== null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';

/** `pane_current_command` as a bounded basename — tmux reports one already; this is belt and braces. */
const cmdOf = (pane) => (typeof pane?.cmd === 'string' && pane.cmd !== '' ? pane.cmd.split('/').pop().slice(0, 64) : null);

const unobservableReading = (why) => ({ state: 'unobservable', fine: 'unobservable', kind: null, cmd: null, source: 'live', why });

/**
 * One pane's reading, for a caller about to TYPE into it or report on it — the bus's `soma_send`,
 * `wake` and `soma_status`, and the CLI's `send`. `{state, fine, kind, cmd, source: 'live', why}`,
 * where `state` is the coarse word and `why` names the cause when the answer is `unobservable`.
 *
 * SYNCHRONOUS on purpose. `bus-tools.wake()` is void and cannot await, so the reading it takes
 * before it types has to be one it can take without yielding; the two readers (`tmux.paneStates`,
 * `tmux.capturePane`) are `execFileSync` calls, so this costs the caller nothing. A `panes` or
 * `capture` that answers with a promise is therefore "not read" — the conservative direction, and
 * named in `why`, never silently treated as a value.
 *
 * `panes` may be the listing itself (a Map, or null) or a function that returns one, so a caller
 * that already holds this tick's listing (`soma_status`, one round trip for the whole fleet)
 * hands it over instead of listing again per row.
 */
export function readPane(target, { panes, capture, lines = CENSUS_LINES } = {}) {
  let listing;
  try {
    listing = typeof panes === 'function' ? panes() : panes;
  } catch (e) {
    return unobservableReading(`the pane listing threw: ${reason(e)}`);
  }
  if (isThenable(listing)) return unobservableReading('the pane listing answered asynchronously and could not be read here');
  if (listing === null || listing === undefined) return unobservableReading('the pane listing could not be read');
  const pane = findPane(listing, target);
  if (pane === null) return { state: 'absent', fine: 'absent', kind: null, cmd: null, source: 'live', why: null };

  let frame = null;
  let why = null;
  if (!isDead(pane.dead) && !isShell(pane.cmd)) {
    if (typeof capture !== 'function') {
      why = 'no screen reader was wired';
    } else {
      try {
        const got = capture(target, lines);
        if (isThenable(got)) why = 'the screen capture answered asynchronously and could not be read here';
        else frame = typeof got === 'string' ? got : null;
      } catch (e) {
        why = `the screen capture threw: ${reason(e)}`;
      }
    }
  }
  const cls = classifyPane({ dead: pane.dead, cmd: pane.cmd, title: pane.title, frame });
  return {
    state: cls.coarse,
    fine: cls.fine,
    kind: cls.kind,
    cmd: cmdOf(pane),
    source: 'live',
    why: cls.coarse === 'unobservable' ? (why ?? 'the screen capture came back empty') : null,
  };
}

/**
 * The pane record behind a tmux target: a session name looks up its (active-pane) record; a
 * `%N` pane id — the shape the orchestrator's lease records — is searched across every session's
 * panes, because the lease's pane need not be its session's active one. `null` when not found
 * or when there is no listing. The record gains a `session` field naming where it was found.
 */
export function findPane(panes, target) {
  if (!panes || typeof panes.get !== 'function' || typeof target !== 'string' || target === '') return null;
  try {
    if (target.startsWith('%')) {
      if (typeof panes[Symbol.iterator] !== 'function') return null;
      for (const [session, rec] of panes) {
        const list = Array.isArray(rec?.panes) ? rec.panes : [];
        for (const p of list) if (p?.pane_id === target) return { ...p, session };
      }
      return null;
    }
    const rec = panes.get(target);
    return rec !== null && typeof rec === 'object' ? { ...rec, session: target } : null;
  } catch {
    return null;
  }
}
