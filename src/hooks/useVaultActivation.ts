import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  getKnownVaults, listVaultTree, readOptional, readSecrets,
  removeVaultIPC, setVaultPath as setVaultPathIPC, writeSecrets,
  writeVaultFile,
} from "../api/tauri";
import { toast } from "../lib/toast";
import {
  AppSettings, DEFAULT_SETTINGS, DeviceSecrets, EMPTY_SECRETS,
  OpenDoc, TokenLedger, VaultEntry,
} from "../types";
import { CONFIG_FILE, splitSettings, TOKENS_FILE } from "../lib/vaultSettings";
import { RaceGuard, useRaceGuard } from "./useRaceGuard";

export interface UseVaultActivation {
  knownVaults: string[];
  /** Bumped on every vault switch. useS3Sync (and any future hook
   *  that wants to be aborted by a vault switch) snapshots its token
   *  before the long-running operation and checks `isCurrent` on
   *  resume — stale results are dropped. */
  activationGuard: RaceGuard;
  activateVault: (path: string) => Promise<void>;
  handleRemoveVault: (path: string) => Promise<void>;
  handlePickVault: () => Promise<void>;
}

interface UseVaultActivationArgs {
  vaultPath: string | null;
  setVaultPath: React.Dispatch<React.SetStateAction<string | null>>;
  flushPendingWrites: (relPath?: string) => Promise<void>;
  cancelAllPending: () => void;
  setSettingsRaw: React.Dispatch<React.SetStateAction<AppSettings>>;
  setLedger: React.Dispatch<React.SetStateAction<TokenLedger>>;
  setEntries: React.Dispatch<React.SetStateAction<VaultEntry[]>>;
  setOpenDoc: React.Dispatch<React.SetStateAction<OpenDoc>>;
  /** Fired once a vault successfully activates — App uses this to
   *  close the settings modal if the user picked from inside it. */
  onActivated?: () => void;
}

