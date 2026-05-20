import React, { useMemo } from "react";
import Editor from "react-simple-code-editor";
import Prism from "prismjs";

// Prism grammars are registered as side-effect imports. Dependencies
// MUST be loaded before the dependents — Prism's `@require` directives
// aren't honoured by bundlers, so the wrong order silently corrupts
// the grammar table and the highlight callback throws at render time
// (which unmounts the entire editor subtree). See:
// https://github.com/PrismJS/prism/issues/2096

// ── Base grammars (no deps or built-in 'clike') ───────────────────
import "prismjs/components/prism-markup";              // html/xml/svg
import "prismjs/components/prism-markup-templating";   // php/handlebars base
import "prismjs/components/prism-css";
import "prismjs/components/prism-javascript";

// ── TypeScript family (order-sensitive) ───────────────────────────
import "prismjs/components/prism-typescript";          // ← needs javascript
import "prismjs/components/prism-jsx";                 // ← needs javascript
import "prismjs/components/prism-tsx";                 // ← needs jsx + typescript

// ── C family ──────────────────────────────────────────────────────
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";                 // ← needs c
import "prismjs/components/prism-objectivec";          // ← needs c
import "prismjs/components/prism-csharp";
import "prismjs/components/prism-java";
import "prismjs/components/prism-kotlin";

// ── Markup-templating dependents ──────────────────────────────────
import "prismjs/components/prism-handlebars";          // ← needs markup-templating
import "prismjs/components/prism-php";                 // ← needs markup-templating
import "prismjs/components/prism-markdown";            // ← needs markup

// ── CSS dependents ────────────────────────────────────────────────
import "prismjs/components/prism-scss";                // ← needs css

// ── Standalone ────────────────────────────────────────────────────
import "prismjs/components/prism-bash";
import "prismjs/components/prism-diff";
import "prismjs/components/prism-docker";
import "prismjs/components/prism-go";
import "prismjs/components/prism-graphql";
import "prismjs/components/prism-ini";
import "prismjs/components/prism-json";
import "prismjs/components/prism-lua";
import "prismjs/components/prism-nginx";
import "prismjs/components/prism-perl";
import "prismjs/components/prism-powershell";
import "prismjs/components/prism-python";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-swift";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-yaml";

// Language alias map: our `detectLanguage` ids → Prism's canonical names.
const ALIAS: Record<string, string> = {
  shell: "bash",
  sh: "bash",
  zsh: "bash",
  ps1: "powershell",
  htm: "markup",
  html: "markup",
  xml: "markup",
  svg: "markup",
  hbs: "handlebars",
  yml: "yaml",
  conf: "ini",
  cfg: "ini",
  patch: "diff",
};

function resolveGrammar(language: string): { name: string; grammar: Prism.Grammar } {
  const key = ALIAS[language] ?? language;
  const grammar = Prism.languages[key];
  if (grammar && typeof grammar === "object") {
    return { name: key, grammar: grammar as Prism.Grammar };
  }
  // Fallback: plaintext-ish via markup (always present, never undefined).
  return { name: "markup", grammar: Prism.languages.markup as Prism.Grammar };
}

interface CodeEditorProps {
  code: string;
  language: string;
  onChange: (next: string) => void;
}

/**
 * Tiny error boundary so a Prism crash in the highlight callback (or
 * a malformed grammar) doesn't take the whole window down. We fall
 * back to a raw, no-highlight textarea instead.
 */
class CodeEditorBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: any, info: any) {
    console.error("CodeEditor crashed, falling back:", error, info);
  }
  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

export const CodeEditor: React.FC<CodeEditorProps> = ({ code, language, onChange }) => {
  const { name: lang, grammar } = useMemo(() => resolveGrammar(language), [language]);
  const safeCode = typeof code === "string" ? code : "";
  const lineCount = useMemo(
    () => Math.max(1, safeCode.split("\n").length),
    [safeCode],
  );

  // Render-time `highlight` — wrapped so a Prism throw doesn't unmount
  // the surrounding card. The Editor itself stays mounted with raw text
  // rendered as fallback.
  const highlight = (input: string): string => {
    try {
      return Prism.highlight(input, grammar, lang);
    } catch (e) {
      console.error("Prism highlight failed:", e);
      // Plain HTML-escaped fallback so the editor still works.
      return input
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }
  };

  // Plain textarea fallback if the highlighted editor crashes outright.
  const fallback = (
    <textarea
      className="note-textarea mono"
      value={safeCode}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
    />
  );

  return (
    <div className="code-editor-wrap">
      <div className="code-editor-gutter" aria-hidden>
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i} className="code-editor-lineno">{i + 1}</div>
        ))}
      </div>
      <div className="code-editor-pane">
        <CodeEditorBoundary fallback={fallback}>
          <Editor
            value={safeCode}
            onValueChange={onChange}
            highlight={highlight}
            padding={0}
            textareaClassName="code-editor-textarea"
            preClassName="code-editor-pre"
            style={{
              fontFamily:
                '"JetBrains Mono", ui-monospace, "Cascadia Code", SFMono-Regular, Menlo, monospace',
              fontSize: 13,
              lineHeight: 1.55,
            }}
          />
        </CodeEditorBoundary>
      </div>
    </div>
  );
};
