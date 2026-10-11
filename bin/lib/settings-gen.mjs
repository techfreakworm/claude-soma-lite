/**
 * Generated settings — the three files that turn the operator's standing rules
 * into mechanics instead of goodwill.
 *
 * The spawner is the only path into a lead, so it is the only place these rules
 * can be attached, and it attaches them as *files* rather than argv because argv
 * binds one process while a file binds everything that reads it from disk:
 *
 *   leads/<id>/mcp.json            the lead's entire MCP surface: soma and the stateless
 *                                  sequential-thinking server, nothing else.
 *   leads/<id>/settings.json       the base of the lead's `--settings`: model pin and three
 *                                  hooks, and DELIBERATELY NO `permissions` BLOCK.
 *                                  NOT the file `--settings` points at — `spawn`'s
 *                                  `writeLaunchSettings` composes this plus the teammate
 *                                  guard into `leads/<id>/settings.launch.json`, and that
 *                                  is the flag's value. **AND IT PROPAGATES — SEE BELOW.**
 *   <worktree>/.claude/settings.local.json
 *                                  the guardrails every *teammate* inherits from cwd.
 *
 * ⚠ **THE `--settings` FILE IS NOT SCOPED TO THE LEAD PROCESS.** A teammate is launched
 * with `--settings <the parent's own value>`, so **everything in this file binds every
 * teammate in the fleet too.** Measured live against claude 2.1.220: a real split-pane
 * teammate's own argv read
 *
 *     … --agent-id fixedteam@session-0000aaaa --agent-name fixedteam --team-name … \
 *       --agent-type general-purpose --dangerously-skip-permissions \
 *       --settings /private/tmp/…/fixed-settings.json --model claude-opus-5
 *
 * — `--settings` present and carrying the parent's exact path; `--disallowedTools`,
 * `--mcp-config`, `--strict-mcp-config` and `--setting-sources` all absent, although the
 * parent carried every one of them. So the rule for this file is the opposite of intuition:
 * **argv is what binds one process, and a `--settings` file is what binds the whole fleet.**
 * Anything here that must NOT reach a teammate belongs on the lead's argv instead. See the
 * no-permissions-block bullet below for the live defect this caused, and its fix.
 *
 * Four properties here are load-bearing, in descending order of what breaks:
 *
 * - **The worktree deny list is the secrets boundary.** Teammates are fresh
 *   `claude` processes: they load settings and MCP servers from disk, so none of
 *   the lead's argv pins reach them (`--settings` is a file, not a pin, and is the
 *   one exception — see the warning above) and the operator's personal MCP fleet does.
 *   On the machine this was written for that fleet includes brokerage-order and
 *   database-write servers, and — through claude.ai account connectors — an
 *   authenticated Slack, Microsoft 365 (send mail, SharePoint writes) and Google
 *   Drive. The teammates are unattended and permission-bypassed. Two mechanisms
 *   hold the line, because one cannot: a bare `mcp__<server>` deny per server
 *   *discoverable on disk* (minus `teammate_mcp_allow` from soma.json), and two
 *   prefix denies for the servers that are **not on disk at all** — account
 *   connectors and plugin servers. See `enumerateUserMcpServers` for what each
 *   source can and cannot see, and STANDING_DENIES for the prefix rules.
 *
 * - **The lead's MCP config holds exactly two servers, `soma` and the stateless
 *   `sequential-thinking`.** The guard is that neither reaches an orchestrator bus,
 *   because a lead that reaches one can spawn leads, which can spawn leads. So a third
 *   server is a recursion-guard decision, not a convenience (`writeLeadMcpConfig` says
 *   what bar the second one cleared). `soma doctor` asserts that exact set (`lead mcp
 *   single-server`), and `--strict-mcp-config` (spawner) is what stops user scope from
 *   adding another behind our back.
 *
 * - **NO `permissions` BLOCK IN THE LEAD FILE — that absence is load-bearing, and putting
 *   one back is the build's worst regression.** `writeLeadSettings` used to write
 *   `permissions.deny: ['Edit','Write','NotebookEdit']` here to give the LEAD its no-code
 *   property, on the premise that the file was "scoped to the lead process". The premise was
 *   false — see the warning above — so those three bare names travelled down `--settings`
 *   into every split-pane teammate. Live, such a teammate reported *"Write, Edit, and
 *   NotebookEdit are all absent from this teammate's toolset."* A soma teammate exists to
 *   write code, so **a fleet wired that way produced none** — and it presented as a model
 *   limitation rather than a settings bug, which is why it survived four reviews. It also
 *   negated the canary invariant `canary.INVARIANT_MEANING.teammateCanEdit` — "a lead's
 *   teammates can write code" — and the canary driver does not exist on this build, so
 *   nothing caught it.
 *
 *   **The deny is gone and the lead's ban is unchanged**, because the ban never needed this
 *   file. Measured, three ways, against claude 2.1.220 with the deny removed and only
 *   `--disallowedTools Edit,Write,NotebookEdit` left on the lead's argv:
 *     · the session's `init` tool list contains none of the three — byte-for-byte the same
 *       27-tool list the deny produced, so argv removes them from context exactly as the
 *       bare-name form did; it does not merely refuse them at call time;
 *     · the lead, asked to write a file, answered *"No such tool available: Write. Write
 *       exists but is not enabled in this context."* — the same sentence the broken teammate
 *       produced, now from the right process;
 *     · the lead's in-process `Task` subagents got that identical error too, so argv holds
 *       the whole stated boundary — "the lead session INCLUDING its workflow agents,
 *       EXCLUDING its teammates" — with no help from the settings file.
 *   In the same live session, with the deny gone, the lead's teammate wrote its file.
 *   The gate hook (`hooks/lead-gate.mjs`) carried a second, session-discriminated Edit arm
 *   as an independent carrier of the same ban — retired, with the lead's edit surface
 *   lifted to match a teammate's.
 *
 *   **What now notices if someone puts it back.** `soma doctor`'s `no edit ban in settings
 *   files` check asserts that neither this file nor the worktree guard file carries any of
 *   the three bare names, and its companion `lead edit ban on argv` asserts that
 *   `spawn.buildLeadArgv()` emits NO `--disallowedTools` naming any of them — the ban is
 *   lifted, and re-imposing it is the regression doctor now guards. That pair
 *   replaced an older doctor check, which asserted the opposite of the first. `soma doctor`
 *   cannot see a running lead's tool list and does not claim to — it reads the generator.
 *
 * - **Every file is published tmp+rename**, the house idiom (`fleet.writeFleet`,
 *   `events.writeCursor`). A lead reads its settings while the watchdog may be
 *   rewriting them for a revival, and `soma doctor` reads a worktree's guard file
 *   while a respawn rewrites it; a half-written guard file is a worktree with no
 *   guardrails at all.
 *
 * Paths written into these files are absolute and forward-slashed. They are
 * consumed by `claude` and by `/bin/sh`, not by `path.join`, and a cwd-relative
 * path in a config read by a process started somewhere else resolves somewhere
 * else. Never `npx`: the bus is a file on this disk.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { SOMA_HOME, leadDir, p } from './paths.mjs';
import { loadConfig } from './config.mjs';
import { socketName } from './tmux.mjs';

/**
 * The installed `bin/` directory — this file's parent's parent.
 *
 * `fileURLToPath`, not `new URL(...).pathname`: the latter hands back a
 * percent-encoded path, so an install under `~/My Repos/` yields `My%20Repos`
 * and every generated hook command points at a directory that does not exist.
 */
const BIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** Absolute, forward-slashed — see the header note on who reads these strings. */
const fwd = (fp) => resolve(fp).replaceAll('\\', '/');

/** A path inside the install, in the form the generated files want. */
const binPath = (...segments) => fwd(join(BIN_DIR, ...segments));

/**
 * Quote one word for the `/bin/sh` that runs a hook command.
 *
 * Same idiom and same reason as `tmux.shQuote`: single quotes so nothing in a
 * path is expanded, and an embedded quote closed-escaped-reopened the POSIX way.
 * A SOMA_HOME containing a space turns an unquoted `touch` into two arguments and
 * the heartbeat lands in the wrong file — silently, since the hook still exits 0
 * and the only symptom is a lead the watchdog reads as stalled.
 */
const shq = (word) => `'${String(word).replaceAll("'", "'\\''")}'`;

