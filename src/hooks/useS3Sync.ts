import { useCallback, useState, useTransition } from "react";
import { listVaultTree, syncVaultIPC } from "../api/tauri";
import { toast } from "../lib/toast";
import { S3Settings, SyncReport, VaultEntry } from "../types";
import type { RaceGuard } from "./useRaceGuard";

export interface UseS3Sync {
  syncing: boolean;
  s3Ready: boolean;
  handleSync: () => Promise<void>;
}

interface UseS3SyncArgs {
  vaultPath: string | null;
  s3: S3Settings;
  /** The vault-activation race guard. We snapshot its token at sync
   *  start and, on completion, check `isCurrent` — if the vault has
   *  switched, we drop the report and don't refresh the tree. */
  activationGuard: RaceGuard;
  flushPendingWrites: (relPath?: string) => Promise<void>;
  setEntries: React.Dispatch<React.SetStateAction<VaultEntry[]>>;
}

export function useS3Sync({
  vaultPath, s3, activationGuard, flushPendingWrites, setEntries,
}: UseS3SyncArgs): UseS3Sync {
  const [syncing, setSyncing] = useState(false);
  const [, startTreeTransition] = useTransition();

  // S3 readiness — all five required fields filled + vault picked.
  const s3Ready =
    !!vaultPath &&
    !!s3.endpoint.trim() &&
    !!s3.region.trim() &&
    !!s3.bucket.trim() &&
    !!s3.accessKeyId.trim() &&
    !!s3.secretAccessKey.trim();

  const handleSync = useCallback(async () => {
    if (!vaultPath || !s3Ready || syncing) return;
    // Bind the sync to the vault that was active at click time. If the
    // user switches vault mid-sync, the activation token will have
    // moved and we discard the stale tree refresh + final toast.
    const myToken = activationGuard.peek();
    setSyncing(true);
    const progressId = toast.progress("Syncing vault with S3…");
    // Flush pending buffered writes so the sync sees the user's latest
    // keystrokes — otherwise a fast sync after typing could miss them.
    await flushPendingWrites();
    try {
      const report: SyncReport = await syncVaultIPC(vaultPath, s3);
      if (!activationGuard.isCurrent(myToken)) {
        toast.dismiss(progressId);
        return;
      }
      const parts: string[] = [];
      if (report.uploaded > 0) parts.push(`↑${report.uploaded}`);
      if (report.downloaded > 0) parts.push(`↓${report.downloaded}`);
      if (report.deleted > 0) parts.push(`🗑${report.deleted}`);
      if (parts.length === 0) parts.push("already up to date");
      const summary = `Sync done — ${parts.join(" ")}`;
      if (report.errors.length > 0) {
        toast.resolveProgress(
          progressId,
          "error",
          `${summary} · ${report.errors.length} error${report.errors.length === 1 ? "" : "s"}`,
        );
      } else {
        toast.resolveProgress(progressId, "success", summary);
      }
      // Skip the (potentially 500–1000 ms on a 5k-file vault) tree
      // walk when sync didn't actually change anything locally.
      //   uploaded → file was already in the local tree (we sent it up)
      //   deleted  → remote-only cleanup of excluded keys (.git/, etc.)
      //   skipped  → both sides equal within mtime skew
      // Only `downloaded` can introduce new local files or folders that
      // weren't in `entries` already, so it's the sole trigger for a
      // refresh. Externally-created files (a CLI dropping a new note)
      // are NOT covered — they show up on the next vault open or on
      // the first sync that ends with downloaded > 0. Worth the
      // trade-off; this hot path runs every time the user hits Sync.
      if (report.downloaded > 0) {
        // Wrap in a transition so committing the (potentially huge)
        // updated tree is interruptible: input stays responsive, the
        // sidebar updates in the background.
        const fresh = await listVaultTree(vaultPath);
        if (!activationGuard.isCurrent(myToken)) return;
        startTreeTransition(() => {
          setEntries(fresh);
        });
      }
    } catch (e: any) {
      if (activationGuard.isCurrent(myToken)) {
        toast.resolveProgress(
          progressId,
          "error",
          `Sync failed: ${e?.message || e || "Unknown error"}`,
        );
      } else {
        toast.dismiss(progressId);
      }
    } finally {
      if (activationGuard.isCurrent(myToken)) setSyncing(false);
    }
  }, [vaultPath, s3, s3Ready, syncing, flushPendingWrites, activationGuard, setEntries]);

  return { syncing, s3Ready, handleSync };
}
