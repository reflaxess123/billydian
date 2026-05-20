import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { produce } from "immer";
import {
  AppSettings,
  DEFAULT_SETTINGS,
  DeviceSecrets,
  EMPTY_LEDGER,
  EMPTY_SECRETS,
  EMPTY_TOKENS,
  MindMapNodeData,
  OpenDoc,
  TokenLedger,
  TokenStats,
  VaultEntry,
} from "./types";
import { Sidebar } from "./components/Sidebar";
import { MindMapCanvas } from "./components/MindMapCanvas";
import { NoteEditor } from "./components/NoteEditor";
import { ImageViewer } from "./components/ImageViewer";
import { DocxViewer } from "./components/DocxViewer";
import { TitleBar } from "./components/TitleBar";
import { SettingsModal } from "./components/SettingsModal";
import { Sparkles, AlertTriangle, X, FolderOpen } from "lucide-react";
import "./App.css";

export type SyncReport = {
  uploaded: number;
  downloaded: number;
  skipped: number;
  deleted: number;
  errors: string[];
};

// ─── Storage paths ────────────────────────────────────────────────────────
//
// Non-secret app state lives inside the vault so it syncs with notes:
//   <vault>/.billydian/config.json   theme, scale, mode, model, etc.
//   <vault>/.billydian/tokens.json   per-file AI token ledger
//
// Secrets live in the OS-managed app config dir, never inside the vault:
//   <app_config_dir>/secrets.json    OpenRouter key + S3 creds
// On Windows that's AppData\Roaming\Billydian\secrets.json — never visited
// by S3 sync, never copied to backup of the user's notes folder.
const CONFIG_FILE = ".billydian/config.json";
const TOKENS_FILE = ".billydian/tokens.json";

// Fields that get extracted to device-local secrets.json instead of
// living in the vault config. Kept here so the split/merge logic and
// the migration both reference the same source of truth.
function splitSettings(merged: AppSettings): {
  vaultLocal: Omit<AppSettings, "apiKey" | "s3">;
  deviceSecrets: DeviceSecrets;
} {
  const { apiKey, s3, ...rest } = merged;
  return { vaultLocal: rest, deviceSecrets: { apiKey, s3 } };
}

