/**
 * The spawner — the only path that starts a lead, and therefore the only place every
 * safety property of a lead session is decided.
 *
 * A lead is a session pinned to one model and effort, forbidden from writing code, running a team
 * of agents that *do* write code, in a real repo, with permissions bypassed, detached in
 * tmux where nobody can answer a prompt. Each of those is a property of the argv, the
 * environment, or a file that has to exist *before* `claude` reads it. None of them
 * announces itself when it is wrong: a lead with a dropped pin starts, prints a prompt,
 * and looks exactly like a healthy one. That is why this module is composed of refusals
 * rather than best-effort steps, and why the comments record what was measured.
 *
 * The five properties, and what enforces each:
 *
 *   model + effort   `--model opus --effort max`, plus `CLAUDE_CODE_EFFORT_LEVEL=max`,
 *                    because effort `max` cannot persist in settings.json and the operator's
 *                    own persisted level on this machine is `low`. The watchdog raises
 *                    MODEL_DEVIATION when the transcript disagrees.
 *   no code          RETIRED — a lead's tool/write surface now matches its teammates':
 *                    `--disallowedTools` is off the argv and the gate's session-
 *                    discriminated Edit and write-idiom arms are gone, along with the
 *                    `--session-guard` flag that switched them on. What stays lead-only
 *                    is `git push` / `git merge` through the shell (the gate's push/merge
 *                    arm) plus the draft-only PR route through soma-pr; the worktree deny
 *                    list binds lead and teammate alike. See `writeLaunchSettings` for why
 *                    no settings file may ever carry the old bare-name ban again.
 *   no personal MCP  `--strict-mcp-config` with a `--mcp-config` naming only `soma` and the
 *                    stateless `sequential-thinking` for the lead, and the worktree guard
 *                    file's deny list for its teammates. The guard file never denies those
 *                    two names (the lead loads it too); the gate holds them for the lead.
 *   scrubbed env     `env -i` plus ENV_ALLOW (applied by `tmux.newSession`). The operator's
 *                    exported API keys never reach a lead, a teammate, or a workflow agent.
 *   its own cwd      the lead's worktree, which is what keeps ten leads in ten
 *                    `projects/<slug>/` directories and therefore on ten separate meters.
 *
 * That gate hook is registered TWICE and the second one is why this module grew a
 * settings composer: `settings-gen` registers it inside `<worktree>/.claude/settings.local.json`,
 * i.e. inside the file it defends, so one bypass removed it. See `teammateGuardHook`.
 *
 * Composition order is load-bearing and is asserted by the tests: the worktree exists
 * before the guard file is written into it, the guard file and the trust mark land before
 * `claude` reads either, and the whole sequence runs inside the per-repo mutex.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import process from 'node:process';
import { loadConfig } from './config.mjs';
import { SOMA_HOME, ensureTree, leadDir, logPath, worktreeDir } from './paths.mjs';
import { preTrust } from './pretrust.mjs';
import { loadSeats } from './seats.mjs';
import * as sg from './settings-gen.mjs';
import { writeStanding } from './standing.mjs';
import * as tmux from './tmux.mjs';
import * as worktree from './worktree.mjs';

/**
 * The environment variables that survive `env -i`, copied through from the spawner.
 *
 * **This list must never carry a credential.** Environment values are world-readable via
 * `ps` on macOS, and a lead's environment is inherited by every teammate and every
 * workflow agent it starts, so one name added here is one secret handed to every agent in
 * the fleet. Anything a repo genuinely needs (a toolchain root, an agent socket) belongs
 * in an operator-visible config escape hatch, not here.
 *
 * Six of the eight are the shape of a usable shell. Two are not cosmetic:
 *
 * **`CLAUDE_CONFIG_DIR` is here because `env -i` drops it, and dropping it is a silent
 * hang.** It decides which `.claude.json` claude reads, and therefore which one holds the
 * trust mark for the lead's brand-new worktree. It is set on the machine v1 ships to *and
 * the stale default file still exists*, so without it the orchestrator marks trust in one
 * file, the lead reads another, finds no mark, and stops on `Quick safety check … 1. Yes,
 * I trust this folder / 2. No, exit` — measured in a detached tmux pane, with nobody there
 * to answer, until the watchdog gives up on it.
 *
 * **`USER` is here because without it the lead is NOT LOGGED IN.** Measured on the machine
 * v1 ships to, on the first real fleet: `claude -p` under `env -i` with the other seven
 * names returns `Not logged in · Please run /login`; add `USER` and the identical command
 * authenticates. Confirmed twice in each direction, and `LOGNAME` alone does not substitute
 * — only `USER` does. OAuth credentials live in the macOS keychain (there is no
 * `.credentials.json` in either config root), and the keychain lookup does not resolve
 * without it. This is the `oauthUnderEnvI` bring-up invariant failing exactly as §10
 * warned it could, and the symptom is worse than a hang: the pane renders normally, the
 * composer accepts input, and only a status line in the corner says the lead can never
 * call the API.
 *
 * It costs no disclosure. `HOME` is already on this list and is `/Users/<username>`, so the
 * username is forwarded to every teammate either way; `USER` tells a teammate nothing it
 * could not already read. That is the whole argument for growing a closed list — and the
 * exact-list test exists to force it to be stated.
 *
 * Deliberately absent: `SOMA_HOME`, which is injected from `paths.SOMA_HOME()` rather than
 * copied, so the lead and the bus config `settings-gen` writes for it cannot end up with
 * two spellings of one root. `SOMA_TMUX_SOCKET`, injected from `tmux.socketName()` by the same
 * rule: that is the server `tmux.newSession` creates the lead on, so the lead's socket is its real
 * server by construction, where a copied value could name a server it was never created on. And
 * `CLAUDE_CODE_EFFORT_LEVEL`, which is *set* below — copying the operator's own `low` through
 * would be the deviation this module exists to prevent.
 */
export const ENV_ALLOW = Object.freeze(['HOME', 'PATH', 'SHELL', 'TERM', 'LANG', 'TMPDIR', 'CLAUDE_CONFIG_DIR', 'USER']);

/** A lead id, and therefore a tmux session name and a directory name. Mirrors `fleet.ID_RE`. */
const LEAD_RE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * One lead's tmux session name, `--name` and `--remote-control` label.
 *
 * Written once because four places need it and they must not drift: the liveness check
 * that refuses a second lead, the session tmux creates, the window `remain-on-exit` is set
 * on, and the target the orchestrator wakes. Spelled inline in two of them, one could be
 * changed alone — and then `hasSession` would clear a name `newSession` does not create, so
 * the pre-spawn `hasSession` guard would pass while the double-spawn it exists to stop went ahead.
 */
const target = (id) => `lead-${id}`;

/**
 * The tools a lead may never call, as claude spells them on the command line.
 *
 * **The ban this names is LIFTED** — `buildLeadArgv` no longer emits `--disallowedTools`, and
 * the gate's session-discriminated Edit arm is retired with it: a lead's edit surface matches
 * a teammate's. The constant stays exported as the pinned SPELLING of the three names,
 * because doctor's regression guard still needs one: a future `--disallowedTools` naming any
 * of these would RE-impose the retired ban, and that is now the FAIL, not the pass.
 *
 * `soma doctor` reads it back through `buildLeadArgv` (check `lead edit ban on argv`) and
 * judges it against **its own** independent spelling of the three names, not against this
 * constant — comparing this constant with itself would be a check that cannot fail.
 */
export const BANNED_TOOLS = 'Edit,Write,NotebookEdit';