/** A value with own keys worth walking. Arrays and null are not. */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The Claude Code config root.
 *
 * TEMPORARY DUPLICATE of `paths.claudeConfigRoot(env)` (on another branch when this was
 * written); kept local so this module does not import across an unmerged branch, and to be
 * deleted by a planned consolidation onto `paths`. Two copies exist on purpose — this one and
 * pretrust's — and that consolidation covers both. Same shape as the canonical one down to
 * the `resolve()`, plus a leading `home` because *this* module's callers point the
 * enumeration at a sandbox home; the canonical takes `homedir()` on trust, so the
 * consolidation is a `join(home, …)` → `homedir()` decision, not a rewrite.
 *
 * `env` is a **parameter**, not a read of the global `process.env`. That is not
 * cosmetic: with the global baked in, `enumerateUserMcpServers('/tmp/fake-home')`
 * still resolved the operator's real `CLAUDE_CONFIG_DIR` and read the operator's
 * real servers, so the `home` argument did not determine the result and any caller
 * with a sandbox home got a silently wrong answer.
 * The test suite papered over it with a module-scope `delete process.env.CLAUDE_CONFIG_DIR`.
 *
 * `||`, not `??`, for the same load-bearing reason as `paths.SOMA_HOME`: an
 * empty-string env value has to fall back to the default root rather than resolve
 * every path against `''`.
 */
const claudeConfigRoot = (home, env = process.env) => resolve(env.CLAUDE_CONFIG_DIR || join(home, '.claude'));

/**
 * Every `.claude.json` that could be the live one, deduped.
 *
 * Two entries because the file's location is not one shape: by default it sits at
 * `$HOME/.claude.json`, *beside* the config dir, but under `CLAUDE_CONFIG_DIR` it
 * sits *inside* it (`$CLAUDE_CONFIG_DIR/.claude.json` — measured). With the env
 * unset the second candidate is `$HOME/.claude/.claude.json`, which simply does not
 * exist and costs one ENOENT.
 *
 * Plus one per seat root (account rotation): a seat is a config dir with its own
 * `.claude.json` INSIDE it — the `CLAUDE_CONFIG_DIR` shape, because that is how a seat is
 * logged in — and a teammate launched under it mounts that file's servers. Deduped, since
 * the operator's own config dir is usually seat-a as well.
 */
const configFiles = (home, env, roots = []) => [...new Set([
  join(home, '.claude.json'),
  join(claudeConfigRoot(home, env), '.claude.json'),
  ...roots.map((dir) => join(dir, '.claude.json')),
])];

/** Every config dir that could be the live one — `settings.json` and `plugins/` live inside. A seat root is one too. */
const configDirs = (home, env, roots = []) => [...new Set([claudeConfigRoot(home, env), resolve(join(home, '.claude')), ...roots])];

/**
 * Publish `body` at `fp` atomically, creating the parent dir if it is missing.
 *
 * `writeFleet`'s shape, down to the pid in the scratch name: readers see the old
 * file or the new one, two writers cannot share a tmp file, and a state root that
 * was never `ensureTree()`d costs one mkdir rather than an exception.
 */
