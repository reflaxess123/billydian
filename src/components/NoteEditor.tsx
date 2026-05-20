import React, {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Eye, Pencil, Wand2, MapPin } from "lucide-react";
import "katex/dist/katex.min.css";
import { NoteViewMode, TokenStats } from "../types";
import { CodeView, detectLanguage } from "./CodeView";
import { CodeEditor } from "./CodeEditor";

// `[remarkGfm, remarkMath]` / `[rehypeKatex]` — module-level constants
// so ReactMarkdown sees a stable plugin array reference and doesn't
// rebuild its processor on every render.
const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS = [rehypeKatex];
// Module-scope regex literal: per ReactMarkdown's `components.code`
// invocation we run this against each code-fence's class attribute.
// Compiling it once at module load is cheaper than the per-render
// literal-as-regex Chromium otherwise creates.
const CODE_LANG_RE = /language-(\w+)/;

// Cap the markdown preview render at ~64KB. ReactMarkdown reconciliation
// cost scales with the OUTPUT tree size — a 200-300KB note can produce
// thousands of <p>, <li>, <code> nodes, and React has to walk all of
// them at mount AND at unmount. Switching files becomes a 200-500ms
// freeze. Above this cap we show a truncated render and surface a hint
// to drop into edit mode (the <textarea> handles huge strings natively
// without paying the React reconciliation cost).
const PREVIEW_MAX_BYTES = 64 * 1024;

interface NoteEditorProps {
  title: string;
  /** Vault-relative path of the open file — shown in the footer card. */
  relPath: string;
  initialContent: string;
  fileKey: string;
  onChange: (next: string) => void;
  mode: NoteViewMode;
  onModeChange: (mode: NoteViewMode) => void;
  onGenerateTitle: (currentContent: string) => void;
  titleBusy?: boolean;
  /** Manual inline rename — caller does the file move + tree refresh. */
  onRename: (newTitle: string) => void;
  /** Width (px) of the card column. Persisted in app settings. */
  width: number;
  onWidthChange: (next: number) => void;
  /** Per-file token spend (null if this note never used the AI). */
  fileTokens?: TokenStats | null;
  /** Drives the Prism colour scheme in code highlighting. */
  isDark: boolean;
}

// Discrete width steps. The active one lights up; clicking another
// snaps the column to that level (animated via CSS transition on the
// card's max-width). Width is still stored as a px number in settings
// so future steps can be inserted without a migration.
const WIDTH_LEVELS: number[] = [760, 900, 1100];