// ─── Tauri command wrappers ───────────────────────────────────────────────
type GenResponse = {
  data: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

async function tauriSetVaultPath(path: string): Promise<void> {
  await invoke("set_vault_path", { path });
}
async function tauriListTree(vault: string): Promise<VaultEntry[]> {
  return await invoke<VaultEntry[]>("list_vault_tree", { vault });
}
async function tauriReadFile(vault: string, rel: string): Promise<string> {
  return await invoke<string>("read_vault_file", { vault, rel });
}
async function tauriWriteFile(vault: string, rel: string, content: string): Promise<void> {
  await invoke("write_vault_file", { vault, rel, content });
}
async function tauriDeleteFile(vault: string, rel: string): Promise<void> {
  await invoke("delete_vault_file", { vault, rel });
}

// Device-local secret blob (lives outside vault — see header comment).
async function tauriReadSecrets(): Promise<string> {
  return await invoke<string>("read_secrets");
}
async function tauriWriteSecrets(content: string): Promise<void> {
  await invoke("write_secrets", { content });
}

// Optional read — returns null if the file doesn't exist yet.
async function readOpt(vault: string, rel: string): Promise<string | null> {
  try {
    return await tauriReadFile(vault, rel);
  } catch {
    return null;
  }
}

function App() {
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [knownVaults, setKnownVaults] = useState<string[]>([]);
  const [settings, setSettings] = useState<AppSettings>({ ...DEFAULT_SETTINGS });
  const [ledger, setLedger] = useState<TokenLedger>(EMPTY_LEDGER);
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [openDoc, setOpenDoc] = useState<OpenDoc>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [generatingNodeId, setGeneratingNodeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncReport, setSyncReport] = useState<SyncReport | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  // useTransition lets us commit a fresh entries tree (potentially
  // 1000+ rows) at low priority, so the UI doesn't freeze for the
  // 50-150ms reconciliation. Used after S3 sync and other bulk tree
  // refreshes that might land alongside user input.
  const [, startTreeTransition] = useTransition();

  // ── Race guards ────────────────────────────────────────────────────────
  // Every async branch that captures state needs to verify it's still
  // the active branch when it resolves. Two counters do all the work:
  //
  //   activationTokenRef  — incremented on every vault switch. If a
  //     vault-A walk lands AFTER the user already switched to vault B,
  //     comparing the captured token to the ref catches it and we
  //     discard the stale tree/settings/ledger.
  //
  //   inFlightGenRef      — incremented on every AI call (generate,
  //     expand, title) and S3 sync. If the user clicks "generate" twice
  //     in a row, the slow first response can't overwrite the fresh
  //     second response or double-charge the token ledger.
  //
  // Both refs persist across renders without triggering re-renders
  // themselves — they're pure mutation counters.
  const activationTokenRef = useRef(0);
  const inFlightGenRef = useRef(0);
  // Replaced by `takenRef` (a path/name Set built off `entries` via
  // useMemo). The Set is rebuilt only when `entries` changes; callbacks
  // read via the ref so their identity stays stable across sync ticks.

  // ── Bootstrap: read vault pointer, then load settings + ledger + tree ──
  useEffect(() => {
    (async () => {
      try {
        const state = await invoke<{ vaults: string[]; active: string | null }>(
          "get_known_vaults",
        );
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

  const refreshKnownVaults = useCallback(async () => {
    try {
      const state = await invoke<{ vaults: string[]; active: string | null }>(
        "get_known_vaults",
      );
      setKnownVaults(state.vaults);
    } catch (e) {
      console.error("refreshKnownVaults:", e);
    }
  }, []);

  // ── Theme class ───────────────────────────────────────────────────────
  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === "light") {
      root.classList.remove("dark");
      root.classList.add("light");
    } else {
      root.classList.remove("light");
      root.classList.add("dark");
    }
  }, [settings.theme]);

  // ── UI scale (Chromium `zoom` on body so layout reflows) ──────────────
  useEffect(() => {
    (document.body.style as any).zoom = String(settings.uiScale);
  }, [settings.uiScale]);

  // ── Settings I/O ──────────────────────────────────────────────────────
  // Debounce-persist on every change so the user never has to hit "save."
  // The merged AppSettings is split into:
  //   - vault-local config.json (theme, scale, mode, model, etc.)
  //   - device-local secrets.json (apiKey, S3 creds)
  // Both are written; failures on either side are logged but don't bubble.
  const settingsDirtyRef = useRef(false);
  useEffect(() => {
    if (!vaultPath) return;
    if (!settingsDirtyRef.current) return;
    const t = setTimeout(() => {
      const { vaultLocal, deviceSecrets } = splitSettings(settings);
      tauriWriteFile(vaultPath, CONFIG_FILE, JSON.stringify(vaultLocal, null, 2)).catch(
        (err) => console.error("save settings:", err),
      );
      tauriWriteSecrets(JSON.stringify(deviceSecrets, null, 2)).catch(
        (err) => console.error("save secrets:", err),
      );
      settingsDirtyRef.current = false;
    }, 300);
    return () => clearTimeout(t);
  }, [settings, vaultPath]);

  const updateSettings = useCallback((next: AppSettings) => {
    settingsDirtyRef.current = true;
    setSettings(next);
  }, []);

  // ── Ledger I/O ────────────────────────────────────────────────────────
  const ledgerDirtyRef = useRef(false);
  useEffect(() => {
    if (!vaultPath) return;
    if (!ledgerDirtyRef.current) return;
    const t = setTimeout(() => {
      tauriWriteFile(vaultPath, TOKENS_FILE, JSON.stringify(ledger, null, 2)).catch(
        (err) => console.error("save tokens:", err),
      );
      ledgerDirtyRef.current = false;
    }, 300);
    return () => clearTimeout(t);
  }, [ledger, vaultPath]);

  // ── Vault activation & tree refresh ───────────────────────────────────
  const refreshTree = useCallback(async (vault: string) => {
    try {
      const tree = await tauriListTree(vault);
      setEntries(tree);
    } catch (e: any) {
      setError(`Failed to read vault: ${e?.message || e}`);
    }
  }, []);

  const activateVault = useCallback(async (path: string) => {
    // Bump the activation token *before* awaiting — every subsequent
    // setState in this branch checks `myToken === activationTokenRef.current`
    // before committing, so if the user starts a new vault switch (or
    // removes a vault) mid-load, the stale completion drops on the floor
    // instead of clobbering fresh state.
    const myToken = ++activationTokenRef.current;
    await tauriSetVaultPath(path);
    if (myToken !== activationTokenRef.current) return;
    setVaultPath(path);
    setOpenDoc(null);
    // Refresh the known list — first-time activation adds this vault.
    await refreshKnownVaults();
    if (myToken !== activationTokenRef.current) return;

    // Load vault-local settings + device-local secrets in parallel; merge
    // into one AppSettings object for the rest of the app to consume.
    const [cfg, secRaw] = await Promise.all([
      readOpt(path, CONFIG_FILE),
      tauriReadSecrets().catch(() => "{}"),
    ]);
    if (myToken !== activationTokenRef.current) return;

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
        // One-time migration: older versions stored apiKey + s3 inside
        // <vault>/.billydian/config.json. If those fields are present
        // and device-local secrets are still empty, hoist them over.
        const hadVaultSecret =
          (typeof parsed.apiKey === "string" && parsed.apiKey.trim() !== "") ||
          (parsed.s3 && Object.values(parsed.s3).some(
            (v) => typeof v === "string" && v.trim() !== "",
          ));
        if (hadVaultSecret) {
          // Only migrate fields the device side doesn't already hold —
          // device wins on conflict so a second vault doesn't overwrite
          // creds the user already entered.
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
          // Secrets always come from the device blob — never from vault.
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
    setSettings(nextSettings);

    // Fire-and-forget the migration write: secrets to device blob,
    // sanitized config back to vault. We don't await — the next debounce
    // tick would do it anyway, this just ensures the vault file stops
    // leaking creds even if the user never edits settings again.
    if (migratedFromVault) {
      tauriWriteSecrets(JSON.stringify(secrets, null, 2)).catch((err) =>
        console.error("migrate secrets:", err),
      );
      const { vaultLocal } = splitSettings(nextSettings);
      tauriWriteFile(path, CONFIG_FILE, JSON.stringify(vaultLocal, null, 2)).catch(
        (err) => console.error("migrate config:", err),
      );
    }

    // Load token ledger
    const tk = await readOpt(path, TOKENS_FILE);
    if (myToken !== activationTokenRef.current) return;
    let nextLedger: TokenLedger = { byFile: {} };
    if (tk) {
      try {
        const parsed = JSON.parse(tk);
        // Backwards-compat: older files had `all` too — we ignore it now.
        nextLedger = { byFile: parsed.byFile ?? {} };
      } catch (e) {
        console.error("tokens.json parse:", e);
      }
    }
    setLedger(nextLedger);

    const tree = await tauriListTree(path);
    if (myToken !== activationTokenRef.current) return;
    setEntries(tree);
  }, [refreshKnownVaults]);

  const handleRemoveVault = useCallback(async (path: string) => {
    try {
      const state = await invoke<{ vaults: string[]; active: string | null }>(
        "remove_vault",
        { path },
      );
      setKnownVaults(state.vaults);
      // If we removed the active vault, switch to the next one (or
      // clear the workspace if none left).
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
      setError(`Could not remove vault: ${e?.message || e}`);
    }
  }, [vaultPath, activateVault]);

  const handlePickVault = useCallback(async () => {
    try {
      const result = await openDialog({
        directory: true,
        multiple: false,
        title: "Pick your MindMapper vault folder",
      });
      if (typeof result === "string" && result.length > 0) {
        await activateVault(result);
        setSettingsOpen(false);
      }
    } catch (e: any) {
      setError(`Could not pick folder: ${e?.message || e}`);
    }
  }, [activateVault]);

  // ── Token bookkeeping ─────────────────────────────────────────────────
  const addTokens = useCallback((relPath: string, delta: TokenStats) => {
    ledgerDirtyRef.current = true;
    setLedger((prev) => {
      const fileBefore = prev.byFile[relPath] ?? EMPTY_TOKENS;
      return {
        byFile: {
          ...prev.byFile,
          [relPath]: {
            prompt: fileBefore.prompt + delta.prompt,
            completion: fileBefore.completion + delta.completion,
            total: fileBefore.total + delta.total,
          },
        },
      };
    });
  }, []);

  // ── Open / save documents ─────────────────────────────────────────────
  const handleOpenFile = useCallback(async (entry: VaultEntry) => {
    if (!vaultPath || entry.kind === "dir") return;
    try {
      if (entry.kind === "image") {
        // Don't pre-read here — the OpenDoc only carries the relPath.
        // `ImageViewer` reads the bytes via the raw-binary IPC channel
        // (`read_vault_file_blob`) and owns the URL.createObjectURL +
        // revokeObjectURL lifecycle. This keeps a 5-20MB base64 string
        // out of React state, and unmount-time revoke prevents long-
        // session WebView memory bloat on image-heavy workflows.
        setOpenDoc({ kind: "image", relPath: entry.path });
        return;
      }
      if (entry.kind === "docx") {
        // Same shape as image — `DocxViewer` reads the raw bytes itself
        // and runs them through mammoth (lazy-loaded chunk) to render
        // an HTML preview, plus the "Convert to .md" button.
        setOpenDoc({ kind: "docx", relPath: entry.path });
        return;
      }
      const raw = await tauriReadFile(vaultPath, entry.path);
      // Wrap the heavy setOpenDoc in a transition so React 19 processes
      // the mount/unmount at low priority. The previous file's huge
      // markdown unmount AND the new file's huge markdown mount get
      // sliced across frames — the file-tree click feels instant even
      // if the parsed tree itself takes 200-300ms to reconcile.
      startTransition(() => {
        if (entry.kind === "md") {
          setOpenDoc({ kind: "md", relPath: entry.path, content: raw });
        } else if (entry.kind === "mindmap") {
          const tree: MindMapNodeData = JSON.parse(raw);
          setOpenDoc({ kind: "mindmap", relPath: entry.path, tree });
        } else {
          // Treat anything else as plain text in the markdown editor.
          setOpenDoc({ kind: "md", relPath: entry.path, content: raw });
        }
      });
    } catch (e: any) {
      setError(`Could not open ${entry.path}: ${e?.message || e}`);
    }
  }, [vaultPath]);

  const handleDeleteFile = useCallback(async (entry: VaultEntry) => {
    if (!vaultPath) return;
    try {
      await tauriDeleteFile(vaultPath, entry.path);
      if (openDoc && openDoc.relPath === entry.path) setOpenDoc(null);
      // Drop the per-file counter; all-time stays untouched
      if (ledger.byFile[entry.path]) {
        ledgerDirtyRef.current = true;
        setLedger((prev) => {
          const { [entry.path]: _, ...rest } = prev.byFile;
          return { ...prev, byFile: rest };
        });
      }
      await refreshTree(vaultPath);
    } catch (e: any) {
      setError(`Could not delete ${entry.path}: ${e?.message || e}`);
    }
  }, [vaultPath, openDoc, ledger.byFile, refreshTree]);

  // ── Generation (note / mindmap) ───────────────────────────────────────
  // Reserved Windows device names + control chars + trailing dot/space
  // all cause weird OS behavior (silent file vanish, console-handle open).
  // The backend `resolve_under_vault` rejects them too, but catching here
  // gives a clean UI error instead of a Rust panic surface.
  const RESERVED_WIN_NAMES = useMemo(
    () =>
      new Set([
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
      ]),
    [],
  );
  const sanitizeFileName = useCallback(
    (s: string): string => {
      const cleaned = s
        // eslint-disable-next-line no-control-regex
        .replace(/[<>:"/\\|?*\x00-\x1f -]/g, " ")
        .trim()
        .replace(/\s+/g, " ")
        // Windows silently strips trailing dot/space → path collisions.
        .replace(/[. ]+$/, "")
        .slice(0, 64);
      if (!cleaned) return "untitled";
      // Reserved name (stem before first dot) → bump to "untitled"
      // rather than silently emit a file the OS will refuse to read.
      const stem = cleaned.split(".")[0]?.toUpperCase() ?? "";
      if (RESERVED_WIN_NAMES.has(stem)) return "untitled";
      return cleaned;
    },
    [RESERVED_WIN_NAMES],
  );

  // Build a flat Set<string> of every existing path/name in the current
  // tree — lets the rename / unique-name logic do O(1) lookups instead
  // of recursing the tree per candidate. Rebuilt only when `entries`
  // actually changes, not on every settings tick.
  const taken = useMemo(() => {
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
  }, [entries]);
  const takenRef = useRef(taken);
  takenRef.current = taken;

  const uniqueName = useCallback(
    (base: string, ext: string): string => {
      if (!vaultPath) return `${base}.${ext}`;
      let candidate = `${base}.${ext}`;
      let n = 2;
      while (takenRef.current.names.has(candidate)) {
        candidate = `${base} ${n}.${ext}`;
        n++;
      }
      return candidate;
    },
    [vaultPath],
  );

  // Walk the tree to check if a path is already taken — Set-backed,
  // ref-read so callbacks that use it don't depend on `entries`.
  const existsInTree = useCallback((relPath: string): boolean => {
    return takenRef.current.paths.has(relPath);
  }, []);

  const surfaceError = (raw: string, fallback: string) => {
    setError(
      raw.startsWith("OpenRouter") || raw.startsWith("Failed to")
        ? raw
        : `${fallback}: ${raw || "Unknown error"}`,
    );
  };

  const handleGenerate = useCallback(async (kind: "note" | "mindmap", topic: string) => {
    if (!vaultPath) {
      setError("Pick a vault folder first.");
      return;
    }
    if (!settings.apiKey.trim()) {
      setError("Set your OpenRouter API key in Settings first.");
      return;
    }
    // Guard: if the user clicks "generate" again while one is in flight,
    // the slow first response is now stale and must NOT clobber the
    // fresh state or double-charge the token ledger.
    const myGen = ++inFlightGenRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const cmd = kind === "mindmap" ? "generate_mindmap" : "generate_note";
      const responseStr = await invoke<string>(cmd, {
        apiKey: settings.apiKey.trim(),
        topic,
        model: settings.model,
      });
      if (myGen !== inFlightGenRef.current) return;
      const r: GenResponse = JSON.parse(responseStr);

      const safe = sanitizeFileName(topic);
      const ext = kind === "mindmap" ? "mindmap" : "md";
      const name = uniqueName(safe, ext);

      if (kind === "mindmap") {
        // Persist as JSON, opens in canvas
        await tauriWriteFile(vaultPath, name, r.data);
        if (myGen !== inFlightGenRef.current) return;
        const tree: MindMapNodeData = JSON.parse(r.data);
        setOpenDoc({ kind: "mindmap", relPath: name, tree });
      } else {
        // Markdown body straight to file
        await tauriWriteFile(vaultPath, name, r.data);
        if (myGen !== inFlightGenRef.current) return;
        setOpenDoc({ kind: "md", relPath: name, content: r.data });
      }

      addTokens(name, {
        prompt: r.prompt_tokens,
        completion: r.completion_tokens,
        total: r.total_tokens,
      });
      await refreshTree(vaultPath);
    } catch (err: any) {
      if (myGen === inFlightGenRef.current) {
        surfaceError(String(err?.message || err || ""), "Generation failed");
      }
    } finally {
      if (myGen === inFlightGenRef.current) setIsLoading(false);
    }
  }, [vaultPath, settings.apiKey, settings.model, addTokens, refreshTree, sanitizeFileName, uniqueName]);

  // ── Mindmap operations (mirrors the old App logic but writes to disk) ─
  // Tree mutations go through immer's `produce`: instead of full
  // JSON.parse(JSON.stringify) — ~5-10ms on an 80KB tree — immer
  // structurally shares unchanged subtrees and only allocates the
  // ancestors of the mutated node. For a 500-node mindmap that's
  // ~10x faster per edit and a fraction of the GC pressure.
  const persistMindmap = useCallback(async (relPath: string, tree: MindMapNodeData) => {
    if (!vaultPath) return;
    try {
      await tauriWriteFile(vaultPath, relPath, JSON.stringify(tree, null, 2));
    } catch (e: any) {
      setError(`Failed to save mind map: ${e?.message || e}`);
    }
  }, [vaultPath]);

  const mutateMindmap = useCallback((mutate: (root: MindMapNodeData) => void) => {
    if (!openDoc || openDoc.kind !== "mindmap") return;
    const updated = produce(openDoc.tree, mutate);
    setOpenDoc({ ...openDoc, tree: updated });
    persistMindmap(openDoc.relPath, updated);
  }, [openDoc, persistMindmap]);

  // All five mindmap handlers wrapped in useCallback so MindMapCanvas
  // and the per-node memo'd MindMapNode don't see a fresh prop identity
  // every time the parent re-renders for an unrelated reason (sync tick,
  // theme toggle, S3 typing). Without these, a 100-node graph re-runs
  // its full reconciliation on every parent update.
  const handleToggleCollapse = useCallback(
    (id: string) => {
      mutateMindmap((root) => {
        const visit = (n: MindMapNodeData): boolean => {
          if (n.id === id) {
            n.isCollapsed = !n.isCollapsed;
            return true;
          }
          return !!n.children?.some(visit);
        };
        visit(root);
      });
    },
    [mutateMindmap],
  );

  const handleEditNode = useCallback(
    (id: string, newName: string) => {
      mutateMindmap((root) => {
        const visit = (n: MindMapNodeData): boolean => {
          if (n.id === id) {
            n.name = newName;
            return true;
          }
          return !!n.children?.some(visit);
        };
        visit(root);
      });
    },
    [mutateMindmap],
  );

  const handleDeleteNode = useCallback(
    (id: string) => {
      if (!openDoc || openDoc.kind !== "mindmap") return;
      if (openDoc.tree.id === id) {
        setError("Root node cannot be deleted.");
        return;
      }
      mutateMindmap((root) => {
        const visit = (n: MindMapNodeData): boolean => {
          if (!n.children) return false;
          const idx = n.children.findIndex((c) => c.id === id);
          if (idx !== -1) {
            n.children.splice(idx, 1);
            return true;
          }
          return n.children.some(visit);
        };
        visit(root);
      });
    },
    [openDoc, mutateMindmap],
  );

  const handleAddChildNode = useCallback(
    (parentId: string) => {
      mutateMindmap((root) => {
        const newId = `node-${Date.now()}`;
        const visit = (n: MindMapNodeData): boolean => {
          if (n.id === parentId) {
            if (!n.children) n.children = [];
            n.children.push({
              id: newId,
              name: "New Subtopic",
              children: [],
              isCollapsed: false,
            });
            n.isCollapsed = false;
            return true;
          }
          return !!n.children?.some(visit);
        };
        visit(root);
      });
    },
    [mutateMindmap],
  );

  const handleAiExpandNode = useCallback(async (nodeId: string) => {
    if (!openDoc || openDoc.kind !== "mindmap" || !vaultPath) return;
    if (!settings.apiKey.trim()) {
      setError("Set your OpenRouter API key in Settings first.");
      return;
    }
    // Race guard: rapid double-click on the same / different node must
    // not leak a stale AI response into the tree after the user moved on.
    const myGen = ++inFlightGenRef.current;
    setGeneratingNodeId(nodeId);
    setError(null);

    // Walk current (immutable) tree once to grab the target's name.
    // No clone needed for this read pass.
    let targetName = "";
    const find = (n: MindMapNodeData): boolean => {
      if (n.id === nodeId) {
        targetName = n.name;
        return true;
      }
      return !!n.children?.some(find);
    };
    find(openDoc.tree);
    if (!targetName) {
      setError("Target node not found.");
      setGeneratingNodeId(null);
      return;
    }

    try {
      const responseStr = await invoke<string>("extend_node", {
        apiKey: settings.apiKey.trim(),
        topicContext: openDoc.tree.name,
        nodeLabel: targetName,
        model: settings.model,
      });
      if (myGen !== inFlightGenRef.current) return;
      const r: GenResponse = JSON.parse(responseStr);
      const newChildren: MindMapNodeData[] = JSON.parse(r.data);

      // Structural-share clone via immer — only the path from root to
      // the target node allocates; everything else is reused.
      const updated = produce(openDoc.tree, (draft) => {
        const append = (n: MindMapNodeData): boolean => {
          if (n.id === nodeId) {
            if (!n.children) n.children = [];
            const taken = new Set(n.children.map((c) => c.id));
            for (const c of newChildren) {
              if (taken.has(c.id)) {
                c.id = `node-${Math.random().toString(36).slice(2, 11)}`;
              }
              n.children.push(c);
            }
            n.isCollapsed = false;
            return true;
          }
          return !!n.children?.some(append);
        };
        append(draft);
      });
      setOpenDoc({ ...openDoc, tree: updated });
      await persistMindmap(openDoc.relPath, updated);
      if (myGen !== inFlightGenRef.current) return;
      addTokens(openDoc.relPath, {
        prompt: r.prompt_tokens,
        completion: r.completion_tokens,
        total: r.total_tokens,
      });
    } catch (err: any) {
      if (myGen === inFlightGenRef.current) {
        surfaceError(String(err?.message || err || ""), "AI expansion failed");
      }
    } finally {
      if (myGen === inFlightGenRef.current) setGeneratingNodeId(null);
    }
  }, [openDoc, settings.apiKey, settings.model, persistMindmap, addTokens, vaultPath]);

  // ── Note content save (debounced inside the editor) ───────────────────
  const handleNoteChange = useCallback(async (next: string) => {
    if (!openDoc || openDoc.kind !== "md" || !vaultPath) return;
    try {
      await tauriWriteFile(vaultPath, openDoc.relPath, next);
      setOpenDoc({ ...openDoc, content: next });
    } catch (e: any) {
      setError(`Failed to save note: ${e?.message || e}`);
    }
  }, [openDoc, vaultPath]);

  // ── Blank-note creation (no AI) ───────────────────────────────────────
  const handleCreateBlankNote = useCallback(async () => {
    if (!vaultPath) return;
    try {
      const name = uniqueName("Untitled", "md");
      await tauriWriteFile(vaultPath, name, "# Untitled\n\n");
      setOpenDoc({ kind: "md", relPath: name, content: "# Untitled\n\n" });
      await refreshTree(vaultPath);
    } catch (e: any) {
      setError(`Could not create note: ${e?.message || e}`);
    }
  }, [vaultPath, refreshTree, uniqueName]);

  // ── Title generation: AI returns a short title; we rename the file ────
  const [titleBusy, setTitleBusy] = useState(false);
  const handleGenerateTitle = useCallback(async (currentContent: string) => {
    if (!openDoc || openDoc.kind !== "md" || !vaultPath) return;
    if (!settings.apiKey.trim()) {
      setError("Set your OpenRouter API key in Settings first.");
      return;
    }
    if (!currentContent.trim()) {
      setError("Note is empty — nothing to title.");
      return;
    }
    const myGen = ++inFlightGenRef.current;
    setTitleBusy(true);
    setError(null);
    try {
      const responseStr = await invoke<string>("generate_title", {
        apiKey: settings.apiKey.trim(),
        content: currentContent,
        model: settings.model,
      });
      if (myGen !== inFlightGenRef.current) return;
      const r: GenResponse = JSON.parse(responseStr);
      const rawTitle = r.data.trim();
      const safe = sanitizeFileName(rawTitle);
      if (!safe || safe === "untitled") {
        setError("AI returned an unusable title.");
        return;
      }

      // Resolve target filename in the same folder as the current note
      const slash = openDoc.relPath.lastIndexOf("/");
      const dirPart = slash >= 0 ? openDoc.relPath.slice(0, slash + 1) : "";
      let candidate = `${dirPart}${safe}.md`;
      let n = 2;
      while (candidate !== openDoc.relPath && existsInTree(candidate)) {
        candidate = `${dirPart}${safe} ${n}.md`;
        n++;
      }
      if (candidate === openDoc.relPath) {
        // Title already matches — nothing to do
      } else {
        await invoke("rename_vault_file", {
          vault: vaultPath,
          from: openDoc.relPath,
          to: candidate,
        });
        if (myGen !== inFlightGenRef.current) return;
        // Move per-file tokens to the new path
        if (ledger.byFile[openDoc.relPath]) {
          ledgerDirtyRef.current = true;
          setLedger((prev) => {
            const { [openDoc.relPath]: stat, ...rest } = prev.byFile;
            return { ...prev, byFile: { ...rest, [candidate]: stat } };
          });
        }
        setOpenDoc({ ...openDoc, relPath: candidate });
        await refreshTree(vaultPath);
      }

      // Account tokens against the (possibly new) path
      addTokens(candidate, {
        prompt: r.prompt_tokens,
        completion: r.completion_tokens,
        total: r.total_tokens,
      });
    } catch (err: any) {
      if (myGen === inFlightGenRef.current) {
        surfaceError(String(err?.message || err || ""), "Title generation failed");
      }
    } finally {
      if (myGen === inFlightGenRef.current) setTitleBusy(false);
    }
  }, [
    openDoc, vaultPath, settings.apiKey, settings.model, ledger.byFile,
    refreshTree, sanitizeFileName, existsInTree, addTokens,
  ]);

  // ── Manual inline rename from the title bar ────────────────────────────
  const handleManualRename = useCallback(async (newRawTitle: string) => {
    if (!openDoc || openDoc.kind !== "md" || !vaultPath) return;
    const safe = sanitizeFileName(newRawTitle);
    if (!safe || safe === "untitled") {
      setError("That name isn't usable.");
      return;
    }
    const slash = openDoc.relPath.lastIndexOf("/");
    const dirPart = slash >= 0 ? openDoc.relPath.slice(0, slash + 1) : "";
    let candidate = `${dirPart}${safe}.md`;
    let n = 2;
    while (candidate !== openDoc.relPath && existsInTree(candidate)) {
      candidate = `${dirPart}${safe} ${n}.md`;
      n++;
    }
    if (candidate === openDoc.relPath) return; // nothing to do
    try {
      await invoke("rename_vault_file", {
        vault: vaultPath,
        from: openDoc.relPath,
        to: candidate,
      });
      if (ledger.byFile[openDoc.relPath]) {
        ledgerDirtyRef.current = true;
        setLedger((prev) => {
          const { [openDoc.relPath]: stat, ...rest } = prev.byFile;
          return { byFile: { ...rest, [candidate]: stat } };
        });
      }
      setOpenDoc({ ...openDoc, relPath: candidate });
      await refreshTree(vaultPath);
    } catch (e: any) {
      setError(`Rename failed: ${e?.message || e}`);
    }
  }, [openDoc, vaultPath, ledger.byFile, refreshTree, sanitizeFileName, existsInTree]);

  // S3 readiness — all five fields filled + vault picked.
  const s3Ready =
    !!vaultPath &&
    !!settings.s3.endpoint.trim() &&
    !!settings.s3.region.trim() &&
    !!settings.s3.bucket.trim() &&
    !!settings.s3.accessKeyId.trim() &&
    !!settings.s3.secretAccessKey.trim();

  const handleSync = useCallback(async () => {
    if (!vaultPath || !s3Ready || syncing) return;
    // Bind the sync to the vault that was active at click time. If the
    // user switches vault mid-sync, the activation token will have moved
    // and we discard the stale report / tree refresh.
    const myToken = activationTokenRef.current;
    setSyncing(true);
    setSyncError(null);
    setSyncReport(null);
    try {
      const report = await invoke<SyncReport>("sync_vault", {
        vault: vaultPath,
        s3: settings.s3,
      });
      if (myToken !== activationTokenRef.current) return;
      setSyncReport(report);
      // Refresh tree — newly-downloaded files need to show up. Wrap in
      // a transition so committing the (potentially huge) updated tree
      // is interruptible: input stays responsive, the sidebar updates
      // in the background.
      const fresh = await tauriListTree(vaultPath);
      if (myToken !== activationTokenRef.current) return;
      startTreeTransition(() => {
        setEntries(fresh);
      });
    } catch (e: any) {
      if (myToken === activationTokenRef.current) {
        setSyncError(String(e?.message || e || "Sync failed"));
      }
    } finally {
      if (myToken === activationTokenRef.current) setSyncing(false);
    }
  }, [vaultPath, s3Ready, syncing, settings.s3]);

  // Auto-clear the sync feedback a few seconds after it lands — the
  // sidebar shows the result inline; we don't want it lingering forever.
  // Errors stick around a bit longer so the user can read them.
  useEffect(() => {
    if (syncing) return;
    if (!syncReport && !syncError) return;
    const linger = syncError ? 6000 : 3000;
    const t = setTimeout(() => {
      setSyncReport(null);
      setSyncError(null);
    }, linger);
    return () => clearTimeout(t);
  }, [syncing, syncReport, syncError]);

  // Stable callbacks for children — without these, Sidebar / NoteEditor /
  // SettingsModal each see a fresh function identity per render and
  // their `React.memo` shells fall through. The body uses the latest
  // settings via closure capture, so deps are intentionally narrow.
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const setNoteMode = useCallback(
    (m: AppSettings["noteMode"]) => {
      updateSettings({ ...settings, noteMode: m });
    },
    [settings, updateSettings],
  );
  const setNoteWidth = useCallback(
    (w: number) => {
      updateSettings({ ...settings, noteWidth: w });
    },
    [settings, updateSettings],
  );

  // Derive a display title for the current note: basename without ext.
  // Memoised so NoteEditor sees a stable string identity until openDoc
  // actually changes (avoids cascading re-renders of memo'd children).
  const noteTitle = useMemo(() => {
    if (!openDoc || openDoc.kind !== "md") return "";
    const base = openDoc.relPath.split("/").slice(-1)[0] ?? "";
    return base.replace(/\.[^.]+$/, "");
  }, [openDoc]);

  // ── Derived: per-file tokens for current open doc, if AI-generated ────
  // Narrow the dep to ONLY this file's entry — `ledger.byFile` mutates
  // every time tokens land on any file, but we only care about the
  // currently open one. Without this narrowing, an unrelated AI
  // generation in the background would invalidate this memo and force
  // the entire MindMapCanvas / NoteEditor subtree to re-render.
  const openRel = openDoc?.relPath;
  const fileTokenEntry = openRel ? ledger.byFile[openRel] : undefined;
  const fileTokens: TokenStats | null = useMemo(() => {
    if (!openDoc) return null;
    if (!fileTokenEntry || fileTokenEntry.total === 0) return null;
    return fileTokenEntry;
  }, [openDoc, fileTokenEntry]);

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="app-container">
      <Sidebar
        settings={settings}
        onSettingsChange={updateSettings}
        vaultPath={vaultPath}
        knownVaults={knownVaults}
        onPickVault={handlePickVault}
        onActivateVault={activateVault}
        onRemoveVault={handleRemoveVault}
        entries={entries}
        activePath={openDoc?.relPath ?? null}
        onOpenFile={handleOpenFile}
        onDeleteFile={handleDeleteFile}
        onGenerate={handleGenerate}
        onCreateBlankNote={handleCreateBlankNote}
        isGenerating={isLoading}
        onOpenSettings={openSettings}
        onSync={handleSync}
        s3Ready={s3Ready}
        syncing={syncing}
        syncReport={syncReport}
        syncError={syncError}
      />

      <div className="main-column">
        <TitleBar />

        <div className="workspace">
          {error && (
            <div className="error-banner">
              <AlertTriangle size={18} />
              <span>{error}</span>
              <button className="error-close-btn" onClick={() => setError(null)}>
                <X size={16} />
              </button>
            </div>
          )}

          {isLoading && (
            <div className="app-loader-overlay">
              <Sparkles size={48} className="loader-sparkle" />
              <p>Generating with AI…</p>
            </div>
          )}

          {!vaultPath ? (
            <div className="welcome-overlay">
              <div className="welcome-content">
                <div className="welcome-logo">
                  <img src="/icon.png" alt="Billydian" />
                </div>
                <h1>Welcome to Billydian</h1>
                <p>
                  Pick a folder to use as your vault. All your notes and mind
                  maps live there as plain files — <code>.md</code> for notes,{" "}
                  <code>.mindmap</code> for trees. Settings sit in a hidden
                  <code> .billydian/ </code>subfolder.
                </p>
                <button className="welcome-submit-btn" onClick={handlePickVault}>
                  <FolderOpen size={16} /> Choose vault folder
                </button>
              </div>
            </div>
          ) : !openDoc ? (
            <div className="welcome-overlay">
              <div className="welcome-content">
                <div className="welcome-logo">
                  <img src="/icon.png" alt="Billydian" />
                </div>
                <h1>Vault ready</h1>
                <p>
                  Pick a file on the left to open it, or use the generator above
                  the file tree to spin up a new <strong>note</strong> or{" "}
                  <strong>mind map</strong> by topic.
                </p>
              </div>
            </div>
          ) : openDoc.kind === "image" ? (
            <ImageViewer
              vaultPath={vaultPath}
              relPath={openDoc.relPath}
              alt={openDoc.relPath.split("/").slice(-1)[0]}
            />
          ) : openDoc.kind === "docx" ? (
            <DocxViewer
              vaultPath={vaultPath}
              relPath={openDoc.relPath}
              onConverted={async (newRel) => {
                // Refresh so the new .md shows up in the sidebar, then
                // open it. Read the freshly-written file so the editor
                // gets the latest content (not a stale cached version).
                await refreshTree(vaultPath);
                try {
                  const content = await tauriReadFile(vaultPath, newRel);
                  setOpenDoc({ kind: "md", relPath: newRel, content });
                } catch (e: any) {
                  setError(`Failed to open converted file: ${e?.message || e}`);
                }
              }}
            />
          ) : openDoc.kind === "mindmap" ? (
            <MindMapCanvas
              data={openDoc.tree}
              onToggleCollapse={handleToggleCollapse}
              onEdit={handleEditNode}
              onDelete={handleDeleteNode}
              onAddChild={handleAddChildNode}
              onAiExpand={handleAiExpandNode}
              generatingNodeId={generatingNodeId}
              fileTokens={fileTokens}
            />
          ) : (
            <NoteEditor
              // `key` forces a fresh mount on every file switch. Without
              // it, NoteEditor's internal `value` state would lag a
              // render behind the new `initialContent` prop — the
              // useEffect that resets state only fires AFTER commit —
              // and the user would briefly see the new title with the
              // PREVIOUS file's markdown body. With key=, React tears
              // the old instance down and mounts a new one atomically,
              // so title + content land in the same paint.
              key={openDoc.relPath}
              title={noteTitle}
              relPath={openDoc.relPath}
              initialContent={openDoc.content}
              fileKey={openDoc.relPath}
              onChange={handleNoteChange}
              mode={settings.noteMode}
              onModeChange={setNoteMode}
              onGenerateTitle={handleGenerateTitle}
              titleBusy={titleBusy}
              onRename={handleManualRename}
              width={settings.noteWidth}
              onWidthChange={setNoteWidth}
              fileTokens={fileTokens}
              isDark={settings.theme === "dark"}
            />
          )}
        </div>
      </div>

      {settingsOpen && (
        <SettingsModal
          settings={settings}
          onChange={updateSettings}
          onClose={closeSettings}
          onSync={handleSync}
          vaultPath={vaultPath}
          s3Ready={s3Ready}
          syncing={syncing}
          syncReport={syncReport}
          syncError={syncError}
        />
      )}
    </div>
  );
}

export default App;
