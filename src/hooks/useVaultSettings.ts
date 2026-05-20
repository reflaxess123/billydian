import { useCallback, useEffect, useRef, useState } from "react";
import { writeSecrets, writeVaultFile } from "../api/tauri";
import { AppSettings, DEFAULT_SETTINGS } from "../types";
import { CONFIG_FILE, splitSettings } from "../lib/vaultSettings";

const PERSIST_DEBOUNCE_MS = 300;

export interface UseVaultSettings {
  settings: AppSettings;
  /** User-driven update — marks the persist effect dirty so changes
   *  land on disk after the debounce window. */
  updateSettings: (
    next: AppSettings | ((prev: AppSettings) => AppSettings),
  ) => void;
  /** Internal: useVaultActivation seeds settings without marking dirty
   *  so a fresh vault load doesn't trigger a no-op save. */
  setSettingsRaw: React.Dispatch<React.SetStateAction<AppSettings>>;
}

export function useVaultSettings(vaultPath: string | null): UseVaultSettings {
  const [settings, setSettings] = useState<AppSettings>({ ...DEFAULT_SETTINGS });
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (!vaultPath) return;
    if (!dirtyRef.current) return;
    const t = setTimeout(() => {
      const { vaultLocal, deviceSecrets } = splitSettings(settings);
      writeVaultFile(vaultPath, CONFIG_FILE, JSON.stringify(vaultLocal, null, 2)).catch(
        (err) => console.error("save settings:", err),
      );
      writeSecrets(JSON.stringify(deviceSecrets, null, 2)).catch(
        (err) => console.error("save secrets:", err),
      );
      dirtyRef.current = false;
    }, PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [settings, vaultPath]);

  const updateSettings = useCallback(
    (next: AppSettings | ((prev: AppSettings) => AppSettings)) => {
      dirtyRef.current = true;
      setSettings((prev) => (typeof next === "function" ? next(prev) : next));
    },
    [],
  );

  return { settings, updateSettings, setSettingsRaw: setSettings };
}
