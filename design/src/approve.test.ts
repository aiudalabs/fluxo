import { test } from "node:test";
import assert from "node:assert/strict";
import {
  unsafePath, prDiffSafe, Approver, safeToApproveOne,
  type PendingRun, type WorkflowApprover,
} from "./approve.ts";

// Fake WorkflowApprover: sirve runs `action_required` + los files de cada PR, y registra qué runs
// se aprobaron. `failFiles`/`failApprove` inyectan errores para probar el best-effort.
function fakeGH(opts: {
  runs: PendingRun[];
  filesByPr: Record<number, string[]>;
  failFiles?: Set<number>;
  failApprove?: Set<number>;
}) {
  const approved: number[] = [];
  const fileCalls: number[] = [];
  const gh: WorkflowApprover = {
    async listActionRequiredRuns() { return opts.runs; },
    async listPRFiles(n) {
      fileCalls.push(n);
      if (opts.failFiles?.has(n)) throw new Error(`files boom #${n}`);
      return opts.filesByPr[n] ?? [];
    },
    async approveRun(id) {
      if (opts.failApprove?.has(id)) throw new Error(`approve boom ${id}`);
      approved.push(id);
    },
  };
  return { gh, approved, fileCalls };
}

// ── unsafePath (el guard exacto de v1) ────────────────────────────────────────────
test("unsafePath: solo .github/workflows/** es inseguro", () => {
  assert.equal(unsafePath(".github/workflows/claude.yml"), true);
  assert.equal(unsafePath(".github/workflows/nested/x.yml"), true);
  assert.equal(unsafePath(".github/workflows"), true);
  assert.equal(unsafePath("src/app.ts"), false);
  assert.equal(unsafePath(".github/dependabot.yml"), false); // no es workflows/
  assert.equal(unsafePath("docs/.github/workflows/x.yml"), false); // no en la raíz
});

// ── prDiffSafe ────────────────────────────────────────────────────────────────────
test("prDiffSafe: sin PRs → NO seguro (se deja al humano)", async () => {
  const { gh } = fakeGH({ runs: [], filesByPr: {} });
  assert.equal(await prDiffSafe(gh, [], new Map()), false);
});

test("prDiffSafe: PR con solo código → seguro", async () => {
  const { gh } = fakeGH({ runs: [], filesByPr: { 7: ["src/a.ts", "README.md"] } });
  assert.equal(await prDiffSafe(gh, [7], new Map()), true);
});

test("prDiffSafe: PR que toca un workflow → NO seguro", async () => {
  const { gh } = fakeGH({ runs: [], filesByPr: { 7: ["src/a.ts", ".github/workflows/evil.yml"] } });
  assert.equal(await prDiffSafe(gh, [7], new Map()), false);
});

test("prDiffSafe: varios PRs, uno inseguro → NO seguro", async () => {
  const { gh } = fakeGH({ runs: [], filesByPr: { 7: ["src/a.ts"], 8: [".github/workflows/x.yml"] } });
  assert.equal(await prDiffSafe(gh, [7, 8], new Map()), false);
});

test("prDiffSafe: cache reusa los files de un PR compartido", async () => {
  const { gh, fileCalls } = fakeGH({ runs: [], filesByPr: { 7: ["src/a.ts"] } });
  const cache = new Map<number, string[]>();
  await prDiffSafe(gh, [7], cache);
  await prDiffSafe(gh, [7], cache);
  assert.deepEqual(fileCalls, [7]); // un solo fetch pese a dos llamadas
});

// ── Approver.sweep ─────────────────────────────────────────────────────────────────
test("sweep: aprueba los runs seguros y bloquea los que tocan workflows", async () => {
  const { gh, approved } = fakeGH({
    runs: [
      { id: 100, prNumbers: [1] }, // seguro
      { id: 200, prNumbers: [2] }, // toca workflow → bloqueado
      { id: 300, prNumbers: [] },  // sin PR → bloqueado
    ],
    filesByPr: { 1: ["src/a.ts"], 2: [".github/workflows/x.yml"] },
  });
  const res = await new Approver().sweep(gh);
  assert.deepEqual(res.approved, [100]);
  assert.deepEqual(res.blocked.sort(), [200, 300]);
  assert.deepEqual(approved, [100]); // SOLO el seguro fue re-disparado
});

test("sweep: un error leyendo files no frena al resto (best-effort)", async () => {
  const { gh, approved } = fakeGH({
    runs: [
      { id: 100, prNumbers: [1] }, // files fallan → se saltea, no aprueba
      { id: 200, prNumbers: [2] }, // seguro → aprueba
    ],
    filesByPr: { 1: ["src/a.ts"], 2: ["src/b.ts"] },
    failFiles: new Set([1]),
  });
  const res = await new Approver().sweep(gh);
  assert.deepEqual(res.approved, [200]);
  assert.deepEqual(approved, [200]);
});

test("sweep: un error al aprobar no cuenta como aprobado", async () => {
  const { gh } = fakeGH({
    runs: [{ id: 100, prNumbers: [1] }],
    filesByPr: { 1: ["src/a.ts"] },
    failApprove: new Set([100]),
  });
  const res = await new Approver().sweep(gh);
  assert.deepEqual(res.approved, []);
  assert.deepEqual(res.blocked, []);
});

// ── safeToApproveOne (aprobación manual con el mismo guard) ─────────────────────────
test("safeToApproveOne: run inexistente → found:false", async () => {
  const { gh } = fakeGH({ runs: [{ id: 1, prNumbers: [1] }], filesByPr: { 1: ["src/a.ts"] } });
  assert.deepEqual(await safeToApproveOne(gh, 999), { found: false, safe: false });
});

test("safeToApproveOne: run que toca workflows → found:true, safe:false", async () => {
  const { gh } = fakeGH({ runs: [{ id: 1, prNumbers: [5] }], filesByPr: { 5: [".github/workflows/x.yml"] } });
  assert.deepEqual(await safeToApproveOne(gh, 1), { found: true, safe: false });
});

test("safeToApproveOne: run con solo código → found:true, safe:true", async () => {
  const { gh } = fakeGH({ runs: [{ id: 1, prNumbers: [5] }], filesByPr: { 5: ["src/a.ts"] } });
  assert.deepEqual(await safeToApproveOne(gh, 1), { found: true, safe: true });
});
