/**
 * One git worktree per task: the per-repo mutex, the fetched base, and idempotent retry.
 *
 * A lead never works in the operator's checkout (standing rule); it gets
 * `worktrees/<repo>/<id>` on its own `soma/<id>` branch. Four decisions here are
 * load-bearing, and each one is a way the fleet was observed to break without it:
 *
 * - **The base is `origin/<base>`, freshly fetched.** Basing on the *local* branch
 *   forks every task off whatever the operator last pulled; on a repo whose base
 *   auto-deploys, a stale-base PR is actively harmful and burns a whole task budget
 *   before a human notices at review. So: `fetch origin <base>`, then
 *   `rev-parse origin/<base>`, and both exit codes are checked — a failed fetch with
 *   a stale remote-tracking ref still lying around is exactly the silent-staleness
 *   case, and `git rev-parse origin/nope` prints `origin/nope` on *stdout* while
 *   exiting 128, so output alone would be recorded as the base sha.
 *
 * - **Retry is idempotent.** A task can be re-enqueued after GAVE_UP, or fresh-spawned
 *   by the watchdog over a corrupted worktree. `worktree add -b soma/<id>` fails if
 *   the branch or the path already exists, which killed the retry at spawn. Clean
 *   worktree -> reuse it; not verifiably clean -> `worktree remove --force` and
 *   recreate on the *next* free retry branch (`-r2`, `-r3`, ...). The old branch is
 *   kept, not deleted: a draft PR may point at it, and committed work is the only
 *   part of a discarded attempt that survives.
 *
 * - **The lock is per repo, and this module takes it itself.** Concurrent
 *   `worktree add` on one repo contend on git's own repo locks, and a manual
 *   `soma_spawn` racing a watchdog tick is not covered by the 90 s spawn stagger.
 *   Re-entrant in-process, so a caller may (and should) wrap a whole spawn in
 *   `withRepoLock` without deadlocking against the acquire in here.
 *
 * - **`.claude/` is hidden per worktree, and the target repo is not edited.** The
 *   spawner writes `<worktree>/.claude/settings.local.json` (the guardrails), which
 *   must never reach the PR. Verified on git 2.39.5: `$GIT_DIR/info/exclude` for a
 *   linked worktree resolves to the *common* `.git/info/exclude` — git's `info` is a
 *   common-dir path — so writing `<repo>/.git/worktrees/<id>/info/exclude` is a no-op
 *   (`git rev-parse --git-path info/exclude` inside the worktree prints the shared
 *   file), and writing the shared one would change the operator's own checkout. What
 *   works, per worktree and with nothing outside it touched, is a `.claude/.gitignore`
 *   of `*`: it hides the directory *and itself*. Without it every worktree reads
 *   dirty on retry (`?? .claude/`) and reuse is dead code.
 *
 * Every git-calling function takes an optional `run` — `(args) => ({stdout, code})`,
 * where `args` follows `git` — so tests drive the whole lifecycle without a repo, and
 * the default adds a `stderr` field nothing is required to provide.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';
import { createFileLock } from './filelock.mjs';
import { p, worktreeDir } from './paths.mjs';

/**
 * Repo key -> one path-safe filename component, for the lock file.
 *
 * Only the *lock* is slugged. The worktree dir keeps the raw key, because
 * `paths.worktreeDir(repo, id)` is what `resumeLead` computes the lead's cwd from,
 * and a slug applied in one place and not the other resumes leads into a directory
 * that does not exist. On a case-insensitive filesystem `Repo` and `repo` collide
 * onto one lock — over-locking is the safe direction for a mutex.
 */
export const repoSlug = (repo) => {
  if (typeof repo !== 'string' || repo === '') throw new TypeError(`repoSlug: repo must be a non-empty string, got ${JSON.stringify(repo)}`);
  return repo.replace(/[^a-z0-9._-]/gi, '-');
};

/** A wedged git — an ssh passphrase prompt, an unreachable host — must not hang a spawn forever. */
export const GIT_TIMEOUT_MS = 120_000;

/**
 * Run `git <args>`, reporting the exit code instead of throwing.
 *
 * A nonzero exit is ordinary control flow here (`status --porcelain` in a deleted
 * worktree, `worktree remove` on a dirty one), so execFileSync's throw is mapped back
 * to `{code}`. stdin is closed and prompting disabled: soma spawns from a detached
 * watchdog where nobody can answer a credential prompt, and git's default is to block
 * on one. stderr is captured rather than inherited so the operator's terminal is not
 * a git log, and handed to the caller for the error message.
 */
