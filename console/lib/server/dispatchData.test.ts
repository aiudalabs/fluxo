// F6a · Test del pegamento del despacho del console (computeCandidates + policyFrom). El KERNEL
// puro (candidates/prompts) ya está testeado en design/src/dispatch.test.ts; acá cubrimos lo que
// el console AGREGA: default de concurrencia = 0 (manual, no --max), mapeo row→DStory (issueNumOf
// desde external_ref), traducción uuid→KEY (el handle estable de cara al cliente), y el filtro a
// claude_action (copilot no cableado en v2). Runner: node --test --experimental-strip-types.

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeCandidates, capWaitingByKey, policyFrom, type Settings } from "./dispatchData.ts";
import type { CapabilityGate, ResolvedCapability } from "../../../design/src/capabilities.ts";

type Row = {
  id: string; key: string; title: string; lane: string | null; status: string;
  sprint_id: string | null; blocked_by: string[] | null; external_ref: string | null;
  body: string | null; acceptance: string | null; screen_key: string | null;
};
const story = (o: Partial<Row> & { id: string; key: string; status: string }): Row => ({
  title: o.key, lane: null, sprint_id: null, blocked_by: null, external_ref: null,
  body: null, acceptance: null, screen_key: null, ...o,
});
const ref = (n: number) => `github:nmlemus/idearium#${n}`;
const sprints = [{ id: "sp1", key: "SP1", title: "Sprint 1" }, { id: "sp2", key: "SP2", title: "Sprint 2" }];

test("policyFrom: default maxConcurrency=0 (manual, no --max), respeta explícito y lanes", () => {
  assert.equal(policyFrom({}).maxConcurrency, 0);
  assert.equal(policyFrom({ max_concurrency: 2 }).maxConcurrency, 2);
  assert.equal(policyFrom({ execution_unit: "sprint" }).executionUnit, "sprint");
  const pol = policyFrom({ lanes: { ui: { channel: "copilot", model: "x" } } });
  assert.equal(pol.channelByLane.get("ui"), "copilot");
  assert.equal(pol.modelByLane.get("ui"), "x");
});

test("story mode: solo backlog espejadas con deps done; keyed por KEY", () => {
  const rows: Row[] = [
    story({ id: "a", key: "S1-01", status: "backlog", sprint_id: "sp1", external_ref: ref(1) }),
    story({ id: "b", key: "S1-02", status: "backlog", sprint_id: "sp1", external_ref: ref(2) }),
    story({ id: "c", key: "S1-03", status: "backlog", sprint_id: "sp1", external_ref: ref(3), blocked_by: ["a"] }), // dep no-done
    story({ id: "d", key: "S2-01", status: "backlog", sprint_id: "sp2" }), // NO espejada (sin issue)
  ];
  const cands = computeCandidates(rows, sprints, {});
  assert.deepEqual(cands.map((c) => c.id).sort(), ["S1-01", "S1-02"]);
  const first = cands.find((c) => c.id === "S1-01")!;
  assert.equal(first.kind, "story");
  assert.deepEqual(first.storyKeys, ["S1-01"]);
  assert.deepEqual(first.issues, [1]);
});

test("story mode: filtra candidatos ruteados a un canal != claude_action", () => {
  const rows: Row[] = [
    story({ id: "a", key: "S1-01", status: "backlog", lane: "ui", external_ref: ref(1) }),
    story({ id: "b", key: "S1-02", status: "backlog", lane: "py", external_ref: ref(2) }),
  ];
  const settings: Settings = { lanes: { ui: { channel: "copilot" } } };
  const cands = computeCandidates(rows, sprints, settings);
  assert.deepEqual(cands.map((c) => c.id), ["S1-02"]); // ui→copilot no cableado → oculto
});

