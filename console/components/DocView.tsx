"use client";

// DocView — renderiza un artefacto según su TIPO (path/kind), en UN solo lugar (el ArtifactView
// compartido: Studio, Registry, Brain lo usan). HTML → iframe navegable · MD → markdown · yaml/json/
// shell → código con syntax-highlight LIVIANO (tokenizer sin dep; spans seguros, sin
// dangerouslySetInnerHTML) · resto → monospace. Cambiás acá y cambia toda la UI.

import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Lang = "yaml" | "json" | "shell" | "text";
type Rule = [type: string, re: RegExp];

// Reglas por lenguaje (regex STICKY `y`, orden = prioridad). El tokenizer escanea desde cada
// posición; lo que no matchea ninguna regla cae a texto. Devuelve tokens → React escapa el texto.
const RULES: Record<Exclude<Lang, "text">, Rule[]> = {
  yaml: [
    ["str", /"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/y],
    ["comment", /#[^\n]*/y],
    ["key", /[A-Za-z0-9_.$/-]+(?=\s*:)/y],
    ["bool", /\b(?:true|false|null|yes|no|on|off)\b/y],
    ["num", /-?\b\d+(?:\.\d+)?\b/y],
    ["punct", /[:>|&*-]/y],
  ],
  json: [
    ["key", /"(?:[^"\\]|\\.)*"(?=\s*:)/y],
    ["str", /"(?:[^"\\]|\\.)*"/y],
    ["num", /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y],
    ["bool", /\b(?:true|false|null)\b/y],
    ["punct", /[{}[\]:,]/y],
  ],
  shell: [
    ["comment", /#[^\n]*/y],
    ["str", /"(?:[^"\\]|\\.)*"|'[^']*'/y],
    ["var", /\$\w+|\$\{[^}]*\}/y],
    ["flag", /(?<=\s)--?[A-Za-z][\w-]*/y],
    ["num", /\b\d+\b/y],
  ],
};

function tokenize(src: string, lang: Exclude<Lang, "text">): Array<{ t: string; v: string }> {
  const rules = RULES[lang];
  const out: Array<{ t: string; v: string }> = [];
  let i = 0;
  const pushText = (ch: string) => {
    const last = out[out.length - 1];
    if (last && last.t === "text") last.v += ch;
    else out.push({ t: "text", v: ch });
  };
  outer: while (i < src.length) {
    for (const [type, re] of rules) {
      re.lastIndex = i;
      const m = re.exec(src);
      if (m && m.index === i && m[0].length > 0) {
        out.push({ t: type, v: m[0] });
        i += m[0].length;
        continue outer;
      }
    }
    pushText(src[i]);
    i += 1;
  }
  return out;
}

function langFor(path: string, kind?: string): Lang {
  const p = (path || "").toLowerCase();
  if (p.endsWith(".json")) return "json";
  if (p.endsWith(".yaml") || p.endsWith(".yml")) return "yaml";
  if (p.endsWith(".sh") || p.endsWith(".bash") || p.endsWith(".env") || p.endsWith(".gate") || p.includes("vibeforge-gate")) return "shell";
  if (kind === "config") return "yaml"; // config sin extensión clara → yaml (el caso común)
  return "text";
}

function Code({ content, lang }: { content: string; lang: Lang }): ReactNode {
  const inner: ReactNode = lang === "text"
    ? content
    : tokenize(content, lang).map((tok, i) => (tok.t === "text" ? tok.v : <span key={i} className={`tok-${tok.t}`}>{tok.v}</span>));
  return <pre className="artifact-code">{inner}</pre>;
}

export function DocView({ content, path, kind }: { content: string; path: string; kind?: string }) {
  const p = (path || "").toLowerCase();
  const isHtml = p.endsWith(".html") || p.endsWith(".htm") || kind === "mockup";
  const isMd = p.endsWith(".md") || p.endsWith(".markdown") || kind === "doc";

  // HTML (mockups navegables) → iframe. sandbox allow-scripts para que corra su nav interna, SIN
  // allow-same-origin (origen opaco: no llega al parent ni a cookies). srcDoc = el HTML tal cual.
  if (isHtml) {
    return (
      <iframe
        title={path || "mockup"}
        srcDoc={content}
        sandbox="allow-scripts allow-popups"
        style={{ width: "100%", height: "82vh", minHeight: 600, border: "1px solid var(--stroke)", borderRadius: 12, background: "#fff", display: "block" }}
      />
    );
  }

  if (isMd) {
    return (
      <article className="docs-md artifact-md">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </article>
    );
  }

  // yaml / json / shell / sin extensión → código con highlight liviano (o monospace crudo si text).
  return <Code content={content} lang={langFor(path, kind)} />;
}
