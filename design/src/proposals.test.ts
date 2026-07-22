import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProposals, registryPath, ProposalError, type Proposal } from "./proposals.ts";

const retroDoc = (proposalsYaml: string) => `# Retro — SP3

## What worked
Todo bien.

## What didn't
La fase ux se colgó 3 veces.

## Proposals
\`\`\`yaml
${proposalsYaml}
\`\`\`
`;

test("parsea propuestas de los 3 kinds", () => {
  const ps = parseProposals(retroDoc(`proposals:
  - kind: skill
    id: ui-screens-template
    rationale: "genera todo de una"
    evidence: "SP3 ux attempts=3"
    content: |
      # Skill — ui-screens-template
      contenido mejorado
  - kind: agent
    id: ux
    content: "# Persona — ux\\nmejor"
  - kind: workflow
    id: design
    content: "id: design\\nsteps: []"`));
  assert.equal(ps.length, 3);
  assert.equal(ps[0].kind, "skill");
  assert.equal(ps[0].id, "ui-screens-template");
  assert.match(ps[0].content, /contenido mejorado/);
  assert.equal(ps[0].rationale, "genera todo de una");
  assert.equal(ps[1].kind, "agent");
  assert.equal(ps[2].kind, "workflow");
});

test("proposals: [] es legal → el método aguantó", () => {
  assert.deepEqual(parseProposals(retroDoc("proposals: []")), []);
});

test("registryPath: agent/skill → .md, workflow → .yaml", () => {
  assert.equal(registryPath({ kind: "agent", id: "ux", content: "x" }), "agents/ux.md");
  assert.equal(registryPath({ kind: "skill", id: "ui-screens-template", content: "x" }), "skills/ui-screens-template.md");
  assert.equal(registryPath({ kind: "workflow", id: "design", content: "x" }), "workflows/design.yaml");
});

// ── Candados (lo más sensible: esto edita el método de la fábrica) ──────────────────
const rejects = (yaml: string, re: RegExp) =>
  assert.throws(() => parseProposals(retroDoc(yaml)), (e) => e instanceof ProposalError && re.test(e.message));

test("kind inválido aborta", () => {
  rejects(`proposals:
  - kind: config
    id: x
    content: y`, /kind inválido/);
});

test("candado: NUNCA el método propio de la retro (retro-analyst/retro-method/retro)", () => {
  rejects(`proposals:
  - kind: agent
    id: retro-analyst
    content: "hackeo"`, /método propio de la retro/);
  rejects(`proposals:
  - kind: skill
    id: retro-method
    content: "hackeo"`, /método propio de la retro/);
  rejects(`proposals:
  - kind: workflow
    id: retro
    content: "hackeo"`, /método propio de la retro/);
});

test("candado: casing NO evade el método propio (Retro-Analyst = retro-analyst en FS case-insensitive)", () => {
  // El bug: regex con flag `i` aceptaba mayúsculas y PROTECTED comparaba minúscula exacta → en macOS
  // (FS case-insensitive) 'Retro-Analyst' escribía sobre retro-analyst.md. El id ahora es minúscula pura.
  rejects(`proposals:
  - kind: agent
    id: Retro-Analyst
    content: hack`, /no path-safe/);
  rejects(`proposals:
  - kind: skill
    id: RETRO-METHOD
    content: hack`, /no path-safe/);
});

test("candado: id con path traversal aborta", () => {
  rejects(`proposals:
  - kind: skill
    id: "../../etc/passwd"
    content: y`, /no path-safe/);
  rejects(`proposals:
  - kind: skill
    id: "..vecino"
    content: y`, /no path-safe/);
});

test("falta content aborta (whole-file replace)", () => {
  rejects(`proposals:
  - kind: skill
    id: ux-screens
    rationale: "sin content"`, /falta content/);
});

test("falta id aborta", () => {
  rejects(`proposals:
  - kind: skill
    content: y`, /falta id/);
});

test("otro agente/skill/workflow NO protegido sí se permite (solo el propio de la retro está vedado)", () => {
  const ps = parseProposals(retroDoc(`proposals:
  - kind: agent
    id: reviewer
    content: "# reviewer mejorado"`));
  assert.equal(ps[0].id, "reviewer"); // reviewer no es el método de la retro → OK
});

test("retro sin bloque proposals aborta (fail loud)", () => {
  assert.throws(() => parseProposals("# Retro\n\nsolo prosa"), (e) => e instanceof ProposalError && /no se encontró/.test(e.message));
});