test("sprint mode: solo el sprint sin deps cross-sprint pendientes; id=KEY, issues del backlog", () => {
  const rows: Row[] = [
    story({ id: "a", key: "S1-01", status: "backlog", sprint_id: "sp1", external_ref: ref(1) }),
    story({ id: "b", key: "S1-02", status: "backlog", sprint_id: "sp1", external_ref: ref(2), blocked_by: ["a"] }), // intra-sprint, no gatea
    story({ id: "c", key: "S2-01", status: "backlog", sprint_id: "sp2", external_ref: ref(3), blocked_by: ["a"] }), // cross-sprint, gatea SP2
  ];
  const cands = computeCandidates(rows, sprints, { execution_unit: "sprint" });
  assert.equal(cands.length, 1);
  const sp1 = cands[0];
  assert.equal(sp1.kind, "sprint");
  assert.equal(sp1.id, "SP1");
  assert.deepEqual(sp1.storyKeys, ["S1-01", "S1-02"]);
  assert.deepEqual(sp1.issues, [1, 2]);
});

test("concurrencia: con max_concurrency=1 y una running, no hay candidatos", () => {
  const rows: Row[] = [
    story({ id: "a", key: "S1-01", status: "running", external_ref: ref(1) }),
    story({ id: "b", key: "S1-02", status: "backlog", external_ref: ref(2) }),
  ];
  assert.deepEqual(computeCandidates(rows, sprints, { max_concurrency: 1 }), []);
});

// ── P6-2b · Paso 3 · readiness gate por capability (glue del console) ─────────────
const gateOf = (needs: Record<string, string[]>, green: string[]): CapabilityGate => ({
  needsByStoryId: new Map(Object.entries(needs)),
  green: new Set(green),
});
const CAPS: ResolvedCapability[] = [{ id: "firebase", name: "Firebase", secret: "FIREBASE_SERVICE_ACCOUNT" }];

test("computeCandidates(gate): story con need NO 🟢 no es candidata; 🟢 sí (mismo mapeo uuid→KEY)", () => {
  const rows: Row[] = [story({ id: "a", key: "S1-01", status: "backlog", external_ref: ref(1) })];
  const needs = { a: ["firebase"] };
  assert.deepEqual(computeCandidates(rows, sprints, {}, gateOf(needs, [])), []);           // firebase ⚪
  const ok = computeCandidates(rows, sprints, {}, gateOf(needs, ["firebase"]));             // firebase 🟢
  assert.deepEqual(ok.map((c) => c.id), ["S1-01"]);
});

test("computeCandidates(gate): sin gate = comportamiento anterior (no gatea)", () => {
  const rows: Row[] = [story({ id: "a", key: "S1-01", status: "backlog", external_ref: ref(1) })];
  assert.deepEqual(computeCandidates(rows, sprints, {}).map((c) => c.id), ["S1-01"]);
});

test("capWaitingByKey: story backlog con need no-🟢 → nombre de capability por KEY; 🟢 → nada", () => {
  const rows: Row[] = [
    story({ id: "a", key: "S1-01", status: "backlog", external_ref: ref(1) }),
    story({ id: "b", key: "S1-02", status: "backlog", external_ref: ref(2) }),
  ];
  const gate = gateOf({ a: ["firebase"], b: ["firebase"] }, ["firebase"]); // b's need SÍ está verde
  // solo `a` espera si firebase NO está verde:
  const w = capWaitingByKey(rows, gateOf({ a: ["firebase"] }, []), CAPS);
  assert.deepEqual(w, { "S1-01": ["Firebase"] });
  // con firebase verde, nadie espera:
  assert.deepEqual(capWaitingByKey(rows, gate, CAPS), {});
});

test("capWaitingByKey: solo stories backlog (una done/running no espera aunque referencie el secret)", () => {
  const rows: Row[] = [
    story({ id: "a", key: "S1-01", status: "done", external_ref: ref(1) }),
    story({ id: "b", key: "S1-02", status: "running", external_ref: ref(2) }),
  ];
  assert.deepEqual(capWaitingByKey(rows, gateOf({ a: ["firebase"], b: ["firebase"] }, []), CAPS), {});
});
