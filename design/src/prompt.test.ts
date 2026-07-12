import { test } from "node:test";
import assert from "node:assert/strict";
import { composePrompt } from "./prompt.ts";

test("output/provisioning become write targets; _path inputs become reads; rest is context", () => {
  const p = composePrompt({
    inputs: {
      prd: "the PRD text",
      screens_path: "docs/UI_SCREENS.md",
      output: "docs/ARCHITECTURE.md",
      provisioning: "docs/provisioning.yaml",
    },
  });
  assert.match(p, /Entregables/);
  assert.match(p, /`docs\/ARCHITECTURE\.md`/);
  assert.match(p, /`docs\/provisioning\.yaml`/);
  assert.match(p, /Insumos ya en el workdir/);
  assert.match(p, /`docs\/UI_SCREENS\.md`/);
  assert.match(p, /### prd\nthe PRD text/);
  // The reply-text hack is gone: it must tell the agent to write to disk.
  assert.match(p, /ESCRIBI[ÉE]NDOLOS A DISCO/i);
  assert.doesNotMatch(p, /as your text response/i);
});

test("reviewer feedback and answered open questions are appended when present", () => {
  const p = composePrompt({
    inputs: { instructions: "idea", output: "docs/BRIEF.md" },
    feedback: "faltó la sección de métricas",
    answers: [{ q: "¿Seña?", a: "Sí, 30%" }],
  });
  assert.match(p, /Corrección del revisor/);
  assert.match(p, /faltó la sección de métricas/);
  assert.match(p, /Respuestas a las preguntas abiertas/);
  assert.match(p, /\*\*¿Seña\?\*\* → Sí, 30%/);
});

test("no feedback/answers → those sections are absent", () => {
  const p = composePrompt({ inputs: { instructions: "idea", output: "docs/BRIEF.md" } });
  assert.doesNotMatch(p, /Corrección del revisor/);
  assert.doesNotMatch(p, /Respuestas a las preguntas/);
});