/**
 * The model every lead is pinned to, and the pin the watchdog judges deviation against.
 *
 * Exported for the same reason `target()` is written once: two places need it and they must
 * not drift. The launch is here; the check is `soma-watchdog.mjs`, which calls
 * `modelDeviation(usage, LEAD_MODEL)`. Spelled as a literal in both, one could be changed
 * alone — and then the watchdog compares a live transcript against a retired pin, which fails
 * in both directions at once: every correctly-pinned lead reports as deviating (noise an
 * operator learns to ignore), or a genuine fallback reports as clean (silence).
 *
 * It is an INFIX, not a prefix: `--model opus` resolves to `claude-opus-5`, so the matching
 * rule lives in `tokens.matchesPin` and nothing here or in the watchdog re-derives it.
 *
 * **MEASURED, not assumed** (2026-08-17, claude 2.1.x, `-p --output-format json`): `--model opus`
 * came back `modelUsage: { "claude-opus-5": { canonicalModel: "claude-opus-5",
 * contextWindow: 1000000 } }`. The full id `--model claude-opus-5` was probed in the same way and
 * resolves identically, so either token launches — see the trade-off below for why the alias is
 * the one that ships. `soma doctor` does not read this constant; `test/spawn.test.mjs` pins it
 * against `tokens.modelDeviation` so the launch token and the watchdog's pin cannot drift apart.
 *
 * ⚠ **ONE BLIND SPOT THIS PIN HAS AND `'fable'` DID NOT, stated because it is a real loss.**
 * `matchesPin` is contiguous SEGMENT containment, so the pin `'opus'` is satisfied by
 * `claude-opus-4-5` as well as by `claude-opus-5` — an Opus 5 → Opus 4.5 fallback therefore reads
 * as correctly pinned and raises no MODEL_DEVIATION. Under the old `'fable'` pin every opus id was
 * a visible fallback, which is what `bus-tools`' model column was written for. Closing it needs
 * only `LEAD_MODEL = 'claude-opus-5'` (probed above; `claude-opus-4-5` does NOT contain the
 * contiguous segments `claude,opus,5`, while the dated `claude-opus-5-20251001` still does) — it is
 * left as an operator decision rather than taken here, because it changes what every deviation
 * row reports. A cross-FAMILY fallback (sonnet, haiku, fable) is still caught either way.
 */
export const LEAD_MODEL = 'opus';

/**
 * The reasoning levels `--effort` and `CLAUDE_CODE_EFFORT_LEVEL` actually accept.
 *
 * Read only in the **closed** direction, and that is the entire reason it is a list:
 * `teammate_effort` is matched against it and **anything not on it is treated as `inherit`**,
 * which *keeps* `CLAUDE_CODE_EFFORT_LEVEL=max`. Nothing validates the config value —
 * `config.DEFAULTS` supplies `'inherit'` and there is no effort-level check anywhere in
 * `bin/` — so `teammate_effort: 'inheret'` is one typo in `soma.json`. Read as "a configured
 * level" that typo would drop the pin and land every teammate and every workflow agent on the
 * operator's persisted `effortLevel: low`: the exact deviation this module exists to prevent,
 * arriving silently. The **lead** stays pinned by `--effort max`, so the watchdog's
 * MODEL_DEVIATION check — which reads the *lead's* transcript — never fires either. The whole
 * failure is on the teammate side, where nothing looks.
 *
 * So the failure direction of this list being *incomplete* is a configured level that is
 * merely unreachable — over-pinned, expensive, faithful — never a fleet that quietly un-pins.
 * A vocabulary list has failed repeatedly on this build by not containing the hostile item;
 * this one is safe against that only because of which way round it is read. Adding `'inherit'`
 * to it would invert exactly that, which is what the `'inherit'` pins in the tests catch.
 */
const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * The lead's effort from `soma.json`'s `lead_effort`. A level on `EFFORT_LEVELS` is used as
 * given; anything else (missing, empty, a typo, `'inherit'`) reads as `'max'`, so a config that
 * was never written or was written wrong keeps the original pin rather than dropping it.
 */
export function leadEffortOf(value) {
  return EFFORT_LEVELS.includes(value) ? value : 'max';
}

/**
 * The installed `bin/` directory — this file's parent's parent. Same derivation and same
 * reason as `settings-gen.BIN_DIR`: `fileURLToPath`, never `new URL(...).pathname`, because
 * the latter percent-encodes, so an install under `~/My Repos/` yields `My%20Repos` and the
 * generated hook command points at a directory that does not exist.
 */
const BIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Quote one word for the `/bin/sh` that runs a hook command — `settings-gen.shq`'s twin, and
 * it has to be a twin: the two produce the same command string and a reviewer diffing them
 * must find them identical. Single quotes so nothing in a path is expanded, and an embedded
 * quote closed-escaped-reopened the POSIX way.
 */
const shq = (word) => `'${String(word).replaceAll("'", "'\\''")}'`;

/** A value with own keys worth walking. Arrays and null are not. */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * THE TEAMMATE GUARD, REGISTERED WHERE THE THING IT GUARDS CANNOT REACH IT.
 *
 * This is the fix for the build's Critical, and the defect is worth stating plainly because
 * the code reads as if it were already handled. `settings-gen.writeWorktreeGuardrails`
 * registers this same `PreToolUse` hook inside `<worktree>/.claude/settings.local.json` —
 * **inside the file the hook exists to defend.** Measured end to end in a real bypassed
 * teammate session: the file can be emptied (`tee`, `cp /dev/null`, `dd of=`, `install -m644`
 * all ran), an emptied file **fails open**, and claude **re-reads it mid-session** (a command
 * denied, the guard emptied, the same command permitted two tool calls later). Clean two-
 * session A/B: populated file → hook registered → write DENIED; emptied file → hook absent →
 * the same write **RAN**. One uncovered write idiom therefore removed the enforcement itself.
 *
 * The platform answer that makes placement sufficient: **hooks MERGE**. A worktree-local file
 * can only ADD a hook, never remove a higher-scope one — measured against five shapes of the
 * local file (absent, a *different* PreToolUse hook, `{"hooks":{}}`, `{}`, zero bytes, and
 * `{"hooks":{"PreToolUse":[]}}`); in every case the higher-scope hook still fired and still
 * denied. So no integrity check over the guard file is needed for the hook's own survival.
 *
 * **The A/B re-run in the fixed direction, live, against a real split-pane teammate** (claude
 * 2.1.220, a separate process with its own session id, not a Task subagent): the worktree
 * `.claude/settings.local.json` held **zero bytes** for the whole run; the teammate's `echo`
 * ran, and its `cp ./.claude/settings.local.json <elsewhere>` was **DENIED**, by a hook whose
 * only registration was a `--settings` file outside the worktree. The destination file was
 * never created. That is the exact vector that previously destroyed the guard file, now
 * refused with the guard file already empty.
 *
 * WHAT THIS DOES NOT FIX, and it must be read in the same breath: **the worktree guard file
 * remains the only home of the 95 machine-independent deny rules, plus one `mcp__*` deny per
 * personal MCP server this machine has, and those can still be erased.**
 *
 * **95 is COUNTED FROM THE GENERATOR, and the number that used to be here was not.** This
 * comment said `58` and `lead-gate.mjs` said `59`; the two disagreed and **both were wrong**,
 * because neither was ever a count of a fixed set — each was a snapshot taken before the
 * credential family landed. Re-derive it the only way that cannot go stale, by calling the
 * writer and counting the file it produces rather than reading any prose:
 *
 *     writeWorktreeGuardrails(dir, { mcpDenies: ['one-fake'], teammateAllow: [], home, env: {} })
 *     → permissions.deny.length === 96, of which 1 is the fake personal server
 *     → 95 machine-independent = 68 `Bash(…)` + 13 `Read(…)` + 13 `mcp__…` + `Edit(./.claude/**)`
 *       (`STANDING_DENIES` 52 pre-credential-family + `CREDENTIAL_STORE_DENIES` 43), zero dupes
 *
 * The direction of the old error is the reason this is worth a paragraph: this sentence is what
 * an operator reads to size the blast radius of an erased guard file, and `58` **understated it
 * by 37 rules** — the whole credential family. A residual note that under-alarms is worse than
 * one that over-alarms, because the operator calibrates their response to it.
 *
 * This hook surviving is what makes that **recoverable rather than fatal**
 * — it is not a substitute for noticing. `soma doctor` checking the guard file exists and is
 * non-empty is the other half, and that also catches `git clean -fdx` removing an
 * ignored-by-design `.claude/`.
 *
 * The in-worktree registration is deliberately KEPT, and the duplicate is measured rather than
 * assumed harmless. With the two registrations carrying **different** commands, both fire on
 * the same tool call, both deny, and **exactly one refusal surfaces** — no error, no second
 * prompt. With them carrying the **same** command, which is the shipped case, the hook runs
 * ONCE — measured 2026-09-07 on claude 2.1.263 (`-p` mode, 13/13 runs, two independent counts
 * agreeing in every run: claude-side `hook_started` events and a hook-side counter file). The
 * dedupe key is the command STRING: identical commands collapsed to one run across two entries
 * in one file, inside one entry's `hooks[]`, across matchers `Bash` + `*`, and across
 * `--settings` + the cwd `.claude/settings.local.json`; two DISTINCT commands in one file ran
 * twice, which is the control showing the second registration loads at all. So the second
 * registration costs nothing while the two strings match, which is why a test pins them
 * byte-identical. Platform behaviour, unversioned by this repo — re-measure on a claude
 * upgrade before leaning on it further.
 *
 * The command used to end in `--session-guard` — the switch for the gate's session-
 * discriminated Edit arm, which was this twin's original whole purpose. That arm was retired
 * when the lead's edit surface was lifted to match a teammate's; the flag became a no-op and
 * is gone from every emit. The twin now earns its keep as the placement fix alone: a
 * registration the worktree's own guard file cannot delete.
 *
 * **The launch file carries exactly ONE gate entry.** The base `writeLeadSettings` publishes
 * already holds an entry byte-identical to this twin, so `withTeammateGuard` appends the twin
 * only when the base carries no entry deep-equal to it — a base with no `hooks` at all, or one
 * whose gate is stale (a pre-08-06 `--session-guard` command) — and is idempotent: applying it
 * twice registers the gate once. Measured against the real generator: base 1 → launch 1,
 * applied twice → 1, no-hooks base → 1, stale flagged base → 2 (the stale entry, then this).
 * Old launch files are never read back — `writeLaunchSettings` recomposes from a freshly
 * published base on every spawn and resume — so nothing migrates; a lead spawned before
 * 08-06 keeps its flagged twin (and pays two gate runs per tool call, harmlessly: the gate
 * writes nothing) until it is resumed.
 *
 * Deep equality is the key on purpose, NOT the command string claude itself dedupes by. Claude's
 * key ignores the matcher (measured: `Bash` + `*` with one command → one run), so mirroring it
 * here would let a base entry carrying the same command under a NARROWED matcher suppress this
 * `'*'` twin, and the BUDGET_TRIPPED breaker would stop being consulted for Read and Task — the
 * round-3 hole `settings-gen.writeLeadSettings` documents. Under deep equality that narrowed
 * entry is not the guard, the twin is appended, and claude still runs one hook for Bash.
 * Identical → skip; anything else → register. That is the fail-safe direction.
 */
