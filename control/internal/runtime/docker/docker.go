// Package docker implements the docker_isolated Runtime (F4-05): each WorkUnit
// runs in an EPHEMERAL container with egress DENIED (--network none), for offline
// E2E. It satisfies runtime.Runtime, so it is dispatched exactly like any other
// channel (docs/02). Isolation is real, not advisory: the container has no network.
package docker

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"

	rt "github.com/aiudalabs/fluxo/control/internal/runtime"
)

// Runtime runs work in throwaway, network-less containers.
type Runtime struct {
	image string // the E2E image the CLI lives in
	bin   string // docker binary (overridable in tests)
}

// New returns a docker_isolated runtime bound to an image.
func New(image string) *Runtime { return &Runtime{image: image, bin: "docker"} }

func (r *Runtime) ID() string { return "docker_isolated" }

// Isolation is a network-denied ephemeral container — the strongest isolation,
// used for offline E2E.
func (r *Runtime) Isolation() rt.Isolation { return rt.IsolationContainerDeny }

// Probe reports whether Docker is reachable. Fail-open: the reason is visible.
func (r *Runtime) Probe(ctx context.Context, _ rt.Provider, _ string) (bool, string) {
	if err := exec.CommandContext(ctx, r.bin, "info").Run(); err != nil {
		return false, "docker not available: " + err.Error()
	}
	return true, "docker available"
}

// Dispatch starts a detached container with NO network (egress denied) and returns
// its id as the session handle. The command comes from the provider's
// docker_isolated invoke argv (data) — nothing provider-specific is hard-coded.
func (r *Runtime) Dispatch(ctx context.Context, _ rt.WorkUnit, provider rt.Provider) (rt.SessionRef, error) {
	argv, err := argvFrom(provider)
	if err != nil {
		return rt.SessionRef{}, err
	}
	args := append([]string{"run", "-d", "--network", "none", r.image}, argv...)
	out, err := r.output(ctx, args...)
	if err != nil {
		return rt.SessionRef{}, fmt.Errorf("docker: run: %w", err)
	}
	id := strings.TrimSpace(out)
	if id == "" {
		return rt.SessionRef{}, fmt.Errorf("docker: empty container id")
	}
	return rt.SessionRef{Runtime: r.ID(), ID: id}, nil
}

// Liveness derives state from `docker inspect` — the robust source. A removed
// (reaped) or unknown container is Lost, never a false "running".
func (r *Runtime) Liveness(ctx context.Context, ref rt.SessionRef) (rt.State, error) {
	out, err := r.output(ctx, "inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", ref.ID)
	if err != nil {
		return rt.StateLost, nil // not found → the container is gone
	}
	fields := strings.Fields(strings.TrimSpace(out))
	if len(fields) < 2 {
		return rt.StateLost, nil
	}
	switch fields[0] {
	case "running", "created", "restarting":
		return rt.StateRunning, nil
	case "exited", "dead":
		if fields[1] == "0" {
			return rt.StateDone, nil
		}
		return rt.StateFailed, nil
	default:
		return rt.StateLost, nil
	}
}

// Reap removes the container — the "ephemeral" half. Called on a terminal state.
func (r *Runtime) Reap(ctx context.Context, ref rt.SessionRef) error {
	return exec.CommandContext(ctx, r.bin, "rm", "-f", ref.ID).Run()
}

func (r *Runtime) output(ctx context.Context, args ...string) (string, error) {
	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, r.bin, args...)
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("%w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

// argvFrom pulls the container command from the provider's docker_isolated invoke
// data, accepting both []string (tests) and []any (YAML).
func argvFrom(provider rt.Provider) ([]string, error) {
	raw, ok := provider.Invoke["argv"]
	if !ok {
		return nil, fmt.Errorf("docker: provider %q has no docker_isolated argv", provider.ID)
	}
	switch v := raw.(type) {
	case []string:
		return v, nil
	case []any:
		argv := make([]string, 0, len(v))
		for _, e := range v {
			s, ok := e.(string)
			if !ok {
				return nil, fmt.Errorf("docker: argv element is not a string: %v", e)
			}
			argv = append(argv, s)
		}
		return argv, nil
	default:
		return nil, fmt.Errorf("docker: argv is not a list")
	}
}
