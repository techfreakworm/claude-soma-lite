#!/usr/bin/env node
/**
 * The soma MCP bus — the process Claude Code launches as an MCP server.
 *
 * Everything here is assembly. `jsonrpc.mjs` owns the wire, `bus-tools.mjs` owns
 * every decision, and the `lib/` modules own every effect; this file decides which
 * of the three tool sets a session gets, wires the real effects behind them, and
 * grows a candidate into the orchestrator when it takes the lease. Four jobs, in
 * the order they matter:
 *
 *   1. `realDeps()` — the seam. `bus-tools` reaches for 34 named deps and touches
 *      no module itself (it has zero imports, deliberately), so every one of them
 *      is named here or the handler that needs it degrades. Some degradations are
 *      honest refusals; two are silent, and both are guarded below.
 *   2. `buildTools(env, deps)` — the role gate: `SOMA_ROLE` selects lead (3 tools),
 *      orchestrator (12), or candidate (2, and the default).
 *   3. `describe(name)` — the MCP tool declaration. A client hands these to a
 *      model, and a model cannot call `soma_send({lead, message})` if the schema
 *      declares no properties, so they are real rather than placeholders.
 *   4. the promotion — after a successful `soma_adopt` the candidate's Map grows
 *      into the orchestrator's *in place* and `notifications/tools/list_changed`
 *      goes out. `jsonrpc.serve` reads the Map live for exactly this reason.
 *
 * Two things this file must never do. It must not write to stdout — that is the
 * frame channel, and one stray line desynchronizes the client's reader for the
 * rest of the session; diagnostics go to stderr, which is what Claude Code's MCP
 * log captures. And it must not throw at load: a bus that fails to start is an
 * orchestrator with no control plane and a lead with no way to report, so a module
 * that does not exist yet is *absent*, not fatal (see `optionalModule`).
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { serve } from './lib/jsonrpc.mjs';
import { candidateTools, leadTools, orchTools } from './lib/bus-tools.mjs';
import * as events from './lib/events.mjs';
import * as fleet from './lib/fleet.mjs';
import * as lease from './lib/lease.mjs';
import * as tmux from './lib/tmux.mjs';
import { readBackpressure } from './lib/wd/backpressure.mjs';
import { readPane } from './lib/wd/pane-state.mjs';
import { loadConfig } from './lib/config.mjs';
import { validateHarnessReport } from './lib/harness.mjs';
import { notify } from './lib/notify.mjs';
import { p } from './lib/paths.mjs';
import { queuePaused, setQueuePaused } from './lib/queue.mjs';
import { seatsSummary } from './lib/seats-summary.mjs';
import { pick as pickOpenSeat } from './lib/seats.mjs';
import { readUsage } from './lib/tokens.mjs';

/**
 * One diagnostic line, on stderr, never on stdout.
 *
 * stdout carries newline-delimited JSON-RPC frames and nothing else. stderr is the
 * MCP server's log channel — Claude Code captures it — and it is the only place
 * this process can say anything to an operator at all. Guarded because a torn-down
 * stderr must not be the thing that kills the bus.
 */
const warn = (message) => {
  try {
    process.stderr.write(`[soma-bus] ${message}\n`);
  } catch {
    // Nowhere left to report to, and nothing actionable if there were.
  }
};

/**
 * Import a module that may not exist yet, without making this entrypoint depend on
 * it existing.
 *
 * `bin/lib/spawn.mjs` is the one such module. A static `import` of it turns "the spawner is
 * not built yet" into `ERR_MODULE_NOT_FOUND` at load — which is not a degraded bus,
 * it is no bus: no `soma_report` for any lead, no `soma_status` for any session, and
 * an MCP server Claude Code shows as failed. `bus-tools` already guards every dep
 * that can be missing (`if (!has('spawnLead')) return refuse(…)`), so leaving the
 * two spawn deps unwired costs exactly the two tools that need them and says so.
 *
 * The existence check is separate from the import on purpose, because the two
 * failures deserve different answers. Absent is the ordinary case and is silent.
 * *Present and broken* is not: the bus's own refusal would say "no spawner is
 * wired", which sends an operator looking for a configuration problem instead of a
 * module that failed to parse — so that case gets a stderr line. Distinguishing
 * them also stops a broken transitive import inside `spawn.mjs` (which raises the
 * same `ERR_MODULE_NOT_FOUND`, naming a different specifier) from being read as
 * "the spawner is not built yet".
 */
const optionalModule = async (relative) => {
  const url = new URL(relative, import.meta.url);
  if (!existsSync(url)) return null;
  try {
    return await import(url.href);
  } catch (e) {
    warn(`optional module ${relative} exists but failed to load (${e?.code ?? e?.name ?? 'Error'}); the tools that need it will refuse`);
    return null;
  }
};

/** The spawner. Null until `lib/spawn.mjs` exists, and then wired with no change here. */
const spawn = await optionalModule('./lib/spawn.mjs');