const teammateGuardHook = () => ({
  matcher: '*',                              // narrowing uninstalls the breaker for every tool it stops asking about
  hooks: [{ type: 'command', command: `node ${shq(resolve(join(BIN_DIR, 'hooks', 'lead-gate.mjs')).replaceAll('\\', '/'))}` }],
});

/**
 * `settings` with the teammate guard on its `PreToolUse` list — appended when absent, left
 * alone when an entry deep-equal to it is already there (see `teammateGuardHook` for why deep
 * equality and not the command string). Idempotent.
 *
 * **Appended, never assigned.** `hooks.PreToolUse = [guard]` would delete the lead's own gate
 * entry — and with it the BUDGET_TRIPPED breaker — while still passing every "the guard is
 * registered" check, which is the shape of mistake this whole module is written against. The
 * real-generator pin alone cannot catch that assignment (the base's one entry IS the guard, so
 * `[guard]` looks deduped); the fixture pins with a fake-path gate entry are what catch it.
 *
 * A missing `hooks` block is a file to add to. A `hooks` that is not an object is not
 * something to guess at: settings-gen is the only writer, so a different shape means the file
 * is not what we think it is, and composing on top of it would produce a settings file claude
 * silently ignores. Refuse instead.
 */
export function withTeammateGuard(settings) {
  if (!isObject(settings)) {
    throw new TypeError(`withTeammateGuard: settings must be a JSON object, got ${Array.isArray(settings) ? 'array' : settings === null ? 'null' : typeof settings}`);
  }
  if (settings.hooks !== undefined && !isObject(settings.hooks)) {
    throw new TypeError(`withTeammateGuard: settings.hooks must be a JSON object, got ${Array.isArray(settings.hooks) ? 'array' : typeof settings.hooks}`);
  }
  const hooks = { ...(settings.hooks ?? {}) };
  const pre = hooks.PreToolUse;
  if (pre !== undefined && !Array.isArray(pre)) {
    throw new TypeError(`withTeammateGuard: settings.hooks.PreToolUse must be an array, got ${typeof pre}`);
  }
  const guard = teammateGuardHook();
  const present = (pre ?? []).some((e) => isDeepStrictEqual(e, guard));
  hooks.PreToolUse = present ? [...pre] : [...(pre ?? []), guard];
  return { ...settings, hooks };
}

/**
 * Publish `leads/<id>/settings.launch.json` — the file `--settings` actually points at — and
 * return its path. It is the lead settings file plus the teammate guard, and it lives under
 * the state root, so no state of any worktree can reach it.
 *
 * **Why compose one file instead of passing a second `--settings`.** Observed on Claude Code
 * 2.1.220: when `--settings` is given more than once, the settings loader keeps only the last
 * value, so repeated flags are **not** merged — the last one wins and every earlier one is
 * discarded in silence. A second flag carrying only the guard would drop the lead's model pin, its
 * heartbeat and its Stop hook, and the lead would start looking perfectly healthy.
 *
 * **Why this reaches a teammate at all.** `settings-gen`'s header used to say the opposite —
 * "`--settings` does not propagate to teammates, who load settings from cwd" — and that
 * sentence was **false**, measured three times now; it has been corrected at its site. In the
 * binary, the teammate launcher builds `cd <cwd> && env <vars> <claude> <identity flags>
 * <inherited flags>` and the inherited-flag builder ends with `--settings <the parent's own
 * value>`. Live, four real split-pane teammates spawned from sessions started with
 * `--settings <path>` all carried `--settings <that same path>` in their own argv. The rest of
 * that sentence is right, and re-measured against a parent that carried all five flags at
 * once: a teammate is a fresh `claude` process and does *not* inherit `--disallowedTools`,
 * `--mcp-config`, `--strict-mcp-config` or `--setting-sources`. `--settings` is the exception,
 * and it is the exception this fix rides on.
 *
 * ---
 * CLOSED, AND THE MEASUREMENT IS KEPT BECAUSE IT IS WHAT MAKES THE SHAPE COMPREHENSIBLE.
 *
 * `settings-gen.writeLeadSettings` used to put `permissions.deny: ['Edit','Write',
 * 'NotebookEdit']` in this file to give the lead its no-code property, on the stated
 * understanding that the file is "scoped to the lead process". It is not. Live, a real
 * split-pane teammate spawned from a session whose `--settings` file carried those denies
 * reported **"No such tool available: Write. Write exists but is not enabled in this
 * context."** A soma teammate exists to write code, so on that wiring every teammate in the
 * fleet lost Edit, Write and NotebookEdit — and it looked like a model limitation rather than
 * a settings bug, which is why four reviews missed or under-graded it.
 *
 * **The propagation asymmetry, re-measured rather than trusted** (claude 2.1.220, a real
 * split-pane teammate under `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` + `teammateMode: tmux`,
 * spawned from a parent carrying `--settings`, `--mcp-config`, `--strict-mcp-config`,
 * `--setting-sources` and `--disallowedTools`). The teammate's own argv, verbatim apart from
 * placeholder ids:
 *
 *     --agent-id fixedteam@session-0000aaaa --agent-name fixedteam \
 *       --team-name session-0000aaaa --agent-color blue \
 *       --parent-session-id 0000aaaa-… --agent-type general-purpose \
 *       --dangerously-skip-permissions \
 *       --settings /private/tmp/…/fixed-settings.json --model claude-opus-5
 *
 * `--settings` inherited. `--disallowedTools`, `--mcp-config`, `--strict-mcp-config` and
 * `--setting-sources` **all dropped**, every one of which the parent had (on Claude Code 2.1.299
 * `--mcp-config` and `--strict-mcp-config` are inherited too). That asymmetry is the whole fix:
 * the ban belongs on argv, which binds one process, not in a file, which binds the fleet.
 *
 * **The fix was proven before it was applied.** With `permissions.deny` removed from the
 * settings file and only `--disallowedTools Edit,Write,NotebookEdit` left on the lead's argv,
 * one live session showed both halves at once: the lead answered *"No such tool available:
 * Write. Write exists but is not enabled in this context."* and wrote nothing, while **its
 * teammate wrote its file.** The session `init` tool list is identical (27 tools, none of the
 * three) with the deny and with argv alone, so argv removes them from context rather than
 * refusing at call time; and the lead's in-process `Task` subagents hit the same refusal, so
 * argv held the entire stated boundary on its own; the gate's session-discriminated Edit arm
 * was a second carrier. Both have since been retired outright — the lead's edit surface now
 * matches a teammate's — and this block stays because its propagation measurements are why no
 * settings file may ever carry a bare edit deny again.
 *
 * **`writeLeadSettings` now writes no `permissions` key at all**, so this composition carries
 * none either — and that is why `withTeammateGuard` spreads rather than requiring the key. The
 * strip was done *there* rather than here on purpose: doing it here would have left
 * `settings.json` stating a ban that the file `--settings` actually points at did not carry,
 * so `soma doctor` would have passed while reading a file no process consumes.
 *
 * `soma doctor` now asserts the inverse of what it used to — `no edit ban in settings files`
 * checks that neither this composition's base nor the worktree guard file carries the three
 * bare names, and `lead edit ban on argv` reads `buildLeadArgv()` back to confirm the
 * replacement is still on the argv. Neither claims anything about a running lead's tool list,
 * which doctor cannot see.
 * ---
 *
 * tmp+rename, the house idiom (`settings-gen.publish`, `fleet.writeFleet`): a lead reads this
 * file at start-up while a revival may be rewriting it, and a half-written settings file is a
 * lead with no pins and no guard. (Atomicity itself is not observable from a single-threaded
 * test — a mutation replacing it with a direct write survives the suite. Declared, not hidden.)
 */