export const defaultRun = (args, { timeout = GIT_TIMEOUT_MS } = {}) => {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  // Respected if the operator set their own: only the default is made non-interactive.
  env.GIT_SSH_COMMAND = process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes';
  // These override `-C` rather than complement it (verified: `GIT_DIR=<other> git -C
  // <repo> rev-parse --absolute-git-dir` prints <other>), so a parent that exported one
  // — a git hook, `rebase -x`, a lead's own shell — would silently point every command
  // in this module at another repository, and register the task's worktree there.
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  try {
    return { stdout: execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, killSignal: 'SIGKILL', env }), stderr: '', code: 0 };
  } catch (e) {
    // `status` is null when a signal killed git — how the timeout surfaces — and
    // undefined when the binary is missing; both are failures, so both collapse to 1.
    const stderr = e.stderr?.toString() || (e.signal ? `git killed by ${e.signal} after ${timeout}ms` : '');
    return { stdout: e.stdout?.toString() || '', stderr, code: e.status ?? 1 };
  }
};

/** Whatever git said about a failure, in one string — stubs need only provide `stdout`. */
const why = (r) => (r.stderr || r.stdout || '').trim() || `exit ${r.code}`;

// --- the per-repo lock -------------------------------------------------------

/** Wait this long for a live holder before giving up. Held across a fetch, so generous. */
export const LOCK_TIMEOUT_MS = 30_000;
/** Gap between acquisition attempts. */
const LOCK_RETRY_MS = 25;

const lockPath = (slug) => p('state', `repo-${slug}.lock`);

/**
 * The per-repo mutex.
 *
 * `filelock.mjs` carries the idiom and the eight rules it rests on — `link(2)` to publish,
 * four owner states, a scratch name nobody can derive, an inode-compared release. What is
 * configured here is what is specific to this lock, and every field is a decision:
 *
 * - **One lock per repo slug, so two repos never serialise against each other.** Only the
 *   *lock* is slugged (see `repoSlug`); the worktree dir keeps the raw key.
 * - **`lockFile` is a function of the slug, called on every attempt.** `p()` reads
 *   `$SOMA_HOME` lazily and the tests retarget the state root between calls.
 * - **`reentrant`, per repo.** `ensureWorktree` takes the lock itself so the mutex cannot be
 *   forgotten, and the spawner is expected to hold it across worktree + pre-trust + settings
 *   + tmux. A non-re-entrant lock would queue behind itself, burn the timeout and throw.
 * - **No `staleMs`, and the *sharing* of one is what is load-bearing here.** This lock is held
 *   across a `git fetch`, which `GIT_TIMEOUT_MS` allows two minutes. Any age-out shorter than
 *   that takes the lock from a spawner that is working normally — the one thing an age-out must
 *   never do — and `pretrust`'s 60 s reaches it from 15 s into a wait. That is why the age-out
 *   is per-caller rather than a property of the shared lock.
 *
 *   What is *not* settled is the value, and `Infinity` is PARKED rather than reasoned: it means a
 *   lock naming a live-but-unrelated pid is never reclaimed, measured refused at one minute
 *   through one year, so every later spawn against this repo fails until a person deletes the
 *   file. It is the safer of two bad options — a stolen lock is a silent lost update, a wedge is
 *   loud — but the right answer is a bound *above* this caller's maximum legitimate hold rather
 *   than at infinity: `GIT_TIMEOUT_MS` plus the spawn steps bounds a real hold, so ~10 minutes is
 *   orders of magnitude clear of one and still ends the wedge. Deferred to its own round.
 * - **`lockFile` and `label` are evaluated once per `withRepoLock` call**, not once per attempt:
 *   the retry loop reuses what it resolved on entry, so one acquisition cannot wander between two
 *   state roots mid-wait. They must still be functions, because `p()` reads `$SOMA_HOME` lazily.
 * - **The hard-link diagnosis names `SOMA_HOME`,** correct for this lock and wrong for
 *   `pretrust`'s, which is why the wording belongs to the caller rather than the module.
 */
