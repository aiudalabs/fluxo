import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldMerge, prNumFromUrl, AutoMerger,
  type PrMergeInfo, type MergeSource,
} from "./automerge.ts";

// ── helpers ─────────────────────────────────────────────────────────────────────
const info = (over: Partial<PrMergeInfo> = {}): PrMergeInfo => ({
  number: over.number ?? 1,
  state: over.state ?? "OPEN",
  isDraft: over.isDraft ?? false,
  mergeStateStatus: over.mergeStateStatus ?? "CLEAN",
  reviewDecision: "reviewDecision" in over ? over.reviewDecision! : "APPROVED",
  headRefName: over.headRefName ?? "feat/x",
});

// Fake MergeSource: sirve un PrMergeInfo por número y registra los merges; `failMerge` hace fallar
// el merge de un número dado (para probar los retries acotados).
function fakeSource(byNum: Record<number, PrMergeInfo>, failMerge = new Set<number>()) {
  const infoCalls: number[] = [];
  const merges: number[] = [];
  const source: MergeSource = {
    async prMergeInfo(n) { infoCalls.push(n); const i = byNum[n]; if (!i) throw new Error(`no info for #${n}`); return i; },
    async mergePr(n) { if (failMerge.has(n)) throw new Error(`boom #${n}`); merges.push(n); },
  };
  return { source, infoCalls, merges };
}

// ── shouldMerge (predicado money-critical) ────────────────────────────────────────
test("shouldMerge: CLEAN + APPROVED → true", () => {
  assert.equal(shouldMerge(info({ mergeStateStatus: "CLEAN", reviewDecision: "APPROVED" })), true);
});
test("shouldMerge: CLEAN + reviewDecision null (sin review requerido) → true", () => {
  assert.equal(shouldMerge(info({ mergeStateStatus: "CLEAN", reviewDecision: null })), true);
});
test("shouldMerge: CHANGES_REQUESTED → false (aunque CLEAN)", () => {
  assert.equal(shouldMerge(info({ mergeStateStatus: "CLEAN", reviewDecision: "CHANGES_REQUESTED" })), false);
});
test("shouldMerge: no-CLEAN (BLOCKED) → false", () => {
  assert.equal(shouldMerge(info({ mergeStateStatus: "BLOCKED" })), false);
});
test("shouldMerge: no-CLEAN (UNSTABLE, un check rojo) → false", () => {
  assert.equal(shouldMerge(info({ mergeStateStatus: "UNSTABLE" })), false);
});
test("shouldMerge: draft → false", () => {
  assert.equal(shouldMerge(info({ isDraft: true })), false);
});
test("shouldMerge: PR ya cerrado → false", () => {
  assert.equal(shouldMerge(info({ state: "CLOSED" })), false);
});
test("shouldMerge: PR ya mergeado → false", () => {
  assert.equal(shouldMerge(info({ state: "MERGED" })), false);
});

// ── prNumFromUrl ──────────────────────────────────────────────────────────────────
test("prNumFromUrl: parsea el número de una pr_url", () => {
  assert.equal(prNumFromUrl("https://github.com/acme/repo/pull/42"), 42);
  assert.equal(prNumFromUrl("https://github.com/acme/repo/pull/42/files"), 42);
  assert.equal(prNumFromUrl("https://github.com/acme/repo/issues/42"), null); // issue, no PR
  assert.equal(prNumFromUrl(null), null);
});

// ── AutoMerger: dedup + gate + retries ─────────────────────────────────────────────
test("AutoMerger: mergea un PR CLEAN+approved una sola vez (dedup del sprint)", async () => {
  const { source, infoCalls, merges } = fakeSource({ 5: info({ number: 5 }) });
  const am = new AutoMerger();
  // Un sprint = 1 PR que cierra 3 issues → 3 stories en review con el mismo pr_url → [5,5,5].
  const res = await am.reconcile(source, [5, 5, 5], "proj");
  assert.deepEqual(res.merged, [5]);
  assert.deepEqual(merges, [5]);
  assert.equal(infoCalls.length, 1); // dedup: se evalúa el PR una sola vez
});

test("AutoMerger: NO mergea un PR con CHANGES_REQUESTED", async () => {
  const { source, merges } = fakeSource({ 7: info({ number: 7, reviewDecision: "CHANGES_REQUESTED" }) });
  const am = new AutoMerger();
  const res = await am.reconcile(source, [7], "proj");
  assert.deepEqual(res.merged, []);
  assert.deepEqual(merges, []);
  assert.equal(res.skipped[0].reason.startsWith("not_ready"), true);
});

test("AutoMerger: retries acotados — tras maxFails deja el PR para el humano", async () => {
  const { source } = fakeSource({ 9: info({ number: 9 }) }, new Set([9]));
  const am = new AutoMerger({ maxFails: 3 });
  // 3 ticks: cada uno intenta el merge y falla.
  for (let i = 1; i <= 3; i++) {
    const res = await am.reconcile(source, [9], "proj");
    assert.equal(res.merged.length, 0);
    assert.equal(res.skipped[0].reason, `merge_failed(${i}/3)`);
  }
  // 4º tick: agotó los retries → skip por max_fails, sin intentar el merge.
  const res = await am.reconcile(source, [9], "proj");
  assert.equal(res.skipped[0].reason, "max_fails");
});

test("AutoMerger: los contadores de fallo se aíslan por scope (PR#5 de proj-A no afecta proj-B)", async () => {
  const srcA = fakeSource({ 5: info({ number: 5 }) }, new Set([5])); // falla siempre
  const srcB = fakeSource({ 5: info({ number: 5 }) });              // mergea limpio
  const am = new AutoMerger({ maxFails: 3 });
  for (let i = 0; i < 3; i++) await am.reconcile(srcA.source, [5], "proj-A"); // agota A
  const skippedA = await am.reconcile(srcA.source, [5], "proj-A");
  assert.equal(skippedA.skipped[0].reason, "max_fails");
  // proj-B con el MISMO número de PR sigue mergeando (contador aislado).
  const resB = await am.reconcile(srcB.source, [5], "proj-B");
  assert.deepEqual(resB.merged, [5]);
});

test("AutoMerger: un merge exitoso limpia el contador de fallos previos", async () => {
  const failing = new Set([3]);
  const { source } = fakeSource({ 3: info({ number: 3 }) }, failing);
  const am = new AutoMerger({ maxFails: 3 });
  await am.reconcile(source, [3], "proj"); // fallo 1/3
  await am.reconcile(source, [3], "proj"); // fallo 2/3
  failing.delete(3);                       // el PR ya mergea
  const ok = await am.reconcile(source, [3], "proj");
  assert.deepEqual(ok.merged, [3]);
  // Si volviera a fallar, el contador arranca de cero (no arrastra los 2 previos).
  failing.add(3);
  const again = await am.reconcile(source, [3], "proj");
  assert.equal(again.skipped[0].reason, "merge_failed(1/3)");
});
