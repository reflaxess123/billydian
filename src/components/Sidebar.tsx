import React, { useState } from "react";
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
} from "lucide-react";
import { AppSettings, VaultEntry } from "../types";
import { SyncReport } from "../App";
import { FolderTree } from "./FolderTree";

type NewKind = "note" | "mindmap";

interface SidebarProps {
  settings: AppSettings;
  onSettingsChange: (s: AppSettings) => void;
  vaultPath: string | null;
  onPickVault: () => void;
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
  syncReport: SyncReport | null;
  syncError: string | null;
}

const SCALE_STEP = 0.1;
const SCALE_MIN = 0.7;
const SCALE_MAX = 1.6;

export const Sidebar: React.FC<SidebarProps> = ({
  settings,
  onSettingsChange,
  vaultPath,
  onPickVault,
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
  syncReport,
  syncError,
}) => {
  const [topic, setTopic] = useState("");
  // The AI generator now only produces mind maps; plain notes are
  // created via the `+` button next to the vault chip.
  const GEN_KIND: NewKind = "mindmap";

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

  const submitGenerate = (e: React.FormEvent) => {
    e.preventDefault();
    const t = topic.trim();
    if (!t) return;
    onGenerate(GEN_KIND, t);
    setTopic("");
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-content">
        {/* Top row: scale +/-, theme switch */}
        <div className="sidebar-top-row">
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
          {/* Right cluster: sync feedback label (sits LEFT of the sync
              icon when present) + sync button + theme switch. The label
              auto-dismisses ~3 s after a sync completes, but fades out
              gracefully via CSS, not abruptly. */}
          <div className="sidebar-top-actions">
            {(syncing || syncReport || syncError) && (
              <span
                className={`sync-inline${syncError ? " err" : syncing ? " busy" : " ok"}`}
                title={syncError ?? "Last sync result"}
              >
                {syncing ? (
                  "Syncing…"
                ) : syncError ? (
                  <span className="sync-inline-text">
                    {syncError.length > 32 ? syncError.slice(0, 29) + "…" : syncError}
                  </span>
                ) : syncReport ? (
                  <>
                    ↑<strong>{syncReport.uploaded}</strong>{" "}
                    ↓<strong>{syncReport.downloaded}</strong>{" "}
                    ={syncReport.skipped}
                    {syncReport.deleted > 0 && (
                      <> 🗑<strong>{syncReport.deleted}</strong></>
                    )}
                    {syncReport.errors.length > 0 && (
                      <> ⚠{syncReport.errors.length}</>
                    )}
                  </>
                ) : null}
              </span>
            )}
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
            <button
              className="theme-icon-btn"
              onClick={toggleTheme}
              title={settings.theme === "dark" ? "Switch to light" : "Switch to dark"}
              aria-label="Toggle theme"
            >
              {settings.theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
            </button>
          </div>
        </div>

        {/* Vault row: picker chip + new-note `+` to its right */}
        <div className="vault-row">
          <button
            className="vault-pick-btn"
            onClick={onPickVault}
            title={vaultPath ?? "Pick a vault folder"}
          >
            <FolderOpen size={14} />
            <span className="vault-pick-label">
              {vaultPath ? vaultPath.split(/[\\/]/).slice(-1)[0] : "Pick vault…"}
            </span>
          </button>
          {vaultPath && (
            <button
              type="button"
              className="vault-new-btn"
              onClick={onCreateBlankNote}
              title="New blank note"
              aria-label="New blank note"
            >
              <Plus size={14} />
            </button>
          )}
        </div>

        {/* Mind-map generator — single input + AI sparkle */}
        {vaultPath && (
          <form className="gen-input-row" onSubmit={submitGenerate}>
            <input
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="Mind map topic…"
              className="api-input"
              disabled={isGenerating}
            />
            <button
              type="submit"
              className="gen-submit-btn"
              disabled={isGenerating || !topic.trim()}
              title="Generate mind map via AI"
              aria-label="Generate mind map"
            >
              <Sparkles size={13} />
            </button>
          </form>
        )}

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
          <SettingsIcon size={14} /> Settings
        </button>
      </div>
    </aside>
  );
};
