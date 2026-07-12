// Package runtime is the execution layer's contract: Runtime × Provider × ExecEnv,
// with everything selectable by data (docs/02-capa-runtime.md). v1 wired execution
// to two hard-coded executors with switch/otherExecutor/capacityBlock in Go
// (L-CQ-1); v2 makes the ids OPEN — any registered runtime/provider — and the
// choice per lane a Policy with an ORDERED fallback list, not a binary swap.
//
// This file is the interface + selection only. Concrete runtimes (github_actions,
// local_daemon, docker_isolated) and the provider data live in later tasks
// (F4-02..06); nothing here knows their ids.
package runtime

import "context"

// State is the liveness of a dispatched session, derived from the runtime's ROBUST
// source (e.g. workflow_run), never a fragile 404 (L-AUTO-4).
type State string

const (
	StateRunning State = "running"
	StateDone    State = "done"
	StateFailed  State = "failed"
	StateLost    State = "lost"
)

// Isolation describes how a runtime isolates work (an Actions runner, a local dir,
// an egress-denied container). It is descriptive, not behavioural.
type Isolation string

const (
	IsolationActionsRunner Isolation = "actions_runner"
	IsolationLocalDir      Isolation = "local_dir"
	IsolationContainerDeny Isolation = "container_egress_deny"
	IsolationCloudSandbox  Isolation = "cloud_sandbox"
)

// Provider is the CLI/agent to run (claude, copilot, codex, …), as data. F4-02
// loads these from registry/providers/*.yaml; the interface only needs its id and
// opaque invocation config, so adding a provider is data, never Go.
type Provider struct {
	ID     string
	Invoke map[string]any // runtime-specific invocation (workflow inputs, argv, …)
}

// WorkUnit is what Fluxo hands the runtime to execute. The runtime is agnostic to
// granularity — it runs a prompt against a repo; it never knows if this is a story
// or a whole sprint (that orchestration lives above, in Fluxo).
type WorkUnit struct {
	Prompt  string
	Repo    string
	Issues  []int
	Lane    string
	Context map[string]string
}

// SessionRef is an opaque handle to a dispatched session, scoped to its runtime.
type SessionRef struct {
	Runtime string
	ID      string
}

// Runtime is WHERE work runs. Implementations are registered under open ids.
type Runtime interface {
	ID() string
	// Dispatch fires the work and returns a session handle.
	Dispatch(ctx context.Context, work WorkUnit, provider Provider) (SessionRef, error)
	// Probe reports capacity with a visible reason. It is fail-open: an unknown
	// answer should not block dispatch (the reason surfaces in the UI).
	Probe(ctx context.Context, provider Provider, repo string) (ok bool, reason string)
	// Liveness derives session state from the runtime's robust source.
	Liveness(ctx context.Context, ref SessionRef) (State, error)
	Isolation() Isolation
}