const lock = createFileLock({
  api: 'withRepoLock',
  label: (slug) => `repo-${slug}.lock`,
  lockFile: (slug) => lockPath(slug),
  hardLinks: {
    requirement: 'SOMA_HOME must be on a filesystem that supports hard links',
    remedy: 'move SOMA_HOME off this volume',
  },
  timeoutMs: LOCK_TIMEOUT_MS,
  retryMs: LOCK_RETRY_MS,
  reentrant: true,
});

/**
 * Run `fn` with exclusive access to one repo, and return what it returns.
 *
 * The lock is `state/repo-<slug>.lock`, holding the owner's pid, hard-linked into place
 * from a scratch file so its name and its contents appear in the same instant (an `O_EXCL`
 * create does not, and the gap was a real steal window). A lock whose owner is gone is
 * taken over rather than waited on. Release is in a `finally`, so a throwing `fn` cannot
 * strand the repo — and it releases the lock it published rather than whatever holds that
 * name by then, so a holder that was taken over cannot delete its successor's.
 *
 * Re-entrant on purpose, per repo and per process. Every acquisition is synchronous, so
 * within one process "we already hold it" is exactly true.
 *
 * Which is also why `fn` may not be async: release happens on the synchronous return, so an
 * async `fn` would run the rest of its "protected" work unlocked — and worse, a synchronous
 * waiter in this process blocks the event loop the promise needs to settle on, which is a
 * deadlock rather than a delay.
 *
 * `run` is accepted for call-shape parity with the rest of the module (nothing in here shells
 * out) and handed to `fn`, so a caller can write
 * `withRepoLock(repo, (run) => ensureWorktree({...}, run), run)`.
 */
export function withRepoLock(repo, fn, run, { timeoutMs = LOCK_TIMEOUT_MS } = {}) {
  const slug = repoSlug(repo);
  // Checked here rather than left to the shared lock, because the slug is what makes the
  // message useful and because `fn` is wrapped below — after which the shared guard would
  // only ever see the wrapper.
  if (typeof fn !== 'function') throw new TypeError(`withRepoLock(${slug}): fn must be a function, got ${typeof fn}`);
  return lock.withLock(slug, () => fn(run), { timeoutMs });
}

// --- worktrees ---------------------------------------------------------------

/** A path-ish argument that cannot climb out of the state root or split a filename. */
function checkName(value, what, { flat = false } = {}) {
  if (typeof value !== 'string' || value === '') throw new TypeError(`${what} must be a non-empty string, got ${JSON.stringify(value)}`);
  // `base` reaches git as a positional argument (`fetch origin <base>`): a leading dash
  // makes it an option instead. git refuses such a branch name anyway, so nothing legal
  // is lost by refusing it one step earlier.
  if (value.startsWith('-')) throw new TypeError(`${what} must not start with '-': ${JSON.stringify(value)}`);
  const parts = value.split(/[/\\]/);
  if (parts.includes('..') || parts.includes('.')) throw new TypeError(`${what} must not contain a '..' or '.' path segment: ${JSON.stringify(value)}`);
  if (flat && parts.length > 1) throw new TypeError(`${what} must not contain a path separator: ${JSON.stringify(value)}`);
}

/**
 * `dir` as itself and as git would print it.
 *
 * git reports worktrees by their *resolved* path (`/var/...` -> `/private/var/...` on
 * macOS, or any operator who symlinked their state root onto another volume) while
 * `paths.p` resolves only lexically — so a state root reached through a symlink would
 * never match itself. Resolving `dir` alone is not enough: the case that needs the
 * match most is a registered worktree whose directory has been deleted, and
 * `realpathSync` throws on that, so the deepest surviving ancestor is resolved and the
 * rest re-appended.
 */
function pathAliases(dir) {
  const out = new Set([dir]);
  let head = dir;
  const tail = [];
  for (let i = 0; i < 64 && head !== dirname(head); i++) {
    try {
      out.add(join(realpathSync(head), ...tail));
      break;
    } catch {
      tail.unshift(basename(head));
      head = dirname(head);
    }
  }
  return out;
}

/**
 * The `git worktree list` row for `dir`, or null — `{branch}` when git named one.
 *
 * Field-boundary matching, not a substring test: `worktrees/<repo>/cr-1` is a prefix
 * of `worktrees/<repo>/cr-10`, so with ten leads a substring check reads cr-10's row
 * as cr-1's own worktree, judges the missing directory dirty, and hands cr-1's *first*
 * attempt a `-r2` branch.
 */
