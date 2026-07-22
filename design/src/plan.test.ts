import { test } from "node:test";
import assert from "node:assert/strict";
import { parseActions, PlanParseError } from "./plan.ts";

// Un PLAN doc realista: prosa markdown + un bloque fenced ```yaml con actions.
const planDoc = (actionsYaml: string) => `# Sprint plan — SP3

## Goal
El cliente puede reservar un turno.

## Rationale
Las APIs van primero; difiero la pantalla.

## Actions
\`\`\`yaml
${actionsYaml}
\`\`\`
`;

test("parsea las 5 ops desde un bloque fenced yaml", () => {
  const acts = parseActions(planDoc(`actions:
  - op: move
    story_id: S-12
    args: { sprint_id: SP3 }
  - op: defer
    story_id: S-9
  - op: cancel
    story_id: S-8
  - op: edit
    story_id: S-7
    args: { title: "Nuevo título", deps: [S-1, S-2] }
  - op: split
    story_id: S-4
    args:
      parts:
        - id: S-4a
          title: "Checkout — carrito"
        - title: "Checkout — pago"
          owner: react-dev`));
  assert.equal(acts.length, 5);
  assert.deepEqual(acts[0], { op: "move", storyId: "S-12", sprintId: "SP3" });
  assert.deepEqual(acts[1], { op: "defer", storyId: "S-9" });
  assert.deepEqual(acts[2], { op: "cancel", storyId: "S-8" });
  assert.deepEqual(acts[3], { op: "edit", storyId: "S-7", fields: { title: "Nuevo título", deps: ["S-1", "S-2"] } });
  assert.equal(acts[4].op, "split");
  if (acts[4].op === "split") {
    assert.equal(acts[4].parts.length, 2);
    assert.deepEqual(acts[4].parts[0], { id: "S-4a", title: "Checkout — carrito" });
    assert.deepEqual(acts[4].parts[1], { title: "Checkout — pago", owner: "react-dev" });
  }
});

test("actions: [] es legal → plan que solo confirma el goal", () => {
  assert.deepEqual(parseActions(planDoc("actions: []")), []);
});

test("fallback: el archivo entero como YAML (sin fence) también sirve", () => {
  const whole = `actions:
  - op: cancel
    story_id: S-1`;
  assert.deepEqual(parseActions(whole), [{ op: "cancel", storyId: "S-1" }]);
});

test("ignora bloques fenced que no son el de actions", () => {
  const doc = `# Plan
\`\`\`
algo que no es yaml de actions
\`\`\`
\`\`\`yaml
actions:
  - op: defer
    story_id: S-2
\`\`\``;
  assert.deepEqual(parseActions(doc), [{ op: "defer", storyId: "S-2" }]);
});

test("edit con deps: [] es legal y BORRA las deps (reemplaza el set con vacío)", () => {
  const acts = parseActions(planDoc(`actions:
  - op: edit
    story_id: S-7
    args: { deps: [] }`));
  assert.deepEqual(acts, [{ op: "edit", storyId: "S-7", fields: { deps: [] } }]);
});

test("edit con screen_key se parsea", () => {
  const acts = parseActions(planDoc(`actions:
  - op: edit
    story_id: S-7
    args: { screen_key: client.booking }`));
  assert.deepEqual(acts, [{ op: "edit", storyId: "S-7", fields: { screen_key: "client.booking" } }]);
});

test("fence SIN lenguaje que contiene actions también se parsea", () => {
  const doc = "# Plan\n```\nactions:\n  - op: cancel\n    story_id: S-3\n```";
  assert.deepEqual(parseActions(doc), [{ op: "cancel", storyId: "S-3" }]);
});

// ── Caminos de error (garantizan la atomicidad: forma ilegal aborta nombrando la ofensora) ──
const rejects = (yaml: string, re: RegExp) =>
  assert.throws(() => parseActions(planDoc(yaml)), (e) => e instanceof PlanParseError && re.test(e.message));

test("op desconocido aborta", () => {
  rejects(`actions:
  - op: frobnicate
    story_id: S-1`, /op inválido/);
});

test("falta story_id aborta", () => {
  rejects(`actions:
  - op: cancel`, /falta story_id/);
});

test("move sin sprint_id aborta", () => {
  rejects(`actions:
  - op: move
    story_id: S-1`, /falta args.sprint_id/);
});

test("split con <2 partes aborta", () => {
  rejects(`actions:
  - op: split
    story_id: S-4
    args: { parts: [ { title: "sola" } ] }`, /≥2 partes/);
});

test("split con parte sin title aborta", () => {
  rejects(`actions:
  - op: split
    story_id: S-4
    args:
      parts:
        - title: "ok"
        - body: "sin title"`, /sin title/);
});

test("split con ids de parte duplicados aborta", () => {
  rejects(`actions:
  - op: split
    story_id: S-4
    args:
      parts:
        - id: S-4a
          title: "a"
        - id: S-4a
          title: "b"`, /ids de partes duplicados/);
});

test("edit sin campos aborta", () => {
  rejects(`actions:
  - op: edit
    story_id: S-7
    args: {}`, /sin campos a cambiar/);
});

test("edit con campo mal escrito aborta (no lo dropea en silencio)", () => {
  rejects(`actions:
  - op: edit
    story_id: S-7
    args: { title: "ok", acceptence: "- typo" }`, /campo desconocido en args: acceptence/);
});

test("defer con args aborta (probable move mal escrito)", () => {
  rejects(`actions:
  - op: defer
    story_id: S-9
    args: { sprint_id: SP3 }`, /no lleva args/);
});

test("edit con deps no-lista aborta", () => {
  rejects(`actions:
  - op: edit
    story_id: S-7
    args: { deps: "S-1" }`, /deps debe ser una lista/);
});

test("plan sin bloque actions aborta (fail loud, no silencioso)", () => {
  assert.throws(() => parseActions("# Plan\n\nSolo prosa, sin acciones."), (e) => e instanceof PlanParseError && /no se encontró un bloque/.test(e.message));
});

test("actions que no es lista aborta", () => {
  rejects(`actions:
  op: cancel`, /debe ser una lista/);
});