function publish(fp, body) {
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

const publishJson = (fp, value) => publish(fp, JSON.stringify(value, null, 2) + '\n');

/**
 * Every enabled plugin's MCP servers, under the names Claude Code gives them.
 *
 * A plugin declares servers in `<installPath>/.mcp.json` and they surface as
 * `plugin:<plugin>:<server>` — which becomes `mcp__plugin_<plugin>_<server>` in a
 * tool name (measured: the vercel plugin declares `vercel`, and the tool is
 * `mcp__plugin_vercel_vercel__authenticate`). Two files inside `configDir` are
 * needed because neither one is enough: `settings.json`'s `enabledPlugins` says
 * *which* plugins are on, and `plugins/installed_plugins.json` says *where* each one
 * is — and the install path is not derivable, since one plugin on this machine
 * lives under `~/.claude-work/plugins/cache/…` rather than `~/.claude/plugins/…`.
 *
 * Belt, not the fence: `mcp__plugin_*` in STANDING_DENIES is what actually shuts
 * these out, including plugins enabled at project scope, which this cannot see.
 * The exact names exist so `soma doctor` can assert a specific deny per server
 * rather than trusting a wildcard nobody re-reads. Everything here is best-effort:
 * a missing or malformed plugin file yields fewer *belt* entries, never a failed
 * spawn, because the wildcard is already holding the line.
 */
function enumeratePluginMcpServers(configDir) {
  const names = new Set();
  const readJson = (fp) => {
    try {
      const parsed = JSON.parse(readFileSync(fp, 'utf8'));
      return isObject(parsed) ? parsed : null;
    } catch {
      return null;                           // absent, unreadable, or not an object
    }
  };
  const settings = readJson(join(configDir, 'settings.json'));
  const installed = readJson(join(configDir, 'plugins', 'installed_plugins.json'));
  if (!settings || !installed || !isObject(settings.enabledPlugins) || !isObject(installed.plugins)) return [];
  for (const key of Object.keys(settings.enabledPlugins)) {
    if (!settings.enabledPlugins[key] || key === '__proto__') continue;
    const plugin = key.split('@')[0];        // "vercel@claude-plugins-official" -> "vercel"
    if (!plugin) continue;
    for (const record of [].concat(installed.plugins[key] ?? [])) {
      if (!isObject(record) || typeof record.installPath !== 'string') continue;
      const declared = readJson(join(record.installPath, '.mcp.json'));
      if (!declared || !isObject(declared.mcpServers)) continue;
      for (const server of Object.keys(declared.mcpServers)) {
        if (server && server !== '__proto__') names.add(`plugin_${plugin}_${server}`);
      }
    }
  }
  return [...names];
}

/**
 * `roots` as resolved absolute dirs, or a refusal naming the bad element.
 *
 * Refused rather than skipped, because both skips fail open on the secrets boundary: a
 * non-array is a caller handing the wrong thing (a string would iterate as characters), and
 * an empty or non-string element would `resolve('')` to the process cwd and read *its*
 * `.claude.json` — a plausible-looking answer about the wrong directory. `seats.mjs`
 * refuses `''` as a seat's `config_dir` for the same reason; this is the belt at the consumer.
 */
function resolvedRoots(roots) {
  if (!Array.isArray(roots)) {
    throw new TypeError(`enumerateUserMcpServers: roots must be an array of config dirs, got ${roots === null ? 'null' : typeof roots}`);
  }
  return roots.map((dir, i) => {
    if (typeof dir !== 'string' || dir === '') {
      throw new TypeError(`enumerateUserMcpServers: roots[${i}] must be a non-empty config dir path, got ${JSON.stringify(dir)}`);
    }
    return resolve(dir);
  });
}

/**
 * Every MCP server name this machine can hand a fresh `claude` process *and* that
 * is discoverable on disk.
 *
 * Three sources, and each one was added because the previous list missed servers
 * that a teammate could actually reach:
 *
 *   user scope   `.claude.json` `mcpServers` at the top level — every session.
 *   local scope  `.claude.json` `projects[<dir>].mcpServers` — the operator's
 *                private per-project servers, which is where `claude mcp add` puts
 *                a server by default. Measured on the machine this was built for:
 *                the top level held two innocuous servers while the
 *                brokerage-order and database-write servers the design review
 *                named — the entire reason the deny list exists — were *all* here.
 *                A top-level-only read misses exactly what it was written for, and
 *                misses it silently, because the file it produces looks correct.
 *   plugins      enabled plugins' own `.mcp.json` (see above).
 *
 * ...times **every config root**, which is the third way this list was found to be
 * short. `CLAUDE_CONFIG_DIR` moves all three files, and it is set on the machine
 * this was built for: `~/.claude-work/.claude.json` is the live file while
 * `~/.claude.json` still exists and still parses, so reading only the latter
 * produces a deny list from a file Claude Code is not using — a plausible-looking
 * guard built on stale data, the same failure shape as the top-level-only read
 * above. Both roots are therefore read and **unioned**, deliberately:
 *
 *   - The root a *teammate* will read is not decided here. It depends on whether
 *     `CLAUDE_CONFIG_DIR` survives the spawner's `env -i` allowlist (`spawn.mjs`'s
 *     ENV_ALLOW), so a union is the only answer that is correct either way.
 *   - An operator who switches roots between sessions has real servers in both.
 *   - A deny for a server that is not currently configured costs exactly nothing:
 *     denies are cheap, and a superset is the safe direction. Whereas a miss is the
 *     brokerage-order server in an unattended session.
 *
 * (Observed while measuring: the two roots are distinct directories with
 * independently changing contents — `.claude-work/settings.json` changed size
 * between two reads seconds apart. Today the two `.claude.json` files happen to
 * hold the same 22 servers, so the *currently observable* miss is zero; the defect
 * is the mechanism, not a gap that can be measured only when it has already bitten.)
 *
 * **What is deliberately NOT here, because it is not on disk at all:** claude.ai
 * account connectors. `claude mcp list` shows sixteen of them on this machine
 * (`claude.ai Slack`, `claude.ai Microsoft 365`, `claude.ai Google Drive` — all
 * three *already authenticated*, i.e. usable with no prompt), and `~/.claude.json`
 * contains no trace of any of them: they come from the account, not the filesystem,
 * and the only related key is the boolean `claudeAiMcpEverConnected`. No
 * enumeration can find them, so they are denied by *prefix* —
 * `mcp__claude_ai_*` in STANDING_DENIES — not by name. Same reasoning covers
 * plugin servers enabled at project scope.
 *
 * Also not covered: project scope, i.e. a repo's committed `.mcp.json`. That one is
 * out of this signature's reach (it lives beside the worktree, not under `home`)
 * and is a different trust class — declared in git by the repo the teammates work
 * in, not by the operator's private setup.
 *
 * All three inputs are parameters — `home`, `env` and `roots` — and none is read from the
 * globals behind the caller's back, so `enumerateUserMcpServers(sandbox)` is an
 * answer about `sandbox` and not about whoever is running the process. See
 * `claudeConfigRoot` for the bug that made that worth spelling out.
 *
 * **`roots` — the seats (account rotation, design §3.4).** A fleet that rotates leads across
 * several Claude Code accounts has one config dir per seat, each with its own `.claude.json`,
 * and a teammate launched under seat B mounts seat B's servers. The fixed pair reads only the
 * spawner's two roots, so a server registered only in seat B's file would reach every
 * worktree undenied — the one place the design widens the secrets boundary. `roots` is every
 * seat's config dir: `spawn.launch` passes `seatRoots(cfg)` (the dirs `loadSeats(cfg)`
 * resolves) and doctor's drift probe passes the same list. Each root contributes its
 * `.claude.json` at both scopes and its plugin dirs exactly as the fixed pair does, unioned
 * and deduped with it. A root must be a non-empty path — `resolve('')` is the process cwd, a
 * plausible answer about the wrong directory — and a bad one is refused by index, never
 * skipped (see `resolvedRoots`). The `soma` delete below runs after every root has
 * contributed, and here that is load-bearing rather than tidy: `soma init --seat <dir>`
 * registers the bus in EVERY seat's file, so a root read after the delete would re-introduce
 * the self-deny that broke the first fleet.
 *
 * Throws rather than returning `[]` when a `.claude.json` in *any* root is
 * unreadable or malformed, and names the file it choked on — which is the resolved
 * path, so the message says which root is broken. "No personal MCP servers" is the
 * fail-open answer here, and it fails open into the one hole this module exists to
 * close; `config.readOverlay` sets the same precedent for the same reason. A
 * *missing* file is different — a machine that has never run Claude Code, or the
 * unused one of two roots, genuinely has nothing to contribute.
 */
export function enumerateUserMcpServers(home = homedir(), env = process.env, opts = {}) {
  // The container before its contents, because `{ roots = [] } = {}` defaults only
  // `undefined`: `null` died with a raw `Cannot read properties of null (reading 'roots')`,
  // and — the one that mattered — an ARRAY destructured to `roots === undefined`, defaulted
  // to `[]`, and answered about no seats at all while the caller believed it had just handed
  // every seat in. That is this module's fail-open shape, in the argument list.
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
    throw new TypeError(
      'enumerateUserMcpServers: the third argument must be an options object like { roots: [...] }'
      + ` or omitted, got ${opts === null ? 'null' : Array.isArray(opts) ? 'an array — the roots go in { roots: [...] }' : typeof opts}`,
    );
  }
  const { roots = [] } = opts;
  const seats = resolvedRoots(roots);              // refused before a single file is read
  const names = new Set();
  // Plugins first, and deliberately not nested inside the file reads below: a root
  // can have enabled plugins and no `.claude.json` at all, and an early return
  // there would drop this whole source on the floor (it did, until a test said so).
  for (const dir of configDirs(home, env, seats)) for (const name of enumeratePluginMcpServers(dir)) names.add(name);
  // `Object.keys` after `JSON.parse` keeps a literal `__proto__` key as an own
  // property (see config.keysOf). Nothing here assigns it — names only ever reach
  // a Set and a template string — but a server cannot be called that, so drop it.
  const add = (servers) => {
    if (!isObject(servers)) return;
    for (const name of Object.keys(servers)) if (name && name !== '__proto__') names.add(name);
  };
  /**
   * **`soma` is never denied here, and leaving it in broke the whole fleet.**
   *
   * MEASURED on the first real fleet: every lead reported
   * `No such tool available: mcp__soma__soma_task`, so no lead could report, checkpoint or
   * re-orient. The bus was healthy — a direct `tools/list` under a lead's exact env returned
   * all three lead tools. The cause was this function: `soma init` registers the bus at user
   * scope so any session can be promoted, this list enumerates everything at user scope, and
   * so it emitted `mcp__soma` — **soma denying its own bus.** The worktree's guard file is
   * loaded by the lead, not only by its teammates.
   *
   * Neither half was wrong alone. `init` must register at user scope or nothing can be
   * promoted; this list must read user scope or it misses the servers it exists to deny.
   * Nobody had connected them.
   *
   * **The teammate exposure is real and is handled where it can be:** a teammate does not
   * inherit `--mcp-config`, falls back to discovery, and mounts the user-scope bus as a
   * CANDIDATE — `soma_adopt` and `soma_status`. It could take the orchestrator lease. A static
   * deny cannot express "the lead may, a teammate may not", because they share one cwd and
   * therefore one settings file. `bin/hooks/lead-gate.mjs` arm (b2) does express it, using the
   * session id — the same discriminator, and the same reasoning, as the Bash arm.
   *
   * So do not "tidy" this back in. A green suite would not tell you: the tests that would
   * redden are the gate's, not this file's.
   *
   * Applied after every source has been read, not beside `add`: plugins are collected before
   * the file loop, so a delete placed at the definition would run before two of the three
   * sources had contributed anything.
   */
  for (const fp of configFiles(home, env, seats)) {
    let raw;
    try {
      raw = readFileSync(fp, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') continue;             // this root is simply not the one in use
      throw e;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new SyntaxError(`${fp} is not valid JSON: ${e.message}`, { cause: e });
    }
    if (!isObject(parsed)) {
      throw new Error(`${fp} must contain a JSON object, got ${Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed}`);
    }
    add(parsed.mcpServers);
    if (isObject(parsed.projects)) for (const project of Object.values(parsed.projects)) if (isObject(project)) add(project.mcpServers);
  }
  // See the long note beside `add`: soma's own bus must not appear here. Deleted after every
  // source has contributed, because plugins are collected before the file loop above.
  names.delete('soma');
  return [...names];
}

/**
 * Write `leads/<id>/mcp.json` — the lead's whole MCP surface — and return its path.
 *
 * `soma`, run as `node <abs>/bin/soma-bus.mjs` with the role and lead
 * name in its environment: the bus reads `SOMA_ROLE` to decide which tool set to
 * expose (`leadTools`, not `orchTools`), and `SOMA_LEAD_NAME` to attribute every
 * event it appends. `SOMA_HOME` is passed explicitly because the lead is started
 * `env -i` and must not fall back to `$HOME/.soma` when the fleet lives elsewhere.
 * `SOMA_TMUX_SOCKET` likewise must not fall back to `soma`: a bus on the wrong server types
 * its wakes into whatever pane holds the orchestrator's pane id there, which in the field was
 * another fleet's orchestrator (issue #1). Both values are the ones the spawner itself uses
 * (`paths.SOMA_HOME()`, `tmux.socketName()`), the same two `spawn.buildLeadEnv` injects, so
 * the lead's env and this file cannot name two roots or two servers.
 *
 * `sequential-thinking` is the second and only other server. It is here because
 * `buildLeadArgv` passes `--strict-mcp-config`, so this file is the lead's ENTIRE MCP
 * surface: a server the operator has configured at user scope is invisible to a lead
 * unless it is named here. Added 2026-09-01 at the operator's instruction, for leads whose
 * work is reasoning rather than editing — the meeting-notes author is the standing case.
 *
 * Two properties made it safe to add where a credentialled server would not be:
 * it is stateless and read-only (a scratchpad for the model's own reasoning; it touches no
 * repo, network or account), and it carries NO secret — the whole definition is `npx -y` on
 * a public package, so it leaks nothing into `leads/<id>/mcp.json`, which is world-readable
 * state rather than a secret store. Do not extend this pattern to any server that needs a
 * token or key: those belong in the lead's env allow-list in `spawn.mjs`, not in this file.
 *
 * Cost note: `npx -y` resolves the package on every lead start. It is cached after the first
 * fetch, but a lead spawned on a cold cache with no network pays a startup delay here.
 */
export function writeLeadMcpConfig(id, busPath = join(BIN_DIR, 'soma-bus.mjs')) {
  return publishJson(join(leadDir(id), 'mcp.json'), {
    mcpServers: {
      soma: {
        command: 'node',
        args: [fwd(busPath)],
        env: { SOMA_ROLE: 'lead', SOMA_LEAD_NAME: id, SOMA_HOME: SOMA_HOME(), SOMA_TMUX_SOCKET: socketName() },
      },
      'sequential-thinking': {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      },
    },
  });
}

/**
 * Write `leads/<id>/settings.json` — the BASE of the lead's `--settings` — and return its
 * path. `spawn.writeLaunchSettings` reads it back and composes `settings.launch.json`, and
 * that composed file is what `--settings` actually points at.
 *
 * ⚠ **THIS FILE IS NOT SCOPED TO THE LEAD PROCESS.** The sentence that used to stand here —
 * *"Scoped to the lead process on purpose: `--settings` does not propagate to teammates,
 * who load settings from cwd"* — was **false, and it was the premise the build's Critical
 * rode on.** Teammates do load the worktree's settings from cwd, but they are *also* launched
 * with `--settings <the parent's own value>`: measured twice in the claude 2.1.220 binary and
 * confirmed live from a real split-pane teammate's own argv. So anything this file says binds
 * **every session in the fleet**, not "the lead session including its workflow agents,
 * excluding its teammates" (spec § 9).
 *
 * **Which is why there is no `permissions` key below, and why adding one is not a small
 * change.** A `permissions.deny` here of `['Edit','Write','NotebookEdit']` — the shape this
 * function shipped with for most of the build — took all three write tools off **every
 * teammate**, which is the one thing a teammate exists to do. The lead's ban then rode
 * `--disallowedTools` on its argv plus the gate hook's session-discriminated arm; both were
 * measured to hold the whole boundary with this file carrying nothing, and both have since
 * been LIFTED — a lead's edit surface now matches a teammate's, and nothing anywhere may
 * carry a bare edit deny. The module header has the measurements. `soma doctor`'s
 * `no edit ban in settings files` check is what notices if the key comes back.
 *
 * The three hooks:
 *
 *   PostToolUse  the heartbeat. `touch` on `heartbeats/<id>` is what the watchdog's
 *                stall detector reads, so it runs on every tool call and must not
 *                be able to fail: the `mkdir -p` in front self-heals a state root
 *                wiped from under a running fleet, which would otherwise leave the
 *                lead permanently "stalled" while it worked perfectly.
 *   Stop         `lead-stop.mjs` — a heartbeat stamp, and NOTHING ELSE. It is neither the
 *                turn-end event nor the HARNESS gate, and this line used to claim both.
 *                See below.
 *   PreToolUse   `lead-gate.mjs` on EVERY tool — the write-idiom and BUDGET_TRIPPED gate.
 *
 * **WHAT THE `Stop` LINE USED TO SAY, AND WHY THE CORRECTION IS HERE RATHER THAN ONLY IN THE
 * HOOK.** It read *"turn-end event, and the HARNESS gate"*, and both halves are false against
 * the shipped `lead-stop.mjs`:
 *
 *   - **No event.** The hook stamps `heartbeats/<lead>` and appends nothing. That is
 *     deliberate and argued at its own site from the one-writer-per-stream rule — a second
 *     writer on `events/<lead>.ndjson` mints colliding ids and a consumer silently skips one.
 *   - **No gate.** Spec §8's "exit 2, at most 3 blocks" is not implemented; the hook's own
 *     header states *"Never exits non-zero"*, because exit 2 on `Stop` blocks the lead from
 *     finishing its turn and feeds stderr back to it, which is a loop a stuck lead cannot
 *     leave. So the promise "no lead reaches its second turn without a declared plan" is NOT
 *     delivered by anything.
 *
 * The safety consequence is contained, and containment is not the gate: a lead that never
 * declares a harness is priced at H1's class (`standard`) by rule 3 of `budgetClassOf`
 * (`soma-watchdog.mjs`), with no event, so no lead runs breakerless. The silence is deliberate:
 * every lead spends its first minutes undeclared, and an event on every spawn would be an alarm
 * nobody keeps unmuted. `HARNESS_DEFAULTED` is a different case: it fires only when what the
 * lead declared cannot be priced. What is lost is the *veto window*: the orchestrator cannot
 * refuse a wrong-shaped harness before budget is spent, because nothing forces the declaration
 * to exist.
 *
 * This correction is here, and not only in the hook, because **the generator is where someone
 * looks to find out what the hooks do.** A registration list that describes an earlier version
 * of a hook is the shape of defect this build has been bitten by most: the reader has no reason
 * to open the hook, so the false line is the one they act on.
 *
 * That matcher is `'*'` and not `'Bash'`, which is what it used to be, because the
 * BUDGET_TRIPPED breaker is an every-tool rule and a hook that is not *consulted*
 * cannot deny anything. Measured with the flag set and the matcher as the only
 * variable: under `'Bash'` a tripped lead's `Bash` was refused with the budget
 * message while its `Read` ran normally — so the breaker stopped the cheapest tool
 * and left `Task` (which spawns the teammates that spend most of the budget) wide
 * open. `evaluateGate` was always right for every tool; only its reach was wrong.
 * Widening costs nothing else: the gate's other two rules test `tool === 'Bash'`
 * and an Edit-tool set explicitly, and everything else falls through to allow.
 *
 * **COST, recorded so a fleet fanning out is not a surprise.** Two of these three
 * matchers are `'*'`, and they are on the two events that fire most, so **every tool
 * call in the lead pays TWO process spawns**: `node lead-gate.mjs` (PreToolUse) and
 * `sh -c 'mkdir -p … && touch …'` (PostToolUse). Measured on this machine: a bare
 * `node` spawn that does nothing is ~19.5 ms and the heartbeat's `sh -c` ~6.4 ms, so
 * the floor is ~26 ms of wall clock per tool call before the gate reads a byte —
 * matching the ~26 ms measured against the real gate script. The worktree guard file
 * adds a third `'*'` PreToolUse entry, so **every teammate pays the gate spawn too**,
 * and a fleet is one lead plus N teammates all doing this on every tool call.
 * Accepted, and deliberately not optimised here: a hook that is not consulted cannot
 * deny anything, which is the defect fix round 3 closed, and correctness on the
 * secrets boundary outranks 26 ms. If it ever needs to come down, the lever is the
 * gate's own start-up cost or merging the heartbeat into the gate — NOT narrowing a
 * matcher, which is how the hole comes back. One exception to "one gate spawn per call":
 * a lead spawned before 2026-08-06 still carries a `--session-guard` twin in its launch
 * file, a DIFFERENT command string, so it pays two gate spawns per tool call until a
 * resume rewrites the file (12 of 34 launch files under the live root on 2026-09-07; the
 * gate writes nothing, so the second run is ~20 ms and nothing else).
 */
export function writeLeadSettings(id) {
  const heartbeat = p('heartbeats', id);
  return publishJson(join(leadDir(id), 'settings.json'), {
    model: 'opus',
    // The floor under account rotation (spec §1.3, MEASURED on one real event): with this true and
    // the window's `resetsAt` within 24 h, Claude Code arms itself — `Usage limit reached ·
    // continuing automatically at <time>` — and resumes 85 s after the reset with a synthetic user
    // prompt. Without it a rate-limited lead sits silent while the fleet reads it as healthy
    // (measured: a rate-limited lead sat silent for days). Rotation moves a lead to an open seat
    // when one exists; this is what recovers it when none does. It reaches every teammate through
    // `--settings`, and here that is wanted: a teammate shares its lead's seat and therefore its
    // window. A spend cap carries no reset time, so this cannot arm for one — that case is the
    // watchdog's BACKPRESSURE, not this key. A lead already running when this landed keeps its old
    // file until its next spawn or resume rewrites it, and doctor does not report that (RUNBOOK §5.2).
    autoContinueAtUsageLimit: true,
    // NO `permissions` KEY, DELIBERATELY. A `deny: ['Edit','Write','NotebookEdit']` sat here
    // and reached every teammate through `--settings`; the lead's ban lives on argv instead.
    // See the two doc blocks above before adding a permissions rule of any kind here — this
    // file binds the whole fleet, so a rule that is right for the lead is rarely right here.
    hooks: {
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `mkdir -p ${shq(dirname(heartbeat))} && touch ${shq(heartbeat)}` }] }],
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: `node ${shq(binPath('hooks', 'lead-stop.mjs'))}` }] }],
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `node ${shq(binPath('hooks', 'lead-gate.mjs'))}` }] }],
    },
  });
}

