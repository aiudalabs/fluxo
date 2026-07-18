"use client";

// DocView — renderiza un artefacto según su TIPO (path/kind), en UN solo lugar. Es el primer paso
// del ArtifactView compartido (ver memoria fluxo-improvements-backlog): HTML → iframe navegable,
// MD → markdown, resto → monospace. El resaltado de sintaxis para yaml/json/shell llega en la
// sesión de improvements — cuando se agregue acá, cambia en TODA la UI que use este componente.
// Objetivo: que Studio/Registry/Brain rendericen igual y no haya hardcode caso-a-caso.

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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

  // yaml / json / shell / sin extensión → monospace crudo (highlight = sesión de improvements).
  return (
    <pre style={{
      margin: 0, padding: "12px 14px", background: "var(--bg2)", border: "1px solid var(--stroke)",
      borderRadius: 8, fontSize: 12.5, lineHeight: 1.55, overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word",
    }}>{content}</pre>
  );
}
