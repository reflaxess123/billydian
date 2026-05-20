import React from "react";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";

// Hand-pick a popular set of languages. PrismLight only ships what we
// register here, so the bundle stays sane (~150 kB total for these).
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import c from "react-syntax-highlighter/dist/esm/languages/prism/c";
import cpp from "react-syntax-highlighter/dist/esm/languages/prism/cpp";
import csharp from "react-syntax-highlighter/dist/esm/languages/prism/csharp";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff";
import dockerfile from "react-syntax-highlighter/dist/esm/languages/prism/docker";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import graphql from "react-syntax-highlighter/dist/esm/languages/prism/graphql";
import handlebars from "react-syntax-highlighter/dist/esm/languages/prism/handlebars";
import ini from "react-syntax-highlighter/dist/esm/languages/prism/ini";
import java from "react-syntax-highlighter/dist/esm/languages/prism/java";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import kotlin from "react-syntax-highlighter/dist/esm/languages/prism/kotlin";
import lua from "react-syntax-highlighter/dist/esm/languages/prism/lua";
import markdownLang from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import nginx from "react-syntax-highlighter/dist/esm/languages/prism/nginx";
import objectivec from "react-syntax-highlighter/dist/esm/languages/prism/objectivec";
import perl from "react-syntax-highlighter/dist/esm/languages/prism/perl";
import php from "react-syntax-highlighter/dist/esm/languages/prism/php";
import powershell from "react-syntax-highlighter/dist/esm/languages/prism/powershell";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import ruby from "react-syntax-highlighter/dist/esm/languages/prism/ruby";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import scss from "react-syntax-highlighter/dist/esm/languages/prism/scss";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import swift from "react-syntax-highlighter/dist/esm/languages/prism/swift";
import toml from "react-syntax-highlighter/dist/esm/languages/prism/toml";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";

const LANGS: Array<[string, any]> = [
  ["bash", bash], ["sh", bash], ["shell", bash], ["zsh", bash], ["ps1", powershell],
  ["powershell", powershell],
  ["c", c], ["h", c],
  ["cpp", cpp], ["c++", cpp], ["cxx", cpp], ["hpp", cpp],
  ["cs", csharp], ["csharp", csharp],
  ["css", css],
  ["diff", diff], ["patch", diff],
  ["dockerfile", dockerfile], ["docker", dockerfile],
  ["go", go],
  ["graphql", graphql], ["gql", graphql],
  ["handlebars", handlebars], ["hbs", handlebars],
  ["ini", ini], ["conf", ini], ["cfg", ini],
  ["java", java],
  ["js", javascript], ["javascript", javascript], ["mjs", javascript], ["cjs", javascript],
  ["json", json], ["jsonc", json],
  ["jsx", jsx],
  ["kt", kotlin], ["kotlin", kotlin],
  ["lua", lua],
  ["md", markdownLang], ["markdown", markdownLang],
  ["html", markup], ["htm", markup], ["xml", markup], ["svg", markup], ["xhtml", markup],
  ["nginx", nginx],
  ["m", objectivec], ["mm", objectivec], ["objc", objectivec], ["objectivec", objectivec],
  ["pl", perl], ["perl", perl],
  ["php", php],
  ["py", python], ["python", python],
  ["rb", ruby], ["ruby", ruby],
  ["rs", rust], ["rust", rust],
  ["scss", scss], ["sass", scss],
  ["sql", sql],
  ["swift", swift],
  ["toml", toml],
  ["tsx", tsx],
  ["ts", typescript], ["typescript", typescript],
  ["yaml", yaml], ["yml", yaml],
];
const REGISTERED = new Set<string>();
for (const [name, lang] of LANGS) {
  if (!REGISTERED.has(name)) {
    SyntaxHighlighter.registerLanguage(name, lang);
    REGISTERED.add(name);
  }
}

const EXT_TO_LANG: Record<string, string> = {
  // Hand-picked, basename-driven exceptions go first
  "Dockerfile": "dockerfile",
  "Makefile":   "bash",
  "Procfile":   "yaml",
  "Gemfile":    "ruby",
  "Rakefile":   "ruby",
};

/** Resolve `(basename, content)` → Prism language id, or `null` if we
 *  can't recognise it. */
export function detectLanguage(name: string): string | null {
  // Special-case full basenames
  if (EXT_TO_LANG[name]) return EXT_TO_LANG[name];
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0 || dot === lower.length - 1) return null;
  const ext = lower.slice(dot + 1);
  // Map a few unusual extensions onto a registered language
  const explicit: Record<string, string> = {
    "mindmap":   "json",     // our own mindmap files
    "env":       "bash",
    "gitignore": "bash",
    "gitattributes": "bash",
    "editorconfig":  "ini",
    "lock":      "toml",
    "vue":       "html",
    "svelte":    "html",
    "asp":       "html",
    "aspx":      "html",
    "ejs":       "html",
    "twig":      "html",
  };
  if (explicit[ext]) return explicit[ext];
  // Direct match from our registered languages
  return REGISTERED.has(ext) ? ext : null;
}

interface CodeViewProps {
  code: string;
  language: string;
  isDark: boolean;
  /** Used as a hint for SyntaxHighlighter to drop noise in single-line files. */
  inline?: boolean;
}

export const CodeView: React.FC<CodeViewProps> = ({ code, language, isDark, inline }) => {
  const theme = isDark ? oneDark : oneLight;
  return (
    <SyntaxHighlighter
      language={language}
      style={theme as any}
      showLineNumbers={!inline}
      wrapLongLines={false}
      customStyle={{
        margin: 0,
        background: "transparent",
        fontSize: 13,
        lineHeight: 1.55,
        padding: 0,
      }}
      lineNumberStyle={{
        opacity: 0.4,
        minWidth: "2.25em",
        paddingRight: "1em",
        userSelect: "none",
      }}
      codeTagProps={{
        style: {
          fontFamily:
            '"JetBrains Mono", ui-monospace, "Cascadia Code", SFMono-Regular, Menlo, monospace',
        },
      }}
    >
      {code}
    </SyntaxHighlighter>
  );
};
