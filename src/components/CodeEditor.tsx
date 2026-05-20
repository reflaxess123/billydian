import React, { useMemo } from "react";
import Editor from "react-simple-code-editor";
import Prism from "prismjs";

// Same registered grammars as the read-only CodeView. Each component
// here primes Prism with one language definition.
import "prismjs/components/prism-bash";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-csharp";
import "prismjs/components/prism-css";
import "prismjs/components/prism-diff";
import "prismjs/components/prism-docker";
import "prismjs/components/prism-go";
import "prismjs/components/prism-graphql";
import "prismjs/components/prism-handlebars";
import "prismjs/components/prism-ini";
import "prismjs/components/prism-java";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-json";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-kotlin";
import "prismjs/components/prism-lua";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-nginx";
import "prismjs/components/prism-objectivec";
import "prismjs/components/prism-perl";
import "prismjs/components/prism-php";
import "prismjs/components/prism-powershell";
import "prismjs/components/prism-python";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-scss";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-swift";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-yaml";

// Language alias map for the small set of Prism IDs that differ from
// the ones we hand out from `detectLanguage`.
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
  if (Prism.languages[key]) {
    return { name: key, grammar: Prism.languages[key] as Prism.Grammar };
  }
  return { name: "markup", grammar: Prism.languages.markup as Prism.Grammar };
}

interface CodeEditorProps {
  code: string;
  language: string;
  onChange: (next: string) => void;
}

export const CodeEditor: React.FC<CodeEditorProps> = ({ code, language, onChange }) => {
  const { name: lang, grammar } = useMemo(() => resolveGrammar(language), [language]);
  const lineCount = useMemo(() => Math.max(1, code.split("\n").length), [code]);

  return (
    <div className="code-editor-wrap">
      <div className="code-editor-gutter" aria-hidden>
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i} className="code-editor-lineno">{i + 1}</div>
        ))}
      </div>
      <div className="code-editor-pane">
        <Editor
          value={code}
          onValueChange={onChange}
          highlight={(c) => Prism.highlight(c, grammar, lang)}
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
      </div>
    </div>
  );
};