function listedEntry(listed, dir) {
  const candidates = pathAliases(dir);
  for (const raw of listed.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    for (const cand of candidates) {
      if (line !== cand && !(line.startsWith(cand) && /\s/.test(line.charAt(cand.length)))) continue;
      // git ref names cannot contain '[', so the first bracket group is the branch;
      // a detached or bare worktree has none, and a stale row carries a trailing
      // `prunable` the anchored form would have missed.
      const branch = /\[([^\]]+)\]/.exec(line.slice(cand.length));
      return { branch: branch?.[1] ?? null };
    }
  }
  return null;
}

/**
 * The next retry branch after `observed`.
 *
 * Always inside this task's namespace: deriving the suffix from an unrelated branch
 * that happens to be checked out there would hand the lead a branch nobody can tie
 * back to the task. A fixed `-r2` (as first planned) is refused by git on the third
 * attempt, because `soma/<id>-r2` exists by then.
 */
function nextRetryBranch(nominal, observed) {
  const prefix = `${nominal}-r`;
  if (typeof observed === 'string' && observed.startsWith(prefix)) {
    const n = Number(observed.slice(prefix.length));
    if (Number.isInteger(n) && n >= 2) return `${nominal}-r${n + 1}`;
  }
  return `${nominal}-r2`;
}

/** A task with this many dead branches is a fleet problem, not something to keep suffixing. */
const MAX_RETRY_BRANCHES = 50;

/**
 * The first branch at or after `from` that does not exist yet.
 *
 * The branch outlives its worktree by design, so "the worktree is gone" does not mean
 * "the name is free": after a `removeWorktree` — or a `soma gc` — `worktree add -b
 * soma/<id>` is refused by git and the task could never be spawned again. Probing with
 * `branch --list` rather than `rev-parse`/`show-ref` deliberately: it exits 0 either
 * way and answers in its *output*, so "no news" means free, which is also what a
 * caller's stubbed `run` says by default. (Its argument is an fnmatch pattern, which is
 * exact here because `fleet.enqueue`'s id regex admits no glob character — and a task
 * id that somehow carried one could not be a git branch name anyway.)
 */
function firstFreeBranch({ repoPath, run, nominal, from, taskId }) {
  let candidate = from;
  for (let i = 0; i < MAX_RETRY_BRANCHES; i++) {
    const listed = run(['-C', repoPath, 'branch', '--list', candidate]);
    if (listed.code !== 0) throw new Error(`ensureWorktree(${taskId}): git branch --list ${candidate} failed in ${repoPath}: ${why(listed)}`);
    if (listed.stdout.trim() === '') return candidate;
    candidate = nextRetryBranch(nominal, candidate);
  }
  throw new Error(`ensureWorktree(${taskId}): ${MAX_RETRY_BRANCHES} branches from ${nominal} already exist in ${repoPath} — clean up the dead soma/${taskId} branches`);
}

/**
 * Make `<dir>/.claude/` invisible to git, idempotently. Returns whether it is.
 *
 * `*` in `.claude/.gitignore` ignores the directory's contents and the file itself, so
 * nothing here can reach the PR and nothing outside the worktree is edited — see the
 * module header for why the per-worktree `info/exclude` git offers is not that file.
 * Non-fatal: a spawn is not worth failing over a hygiene rule, so the outcome is
 * reported instead (a repo that *tracks* files under `.claude/` cannot be helped by an
 * ignore rule at all — git never ignores a tracked file). Never creates the worktree
 * directory: called only after a successful `worktree add` or a `status` that proved
 * the checkout is there, so a missing dir means there is nothing to hide — and
 * conjuring one would make the next attempt see an unregistered leftover.
 */
