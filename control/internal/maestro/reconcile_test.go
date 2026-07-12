package maestro

import (
	"testing"
	"time"

	"github.com/aiudalabs/fluxo/control/internal/state"
)

func TestDecideHysteresisAndProgress(t *testing.T) {
	cases := []struct {
		name   string
		ev     Event
		status state.Status
		want   state.Status // "" = no change
	}{
		// Progress paths.
		{"pr opened advances running->review", EventPROpened, state.StatusRunning, state.StatusReview},
		{"run success advances running->review", EventRunSuccess, state.StatusRunning, state.StatusReview},
		{"merge accepts review->done", EventPRMerged, state.StatusReview, state.StatusDone},

		// The ONLY demotion: explicit terminal failure from an active state.
		{"failure demotes running->failed", EventRunFailure, state.StatusRunning, state.StatusFailed},
		{"failure demotes review->failed", EventRunFailure, state.StatusReview, state.StatusFailed},

		// Hysteresis: no demotion / no movement on non-terminal or mismatched events.
		{"pr opened is noop when not running", EventPROpened, state.StatusReady, ""},
		{"run success is noop when done", EventRunSuccess, state.StatusDone, ""},
		{"merge is noop when running", EventPRMerged, state.StatusRunning, ""},
		{"failure is noop when backlog", EventRunFailure, state.StatusBacklog, ""},
		{"failure is noop when already done", EventRunFailure, state.StatusDone, ""},
		{"other event is always noop (running)", EventOther, state.StatusRunning, ""},
		{"other event is always noop (review)", EventOther, state.StatusReview, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Decide(c.ev, c.status)
			if got.NextStatus != c.want {
				t.Errorf("Decide(%s, %s) = %q (%s), want %q", c.ev, c.status, got.NextStatus, got.Reason, c.want)
			}
			if got.Reason == "" {
				t.Error("every decision must carry a reason")
			}
		})
	}
}

// The core anti-flap property, stated directly: nothing but an explicit terminal
// failure can ever demote a story to failed.
func TestOnlyTerminalFailureDemotes(t *testing.T) {
	for _, ev := range []Event{EventPROpened, EventRunSuccess, EventPRMerged, EventOther} {
		for _, st := range []state.Status{state.StatusRunning, state.StatusReview, state.StatusReady, state.StatusBacklog} {
			if got := Decide(ev, st); got.NextStatus == state.StatusFailed {
				t.Errorf("Decide(%s, %s) demoted to failed without a terminal failure event", ev, st)
			}
		}
	}
}

func TestShouldDispatchReadLagGuard(t *testing.T) {
	// The read-lag scenario: the status we read says 'ready' (stale), but a run is
	// already live. We must NOT dispatch a second run.
	if ShouldDispatch(DispatchInput{Status: state.StatusReady, HasLiveRun: true, SinceLastRun: time.Hour, Cooldown: time.Minute}) {
		t.Error("dispatched a 2nd run despite a live run (read-lag flap, L-ARCH-2)")
	}
}

func TestShouldDispatchCooldown(t *testing.T) {
	if ShouldDispatch(DispatchInput{Status: state.StatusReady, HasLiveRun: false, SinceLastRun: 10 * time.Second, Cooldown: time.Minute}) {
		t.Error("dispatched within the cooldown window (no dwell)")
	}
}

func TestShouldDispatchHappyPath(t *testing.T) {
	if !ShouldDispatch(DispatchInput{Status: state.StatusReady, HasLiveRun: false, SinceLastRun: 2 * time.Minute, Cooldown: time.Minute}) {
		t.Error("a ready story with no live run past cooldown should dispatch")
	}
}

func TestShouldDispatchOnlyReady(t *testing.T) {
	for _, st := range []state.Status{state.StatusBacklog, state.StatusRunning, state.StatusReview, state.StatusDone, state.StatusFailed, state.StatusBlocked} {
		if ShouldDispatch(DispatchInput{Status: st, HasLiveRun: false, SinceLastRun: time.Hour, Cooldown: time.Minute}) {
			t.Errorf("dispatched a story in %q; only 'ready' should dispatch", st)
		}
	}
}
