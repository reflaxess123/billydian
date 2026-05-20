import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Eye, EyeOff, X, FolderOpen, Cpu, Key, Cloud, RefreshCw, CheckCircle2, AlertTriangle } from "lucide-react";
import { AppSettings } from "../types";

interface SettingsModalProps {
  settings: AppSettings;
  vaultPath: string | null;
  onChange: (next: AppSettings) => void;
  onClose: () => void;
  onPickVault: () => void;
  onAfterSync?: () => void;
}

type SyncReport = {
  uploaded: number;
  downloaded: number;
  skipped: number;
  deleted: number;
  errors: string[];
};

export const SettingsModal: React.FC<SettingsModalProps> = ({
  settings,
  vaultPath,
  onChange,
  onClose,
  onPickVault,
  onAfterSync,
}) => {
  const [showKey, setShowKey] = useState(false);
  const [showS3Secret, setShowS3Secret] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncReport, setSyncReport] = useState<SyncReport | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const setS3 = (patch: Partial<AppSettings["s3"]>) => {
    onChange({ ...settings, s3: { ...settings.s3, ...patch } });
  };

  const s3Ready =
    !!vaultPath &&
    !!settings.s3.endpoint.trim() &&
    !!settings.s3.region.trim() &&
    !!settings.s3.bucket.trim() &&
    !!settings.s3.accessKeyId.trim() &&
    !!settings.s3.secretAccessKey.trim();

  const handleSync = async () => {
    if (!vaultPath) return;
    setSyncing(true);
    setSyncError(null);
    setSyncReport(null);
    try {
      const report = await invoke<SyncReport>("sync_vault", {
        vault: vaultPath,
        s3: settings.s3,
      });
      setSyncReport(report);
      onAfterSync?.();
    } catch (e: any) {
      setSyncError(String(e?.message || e || "Sync failed"));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          {/* Vault */}
          <section className="modal-section">
            <h3>
              <FolderOpen size={14} /> Vault folder
            </h3>
            <div className="modal-row">
              <code className="modal-path" title={vaultPath ?? ""}>
                {vaultPath ?? "No vault selected"}
              </code>
              <button className="modal-btn" onClick={onPickVault}>
                Change…
              </button>
            </div>
          </section>

          {/* OpenRouter */}
          <section className="modal-section">
            <h3>
              <Key size={14} /> OpenRouter API key
            </h3>
            <div className="input-group">
              <input
                className="api-input"
                type={showKey ? "text" : "password"}
                value={settings.apiKey}
                onChange={(e) => onChange({ ...settings, apiKey: e.target.value })}
                placeholder="sk-or-v1-…"
                spellCheck={false}
                autoComplete="off"
              />
              <button
                type="button"
                className="toggle-visibility-btn"
                onClick={() => setShowKey(!showKey)}
                aria-label={showKey ? "Hide" : "Reveal"}
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <p className="settings-tip">
              Get a key at{" "}
              <a href="https://openrouter.ai" target="_blank" rel="noreferrer">
                openrouter.ai
              </a>
              .
            </p>
          </section>

          {/* Model */}
          <section className="modal-section">
            <h3>
              <Cpu size={14} /> AI model
            </h3>
            <div className="model-combo">
              <Cpu size={14} className="model-combo-icon" />
              <input
                type="text"
                className="model-combo-input"
                value={settings.model}
                onChange={(e) => onChange({ ...settings, model: e.target.value })}
                placeholder="provider/model"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <p className="settings-tip">
              Free-form OpenRouter slug, e.g. <code>x-ai/grok-4</code>,{" "}
              <code>anthropic/claude-3.5-sonnet</code>.
            </p>
          </section>

          {/* S3 sync */}
          <section className="modal-section">
            <h3>
              <Cloud size={14} /> S3 sync
            </h3>
            <div className="grid-2">
              <label className="field">
                <span className="ftitle">Endpoint</span>
                <input
                  className="api-input mono"
                  value={settings.s3.endpoint}
                  onChange={(e) => setS3({ endpoint: e.target.value })}
                  placeholder="https://s3.amazonaws.com"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <label className="field">
                <span className="ftitle">Region</span>
                <input
                  className="api-input mono"
                  value={settings.s3.region}
                  onChange={(e) => setS3({ region: e.target.value })}
                  placeholder="us-east-1"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <label className="field">
                <span className="ftitle">Bucket</span>
                <input
                  className="api-input mono"
                  value={settings.s3.bucket}
                  onChange={(e) => setS3({ bucket: e.target.value })}
                  placeholder="billydian-vault"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <label className="field">
                <span className="ftitle">Prefix (optional)</span>
                <input
                  className="api-input mono"
                  value={settings.s3.prefix ?? ""}
                  onChange={(e) => setS3({ prefix: e.target.value })}
                  placeholder="vault/"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <label className="field">
                <span className="ftitle">Access key ID</span>
                <input
                  className="api-input mono"
                  value={settings.s3.accessKeyId}
                  onChange={(e) => setS3({ accessKeyId: e.target.value })}
                  placeholder="AKIA…"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <label className="field">
                <span className="ftitle">Secret access key</span>
                <div className="input-group">
                  <input
                    className="api-input mono"
                    type={showS3Secret ? "text" : "password"}
                    value={settings.s3.secretAccessKey}
                    onChange={(e) => setS3({ secretAccessKey: e.target.value })}
                    placeholder="••••••••"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="toggle-visibility-btn"
                    onClick={() => setShowS3Secret(!showS3Secret)}
                    aria-label={showS3Secret ? "Hide" : "Reveal"}
                  >
                    {showS3Secret ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </label>
            </div>
            <p className="settings-tip">
              Two-way diff sync: walks your vault, lists the bucket, and
              push/pull whatever side is newer. Files inside
              <code> .billydian/ </code>are excluded so your creds never
              travel.
            </p>
            <div className="modal-row">
              <button
                type="button"
                className="modal-btn primary"
                onClick={handleSync}
                disabled={!s3Ready || syncing}
                title={
                  !vaultPath
                    ? "Pick a vault first"
                    : !s3Ready
                    ? "Fill all S3 fields above"
                    : "Sync now"
                }
              >
                <RefreshCw size={13} className={syncing ? "spin" : ""} />
                {syncing ? "Syncing…" : "Sync now"}
              </button>
              {syncReport && !syncing && (
                <div className="sync-feedback ok">
                  <CheckCircle2 size={14} />
                  <span>
                    ↑ <strong>{syncReport.uploaded}</strong>
                    {"  ·  "}↓ <strong>{syncReport.downloaded}</strong>
                    {"  ·  "}= <strong>{syncReport.skipped}</strong>
                    {syncReport.deleted > 0 && (
                      <>{"  ·  "}🗑 <strong>{syncReport.deleted}</strong></>
                    )}
                    {syncReport.errors.length > 0 && (
                      <>{"  ·  "}<span className="sync-feedback-err">⚠ {syncReport.errors.length}</span></>
                    )}
                  </span>
                </div>
              )}
            </div>
            {syncError && !syncing && (
              <div className="sync-error-box">
                <div className="sync-error-head">
                  <AlertTriangle size={14} /> Sync failed
                </div>
                <pre>{syncError}</pre>
              </div>
            )}
            {syncReport && syncReport.errors.length > 0 && (
              <details className="sync-errors" open>
                <summary>Errors ({syncReport.errors.length})</summary>
                <ul>
                  {syncReport.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        </div>

        <div className="modal-footer">
          <button className="modal-btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