/**
 * Is this pane still there?
 *
 * The predicate `lease.leaseStale` injects, and the one probe in the system whose
 * failure is invisible in *both* directions: too permissive and every dead
 * orchestrator reads as live (instant adoption never fires, and `soma_adopt`
 * answers `holder_live: true` about a session that is gone); too strict and every
 * live orchestrator reads as stale, which makes the fleet steal-able with no
 * `force` and no DEMOTED notice. Both spellings that suggest themselves are wrong,
 * in opposite directions. Measured on tmux 3.6a, on this machine:
 *
 *   has-session     -t '=%0'                    exit=1  (LIVE pane!)    <- too strict
 *   display-message -p -t %0     '#{pane_id}'   exit=0  stdout='%0'
 *   display-message -p -t %99999 '#{pane_id}'   exit=0  stdout=''       <- too permissive
 *   display-message -p -t s1     '#{pane_id}'   exit=0  stdout='%0'     <- answers about
 *                                                                          another pane
 *   (no server at all)                          exit=1  stdout=''
 *
 * So `has-session` is the session-level probe and says "no such session" for a
 * pane id, and `display-message`'s exit code means "some tmux server answered" —
 * it is 0 for a pane that does not exist. What carries the answer is the *output*:
 * ask tmux which pane it resolved the target to, and require it to be the one we
 * asked about. That is also correct under target fallback, where tmux answers
 * about a different pane and the ids simply differ, and with no server running,
 * where `defaultRun` maps `execFileSync`'s throw to `{stdout: '', code: 1}` —
 * `''` is not a pane id, so a pane on a dead server is a gone pane. (tmux writes
 * "no server running on …" to *stderr*, which this never reads, so no filesystem
 * path can reach a caller through here.)
 *
 * `run` is the same seam every `tmux.mjs` wrapper takes, so a test can drive the
 * predicate against a recorded argv — but the case that matters wants a real tmux
 * process, because no stub reproduces "exit 0 with empty stdout".
 */
export const hasPane = (pane, run = tmux.defaultRun) => {
  // A `notify`-mode holder has `tmux_pane: null`. `leaseStale` never asks about one
  // (it checks `lease.tmux_pane &&` first), so this is a belt — but it also keeps a
  // malformed record from spending a process on a probe whose answer is known.
  if (typeof pane !== 'string' || pane === '') return false;
  return run(['display-message', '-p', '-t', pane, '#{pane_id}']).stdout.trim() === pane;
};

/**
 * Is this session's pane on soma's OWN tmux server? The proof `soma_adopt` needs before it
 * records `wake: 'tmux'`, and `beat()` before it repairs the lease's pane (issue #2).
 *
 * `$TMUX_PANE` is only a pane id, and a pane id is a small per-server counter. An orchestrator
 * promoted inside the operator's everyday tmux carries THAT server's `%3`, and soma's server has a
 * `%3` of its own whenever it has four panes: a lead's or a teammate's. So existence is not
 * enough. `hasPane(pane)` answers yes for exactly the collision this exists to catch, and that yes
 * is how wake keystrokes reached a stranger's pane. What tells two servers apart is the socket's
 * path: tmux puts it first in every pane's `$TMUX` (`<socket_path>,<server_pid>,<session_index>`),
 * byte-identical to the server's own `#{socket_path}`, realpath and all. Measured on tmux 3.6a:
 *
 *   display-message -p -t %0  '#{pane_id} #{socket_path}'   exit=0  '%0 /private/var/…/soma'
 *   display-message -p -t %99 '#{pane_id} #{socket_path}'   exit=0  ' /private/var/…/soma'
 *                                                                    <- missing pane: an EMPTY id
 *   (no server at all)                                      exit=1  ''
 *
 * So ONE round trip on this bus's socket answers both questions, and both halves must match: the
 * id tmux resolved is the pane asked about (the target-fallback rule `hasPane` states), and the
 * socket it answered on is the one `$TMUX` names. A space separates them, not a tab: a client
 * with no UTF-8 locale in its environment prints a tab in a format as `_` (measured), and a pane
 * id never contains a space, so splitting at the first one also keeps a socket path that has
 * spaces in it whole. The first comma of `$TMUX` is tmux's own reading of it, so a socket path
 * with a comma in it fails here exactly as it fails for tmux.
 *
 * Every answer that is not a match is `false`: no pane, no `$TMUX` (a session outside tmux), no
 * server, a missing pane, another server. `false` means `wake: 'notify'`, which is desktop toasts
 * and pull delivery: slower, and never a keystroke into somebody else's pane. stderr is never
 * read, so the "no server running on <path>" line cannot reach a caller.
 */
export const paneOnServer = (pane, tmuxVar, run = tmux.defaultRun) => {
  if (typeof pane !== 'string' || pane === '') return false;
  const socketPath = typeof tmuxVar === 'string' ? tmuxVar.split(',')[0] : '';
  if (socketPath === '') return false;
  const said = String(run(['display-message', '-p', '-t', pane, '#{pane_id} #{socket_path}']).stdout ?? '').replace(/\n+$/, '');
  const cut = said.indexOf(' ');
  return cut !== -1 && said.slice(0, cut) === pane && said.slice(cut + 1) === socketPath;
};

/**
 * How much of a lead's transcript to read in order to answer with its tail.
 *
 * `soma_transcript` is capped at 500 lines and 40,000 characters and keeps the end,
 * so the whole file is never the answer — and a `pipe-pane` transcript of a
 * multi-hour lead is unbounded, which makes `readFileSync` a memory spike for a
 * 120-line reply (and, past V8's ~512 MB string cap, a `RangeError`). 1 MiB is
 * three orders of magnitude more than the largest legal reply and still a bounded
 * read.
 */
const TAIL_WINDOW = 1024 * 1024;

