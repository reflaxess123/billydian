import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileText, RefreshCw, AlertTriangle } from "lucide-react";

interface DocxViewerProps {
  vaultPath: string;
  relPath: string;
  /** Optional handler the parent uses to open a freshly-converted .md file. */
  onConverted?: (newRelPath: string) => void;
  /** Token bookkeeping isn't relevant for docx, so no fileTokens prop. */
}

// Mammoth + Turndown together weigh ~480KB. We never want that in the
// initial bundle — the vast majority of vaults have zero .docx files.
// Cache the dynamic imports module-side so opening N docx files only
// triggers ONE network round trip (or filesystem read for the chunks).
// Typed as `any` because turndown's bundled types describe the default
// export as the constructor itself, but Vite resolves it as `{ default,
// ... }` namespace at runtime — TS won't reconcile the two and the
// promise's concrete shape isn't worth fighting.
let mammothPromise: Promise<any> | null = null;
let turndownPromise: Promise<any> | null = null;

function loadMammoth(): Promise<any> {
  if (!mammothPromise) mammothPromise = import("mammoth");
  return mammothPromise;
}
function loadTurndown(): Promise<any> {
  if (!turndownPromise) turndownPromise = import("turndown");
  return turndownPromise;
}

const DocxViewerImpl: React.FC<DocxViewerProps> = ({
  vaultPath,
  relPath,
  onConverted,
}) => {
  const [html, setHtml] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [converting, setConverting] = useState(false);
  // Keep the raw ArrayBuffer around so a "Convert to .md" click doesn't
  // re-fetch the file. mammoth reads from the same buffer twice (once
  // for the in-app preview, once when the user converts).
  const bufRef = useRef<ArrayBuffer | null>(null);

  // Load + render the docx as HTML via mammoth on file change.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setHtml(null);
    setWarnings([]);
    bufRef.current = null;
    (async () => {
      try {
        const buf = await invoke<ArrayBuffer>("read_vault_file_blob", {
          vault: vaultPath,
          rel: relPath,
        });
        if (cancelled) return;
        bufRef.current = buf;
        const mammoth = await loadMammoth();
        if (cancelled) return;
        // `convertToHtml` takes `{ arrayBuffer }`. We pass the buffer
        // directly; mammoth never mutates it, so future conversions
        // (the Convert button) can reuse the same backing memory.
        const result = await mammoth.convertToHtml(
          { arrayBuffer: buf },
          {
            // Map common Word styles to friendlier HTML so the preview
            // looks like a document, not raw markup. The defaults are
            // fine for headings/paragraphs/lists; we just override the
            // table-cell padding to match our content card.
            styleMap: [
              "p[style-name='Title'] => h1.docx-title:fresh",
              "p[style-name='Subtitle'] => h2.docx-subtitle:fresh",
              "p[style-name='Quote'] => blockquote:fresh",
            ],
            // Inline images as base64 data URLs so the preview just
            // renders. For a Convert-to-Markdown flow we keep them
            // inline too — clean, but ugly source. A future pass could
            // extract images to a sibling folder and reference them.
          },
        );
        if (cancelled) return;
        setHtml(result.value);
        if (result.messages.length > 0) {
          setWarnings(
            result.messages.map((m: { type: string; message: string }) =>
              `${m.type}: ${m.message}`,
            ),
          );
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(String(e?.message || e || "Failed to render .docx"));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultPath, relPath]);

  // Convert the current docx to markdown and write it to a sibling .md
  // file in the same folder. The new file appears in the tree once the
  // parent calls refreshTree (we delegate that via onConverted).
  const handleConvert = useCallback(async () => {
    if (!bufRef.current || converting) return;
    setConverting(true);
    setError(null);
    try {
      const [mammoth, turndownMod] = await Promise.all([
        loadMammoth(),
        loadTurndown(),
      ]);
      // mammoth: docx → html (we run a fresh conversion rather than
      // re-using the in-app preview HTML, because the preview adds
      // class hooks like `docx-title` that turndown would carry into
      // the markdown as noise).
      const result = await mammoth.convertToHtml({ arrayBuffer: bufRef.current });
      // turndown ships as both a CJS module with `default` export and an
      // ESM-style namespace, depending on bundler. The cast handles
      // both shapes — `default` if Vite normalised it, the raw module
      // namespace if not.
      const TurndownService: any = (turndownMod as any).default ?? turndownMod;
      const td = new TurndownService({
        headingStyle: "atx",
        codeBlockStyle: "fenced",
        emDelimiter: "_",
        bulletListMarker: "-",
      });
      const md: string = td.turndown(result.value);

      // Build target path: <same folder>/<basename>.md
      const slash = relPath.lastIndexOf("/");
      const dir = slash >= 0 ? relPath.slice(0, slash + 1) : "";
      const base = (slash >= 0 ? relPath.slice(slash + 1) : relPath).replace(/\.docx$/i, "");
      const targetRel = `${dir}${base}.md`;

      await invoke<void>("write_vault_file", {
        vault: vaultPath,
        rel: targetRel,
        content: md,
      });

      if (onConverted) onConverted(targetRel);
    } catch (e: any) {
      setError(String(e?.message || e || "Conversion failed"));
    } finally {
      setConverting(false);
    }
  }, [vaultPath, relPath, converting, onConverted]);

  return (
    <div className="docx-viewer">
      <div className="docx-toolbar">
        <span className="docx-toolbar-title">
          <FileText size={13} /> {relPath.split("/").slice(-1)[0]}
        </span>
        <button
          type="button"
          className="docx-convert-btn"
          onClick={handleConvert}
          disabled={loading || converting || !bufRef.current}
          title="Convert this .docx to a .md file in the same folder"
        >
          <RefreshCw size={13} className={converting ? "spin" : ""} />
          {converting ? "Converting…" : "Convert to .md"}
        </button>
      </div>

      <div className="docx-scroll">
        {loading && (
          <div className="docx-loading">Rendering document…</div>
        )}
        {error && (
          <div className="docx-error">
            <AlertTriangle size={14} /> {error}
          </div>
        )}
        {!loading && !error && html && (
          <article
            className="docx-content"
            // mammoth's output is well-formed semantic HTML — no script
            // tags, no event handlers, no style attributes that can do
            // damage. We render it directly into our CSP-locked WebView
            // (script-src 'self'), which would block any injected JS
            // anyway. Embedded images are data: URLs the CSP allows.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
        {!loading && !error && warnings.length > 0 && (
          <details className="docx-warnings">
            <summary>{warnings.length} warning{warnings.length === 1 ? "" : "s"}</summary>
            <ul>
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
};

export const DocxViewer = React.memo(DocxViewerImpl);