function writeLaunchSettings(what, id, leadSettingsPath) {
  let raw;
  try {
    raw = readFileSync(leadSettingsPath, 'utf8');
  } catch (e) {
    throw new Error(`${what}(${id}): could not read the lead settings file ${leadSettingsPath} (${e.code ?? e.message}) — it is the base the teammate guard is composed onto, and a lead launched without it has neither its model pin nor its heartbeat, Stop hook and own PreToolUse gate (its no-code ban is on argv and survives this)`, { cause: e });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new SyntaxError(`${what}(${id}): ${leadSettingsPath} is not valid JSON: ${e.message}`, { cause: e });
  }
  if (!isObject(parsed)) {
    throw new Error(`${what}(${id}): ${leadSettingsPath} must contain a JSON object, got ${Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed}`);
  }
  const fp = join(leadDir(id), 'settings.launch.json');
  const body = `${JSON.stringify(withTeammateGuard(parsed), null, 2)}\n`;
  const tmp = `${fp}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, body);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    mkdirSync(dirname(tmp), { recursive: true });
    writeFileSync(tmp, body);
  }
  renameSync(tmp, fp);
  return fp;
}

/** A string with something in it: the only shape a sha or a branch name may have here. */
const nonEmpty = (v) => typeof v === 'string' && v !== '';

/**
 * `leads/<id>/meta.json`: the spawner's record of one launch, the per-lead forensic record the
 * design names.
 *
 * Only what the spawn fixed goes in it: the task and repo, the base branch and the commit the
 * worktree was cut from, the branch and the checkout, whether it was reused, the session uuid,
 * the tmux target, and when. Not the seat or its config dir, which a rotation changes (the row
 * tracks `seat`), and not the Remote Control URL, which nothing captures yet (ROADMAP).
 *
 * Written inside the repo lock and BEFORE the launch, in the order the design's spawn recipe
 * gives. A launch that throws after a fresh cut leaves a clean checkout, the next attempt reuses
 * it, and `ensureWorktree` can then report only the remote's tip: this file is where that attempt
 * finds the commit the checkout was really cut from. A write that fails throws, because nothing
 * has launched yet and both callers roll the row back. tmp+rename, as `writeLaunchSettings`.
 */
function writeMeta(id, meta) {
  const dir = leadDir(id);
  mkdirSync(dir, { recursive: true });
  const fp = join(dir, 'meta.json');
  const tmp = `${fp}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`);
  renameSync(tmp, fp);
}

/**
 * The commit a REUSED checkout on `branch` was cut from, as recorded, or null when nothing says.
 *
 * `leads/<id>/meta.json` decides whenever it can be read. The spawner writes it, naming its
 * branch, before the launch; the row only gets the same value after the launch, through a write
 * that can fail on its own. So a readable record is never older than the row, and it is the only
 * one that says which branch its base belongs to. Its base counts when the branch is this one.
 * A record of another branch says nothing about this checkout: after a retry suffix the checkout
 * here is on `soma/<id>-r2`, cut later, and a `soma/<id>` record is what a failed write on that cut
 * left behind. That record, or one with no usable base, means the base is unknown: null, even
 * when the row has one, since the row's may be from that same stale cut.
 *
 * `rowBase`, the row's own `base_sha`, is the fallback only when there is no record to read: no
 * file, or one that does not parse to an object, which is a lead spawned before this record
 * existed or a lead dir someone wiped. The remote's current tip is never the answer.
 */
function recordedBase(id, branch, rowBase) {
  let meta = null;
  try {
    meta = JSON.parse(readFileSync(join(leadDir(id), 'meta.json'), 'utf8'));
  } catch {
    // No file, or no JSON in it: no record.
  }
  if (!isObject(meta)) return nonEmpty(rowBase) ? rowBase : null;
  return nonEmpty(branch) && meta.branch === branch && nonEmpty(meta.base_sha) ? meta.base_sha : null;
}

/**
 * What a resumed lead is told, as its first user message.
 *
 * Short on purpose: the standing brief (`--append-system-prompt-file`) carries the task
 * facts and the rules, and it is re-appended every turn, whereas this is one user message
 * that a later compaction can eat. Its whole job is to send the lead back to `soma_task()`
 * for state it must not guess at — teams do not survive a resume, and finished work stays
 * finished.
 */
const RESUME_BRIEF = 'You were interrupted. Call soma_task() to re-orient, re-establish your team, and continue.';

/** `value` if it is a usable lead id, else a refusal naming the caller. */
function leadId(value, what) {
  if (typeof value !== 'string' || !LEAD_RE.test(value)) {
    throw new TypeError(`${what}: ${JSON.stringify(String(value))} is not a usable lead id (lowercase letter, then letters/digits/hyphens)`);
  }
  return value;
}

/**
 * `value` if it is a repo key that cannot climb out of the state root.
 *
 * `spawnLead` gets this check for free from `ensureWorktree`, but `resumeLead` does not go
 * near git and still builds a cwd from the key — so a row carrying `repo: '../../..'`
 * would resume a permission-bypassed session somewhere outside `$SOMA_HOME` entirely.
 */
function repoKey(value, what) {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${what}: repo must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  const parts = value.split(/[/\\]/);
  if (value.startsWith('-') || parts.includes('..') || parts.includes('.')) {
    throw new TypeError(`${what}: repo ${JSON.stringify(value)} is not a usable path component`);
  }
  return value;
}

/** `value` if it is a non-empty string, else a refusal naming the field. */
function required(value, what, field) {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${what}: ${field} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * A refused `configDir`, rendered for its own refusal message. Total by construction: three
 * states, and the third is "could not be printed at all".
 *
 * The refusal used to interpolate `JSON.stringify(value) ?? String(value)` directly, and
 * `JSON.stringify` THROWS on three inputs (all measured): a bigint (`Do not know how to serialize
 * a BigInt`), a self-referential object (`Converting circular structure to JSON`) and anything with
 * a `toJSON` that throws. The throw happened inside the refusal's own template, so the named
 * refusal never printed — the operator got a serialiser error and no mention of `configDir`. It
 * still failed closed, which is why this was Minor rather than Critical.
 *
 * `String(value)` alone is NOT the fix, and swapping to it would have traded one hole for another:
 * `String` throws on a revoked Proxy and on any object whose `toString`/`Symbol.toPrimitive`
 * throws — and `{ toString() { throw } }` is a case the CURRENT expression gets right, because
 * `JSON.stringify` never calls `toString` on a plain object. So both renderers are tried, in the
 * order that gives the better message, and neither is trusted to return.
 *
 * `String(value)`, not `${value}`: a Symbol throws on implicit conversion (`Cannot convert a Symbol
 * value to a string`) and does not on the explicit call — measured, in the same direction as the
 * bug above.
 *
 * `JSON.stringify` first because it quotes: `"seat-b"` is visibly a string where `seat-b` could be
 * anything, and a path with a stray space or newline in it shows up. It returns `undefined` — not a
 * throw — for a Symbol, a function or `undefined` itself, which is the second state, not the third.
 */
function describeSeat(value) {
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch { /* bigint, circular, a throwing toJSON — fall through to the second renderer */ }
  try {
    // The type as well as the text: `String(1n)` is "1", which would read as the number.
    return `${typeof value} ${String(value)}`;
  } catch { /* a revoked Proxy, a throwing toString/Symbol.toPrimitive — fall through */ }
  return `an unprintable ${typeof value}`;
}

/**
 * `value` if it is a usable per-launch config dir — a seat — or `undefined` when the caller named
 * none.
 *
 * Three spellings of "no seat", and all three mean TODAY'S behaviour, the frozen module env
 * deciding `CLAUDE_CONFIG_DIR`: `undefined` (every caller that predates seats), `null` (the fleet
 * row's `seat: string | null`, so a revert onto a pre-seat lead's original seat lands where that
 * lead always ran) and `''` (how soma spells unset everywhere — `soma up` forwards `VAR || ''`,
 * `buildLeadEnv` drops empty values, `paths` and `pretrust` read with `||`). That is the
 * fail-toward-the-pin direction `EFFORT_LEVELS` takes: a rotation that arrives with an empty seat
 * lands the lead where every lead has landed until now, never on the default `~/.claude`, which on
 * the machine v1 ships to is a stale root that may hold no login — a pane that renders and can
 * never call the API.
 *
 * A RELATIVE dir is refused rather than resolved. `pretrust.configPath` would `resolve()` it against
 * the SPAWNER's cwd while claude resolves it against the LEAD's — the worktree — so the mark would
 * land in one `.claude.json` and the lead read another: the measured detached-pane hang, from a
 * value that looks fine. `~/x` is refused for the same reason and is NOT expanded here:
 * `resolveConfigDir` in `seats.mjs` is the only `~` expander, `loadSeats` runs it once when the
 * config is read, and every legitimate seat — `pick()`'s, a revert's original resolved through
 * `loadSeats`, `soma init --seat`'s — has been through it. A tilde reaching here skipped the loader.
 */
function seatConfigDir(value, what) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new TypeError(
      `${what}: configDir must be an absolute path (or undefined for the spawner's own), got ${describeSeat(value)}`
      + ' — a relative one is resolved against the spawner\'s cwd by preTrust and against the lead\'s by claude,'
      + ' so the trust mark and the lead would disagree about which .claude.json is live',
    );
  }
  return value;
}

