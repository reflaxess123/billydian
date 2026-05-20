import React, { useEffect, useRef, useState } from "react";
import {
  Sun,
  Moon,
  Settings as SettingsIcon,
  Sparkles,
  FolderOpen,
  Plus,
  ZoomIn,
  ZoomOut,
  RefreshCw,
  Check,
  X,
  ChevronDown,
} from "lucide-react";
import { AppSettings, VaultEntry } from "../types";
import { FolderTree } from "./FolderTree";

type NewKind = "note" | "mindmap";

interface SidebarProps {
  settings: AppSettings;
  onSettingsChange: (s: AppSettings) => void;
  vaultPath: string | null;
  knownVaults: string[];
  onPickVault: () => void;
  onActivateVault: (path: string) => void;
  onRemoveVault: (path: string) => void;
  entries: VaultEntry[];
  activePath: string | null;
  onOpenFile: (entry: VaultEntry) => void;
  onDeleteFile: (entry: VaultEntry) => void;
  onGenerate: (kind: NewKind, topic: string) => void;
  /** Create a blank .md file with a placeholder title. */
  onCreateBlankNote: () => void;
  isGenerating: boolean;
  onOpenSettings: () => void;
  /** S3 sync trigger; ignored when `s3Ready === false`. */
  onSync: () => void;
  s3Ready: boolean;
  syncing: boolean;
}

const SCALE_STEP = 0.1;
const SCALE_MIN = 0.7;
const SCALE_MAX = 1.6;
// Module-scope so we don't recompile per call. Splits paths on either
// `/` (POSIX) or `\` (Windows) so we can pull the basename of a vault
// path regardless of which the OS handed us.
const PATH_SEP_RE = /[\\/]/;