/**
 * The last `lines` lines of `logs/<lead>.log`.
 *
 * Reads a fixed window off the end rather than the file: see `TAIL_WINDOW`. When
 * the window starts mid-file the first line is a fragment — and, since the window
 * is a byte offset, may open mid-UTF-8-sequence — so it is dropped, which costs at
 * most one line of a 500-line answer and keeps a `�` out of the reply.
 *
 * A missing file is *not* an empty transcript. `''` reads as "the lead printed
 * nothing", which is a claim about the lead rather than about this bus and sends an
 * orchestrator down the wrong path entirely; letting ENOENT out means `soma_transcript`
 * answers "the transcript could not be read (ENOENT)" instead. That refusal is
 * built by `bus-tools` from `e.code` alone, so the path in `err.message` stays in
 * this process.
 */
const tailLog = (leadId, lines) => {
  const fd = openSync(p('logs', `${leadId}.log`), 'r');
  try {
    const size = fstatSync(fd).size;
    const want = Math.min(size, TAIL_WINDOW);
    const start = size - want;
    const buf = Buffer.allocUnsafe(want);
    let filled = 0;
    // `readSync` may return short — a pipe-pane target being appended to while we
    // read it is the normal case here, not an edge one.
    while (filled < want) {
      const got = readSync(fd, buf, filled, want - filled, start + filled);
      if (got === 0) break;
      filled += got;
    }
    let text = buf.subarray(0, filled).toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    const all = text.split('\n');
    return all.slice(Math.max(0, all.length - lines)).join('\n');
  } finally {
    closeSync(fd);
  }
};

/** Age of a state file by mtime, or `whenMissing` if it cannot be stat'd. */
const mtimeAgeMs = (path, whenMissing) => {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return whenMissing;
  }
};

/**
 * The wake debounce's one file — **spelled once, because a reader and a writer share it.**
 *
 * `stampWake` writes it and `realDeps().lastWakeAgeMs` reads it, and until this existed each
 * built the `state/last-wake` path for itself, 89 lines apart. Milder than the queue-switch
 * split that shipped (both copies are in one file and one process, so a reader changing one
 * *can* see the other) but the same shape, and the placement is what makes it worth closing:
 * the read lives inside `realDeps()` — the block an agent rewiring deps is editing — while the
 * write lives in a helper that agent has no reason to open. A drift here does not throw; it
 * leaves the debounce reading `Infinity` forever, which is to say the pane is woken by every
 * urgent event and nothing anywhere says the floor stopped working. A local, not a module:
 * one file owns both ends. Exported so the suite can ask it rather than re-spell it, which is
 * what a test that passes on both sides of a split does.
 */
export const lastWakePath = () => p('state', 'last-wake');

/**
 * Touch `state/last-wake` — the fleet-wide floor between two pane pushes.
 *
 * Swallows, and the direction it fails in is deliberate: a stamp that never lands
 * leaves `lastWakeAgeMs()` at `Infinity`, so every urgent event wakes the pane. One
 * extra keystroke per report is a worse bus; a *missed* NEEDS_INPUT wake is a
 * blocked lead nobody answers. The one-shot mkdir is the same self-heal the lead's
 * heartbeat hook carries, for the same reason: a state root wiped from under a
 * running fleet must not permanently disable a push channel.
 */
const stampWake = () => {
  const fp = lastWakePath();
  try {
    writeFileSync(fp, '');
  } catch {
    try {
      mkdirSync(p('state'), { recursive: true });
      writeFileSync(fp, '');
    } catch {
      // The debounce degrades to "always wake", which is the safe direction.
    }
  }
};

/**
 * Every effect `bus-tools` can reach, by the name it reaches for.
 *
 * The list is exhaustive on purpose and the suite pins it that way — it is derived
 * from `bus-tools.mjs`'s own source rather than from this comment, because the
 * failure mode of an unwired dep is a handler that quietly refuses (or, for the two
 * predicates, one that quietly lies) and no test that only reads this file would
 * see it.
 *
 * Three names are deliberately absent, each with a guard in `bus-tools` that turns
 * the absence into a sentence a model can act on:
 *   `spawnLead` / `resumeLead`  until `lib/spawn.mjs` exists — see
 *                               `optionalModule`; wired automatically when it does.
 *   `buildDigest`               the digest composer is a declared v1.x gap (spec
 *                               §16's cut line), so `soma_digest` answers "not
 *                               available in this build" rather than `undefined`.
 */