/**
 * Every option name the last argument may carry, spelled ONCE so a caller and this check cannot
 * drift apart. A change that adds an option adds it here and nowhere else.
 */
const LAUNCH_OPT_KEYS = Object.freeze(['configDir']);

/**
 * The per-launch options object, or a refusal naming the caller.
 *
 * `spawnLead(task, deps, '/seat-b')` would otherwise destructure a string, find no `configDir`,
 * and launch on the spawner's own seat — a rotation that silently did not rotate, which hits the
 * same closed window again and reads as thrash. A missing argument is every caller that predates
 * seats; anything present has to be the shape the contract names.
 *
 * **The container is not enough: the KEY is checked too.** `{ config_dir }`, `{ seat }` and
 * `{ CONFIGDIR }` are objects, so the check above passes them; the destructure then finds no
 * `configDir` and the launch lands on the spawner's own seat — MEASURED on all five spellings,
 * both entry points, with no refusal at all. That is the same silent non-rotation the bare-string
 * case exists to prevent, and nothing downstream can catch it: with no seat in the env `preTrust`
 * and `trustFileFor` both name the spawner's file and AGREE, so the one check that would have
 * noticed passes. An unknown key is therefore refused rather than ignored.
 *
 * `Object.keys` — own enumerable string keys, which is exactly what an object literal yields — is
 * what a misspelling can produce. It deliberately does not see a symbol key, an own non-enumerable
 * one, or an inherited one: none of those can be a typo for `configDir`, and each is read by the
 * destructure the same way whether or not this check saw it, so there is no third case hiding
 * behind it. A container whose keys cannot be enumerated at all (a revoked Proxy) throws here,
 * before the repo lock, which is the fail-closed direction.
 */
function launchOpts(opts, what) {
  if (opts === undefined) return {};
  if (!isObject(opts)) {
    throw new TypeError(`${what}: the last argument must be an options object such as { configDir }, got ${Array.isArray(opts) ? 'array' : opts === null ? 'null' : typeof opts}`);
  }
  const unknown = Object.keys(opts).filter((k) => !LAUNCH_OPT_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new TypeError(
      `${what}: unknown option key${unknown.length === 1 ? '' : 's'} ${unknown.map((k) => JSON.stringify(k)).join(', ')}`
      + ` — this argument takes only ${LAUNCH_OPT_KEYS.map((k) => JSON.stringify(k)).join(', ')}`
      + ', and a key nothing reads is a seat that was named and then dropped:'
      + " the launch would land on the spawner's own seat and read as a rotation that happened",
    );
  }
  return opts;
}

/**
 * The refusal both entry points share, with the remedy in it.
 *
 * `what` is the caller's own name: an operator reading "spawnLead(cr-1)" after asking for a
 * resume would go looking in the wrong place.
 */
const refuseLive = (what, id, name) =>
  new Error(
    `${what}(${id}): tmux already has a live tmux session named ${name}, so this would be a second lead on one task`
    + ' — a session survives its lead by design (remain-on-exit keeps the death scene), so kill it first'
    + ` (\`soma kill ${id}\`, or tmux kill-session -t =${name}) and then respawn`,
  );

/**
 * The `.claude.json` the lead we are about to start will actually read.
 *
 * A second, independent statement of `pretrust.configPath`'s rule, and it is here to be
 * *compared* against what `preTrust` returns rather than to be used in its place. The two
 * disagreeing is the measured silent hang, so the spawn is failed instead.
 *
 * The shape is the part worth re-reading: the file sits **beside** the default config dir
 * (`$HOME/.claude.json`) and **inside** an overridden one (`$CLAUDE_CONFIG_DIR/.claude.json`).
 * Joining onto a config *root* helper instead would ask for `$HOME/.claude/.claude.json` in
 * the default case — a path that exists on no machine checked — and would reintroduce the
 * hang while looking tidier.
 */
const trustFileFor = (env) => resolve(join(env?.CLAUDE_CONFIG_DIR || env?.HOME || homedir(), '.claude.json'));

/**
 * The lead's launch argv, `claude` first, the brief last behind a `--` guard.
 *
 * Every pin is its own element. That is not stylistic: `['--model opus']` is one word to
 * `execFile`, "unknown option" to claude, and a lead that dies instantly inside a tmux
 * session that still reads as alive.
 *
 * `--` before the brief is a regression fix inherited from soma: `--mcp-config` is
 * variadic, so without the separator a brief following it is swallowed as another config
 * path and the lead starts with no task at all.
 *
 * `--session-id` and `--resume` are mutually exclusive by construction. Claude Code refuses
 * to reuse a `--session-id` (measured while building the permission probe), so passing both
 * on a revival would fail the spawn.
 *
 * `--dangerously-skip-permissions` reads alarmingly next to a deny list, and the two do
 * coexist: measured against real Claude Code with the bypass flag set, a `permissions.deny`
 * rule still returned `Permission to use Bash with command … has been denied.` The bypass
 * removes the *prompts* — which is the point, since nobody is attached — not the rules.
 */
export function buildLeadArgv({ id, sessionUuid, brief, settingsPath, mcpPath, standingPath, resume = false, leadEffort } = {}) {
  leadId(id, 'buildLeadArgv');
  required(sessionUuid, 'buildLeadArgv', 'sessionUuid');
  required(brief, 'buildLeadArgv', 'brief');
  required(settingsPath, 'buildLeadArgv', 'settingsPath');
  required(mcpPath, 'buildLeadArgv', 'mcpPath');
  required(standingPath, 'buildLeadArgv', 'standingPath');
  const name = target(id);
  return [
    'claude',
    '--model', LEAD_MODEL,
    '--effort', leadEffortOf(leadEffort),
    ...(resume ? ['--resume', sessionUuid] : ['--session-id', sessionUuid]),
    '--name', name,
    '--permission-mode', 'acceptEdits',
    '--dangerously-skip-permissions',
    '--setting-sources', 'user,project,local',
    '--settings', settingsPath,
    '--mcp-config', mcpPath,
    '--strict-mcp-config',
    '--append-system-prompt-file', standingPath,
    '--remote-control', name,
    '--', brief,
  ];
}

