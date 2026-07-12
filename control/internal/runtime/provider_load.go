package runtime

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"gopkg.in/yaml.v3"
)

// ProviderSpec is a provider loaded from registry/providers/*.yaml (docs/02). It
// is pure DATA — invocation, credential, probe, liveness and preamble all come
// from the file. The dispatcher reads these; there is NO per-channel switch in Go
// (golden rule 1, closes L-CQ-1). Adding a provider is a YAML file, zero code.
type ProviderSpec struct {
	ID             string                    `yaml:"id"`
	Runtimes       []string                  `yaml:"runtimes"`
	Invoke         map[string]map[string]any `yaml:"invoke"`
	Credential     map[string]any            `yaml:"credential"`
	CapacityProbe  string                    `yaml:"capacity_probe"`
	Liveness       string                    `yaml:"liveness"`
	RunningSignal  string                    `yaml:"running_signal"`
	PromptPreamble string                    `yaml:"prompt_preamble"`
}

// LoadProviders reads every *.yaml under dir into a spec keyed by id. It is fully
// generic: it never branches on a provider id, so claude/copilot/codex/… are all
// the same code path.
func LoadProviders(dir string) (map[string]ProviderSpec, error) {
	paths, err := filepath.Glob(filepath.Join(dir, "*.yaml"))
	if err != nil {
		return nil, fmt.Errorf("runtime: glob providers: %w", err)
	}
	sort.Strings(paths)

	out := make(map[string]ProviderSpec, len(paths))
	for _, p := range paths {
		b, err := os.ReadFile(p)
		if err != nil {
			return nil, fmt.Errorf("runtime: read %s: %w", p, err)
		}
		var spec ProviderSpec
		if err := yaml.Unmarshal(b, &spec); err != nil {
			return nil, fmt.Errorf("runtime: parse %s: %w", p, err)
		}
		if spec.ID == "" {
			return nil, fmt.Errorf("runtime: %s has no id", p)
		}
		if _, dup := out[spec.ID]; dup {
			return nil, fmt.Errorf("runtime: duplicate provider id %q", spec.ID)
		}
		if len(spec.Runtimes) == 0 {
			return nil, fmt.Errorf("runtime: provider %q lists no runtimes", spec.ID)
		}
		out[spec.ID] = spec
	}
	return out, nil
}
