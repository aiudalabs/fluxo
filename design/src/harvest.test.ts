import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotDir, harvestChanged, classifyKind, primaryText } from "./harvest.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "fluxo-harvest-"));
}
function write(dir: string, rel: string, content: string): void {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

test("classifyKind maps by extension", () => {
  assert.equal(classifyKind("docs/mockups/patient.html"), "mockup");
  assert.equal(classifyKind("docs/BRIEF.md"), "doc");
  assert.equal(classifyKind("docs/provisioning.yaml"), "config");
  assert.equal(classifyKind("bin/data"), "file");
});

test("harvests only files new or changed since the snapshot", () => {
  const dir = tmp();
  try {
    write(dir, "docs/PRD.md", "old prd");
    const before = snapshotDir(dir);

    // A new file and a modified existing file (bump mtime forward to be deterministic).
    write(dir, "docs/ARCHITECTURE.md", "arch");
    const future = new Date(Date.now() + 10_000);
    write(dir, "docs/PRD.md", "new prd");
    utimesSync(join(dir, "docs/PRD.md"), future, future);

    const got = harvestChanged(dir, before).map((a) => a.path);
    assert.deepEqual(got, ["docs/ARCHITECTURE.md", "docs/PRD.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a multi-file phase (mockups) harvests every surface", () => {
  const dir = tmp();
  try {
    const before = snapshotDir(dir); // empty workdir
    write(dir, "docs/mockups/index.html", "<html>index</html>");
    write(dir, "docs/mockups/patient.html", "<html>patient</html>");
    write(dir, "docs/mockups/doctor.html", "<html>doctor</html>");
    const arts = harvestChanged(dir, before);
    assert.deepEqual(arts.map((a) => a.path), [
      "docs/mockups/doctor.html",
      "docs/mockups/index.html",
      "docs/mockups/patient.html",
    ]);
    assert.ok(arts.every((a) => a.kind === "mockup"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a multi-artifact phase (architecture) harvests doc + config together", () => {
  const dir = tmp();
  try {
    const before = snapshotDir(dir);
    write(dir, "docs/ARCHITECTURE.md", "# Architecture\nprose");
    write(dir, "docs/provisioning.yaml", "roles: []");
    const arts = harvestChanged(dir, before);
    assert.deepEqual(
      arts.map((a) => [a.path, a.kind]),
      [
        ["docs/ARCHITECTURE.md", "doc"],
        ["docs/provisioning.yaml", "config"],
      ],
    );
    // The prose doc is what the next phase reads as output.text.
    assert.equal(primaryText(arts), "# Architecture\nprose");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ignores node_modules / .git noise", () => {
  const dir = tmp();
  try {
    const before = snapshotDir(dir);
    write(dir, "docs/BRIEF.md", "brief");
    write(dir, "node_modules/pkg/index.js", "junk");
    write(dir, ".git/HEAD", "ref");
    assert.deepEqual(harvestChanged(dir, before).map((a) => a.path), ["docs/BRIEF.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
