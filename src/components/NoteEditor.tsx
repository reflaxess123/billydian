import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Eye, Pencil, Wand2, MapPin } from "lucide-react";
import "katex/dist/katex.min.css";
import { NoteViewMode, TokenStats } from "../types";
import { CodeView, detectLanguage } from "./CodeView";

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

export const NoteEditor: React.FC<NoteEditorProps> = ({
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
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow the textarea to match its content height — no min, no
  // internal scroll. The outer `.note-view` becomes the single scroll
  // surface for the whole page.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value, mode]);

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

  // Footer stats: words + chars; cheap to compute on every keystroke.
  const stats = useMemo(() => {
    const trimmed = value.trim();
    const chars = value.length;
    const words = trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
    const lines = value.length === 0 ? 0 : value.split("\n").length;
    return { chars, words, lines };
  }, [value]);

  // Language detection: when the file's extension matches a known
  // Prism grammar (and isn't markdown), we switch the preview from
  // ReactMarkdown to a syntax-highlighted code view.
  const baseName = relPath.split("/").slice(-1)[0] ?? relPath;
  const lang = useMemo(() => detectLanguage(baseName), [baseName]);
  const isCode = lang !== null && lang !== "md" && lang !== "markdown";

  const cardStyle: React.CSSProperties = { maxWidth: width };

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
            <textarea
              ref={textareaRef}
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
          ) : isCode ? (
            <div className="note-code">
              <CodeView code={value} language={lang!} isDark={isDark} />
            </div>
          ) : (
            <div className="note-preview">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeKatex]}
                components={{
                  code(props: any) {
                    const { inline, className, children } = props;
                    const match = /language-(\w+)/.exec(className || "");
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
                }}
              >
                {value || ""}
              </ReactMarkdown>
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