export function realDeps() {
  return {
    // --- events: the lead → orchestrator channel, and the read cursors ---------
    appendEvent: events.appendEvent,
    unread: events.unread,
    writeCursor: events.writeCursor,
    // Every lead's stream plus the orchestrator's own. Non-throwing: an inbox that
    // sweeps nothing reads as "no news", which is indistinguishable from a working
    // fleet going quiet, so a broken checkpoint must not silence the mail.
    eventStreams: () => {
      try {
        return [...fleet.readFleet().tasks.map((t) => t?.id).filter((id) => typeof id === 'string' && id !== ''), 'orch'];
      } catch {
        return ['orch'];
      }
    },

    // --- the lease: who holds the fleet, and whether they are still there ------
    readLease: lease.readLease,
    acquireLease: lease.acquireLease,
    releaseLease: lease.releaseLease,
    // `heartbeat` and `leaseStale` are what make adoption honest in the two
    // directions: without the first an orchestrator that thinks for eleven minutes
    // is silently stealable, and without the second a dead holder's pane keeps the
    // fleet locked until its heartbeat ages out.
    heartbeat: lease.heartbeat,
    leaseStale: lease.leaseStale,
    hasPane,
    // The proof that this session's pane is on soma's own server, before a claim of keystroke
    // wakes (issue #2). Unwired, every adopt claims notify. Fixed arity, like `paneStates` below:
    // `paneOnServer` takes a trailing `run` transport that a forwarded extra argument would replace.
    paneOnServer: (pane, tmuxVar) => paneOnServer(pane, tmuxVar),

    // --- the checkpoint -------------------------------------------------------
    readFleet: fleet.readFleet,
    // `updateFleet` is what makes `soma_spawn`'s admit-and-mark one transaction;
    // unwired, `soma_spawn` refuses rather than racing itself past max_leads.
    updateFleet: fleet.updateFleet,
    setTaskStatus: fleet.setTaskStatus,
    enqueue: fleet.enqueue,
    admit: fleet.admit,
    launching: fleet.launching,
    // A lead asking which task it is. Non-throwing, because `leadTools` has no
    // catch-all net around it and `readFleet` puts the checkpoint's absolute path
    // in the message it throws for a torn file — which the transport would hand
    // straight to the lead's model as a -32000. `{}` is what the handler already
    // reads as "no row", and it answers "ask the orchestrator to re-enqueue it".
    taskFor: (id) => {
      try {
        return fleet.readFleet().tasks.find((t) => t?.id === id) ?? {};
      } catch {
        return {};
      }
    },
    loadConfig,

    // --- tmux ------------------------------------------------------------------
    sendKeys: tmux.sendKeys,
    hasSession: tmux.hasSession,
    killSession: tmux.killSession,
    listPanes: tmux.listPanes,
    // The pane census's two reads (added after leads were found stalled on prompts nobody saw).
    // `bus-tools` is import-free, so it consumes a READING rather than the classifier:
    // `paneReading(target, panes?)` is the synchronous `{state, fine, kind, cmd, source, why}`
    // that `soma_send` and `wake()` take before they type and that `soma_status` reports, built
    // here from the real listing and the real screen.
    // Fixed-arity arrows, because both tmux functions take a trailing `run` transport that a
    // forwarded extra argument would silently replace. `panes` is an already-taken listing
    // (`soma_status` lists once for the whole fleet); absent, the reading lists for itself.
    paneStates: () => tmux.paneStates(),
    paneReading: (target, panes) => readPane(target, {
      panes: panes === undefined ? () => tmux.paneStates() : panes,
      capture: (t, n) => tmux.capturePane(t, n),
    }),

    // --- the operator's channels ----------------------------------------------
    notify,
    lastWakeAgeMs: () => mtimeAgeMs(lastWakePath(), Infinity),
    stampWake,

    // --- what a lead's own hooks and transcript say about it -------------------
    // `null`, not Infinity: no touch file yet means "not known", and the row
    // reports `heartbeat_age_ms: null` rather than claiming a stall.
    heartbeatAgeMs: (id) => mtimeAgeMs(p('heartbeats', id), null),
    readUsage,
    tailLog,

    // --- admission switches ---------------------------------------------------
    //
    // BOTH HALVES COME FROM `lib/queue.mjs`, AND THE POINT OF THAT MODULE IS THAT
    // THIS FILE MUST NOT SPELL THE PATH. The carry this replaces read the switch at
    // `state/queue.paused` while `soma-watchdog.mjs` reads `state/QUEUE_PAUSED`, and
    // the two never met: `soma_queue pause` wrote one file, `soma_status` read the
    // same one back and rendered `queue_paused: true`, and the watchdog's admission
    // branch checked the other, found nothing, and kept spawning. That is the exact
    // failure the carry was written to prevent, arriving through the one route nobody
    // watches — two correct implementations of one contract, in two files, merged an
    // hour apart. Neither is wrong on its own, which is why nothing caught it.
    //
    // So the path is named in exactly one place (`queue.queuePausedPath`), and
    // `test/soma-bus.smoke.test.mjs` fails if this file ever grows a second spelling.
    // The module also refuses a non-boolean write rather than coercing it, which the
    // inline version did not: `setQueuePaused(undefined)` reached `if (!on)` and
    // silently RESUMED a queue an operator had paused.
    queuePaused,
    setQueuePaused,
    // ONE reader, in the module that owns the file. `wd/backpressure.mjs` spells the path, writes
    // the record under the fleet lock (the watchdog's storm and spend-cap branches), and reads it
    // back three-state: `{active: false}` for no file, the record, or `{active: false,
    // unreadable: true, why}`. The inline `JSON.parse(readFileSync(...))` of a path spelled HERE,
    // which this replaces, was the queue-switch split in waiting — a second spelling of a path
    // another process writes — and `test/soma-bus.smoke.test.mjs` fails if this file grows one again.
    backpressureState: readBackpressure,
    // The seat pool for `soma_status` (account rotation): one record, built by the module that
    // owns the merge of soma.json seats with state/seats.json. It never throws — an unreadable
    // pool comes back as `unreadable: true` — and bus-tools shapes it to labels before it
    // reaches the model, because each row carries the seat's config_dir. Fixed arity, like
    // `paneStates`: `seatsSummary(nowMs)` takes a clock, and a forwarded argument would set it.
    seatsSummary: () => seatsSummary(),

    // --- the harness contract -------------------------------------------------
    // Returns the CANONICAL `{harness_id, budget_class}`, which is why the fold
    // stores `H2` rather than the prose a lead reported it with.
    validateHarnessReport,

    // --- the spawner ----------------------------------------------------------
    // The options object goes THIRD, with `undefined` second so the spawner's own dep set
    // applies. The hazard is the SECOND position, not the arity: `spawn.resumeLead(task, opts)`
    // would hand `{configDir}` over as the *spawner wiring* and silently replace it.
    ...(spawn ? {
      spawnLead: (task, opts = {}) => spawn.spawnLead(task, undefined, opts),
      resumeLead: (task, opts = {}) => spawn.resumeLead(task, undefined, opts),
    } : {}),
    // The seat pool's pick, for `soma_spawn` / `soma_resume` (account rotation). Fixed arity,
    // because `pick` takes a clock a forwarded argument would replace. Reads soma.json and
    // state/seats.json, writes nothing.
    pickSeat: (now, cfg) => pickOpenSeat(now, cfg),
  };
}

