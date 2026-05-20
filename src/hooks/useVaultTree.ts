import { useCallback, useMemo, useRef, useState } from "react";
import { listVaultTree } from "../api/tauri";
import { toast } from "../lib/toast";
import { buildTakenIndex, TakenIndex } from "../lib/names";
import { VaultEntry } from "../types";

export interface UseVaultTree {
  entries: VaultEntry[];
  setEntries: React.Dispatch<React.SetStateAction<VaultEntry[]>>;
  refreshTree: (vault: string) => Promise<void>;
  /** Memoised path/name Sets for O(1) collision checks. */
  taken: TakenIndex;
  /** Mirror of `taken`, so handlers that don't depend on a re-render
   *  can read the latest value without invalidating their callback
   *  identity. */
  takenRef: React.MutableRefObject<TakenIndex>;
}

export function useVaultTree(): UseVaultTree {
  const [entries, setEntries] = useState<VaultEntry[]>([]);

  const taken = useMemo(() => buildTakenIndex(entries), [entries]);
  const takenRef = useRef(taken);
  takenRef.current = taken;

  const refreshTree = useCallback(async (vault: string) => {
    try {
      const tree = await listVaultTree(vault);
      setEntries(tree);
    } catch (e: any) {
      toast.error(`Failed to read vault: ${e?.message || e}`);
    }
  }, []);

  return { entries, setEntries, refreshTree, taken, takenRef };
}
