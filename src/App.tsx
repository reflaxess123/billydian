import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSettings, TokenStats } from "./types";
import { readVaultFile } from "./api/tauri";
import { useWriteQueue } from "./hooks/useWriteQueue";
import { useTokenLedger } from "./hooks/useTokenLedger";
import { useVaultSettings } from "./hooks/useVaultSettings";
import { useVaultTree } from "./hooks/useVaultTree";
import { useFileOps } from "./hooks/useFileOps";
import { useVaultActivation } from "./hooks/useVaultActivation";
import { useS3Sync } from "./hooks/useS3Sync";
import { useAi } from "./hooks/useAi";
import { useMindmapOps } from "./hooks/useMindmapOps";
import { Sidebar } from "./components/Sidebar";
import { MindMapCanvas } from "./components/MindMapCanvas";
import { NoteEditor } from "./components/NoteEditor";
import { ImageViewer } from "./components/ImageViewer";
import { DocxViewer } from "./components/DocxViewer";
import { TitleBar } from "./components/TitleBar";
import { SettingsModal } from "./components/SettingsModal";
import { ViewerBoundary } from "./components/ViewerBoundary";
import { ToastContainer } from "./components/ToastContainer";
import { toast } from "./lib/toast";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Sparkles, FolderOpen } from "lucide-react";
import "./App.css";