/** The three roles, and the one an unset or unrecognised `SOMA_ROLE` means. */
const roleOf = (env) => {
  const role = env?.SOMA_ROLE;
  return role === 'lead' || role === 'orchestrator' ? role : 'candidate';
};

/**
 * The role this session actually has — which the environment alone cannot answer.
 *
 * `soma init` registers the bus at user scope with no `SOMA_ROLE`, so every session
 * starts as a candidate and the promotion below grows its Map in place. That upgrade
 * lives entirely in *this process*, and the process does not outlive the client's
 * connection: a `--resume`, a `/mcp` reconnect, or any restart of the MCP server
 * starts a fresh bus that reads the same empty `SOMA_ROLE` and offers two tools — to
 * a session that still holds the lease on disk. Nothing is unsafe about that (the
 * lease is intact, and every handler re-checks it), but the operator's control plane
 * has silently gone missing and the only way back is to notice and re-adopt.
 *
 * Measured, and this is what motivated it: in a real `claude -p` run on 2.1.220 the
 * bus mounted, `soma_adopt` returned `adopted: true` and wrote a lease naming that
 * session's uuid — and `soma_enqueue` was *not* visible to the model in the same turn.
 * A single-turn headless run has no next turn to re-list in, so that is the expected
 * outcome there rather than evidence the notification failed; it is also exactly what
 * `skills/soma-promote/SKILL.md` §6 warns the operator to check. What it does prove is
 * that the in-process upgrade is the *only* thing carrying the promotion, and the lease
 * is a durable answer sitting right there.
 *
 * So the lease is consulted, once, at startup: if it names this session, this session
 * is the orchestrator. Read-only, lock-free, and guarded — an unreadable lease means
 * "candidate", never a dead bus.
 *
 * Deliberately NOT inside `buildTools`, which stays a pure function of the environment
 * it is handed: "what does this role get" and "what role is this session" are different
 * questions, and only the second one needs a filesystem.
 *
 * A `lead` short-circuits before the lease is read at all. A lead must never reach the
 * control plane, and `bus-tools`' `SOMA_LEAD_NAME` gate refuses the whole surface for a
 * lead or a teammate even if one somehow matched the recorded id.
 */
const startingRole = (env, deps) => {
  const role = roleOf(env);
  if (role !== 'candidate') return role;
  // Same precedence as `bus-tools`' own `sessionId()` — harness first, override
  // second. If those two ever disagree, this session would claim a role the lease
  // does not grant it, so they are kept in step deliberately.
  const id = env?.CLAUDE_CODE_SESSION_ID || env?.SOMA_SESSION_ID;
  if (!id) return role;
  try {
    return deps?.readLease?.()?.session_id === id ? 'orchestrator' : role;
  } catch {
    return role;
  }
};

/**
 * `{ctx, tools}` for this session's role.
 *
 * `deps` is a parameter so the suite can drive the real handlers against recorded
 * effects, and so the promotion below reuses one wiring instead of building a
 * second.
 */
export function buildTools(env, deps = realDeps()) {
  const ctx = { env, deps };
  const role = roleOf(env);
  if (role === 'lead') return { ctx, tools: leadTools(ctx) };
  if (role === 'orchestrator') return { ctx, tools: orchTools(ctx) };
  return { ctx, tools: candidateTools(ctx) };
}

/**
 * The environment `bus-tools` reads, assembled from this process's.
 *
 * Six variables reach it: `SOMA_ROLE`, `SOMA_LEAD_NAME`, `SOMA_TMUX_SOCKET`, `TMUX`,
 * `CLAUDE_CODE_SESSION_ID` and `SOMA_TMUX_PANE`. The first four arrive with the
 * spread. The other two are the whole reason this function exists.
 *
 * `TMUX` arrives because Claude Code hands an MCP server its whole process environment, and
 * tmux sets `$TMUX` beside `$TMUX_PANE` for every process in a pane. Its first field is the
 * path of the server's socket, which is what `paneOnServer` compares to prove that the pane
 * this session offers is on soma's own server rather than on the operator's (issue #2).
 *
 * **`CLAUDE_SESSION_ID` is not read, and must not be re-added.** The original sketch
 * resolved identity as `SOMA_SESSION_ID || CLAUDE_SESSION_ID`; measured on Claude
 * Code 2.1.220, inside a real MCP server process, `CLAUDE_SESSION_ID` is
 * `undefined` and the variable that equals the hook payload's `session_id` — the
 * string `orch-inject.mjs` compares a lease against — is
 * **`CLAUDE_CODE_SESSION_ID`**, which `--resume` preserves. So the sketch's line
 * gave the bus no identity at all: `soma_adopt` refused, and no session on the
 * machine could ever adopt the fleet. Fail-closed, and total. `bus-tools` reads
 * `CLAUDE_CODE_SESSION_ID` itself (harness first, `SOMA_SESSION_ID` only as the
 * override for a test or a hand-run bus), so the fix here is the absence.
 *
 * `SOMA_TMUX_PANE` is `$TMUX_PANE`, which tmux sets for every process inside a
 * pane — and it is the pane the lease claim offers, recorded as `wake: 'tmux'` only once
 * `paneOnServer` proves it is on soma's server; otherwise the claim is `wake: 'notify'`.
 * Harness value first for the same reason as the session id: while tmux is telling
 * us which pane we are in, an override can only be wrong. It is a fallback rather
 * than an overwrite because the sketch's `SOMA_TMUX_PANE: process.env.TMUX_PANE`
 * *clobbers* a deliberately-set value with `undefined` on every bus that is not in
 * a pane.
 */
