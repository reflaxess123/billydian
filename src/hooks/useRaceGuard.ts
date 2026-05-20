import { useMemo, useRef } from "react";

export interface RaceGuard {
  /** Bump the counter and return the new token. Call this at the
   *  start of every async operation that might be overtaken by a
   *  newer request. */
  take: () => number;
  /** Read the current token without bumping it — useful for snapshot
   *  + later isCurrent() check (the user of the guard is observing,
   *  not initiating). */
  peek: () => number;
  /** Check whether `token` is still the most recent — i.e. nobody has
   *  called `take()` since the caller took its token. */
  isCurrent: (token: number) => boolean;
}

// Monotonic counter for "is this still the latest operation?" race
// checks. Two distinct uses today:
//
//   1. Vault activation — a tree-walk for vault A that lands AFTER
//      the user switched to vault B must be dropped on the floor.
//      Owned by useVaultActivation; useS3Sync borrows it to discard
//      stale post-sync state after a mid-flight vault switch.
//
//   2. AI requests — a slow first generate() that lands AFTER the
//      user fired a second one must not overwrite the fresh result
//      or double-charge the token ledger. Owned by useAi.
//
// Single-threaded JS means there's no torn read between take() and
// the eventual isCurrent() check — every async resume runs as one
// atomic microtask wrt the counter.
export function useRaceGuard(): RaceGuard {
  const ref = useRef(0);
  // Memoised so the returned object has stable identity across
  // renders — consumers can pass the whole guard down without
  // invalidating useCallback dep arrays on every render of the
  // owning hook.
  return useMemo<RaceGuard>(
    () => ({
      take: () => ++ref.current,
      peek: () => ref.current,
      isCurrent: (token: number) => token === ref.current,
    }),
    [],
  );
}
