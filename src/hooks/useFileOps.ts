import { startTransition, useCallback, useEffect, useState } from "react";
import {
  deleteVaultFile, readVaultFile, renameVaultFile, writeVaultFile,
} from "../api/tauri";
import { toast } from "../lib/toast";
import { sanitizeFileName, TakenIndex, uniqueName } from "../lib/names";
import { MindMapNodeData, OpenDoc, TokenLedger, VaultEntry } from "../types";

// 150ms grace covers the in-app race where rename/create updates
// `openDoc.relPath` to a path the tree refresh hasn't seen yet —
// without grace, the validate effect would snap openDoc back to null
// every time the user renamed.
const OPEN_DOC_VALIDATE_GRACE_MS = 150;

export interface UseFileOps {
  openDoc: OpenDoc;
  setOpenDoc: React.Dispatch<React.SetStateAction<OpenDoc>>;
  handleOpenFile: (entry: VaultEntry) => Promise<void>;
  handleDeleteFile: (entry: VaultEntry) => Promise<void>;
  handleCreateBlankNote: () => Promise<void>;
  handleManualRename: (newRawTitle: string) => Promise<void>;
}

interface UseFileOpsArgs {
  vaultPath: string | null;
  taken: TakenIndex;
  takenRef: React.MutableRefObject<TakenIndex>;
  refreshTree: (vault: string) => Promise<void>;
  flushPendingWrites: (relPath?: string) => Promise<void>;
  cancelPending: (relPath: string) => void;
  ledgerRef: React.MutableRefObject<TokenLedger>;
  setLedger: React.Dispatch<React.SetStateAction<TokenLedger>>;
  markLedgerDirty: () => void;
}

export function useFileOps(args: UseFileOpsArgs): UseFileOps {
  const {
    vaultPath, taken, takenRef, refreshTree, flushPendingWrites,
    cancelPending, ledgerRef, setLedger, markLedgerDirty,
  } = args;

  const [openDoc, setOpenDoc] = useState<OpenDoc>(null);

  // Validate openDoc against the tree — if its path vanishes (an
  // external rename, a sync delete, a CLI move) clear the viewer so
  // the user doesn't keep editing a phantom and saving back into thin
  // air. The grace timer absorbs in-app rename races where the new
  // path arrives in `entries` a render tick after we updated openDoc.
  useEffect(() => {
    if (!openDoc) return;
    if (taken.paths.has(openDoc.relPath)) return;
    const t = window.setTimeout(() => {
      if (!takenRef.current.paths.has(openDoc.relPath)) {
        setOpenDoc(null);
      }
    }, OPEN_DOC_VALIDATE_GRACE_MS);
    return () => window.clearTimeout(t);
    // takenRef is stable; including it would be a no-op (refs don't
    // trigger re-renders), but keeping the lint surface honest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taken, openDoc]);

  const handleOpenFile = useCallback(async (entry: VaultEntry) => {
    if (!vaultPath || entry.kind === "dir") return;
    await flushPendingWrites();
    try {
      if (entry.kind === "image") {
        setOpenDoc({ kind: "image", relPath: entry.path });
        return;
      }
      if (entry.kind === "docx") {
        setOpenDoc({ kind: "docx", relPath: entry.path });
        return;
      }
      const raw = await readVaultFile(vaultPath, entry.path);
      // Wrap the heavy setOpenDoc in a transition so React 19 mounts
      // the new viewer at low priority — input stays responsive.
      startTransition(() => {
        if (entry.kind === "md") {
          setOpenDoc({ kind: "md", relPath: entry.path, content: raw });
        } else if (entry.kind === "mindmap") {
          const tree: MindMapNodeData = JSON.parse(raw);
          setOpenDoc({ kind: "mindmap", relPath: entry.path, tree });
        } else {
          setOpenDoc({ kind: "md", relPath: entry.path, content: raw });
        }
      });
    } catch (e: any) {
      toast.error(`Could not open ${entry.path}: ${e?.message || e}`);
    }
  }, [vaultPath, flushPendingWrites]);

  const handleDeleteFile = useCallback(async (entry: VaultEntry) => {
    if (!vaultPath) return;
    // Drop pending buffered writes for the file we're deleting —
    // otherwise the debounce timer would re-create it 400ms later.
    cancelPending(entry.path);
    try {
      await deleteVaultFile(vaultPath, entry.path);
      setOpenDoc((cur) => (cur && cur.relPath === entry.path ? null : cur));
      if (ledgerRef.current.byFile[entry.path]) {
        markLedgerDirty();
        setLedger((prev) => {
          const { [entry.path]: _, ...rest } = prev.byFile;
          return { ...prev, byFile: rest };
        });
      }
      await refreshTree(vaultPath);
    } catch (e: any) {
      toast.error(`Could not delete ${entry.path}: ${e?.message || e}`);
    }
  }, [vaultPath, cancelPending, refreshTree, ledgerRef, setLedger, markLedgerDirty]);

  const handleCreateBlankNote = useCallback(async () => {
    if (!vaultPath) return;
    try {
      const name = uniqueName("Untitled", "md", takenRef.current.names);
      await writeVaultFile(vaultPath, name, "# Untitled\n\n");
      setOpenDoc({ kind: "md", relPath: name, content: "# Untitled\n\n" });
      await refreshTree(vaultPath);
    } catch (e: any) {
      toast.error(`Could not create note: ${e?.message || e}`);
    }
  }, [vaultPath, refreshTree, takenRef]);

  const handleManualRename = useCallback(async (newRawTitle: string) => {
    if (!openDoc || openDoc.kind !== "md" || !vaultPath) return;
    const safe = sanitizeFileName(newRawTitle);
    if (!safe || safe === "untitled") {
      toast.error("That name isn't usable.");
      return;
    }
    const slash = openDoc.relPath.lastIndexOf("/");
    const dirPart = slash >= 0 ? openDoc.relPath.slice(0, slash + 1) : "";
    let candidate = `${dirPart}${safe}.md`;
    let n = 2;
    while (candidate !== openDoc.relPath && takenRef.current.paths.has(candidate)) {
      candidate = `${dirPart}${safe} ${n}.md`;
      n++;
    }
    if (candidate === openDoc.relPath) return;
    try {
      await flushPendingWrites(openDoc.relPath);
      await renameVaultFile(vaultPath, openDoc.relPath, candidate);
      if (ledgerRef.current.byFile[openDoc.relPath]) {
        markLedgerDirty();
        setLedger((prev) => {
          const { [openDoc.relPath]: stat, ...rest } = prev.byFile;
          return { byFile: { ...rest, [candidate]: stat } };
        });
      }
      setOpenDoc({ ...openDoc, relPath: candidate });
      await refreshTree(vaultPath);
    } catch (e: any) {
      toast.error(`Rename failed: ${e?.message || e}`);
    }
  }, [
    openDoc, vaultPath, flushPendingWrites, refreshTree, takenRef,
    ledgerRef, setLedger, markLedgerDirty,
  ]);

  return {
    openDoc, setOpenDoc,
    handleOpenFile, handleDeleteFile, handleCreateBlankNote, handleManualRename,
  };
}