const SidebarImpl: React.FC<SidebarProps> = ({
  settings,
  onSettingsChange,
  vaultPath,
  knownVaults,
  onPickVault,
  onActivateVault,
  onRemoveVault,
  entries,
  activePath,
  onOpenFile,
  onDeleteFile,
  onGenerate,
  onCreateBlankNote,
  isGenerating,
  onOpenSettings,
  onSync,
  s3Ready,
  syncing,
}) => {
  const [topic, setTopic] = useState("");
  // The AI generator now only produces mind maps; plain notes are
  // created via the `+` button next to the vault chip.
  const GEN_KIND: NewKind = "mindmap";

  // Vault picker dropdown — opens on chip click when there's at least
  // one known vault, lets the user switch between them or add new.
  const [vaultMenuOpen, setVaultMenuOpen] = useState(false);
  const vaultMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!vaultMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (
        vaultMenuRef.current &&
        !vaultMenuRef.current.contains(e.target as Node)
      ) {
        setVaultMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setVaultMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onClick, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [vaultMenuOpen]);

  const basename = (p: string) => p.split(PATH_SEP_RE).slice(-1)[0] || p;
  const handleVaultClick = () => {
    // First-time use (no known vaults): jump straight to the OS dialog.
    if (knownVaults.length === 0) onPickVault();
    else setVaultMenuOpen((v) => !v);
  };

  const toggleTheme = () => {
    onSettingsChange({
      ...settings,
      theme: settings.theme === "dark" ? "light" : "dark",
    });
  };

  const bumpScale = (delta: number) => {
    const next = Math.round((settings.uiScale + delta) * 100) / 100;
    const clamped = Math.max(SCALE_MIN, Math.min(SCALE_MAX, next));
    onSettingsChange({ ...settings, uiScale: clamped });
  };

  const submitGenerate = (e?: React.SyntheticEvent) => {
    e?.preventDefault();
    const t = topic.trim();
    if (!t) return;
    onGenerate(GEN_KIND, t);
    setTopic("");
  };

  // Enter inside the generate input acts as submit (no surrounding <form>
  // since the input and submit button live in different grid cells now).
  const onTopicKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") submitGenerate(e);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-content">
        {/* Sync progress + result + errors all flow through the global
            ToastContainer now — no inline UI here. */}

        {/* Pixel-perfect controls grid.
            Column 1: 1fr (scale cluster / vault picker / topic input).
            Columns 2-3: compact icon buttons, so the right edge of every
            row aligns exactly. */}
        <div className="sidebar-controls">
          {/* Row 1, col 1 — scale */}
          <div className="scale-cluster" role="group" aria-label="UI scale">
            <button
              className="scale-btn"
              onClick={() => bumpScale(-SCALE_STEP)}
              disabled={settings.uiScale <= SCALE_MIN + 0.001}
              title="Smaller UI"
              aria-label="Smaller UI"
            >
              <ZoomOut size={13} />
            </button>
            <span className="scale-readout">{Math.round(settings.uiScale * 100)}%</span>
            <button
              className="scale-btn"
              onClick={() => bumpScale(SCALE_STEP)}
              disabled={settings.uiScale >= SCALE_MAX - 0.001}
              title="Bigger UI"
              aria-label="Bigger UI"
            >
              <ZoomIn size={13} />
            </button>
          </div>

          {/* Row 1, col 2 — sync */}
          <button
            className="theme-icon-btn sync-btn"
            onClick={onSync}
            disabled={!s3Ready || syncing}
            title={
              !s3Ready
                ? "Fill in S3 settings to enable sync"
                : syncing
                ? "Syncing…"
                : "Sync vault with S3"
            }
            aria-label="Sync vault"
          >
            <RefreshCw size={15} className={syncing ? "spin" : ""} />
          </button>
          {/* Row 1, col 3 — theme */}
          <button
            className="theme-icon-btn"
            onClick={toggleTheme}
            title={settings.theme === "dark" ? "Switch to light" : "Switch to dark"}
            aria-label="Toggle theme"
          >
            {settings.theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
          </button>

          {/* Row 2, col 1 — vault picker (relative anchor for dropdown) */}
          <div className="vault-row" ref={vaultMenuRef}>
            <button
              className={`vault-pick-btn${vaultMenuOpen ? " open" : ""}`}
              onClick={handleVaultClick}
              title={vaultPath ?? "Pick a vault folder"}
            >
              <FolderOpen size={14} />
              <span className="vault-pick-label">
                {vaultPath ? basename(vaultPath) : "Pick vault…"}
              </span>
              {knownVaults.length > 0 && (
                <ChevronDown
                  size={13}
                  className={`vault-pick-chev${vaultMenuOpen ? " open" : ""}`}
                />
              )}
            </button>

            {vaultMenuOpen && (
              <div className="vault-menu" role="listbox">
                {knownVaults.map((p) => {
                  const active = p === vaultPath;
                  return (
                    <div
                      key={p}
                      className={`vault-menu-item${active ? " active" : ""}`}
                      role="option"
                      aria-selected={active}
                      onClick={() => {
                        if (!active) onActivateVault(p);
                        setVaultMenuOpen(false);
                      }}
                    >
                      <FolderOpen size={13} className="vault-menu-icon" />
                      <span className="vault-menu-text" title={p}>
                        <span className="vault-menu-name">{basename(p)}</span>
                        <span className="vault-menu-path">{p}</span>
                      </span>
                      {active && <Check size={13} className="vault-menu-check" />}
                      {!active && (
                        <button
                          type="button"
                          className="vault-menu-remove"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemoveVault(p);
                          }}
                          title="Forget this vault"
                          aria-label="Forget this vault"
                        >
                          <X size={11} />
                        </button>
                      )}
                    </div>
                  );
                })}
                <button
                  type="button"
                  className="vault-menu-add"
                  onClick={() => {
                    setVaultMenuOpen(false);
                    onPickVault();
                  }}
                >
                  <Plus size={13} /> Add another vault…
                </button>
              </div>
            )}
          </div>

          {/* Row 2, col 2 — new note. Always rendered (disabled when
              no vault) so the column doesn't collapse and the row
              keeps its compact row height. */}
          <button
            type="button"
            className="vault-new-btn"
            onClick={onCreateBlankNote}
            disabled={!vaultPath}
            title="New blank note"
            aria-label="New blank note"
          >
            <Plus size={14} />
          </button>

          {/* Row 3 — only when a vault is open */}
          {vaultPath && (
            <>
              <input
                type="text"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                onKeyDown={onTopicKeyDown}
                placeholder="Mind map topic…"
                className="api-input gen-input"
                disabled={isGenerating}
              />
              <button
                type="button"
                className="gen-submit-btn"
                onClick={submitGenerate}
                disabled={isGenerating || !topic.trim()}
                title="Generate mind map via AI"
                aria-label="Generate mind map"
              >
                <Sparkles size={13} />
              </button>
            </>
          )}
        </div>

        {/* Tree */}
        <div className="vault-tree-wrap">
          {!vaultPath ? (
            <p className="no-vault">Pick a folder above — it becomes your MindMapper vault.</p>
          ) : entries.length === 0 ? (
            <p className="no-vault">Empty vault. Generate or create something above to get started.</p>
          ) : (
            <FolderTree
              entries={entries}
              activePath={activePath}
              onOpen={onOpenFile}
              onDelete={onDeleteFile}
            />
          )}
        </div>

        {/* Bottom: settings modal trigger */}
        <button className="sidebar-settings-btn" onClick={onOpenSettings}>
          <span className="sidebar-settings-inner">
            <SettingsIcon size={14} />
            <span>Settings</span>
          </span>
        </button>
      </div>
    </aside>
  );
};

// Memo'd — App.tsx re-renders on every settings tick, sync feedback
// timer, ledger update. Sidebar takes 18 props but most are stable
// callbacks (now wrapped in useCallback upstream); when only an
// irrelevant App state changes, shallow equality short-circuits all
// the children including FolderTree.
export const Sidebar = React.memo(SidebarImpl);
