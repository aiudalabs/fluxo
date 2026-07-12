package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aiudalabs/fluxo/control/internal/state"
)

// fakeStore records what the endpoint passed through and returns canned data.
type fakeStore struct {
	gotToken, gotProject string
	stories              []state.Story
	runs                 []state.Run
	err                  error
}

func (f *fakeStore) ListStories(_ context.Context, token, projectID string) ([]state.Story, error) {
	f.gotToken, f.gotProject = token, projectID
	return f.stories, f.err
}
func (f *fakeStore) ListRuns(_ context.Context, token, projectID string) ([]state.Run, error) {
	f.gotToken, f.gotProject = token, projectID
	return f.runs, f.err
}

func TestHealthz(t *testing.T) {
	rec := httptest.NewRecorder()
	New("test-cors", nil).Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not JSON: %v", err)
	}
	if body["status"] != "ok" {
		t.Errorf("status field = %q, want ok", body["status"])
	}
}

func TestReadyz(t *testing.T) {
	rec := httptest.NewRecorder()
	New("test-cors", nil).Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

func TestUnknownRouteIs404(t *testing.T) {
	rec := httptest.NewRecorder()
	New("test-cors", nil).Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/nope", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestCORSHeaderPresent(t *testing.T) {
	rec := httptest.NewRecorder()
	New("https://console.example", nil).Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://console.example" {
		t.Errorf("Allow-Origin = %q", got)
	}
}

func TestListStoriesPassesTokenAndProject(t *testing.T) {
	fs := &fakeStore{stories: []state.Story{{ID: "s1", Status: state.StatusBacklog}}}
	srv := New("cors", fs)
	req := httptest.NewRequest(http.MethodGet, "/stories?project_id=p1", nil)
	req.Header.Set("Authorization", "Bearer tenant-tok")
	rec := httptest.NewRecorder()

	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body)
	}
	if fs.gotToken != "tenant-tok" {
		t.Errorf("token passed = %q, want tenant-tok", fs.gotToken)
	}
	if fs.gotProject != "p1" {
		t.Errorf("project passed = %q, want p1", fs.gotProject)
	}
}

func TestStateEndpointRequiresBearer(t *testing.T) {
	srv := New("cors", &fakeStore{})
	req := httptest.NewRequest(http.MethodGet, "/stories?project_id=p1", nil) // no Authorization
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestStateEndpointRequiresProject(t *testing.T) {
	srv := New("cors", &fakeStore{})
	req := httptest.NewRequest(http.MethodGet, "/runs", nil)
	req.Header.Set("Authorization", "Bearer x")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestStateEndpointDisabledWhenNoStore(t *testing.T) {
	srv := New("cors", nil)
	req := httptest.NewRequest(http.MethodGet, "/stories?project_id=p1", nil)
	req.Header.Set("Authorization", "Bearer x")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}
