/**
 * Reconcile: the fleet checkpoint against tmux reality.
 *
 * `tmux has-session` is the only liveness truth in soma, so one question is asked per
 * tick — which rows claim `spawned` while `lead-<id>` is gone? Those are the leads
 * `wd/revive.mjs` has to plan for. Naming them is all this does: it takes a fleet
 * *snapshot*, takes no lock, writes nothing, reads no clock. The tick owns the effects.
 * "Alive" here means what the caller put in the Set: since the pane census, the tick hands
 * over `liveSessions` MINUS the sessions whose pane the census read as a bare shell, so a
 * pane with `pane_dead=0` running `zsh` instead of claude is a dead lead to this function
 * without it knowing why. The filter lives in the tick; this contract does not move.
 *
 * A `spawned` row that is still being launched (`fleet.launching`) has no session YET rather
 * than none any more: `soma_spawn` claims the row and spawns outside the fleet lock, and the
 * session is the last thing a spawn creates. So it is left alone, neither dead nor
 * re-affirmed, until its mark is `LAUNCH_GRACE_MS` old; past that, a row with no session is
 * dead to this function again: usually a spawner that died, sometimes a launch slower than the
 * bound (`LAUNCH_GRACE_MS` says what that costs). The mark is dated by the `now` the tick hands
 * over (still no clock read here), and a caller that passes none gets the contract as it was
 * before the mark.
 *
 * Two things it deliberately does not do:
 *
 * - **It proposes no status transition.** `updates` re-affirms `spawned` for each dead
 *   lead rather than moving it to `failed`, because a missing session is not a verdict:
 *   revival still owes the lead three attempts (`planRevival`). The re-affirmation is
 *   safe by construction, and the reason is worth knowing before deleting it —
 *   `setTaskStatus` stamps `last_spawn_at` only on a *genuine* transition into
 *   `spawned` (its `!wasSpawned` guard names this reconciler), so replaying these
 *   updates every 30 s cannot push the 90 s stagger clock forward and starve admission.
 *   A `wd/admission.mjs` that never admitted anything while one lead ran is a bug this
 *   build has already paid for once.
 *
 * - **It does not look a session up by name in a plain object.** `aliveSessions` must
 *   be a Set (or Map): an object registry indexed `reg[name]` answers truthy for every
 *   `Object.prototype` key, which in this build produced a lead bound to *no* budget
 *   class — breakerless, in a fleet whose whole safety model is that breaker. The
 *   `lead-` prefix happens to hide the collision here, which is exactly why the
 *   structural requirement is enforced rather than assumed.
 */

import { launching } from '../fleet.mjs';

/**
 * Leads whose session has vanished: `{ updates, deadLeads }`.
 *
 * @param {{tasks: Array<{id: string, status: string}>}} fleet a checkpoint snapshot
 * @param {{has: (name: string) => boolean}} aliveSessions live tmux session names
 * @param {number} [now] the caller's clock, for launch marks; omitted, no row is read as launching
 */
export function reconcile(fleet, aliveSessions, now) {
  const tasks = fleet?.tasks;
  if (!Array.isArray(tasks)) {
    throw new TypeError(`reconcile: fleet.tasks must be an array, got ${describe(tasks)}`);
  }
  if (typeof aliveSessions?.has !== 'function') {
    throw new TypeError(
      `reconcile: aliveSessions must be a Set or Map, got ${describe(aliveSessions)} — an object indexed by session name reports every Object.prototype key as live`,
    );
  }

  const deadLeads = [];
  const updates = [];
  for (const t of tasks) {
    // Only `spawned` occupies a lead slot (see fleet.mjs's header): a done, failed,
    // skipped or blocked row has no session to miss, and a queued one never had one.
    if (t?.status !== 'spawned') continue;
    if (aliveSessions.has(`lead-${t.id}`)) continue;
    // Still being launched: not dead, and not re-affirmed either. See the module header.
    if (launching(t, now)) continue;
    deadLeads.push(t.id);
    updates.push({ id: t.id, status: 'spawned' });
  }
  return { updates, deadLeads };
}

/** A type name for an error message, without stringifying a caller's whole object. */
const describe = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
