import React, { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, X, Cpu, Key, Cloud, RefreshCw } from "lucide-react";
import { AppSettings } from "../types";

interface SettingsModalProps {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  onClose: () => void;
  onSync: () => void;
  vaultPath: string | null;
  s3Ready: boolean;
  syncing: boolean;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  settings,
  onChange,
  onClose,
  onSync,
  vaultPath,
  s3Ready,
  syncing,
}) => {
  const [showKey, setShowKey] = useState(false);
  const [showS3Secret, setShowS3Secret] = useState(false);
  const [closing, setClosing] = useState(false);

  // Park the pending close timer in a ref so an unmount-mid-animation
  // (StrictMode double effect, rapid open/close, parent route change)
  // can cancel it cleanly — otherwise the timer keeps the `onClose`
  // closure pinned in the event loop for ~220ms after we're gone.
  const closeTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  // Play the modal-out animation before actually unmounting. Duration
  // here must match the CSS `modalOut`/`fadeOut` keyframes (220 ms).
  const requestClose = () => {
    if (closing) return;
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      onClose();
    }, 220);
  };

  const setS3 = (patch: Partial<AppSettings["s3"]>) => {
    onChange({ ...settings, s3: { ...settings.s3, ...patch } });
  };

  return (
    <div
      className={`modal-backdrop${closing ? " closing" : ""}`}
      onMouseDown={requestClose}
    >
      <div
        className={`modal${closing ? " closing" : ""}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="modal-close" onClick={requestClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          {/* Vault folder section removed — the sidebar's vault-row
              dropdown is now the single way to pick / switch / forget
              vaults, so showing the path twice was redundant. */}

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

          {/* Model — no heading, the chip itself with its Cpu icon
              telegraphs what it's for, and the tip below the chip
              already mentions "model slug". */}
          <section className="modal-section">
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
                onClick={onSync}
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
              {/* Sync result + errors now flow through global toasts. */}
            </div>
          </section>
        </div>

        <div className="modal-footer">
          <button className="modal-btn primary" onClick={requestClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