/**
 * One protected branch's worth of push denies — see STANDING_DENIES below.
 *
 * Every rule anchors on the **refspec position** the branch name occupies, never on
 * the bare word, and closes at a word boundary. Both halves are load-bearing and
 * each was measured against a real bare remote:
 *
 * - *Anchor.* The destination of a push is always preceded by a delimiter: the
 *   space after the remote name, a `:` (`HEAD:main`, `x:main`), a `+` (a force-push
 *   wearing a plus), or `heads/` (`refs/heads/main`, in either half of a refspec).
 *   Matching the bare word instead is what made `git push origin soma/fix-main-nav`
 *   and `git push origin soma/developer-docs` refuse — measured, remote received
 *   zero refs — which dead-ends the task, since a teammate that cannot push its own
 *   branch never reaches `soma-pr` and never opens a draft PR. Worse, the refusal
 *   reads to the agent as a protected-branch hit rather than a rule bug, so it does
 *   not diagnose itself.
 * - *Boundary.* Each anchor is spelled twice — once ending the command, once
 *   followed by a space — rather than with a trailing wildcard, because
 *   `origin main` + anything also refuses `git push origin mainline` and
 *   `git push origin maintenance` (both measured under the old rules). There is no
 *   third form: a refspec is a whitespace-delimited argument.
 *
 * The quoted spellings are separate rules because rule matching is textual and does
 * **not** shell-unquote: with only the bare anchors, `git push origin 'main'` ran and
 * put `main` on the remote (measured). A quote character immediately before *and*
 * after the name is unambiguous, so those two may match anywhere in the command —
 * `'soma/fix-main-nav'` does not contain `'main'`.
 *
 * The flags are here because they reach a protected branch **without naming it**:
 * `git push --all origin` and `git push --mirror origin` both pushed main *and*
 * develop under the old rules (measured), and `--delete` removes a protected branch
 * rather than writing to it, which is worse. soma's own flow uses none of them.
 */
