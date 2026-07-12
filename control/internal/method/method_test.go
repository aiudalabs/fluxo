package method

import (
	"os"
	"path/filepath"
	"testing"
)

func methodsDir(t *testing.T) string {
	t.Helper()
	dir, _ := os.Getwd()
	for {
		cand := filepath.Join(dir, "registry", "methods")
		if fi, err := os.Stat(cand); err == nil && fi.IsDir() {
			return cand
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Skip("registry/methods not found")
		}
		dir = parent
	}
}

func TestLoadRealMethods(t *testing.T) {
	schemas, err := Load(methodsDir(t))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	scrum, ok := schemas["scrum"]
	if !ok {
		t.Fatal("scrum method not loaded")
	}
	if !scrum.HasLevel("sprint") {
		t.Error("scrum must have a sprint level")
	}
	if scrum.Leaf() != "story" {
		t.Errorf("scrum leaf = %q, want story", scrum.Leaf())
	}

	// The whole point (L-CQ-1): a sprint-less method loads through the SAME code —
	// no Go change, no branch on method id.
	kanban, ok := schemas["kanban"]
	if !ok {
		t.Fatal("kanban method not loaded")
	}
	if kanban.HasLevel("sprint") {
		t.Error("kanban must NOT have a sprint level")
	}
	if kanban.Leaf() != "story" {
		t.Errorf("kanban leaf = %q, want story", kanban.Leaf())
	}
	// Gate names come from the schema, not Go.
	if len(kanban.Gates) == 0 || kanban.Gates[0] != "discovery" {
		t.Errorf("kanban gates wrong: %v", kanban.Gates)
	}
}

func TestLoadRejectsIncomplete(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "bad.yaml"), []byte("id: x\ngates: [a]\n"), 0o644) // no levels
	if _, err := Load(dir); err == nil {
		t.Error("expected error for method without levels")
	}
}
