package runtime

import "fmt"

// Registry holds runtimes under OPEN ids — any string, not a fixed enum of two.
// Adding a runtime is a Register call, never a switch edit (L-CQ-1).
type Registry struct {
	runtimes map[string]Runtime
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{runtimes: map[string]Runtime{}}
}

// Register adds a runtime under its own id. A duplicate id is an error — ids must
// be unambiguous for the Policy to resolve them.
func (r *Registry) Register(rt Runtime) error {
	id := rt.ID()
	if id == "" {
		return fmt.Errorf("runtime: empty id")
	}
	if _, exists := r.runtimes[id]; exists {
		return fmt.Errorf("runtime: duplicate id %q", id)
	}
	r.runtimes[id] = rt
	return nil
}

// Get resolves a runtime id.
func (r *Registry) Get(id string) (Runtime, bool) {
	rt, ok := r.runtimes[id]
	return rt, ok
}

// Choice is one (runtime, provider) pair the Policy may pick.
type Choice struct {
	Runtime  string
	Provider string
}

// Policy chooses (runtime, provider) per lane, as an ORDERED fallback list — the
// dispatcher (F4-06) tries them in order until one has capacity and dispatches.
// This replaces v1's binary otherExecutor swap. A lane with no explicit list uses
// the default ("*") list.
type Policy struct {
	// Lanes maps a lane to its ordered choices. The "*" key is the default.
	Lanes map[string][]Choice
}

// Select returns the ordered choices for a lane, falling back to the default list.
// An empty result means the Policy has nothing for this lane (caller decides).
func (p Policy) Select(lane string) []Choice {
	if choices, ok := p.Lanes[lane]; ok && len(choices) > 0 {
		return choices
	}
	return p.Lanes["*"]
}