const protectedBranchDenies = (branch) => [
  `Bash(git push*origin ${branch})`,
  `Bash(git push*origin ${branch} *)`,
  `Bash(git push*:${branch})`,
  `Bash(git push*:${branch} *)`,
  `Bash(git push*+${branch})`,
  `Bash(git push*+${branch} *)`,
  `Bash(git push*heads/${branch})`,
  `Bash(git push*heads/${branch} *)`,
  `Bash(git push*'${branch}'*)`,
  `Bash(git push*"${branch}"*)`,
];

/** The branches the operator's standing rule puts off limits (spec § 9). */
const PROTECTED_BRANCHES = Object.freeze(['main', 'develop']);

/**
 * The credential-store family: the operator's secrets, and the two surfaces that reach them.
 *
 * **THIS FAMILY EXISTS BECAUSE IT WAS REACHED.** During this build a review agent read the
 * operator's live Claude OAuth tokens into its own transcript **by accident** — no attack, no
 * prompting, one `security find-generic-password` while looking for something else. Until this
 * array landed, nothing in soma stopped it: teammates are unattended, permission-bypassed
 * `claude` processes with full shell access, and the canary would have reported all eight
 * invariants holding while it happened. A transcript is a file on disk that later sessions
 * read, so one accidental dump is a credential at rest for as long as the transcript lives.
 *
 * **TWO SURFACES, AND A BASH RULE CANNOT SEE THE SECOND ONE.** `Bash(...)` rules match a
 * command string, so they cover `cat`, `grep`, `security`, `python -c` and every other
 * spelling that goes through a shell — but the `Read` tool never produces a command string at
 * all. `Read(...)` is the only rule that reaches it. Both halves are here, and neither is
 * sufficient: dropping the Bash half leaves `cat ~/.aws/credentials`, dropping the Read half
 * leaves the Read tool pointed at the same file.
 *
 * **NAMED BY THE SECRET, NOT BY THE READER** — the same framing STANDING_DENIES states for the
 * protected branches, applied in the direction where it actually works. `Bash(cat*credentials*)`
 * enumerates an idiom and loses to `head`, `less`, `python`, `xxd` and a here-doc; a rule that
 * names the *path* catches every reader that types it. The exceptions are the credential
 * *agents* — `security`, `keyring`, `secret-tool`, `pass`, `gpg --decrypt` — where the secret has
 * no path, so the tool IS the goal and the binary is what gets named. Each of those is spelled
 * twice, bare and path-prefixed, because `/usr/bin/security …` and `sudo security …` are one
 * segment that a bare-name rule does not match.
 *
 * **Every rule keeps a `*`**, per the invariant STANDING_DENIES states above: a wildcard-free
 * rule is compared to the raw segment, so a doubled space would defeat it. That is why the
 * bare-binary rules are `Bash(security *)` rather than `Bash(security)` — the trailing
 * `<space>*` is both the argument matcher and the wildcard the invariant requires. Note it is
 * `security<space>*` and not `security*`: the latter also matches `securityscan --help`.
 *
 * **Over-reach, declared rather than discovered later.** These rules refuse some legitimate
 * commands, and each is accepted because the alternative is a rule that misses: `ssh-add
 * ~/.ssh/id_ed25519` (a *use*, not a read, but not a teammate's job), `curl --netrc`, a `grep`
 * whose pattern happens to contain `Login Data`, and any `pass`/`security` invocation at all.
 * Soma's own flow uses none of them. What is deliberately NOT here, for the opposite reason:
 * `.npmrc`, `.pypirc` and `.kube/config` live inside repos and are read routinely by an agent
 * doing ordinary work, so a rule for them would dead-end tasks — the test STANDING_DENIES
 * states for any widening ("does it delete a redundant spelling, or the last one?").
 *
 * **What this does NOT close, stated because a deny list over strings never closes a class.**
 * A subprocess the teammate writes (`python -c` reading the file byte-by-byte from a path it
 * assembles at runtime, a compiled helper, a `$(printf …)` path) is invisible to a textual
 * rule, exactly as it is for the protected branches. Read this as depth. The class needs the
 * PreToolUse gate and the OS sandboxing the roadmap names, and `soma doctor` must not report
 * "credentials are safe" on the strength of these rules — only that the named single-command
 * paths are closed.
 *
 * ---
 * TWO MORE RESIDUALS, AND THEY ARE CHEAPER TO REACH THAN THE SUBPROCESS ONE. Both were found
 * by the final whole-branch review; both were UNDECLARED until now, which was the actual
 * defect — the paragraph above reads as though the subprocess is the whole remainder.
 *
 * **(a) CASE VARIATION ON A PATH. A one-keystroke bypass.** Permission rules are matched
 * case-SENSITIVELY against the command string, and this volume is case-INSENSITIVE. So
 * `cat ~/.AWS/credentials` and `strings ".../LOGIN DATA"` match no rule here and are ALLOW,
 * while the filesystem serves the same bytes as `~/.aws/credentials` and `Login Data`.
 * Re-measured for this note with SYNTHETIC files under a scratch directory (never a real
 * credential, never a keychain read): a file written as `.aws/credentials` was read back
 * through `./.AWS/credentials` on the APFS root volume.
 *
 * **(b) QUOTE OR BACKSLASH SPLITTING INSIDE A FILENAME.** `cat ~/.ssh/id""_ed25519` and
 * `cat ~/.ssh/id\_ed25519` name the same file to the kernel — the shell removes the quoting
 * before the syscall — but the string a rule is compared against still carries the `""`, so
 * `Bash(*.ssh/id_*)` does not match it. Measured the same synthetic way: `ls .ssh/id""_x`
 * resolved to `.ssh/id_x`.
 *
 * **DELIBERATELY NOT FIXED HERE, and the reasoning is the whole point rather than an excuse.**
 * Both are tempting to close by widening a regex, and widening is the wrong move:
 *
 *   - Case is not enumerable. `~/.aws/credentials` alone has 2^15 spellings on a
 *     case-insensitive volume; adding `Bash(*.AWS/credentials*)` closes ONE of them and
 *     produces a rule set that LOOKS more complete while covering a vanishing fraction. That
 *     is the same "name an idiom and lose to the next spelling" failure this block already
 *     rejects for `Bash(cat*credentials*)`, and a false sense of closure on the credential
 *     boundary is worse than a declared hole.
 *   - Quote-splitting has the same shape: `""`, `''`, `\`, `$''` and `${x:-…}` are an open set.
 *   - The standing rule on this build is that a residual is DECLARED rather than tightened on
 *     suspicion, and ignoring it produced 29 false positives here.
 *
 * **What WOULD close both, and where it belongs.** Not a rule — a predicate. The PreToolUse
 * gate already resolves a write target rather than pattern-matching one, which is why it beats
 * a deny rule on the `.claude/` boundary; the same treatment for reads (lower-case the command
 * string and strip shell quoting before comparing against a credential-path set) closes (a) and
 * (b) together and is immune to the next spelling. That is a `lead-gate.mjs` change and is
 * recorded in `docs/ROADMAP.md`, not attempted here.
 */
