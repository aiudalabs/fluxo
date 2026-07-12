package state

// Status is a story's lifecycle state. These constants are the SINGLE source of
// status strings in Go — the arch lint (status_lint_test.go) rejects any raw
// status literal elsewhere, so the class of bug where 16 scattered status='…'
// writes bypassed the state machine (L-CQ-2) cannot recur here. The values
// mirror the DB CHECK and the transition graph (F2-01/F2-02).
type Status string

const (
	StatusBacklog Status = "backlog"
	StatusReady   Status = "ready"
	StatusRunning Status = "running"
	StatusReview  Status = "review"
	StatusDone    Status = "done"
	StatusFailed  Status = "failed"
	StatusBlocked Status = "blocked"
)