const NoteEditorImpl: React.FC<NoteEditorProps> = ({
  title,
  relPath,
  initialContent,
  fileKey,
  onChange,
  mode,
  onModeChange,
  onGenerateTitle,
  titleBusy,
  onRename,
  width,
  onWidthChange,
  fileTokens,
  isDark,
}) => {
  const [value, setValue] = useState(initialContent);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(title);
  const titleInputRef = useRef<HTMLInputElement | null>(null);

  // Auto-grow textarea: handled by `field-sizing: content` in App.css
  // (Chromium 123+, WebView2). The previous JS effect did the same job
  // via scrollHeight reads on every keystroke — two forced layouts per
  // character on large notes. Dropped.

  // Defer the markdown render input so typing stays at native speed
  // while remark/rehype/katex catches up in the background. React 19
  // schedules the render with deferred priority, giving input updates
  // first crack at the frame budget.
  const deferredValue = useDeferredValue(value);

  useEffect(() => {
    setValue(initialContent);
    setEditingTitle(false);
    setTitleDraft(title);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey]);

  // Keep draft synced when caller renames via AI (Wand button).
  useEffect(() => {
    if (!editingTitle) setTitleDraft(title);
  }, [title, editingTitle]);

  useEffect(() => {
    if (editingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [editingTitle]);

  const commitTitle = () => {
    const next = titleDraft.trim();
    if (next && next !== title) onRename(next);
    setEditingTitle(false);
  };

  const cancelTitle = () => {
    setTitleDraft(title);
    setEditingTitle(false);
  };

  useEffect(() => {
    if (value === initialContent) return;
    const t = setTimeout(() => onChange(value), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Truncate the preview source to bound the React tree size — see the
  // PREVIEW_MAX_BYTES comment for why this matters. We cut at the last
  // paragraph break (\n\n) before the cap so we never slice a heading,
  // list item, or code-fence mid-element. `truncatedBy` carries the
  // number of bytes the user can't see in preview mode, surfaced as a
  // small banner with a one-click jump to the editor.
  const { previewMd, truncatedBy } = useMemo(() => {
    if (deferredValue.length <= PREVIEW_MAX_BYTES) {
      return { previewMd: deferredValue, truncatedBy: 0 };
    }
    const slice = deferredValue.slice(0, PREVIEW_MAX_BYTES);
    const lastBreak = slice.lastIndexOf("\n\n");
    // Only honour the paragraph break if it's past the halfway mark —
    // a break very early would throw away half the cap and look weird.
    const cut = lastBreak > PREVIEW_MAX_BYTES / 2 ? lastBreak : PREVIEW_MAX_BYTES;
    return {
      previewMd: deferredValue.slice(0, cut),
      truncatedBy: deferredValue.length - cut,
    };
  }, [deferredValue]);

  // Footer stats: words + chars + lines computed in ONE pass through the
  // buffer. The previous version called `.split(/\s+/)` AND `.split("\n")`
  // — two full O(L) scans per keystroke that also allocated two
  // intermediate arrays. For a 50KB markdown note this saves ~100KB of
  // GC churn per character typed.
  const stats = useMemo(() => {
    const chars = value.length;
    if (chars === 0) return { chars: 0, words: 0, lines: 0 };
    let lines = 1;
    let words = 0;
    let inWord = false;
    for (let i = 0; i < chars; i++) {
      const c = value.charCodeAt(i);
      // 9=tab 10=\n 13=\r 32=space — collapse all to "whitespace"
      const isSpace = c === 32 || c === 9 || c === 10 || c === 13;
      if (c === 10) lines++;
      if (!isSpace) {
        if (!inWord) {
          words++;
          inWord = true;
        }
      } else {
        inWord = false;
      }
    }
    return { chars, words, lines };
  }, [value]);

  // Language detection: when the file's extension matches a known
  // Prism grammar (and isn't markdown), we switch the preview from
  // ReactMarkdown to a syntax-highlighted code view.
  const baseName = relPath.split("/").slice(-1)[0] ?? relPath;
  const lang = useMemo(() => detectLanguage(baseName), [baseName]);
  const isCode = lang !== null && lang !== "md" && lang !== "markdown";

  // Stable style + components objects — ReactMarkdown / the three card
  // wrappers all do shallow-compare reconciliation, so a fresh object
  // per render makes them think something actually changed.
  const cardStyle: React.CSSProperties = useMemo(
    () => ({ maxWidth: width }),
    [width],
  );
  const mdComponents: Components = useMemo(
    () => ({
      code(props) {
        const { inline, className, children } = props as {
          inline?: boolean;
          className?: string;
          children?: React.ReactNode;
        };
        const match = CODE_LANG_RE.exec(className || "");
        const codeStr = String(children ?? "").replace(/\n$/, "");
        if (inline || !match) {
          return <code className={className}>{children}</code>;
        }
        return (
          <CodeView
            code={codeStr}
            language={match[1]}
            isDark={isDark}
            inline={false}
          />
        );
      },
    }),
    [isDark],
  );

  return (
    <div className={`note-view note-view--${mode}`}>
      <div className="note-stack">
        {/* Title card */}
        <header className="note-card note-title-card" style={cardStyle}>
          <div className="note-title-block">
            {editingTitle ? (
              <input
                ref={titleInputRef}
                className="note-title note-title-input"
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitTitle();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelTitle();
                  }
                }}
                spellCheck={false}
                aria-label="Note title"
              />
            ) : (
              <h1
                className="note-title"
                title="Click to rename"
                onClick={() => setEditingTitle(true)}
              >
                {title}
              </h1>
            )}
          </div>
          <div className="note-header-actions">
            <div className="width-levels" role="group" aria-label="Note width">
              {WIDTH_LEVELS.map((w, i) => (
                <button
                  key={w}
                  type="button"
                  className={`width-level${width === w ? " active" : ""}`}
                  onClick={() => onWidthChange(w)}
                  title={`${w}px wide`}
                  aria-pressed={width === w}
                  aria-label={`Width level ${i + 1}`}
                >
                  {i + 1}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="note-icon-btn"
              onClick={() => onGenerateTitle(value)}
              disabled={!!titleBusy}
              title="Generate title from content"
              aria-label="Generate title"
            >
              <Wand2 size={15} />
            </button>
            <button
              type="button"
              className={`note-mode-toggle${mode === "view" ? " active" : ""}`}
              onClick={() => onModeChange(mode === "edit" ? "view" : "edit")}
              title={mode === "edit" ? "Switch to preview" : "Switch to editor"}
              aria-label="Toggle edit/view"
            >
              {mode === "edit" ? <Eye size={15} /> : <Pencil size={15} />}
            </button>
          </div>
        </header>

        {/* Content card */}
        <div className="note-card note-content-card" style={cardStyle}>
          {mode === "edit" ? (
            isCode ? (
              <CodeEditor
                code={value}
                language={lang!}
                onChange={(next) => setValue(next)}
              />
            ) : (
              <textarea
                className="note-textarea mono"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                spellCheck={false}
                placeholder={
`# Title

Write Markdown here. Math works via $E = mc^2$ inline and
$$
\\int_0^\\infty e^{-x^2}\\,dx = \\tfrac{\\sqrt{\\pi}}{2}
$$
display blocks.`
                }
              />
            )
          ) : isCode ? (
            <div className="note-code">
              <CodeView code={value} language={lang!} isDark={isDark} />
            </div>
          ) : (
            <div className="note-preview">
              <ReactMarkdown
                remarkPlugins={REMARK_PLUGINS}
                rehypePlugins={REHYPE_PLUGINS}
                components={mdComponents}
              >
                {previewMd || ""}
              </ReactMarkdown>
              {truncatedBy > 0 && (
                <div className="note-preview-truncated">
                  <span>
                    Preview cut at {Math.round(previewMd.length / 1024)} KB ·{" "}
                    {Math.round(truncatedBy / 1024)} KB hidden.
                  </span>
                  <button
                    type="button"
                    onClick={() => onModeChange("edit")}
                    title="Switch to the editor — textarea handles the full file"
                  >
                    Open in editor
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer card: shows where the file lives + content stats */}
        <footer className="note-card note-footer-card" style={cardStyle}>
          <div className="note-footer-loc" title={relPath}>
            <MapPin size={12} />
            <span className="note-footer-path">{relPath}</span>
          </div>
          <div className="note-footer-stats">
            {isCode && lang && (
              <span className="footer-lang"><strong>{lang}</strong></span>
            )}
            <span><strong>{stats.words.toLocaleString()}</strong> words</span>
            <span><strong>{stats.chars.toLocaleString()}</strong> chars</span>
            <span><strong>{stats.lines.toLocaleString()}</strong> lines</span>
            {fileTokens && fileTokens.total > 0 && (
              <span className="footer-tokens" title="Tokens spent on this note">
                <strong>{fileTokens.total.toLocaleString()}</strong> tokens
              </span>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
};

// Memoised — App.tsx state changes (sync ticks, ledger updates, theme
// toggle) re-render the whole tree; without memo NoteEditor would
// re-run remark+rehype+katex on each parent update even when the file
// content hasn't changed. Default shallow-equal comparator is fine
// because all props are primitives or stable callbacks.
export const NoteEditor = React.memo(NoteEditorImpl);
