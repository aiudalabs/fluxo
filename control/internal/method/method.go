// Package method loads backlog-method schemas from registry/methods/*.yaml
// (F5-02). The backlog hierarchy (epic/sprint/story) and the ordered gate names
// are DATA, so switching methods — e.g. a sprint-less kanban — is a YAML file and
// never a Go change (golden rule 1, closes L-CQ-1). This loader is generic: it
// never branches on a method id.
package method

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"gopkg.in/yaml.v3"
)

// Schema is one backlog method as data.
type Schema struct {
	ID     string   `yaml:"id"`
	Levels []string `yaml:"levels"` // hierarchy, coarse→fine (e.g. epic, sprint, story)
	Gates  []string `yaml:"gates"`  // ordered design gate names
}

// HasLevel reports whether the method has a hierarchy level (e.g. "sprint").
func (s Schema) HasLevel(level string) bool {
	for _, l := range s.Levels {
		if l == level {
			return true
		}
	}
	return false
}

// Leaf is the finest hierarchy level — the unit of execution (usually "story").
func (s Schema) Leaf() string {
	if len(s.Levels) == 0 {
		return ""
	}
	return s.Levels[len(s.Levels)-1]
}

// Load reads every *.yaml under dir into a schema keyed by id. Generic — the same
// code loads scrum, kanban, or any future method.
func Load(dir string) (map[string]Schema, error) {
	paths, err := filepath.Glob(filepath.Join(dir, "*.yaml"))
	if err != nil {
		return nil, fmt.Errorf("method: glob: %w", err)
	}
	sort.Strings(paths)

	out := make(map[string]Schema, len(paths))
	for _, p := range paths {
		b, err := os.ReadFile(p)
		if err != nil {
			return nil, fmt.Errorf("method: read %s: %w", p, err)
		}
		var s Schema
		if err := yaml.Unmarshal(b, &s); err != nil {
			return nil, fmt.Errorf("method: parse %s: %w", p, err)
		}
		if s.ID == "" {
			return nil, fmt.Errorf("method: %s has no id", p)
		}
		if len(s.Levels) == 0 {
			return nil, fmt.Errorf("method %q declares no levels", s.ID)
		}
		if len(s.Gates) == 0 {
			return nil, fmt.Errorf("method %q declares no gates", s.ID)
		}
		out[s.ID] = s
	}
	return out, nil
}
