package runtime

import (
	"context"
	"testing"
)

// fakeRuntime is a test double proving the interface is implementable under an
// arbitrary (open) id, with no special-casing in the package.
type fakeRuntime struct {
	id          string
	probeOK     bool
	probeWhy    string
	dispatchErr error
	state       State
}

func (f *fakeRuntime) ID() string { return f.id }
func (f *fakeRuntime) Dispatch(_ context.Context, work WorkUnit, p Provider) (SessionRef, error) {
	if f.dispatchErr != nil {
		return SessionRef{}, f.dispatchErr
	}
	return SessionRef{Runtime: f.id, ID: work.Repo + ":" + p.ID}, nil
}
func (f *fakeRuntime) Probe(_ context.Context, _ Provider, _ string) (bool, string) {
	return f.probeOK, f.probeWhy
}
func (f *fakeRuntime) Liveness(_ context.Context, _ SessionRef) (State, error) { return f.state, nil }
func (f *fakeRuntime) Isolation() Isolation                                    { return IsolationActionsRunner }

func TestRegistryOpenIds(t *testing.T) {
	reg := NewRegistry()
	// Any id works — no fixed enum of two executors.
	for _, id := range []string{"github_actions", "local_daemon", "some_future_engine"} {
		if err := reg.Register(&fakeRuntime{id: id}); err != nil {
			t.Fatalf("Register(%q): %v", id, err)
		}
	}
	if _, ok := reg.Get("some_future_engine"); !ok {
		t.Error("open id not resolvable")
	}
	if _, ok := reg.Get("nope"); ok {
		t.Error("unknown id should not resolve")
	}
}

func TestRegistryRejectsDuplicateAndEmpty(t *testing.T) {
	reg := NewRegistry()
	if err := reg.Register(&fakeRuntime{id: ""}); err == nil {
		t.Error("empty id should error")
	}
	_ = reg.Register(&fakeRuntime{id: "x"})
	if err := reg.Register(&fakeRuntime{id: "x"}); err == nil {
		t.Error("duplicate id should error")
	}
}

func TestPolicySelectLaneThenDefault(t *testing.T) {
	p := Policy{Lanes: map[string][]Choice{
		"*":      {{Runtime: "github_actions", Provider: "copilot"}},
		"mobile": {{Runtime: "github_actions", Provider: "claude"}, {Runtime: "local_daemon", Provider: "claude"}},
	}}

	// Lane-specific list, in order (the fallback ordering).
	mobile := p.Select("mobile")
	if len(mobile) != 2 || mobile[0].Provider != "claude" || mobile[1].Runtime != "local_daemon" {
		t.Fatalf("mobile choices wrong: %+v", mobile)
	}
	// A lane with no explicit list falls back to the default.
	backend := p.Select("backend")
	if len(backend) != 1 || backend[0].Provider != "copilot" {
		t.Fatalf("default fallback wrong: %+v", backend)
	}
}

func TestPolicySelectEmptyWhenNothing(t *testing.T) {
	if got := (Policy{Lanes: map[string][]Choice{}}).Select("x"); len(got) != 0 {
		t.Errorf("expected no choices, got %+v", got)
	}
}

func TestRuntimeInterfaceRoundTrip(t *testing.T) {
	var rt Runtime = &fakeRuntime{id: "github_actions", probeOK: true, probeWhy: "secret present", state: StateRunning}
	ok, why := rt.Probe(context.Background(), Provider{ID: "claude"}, "rosa/peluqueria")
	if !ok || why == "" {
		t.Errorf("probe = %v %q", ok, why)
	}
	ref, err := rt.Dispatch(context.Background(), WorkUnit{Repo: "rosa/peluqueria", Lane: "mobile"}, Provider{ID: "claude"})
	if err != nil || ref.Runtime != "github_actions" {
		t.Fatalf("dispatch = %+v, %v", ref, err)
	}
	st, _ := rt.Liveness(context.Background(), ref)
	if st != StateRunning {
		t.Errorf("liveness = %q", st)
	}
	if rt.Isolation() != IsolationActionsRunner {
		t.Errorf("isolation = %q", rt.Isolation())
	}
}