// Owns everything that crosses the "vault A → vault B" boundary: the
// known-vaults registry, the multi-step activation flow (with its race
// guard + one-time legacy-secrets migration), and the pick/remove UI
// actions. Bootstrap useEffect runs once on mount to re-activate the
// last-active vault.
export function useVaultActivation(args: UseVaultActivationArgs): UseVaultActivation {
  const {
    vaultPath, setVaultPath, flushPendingWrites, cancelAllPending,
    setSettingsRaw, setLedger, setEntries, setOpenDoc, onActivated,
  } = args;

  const [knownVaults, setKnownVaults] = useState<string[]>([]);
  const activationGuard = useRaceGuard();

  const refreshKnownVaults = useCallback(async () => {
    try {
      const state = await getKnownVaults();
      setKnownVaults(state.vaults);
    } catch (e) {
      console.error("refreshKnownVaults:", e);
    }
  }, []);

  const activateVault = useCallback(async (path: string) => {
    // Flush pending buffered writes for the previous vault BEFORE
    // bumping the token. Pending entries reference paths relative to
    // whatever vault was active when they were queued — they'd land
    // in the wrong place after we switch.
    await flushPendingWrites();
    const myToken = activationGuard.take();
    await setVaultPathIPC(path);
    if (!activationGuard.isCurrent(myToken)) return;
    setVaultPath(path);
    setOpenDoc(null);
    await refreshKnownVaults();
    if (!activationGuard.isCurrent(myToken)) return;

    // Load vault-local settings + device-local secrets in parallel.
    const [cfg, secRaw] = await Promise.all([
      readOptional(path, CONFIG_FILE),
      readSecrets().catch(() => "{}"),
    ]);
    if (!activationGuard.isCurrent(myToken)) return;

    let secrets: DeviceSecrets = { ...EMPTY_SECRETS };
    try {
      const parsed = JSON.parse(secRaw) as Partial<DeviceSecrets>;
      secrets = {
        apiKey: parsed.apiKey ?? "",
        s3: { ...EMPTY_SECRETS.s3, ...(parsed.s3 || {}) },
      };
    } catch (e) {
      console.error("secrets.json parse:", e);
    }

    let nextSettings: AppSettings = { ...DEFAULT_SETTINGS };
    let migratedFromVault = false;
    if (cfg) {
      try {
        const parsed = JSON.parse(cfg);
        // One-time migration: older versions stored apiKey + s3
        // inside <vault>/.billydian/config.json. Hoist them to the
        // device blob if present and not already overridden.
        const hadVaultSecret =
          (typeof parsed.apiKey === "string" && parsed.apiKey.trim() !== "") ||
          (parsed.s3 && Object.values(parsed.s3).some(
            (v) => typeof v === "string" && v.trim() !== "",
          ));
        if (hadVaultSecret) {
          if (!secrets.apiKey && typeof parsed.apiKey === "string") {
            secrets.apiKey = parsed.apiKey;
          }
          if (parsed.s3) {
            for (const k of [
              "endpoint", "region", "accessKeyId", "secretAccessKey", "bucket", "prefix",
            ] as const) {
              const v = parsed.s3[k];
              if (typeof v === "string" && v.trim() && !secrets.s3[k]) {
                secrets.s3[k] = v;
              }
            }
          }
          migratedFromVault = true;
        }
        nextSettings = {
          ...DEFAULT_SETTINGS,
          ...parsed,
          apiKey: secrets.apiKey,
          s3: { ...DEFAULT_SETTINGS.s3, ...secrets.s3 },
        };
      } catch (e) {
        console.error("config.json parse:", e);
        nextSettings = {
          ...DEFAULT_SETTINGS,
          apiKey: secrets.apiKey,
          s3: { ...DEFAULT_SETTINGS.s3, ...secrets.s3 },
        };
      }
    } else {
      nextSettings = {
        ...DEFAULT_SETTINGS,
        apiKey: secrets.apiKey,
        s3: { ...DEFAULT_SETTINGS.s3, ...secrets.s3 },
      };
    }
    setSettingsRaw(nextSettings);

    if (migratedFromVault) {
      writeSecrets(JSON.stringify(secrets, null, 2)).catch((err) =>
        console.error("migrate secrets:", err),
      );
      const { vaultLocal } = splitSettings(nextSettings);
      writeVaultFile(path, CONFIG_FILE, JSON.stringify(vaultLocal, null, 2)).catch(
        (err) => console.error("migrate config:", err),
      );
    }

    const tk = await readOptional(path, TOKENS_FILE);
    if (!activationGuard.isCurrent(myToken)) return;
    let nextLedger: TokenLedger = { byFile: {} };
    if (tk) {
      try {
        const parsed = JSON.parse(tk);
        nextLedger = { byFile: parsed.byFile ?? {} };
      } catch (e) {
        console.error("tokens.json parse:", e);
      }
    }
    setLedger(nextLedger);

    const tree = await listVaultTree(path);
    if (!activationGuard.isCurrent(myToken)) return;
    setEntries(tree);
    onActivated?.();
  }, [
    flushPendingWrites, setVaultPath, setOpenDoc, refreshKnownVaults,
    setSettingsRaw, setLedger, setEntries, onActivated, activationGuard,
  ]);

  const handleRemoveVault = useCallback(async (path: string) => {
    if (vaultPath === path) cancelAllPending();
    try {
      const state = await removeVaultIPC(path);
      setKnownVaults(state.vaults);
      if (vaultPath === path) {
        if (state.active) {
          await activateVault(state.active);
        } else {
          setVaultPath(null);
          setOpenDoc(null);
          setEntries([]);
        }
      }
    } catch (e: any) {
      toast.error(`Could not remove vault: ${e?.message || e}`);
    }
  }, [vaultPath, cancelAllPending, activateVault, setVaultPath, setOpenDoc, setEntries]);

  const handlePickVault = useCallback(async () => {
    try {
      const result = await openDialog({
        directory: true,
        multiple: false,
        title: "Pick your MindMapper vault folder",
      });
      if (typeof result === "string" && result.length > 0) {
        await activateVault(result);
      }
    } catch (e: any) {
      toast.error(`Could not pick folder: ${e?.message || e}`);
    }
  }, [activateVault]);

  // Bootstrap on mount — read the known-vaults list + activate the
  // last-active one if any. Runs once; subsequent re-renders skip via
  // the empty dep array.
  useEffect(() => {
    (async () => {
      try {
        const state = await getKnownVaults();
        setKnownVaults(state.vaults);
        if (state.active) {
          await activateVault(state.active);
        }
      } catch (e) {
        console.error("vault bootstrap failed", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    knownVaults, activationGuard,
    activateVault, handleRemoveVault, handlePickVault,
  };
}