const CREDENTIAL_STORE_DENIES = Object.freeze([
  // Credential AGENTS — the secret has no path, so the tool is the goal.
  'Bash(security *)',                        // macOS keychain CLI, every subcommand
  'Bash(*/security *)',                      //   …path-spelled, or behind sudo
  'Bash(*find-generic-password*)',           // the exact call that read the live OAuth token
  'Bash(*find-internet-password*)',
  'Bash(*find-certificate*)',
  'Bash(*dump-keychain*)',
  'Bash(keyring *)',                         // python-keyring
  'Bash(*/keyring *)',
  'Bash(secret-tool *)',                     // libsecret / GNOME keyring
  'Bash(*/secret-tool *)',
  'Bash(pass *)',                            // passwordstore.org
  'Bash(*/pass *)',
  'Bash(gpg*--decrypt*)',                    // …which is what `pass` shells out to
  'Bash(gpg*-d *)',                          // both spellings, both positions — as with git's -f
  'Bash(gpg*-d)',
  'Bash(*/gpg*--decrypt*)',
  // Credential FILES, through any shell reader at all.
  'Bash(*.credentials.json*)',               // Claude Code's own token file on Linux/WSL
  'Bash(*.aws/credentials*)',
  'Bash(*.aws/sso*)',                        // the SSO token cache, same secret by another route
  'Bash(*.ssh/id_*)',
  'Bash(*.netrc*)',
  'Bash(*gh/hosts.yml*)',
  'Bash(*.docker/config.json*)',
  // Browser cookie and saved-password stores. Narrow on purpose: a bare `Bash(*Cookies*)`
  // would refuse a teammate reading its own `src/Cookies.tsx`, which is a dead-ended task.
  'Bash(*Library/Cookies*)',
  'Bash(*Cookies.binarycookies*)',
  'Bash(*cookies.sqlite*)',
  'Bash(*/Chrome/*/Cookies*)',
  'Bash(*/Chromium/*/Cookies*)',
  'Bash(*Login Data*)',
  'Bash(*.mozilla/firefox*)',
  // The SAME files through the Read tool, which produces no command string for any rule
  // above to match. `Read(...)`, not `Write(...)`: see the inert-rule note in STANDING_DENIES.
  'Read(~/.aws/**)',
  'Read(~/.ssh/**)',
  'Read(~/.netrc)',
  'Read(~/.config/gh/**)',
  'Read(~/.docker/config.json)',
  'Read(~/.claude/.credentials.json)',
  'Read(~/.claude*/.credentials.json)',      // a CLAUDE_CONFIG_DIR sibling of the default root
  'Read(~/Library/Cookies/**)',
  'Read(~/Library/Application Support/**/Cookies*)',
  'Read(~/Library/Application Support/**/Login Data*)',
  'Read(~/.mozilla/**)',
  'Read(~/.config/google-chrome/**)',
  'Read(~/.config/chromium/**)',
]);

/**
 * The standing rules that do not depend on the machine, grouped by what they hold.
 *
 * **Draft-only, CLI and REST.** `gh pr create` is denied so the only route to a PR
 * is the `soma-pr` wrapper, which always injects `--draft`; `gh pr ready` and
 * `gh pr edit` are the un-draft paths, and `gh api` reaches all three over REST —
 * `gh api --method POST /repos/O/R/pulls -F draft=false` is a non-draft PR and
 * `gh api -X PATCH /repos/O/R/pulls/N` is `gh pr ready` by another name, so
 * the `pulls` path is denied alongside the `merge` one. The wrapper is unaffected:
 * its own `gh` runs inside the script, where no Bash rule ever sees it.
 * (No glob may be spelled inside this comment — a `<star><slash>` sequence would
 * end it. The rules themselves are in the array below.)
 *
 * That `gh api` rule is deliberately **broad**, and the breadth is right here for
 * the exact reason it was wrong for the protected branches above. It also refuses a
 * read-only `gh api /repos/O/R/pulls/N`, and that is accepted, because (a) the
 * method cannot be read off the string — `gh api <path> -f k=v` is a POST with no
 * method flag at all, so a "deny writes only" spelling is unsound rather than
 * merely narrow — and (b) nothing is *blocked*: `gh pr view`, `gh pr list` and
 * `gh pr diff` are untouched and `mcp__github__pull_request_read` survives the
 * named-tool denies below, so the cost is one redundant spelling of a question the
 * teammate can still ask three other ways. The protected-branch breadth had no such
 * alternative: it removed the only way to push, and the task dead-ended there. That
 * is the test to apply to any future widening — does it delete a redundant spelling,
 * or the last one?
 *
 * **`gh api` also reaches a PROTECTED BRANCH, in one command, and two more paths are
 * denied for that.** The gap was measured, not reasoned about: all three of these were
 * *permission-allowed* by the rules above and failed only on GitHub's 404, because the
 * probe aimed them at a repo that does not exist. The permission check happens first,
 * and the `repo` token scope on this machine would have landed every one against a
 * real remote:
 *
 *     gh api --method PATCH /repos/O/R/git/refs/heads/main -f sha=…   force-moves main
 *     gh api --method PUT   /repos/O/R/contents/x.txt -f branch=main  direct commit to main
 *     gh api --method POST  /repos/O/R/git/refs -f ref=refs/heads/main   creates main
 *
 * An omission rather than a judgement, which is why it is closed here: the surface was
 * already policed on both sides of it — `gh api` with `merge` and with `pulls` are
 * denied above, and the three MCP equivalents (`push_files`, `create_or_update_file`,
 * `delete_file`) are denied *by name* below for exactly this hazard. The CLI spelling
 * of the same three writes was simply missing.
 *
 * These two carry the identical soundness argument as the `pulls` rule and have to:
 * the HTTP method is unreadable from the command string, since `gh api <path> -f k=v`
 * is a POST with no method flag at all, so a "deny writes only" spelling would merely
 * *look* like it distinguishes read from write. The read-only spellings therefore go
 * too — and by the test just stated, that deletes redundant spellings rather than last
 * ones, verified rather than assumed: reading a ref still works through `git ls-remote`
 * and `gh repo view`, reading a file still works through `git show`, the Read tool and
 * `gh repo view`, and `gh api` on every other path (a repo, a user, commits, issues,
 * rate_limit) still runs — measured live against the real network after these rules
 * shipped. Nothing soma does uses either path: its PR route is the `soma-pr` wrapper
 * and its push route is `git push`.
 *
 * **Protected branches.** Ten rules per branch, generated by
 * `protectedBranchDenies` — see its comment for why each anchor exists and what
 * measurement produced it. The spec's own two literal rules
 * (`git push origin main` + anything) are deliberately *not* kept: they are
 * subsumed by the anchored pair and their trailing wildcard is precisely the
 * over-reach being removed. The spec's intent is preserved and widened; only its
 * spelling is replaced.
 *
 * **Force pushes**, both spellings, in both positions. `-f` gets an end-of-command
 * rule as well as a followed-by-space one because `git push origin soma/x -f` — the
 * flag last — went through under the space-only rule (measured).
 *
 * **The guard file protects itself.** It lives in a directory the teammates own
 * with full Edit/Write, and `worktree.mjs`'s `.claude/.gitignore` (`*`) means deleting it
 * shows up in neither `git status` nor the PR — so a teammate could restore the
 * operator's entire personal MCP fleet for every later spawn in that worktree,
 * leaving no trace in the diff. Hence the `rm`/`mv` and Edit rules.
 *
 * There is deliberately **no `Write(...)` rule** for the guard directory, and one
 * must not be added back. Claude Code refuses to honour it and says so, once per
 * session, in every guarded worktree: *"Permission deny rule
 * (.claude/settings.local.json): `Write(./.claude/**)` is not matched by file
 * permission checks — only Edit(path) rules are. Use Edit(./.claude/**) instead
 * (Edit rules cover all file-editing tools)."* So the rule was inert, it looked
 * like coverage in review, and it put a warning in front of every teammate. The
 * `Edit(./.claude/**)` rule below is what actually refuses the Write tool — per
 * that same message, an Edit rule covers Edit, Write and NotebookEdit — and it was
 * always the rule doing the work in the round-1 measurement.
 *
 * **Named MCP tools that must survive `teammate_mcp_allow`.** Every bare
 * `mcp__<server>` deny below can be lifted by the operator's allowlist, and
 * `github` is the plausible one to lift (teammates do PR work). Lifting it without
 * these would hand back `create_pull_request` (a *non-draft* PR — the CLI deny
 * covers only the CLI), `push_files` / `create_or_update_file` / `delete_file`
 * (direct commits to main, so the protected-branch rules are moot),
 * `pull_request_review_write` (self-approval) and the two un-draft paths. Same
 * shape as atlassian: allowlisting it restores Jira *comments* while transitions
 * and edits stay denied.
 *
 * **Two prefix rules, because enumeration cannot reach these.** claude.ai account
 * connectors (`mcp__claude_ai_*`) and plugin servers (`mcp__plugin_*`) are not in
 * `~/.claude.json` at all — see `enumerateUserMcpServers`. On this machine that is
 * sixteen connectors, three of them already authenticated: Slack (post as the
 * operator), Microsoft 365 (send mail, upload and delete SharePoint files) and
 * Google Drive (create and read files) — the same severity class as the database
 * writes, reachable today by any teammate in a cwd without this file. A prefix
 * deny is verified to bite exactly like an exact name (see the fix report's A/B).
 * Consequence the operator has to be told, because it is the opposite of what the
 * dial's name implies: `teammate_mcp_allow` **cannot** lift these two rules. Deny
 * beats allow in Claude Code's resolver, and a third A/B arm confirmed it — the
 * prefix deny plus *both* an exact-name allow and a wildcard allow still left the
 * tool unresolved. Handing teammates one connector therefore means editing this
 * array, not `soma.json`. Said again in README so the first operator who wants a
 * connector does not spend the afternoon on the wrong dial.
 *
 * Narrowed rather than sealed, knowingly: anything that reaches `gh` or a file
 * through a subprocess (`python -c`, a script the teammate wrote) is invisible to
 * rules that match a command string. Sealing that needs OS sandboxing, out of
 * lite's scope (spec § 9, "declared residual holes"). Three more, stated so they are
 * not later diagnosed as bugs:
 *
 * - A bare `git push` with the upstream already set to a protected branch names
 *   nothing this can match — the refspec has to appear in the string to fire.
 * - The end-of-command `-f` / `-d` rules also refuse a branch whose name happens to
 *   END in `-f` or `-d`: `git push origin soma/task-f` and `soma/task-d` are both
 *   denied. Deliberate — dropping them let `git push origin soma/x -f` through, with
 *   the flag last, measured. **Branch-naming guidance, since this is the one
 *   over-reach a caller can simply avoid: a lead must not generate a task branch
 *   whose name ends in `-f` or `-d`.** Any other suffix is fine, and the collision is
 *   only on the final two characters — `soma/task-fix` and `soma/task-docs` push
 *   normally. The prompts and the promotion skill are where that belongs if it ever bites.
 * - The rules assume one command per string. They do not have to: Claude Code
 *   segments a command on `;`, `&&`, `||`, `|` and `&` and applies the rules to each
 *   segment, so `echo hi && git push origin main` is refused (measured) — which is
 *   the direction that helps, and it is what lets a teammate's real
 *   `git add -A && git commit -m x && git push origin soma/task-x` through while
 *   still catching a protected branch anywhere in the chain. A wildcard cannot span a
 *   segment boundary, though, so no rule here should be written expecting it to.
 * - **Every rule in this array must keep at least one `*`, and that is load-bearing
 *   rather than stylistic.** Measured with the rule as the only variable: a rule
 *   containing a wildcard matches **whitespace-insensitively**, while a rule with no
 *   wildcard is compared against the raw segment, so `Bash(echo alpha beta)` lets
 *   `echo alpha  beta` (two spaces) RUN while `Bash(echo alpha beta*)` refuses it. All
 *   38 `Bash(...)` rules generated here contain a wildcard today — asserted by a test —
 *   so `git push origin  main` with a doubled space is denied, and a bypass that would
 *   otherwise cost one keystroke does not exist. Write a wildcard-free rule here and it
 *   silently becomes whitespace-brittle in a way no other rule in the file is.
 *
 * **The framing that matters, because this round is the evidence for it: ENUMERATE
 * THE GOAL, NOT THE IDIOM.** The class boundary worth defending is "writes a
 * protected ref", not "contains `git push`". Fix round 3 enumerated the ways to reach
 * a protected branch *via `git push`* and found three holes in a single pass;
 * enumerating the ways to reach one *at all* immediately finds more, none of which
 * are `git push origin main` and all of which were measured landing `main` on a real
 * remote:
 *
 *   - `origin ` is a remote-NAME anchor, not a remote anchor, so
 *     `git push "$(git remote get-url origin)" main`, `git push upstream main` and
 *     `git send-pack ../remote.git main` all ran.
 *   - `git push origin HEAD` while standing on `main` ran — reachable in two steps,
 *     since the gate's git-verb ban is lead-only and a teammate may `git checkout main`.
 *   - Partial quoting defeats the quoted rules: `git push origin "ma"in`, `ma''in`.
 *   - An alias launders the whole string: `git config alias.pm 'push origin main'`
 *     then `git pm`.
 *
 * Those are recorded, not chased. Chasing them is the mistake: a string-matching deny
 * list **cannot** close this class, because the set of strings that write a ref is not
 * enumerable and every round of enumeration produces a shorter, more obfuscated
 * spelling. The two `gh api` paths above are closed for a narrower reason than "the
 * class is closable" — they are a *single command* on a surface this file already
 * polices on both sides, so they cost two rules and no capability. The real answer to
 * the class is the PreToolUse gate (which sees the command before it runs and can
 * reason rather than pattern-match) plus the OS sandboxing the roadmap already names.
 * Read this list as depth, not as a boundary.
 */
