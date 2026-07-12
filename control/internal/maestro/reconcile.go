// Package maestro is the deterministic reconciler — the heart of v2 and the fix
// for v1's recurring "flap" (L-ARCH-2). It is pure decision logic: given a
// normalized event and the current state, it emits the next action. No LLM, no
// I/O — so it can be, and is, exhaustively tested (golden rule 6). The judgement
// stays here, isolated and total; the applier that reads webhook_deliveries and
// writes transitions is wired once the repo→project→story mapping exists (F5-03)
// and the trigger lands (F3-04, Realtime). The decision kernel is what kills the
// flap, so it is built and tested first.
//
// The two invariants that kill the flap:
//  1. HYSTERESIS — a story is demoted (to failed) ONLY on an explicit terminal
//     failure event, NEVER on the absence of a signal. v1 derived `running` from
//     a single eventual read that defaulted to backlog and demoted on "no PR
//     seen this tick"; that is impossible here because Decide only ever demotes
//     on EventRunFailure.
//  2. NO DOUBLE-DISPATCH — a (re)dispatch is suppressed whenever a live run
//     exists, even if the story status we read is stale (a 1-tick read-lag).
//     Plus a cooldown so a just-started story is never immediately re-dispatched.
package maestro

import (
	"time"

	"github.com/aiudalabs/fluxo/control/internal/state"
)

// Event is a webhook normalized to what the reconciler actually cares about.
// Normalization (from raw GitHub payloads) happens at the edge; Decide never sees
// provider-specific shapes.
type Event string

const (
	EventPROpened   Event = "pr_opened"   // agent produced work, awaiting review (non-terminal)
	EventRunSuccess Event = "run_success" // workflow_run concluded success (non-terminal for the story)
	EventPRMerged   Event = "pr_merged"   // review accepted → done
	EventRunFailure Event = "run_failure" // workflow_run concluded failure/cancelled/timed_out — the ONLY demotion
	EventOther      Event = "other"       // anything else — deliberately a no-op
)

// Decision is the reconciler's verdict. NextStatus == "" means "do nothing" —
// the safe default that hysteresis relies on.
type Decision struct {
	NextStatus state.Status
	Reason     string
}

func noop(reason string) Decision { return Decision{NextStatus: "", Reason: reason} }

// Decide maps (event, current story status) to the next status. It is total and
// side-effect free. The only demotion is EventRunFailure from an active state;
// every non-terminal or irrelevant event is a no-op — that is the hysteresis.
func Decide(ev Event, status state.Status) Decision {
	switch ev {
	case EventPROpened, EventRunSuccess:
		// Progress, never a demotion. A running story advances to review; if it is
		// already past running, there is nothing to do (don't move backwards).
		if status == state.StatusRunning {
			return Decision{NextStatus: state.StatusReview, Reason: "work delivered (" + string(ev) + ")"}
		}
		return noop("non-terminal event; story not in running")
	case EventPRMerged:
		if status == state.StatusReview {
			return Decision{NextStatus: state.StatusDone, Reason: "PR merged"}
		}
		return noop("merge event; story not in review")
	case EventRunFailure:
		// The one and only demotion — and only from an active state. This is the
		// explicit terminal event hysteresis requires.
		if status == state.StatusRunning || status == state.StatusReview {
			return Decision{NextStatus: state.StatusFailed, Reason: "terminal run failure"}
		}
		return noop("failure event; story not active")
	default:
		return noop("irrelevant event (hysteresis)")
	}
}

// DispatchInput is the state a re-dispatch decision considers.
type DispatchInput struct {
	Status       state.Status  // the story status we read (MAY be stale)
	HasLiveRun   bool          // a run currently in 'running'
	SinceLastRun time.Duration // elapsed since the most recent run started
	Cooldown     time.Duration // minimum dwell before re-dispatch
}

// ShouldDispatch is the anti-flap guard for (re)dispatch. It returns false the
// moment a live run exists — even if Status reads 'ready' due to a 1-tick
// read-lag — so a lagging read can never spawn a second paid run (L-ARCH-2). It
// also holds off within the cooldown window (dwell).
func ShouldDispatch(in DispatchInput) bool {
	if in.HasLiveRun {
		return false // read-lag / live-session guard: never double-dispatch
	}
	if in.SinceLastRun < in.Cooldown {
		return false // dwell/cooldown
	}
	return in.Status == state.StatusReady
}