/**
 * The lead's whole environment: the allow-list, scrubbed, plus what soma injects.
 *
 * `tmux.newSession` turns this into `env -i K=V …`, so what is not here does not exist for
 * the lead or for anything it spawns.
 *
 * **Empty values are dropped rather than forwarded.** `soma up` spells "unset" as `''`
 * (`SOMA_HOME: process.env.SOMA_HOME || ''`), and every soma reader of these variables uses
 * `||`, so soma already means "empty is unset". Forwarding `CLAUDE_CONFIG_DIR=` would make
 * that true of soma and unverified of claude — and the one variable where the two
 * disagreeing is a silent hang is exactly that one.
 *
 * **`SOMA_LEAD_SESSION_UUID` is not decoration.** `lead-gate.mjs` — the PreToolUse hook every
 * session in the worktree runs — decides lead-versus-teammate by comparing the hook's
 * `session_id` against it, and two arms ride that answer. The bus arm fails CLOSED without
 * it: an unidentifiable session is refused `mcp__soma__*`, so a lead spawned with this unset
 * cannot report at all. The push/merge arm fails OPEN: unset makes `isLead` false for every
 * session including the lead's, so the lead's `git push` / `git merge` denies never fire —
 * silently, and the worktree deny list then only covers the protected-branch spellings.
 *
 * **`teammateEffort`.** `inherit` (the default, decision D2) sets
 * `CLAUDE_CODE_EFFORT_LEVEL=max`, which flows to teammates and workflow agents — the
 * expensive but faithful reading. A configured *level* drops the variable instead, because
 * the variable outranks every other mechanism including per-subagent frontmatter, so
 * leaving it set would make the configured level unreachable. The lead stays pinned either
 * way by `--effort max`; only the inheritance changes. **Anything that is not one of the
 * levels claude accepts is treated as `inherit`** — missing, empty, `'inherit'` itself, and a
 * typo alike — so neither a config that has not been written nor one that was written wrong
 * can un-pin the fleet. `EFFORT_LEVELS` records why that direction is the safe one.
 *
 * **`teammateMcpAllow`** — soma.json's `teammate_mcp_allow`, set as `SOMA_TEAMMATE_MCP_ALLOW` for
 * the gate's arm (b3), which refuses the lead's reasoning server to teammates unless it is named.
 *
 * **`leadBranchPush`** — soma.json's `lead_branch_push`, set as `SOMA_LEAD_BRANCH_PUSH=1` only when
 * it is exactly `true`; see the line that sets it.
 *
 * **`configDir`** — a seat for THIS launch (account rotation, spec §3.3). It replaces the copied
 * `CLAUDE_CONFIG_DIR` and nothing else; `undefined`, `null` and `''` all mean "the spawner's own",
 * which is exactly what every lead got before seats existed. `seatConfigDir` says why each of
 * those three reads that way and why a relative dir is refused.
 */
export function buildLeadEnv({ id, sessionUuid, teammateEffort, teammateMcpAllow, leadBranchPush, leadEffort, env = process.env, configDir } = {}) {
  leadId(id, 'buildLeadEnv');
  const seat = seatConfigDir(configDir, 'buildLeadEnv');
  const out = {};
  for (const k of ENV_ALLOW) {
    const v = env?.[k];
    if (typeof v === 'string' && v !== '') out[k] = v;
  }
  // The seat, when there is one, REPLACES the copied value: the copied one is the spawner's own
  // config dir, and a lead rotated onto another seat must not see it. It is the only name a seat
  // touches — the allow-list above is unchanged, so no new name reaches a teammate — and
  // `seatConfigDir` has already read '' as "no seat", so `CLAUDE_CONFIG_DIR=` cannot be forwarded from here either.
  if (seat !== undefined) out.CLAUDE_CONFIG_DIR = seat;
  out.SOMA_LEAD_NAME = id;
  // The canonical resolver, not the raw variable: it normalises `/x/soma/` and `/x/soma`
  // onto one root and refuses a relative one outright, which is the only thing that stops a
  // lead and its watchdog silently disagreeing about where the fleet's state lives.
  out.SOMA_HOME = SOMA_HOME();
  // The tmux server, injected by the same rule: the socket this process's own tmux calls use, which
  // is the one `tmux.newSession` creates the lead on. Without it `env -i` left every lead's bus on
  // `soma`, typing its wakes into whatever pane held the orchestrator's pane id THERE — in the
  // field, another fleet's orchestrator (issue #1).
  out.SOMA_TMUX_SOCKET = tmux.socketName();
  if (typeof sessionUuid === 'string' && sessionUuid !== '') out.SOMA_LEAD_SESSION_UUID = sessionUuid;
  // soma.json's `teammate_mcp_allow`, for the one reader that cannot get it from the guard file:
  // `lead-gate.mjs` arm (b3). The guard file no longer denies the lead's own reasoning server (the
  // lead loads that file, and a bare server deny would take the server off the lead), so the gate
  // refuses it to teammates unless this list names it. Teammates inherit the lead's environment,
  // which is the only way a value set here reaches their hooks. Injected from the config, never
  // copied from the spawner's environment; a name with a comma in it cannot be told apart inside
  // the list, so it is dropped, and an empty list sets nothing.
  //
  // Not a secrets boundary, and not tamper-proof: a split-pane teammate (an operator's own
  // `teammateMode: tmux`) is started through the login shell, so a shell startup file a teammate
  // wrote can set this variable for later teammates. The most that buys them is soma's own
  // stateless reasoning server, which is why a variable is good enough here.
  const handedBack = Array.isArray(teammateMcpAllow)
    ? teammateMcpAllow.filter((name) => typeof name === 'string' && name !== '' && !name.includes(','))
    : [];
  if (handedBack.length) out.SOMA_TEAMMATE_MCP_ALLOW = handedBack.join(',');
  // soma.json's `lead_branch_push`, for `lead-gate.mjs` arm (d): `'1'` lets the lead push its own
  // branch, `git push -u origin soma/<id>`, and ABSENCE refuses it. Set only for exactly `true`, so
  // `false`, a missing key and a value that is not a boolean all keep "the lead never pushes", and
  // so does a lead spawned before this variable existed. Here, beside `SOMA_LEAD_NAME`, at the same
  // trust level as it and `SOMA_HOME`: an `export` in the lead's Bash does not reach the gate, but
  // on Claude Code 2.1.303 a settings file the lead writes with an `env` block does, and that route
  // can already forge those two (see `lead-gate.mjs`, `ownBranchPush`). A flag file under
  // `leads/<id>/` was tried first and was weaker: a subprocess could delete it.
  if (leadBranchPush === true) out.SOMA_LEAD_BRANCH_PUSH = '1';
  out.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
  out.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = '0';
  out.DISABLE_AUTOUPDATER = '1';
  // Unrecognised values fail TOWARD the pin, which is what `EFFORT_LEVELS` is for: `undefined`,
  // `null`, `''` and `'inherit'` are all simply not levels, so the four cases the old branch
  // spelled out by hand fall out of the one rule — and so does `'inheret'`.
  const inherit = !EFFORT_LEVELS.includes(teammateEffort);
  if (inherit) out.CLAUDE_CODE_EFFORT_LEVEL = leadEffortOf(leadEffort);
  return out;
}

/**
 * Every seat's config dir — the `roots` the worktree guard enumeration reads (account
 * rotation design §3.4: the secrets boundary widens by exactly this).
 *
 * A lead rotated onto seat B runs teammates that read seat B's `.claude.json`, so a server
 * registered only there reaches every worktree undenied unless the guard file was written
 * from every seat at once. One definition, exported, because doctor's `mcp deny drift` probe
 * must enumerate from the SAME list the spawner writes from — two lists would report drift
 * on every worktree the moment a seat has a server the ambient root lacks.
 *
 * The dirs come back absolute: `loadSeats` expands `~` through `seats.resolveConfigDir`, the
 * one place a tilde is expanded, so nothing here re-implements it. An absent `seats` key is
 * `config.DEFAULTS`' `[]`: a stubbed config under test and `resumeLead`'s `cfg ?? {}` both
 * reach here without one, and a fleet with no seats configured must keep writing today's
 * guard file rather than throw.
 */
export const seatRoots = (cfg) => loadSeats({ ...cfg, seats: cfg?.seats ?? [] }).map((seat) => seat.config_dir);