const STANDING_DENIES = Object.freeze([
  'Bash(gh pr merge*)',
  'Bash(gh pr ready*)',
  'Bash(gh pr create*)',
  'Bash(gh pr edit*)',
  'Bash(gh api */merge*)',
  'Bash(gh api */pulls*)',
  // …and the two REST paths that write a ref or a file directly — see above. Both
  // were measured permission-ALLOWED before this rule existed.
  'Bash(gh api */git/refs*)',
  'Bash(gh api */contents*)',
  ...PROTECTED_BRANCHES.flatMap(protectedBranchDenies),
  // Reach a protected branch without ever naming it.
  'Bash(git push*--all*)',
  'Bash(git push*--mirror*)',
  // `--delete` is deliberately unqualified, so it also refuses a teammate deleting
  // its OWN task branch. Declared rather than narrowed: soma's flow never cleans up
  // branches (the draft PR is the handoff and the branch outlives it), so the
  // capability is unused, while a qualified spelling would have to name the branch —
  // and the branch name is the one thing a delete does not have to spell in the
  // refspec position. If a later round teaches cleanup, this is the rule to revisit.
  'Bash(git push*--delete*)',
  'Bash(git push*-d *)',
  'Bash(git push*-d)',
  // Force, both spellings, both positions.
  'Bash(git push*--force*)',
  'Bash(git push*-f *)',
  'Bash(git push*-f)',
  'Bash(rm*.claude*)',
  'Bash(mv*.claude*)',
  'Edit(./.claude/**)',                     // covers Edit, Write AND NotebookEdit — see above
  'mcp__atlassian__transitionJiraIssue',
  'mcp__atlassian__editJiraIssue',
  'mcp__github__merge_pull_request',
  'mcp__github__update_pull_request',
  'mcp__github__update_pull_request_branch',
  'mcp__github__create_pull_request',
  'mcp__github__create_pull_request_with_copilot',
  'mcp__github__pull_request_review_write',
  'mcp__github__push_files',
  'mcp__github__create_or_update_file',
  'mcp__github__delete_file',
  'mcp__claude_ai_*',
  'mcp__plugin_*',
  // The secrets boundary's other half: the operator's own credentials, not their MCP
  // servers. See CREDENTIAL_STORE_DENIES — this family was added because a review agent
  // read the operator's live Claude OAuth token into a transcript with one command.
  ...CREDENTIAL_STORE_DENIES,
]);

/**
 * Make sure `.claude/` cannot show up in the task's diff.
 *
 * `worktree.ensureWorktree` writes this file, and in the spawner's order it has
 * already run — so this is the belt for a caller that has not (the canary, a
 * repair pass, a worktree left by an older soma). Create-if-absent only: the
 * existing bytes are `ensureWorktree`'s and must survive untouched, since they are what
 * keeps the guard file out of the PR *and* keeps `status --porcelain` empty, which
 * is what makes the worktree-reuse path reachable at all.
 *
 * Non-fatal. A missing ignore file is a hygiene problem; a spawn that dies here
 * is a lead that never starts.
 */
function ensureClaudeIgnored(claudeDir) {
  try {
    // The existsSync is the ordinary path — in a real spawn `ensureWorktree` wrote this
    // file minutes ago. `wx` (create-or-fail) is what makes the gap between the
    // two calls harmless: a concurrent writer that wins gets to keep its bytes
    // and we take the EEXIST below, rather than truncating what it just wrote.
    if (!existsSync(join(claudeDir, '.gitignore'))) writeFileSync(join(claudeDir, '.gitignore'), '*\n', { flag: 'wx' });
  } catch {
    // EEXIST (someone won the race — fine, theirs is as good as ours) or a
    // read-only worktree. Either way the guardrails still get written.
  }
}