export const busEnv = (env = process.env) => ({
  ...env,
  SOMA_TMUX_PANE: env.TMUX_PANE || env.SOMA_TMUX_PANE || undefined,
});

/**
 * What a client tells a model about each tool.
 *
 * These are declarations, not documentation: an MCP client puts `inputSchema` in
 * front of a model, so `{type: 'object'}` with no `properties` says "this tool
 * takes no arguments" — and a model that cannot see the words `lead` and `message`
 * will call `soma_send` with something else, once, and report the lead as answered.
 * Every property below is the parameter its handler actually destructures, with
 * the handler's own default and bound; the suite derives that list from
 * `bus-tools.mjs`'s source and fails if the two drift.
 *
 * Descriptions say what the tool *does to the fleet*, and name the refusals a
 * caller has to be ready for, because a refusal is a value here and not an error.
 */
const obj = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const str = (description) => ({ type: 'string', description });
const bool = (description, dflt) => ({ type: 'boolean', description, default: dflt });
const int = (description, dflt, max) => ({ type: 'integer', description, default: dflt, minimum: 1, maximum: max });

const LEAD_ID = str('The lead / task id, e.g. "task-42".');

const SPECS = {
  // --- lead role ------------------------------------------------------------
  soma_report: {
    description:
      'File a report on this lead\'s own event stream — the only way anything this session does becomes visible to the orchestrator. '
      + 'STARTED once at pickup; HARNESS with the chosen verification harness (the orchestrator may veto it); MILESTONE for progress; '
      + 'NEEDS_INPUT to ask a question and stop; COMPLETED with the draft-PR url; ERROR when the task cannot be finished. '
      + 'NEEDS_INPUT, ERROR and COMPLETED wake the orchestrator immediately; the rest batch. Payload fields are clamped, and the reply says whether that happened.',
    inputSchema: obj({
      type: { type: 'string', enum: ['STARTED', 'HARNESS', 'MILESTONE', 'NEEDS_INPUT', 'COMPLETED', 'ERROR'], description: 'The report type.' },
      payload: { type: 'object', description: 'Type-specific fields, e.g. {harness_id, budget_class} for HARNESS, {question} for NEEDS_INPUT, {pr_url, summary} for COMPLETED.' },
    }, ['type']),
  },
  soma_task: {
    description:
      'Re-read this lead\'s own task row: brief, repo, base branch, source ref and verify hint. '
      + 'Use it after a compaction, or whenever the brief is no longer in context — it is the assignment, not a summary of it.',
    inputSchema: obj(),
  },
  soma_checkpoint: {
    description:
      'Record a cheap progress marker on this lead\'s stream. It is also the "still working" evidence the watchdog\'s stall detector reads, '
      + 'so call it liberally: it appends one line, wakes nobody, and costs the orchestrator no turn.',
    inputSchema: obj({ note: str('One line on what just happened.') }),
  },

  // --- candidate + orchestrator --------------------------------------------
  soma_adopt: {
    description:
      'Take the orchestrator lease for this session — the promotion, which is a lease and not a restart. '
      + 'Refused while a live holder has it: `adopted:false` with `holder` and `holder_live`, where `holder_live:true` means the liveness check ran and said the holder is there, '
      + 'and `null` means it could not run (so the refusal does not prove anything). `force:true` steals a live lease, types a DEMOTED notice into the old holder\'s pane and cuts it off the feed — operator decision only. '
      + 'Re-adopting a lease this session already holds is idempotent.',
    inputSchema: obj({ force: bool('Steal a lease whose holder is still live. Ask the operator first.', false) }),
  },
  soma_status: {
    description:
      'The fleet at a glance: one row per lead (status, liveness, harness, budget class, turns, est tokens, budget %, model, heartbeat age, team pane health, PR url, tmux target), '
      + 'plus the queued ids, a status count map, backpressure, whether admission is paused, watchdog health, and who holds the lease with whether that claim is stale. '
      + 'Pass `lead` for one row. Read-only, and available to an unpromoted session. A non-zero `rows_omitted` means the lead list was capped and is partial.',
    inputSchema: obj({ lead: LEAD_ID }),
  },

  // --- orchestrator only ---------------------------------------------------
  soma_release: {
    description:
      'Hand the orchestrator lease back, so the next session takes it cleanly instead of finding it stale. '
      + 'Running leads keep running — but nothing answers a NEEDS_INPUT until some session adopts the fleet. Refused unless this session is the holder.',
    inputSchema: obj(),
  },
  soma_enqueue: {
    description:
      'Add tasks to the queue. Each row needs an id and a brief you authored — the brief is the assignment a lead will work from, so write it, do not paste the ticket. '
      + 'Rows are validated per task and the reply lists what was `skipped` and why (duplicate, invalid-id, reserved-id, unknown-repo, unknown-budget-class, brief-too-long); a batch that is too large is refused whole.',
    inputSchema: obj({
      tasks: {
        type: 'array',
        description: 'The task rows to queue (at most 200 per call).',
        maxItems: 200,
        items: obj({
          id: str('Stable task id, lowercase — this becomes the lead name, its tmux session, its event stream and its worktree.'),
          title: str('One-line human title.'),
          repo: str('Repo name as configured in soma.json (a name, not a path).'),
          brief: str('The assignment: goal, constraints, and a checkable definition of done. Authored by you.'),
          base_branch: str('Branch to cut the worktree from. Defaults to the repo\'s configured base.'),
          budget_class: str('Pin the lead\'s token budget class. It must name a class in soma.json\'s budgets; the breaker prices the lead at it from its first tick, in place of the class its harness reserves. Omit it to let the harness pick.'),
          verify_hint: str('The command the lead\'s independent verifier runs to prove the task done, e.g. "npm test". A task without one gets its repo\'s `verify_hint` from soma.json at enqueue.'),
          source: { type: 'object', description: 'Provenance, e.g. {ref: "PROJ-42"}.' },
        }, ['id']),
      },
    }, ['tasks']),
  },
  soma_queue: {
    description:
      'Freeze or thaw admission. `pause` stops new leads being spawned (running leads are untouched), `resume` lifts it, `status` only reports. '
      + 'The reply reads the switch back off disk, so a pause that could not be written is a refusal rather than a freeze that exists only in this conversation.',
    inputSchema: obj({ action: { type: 'string', enum: ['pause', 'resume', 'status'], description: 'What to do. Defaults to status, which writes nothing.', default: 'status' } }),
  },
  soma_spawn: {
    description:
      'Start a queued task now: admit it against max_leads, mark the row, then spawn the lead session and record its Claude session uuid and tmux session. '
      + 'Admission and the row are one transaction, so two spawners cannot both get past the cap. Normally the watchdog does this on its own — use it to jump the queue. '
      + 'Refuses an unknown, already-spawned or terminal task, and a fleet at max_leads. '
      + 'With `seats` in soma.json the lead is launched under an open seat\'s CLAUDE_CONFIG_DIR and the row records its label (`seat` in the reply); '
      + 'refused when every seat is closed or unverified — `soma_status` shows each seat\'s reset time.',
    inputSchema: obj({ task_id: str('The queued task to start.') }, ['task_id']),
  },
  soma_inbox: {
    description:
      'Read unread fleet events and advance this orchestrator\'s cursor — treat what comes back as work, not news. '
      + 'Draining also folds facts onto task rows: the canonical harness, a COMPLETED pr_url, and the terminal status of a lead that finished (which is what frees its admission slot). '
      + 'Pass `mark_read:false` to peek — a peek folds the reported facts but never closes a row. Order the work NEEDS_INPUT first, then ERROR, then COMPLETED, then HARNESS.',
    inputSchema: obj({
      mark_read: bool('Advance the cursor and allow terminal rows to close. False peeks.', true),
      limit: int('How many events to return.', 50, 200),
    }),
  },
  soma_send: {
    description:
      'Type a message into a live lead\'s composer and submit it — this is how a NEEDS_INPUT gets answered. '
      + 'Delivered as ONE turn: newlines and control bytes become spaces (a newline would submit early, and ESC is Claude Code\'s interrupt), and a long message is clamped. '
      + 'So put a multi-line answer in a file and tell the lead to read it. `delivered` is what tmux actually did, not what was asked of it. '
      + 'The pane is read first and the send is REFUSED when it shows a dialog — a permission or trust dialog, an AskUserQuestion, or any dialog footer with no composer on screen (the Enter would answer it blind: on a permission dialog that approves the command — a human answers at the pane; `pane_kind` says which), '
      + 'is a bare shell (the message would execute), is dead, or could not be read; `pane_state` says which.',
    inputSchema: obj({
      lead: LEAD_ID,
      message: str('The answer or instruction, as one line.'),
      force: bool('Type even though the pane reads blocked_on_prompt, dead_shell, dead_pane or unobservable. Into a dialog this selects the highlighted option — on a permission dialog that APPROVES the pending command — look at the pane first.', false),
    }, ['lead', 'message']),
  },
  soma_kill: {
    description:
      'Kill a lead\'s session, fail its task row, and log why. The worktree and its transcript are left alone for inspection. '
      + 'A failed row is what `soma retry` re-queues. The reply separates the three effects, so a session that was already gone still reports the row and the log honestly.',
    inputSchema: obj({ lead: LEAD_ID, reason: str('Why — this goes on the orchestrator\'s event log.') }, ['lead']),
  },
  soma_resume: {
    description:
      'Bring a dead lead back on its recorded Claude session (`claude --resume`) and re-occupy its admission slot. '
      + 'Refused while its session still looks alive, because a second Claude on one worktree means two plans editing the same files: `soma_kill` first, or pass `force:true` if you know the session is gone. '
      + '`force` skips that probe and nothing else — it never kills. '
      + 'With `seats` in soma.json the resume lands on an open seat (not necessarily the one it died on) and the row records it; refused when every seat is closed or unverified.',
    inputSchema: obj({ lead: LEAD_ID, force: bool('Skip the liveness probe. Does not kill.', false) }, ['lead']),
  },
  soma_transcript: {
    description:
      'The tail of a lead\'s terminal transcript, bounded in lines and characters — the end, because that is where a death scene is. '
      + 'Use it to find out what a lead actually did before it errored. A transcript that cannot be read is said so, never returned as empty.',
    inputSchema: obj({ lead: LEAD_ID, lines: int('How many trailing lines.', 120, 500) }, ['lead']),
  },
  soma_digest: {
    description: 'The current fleet digest, if this build composes one. In v1 the composer is a declared gap and this refuses rather than answering with nothing.',
    inputSchema: obj(),
  },
};

