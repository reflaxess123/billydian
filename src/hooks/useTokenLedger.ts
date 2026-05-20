import { useCallback, useEffect, useRef, useState } from "react";
import { writeVaultFile } from "../api/tauri";
import { EMPTY_LEDGER, EMPTY_TOKENS, TokenLedger, TokenStats } from "../types";

const TOKENS_FILE = ".billydian/tokens.json";
const PERSIST_DEBOUNCE_MS = 300;

export interface UseTokenLedger {
  ledger: TokenLedger;
  /** Mirror of `ledger` for callbacks that need to read without
   *  depending on the value — depending on ledger would invalidate
   *  their useCallback identity on every AI generation in the
   *  background. */
  ledgerRef: React.MutableRefObject<TokenLedger>;
  setLedger: React.Dispatch<React.SetStateAction<TokenLedger>>;
  addTokens: (relPath: string, delta: TokenStats) => void;
  /** Mark the ledger dirty after a raw setLedger from rename/delete
   *  handlers, so the debounce-persist effect picks it up. */
  markDirty: () => void;
}

export function useTokenLedger(vaultPath: string | null): UseTokenLedger {
  const [ledger, setLedger] = useState<TokenLedger>(EMPTY_LEDGER);
  const dirtyRef = useRef(false);
  const ledgerRef = useRef(ledger);
  ledgerRef.current = ledger;

  useEffect(() => {
    if (!vaultPath) return;
    if (!dirtyRef.current) return;
    const t = setTimeout(() => {
      writeVaultFile(vaultPath, TOKENS_FILE, JSON.stringify(ledger, null, 2)).catch(
        (err) => console.error("save tokens:", err),
      );
      dirtyRef.current = false;
    }, PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [ledger, vaultPath]);

  const addTokens = useCallback((relPath: string, delta: TokenStats) => {
    dirtyRef.current = true;
    setLedger((prev) => {
      const before = prev.byFile[relPath] ?? EMPTY_TOKENS;
      return {
        byFile: {
          ...prev.byFile,
          [relPath]: {
            prompt: before.prompt + delta.prompt,
            completion: before.completion + delta.completion,
            total: before.total + delta.total,
          },
        },
      };
    });
  }, []);

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
  }, []);

  return { ledger, ledgerRef, setLedger, addTokens, markDirty };
}
