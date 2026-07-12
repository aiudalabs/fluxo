package local

import (
	"context"
	"testing"
	"time"

	rt "github.com/aiudalabs/fluxo/control/internal/runtime"
)

func provider(argv ...string) rt.Provider {
	return rt.Provider{ID: "claude", Invoke: map[string]any{"argv": argv}}
}

func pollTerminal(t *testing.T, r *Runtime, ref rt.SessionRef) rt.State {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		st, _ := r.Liveness(context.Background(), ref)
		if st != rt.StateRunning {
			return st
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("session did not terminate in time")
	return ""
}

func TestDispatchRunsLocalCliToDone(t *testing.T) {
	r := New(t.TempDir())
	ref, err := r.Dispatch(context.Background(), rt.WorkUnit{}, provider("sh", "-c", "exit 0"))
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if ref.Runtime != "local_daemon" || ref.ID == "" {
		t.Fatalf("bad ref: %+v", ref)
	}
	if st := pollTerminal(t, r, ref); st != rt.StateDone {
		t.Errorf("state = %q, want done", st)
	}
}

func TestDispatchFailingCliIsFailed(t *testing.T) {
	r := New(t.TempDir())
	ref, _ := r.Dispatch(context.Background(), rt.WorkUnit{}, provider("sh", "-c", "exit 3"))
	if st := pollTerminal(t, r, ref); st != rt.StateFailed {
		t.Errorf("state = %q, want failed", st)
	}
}

func TestLivenessUnknownIsLost(t *testing.T) {
	r := New(t.TempDir())
	if st, _ := r.Liveness(context.Background(), rt.SessionRef{ID: "nope"}); st != rt.StateLost {
		t.Errorf("unknown session = %q, want lost", st)
	}
}

func TestProbeChecksCliOnPath(t *testing.T) {
	r := New(t.TempDir())
	if ok, _ := r.Probe(context.Background(), provider("sh"), ""); !ok {
		t.Error("sh should be on PATH")
	}
	if ok, why := r.Probe(context.Background(), provider("definitely-not-a-real-cli-xyz"), ""); ok || why == "" {
		t.Errorf("missing cli should fail with a reason, got ok=%v why=%q", ok, why)
	}
}

func TestDispatchRequiresArgv(t *testing.T) {
	r := New(t.TempDir())
	if _, err := r.Dispatch(context.Background(), rt.WorkUnit{}, rt.Provider{ID: "claude"}); err == nil {
		t.Error("expected error with no argv")
	}
}

func TestIsolationIsLocalDir(t *testing.T) {
	if New(t.TempDir()).Isolation() != rt.IsolationLocalDir {
		t.Error("local_daemon must report local-dir isolation")
	}
}

// fakeClaimer hands out N units then dries up — the daemon's "reclama unidades".
type fakeClaimer struct {
	units []rt.Provider
	i     int
}

func (f *fakeClaimer) Claim(context.Context) (rt.WorkUnit, rt.Provider, bool) {
	if f.i >= len(f.units) {
		return rt.WorkUnit{}, rt.Provider{}, false
	}
	p := f.units[f.i]
	f.i++
	return rt.WorkUnit{Lane: "backend"}, p, true
}

func TestDaemonDrainsClaimsAndDispatches(t *testing.T) {
	r := New(t.TempDir())
	claimer := &fakeClaimer{units: []rt.Provider{provider("sh", "-c", "exit 0"), provider("sh", "-c", "exit 0")}}
	d := NewDaemon(claimer, r)

	refs, err := d.Drain(context.Background())
	if err != nil {
		t.Fatalf("Drain: %v", err)
	}
	if len(refs) != 2 {
		t.Fatalf("expected 2 dispatched units, got %d", len(refs))
	}
	for _, ref := range refs {
		if st := pollTerminal(t, r, ref); st != rt.StateDone {
			t.Errorf("claimed unit %s state = %q, want done", ref.ID, st)
		}
	}
}
