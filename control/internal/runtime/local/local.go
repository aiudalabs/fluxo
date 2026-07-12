// Package local implements the local_daemon Runtime (F4-04): it runs the
// provider's CLI as a local process in a per-session sandbox dir. It reuses v1's
// worker+sandbox idea under the same runtime.Runtime interface, so a local run is
// dispatched exactly like a GitHub or docker one (docs/02). A companion Daemon
// (daemon.go) claims work units and feeds them here.
package local

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"

	rt "github.com/aiudalabs/fluxo/control/internal/runtime"
)

// Runtime runs work locally, tracking live sessions in-process so Liveness can
// report their real state (not a defaulted guess).
type Runtime struct {
	base    string // sandbox root
	mu      sync.Mutex
	seq     atomic.Uint64
	session map[string]*session
}

type session struct {
	cmd  *exec.Cmd
	done atomic.Bool
	err  error
}

// New returns a local runtime whose sandboxes live under base.
func New(base string) *Runtime {
	return &Runtime{base: base, session: map[string]*session{}}
}

func (r *Runtime) ID() string              { return "local_daemon" }
func (r *Runtime) Isolation() rt.Isolation { return rt.IsolationLocalDir }

// Probe reports whether the provider's CLI is on PATH. Fail-open with a reason.
func (r *Runtime) Probe(_ context.Context, provider rt.Provider, _ string) (bool, string) {
	argv, err := argvFrom(provider)
	if err != nil {
		return false, err.Error()
	}
	if _, err := exec.LookPath(argv[0]); err != nil {
		return false, fmt.Sprintf("cli %q not on PATH", argv[0])
	}
	return true, "cli present"
}

// Dispatch starts the CLI in a fresh sandbox dir and returns a session handle. The
// process runs detached; a goroutine records its terminal result for Liveness.
func (r *Runtime) Dispatch(ctx context.Context, work rt.WorkUnit, provider rt.Provider) (rt.SessionRef, error) {
	argv, err := argvFrom(provider)
	if err != nil {
		return rt.SessionRef{}, err
	}
	id := "local-" + strconv.FormatUint(r.seq.Add(1), 10)
	dir := filepath.Join(r.base, id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return rt.SessionRef{}, fmt.Errorf("local: sandbox: %w", err)
	}

	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = dir
	s := &session{cmd: cmd}
	if err := cmd.Start(); err != nil {
		return rt.SessionRef{}, fmt.Errorf("local: start: %w", err)
	}
	r.mu.Lock()
	r.session[id] = s
	r.mu.Unlock()

	go func() {
		err := cmd.Wait()
		s.err = err
		s.done.Store(true)
	}()

	return rt.SessionRef{Runtime: r.ID(), ID: id}, nil
}

// Liveness reports the real state of a tracked session; an unknown id is Lost.
func (r *Runtime) Liveness(_ context.Context, ref rt.SessionRef) (rt.State, error) {
	r.mu.Lock()
	s, ok := r.session[ref.ID]
	r.mu.Unlock()
	if !ok {
		return rt.StateLost, nil
	}
	if !s.done.Load() {
		return rt.StateRunning, nil
	}
	if s.err != nil {
		return rt.StateFailed, nil
	}
	return rt.StateDone, nil
}

func argvFrom(provider rt.Provider) ([]string, error) {
	raw, ok := provider.Invoke["argv"]
	if !ok {
		return nil, fmt.Errorf("local: provider %q has no local_daemon argv", provider.ID)
	}
	switch v := raw.(type) {
	case []string:
		if len(v) == 0 {
			return nil, fmt.Errorf("local: empty argv")
		}
		return v, nil
	case []any:
		argv := make([]string, 0, len(v))
		for _, e := range v {
			s, ok := e.(string)
			if !ok {
				return nil, fmt.Errorf("local: argv element not a string: %v", e)
			}
			argv = append(argv, s)
		}
		if len(argv) == 0 {
			return nil, fmt.Errorf("local: empty argv")
		}
		return argv, nil
	default:
		return nil, fmt.Errorf("local: argv is not a list")
	}
}