function ensureClaudeIgnored(dir) {
  if (!existsSync(dir)) return false;
  const gi = join(dir, '.claude', '.gitignore');
  try {
    const existing = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
    if (existing.split(/\r?\n/).includes('*')) return true;
    mkdirSync(dirname(gi), { recursive: true });
    // A file whose last line has no newline — one the target repo may well *track* —
    // would otherwise have this comment spliced onto that line, corrupting the pattern
    // and carrying the damage into the PR.
    const lead = existing !== '' && !existing.endsWith('\n') ? '\n' : '';
    appendFileSync(gi, `${lead}# soma: the lead's guard settings live here and must never enter the PR.\n`
      + '# `*` ignores this file too, so .claude/ is invisible to git in this worktree.\n*\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * The worktree for one task, created or reused: `{dir, branch, base_sha, reused, excluded}`.
 *
 * Runs under the repo lock, so a manual spawn racing a watchdog tick cannot have two
 * `worktree add`s in flight on one repo. `base_sha` is the tip of `origin/<base>` as
 * just fetched — the digest's "based on develop@abc123" — and on a reused worktree
 * that is the remote tip *now*, not necessarily what the checkout forked from: a reused
 * worktree may already carry the previous attempt's commits, which is what `reused`
 * exists to tell the spawner so the brief can say so. `excluded` reports whether
 * `.claude/` is hidden from git in the returned checkout: false is a PR-hygiene warning
 * worth surfacing, not a failed spawn.
 */
export function ensureWorktree({ repo, taskId, base, repoPath } = {}, run = defaultRun) {
  checkName(repo, 'ensureWorktree: repo');
  checkName(taskId, 'ensureWorktree: taskId', { flat: true });
  checkName(base, 'ensureWorktree: base');
  // `repoPath` is `cfg.repos[task.repo]?.path` at the call site, so a repo missing from
  // soma.json arrives as undefined; unguarded it reaches execFileSync as an undefined
  // argv entry and surfaces as a child_process type error nobody can act on.
  if (typeof repoPath !== 'string' || repoPath === '') {
    throw new TypeError(`ensureWorktree(${taskId}): repoPath must be a non-empty string — is ${JSON.stringify(repo)} configured in soma.json repos?`);
  }

  return withRepoLock(repo, () => {
    const dir = worktreeDir(repo, taskId);
    mkdirSync(dirname(dir), { recursive: true });

    // The base first, and loudly: everything after this is based on it.
    const fetched = run(['-C', repoPath, 'fetch', 'origin', base]);
    if (fetched.code !== 0) throw new Error(`ensureWorktree(${taskId}): git fetch origin ${base} failed in ${repoPath}: ${why(fetched)}`);
    const parsed = run(['-C', repoPath, 'rev-parse', `origin/${base}`]);
    if (parsed.code !== 0) throw new Error(`ensureWorktree(${taskId}): git rev-parse origin/${base} failed: ${why(parsed)}`);
    const base_sha = parsed.stdout.trim();
    if (!base_sha) throw new Error(`ensureWorktree(${taskId}): git rev-parse origin/${base} returned no sha`);

    const listing = run(['-C', repoPath, 'worktree', 'list']);
    if (listing.code !== 0) throw new Error(`ensureWorktree(${taskId}): git worktree list failed in ${repoPath}: ${why(listing)}`);
    const entry = listedEntry(listing.stdout, dir);

    const nominal = `soma/${taskId}`;
    let branch = nominal;
    if (entry) {
      const status = run(['-C', dir, 'status', '--porcelain']);
      // Reusable means three things, and each `false` here is a state a lead must not
      // be launched into. Not verifiably clean is treated as dirty: a
      // deleted-but-registered worktree makes `status` exit 128 with empty output,
      // which reads as clean to a check that only looks at the text. And the checkout
      // has to be on a branch of *this* task — a detached HEAD or someone else's branch
      // sitting at soma's path would otherwise be reported as the lead's branch, and
      // soma-pr would open the PR from whatever that is.
      const clean = status.code === 0 && status.stdout.trim() === '';
      const ours = entry.branch === nominal || entry.branch?.startsWith(`${nominal}-r`);
      if (clean && ours) {
        // The branch git says it is on, not the nominal one: after a retry this
        // checkout is on `-r2`, while `soma/<id>` still exists — so naming the nominal
        // branch would send soma-pr at the wrong head with nothing looking wrong.
        return { dir, branch: entry.branch, base_sha, reused: true, excluded: ensureClaudeIgnored(dir) };
      }
      const removed = run(['-C', repoPath, 'worktree', 'remove', dir, '--force']);
      if (removed.code !== 0) {
        // A registration whose directory is gone is prunable rather than removable on
        // older gits; without this the `add` below dies on git's "missing but already
        // registered" and the task can never spawn again.
        const pruned = run(['-C', repoPath, 'worktree', 'prune']);
        // Prune's exit code says nothing about whether *this* entry went: it exits 0
        // having pruned nothing (verified on 2.39.5). A locked worktree — or one whose
        // submodules have modifications — refuses `--force` and demands `-f -f`, prune
        // then reports success, and the `add` below dies on the cause-hiding
        // `fatal: '<dir>' already exists` *having already created the branch*. So every
        // watchdog respawn would burn one suffix until MAX_RETRY_BRANCHES, leaving ~50
        // dead soma/<id>-r* branches in the operator's repo and never saying why.
        // Verify, and hand back the real cause instead.
        const after = run(['-C', repoPath, 'worktree', 'list']);
        if (after.code !== 0 || listedEntry(after.stdout, dir)) {
          throw new Error(`ensureWorktree(${taskId}): ${dir} is still registered in ${repoPath} — worktree remove --force failed (${why(removed)})`
            + `${pruned.code !== 0 ? ` and prune failed too (${why(pruned)})` : ' and prune cleared nothing'}`
            + `; if it is locked, run \`git -C ${repoPath} worktree unlock ${dir}\` or force it with \`worktree remove -f -f\`, then retry`);
        }
      }
      branch = nextRetryBranch(nominal, entry.branch);
    } else if (existsSync(dir) && !isEmptyDir(dir)) {
      // Not ours to delete: an unregistered directory with files in it is either an
      // operator's or the wreckage of one, and `worktree add` would only say "already
      // exists". Both directions of guessing lose data, so neither is taken.
      throw new Error(`ensureWorktree(${taskId}): ${dir} exists but is not a registered worktree of ${repoPath} — move it aside or delete it, then retry`);
    }

    branch = firstFreeBranch({ repoPath, run, nominal, from: branch, taskId });
    const added = run(['-C', repoPath, 'worktree', 'add', dir, '--no-track', '-b', branch, `origin/${base}`]);
    // `--no-track`: a branch tracking `origin/<base>` lets a bare `git push` under
    // push.default=upstream write straight to the base branch, which the writeback
    // guard's command-text deny cannot see coming. Without an upstream, that push fails.
    if (added.code !== 0) throw new Error(`ensureWorktree(${taskId}): git worktree add ${dir} -b ${branch} origin/${base} failed: ${why(added)}`);
    return { dir, branch, base_sha, reused: false, excluded: ensureClaudeIgnored(dir) };
  }, run);
}

/** Whether `dir` has nothing in it — a path that is not a directory counts as occupied. */
function isEmptyDir(dir) {
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

/**
 * Unregister and delete one task's worktree. A worktree git no longer knows about is a
 * no-op, so `soma gc` can be re-run; anything else is thrown.
 *
 * `repoPath` is optional and worth passing: without it git runs *inside* the worktree,
 * which works while the directory is alive (verified on git 2.39.5) and cannot work
 * once it is gone. The branch is deliberately left behind — a draft PR references it,
 * and it holds whatever the attempt committed.
 */
export function removeWorktree({ repo, taskId, force = false, repoPath } = {}, run = defaultRun) {
  checkName(repo, 'removeWorktree: repo');
  checkName(taskId, 'removeWorktree: taskId', { flat: true });
  if (repoPath !== undefined && (typeof repoPath !== 'string' || repoPath === '')) {
    throw new TypeError(`removeWorktree(${taskId}): repoPath must be a non-empty string when given, got ${JSON.stringify(repoPath)}`);
  }

  withRepoLock(repo, () => {
    const dir = worktreeDir(repo, taskId);
    const at = repoPath || dir;
    const listing = run(['-C', at, 'worktree', 'list']);
    if (listing.code !== 0) {
      throw new Error(`removeWorktree(${taskId}): git worktree list failed in ${at} (${why(listing)}) — pass repoPath when the worktree dir may already be gone`);
    }
    if (!listedEntry(listing.stdout, dir)) return;
    const removed = run(['-C', at, 'worktree', 'remove', dir, ...(force ? ['--force'] : [])]);
    // Loud on purpose: git refuses to remove a worktree with uncommitted work, and a
    // silent no-op there is how `soma gc` reports success having freed nothing.
    if (removed.code !== 0) throw new Error(`removeWorktree(${taskId}): git worktree remove ${dir} failed: ${why(removed)}`);
  }, run);
}
