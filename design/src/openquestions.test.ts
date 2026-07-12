import { test } from "node:test";
import assert from "node:assert/strict";
import { extractOpenQuestions } from "./openquestions.ts";

test("pulls the bullets under an Open Questions H2", () => {
  const md = [
    "# Project Brief",
    "## 7. Success Metrics",
    "- 100 bookings/week",
    "## 8. Open Questions",
    "- ¿Se cobra seña al reservar?",
    "- ¿Qué pasa si la clienta no llega?",
    "## 9. Design Direction",
    "- like Linear",
  ].join("\n");
  assert.deepEqual(extractOpenQuestions(md), [
    "¿Se cobra seña al reservar?",
    "¿Qué pasa si la clienta no llega?",
  ]);
});

test("matches the Spanish heading 'Preguntas abiertas'", () => {
  const md = "## Preguntas abiertas\n1. ¿Idioma por defecto?\n2) ¿Multi-sucursal?\n";
  assert.deepEqual(extractOpenQuestions(md), ["¿Idioma por defecto?", "¿Multi-sucursal?"]);
});

test("a section that says 'ninguna' yields no questions", () => {
  const md = "## Open Questions\nNinguna — todo resuelto.\n";
  assert.deepEqual(extractOpenQuestions(md), []);
});

test("no open-questions section yields nothing", () => {
  assert.deepEqual(extractOpenQuestions("# Doc\n## Scope\n- a\n- b\n"), []);
  assert.deepEqual(extractOpenQuestions(""), []);
});

test("stops collecting at the next heading", () => {
  const md = "## Open Questions\n- q1\n## Next\n- not a question\n";
  assert.deepEqual(extractOpenQuestions(md), ["q1"]);
});