// Thin composition shell. The big-bang useVault hook was split into
// four focused hooks (settings, tree, fileOps, activation) — App
// stitches them together in dependency order.
//
// Storage paths:
//   <vault>/.billydian/config.json   theme, scale, mode, model, …
//   <vault>/.billydian/tokens.json   per-file AI token ledger
//   <app_config_dir>/secrets.json    OpenRouter key + S3 creds
// (Secrets live in the OS-managed app config dir, never inside the
// vault, so S3 sync never carries them off the machine.)
function App() {
  // ── Top-level state that crosses hook boundaries ──────────────────
  // vaultPath sits at the top because useWriteQueue + useTokenLedger
  // both read it, AND useVaultActivation writes to it. Lifting it
  // here breaks the would-be circular dependency.
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ── Hooks: each owns one concern, composed in dependency order ───
  // Busy states (ai.isGenerating, ai.generatingNodeId, ai.titleBusy,
  // sync.syncing) are INTENTIONALLY independent — concurrent ops are
  // safe because each path is race-guarded (useRaceGuard) and the
  // result of a stale op is dropped on settle. The full-screen overlay
  // that hangs on ai.isGenerating is cosmetic, not a lock.
  const writeQueue = useWriteQueue(vaultPath);
  const tokenLedger = useTokenLedger(vaultPath);
  const settings = useVaultSettings(vaultPath);
  const tree = useVaultTree();

  const fileOps = useFileOps({
    vaultPath,
    taken: tree.taken,
    takenRef: tree.takenRef,
    refreshTree: tree.refreshTree,
    flushPendingWrites: writeQueue.flushPendingWrites,
    cancelPending: writeQueue.cancelPending,
    ledgerRef: tokenLedger.ledgerRef,
    setLedger: tokenLedger.setLedger,
    markLedgerDirty: tokenLedger.markDirty,
  });

  const activation = useVaultActivation({
    vaultPath,
    setVaultPath,
    flushPendingWrites: writeQueue.flushPendingWrites,
    cancelAllPending: writeQueue.cancelAllPending,
    setSettingsRaw: settings.setSettingsRaw,
    setLedger: tokenLedger.setLedger,
    setEntries: tree.setEntries,
    setOpenDoc: fileOps.setOpenDoc,
    onActivated: () => setSettingsOpen(false),
  });

  const sync = useS3Sync({
    vaultPath,
    s3: settings.settings.s3,
    activationGuard: activation.activationGuard,
    flushPendingWrites: writeQueue.flushPendingWrites,
    setEntries: tree.setEntries,
  });

  const ai = useAi({
    vaultPath,
    apiKey: settings.settings.apiKey,
    model: settings.settings.model,
    openDoc: fileOps.openDoc,
    setOpenDoc: fileOps.setOpenDoc,
    takenRef: tree.takenRef,
    refreshTree: tree.refreshTree,
    flushPendingWrites: writeQueue.flushPendingWrites,
    addTokens: tokenLedger.addTokens,
    ledgerRef: tokenLedger.ledgerRef,
    setLedger: tokenLedger.setLedger,
    markLedgerDirty: tokenLedger.markDirty,
  });

  const mindmap = useMindmapOps({
    openDoc: fileOps.openDoc,
    setOpenDoc: fileOps.setOpenDoc,
    queueWrite: writeQueue.queueWrite,
  });

  // ── Side effects: theme + UI scale ────────────────────────────────
  useEffect(() => {
    const root = document.documentElement;
    if (settings.settings.theme === "light") {
      root.classList.remove("dark");
      root.classList.add("light");
    } else {
      root.classList.remove("light");
      root.classList.add("dark");
    }
  }, [settings.settings.theme]);

  useEffect(() => {
    (document.body.style as any).zoom = String(settings.settings.uiScale);
  }, [settings.settings.uiScale]);

  // Route every external http(s) link through the OS default browser.
  // WebView2's default is to navigate the embedded window itself, which
  // strands the user inside an in-app Chromium with no back button.
  // Capture-phase listener so we run before any per-component handler
  // (markdown renderer, etc.). mailto:, relative paths, #anchors fall
  // through to the browser's default behaviour.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      if (e.button !== 0) return; // ignore middle / right click
      const target = e.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href) return;
      if (!/^https?:\/\//i.test(href)) return;
      e.preventDefault();
      openUrl(href).catch((err) =>
        toast.error(`Failed to open link: ${err?.message || err}`),
      );
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  // ── Stable callbacks for memoised children ────────────────────────
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  // Functional updates so these callbacks never depend on `settings`.
  // Depending on `settings` itself would re-create them on every
  // settings change and invalidate NoteEditor's React.memo.
  const updateSettings = settings.updateSettings;
  const setNoteMode = useCallback(
    (m: AppSettings["noteMode"]) =>
      updateSettings((prev) => ({ ...prev, noteMode: m })),
    [updateSettings],
  );
  const setNoteWidth = useCallback(
    (w: number) => updateSettings((prev) => ({ ...prev, noteWidth: w })),
    [updateSettings],
  );

  // ── Note save (debounced via write queue) ─────────────────────────
  // NoteEditor owns the live buffer (it debounces internally too); we
  // only persist through the queue. setOpenDoc on every keystroke
  // would force every App-tree re-render to invalidate the memo'd
  // Sidebar / MindMapCanvas / SettingsModal too.
  const openDoc = fileOps.openDoc;
  const queueWrite = writeQueue.queueWrite;
  const handleNoteChange = useCallback((next: string) => {
    if (!openDoc || openDoc.kind !== "md") return;
    queueWrite(openDoc.relPath, next);
  }, [openDoc, queueWrite]);

  // ── Derived: display title for the current note ───────────────────
  const noteTitle = useMemo(() => {
    if (!openDoc || openDoc.kind !== "md") return "";
    const base = openDoc.relPath.split("/").slice(-1)[0] ?? "";
    return base.replace(/\.[^.]+$/, "");
  }, [openDoc]);

  // Per-file tokens for the current open doc, if AI-generated. Narrow
  // the dep to ONLY this file's entry — `ledger.byFile` mutates
  // whenever tokens land on any file, but we only care about the open
  // one.
  const openRel = openDoc?.relPath;
  const fileTokenEntry = openRel ? tokenLedger.ledger.byFile[openRel] : undefined;
  const fileTokens: TokenStats | null = useMemo(() => {
    if (!openDoc) return null;
    if (!fileTokenEntry || fileTokenEntry.total === 0) return null;
    return fileTokenEntry;
  }, [openDoc, fileTokenEntry]);

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="app-container">
      <Sidebar
        settings={settings.settings}
        onSettingsChange={updateSettings}
        vaultPath={vaultPath}
        knownVaults={activation.knownVaults}
        onPickVault={activation.handlePickVault}
        onActivateVault={activation.activateVault}
        onRemoveVault={activation.handleRemoveVault}
        entries={tree.entries}
        activePath={openDoc?.relPath ?? null}
        onOpenFile={fileOps.handleOpenFile}
        onDeleteFile={fileOps.handleDeleteFile}
        onGenerate={ai.handleGenerate}
        onCreateBlankNote={fileOps.handleCreateBlankNote}
        isGenerating={ai.isGenerating}
        onOpenSettings={openSettings}
        onSync={sync.handleSync}
        s3Ready={sync.s3Ready}
        syncing={sync.syncing}
      />

      <div className="main-column">
        <TitleBar />

        <div className="workspace">
          {ai.isGenerating && (
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
                <button className="welcome-submit-btn" onClick={activation.handlePickVault}>
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
          ) : (
            <ViewerBoundary resetKey={openDoc.relPath}>
              {openDoc.kind === "image" ? (
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
                    await tree.refreshTree(vaultPath);
                    try {
                      const content = await readVaultFile(vaultPath, newRel);
                      fileOps.setOpenDoc({ kind: "md", relPath: newRel, content });
                    } catch (e: any) {
                      toast.error(`Failed to open converted file: ${e?.message || e}`);
                    }
                  }}
                />
              ) : openDoc.kind === "mindmap" ? (
                <MindMapCanvas
                  data={openDoc.tree}
                  onToggleCollapse={mindmap.handleToggleCollapse}
                  onEdit={mindmap.handleEditNode}
                  onDelete={mindmap.handleDeleteNode}
                  onAddChild={mindmap.handleAddChildNode}
                  onAiExpand={ai.handleAiExpandNode}
                  generatingNodeId={ai.generatingNodeId}
                  fileTokens={fileTokens}
                />
              ) : (
                <NoteEditor
                  // `key` forces a fresh mount on every file switch.
                  // Without it, NoteEditor's internal `value` state
                  // would lag a render behind the new `initialContent`
                  // prop.
                  key={openDoc.relPath}
                  title={noteTitle}
                  relPath={openDoc.relPath}
                  initialContent={openDoc.content}
                  fileKey={openDoc.relPath}
                  onChange={handleNoteChange}
                  mode={settings.settings.noteMode}
                  onModeChange={setNoteMode}
                  onGenerateTitle={ai.handleGenerateTitle}
                  titleBusy={ai.titleBusy}
                  onRename={fileOps.handleManualRename}
                  width={settings.settings.noteWidth}
                  onWidthChange={setNoteWidth}
                  fileTokens={fileTokens}
                  isDark={settings.settings.theme === "dark"}
                />
              )}
            </ViewerBoundary>
          )}
        </div>
      </div>

      {settingsOpen && (
        <SettingsModal
          settings={settings.settings}
          onChange={updateSettings}
          onClose={closeSettings}
          onSync={sync.handleSync}
          vaultPath={vaultPath}
          s3Ready={sync.s3Ready}
          syncing={sync.syncing}
        />
      )}

      <ToastContainer />
    </div>
  );
}

export default App;
