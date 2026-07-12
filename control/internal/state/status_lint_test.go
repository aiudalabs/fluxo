package state

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// These are the architecture lints that keep the RLS/state-machine discipline
// from eroding (the AC of F2-03). They run as ordinary `go test`, so CI enforces
// them with no extra tooling.

// controlRoot walks up from the package dir to the module root (control/).
func controlRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("could not find control/go.mod")
		}
		dir = parent
	}
}

func walkGoFiles(t *testing.T, root string, fn func(path string, src string)) {
	t.Helper()
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		fn(path, string(b))
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
}

// TestNoRawStatusLiterals: status strings may appear only in status.go (their
// definition). Anywhere else, code must use the typed Status constants — this is
// the Go-side guard against L-CQ-2 (scattered status='…' writes).
func TestNoRawStatusLiterals(t *testing.T) {
	root := controlRoot(t)
	statuses := []string{"backlog", "ready", "running", "review", "done", "failed", "blocked"}
	walkGoFiles(t, root, func(path, src string) {
		if filepath.Base(path) == "status.go" {
			return // the one legal home for the literals
		}
		for _, s := range statuses {
			if strings.Contains(src, `"`+s+`"`) {
				t.Errorf("%s: raw status literal %q — use the state.Status constants", relPath(root, path), s)
			}
		}
	})
}

// TestNoDirectDBAccessOutsideStores: only the designated store packages may hit
// Supabase REST directly. Everything else goes through them, so tenant scoping is
// always RLS (no hand-rolled WHERE-by-tenant can sneak in elsewhere).
func TestNoDirectDBAccessOutsideStores(t *testing.T) {
	root := controlRoot(t)
	allowed := map[string]bool{
		filepath.Join(root, "internal", "state"): true,
		filepath.Join(root, "internal", "brain"): true,
	}
	walkGoFiles(t, root, func(path, src string) {
		if allowed[filepath.Dir(path)] {
			return
		}
		if strings.Contains(src, "/rest/v1") {
			t.Errorf("%s: direct Supabase REST access — go through internal/state or internal/brain", relPath(root, path))
		}
	})
}

func relPath(root, path string) string {
	r, err := filepath.Rel(root, path)
	if err != nil {
		return path
	}
	return r
}