/**
 * Write `<dir>/.claude/settings.local.json` — the team-wide guardrails — and
 * return its path.
 *
 * This is the one settings source every teammate inherits, because it is found
 * from cwd. `mcpDenies` is the list of servers to shut out (defaults to whatever
 * this machine has) and `teammateAllow` the operator's exemptions (defaults to
 * `soma.json`'s `teammate_mcp_allow`). Both default to the *real* sources rather
 * than to `[]`, so a caller that forgets the options gets a complete guard file
 * instead of a plausible-looking one with no personal-MCP denies in it.
 *
 * `home` and `env` are the enumeration's two inputs, forwarded to
 * `enumerateUserMcpServers` — including to the refusal below, which used to call it
 * with no arguments and so reported *this machine's* server count back to a caller
 * that had pointed the whole operation at a sandbox home. Omit both in production;
 * they exist so a caller with a throwaway home gets an answer about that home.
 *
 * **`home` alone is enough to isolate, and that took a second fix to be true.**
 * Forwarding the two *verbatim* left `env` `undefined`, which fell through to
 * `enumerateUserMcpServers`'s own `env = process.env` default — so on a machine with
 * an ambient `CLAUDE_CONFIG_DIR` (this one), `writeWorktreeGuardrails(wt, { home:
 * sandbox })` still unioned the operator's real config root, and the refusal message
 * then named the wrong machine: precisely the bug the sandbox-home parameter was
 * added to remove, half-removed. The gap survived because every test passed `home`
 * and `env` together, so nothing ever exercised the one-argument call. Hence
 * `enumEnv` below: an explicit `env` always wins, and an explicit `home` with no
 * `env` means `{}` — a caller who has said "answer about this home" cannot have meant
 * "…unioned with whatever root my shell happens to point at". Production passes
 * neither and is unchanged (`process.env`, the real root). Pinned by a test that
 * passes `home` with NO `env`.
 *
 * `roots` is the seat list, the same word `enumerateUserMcpServers` takes, and it is
 * forwarded to BOTH enumerations below — the fallback that runs when a caller omits
 * `mcpDenies`, and the empty-`mcpDenies` refusal. Without it those two answered about
 * the fixed pair alone: a fleet whose servers live in a seat would have got a guard
 * file with no seat deny in it from the fallback, and an empty deny list would have
 * sailed past a refusal that counted the wrong machine. Explicit rather than read from
 * `soma.json` here, for the same reason `home`/`env` are explicit — a caller that has
 * pointed this at a sandbox cannot have meant "…unioned with the live fleet's seats".
 *
 * The file is soma-owned and rewritten in full on every spawn: that is how a
 * server the operator added yesterday gets denied in a worktree reused today.
 *
 * Two refusals rather than a plausible-looking file:
 *
 * - **A missing `dir`.** Conjuring it would produce a `.claude/` orphan outside any
 *   checkout while the caller believes a worktree was guarded; `worktree.mjs` deliberately
 *   refuses to invent a worktree either.
 * - **An explicitly empty `mcpDenies` on a machine that has servers.** `[]` is
 *   indistinguishable from "I enumerated and found nothing", and it writes a file
 *   that reads as guarded while denying not one personal server. The default
 *   (omit the option) is what a caller wants; `[]` is a bug or a stale call site.
 */
export function writeWorktreeGuardrails(dir, { mcpDenies, teammateAllow, home, env, roots = [] } = {}) {
  if (!existsSync(dir)) {
    throw new Error(`writeWorktreeGuardrails: ${dir} does not exist — ensureWorktree must create the worktree first`);
  }
  // An explicit `env` wins; an explicit `home` with no `env` isolates rather than
  // silently unioning the ambient CLAUDE_CONFIG_DIR root. See the JSDoc — passing
  // `home` alone used to leak the operator's real root into a sandbox answer.
  const enumEnv = env ?? (home === undefined ? process.env : {});
  if (Array.isArray(mcpDenies) && mcpDenies.length === 0) {
    const found = enumerateUserMcpServers(home, enumEnv, { roots });
    if (found.length) {
      throw new Error(`writeWorktreeGuardrails: mcpDenies is empty but this machine has ${found.length} discoverable MCP servers (${found.slice(0, 3).join(', ')}…) — omit the option to deny them, or pass them with teammate_mcp_allow to exempt one`);
    }
  }
  const allowed = new Set(teammateAllow ?? loadConfig().teammate_mcp_allow ?? []);
  const personal = [...new Set(mcpDenies ?? enumerateUserMcpServers(home, enumEnv, { roots }))]
    .filter((name) => typeof name === 'string' && name && !allowed.has(name))
    .sort()                                  // deterministic: doctor and every respawn diff this file
    .map((name) => `mcp__${name}`);
  const somaPr = binPath('soma-pr.mjs');
  const claudeDir = join(dir, '.claude');
  const cfg = {
    permissions: {
      deny: [...STANDING_DENIES, ...personal],
      // Both spellings of the real path, plus one glob. soma-pr.mjs is committed
      // 100755 with a shebang, so the bare form runs and would not match
      // a `Bash(node ...)` rule; the glob is what matches a tilde or quoted
      // spelling of the same install (`node ~/soma/bin/soma-pr.mjs`,
      // `node "/Users/a b/..."`), which an absolute rule cannot match textually.
      // A *bare* glob is deliberately not here: it would allow any path ending in
      // bin/soma-pr.mjs, and the two absolute rules already cover every spelling
      // soma's own prompts teach.
      allow: [
        `Bash(node ${somaPr}*)`,
        `Bash(${somaPr}*)`,
        'Bash(node */bin/soma-pr.mjs*)',
        // Read-only inspection, added 2026-09-07 on the operator's call.
        //
        // WHY: a lead writes `cd <worktree> && grep pattern relative-file` out of
        // habit — the spawn already sets cwd, so the `cd` is redundant. Claude Code
        // cannot statically resolve a path that follows a `cd`, and because SOME
        // `Read(...)` deny exists above it cannot prove the command will not reach
        // one. So it ASKS. Nobody watches a lead's pane, so the lead waits forever,
        // and its heartbeat still looks healthy because `PostToolUse` stamps the last
        // COMPLETED call and a blocked lead has just completed one. Measured cost on
        // 2026-09-07: seven freezes on one lead, one of ~38 hours on another, six
        // leads affected. Telling leads to stop using `cd` does not work; the habit
        // outlives the instruction.
        //
        // WHY THIS IS SAFE: the secrets boundary is held at the Bash layer
        // independently of these entries. STANDING_DENIES already carries
        // `Bash(*.ssh/id_*)`, `Bash(*.aws/credentials*)`, `Bash(*.aws/sso*)`,
        // `Bash(*.netrc*)`, `Bash(*gh/hosts.yml*)`, `Bash(*.credentials.json*)`,
        // `Bash(*.docker/config.json*)`, every browser cookie store, and the
        // keychain / pass / secret-tool / gpg --decrypt families. Deny beats allow,
        // so none of that is reachable through an allowed `grep` or `cat` — these
        // entries remove a PROMPT, not a GUARD.
        //
        // Deliberately NOT here: anything that writes or executes. No `tee`, no
        // `sed -i`, no `xargs`, no `sh -c`, no `find -exec`, no `git checkout`.
        // `git` is enumerated per read-only subcommand rather than as `Bash(git:*)`,
        // which would admit `push`, `reset` and `checkout`.
        'Bash(grep:*)',
        'Bash(rg:*)',
        'Bash(cat:*)',
        'Bash(head:*)',
        'Bash(tail:*)',
        'Bash(wc:*)',
        'Bash(ls:*)',
        'Bash(sed:-n*)',                       // print-only; `sed -i` edits in place
        'Bash(git log:*)',
        'Bash(git show:*)',
        'Bash(git diff:*)',
        'Bash(git status:*)',
        'Bash(git rev-parse:*)',
        'Bash(git rev-list:*)',
        'Bash(git branch:--list*)',
        'Bash(git ls-files:*)',
        'Bash(git merge-base:*)',
      ],
    },
    // One PreToolUse entry doing two jobs, which is why the matcher is `'*'` and
    // must stay `'*'`. `evaluateGate` decides both; the matcher only decides which
    // of them it is ever *asked* about, and a hook that is not consulted looks
    // exactly like a rule that is working.
    //
    //   Bash         the teammate write-guard. This entry used to match only the
    //                three Edit tools, which is precisely why teammates' Bash was
    //                unhooked: measured end to end, a bypassed teammate emptied its
    //                own guard file with `tee` and the md5 changed. That is the whole
    //                secrets boundary, and an emptied guard file fails OPEN to the
    //                operator's personal MCP fleet for every later spawn in that
    //                worktree — invisible in `git status` too, thanks to the `*`
    //                ignore. `lead-gate.mjs`'s `claudeWrite` predicate is what
    //                refuses it; this matcher is what lets it be asked.
    //   everything   the BUDGET_TRIPPED breaker, which is an every-tool rule (bus
    //                tools excepted, so a tripped lead can still file its report).
    //
    // (A third job is retired: the session-discriminated Edit arm, switched on by a
    // `--session-guard` argument this command used to end in. The lead's edit surface
    // was lifted to match a teammate's, the arm and flag are gone, and guard files
    // written before that still carry the flag harmlessly — the gate ignores argv it
    // does not know.)
    //
    // `'Bash'` is still the wrong narrowing: the breaker is an every-tool rule, and a
    // matcher that stopped asking about `Task` would leave the tool that spends most
    // of a lead's budget outside it.
    //
    // Cost of that `'*'`, since this file is inherited by every teammate: one
    // `node lead-gate.mjs` spawn per tool call per teammate, ~20-26 ms measured. The
    // lead pays it twice over (this entry's twin plus the heartbeat) — see
    // `writeLeadSettings` for the numbers and for why it is not optimised by
    // narrowing a matcher.
    hooks: {
      PreToolUse: [{
        matcher: '*',
        hooks: [{ type: 'command', command: `node ${shq(binPath('hooks', 'lead-gate.mjs'))}` }],
      }],
    },
  };
  mkdirSync(claudeDir, { recursive: true });
  ensureClaudeIgnored(claudeDir);            // before the guard file, so it is never briefly visible to git
  return publishJson(join(claudeDir, 'settings.local.json'), cfg);
}