/**
 * The `tools/list` entry for one name.
 *
 * `jsonrpc.serve` calls this once per key in the live Map, so it must answer for a
 * name this file has never heard of — a tool added to `bus-tools` without a spec
 * here — and it must not throw, because a throw during `tools/list` costs the
 * session its whole tool list. The fallback is honest about being one.
 */
export const describe = (name) => {
  const spec = Object.hasOwn(SPECS, name) ? SPECS[name] : null;
  if (spec) return { name, description: spec.description, inputSchema: spec.inputSchema };
  return { name, description: `soma ${name} (no declaration on record in this build; call it with the arguments the fleet documentation names)`, inputSchema: { type: 'object' } };
};

/**
 * Assemble and serve. Returns the pieces so a test can drive the real thing.
 *
 * The promotion is the only interesting line. `soma init` mounts this bus at user
 * scope in the *candidate* role, which is what makes `/soma-promote` one tool call
 * with no restart and no mid-session MCP mounting — so when that call succeeds the
 * ten control tools have to appear in a session that is already running. Growing
 * the Map `serve` is holding (it reads it live, never snapshots it) and then
 * announcing `notifications/tools/list_changed` is how.
 *
 * Two details in that block are load-bearing:
 *
 * - The overwrite includes `soma_adopt` itself, so the wrapper *replaces itself*
 *   with the orchestrator's own handler. A re-adopt after a demotion then costs no
 *   second announcement, and there is no wrapper stack to grow.
 * - Only `adopted === true` upgrades. `adopted:false` is the refusal a live holder
 *   produces, and a session that acquires the control plane on a refused adopt is
 *   a second orchestrator on one queue.
 *
 * The role gate reuses `roleOf`, so whatever `buildTools` treated as a candidate is
 * exactly what gets the upgrade — including a typo'd `SOMA_ROLE`, which would
 * otherwise get the candidate's two tools and no way out of them.
 *
 * ---
 * **THERE IS NO DOWNGRADE PATH, AND THAT IS NOW SAFE RATHER THAN MERELY UNSTATED.**
 *
 * This upgrade is one-way: the Map grows on a successful adopt and nothing ever shrinks
 * it, so a session that is later demoted — force-stolen from, or released — keeps all
 * twelve tools for the life of its process. `startingRole` is consulted once, at startup.
 *
 * For most of this build that was a live hole, and a review measured it: eleven of
 * the twelve handlers never compared the caller to `lease.session_id`, so after a
 * force-steal the stolen-from session still enqueued rows, still killed leads, still typed
 * into panes and still paused the queue. **The fix is in `bus-tools.def`, not here** — it
 * gates every mutating tool on still holding the lease and refuses with the holder
 * attached — and it had to be, precisely because the Map cannot be shrunk from underneath
 * a client that has already listed it. A tool that vanishes mid-session is a tool call
 * that fails with a transport error the model cannot act on; a tool that refuses with
 * "you were demoted, here is who holds it now" is one it can.
 *
 * So: do NOT add a downgrade here on the reasoning that the Map should track the role.
 * The presence of a tool is not the authority for calling it — the lease is, and every
 * handler re-reads it.
 */
