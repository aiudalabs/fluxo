import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseIssueRefs, isAgentAssignee, derive, Projector,
  type GhIssue, type GhPr, type GhSource, type MirroredStory,
} from "./projection.ts";

// ── parseIssueRefs ────────────────────────────────────────────────────────────
test("parseIssueRefs separa closes de mentions", () => {
  const r = parseIssueRefs("Implementa la feature.\n\nCloses #12. Ver también #3 y Fixes #7.");
  assert.deepEqual(r.closes.sort((a, b) => a - b), [7, 12]);
  assert.deepEqual(r.mentions, [3]); // #3 mencionado pero no cerrado
});

test("parseIssueRefs reconoce Resolves/Fixed y no duplica", () => {
  const r = parseIssueRefs("resolves #1 fixed #1 closes #1");
  assert.deepEqual(r.closes, [1]);
  assert.deepEqual(r.mentions, []);
});

test("parseIssueRefs sin refs → vacío", () => {
  assert.deepEqual(parseIssueRefs("sin nada"), { closes: [], mentions: [] });
});

// ── isAgentAssignee ───────────────────────────────────────────────────────────
test("isAgentAssignee: bots y copilot sí, humanos no", () => {
  assert.equal(isAgentAssignee("github-actions[bot]"), true);
  assert.equal(isAgentAssignee("Copilot"), true);
  assert.equal(isAgentAssignee("nmlemus"), false);
});

// ── derive (switch de proyección) ─────────────────────────────────────────────
const issue = (over: Partial<GhIssue>): GhIssue => ({ number: 1, state: "open", assignees: [], labels: [], ...over });
const pr = (over: Partial<GhPr>): GhPr => ({ number: 10, state: "open", draft: false, merged: false, url: "u", closes: [], mentions: [], ...over });

test("derive: issue cerrado → done (aun con PR)", () => {
  assert.deepEqual(derive(issue({ state: "closed" }), [pr({})]), { kind: "done" });
});

test("derive: PR abierto no-draft → review con pr_url", () => {
  assert.deepEqual(derive(issue({}), [pr({ url: "https://pr/1" })]), { kind: "review", prUrl: "https://pr/1" });
});

test("derive: solo PR draft → running", () => {
  assert.deepEqual(derive(issue({}), [pr({ draft: true })]), { kind: "running" });
});

test("derive: asignado agente sin PR → running", () => {
  assert.deepEqual(derive(issue({ assignees: ["Copilot"] }), []), { kind: "running" });
});

test("derive: label agent:running sin PR/asignado → running", () => {
  assert.deepEqual(derive(issue({ labels: ["agent:running"] }), []), { kind: "running" });
});

test("derive: issue abierto sin nada → idle", () => {
  assert.deepEqual(derive(issue({}), []), { kind: "idle" });
});

test("derive: sin issue (no encontrado) → idle", () => {
  assert.deepEqual(derive(undefined, []), { kind: "idle" });
});

// ── Projector.syncProject (aplicación + histéresis) ───────────────────────────
// Un GhSource fake y un writer que captura las escrituras.
function fakeSource(issues: GhIssue[], prs: GhPr[], liveRuns = 0): GhSource {
  return { listIssues: async () => issues, listPulls: async () => prs, liveRunCount: async () => liveRuns };
}
function capture() {
  const writes: Array<{ id: string; status: string; prUrl?: string | null; agentLost?: string | null }> = [];
  const write = async (id: string, status: string, prUrl?: string | null, agentLost?: string | null) => { writes.push({ id, status, prUrl, agentLost }); };
  return { writes, write };
}
const story = (over: Partial<MirroredStory>): MirroredStory => ({ id: "s1", key: "S-1", status: "running", issue: 1, prUrl: null, ...over });

