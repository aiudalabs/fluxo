import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDoc, buildAssistantTools, ASSISTANT_TOOL_IDS, type Rest } from "./assistantTools.ts";
import type { Artifact } from "./harvest.ts";

const doc = (path: string, content: string): Artifact => ({ path, kind: "doc", content });

test("resolveDoc: la ÚLTIMA versión de un path gana (orden asc)", () => {
  const rows = [
    { artifacts: [doc("docs/BRIEF.md", "v1")] },
    { artifacts: [doc("docs/BRIEF.md", "v2 final")] },
  ];
  const r = resolveDoc(rows, "docs/BRIEF.md");
  assert.deepEqual(r, { content: "v2 final" });
});

test("resolveDoc: path inexistente → error + lista de disponibles", () => {
  const rows = [{ artifacts: [doc("docs/BRIEF.md", "x"), doc("docs/PRD.md", "y")] }];
  const r = resolveDoc(rows, "docs/NOPE.md");
  assert.ok("error" in r);
  assert.deepEqual((r as { disponibles: string[] }).disponibles, ["docs/BRIEF.md", "docs/PRD.md"]);
});

test("resolveDoc: trunca un doc gigante con marca", () => {
  const big = "a".repeat(30_000);
  const r = resolveDoc([{ artifacts: [doc("docs/BIG.md", big)] }], "docs/BIG.md");
  assert.ok("content" in r);
  const content = (r as { content: string }).content;
  assert.ok(content.length < big.length);
  assert.ok(content.endsWith("…(truncado)"));
});

test("resolveDoc: artifacts null no revienta", () => {
  const r = resolveDoc([{ artifacts: null }], "docs/BRIEF.md");
  assert.ok("error" in r);
});

test("buildAssistantTools: construye el MCP server sin tocar la red y expone los ids esperados", () => {
  let called = false;
  const rest: Rest = async () => { called = true; return [] as unknown as never; };
  const server = buildAssistantTools({ projectId: "p1", rest });
  assert.ok(server); // se construye
  assert.equal(called, false); // construir NO dispara ninguna query
  assert.deepEqual(ASSISTANT_TOOL_IDS, ["mcp__fluxo__read_backlog", "mcp__fluxo__read_story", "mcp__fluxo__read_sprints", "mcp__fluxo__read_brain_doc"]);
});