export function main({ env = busEnv(), deps = realDeps(), io } = {}) {
  const role = startingRole(env, deps);
  const { tools } = buildTools({ ...env, SOMA_ROLE: role }, deps);
  const server = serve({ tools, describe }, io);

  if (role === 'candidate') {
    const adopt = tools.get('soma_adopt');
    if (adopt) {
      tools.set('soma_adopt', async (args) => {
        const result = await adopt(args);
        if (result?.adopted === true) {
          for (const [name, fn] of buildTools({ ...env, SOMA_ROLE: 'orchestrator' }, deps).tools) tools.set(name, fn);
          server.emitToolsChanged();
        }
        return result;
      });
    }
  }

  return { tools, server, env, deps, role };
}

/**
 * Was this file run, or imported?
 *
 * `import.meta.main` since Node 24.2. The fallback is for the 24.0/24.1 floor
 * `package.json` allows, and it is `pathToFileURL` rather than the originally planned
 * `import.meta.url === \`file://${process.argv[1]}\`` because that comparison is
 * measurably wrong twice over: a path containing a space is percent-encoded in
 * `import.meta.url` and not in `argv[1]`, and a symlinked entrypoint resolves to
 * its target in one and not the other. Either way it reads "imported" and the bus
 * starts nothing at all — an MCP server that connects and then answers no frame.
 */
const isMain = () => {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  const argv1 = process.argv[1];
  if (typeof argv1 !== 'string' || argv1 === '') return false;
  try {
    return pathToFileURL(argv1).href === import.meta.url;
  } catch {
    return false;
  }
};

if (isMain()) main();