test("syncProject: PR con Closes #1 → story a review con su url", async () => {
  const { writes, write } = capture();
  const p = new Projector({ write });
  const s = fakeSource([issue({ number: 1 })], [pr({ number: 5, url: "https://pr/5", closes: [1] })]);
  const res = await p.syncProject(s, [story({ status: "running" })]);
  assert.deepEqual(writes, [{ id: "s1", status: "review", prUrl: "https://pr/5", agentLost: null }]);
  assert.equal(res.changes[0].to, "review");
});

test("syncProject: issue cerrado → done (desde review)", async () => {
  const { writes, write } = capture();
  const p = new Projector({ write });
  const s = fakeSource([issue({ number: 1, state: "closed" })], []);
  await p.syncProject(s, [story({ status: "review", prUrl: "https://pr/5" })]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].status, "done");
});

test("syncProject: no reescribe si ya está en el estado derivado (idempotente)", async () => {
  const { writes, write } = capture();
  const p = new Projector({ write });
  const s = fakeSource([issue({ number: 1, state: "closed" })], []);
  await p.syncProject(s, [story({ status: "done" })]);
  assert.deepEqual(writes, []);
});

test("HISTÉRESIS: running sin señal PERO con run vivo → NO se degrada", async () => {
  const { writes, write } = capture();
  const p = new Projector({ write, threshold: 3 });
  const s = fakeSource([issue({ number: 1 })], [], /*liveRuns*/ 1);
  for (let i = 0; i < 10; i++) await p.syncProject(s, [story({ status: "running" })]);
  assert.deepEqual(writes, []); // el agente está trabajando; jamás agent_lost
});

test("HISTÉRESIS: running sin señal y sin runs vivos → agent_lost SOLO al llegar al umbral", async () => {
  const { writes, write } = capture();
  const p = new Projector({ write, threshold: 3 });
  const s = fakeSource([issue({ number: 1 })], [], /*liveRuns*/ 0);
  const st = story({ status: "running" });
  await p.syncProject(s, [st]); assert.equal(writes.length, 0); // tick 1
  await p.syncProject(s, [st]); assert.equal(writes.length, 0); // tick 2
  await p.syncProject(s, [st]); assert.equal(writes.length, 1); // tick 3 → dispara
  assert.deepEqual(writes[0], { id: "s1", status: "backlog", prUrl: null, agentLost: "agent_lost" });
});

test("HISTÉRESIS: una señal fuerte en medio resetea el contador", async () => {
  const { writes, write } = capture();
  const p = new Projector({ write, threshold: 3 });
  const idle = fakeSource([issue({ number: 1 })], [], 0);
  const alive = fakeSource([issue({ number: 1, assignees: ["Copilot"] })], [], 0);
  const st = story({ status: "running" });
  await p.syncProject(idle, [st]);  // tick 1: stale=1
  await p.syncProject(idle, [st]);  // tick 2: stale=2
  await p.syncProject(alive, [st]); // señal fuerte → reset (running ya = running, no escribe)
  await p.syncProject(idle, [st]);  // stale=1 de nuevo
  await p.syncProject(idle, [st]);  // stale=2
  assert.equal(writes.length, 0);   // nunca llegó a 3 seguidos
});

test("histéresis NO aplica a stories no-vivas: un backlog sin señal jamás se toca", async () => {
  const { writes, write } = capture();
  const p = new Projector({ write, threshold: 2 });
  const s = fakeSource([issue({ number: 1 })], [], 0);
  for (let i = 0; i < 5; i++) await p.syncProject(s, [story({ status: "backlog" })]);
  assert.deepEqual(writes, []);
});

test("syncProject: un PR draft mueve backlog→running (arranque detectado)", async () => {
  const { writes, write } = capture();
  const p = new Projector({ write });
  const s = fakeSource([issue({ number: 1 })], [pr({ draft: true, closes: [1] })]);
  await p.syncProject(s, [story({ status: "backlog" })]);
  assert.deepEqual(writes, [{ id: "s1", status: "running", prUrl: null, agentLost: null }]);
});
