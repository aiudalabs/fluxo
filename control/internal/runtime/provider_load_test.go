package runtime

import (
	"os"
	"path/filepath"
	"testing"
)

// providersDir locates the repo's registry/providers from the package dir.
func providersDir(t *testing.T) string {
	t.Helper()
	dir, _ := os.Getwd()
	for {
		cand := filepath.Join(dir, "registry", "providers")
		if fi, err := os.Stat(cand); err == nil && fi.IsDir() {
			return cand
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Skip("registry/providers not found from test dir")
		}
		dir = parent
	}
}

func TestLoadRealProviders(t *testing.T) {
	specs, err := LoadProviders(providersDir(t))
	if err != nil {
		t.Fatalf("LoadProviders: %v", err)
	}

	claude, ok := specs["claude"]
	if !ok {
		t.Fatal("claude provider not loaded")
	}
	if claude.Liveness != "workflow_run" {
		t.Errorf("claude liveness = %q, want workflow_run (robust source, not 404)", claude.Liveness)
	}
	if claude.CapacityProbe != "repo_secret_exists" {
		t.Errorf("claude capacity_probe = %q", claude.CapacityProbe)
	}
	if claude.PromptPreamble != "claude_ephemeral.md" {
		t.Errorf("claude prompt_preamble = %q", claude.PromptPreamble)
	}
	if claude.Credential["owner"] != "client" {
		t.Errorf("claude credential owner = %v, want client (BYO)", claude.Credential["owner"])
	}
	// invoke is data, per runtime — github_actions carries a workflow file.
	if claude.Invoke["github_actions"]["workflow"] != "claude.yml" {
		t.Errorf("claude github_actions invoke wrong: %v", claude.Invoke["github_actions"])
	}

	copilot, ok := specs["copilot"]
	if !ok {
		t.Fatal("copilot provider not loaded")
	}
	if len(copilot.Runtimes) != 1 || copilot.Runtimes[0] != "github_actions" {
		t.Errorf("copilot runtimes = %v", copilot.Runtimes)
	}
	if copilot.Liveness != "workflow_run" {
		t.Errorf("copilot liveness = %q", copilot.Liveness)
	}
}

func TestLoadProvidersRejectsBad(t *testing.T) {
	dir := t.TempDir()
	// missing id
	os.WriteFile(filepath.Join(dir, "bad.yaml"), []byte("runtimes: [x]\n"), 0o644)
	if _, err := LoadProviders(dir); err == nil {
		t.Error("expected error for provider without id")
	}
}

func TestLoadProvidersEmptyDirIsEmpty(t *testing.T) {
	specs, err := LoadProviders(t.TempDir())
	if err != nil {
		t.Fatalf("LoadProviders(empty): %v", err)
	}
	if len(specs) != 0 {
		t.Errorf("expected no specs, got %d", len(specs))
	}
}