/**
 * The pool PLUS the seat this launch actually lands on — the `roots` one launch enumerates.
 *
 * `seatRoots(cfg)` is what soma.json SAYS the pool is; `configDir` is where the lead really
 * runs, and the two can disagree. `seatConfigDir` checks that a per-launch seat is absolute
 * and nothing else — never membership in `cfg.seats` — so a rotation onto a seat the config
 * no longer lists, or a pool edited between `pick()` and this launch's own `deps.loadConfig()`,
 * used to write a guard file that denied nothing from the dir the lead was about to read.
 * MEASURED on that shape: `personal denies written: []` while the lead launched under a seat
 * holding a server of its own, which every teammate in that worktree would then mount undenied.
 *
 * Unioned rather than refused: a deny list may safely be a superset, and refusing an unlisted
 * seat would fail a rotation CLOSED on a config race — killing a lead to protect a boundary a
 * union already holds. A `configDir` already in the pool dedupes here (and again inside
 * `configFiles`/`configDirs`, which are both `new Set`), and one whose dir holds no
 * `.claude.json` simply ENOENTs and contributes nothing. `undefined` — every caller that names
 * no seat, which today is all of them — leaves the list byte-identical to the pool.
 */
const launchRoots = (cfg, configDir) => (configDir === undefined
  ? seatRoots(cfg)
  : [...new Set([...seatRoots(cfg), configDir])]);

/** The real wiring. Frozen and shared: a fresh object per call would be rebuilt for nothing. */
const SPAWN_DEPS = Object.freeze({
  withRepoLock: worktree.withRepoLock,
  hasSession: tmux.hasSession,
  ensureWorktree: worktree.ensureWorktree,
  writeWorktreeGuardrails: sg.writeWorktreeGuardrails,
  enumerateUserMcpServers: sg.enumerateUserMcpServers,
  preTrust,
  writeLeadMcpConfig: sg.writeLeadMcpConfig,
  writeLeadSettings: sg.writeLeadSettings,
  writeStanding,
  newSession: tmux.newSession,
  setRemainOnExit: tmux.setRemainOnExit,
  uuid: randomUUID,
  loadConfig,
  env: process.env,
});

/** `resumeLead` never creates a worktree, so it is wired without the two that would. */
const RESUME_DEPS = Object.freeze({
  withRepoLock: worktree.withRepoLock,
  hasSession: tmux.hasSession,
  writeWorktreeGuardrails: sg.writeWorktreeGuardrails,
  enumerateUserMcpServers: sg.enumerateUserMcpServers,
  preTrust,
  writeLeadMcpConfig: sg.writeLeadMcpConfig,
  writeLeadSettings: sg.writeLeadSettings,
  writeStanding,
  newSession: tmux.newSession,
  setRemainOnExit: tmux.setRemainOnExit,
  loadConfig,
  env: process.env,
});

/**
 * Refuse a partial dep object instead of quietly completing it from the real wiring.
 *
 * The alternative — `{...defaults, ...deps}` — is worse here than anywhere else in this
 * repo: a test that stubs four deps and forgets `newSession` would start a real detached
 * `claude` in a real worktree, and one that forgets `ensureWorktree` would run `git
 * worktree add` against the operator's checkout. A missing dep is a wiring bug, and the
 * cheap loud version of it is a message naming what is absent.
 */
function checkDeps(deps, names, what) {
  const missing = names.filter((k) => typeof deps?.[k] !== 'function');
  if (missing.length) {
    throw new TypeError(`${what}: these dependencies are missing or are not functions: ${missing.join(', ')} — pass a complete dep set or none at all`);
  }
}

const SPAWN_REQUIRED = Object.freeze(Object.keys(SPAWN_DEPS).filter((k) => k !== 'env'));
const RESUME_REQUIRED = Object.freeze(Object.keys(RESUME_DEPS).filter((k) => k !== 'env'));

/**
 * The composed steps every launch shares, run with the repo lock already held.
 *
 * `cwd` is the lead's worktree in both callers, and that is the single most consequential
 * value in this file — see `spawnLead`.
 *
 * `configDir` is the seat for this launch, already checked by `seatConfigDir` (absolute, or
 * `undefined` for the spawner's own). It enters exactly one object here — the lead env — and reaches
 * the trust mark and the agreement check through that object, never as a second argument.
 */
function launch({ id, cwd, sessionUuid, resume, task, cfg, deps, configDir }) {
  // The guard file first, because it is the one settings source every teammate inherits
  // (it is found from cwd) and because it is re-read mid-session — measured: a command
  // denied, the guard emptied through one uncovered write idiom, the same command permitted
  // two tool calls later. Rewritten in full on every launch, so a server the operator added
  // yesterday is denied in a worktree reused today, and so a guard file a bypassed teammate
  // emptied with `tee` is whole again before the next session reads it.
  //
  // Enumerated from the SPAWNER's environment — the same `HOME || homedir()` idiom the
  // `preTrust` call below uses, and what the old no-argument call read implicitly — plus every
  // seat's config dir: a teammate under seat B reads seat B's `.claude.json`, so the deny list
  // has to be the union across seats or a new seat's personal servers reach every worktree
  // undenied. The spawner's env on purpose, not the lead's: this list is about which servers
  // exist on this machine's roots. `roots` is the pool AND this launch — the seat named for one
  // launch is only checked for being absolute, so it is not trusted to be in `cfg.seats`.
  const spawnerEnv = deps.env ?? process.env;
  deps.writeWorktreeGuardrails(cwd, {
    mcpDenies: deps.enumerateUserMcpServers(spawnerEnv.HOME || homedir(), spawnerEnv, { roots: launchRoots(cfg, configDir) }),
    teammateAllow: cfg.teammate_mcp_allow,
  });

  // The environment before the trust mark, because the mark's location is a function of the
  // environment the LEAD gets, not of ours. They differ silently: `env -i` means
  // CLAUDE_CONFIG_DIR reaches the lead only because ENV_ALLOW carries it — or because a seat was
  // named for this launch, which replaces the copied value here and nowhere else. This ONE object
  // then carries the seat into `preTrust` and `trustFileFor` below; that is what makes the three
  // agree by construction, and why neither of them takes the seat as a separate argument — a
  // second spelling would be a second place for them to disagree.
  const env = buildLeadEnv({ id, sessionUuid, teammateEffort: cfg.teammate_effort, teammateMcpAllow: cfg.teammate_mcp_allow, leadBranchPush: cfg.lead_branch_push, leadEffort: cfg.lead_effort, env: deps.env ?? process.env, configDir });

  // Immediately before this launch, never batched across launches: the file is
  // last-writer-wins against claude's own rewrites of it, so a mark made for an earlier
  // spawn may simply not be there any more. Throws on drift or corruption, and that is not
  // swallowed — an unmarked cwd is a detached session stopped on an unanswerable dialog.
  const marked = deps.preTrust(cwd, env.HOME || homedir(), env);
  const expected = trustFileFor(env);
  if (marked !== expected) {
    throw new Error(
      `spawnLead(${id}): preTrust marked trust in ${marked} but the lead will read ${expected}`
      + ' — the mark would be invisible to it and the session would stop on the trust dialog with nobody to answer',
    );
  }

  const mcpPath = deps.writeLeadMcpConfig(id);
  // The lead settings file is the BASE, not the thing `--settings` points at: the teammate
  // guard is composed onto it here, outside the worktree, because the only other registration
  // lives inside the file it defends. See `teammateGuardHook`.
  const settingsPath = writeLaunchSettings(resume ? 'resumeLead' : 'spawnLead', id, deps.writeLeadSettings(id));
  // The cwd travels with the facts: the standing brief states it so the lead can hand it to a
  // teammate as "your cwd is <path>" instead of `cd`-ing to it in every command (the cd-compound
  // fix — a `cd` in a compound was the shape Claude Code 2.1.259 stopped 79 sessions on).
  const standingPath = deps.writeStanding({ ...task, cwd });
  const argv = buildLeadArgv({ id, sessionUuid, brief: resume ? RESUME_BRIEF : task.brief, settingsPath, mcpPath, standingPath, resume, leadEffort: cfg.lead_effort });

  const name = target(id);
  // `logs/` is nobody else's job. pipe-pane's `cat >>` into a missing directory fails in the
  // shell while tmux itself still exits 0, so the lead would run with no transcript and
  // nothing would say so. Idempotent, and it self-heals a state root wiped mid-fleet.
  ensureTree();
  deps.newSession({ name, cwd, env, argv, logPath: logPath(id) });
  // Deliberately unchecked. It returns false rather than throwing, and the pane it preserves
  // is the death scene the watchdog *reads* — valuable, but losing it degrades diagnosis
  // rather than the lead. Failing a running lead's spawn over it would be the worse trade.
  deps.setRemainOnExit(name);
}

