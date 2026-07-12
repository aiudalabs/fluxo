// F6-02 · Workdir-harvest (decision D5). The design agent writes its deliverables to a
// scoped workdir AS THE ROLE ALREADY ASKS (docs/BRIEF.md, docs/mockups/*.html,
// ARCHITECTURE.md + provisioning.yaml, …) — no "put it in the reply" hack. The runtime
// then COSECHA the files the phase produced and hands them to the brain + Studio.
//
// Harvesting is by DIFF, not by declared path: we snapshot the workdir before the phase
// and collect every file that is new or changed after it. That is what makes multi-file
// phases fall out naturally — mockups (one HTML per surface) and architecture
// (ARCHITECTURE.md + provisioning.yaml) both just work, with no per-phase special-casing.
//
// Pure + deterministic (no SDK): given a dir and a prior snapshot, it returns artifacts.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

export type ArtifactKind = "mockup" | "doc" | "config" | "file";

export interface Artifact {
  path: string; // workdir-relative, POSIX separators (docs/BRIEF.md)
  kind: ArtifactKind;
  content: string;
}

const IGNORE_DIRS = new Set([".git", "node_modules", ".next", ".cache"]);

export function classifyKind(path: string): ArtifactKind {
  const lower = path.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "mockup";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "doc";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml") || lower.endsWith(".json")) return "config";
  return "file";
}

function walk(dir: string, base: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), base, out);
    } else if (entry.isFile()) {
      out.push(relative(base, join(dir, entry.name)).split(sep).join("/"));
    }
  }
}

// snapshotDir maps every file (workdir-relative) to its mtime, so a later harvest can
// tell what the phase created or changed. A missing dir yields an empty snapshot.
export function snapshotDir(dir: string): Map<string, number> {
  const snap = new Map<string, number>();
  if (!existsSync(dir)) return snap;
  const files: string[] = [];
  walk(dir, dir, files);
  for (const rel of files) snap.set(rel, statSync(join(dir, rel)).mtimeMs);
  return snap;
}

// harvestChanged returns the artifacts that are new or modified relative to `before`.
export function harvestChanged(dir: string, before: Map<string, number>): Artifact[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  walk(dir, dir, files);
  const artifacts: Artifact[] = [];
  for (const rel of files) {
    const mtime = statSync(join(dir, rel)).mtimeMs;
    const prior = before.get(rel);
    if (prior !== undefined && mtime <= prior) continue; // unchanged since the snapshot
    artifacts.push({ path: rel, kind: classifyKind(rel), content: readFileSync(join(dir, rel), "utf8") });
  }
  artifacts.sort((a, b) => a.path.localeCompare(b.path));
  return artifacts;
}

// primaryText picks the doc a downstream phase reads as `$<phase>.output.text`. Prefer
// the largest markdown doc (the brief/PRD/architecture prose); fall back to the first
// artifact's content, or "" if the phase produced nothing.
export function primaryText(artifacts: Artifact[]): string {
  const docs = artifacts.filter((a) => a.kind === "doc");
  const pick = (docs.length ? docs : artifacts).reduce<Artifact | undefined>(
    (best, a) => (best && best.content.length >= a.content.length ? best : a),
    undefined,
  );
  return pick?.content ?? "";
}
