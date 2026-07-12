package docker

import (
	"context"
	"testing"
	"time"

	rt "github.com/aiudalabs/fluxo/control/internal/runtime"
)

const testImage = "alpine:3"

func provider(argv ...string) rt.Provider {
	return rt.Provider{ID: "claude", Invoke: map[string]any{"argv": argv}}
}

// requireDocker skips the test if Docker (or the test image) isn't available, so
// the suite stays green on machines without Docker while really exercising it
// where present.
func requireDocker(t *testing.T) *Runtime {
	t.Helper()
	r := New(testImage)
	if ok, why := r.Probe(context.Background(), rt.Provider{}, ""); !ok {
		t.Skip("docker unavailable: " + why)
	}
	return r
}

func pollTerminal(t *testing.T, r *Runtime, ref rt.SessionRef) rt.State {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		st, err := r.Liveness(context.Background(), ref)
		if err != nil {
			t.Fatalf("Liveness: %v", err)
		}
		if st != rt.StateRunning {
			return st
		}
		time.Sleep(300 * time.Millisecond)
	}
	t.Fatal("container did not reach a terminal state in time")
	return ""
}

func TestDispatchSuccessThenReapIsLost(t *testing.T) {
	r := requireDocker(t)
	ref, err := r.Dispatch(context.Background(), rt.WorkUnit{}, provider("sh", "-c", "exit 0"))
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if ref.Runtime != "docker_isolated" || ref.ID == "" {
		t.Fatalf("bad ref: %+v", ref)
	}
	if st := pollTerminal(t, r, ref); st != rt.StateDone {
		t.Errorf("state = %q, want done", st)
	}
	// Ephemeral: after reap the container is gone → Lost, never a stale running.
	if err := r.Reap(context.Background(), ref); err != nil {
		t.Fatalf("Reap: %v", err)
	}
	if st, _ := r.Liveness(context.Background(), ref); st != rt.StateLost {
		t.Errorf("state after reap = %q, want lost", st)
	}
}

func TestEgressIsDenied(t *testing.T) {
	r := requireDocker(t)
	// With --network none, any outbound call fails → the container exits nonzero.
	ref, err := r.Dispatch(context.Background(), rt.WorkUnit{},
		provider("sh", "-c", "wget -T 3 -q -O /dev/null http://example.com"))
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	defer r.Reap(context.Background(), ref)
	if st := pollTerminal(t, r, ref); st != rt.StateFailed {
		t.Errorf("egress-denied container state = %q, want failed (network must be unreachable)", st)
	}
}

func TestFailingCommandIsFailed(t *testing.T) {
	r := requireDocker(t)
	ref, err := r.Dispatch(context.Background(), rt.WorkUnit{}, provider("sh", "-c", "exit 7"))
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	defer r.Reap(context.Background(), ref)
	if st := pollTerminal(t, r, ref); st != rt.StateFailed {
		t.Errorf("state = %q, want failed", st)
	}
}

func TestDispatchRequiresArgv(t *testing.T) {
	r := New(testImage)
	if _, err := r.Dispatch(context.Background(), rt.WorkUnit{}, rt.Provider{ID: "claude"}); err == nil {
		t.Error("expected error when provider has no docker argv")
	}
}

func TestIsolationIsContainerDeny(t *testing.T) {
	if New(testImage).Isolation() != rt.IsolationContainerDeny {
		t.Error("docker_isolated must report container-egress-deny isolation")
	}
}
