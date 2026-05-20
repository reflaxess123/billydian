import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  AppSettings,
  DEFAULT_SETTINGS,
  EMPTY_LEDGER,
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
import { TitleBar } from "./components/TitleBar";
import { SettingsModal } from "./components/SettingsModal";
import { Sparkles, AlertTriangle, X, FolderOpen } from "lucide-react";
import "./App.css";

// ─── Vault-local config & token paths (inside <vault>/.mindmapper/) ───────
const CONFIG_FILE = ".mindmapper/config.json";
const TOKENS_FILE = ".mindmapper/tokens.json";

// ─── Tauri command wrappers ───────────────────────────────────────────────
type GenResponse = {
  data: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

async function tauriGetVaultPath(): Promise<string | null> {
  return await invoke<string | null>("get_vault_path");
}
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
  const [settings, setSettings] = useState<AppSettings>({ ...DEFAULT_SETTINGS });
  const [ledger, setLedger] = useState<TokenLedger>(EMPTY_LEDGER);
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [openDoc, setOpenDoc] = useState<OpenDoc>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [generatingNodeId, setGeneratingNodeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ── Bootstrap: read vault pointer, then load settings + ledger + tree ──
  useEffect(() => {
    (async () => {
      try {
        const path = await tauriGetVaultPath();
        if (path) {
          await activateVault(path);
        }
      } catch (e) {
        console.error("vault bootstrap failed", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // We debounce-persist to disk on every change so the user never has to
  // hit "save."
  const settingsDirtyRef = useRef(false);
  useEffect(() => {
    if (!vaultPath) return;
    if (!settingsDirtyRef.current) return;
    const t = setTimeout(() => {
      tauriWriteFile(vaultPath, CONFIG_FILE, JSON.stringify(settings, null, 2)).catch(
        (err) => console.error("save settings:", err),
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
    await tauriSetVaultPath(path);
    setVaultPath(path);
    setOpenDoc(null);

    // Load settings (or fall back to defaults & write them on first run)
    const cfg = await readOpt(path, CONFIG_FILE);
    let nextSettings: AppSettings = { ...DEFAULT_SETTINGS };
    if (cfg) {
      try {
        const parsed = JSON.parse(cfg);
        nextSettings = { ...DEFAULT_SETTINGS, ...parsed, s3: { ...DEFAULT_SETTINGS.s3, ...(parsed.s3 || {}) } };
      } catch (e) {
        console.error("config.json parse:", e);
      }
    }
    setSettings(nextSettings);

    // Load token ledger
    const tk = await readOpt(path, TOKENS_FILE);
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

    await refreshTree(path);
  }, [refreshTree]);

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
      const raw = await tauriReadFile(vaultPath, entry.path);
      if (entry.kind === "md") {
        setOpenDoc({ kind: "md", relPath: entry.path, content: raw });
      } else if (entry.kind === "mindmap") {
        const tree: MindMapNodeData = JSON.parse(raw);
        setOpenDoc({ kind: "mindmap", relPath: entry.path, tree });
      } else {
        // Treat anything else as plain text in the markdown editor.
        setOpenDoc({ kind: "md", relPath: entry.path, content: raw });
      }
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
  const sanitizeFileName = (s: string): string => {
    return s
      .replace(/[<>:"/\\|?* -]/g, " ")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 64) || "untitled";
  };

  const uniqueName = async (base: string, ext: string): Promise<string> => {
    // Find a free `<base>.ext`, `<base> 2.ext`, … inside the vault.
    if (!vaultPath) return `${base}.${ext}`;
    const isTaken = (name: string) => {
      const walk = (arr: VaultEntry[]): boolean =>
        arr.some((e) => (e.name === name) || (e.children && walk(e.children)));
      return walk(entries);
    };
    let candidate = `${base}.${ext}`;
    let n = 2;
    while (isTaken(candidate)) {
      candidate = `${base} ${n}.${ext}`;
      n++;
    }
    return candidate;
  };

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
    setIsLoading(true);
    setError(null);
    try {
      const cmd = kind === "mindmap" ? "generate_mindmap" : "generate_note";
      const responseStr = await invoke<string>(cmd, {
        apiKey: settings.apiKey.trim(),
        topic,
        model: settings.model,
      });
      const r: GenResponse = JSON.parse(responseStr);

      const safe = sanitizeFileName(topic);
      const ext = kind === "mindmap" ? "mindmap" : "md";
      const name = await uniqueName(safe, ext);

      if (kind === "mindmap") {
        // Persist as JSON, opens in canvas
        await tauriWriteFile(vaultPath, name, r.data);
        const tree: MindMapNodeData = JSON.parse(r.data);
        setOpenDoc({ kind: "mindmap", relPath: name, tree });
      } else {
        // Markdown body straight to file
        await tauriWriteFile(vaultPath, name, r.data);
        setOpenDoc({ kind: "md", relPath: name, content: r.data });
      }

      addTokens(name, {
        prompt: r.prompt_tokens,
        completion: r.completion_tokens,
        total: r.total_tokens,
      });
      await refreshTree(vaultPath);
    } catch (err: any) {
      surfaceError(String(err?.message || err || ""), "Generation failed");
    } finally {
      setIsLoading(false);
    }
  }, [vaultPath, settings.apiKey, settings.model, addTokens, refreshTree, entries]);

  // ── Mindmap operations (mirrors the old App logic but writes to disk) ─
  const cloneTree = (t: MindMapNodeData): MindMapNodeData => JSON.parse(JSON.stringify(t));

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
    const updated = cloneTree(openDoc.tree);
    mutate(updated);
    setOpenDoc({ ...openDoc, tree: updated });
    persistMindmap(openDoc.relPath, updated);
  }, [openDoc, persistMindmap]);

  const handleToggleCollapse = (id: string) => {
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
  };

  const handleEditNode = (id: string, newName: string) => {
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
  };

  const handleDeleteNode = (id: string) => {
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
  };

  const handleAddChildNode = (parentId: string) => {
    mutateMindmap((root) => {
      const newId = `node-${Date.now()}`;
      const visit = (n: MindMapNodeData): boolean => {
        if (n.id === parentId) {
          if (!n.children) n.children = [];
          n.children.push({ id: newId, name: "New Subtopic", children: [], isCollapsed: false });
          n.isCollapsed = false;
          return true;
        }
        return !!n.children?.some(visit);
      };
      visit(root);
    });
  };

  const handleAiExpandNode = async (nodeId: string) => {
    if (!openDoc || openDoc.kind !== "mindmap" || !vaultPath) return;
    if (!settings.apiKey.trim()) {
      setError("Set your OpenRouter API key in Settings first.");
      return;
    }
    setGeneratingNodeId(nodeId);
    setError(null);

    const tree = cloneTree(openDoc.tree);
    let targetName = "";
    const find = (n: MindMapNodeData): boolean => {
      if (n.id === nodeId) {
        targetName = n.name;
        return true;
      }
      return !!n.children?.some(find);
    };
    find(tree);
    if (!targetName) {
      setError("Target node not found.");
      setGeneratingNodeId(null);
      return;
    }

    try {
      const responseStr = await invoke<string>("extend_node", {
        apiKey: settings.apiKey.trim(),
        topicContext: tree.name,
        nodeLabel: targetName,
        model: settings.model,
      });
      const r: GenResponse = JSON.parse(responseStr);
      const newChildren: MindMapNodeData[] = JSON.parse(r.data);

      const append = (n: MindMapNodeData): boolean => {
        if (n.id === nodeId) {
          if (!n.children) n.children = [];
          const taken = new Set(n.children.map((c) => c.id));
          for (const c of newChildren) {
            if (taken.has(c.id)) c.id = `node-${Math.random().toString(36).slice(2, 11)}`;
            n.children.push(c);
          }
          n.isCollapsed = false;
          return true;
        }
        return !!n.children?.some(append);
      };
      append(tree);
      setOpenDoc({ ...openDoc, tree });
      await persistMindmap(openDoc.relPath, tree);
      addTokens(openDoc.relPath, {
        prompt: r.prompt_tokens,
        completion: r.completion_tokens,
        total: r.total_tokens,
      });
    } catch (err: any) {
      surfaceError(String(err?.message || err || ""), "AI expansion failed");
    } finally {
      setGeneratingNodeId(null);
    }
  };

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
      const name = await uniqueName("Untitled", "md");
      await tauriWriteFile(vaultPath, name, "# Untitled\n\n");
      setOpenDoc({ kind: "md", relPath: name, content: "# Untitled\n\n" });
      await refreshTree(vaultPath);
    } catch (e: any) {
      setError(`Could not create note: ${e?.message || e}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultPath, entries, refreshTree]);

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
    setTitleBusy(true);
    setError(null);
    try {
      const responseStr = await invoke<string>("generate_title", {
        apiKey: settings.apiKey.trim(),
        content: currentContent,
        model: settings.model,
      });
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
      surfaceError(String(err?.message || err || ""), "Title generation failed");
    } finally {
      setTitleBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openDoc, vaultPath, settings.apiKey, settings.model, ledger.byFile, refreshTree]);

  // Walk the tree to check if a path is already taken
  const existsInTree = (relPath: string): boolean => {
    const walk = (arr: VaultEntry[]): boolean =>
      arr.some((e) => e.path === relPath || (e.children && walk(e.children)));
    return walk(entries);
  };

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openDoc, vaultPath, entries, ledger.byFile, refreshTree]);

  // Derive a display title for the current note: basename without ext.
  const noteTitle = (() => {
    if (!openDoc || openDoc.kind !== "md") return "";
    const base = openDoc.relPath.split("/").slice(-1)[0];
    return base.replace(/\.[^.]+$/, "");
  })();

  // ── Derived: per-file tokens for current open doc, if AI-generated ────
  const fileTokens: TokenStats | null = useMemo(() => {
    if (!openDoc) return null;
    const t = ledger.byFile[openDoc.relPath];
    if (!t || t.total === 0) return null;
    return t;
  }, [openDoc, ledger]);

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="app-container">
      <Sidebar
        settings={settings}
        onSettingsChange={updateSettings}
        vaultPath={vaultPath}
        onPickVault={handlePickVault}
        entries={entries}
        activePath={openDoc?.relPath ?? null}
        onOpenFile={handleOpenFile}
        onDeleteFile={handleDeleteFile}
        onGenerate={handleGenerate}
        onCreateBlankNote={handleCreateBlankNote}
        isGenerating={isLoading}
        onOpenSettings={() => setSettingsOpen(true)}
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
                  <code> .mindmapper/ </code>subfolder.
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
              title={noteTitle}
              relPath={openDoc.relPath}
              initialContent={openDoc.content}
              fileKey={openDoc.relPath}
              onChange={handleNoteChange}
              mode={settings.noteMode}
              onModeChange={(m) => updateSettings({ ...settings, noteMode: m })}
              onGenerateTitle={handleGenerateTitle}
              titleBusy={titleBusy}
              onRename={handleManualRename}
              width={settings.noteWidth}
              onWidthChange={(w) => updateSettings({ ...settings, noteWidth: w })}
              fileTokens={fileTokens}
            />
          )}
        </div>
      </div>

      {settingsOpen && (
        <SettingsModal
          settings={settings}
          vaultPath={vaultPath}
          onChange={updateSettings}
          onClose={() => setSettingsOpen(false)}
          onPickVault={handlePickVault}
          onAfterSync={() => vaultPath && refreshTree(vaultPath)}
        />
      )}
    </div>
  );
}

export default App;