/**
 * Start a lead for `task`. Returns `{lead, session_uuid, tmux_target, cwd, base_sha}`.
 *
 * `base_sha` is the commit the lead's worktree was cut from, or null when that is not known (a
 * reused checkout with no record of its own cut: see `recordedBase`). It is also written to
 * `leads/<id>/meta.json` before the launch (see `writeMeta`), and the callers put it on the task
 * row, which `fleet.enqueue` creates with `base_sha: null`.
 *
 * Synchronous from end to end, because `withRepoLock` is: it releases on the synchronous
 * return, so an async body would run the rest of its "protected" work with the mutex gone —
 * and a synchronous waiter in this process blocks the event loop the promise needs to settle
 * on, which is a deadlock rather than a delay. `withRepoLock` refuses a thenable outright.
 * Callers may still `await` the plain object; `bus-tools` does.
 *
 * **The cwd is the lead's own worktree, and this is measured, not stylistic.** Teammates
 * inherit the cwd of whoever *spawned* them rather than the directory they are told to edit
 * — checked across 220 real transcripts. Launch a lead at the repo root and merely tell it
 * to work in a worktree, and all ten leads write their transcripts into one
 * `projects/<slug>/` directory; the token meter reads the whole fleet's spend as each
 * lead's and trips all ten breakers at once.
 *
 * **The live-session check is load-bearing, not defensive.** A `spawnLead` that throws after
 * partial success leaves `bus-tools` rolling the row back to `queued`, and another admitter
 * can then claim it — a reviewer saw exactly one `[cr-1 cr-2 cr-2]` double-spawn and proved
 * the fleet lock was not the cause. A second `spawnLead` for one id is reachable by design.
 * Note the interaction with `remain-on-exit`: a *dead* lead's session survives on purpose,
 * so this refuses a revival too, and a revival path must kill the session first.
 *
 * **`opts.configDir` names the seat for this launch** (account rotation, spec §3.3): the config dir
 * whose `.claude.json` is marked, whose `CLAUDE_CONFIG_DIR` the lead runs under, and whose file the
 * agreement check expects — one value, three places. Omitted, the frozen `SPAWN_DEPS.env` decides,
 * exactly as before seats existed; `seatConfigDir` and `launchOpts` say what is refused and why. The
 * options object is the LAST parameter so every existing `spawnLead(task)` / `spawnLead(task, deps)`
 * call is unchanged; a caller with real deps passes `spawnLead(task, undefined, { configDir })`.
 */
export function spawnLead(task, deps = SPAWN_DEPS, opts) {
  checkDeps(deps, SPAWN_REQUIRED, 'spawnLead');
  const id = leadId(task?.id, 'spawnLead');
  const repo = repoKey(task?.repo, `spawnLead(${id})`);
  // Before the lock and before the live-session check, like every other refusal: a seat that
  // cannot be right creates nothing.
  const configDir = seatConfigDir(launchOpts(opts, `spawnLead(${id})`).configDir, `spawnLead(${id})`);
  const name = target(id);

  const cfg = deps.loadConfig();
  const repoCfg = cfg?.repos?.[repo];
  if (!repoCfg || typeof repoCfg.path !== 'string' || repoCfg.path === '') {
    throw new Error(`spawnLead(${id}): repo ${JSON.stringify(repo)} is not configured in soma.json (repos.${repo}.path); nothing was created`);
  }
  const base = task.base_branch || repoCfg.base_branch || 'develop';

  // Before the lock, so a refusal costs nothing and creates nothing.
  if (deps.hasSession(name)) throw refuseLive('spawnLead', id, name);

  return deps.withRepoLock(repo, () => {
    // Again, now that we are ordered against every other spawner on this repo. The window
    // between the two checks is real and this is where it closes with a message; without it
    // the race surfaces as tmux's bare "duplicate session".
    if (deps.hasSession(name)) throw refuseLive('spawnLead', id, name);

    const wt = deps.ensureWorktree({ repo, taskId: id, base, repoPath: repoCfg.path });
    if (typeof wt?.dir !== 'string' || !isAbsolute(wt.dir)) {
      throw new Error(`spawnLead(${id}): ensureWorktree returned no absolute worktree directory (${JSON.stringify(wt?.dir)}) — the lead's cwd is what pins its token meter to its own transcript directory, so there is nothing safe to launch`);
    }

    const sessionUuid = deps.uuid();
    // The commit this checkout was cut from. On a fresh cut that is the tip `ensureWorktree` just
    // fetched. A reused checkout was cut by an earlier attempt, and the tip reported now is only
    // where the remote has got to since, so the base is what that attempt recorded: meta.json's
    // for this same branch when there is a meta.json to read, the row's only when there is none,
    // else unknown (see `recordedBase`). Never the tip: a wrong base is worse than an absent one.
    const baseSha = wt.reused === true
      ? recordedBase(id, wt.branch, task.base_sha)
      : (nonEmpty(wt.base_sha) ? wt.base_sha : null);
    writeMeta(id, {
      id,
      repo,
      base_branch: base,
      base_sha: baseSha,
      branch: nonEmpty(wt.branch) ? wt.branch : null,
      worktree: wt.dir,
      reused: wt.reused === true,
      session_uuid: sessionUuid,
      tmux_target: name,
      spawned_at: new Date().toISOString(),
    });
    launch({
      id,
      cwd: wt.dir,
      sessionUuid,
      resume: false,
      // The resolved base, not the possibly-absent field: the standing brief tells the lead
      // what its worktree was cut from, and `(unknown)` there is a lead guessing.
      task: { ...task, base_branch: base },
      cfg,
      deps,
      configDir,
    });
    return { lead: id, session_uuid: sessionUuid, tmux_target: name, cwd: wt.dir, base_sha: baseSha };
  });
}

/**
 * Restart a lead on its recorded session. Returns `{lead, session_uuid}`: no `base_sha`, and
 * `leads/<id>/meta.json` is left alone, because a resume cuts nothing and the record is the spawn's.
 *
 * Deliberately does **not** call `ensureWorktree`: the worktree is the one holding the work
 * being resumed, and a reuse judged unclean would be removed and re-cut on a fresh branch,
 * losing it. The cwd is therefore computed from `paths.worktreeDir`, which is why that path
 * keeps the raw repo key while only the *lock* is slugged, and why a retry suffix lives on
 * the branch rather than the directory.
 *
 * It does call `preTrust` and rewrite the guard file, which was not originally planned.
 * Both are per-launch facts rather than per-worktree ones: the trust mark is last-writer-wins
 * against claude's own rewrites, and the guard file is re-read mid-session and can have been
 * emptied by a teammate since the first spawn. A resume is a spawn.
 *
 * The recorded uuid is required rather than defaulted. Minting a fresh one would not be a
 * resume at all — it would be a second lead on the same task, under the same tmux name,
 * with the first lead's spend unaccounted for.
 *
 * **`opts.configDir` is how a lead changes seat.** The watchdog's `rotate()` kills the session and
 * calls `resumeLead(row, undefined, { configDir: <open seat> })` through its dep wrapper: same
 * session uuid, same worktree, same transcript in the shared `projects/` tree — under a different
 * `CLAUDE_CONFIG_DIR`, with the trust mark re-made in THAT seat's `.claude.json`. Its revert path is
 * the same call with the original seat (`configDir: undefined` for a lead spawned before seats
 * existed). Omitted, the resume lands where the lead was spawned, as it always has.
 */
export function resumeLead(task, deps = RESUME_DEPS, opts) {
  checkDeps(deps, RESUME_REQUIRED, 'resumeLead');
  const id = leadId(task?.id, 'resumeLead');
  const repo = repoKey(task?.repo, `resumeLead(${id})`);
  const configDir = seatConfigDir(launchOpts(opts, `resumeLead(${id})`).configDir, `resumeLead(${id})`);
  const name = target(id);
  const sessionUuid = task?.lead_session_uuid;
  if (typeof sessionUuid !== 'string' || sessionUuid === '') {
    throw new Error(`resumeLead(${id}): the task row has no recorded lead_session_uuid, so there is no session to resume; re-spawn it from its brief instead`);
  }
  if (deps.hasSession(name)) throw refuseLive('resumeLead', id, name);

  const cfg = deps.loadConfig();
  return deps.withRepoLock(repo, () => {
    if (deps.hasSession(name)) throw refuseLive('resumeLead', id, name);
    launch({
      id,
      cwd: worktreeDir(repo, id),
      sessionUuid,
      resume: true,
      task: { ...task, resume: true },
      cfg: cfg ?? {},
      deps,
      configDir,
    });
    return { lead: id, session_uuid: sessionUuid };
  });
}
