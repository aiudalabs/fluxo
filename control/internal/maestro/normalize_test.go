package maestro

import "testing"

func TestNormalize(t *testing.T) {
	cases := []struct {
		name string
		raw  RawEvent
		want Event
	}{
		{"PR opened", RawEvent{Type: "pull_request", Action: "opened"}, EventPROpened},
		{"PR reopened", RawEvent{Type: "pull_request", Action: "reopened"}, EventPROpened},
		{"PR merged", RawEvent{Type: "pull_request", Action: "closed", Merged: true}, EventPRMerged},
		{"PR closed unmerged is other", RawEvent{Type: "pull_request", Action: "closed", Merged: false}, EventOther},
		{"workflow success", RawEvent{Type: "workflow_run", Action: "completed", Conclusion: "success"}, EventRunSuccess},
		{"workflow failure", RawEvent{Type: "workflow_run", Action: "completed", Conclusion: "failure"}, EventRunFailure},
		{"workflow cancelled is terminal failure", RawEvent{Type: "workflow_run", Action: "completed", Conclusion: "cancelled"}, EventRunFailure},
		{"workflow timed_out is terminal failure", RawEvent{Type: "workflow_run", Action: "completed", Conclusion: "timed_out"}, EventRunFailure},
		{"check_run failure", RawEvent{Type: "check_run", Action: "completed", Conclusion: "failure"}, EventRunFailure},
		{"workflow requested (not completed) is other", RawEvent{Type: "workflow_run", Action: "requested"}, EventOther},
		{"unknown conclusion is other, not a demotion", RawEvent{Type: "workflow_run", Action: "completed", Conclusion: "neutral"}, EventOther},
		{"push is other", RawEvent{Type: "push"}, EventOther},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Normalize(c.raw); got != c.want {
				t.Errorf("Normalize(%+v) = %q, want %q", c.raw, got, c.want)
			}
		})
	}
}

// A non-completed or ambiguous run must never normalize to a demotion event —
// that is what protected v1 from the flap, verified end to end here.
func TestNormalizeNeverInventsFailure(t *testing.T) {
	for _, r := range []RawEvent{
		{Type: "workflow_run", Action: "requested"},
		{Type: "workflow_run", Action: "completed", Conclusion: ""},
		{Type: "workflow_run", Action: "completed", Conclusion: "neutral"},
		{Type: "check_run", Action: "created"},
		{Type: "issues", Action: "opened"},
	} {
		if got := Normalize(r); got == EventRunFailure {
			t.Errorf("Normalize(%+v) invented a failure event", r)
		}
	}
}
