package runtime

import (
	"context"
	"fmt"
)

// Attempt records one try in the fallback chain — for the UI signal (L-CQ-1: a
// fallback must be visible, not a silent binary swap).
type Attempt struct {
	Runtime  string
	Provider string
	OK       bool
	Reason   string // probe reason or dispatch error
}

// DispatchResult is the outcome of a fallback dispatch: the winning session (if
// any) plus the full trail of attempts for the UI.
type DispatchResult struct {
	Ref      SessionRef
	Provider string
	Attempts []Attempt
}

// Dispatcher runs a WorkUnit through a lane's ordered (runtime, provider) choices
// (F4-06). It tries each in order: probe first (fail-open — a probe error is a
// reason to try the next, not to crash), then dispatch. The first success wins;
// every attempt is recorded so the UI can show WHY it fell through. This replaces
// v1's binary otherExecutor swap with an ordered list.
type Dispatcher struct {
	reg       *Registry
	providers map[string]ProviderSpec
	policy    Policy
}

// NewDispatcher wires the registry, provider specs, and policy.
func NewDispatcher(reg *Registry, providers map[string]ProviderSpec, policy Policy) *Dispatcher {
	return &Dispatcher{reg: reg, providers: providers, policy: policy}
}

// Dispatch tries the lane's choices in order and returns the first success, or an
// error naming every attempt. The Attempts trail is populated either way.
func (d *Dispatcher) Dispatch(ctx context.Context, work WorkUnit) (DispatchResult, error) {
	choices := d.policy.Select(work.Lane)
	if len(choices) == 0 {
		return DispatchResult{}, fmt.Errorf("dispatch: no policy choices for lane %q", work.Lane)
	}

	var res DispatchResult
	for _, c := range choices {
		rt, ok := d.reg.Get(c.Runtime)
		if !ok {
			res.Attempts = append(res.Attempts, Attempt{Runtime: c.Runtime, Provider: c.Provider, OK: false, Reason: "runtime not registered"})
			continue
		}
		spec, ok := d.providers[c.Provider]
		if !ok {
			res.Attempts = append(res.Attempts, Attempt{Runtime: c.Runtime, Provider: c.Provider, OK: false, Reason: "provider not loaded"})
			continue
		}
		provider := Provider{ID: spec.ID, Invoke: invokeFor(spec, c.Runtime)}

		if ok, reason := rt.Probe(ctx, provider, work.Repo); !ok {
			res.Attempts = append(res.Attempts, Attempt{Runtime: c.Runtime, Provider: c.Provider, OK: false, Reason: "no capacity: " + reason})
			continue
		}
		ref, err := rt.Dispatch(ctx, work, provider)
		if err != nil {
			res.Attempts = append(res.Attempts, Attempt{Runtime: c.Runtime, Provider: c.Provider, OK: false, Reason: "dispatch failed: " + err.Error()})
			continue
		}
		res.Attempts = append(res.Attempts, Attempt{Runtime: c.Runtime, Provider: c.Provider, OK: true, Reason: "dispatched"})
		res.Ref = ref
		res.Provider = c.Provider
		return res, nil
	}
	return res, fmt.Errorf("dispatch: all %d choices for lane %q failed", len(choices), work.Lane)
}

// invokeFor returns the provider's invocation config for a runtime (nil if the
// provider doesn't declare one for it) — data, no branching on ids.
func invokeFor(spec ProviderSpec, runtimeID string) map[string]any {
	if spec.Invoke == nil {
		return nil
	}
	return spec.Invoke[runtimeID]
}
