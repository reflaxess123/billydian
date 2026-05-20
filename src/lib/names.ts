// Pure helpers for filename validation, the path/name index, and
// unique-name generation. No React, no IPC — just data in / data out
// so any hook (or unit test) can call them.
import type { VaultEntry } from "../types";

// Reserved Windows device names + control chars + trailing dot/space
// all cause weird OS behavior (silent file vanish, console-handle open).
// The backend `resolve_under_vault` rejects them too, but catching here
// gives a clean UI error instead of a Rust panic surface.
const RESERVED_WIN_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

export function sanitizeFileName(s: string): string {
  const cleaned = s
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f -]/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    // Windows silently strips trailing dot/space → path collisions.
    .replace(/[. ]+$/, "")
    .slice(0, 64);
  if (!cleaned) return "untitled";
  // Reserved name (stem before first dot) → bump to "untitled" rather
  // than silently emit a file the OS will refuse to read.
  const stem = cleaned.split(".")[0]?.toUpperCase() ?? "";
  if (RESERVED_WIN_NAMES.has(stem)) return "untitled";
  return cleaned;
}

export interface TakenIndex {
  /** Every basename present anywhere in the tree (for uniqueName). */
  names: Set<string>;
  /** Every vault-relative path present in the tree (for existsInTree). */
  paths: Set<string>;
}

/** Build a flat Set<string> of every existing path/name in the current
 *  tree — lets rename / unique-name logic do O(1) lookups instead of
 *  recursing the tree per candidate. Caller memoises on `entries`. */
export function buildTakenIndex(entries: VaultEntry[]): TakenIndex {
  const names = new Set<string>();
  const paths = new Set<string>();
  const walk = (arr: VaultEntry[]) => {
    for (const e of arr) {
      names.add(e.name);
      paths.add(e.path);
      if (e.children && e.children.length > 0) walk(e.children);
    }
  };
  walk(entries);
  return { names, paths };
}

/** Generate a fresh basename not present in `taken` by appending " 2",
 *  " 3"… `taken` should be `buildTakenIndex(entries).names`. */
export function uniqueName(base: string, ext: string, taken: Set<string>): string {
  let candidate = `${base}.${ext}`;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base} ${n}.${ext}`;
    n++;
  }
  return candidate;
}
