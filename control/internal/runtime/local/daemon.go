package local

import (
	"context"

	rt "github.com/aiudalabs/fluxo/control/internal/runtime"
)

// Claimer hands out the next work unit to run, or ok=false when there is nothing
// to claim right now. The real implementation reads the runs queue (scoped by
// RLS); the Daemon stays agnostic to where units come from.
type Claimer interface {
	Claim(ctx context.Context) (rt.WorkUnit, rt.Provider, bool)
}

// Dispatcher is the subset of a runtime the Daemon needs to run a claimed unit.
type Dispatcher interface {
	Dispatch(ctx context.Context, work rt.WorkUnit, provider rt.Provider) (rt.SessionRef, error)
}

// Daemon is the "worker" loop: claim a unit, dispatch it, repeat, until the
// context is cancelled or claims run dry. It is generic — the local Runtime is one
// possible Dispatcher, and any Claimer (a test source, the runs queue) feeds it.
type Daemon struct {
	claimer    Claimer
	dispatcher Dispatcher
}

// NewDaemon wires a claimer to a dispatcher.
func NewDaemon(c Claimer, d Dispatcher) *Daemon {
	return &Daemon{claimer: c, dispatcher: d}
}

// RunOnce claims and dispatches a single unit if one is available. It returns the
// session ref and true when it dispatched, or ok=false when nothing was claimed.
func (d *Daemon) RunOnce(ctx context.Context) (rt.SessionRef, bool, error) {
	work, provider, ok := d.claimer.Claim(ctx)
	if !ok {
		return rt.SessionRef{}, false, nil
	}
	ref, err := d.dispatcher.Dispatch(ctx, work, provider)
	return ref, true, err
}

// Drain claims and dispatches until the claimer is empty or ctx is done. Returns
// the refs it dispatched. (A long-running daemon would instead block/poll between
// claims; Drain is the deterministic, testable core.)
func (d *Daemon) Drain(ctx context.Context) ([]rt.SessionRef, error) {
	var refs []rt.SessionRef
	for {
		if ctx.Err() != nil {
			return refs, ctx.Err()
		}
		ref, ok, err := d.RunOnce(ctx)
		if err != nil {
			return refs, err
		}
		if !ok {
			return refs, nil
		}
		refs = append(refs, ref)
	}
}
