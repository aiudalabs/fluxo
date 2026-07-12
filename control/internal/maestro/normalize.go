package maestro

// RawEvent is the handful of fields the reconciler extracts from a GitHub webhook
// (see webhook_deliveries, F3-01). Keeping normalization separate and pure means
// provider-specific shapes never reach Decide — adding another provider is a new
// Normalize case, not a change to the decision kernel.
type RawEvent struct {
	Type       string // X-GitHub-Event: pull_request, workflow_run, check_run, …
	Action     string // payload.action: opened, reopened, closed, completed, …
	Conclusion string // workflow_run/check_run conclusion: success, failure, cancelled, …
	Merged     bool   // pull_request.merged
}

// terminalFailure is the set of run conclusions that count as an explicit terminal
// failure — the only thing allowed to demote a story (hysteresis).
var terminalFailure = map[string]bool{
	"failure":         true,
	"cancelled":       true,
	"timed_out":       true,
	"startup_failure": true,
}

// Normalize collapses a raw GitHub event into the reconciler's vocabulary. Unknown
// or non-actionable events become EventOther — a deliberate no-op, never a guess.
func Normalize(r RawEvent) Event {
	switch r.Type {
	case "pull_request":
		switch {
		case r.Action == "opened" || r.Action == "reopened":
			return EventPROpened
		case r.Action == "closed" && r.Merged:
			return EventPRMerged
		}
	case "workflow_run", "check_run":
		if r.Action == "completed" {
			if r.Conclusion == "success" {
				return EventRunSuccess
			}
			if terminalFailure[r.Conclusion] {
				return EventRunFailure
			}
		}
	}
	return EventOther
}
