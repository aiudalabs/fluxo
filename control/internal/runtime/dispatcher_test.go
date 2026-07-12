package runtime

import (
	"context"
	"errors"
	"testing"
)

func specs() map[string]ProviderSpec {
	return map[string]ProviderSpec{
		"claude":  {ID: "claude", Runtimes: []string{"github_actions", "local_daemon"}, Invoke: map[string]map[string]any{"github_actions": {"workflow": "claude.yml"}}},
		"copilot": {ID: "copilot", Runtimes: []string{"github_actions"}},
	}
}

func TestDispatchFallsThroughToNextChoice(t *testing.T) {
	reg := NewRegistry()
	// First choice has no capacity; second dispatches.
	_ = reg.Register(&fakeRuntime{id: "github_actions", probeOK: false, probeWhy: "no client secret"})
	_ = reg.Register(&fakeRuntime{id: "local_daemon", probeOK: true})
	policy := Policy{Lanes: map[string][]Choice{
		"mobile": {{Runtime: "github_actions", Provider: "claude"}, {Runtime: "local_daemon", Provider: "claude"}},
	}}

	d := NewDispatcher(reg, specs(), policy)
	res, err := d.Dispatch(context.Background(), WorkUnit{Repo: "rosa/peluqueria", Lane: "mobile"})
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if res.Ref.Runtime != "local_daemon" {
		t.Errorf("winner = %q, want local_daemon (fell through)", res.Ref.Runtime)
	}
	if len(res.Attempts) != 2 || res.Attempts[0].OK || !res.Attempts[1].OK {
		t.Fatalf("attempts trail wrong: %+v", res.Attempts)
	}
	if res.Attempts[0].Reason == "" {
		t.Error("first attempt must carry a visible reason for the UI")
	}
}

func TestDispatchFirstSuccessWins(t *testing.T) {
	reg := NewRegistry()
	_ = reg.Register(&fakeRuntime{id: "github_actions", probeOK: true})
	_ = reg.Register(&fakeRuntime{id: "local_daemon", probeOK: true})
	policy := Policy{Lanes: map[string][]Choice{"*": {{Runtime: "github_actions", Provider: "claude"}, {Runtime: "local_daemon", Provider: "claude"}}}}

	res, err := NewDispatcher(reg, specs(), policy).Dispatch(context.Background(), WorkUnit{Lane: "backend"})
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if res.Ref.Runtime != "github_actions" || len(res.Attempts) != 1 {
		t.Errorf("first success should win with 1 attempt: %+v", res)
	}
}

func TestDispatchAllFail(t *testing.T) {
	reg := NewRegistry()
	_ = reg.Register(&fakeRuntime{id: "github_actions", probeOK: true, dispatchErr: errors.New("boom")})
	policy := Policy{Lanes: map[string][]Choice{"*": {{Runtime: "github_actions", Provider: "claude"}}}}

	res, err := NewDispatcher(reg, specs(), policy).Dispatch(context.Background(), WorkUnit{Lane: "x"})
	if err == nil {
		t.Fatal("expected error when all choices fail")
	}
	if len(res.Attempts) != 1 || res.Attempts[0].OK {
		t.Errorf("attempts should record the failure: %+v", res.Attempts)
	}
}

func TestDispatchNoPolicyForLane(t *testing.T) {
	d := NewDispatcher(NewRegistry(), specs(), Policy{Lanes: map[string][]Choice{}})
	if _, err := d.Dispatch(context.Background(), WorkUnit{Lane: "x"}); err == nil {
		t.Error("expected error when the policy has no choices")
	}
}

func TestDispatchSkipsUnregisteredRuntimeAndMissingProvider(t *testing.T) {
	reg := NewRegistry()
	_ = reg.Register(&fakeRuntime{id: "local_daemon", probeOK: true})
	policy := Policy{Lanes: map[string][]Choice{"*": {
		{Runtime: "ghost", Provider: "claude"},         // runtime not registered
		{Runtime: "local_daemon", Provider: "missing"}, // provider not loaded
		{Runtime: "local_daemon", Provider: "claude"},  // this one works
	}}}
	res, err := NewDispatcher(reg, specs(), policy).Dispatch(context.Background(), WorkUnit{Lane: "x"})
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if res.Ref.Runtime != "local_daemon" || res.Provider != "claude" || len(res.Attempts) != 3 {
		t.Errorf("expected to skip two bad choices then win: %+v", res)
	}
}

// The claude/github_actions invocation data must reach the provider passed to the
// runtime — proving invoke config is threaded from the YAML, not hard-coded.
func TestDispatchThreadsInvokeConfig(t *testing.T) {
	reg := NewRegistry()
	capture := &capturingRuntime{fakeRuntime: fakeRuntime{id: "github_actions", probeOK: true}}
	_ = reg.Register(capture)
	policy := Policy{Lanes: map[string][]Choice{"*": {{Runtime: "github_actions", Provider: "claude"}}}}

	_, err := NewDispatcher(reg, specs(), policy).Dispatch(context.Background(), WorkUnit{Lane: "x"})
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if capture.gotProvider.Invoke["workflow"] != "claude.yml" {
		t.Errorf("invoke config not threaded: %+v", capture.gotProvider.Invoke)
	}
}

type capturingRuntime struct {
	fakeRuntime
	gotProvider Provider
}

func (c *capturingRuntime) Dispatch(ctx context.Context, work WorkUnit, p Provider) (SessionRef, error) {
	c.gotProvider = p
	return c.fakeRuntime.Dispatch(ctx, work, p)
}
