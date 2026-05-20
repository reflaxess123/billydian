import { useCallback, useEffect, useRef } from "react";
import { writeVaultFile } from "../api/tauri";
import { toast } from "../lib/toast";

// Single coalesced timer per file. Markdown keystrokes and mindmap
// edits both flow through here so:
//   - we never write to disk faster than 400ms per file (previously a
//     fast typist or rapid node drags hit the FS on every keystroke /
//     every collapse, stalling the UI on a 80KB tree),
//   - on file-switch / vault-switch / sync we explicitly flush the
//     buffer so a stale buffer never lands on the wrong file (or after
//     the vault has been removed).
//
// `vaultPath` is mirrored into a ref every render so the timer
// callbacks read the current value without re-binding.

const WRITE_DEBOUNCE_MS = 400;

interface PendingEntry {
  content: string;
  timer: number;
}

export interface WriteQueue {
  queueWrite: (relPath: string, content: string) => void;
  /** Flush a single path, or all pending if omitted. */
  flushPendingWrites: (relPath?: string) => Promise<void>;
  /** Drop a single pending entry without writing it. */
  cancelPending: (relPath: string) => void;
  /** Drop every pending entry. Used on vault removal. */
  cancelAllPending: () => void;
}

export function useWriteQueue(vaultPath: string | null): WriteQueue {
  const pendingRef = useRef(new Map<string, PendingEntry>());
  const vaultPathRef = useRef<string | null>(null);
  vaultPathRef.current = vaultPath;

  const queueWrite = useCallback((relPath: string, content: string) => {
    const vault = vaultPathRef.current;
    if (!vault) return;
    const pending = pendingRef.current;
    const cur = pending.get(relPath);
    if (cur) window.clearTimeout(cur.timer);
    const timer = window.setTimeout(() => {
      const entry = pending.get(relPath);
      if (!entry) return;
      pending.delete(relPath);
      writeVaultFile(vault, relPath, entry.content).catch((e: any) =>
        toast.error(`Failed to save ${relPath}: ${e?.message || e}`),
      );
    }, WRITE_DEBOUNCE_MS);
    pending.set(relPath, { content, timer });
  }, []);

  const flushPendingWrites = useCallback(async (relPath?: string) => {
    const vault = vaultPathRef.current;
    if (!vault) return;
    const pending = pendingRef.current;
    const keys = relPath ? [relPath] : Array.from(pending.keys());
    await Promise.all(
      keys.map(async (k) => {
        const entry = pending.get(k);
        if (!entry) return;
        window.clearTimeout(entry.timer);
        pending.delete(k);
        try {
          await writeVaultFile(vault, k, entry.content);
        } catch (e: any) {
          console.error("flush write:", e);
        }
      }),
    );
  }, []);

  const cancelPending = useCallback((relPath: string) => {
    const pending = pendingRef.current;
    const cur = pending.get(relPath);
    if (cur) {
      window.clearTimeout(cur.timer);
      pending.delete(relPath);
    }
  }, []);

  const cancelAllPending = useCallback(() => {
    const pending = pendingRef.current;
    pending.forEach((entry) => window.clearTimeout(entry.timer));
    pending.clear();
  }, []);

  // Flush anything still buffered before the window unloads. Doesn't
  // help on a hard process kill, but covers normal app close + reload.
  useEffect(() => {
    const onBeforeUnload = () => {
      const pending = pendingRef.current;
      const vault = vaultPathRef.current;
      if (!vault) return;
      pending.forEach((entry, k) => {
        window.clearTimeout(entry.timer);
        // Synchronous fire-and-forget — we can't await on beforeunload.
        writeVaultFile(vault, k, entry.content).catch(() => {});
      });
      pending.clear();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  return { queueWrite, flushPendingWrites, cancelPending, cancelAllPending };
}
