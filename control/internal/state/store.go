// Package state is the control-plane access to the execution state (stories, runs)
// in Postgres. Every call goes through Supabase REST AS THE CALLER'S TENANT: RLS
// scopes every row to the token's tenant, so there is no hand-rolled WHERE-by-
// tenant anywhere here (kills L-SEC-1/2/6, L-ARCH-1/3). The database is the guard,
// not Go. Filters like project_id are within-tenant conveniences, never the
// security boundary.
package state

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Store talks to PostgREST. It holds no tenant identity of its own — the caller's
// token carries it, one request at a time.
type Store struct {
	restURL string
	anonKey string
	http    *http.Client
}

// NewStore validates config and returns a Store. supabaseURL is the Supabase
// project URL (e.g. http://127.0.0.1:54321); the store derives the PostgREST base
// from it, so PostgREST paths live only in this package (see the arch lint).
func NewStore(supabaseURL, anonKey string) (*Store, error) {
	if supabaseURL == "" || anonKey == "" {
		return nil, fmt.Errorf("state: supabaseURL and anonKey are required")
	}
	return &Store{
		restURL: strings.TrimRight(supabaseURL, "/") + "/rest/v1",
		anonKey: anonKey,
		http:    &http.Client{Timeout: 10 * time.Second},
	}, nil
}

// Story mirrors public.stories (the fields the console needs).
type Story struct {
	ID        string   `json:"id"`
	ProjectID string   `json:"project_id"`
	SprintID  *string  `json:"sprint_id"`
	Key       string   `json:"key"`
	Title     string   `json:"title"`
	Lane      string   `json:"lane"`
	Status    Status   `json:"status"`
	BlockedBy []string `json:"blocked_by"`
	CreatedAt string   `json:"created_at"`
	UpdatedAt string   `json:"updated_at"`
}

// Run mirrors public.runs.
type Run struct {
	ID         string  `json:"id"`
	ProjectID  string  `json:"project_id"`
	StoryID    string  `json:"story_id"`
	Runtime    string  `json:"runtime"`
	Provider   string  `json:"provider"`
	Status     string  `json:"status"`
	SessionRef *string `json:"session_ref"`
	StartedAt  string  `json:"started_at"`
	EndedAt    *string `json:"ended_at"`
}

// ListStories returns the caller-tenant's stories for a project, newest first.
// Note the query scopes by project_id only — tenant scoping is RLS's job.
func (s *Store) ListStories(ctx context.Context, token, projectID string) ([]Story, error) {
	q := url.Values{}
	q.Set("project_id", "eq."+projectID)
	q.Set("order", "created_at.desc")
	var out []Story
	if err := s.get(ctx, token, "/stories", q, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListRuns returns the caller-tenant's runs for a project, newest first.
func (s *Store) ListRuns(ctx context.Context, token, projectID string) ([]Run, error) {
	q := url.Values{}
	q.Set("project_id", "eq."+projectID)
	q.Set("order", "started_at.desc")
	var out []Run
	if err := s.get(ctx, token, "/runs", q, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Store) get(ctx context.Context, token, path string, q url.Values, dst any) error {
	if token == "" {
		return fmt.Errorf("state: missing caller token")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.restURL+path+"?"+q.Encode(), nil)
	if err != nil {
		return fmt.Errorf("state: build request: %w", err)
	}
	req.Header.Set("apikey", s.anonKey)
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := s.http.Do(req)
	if err != nil {
		return fmt.Errorf("state: request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("state: %s %d: %s", path, resp.StatusCode, snippet)
	}
	if err := json.NewDecoder(resp.Body).Decode(dst); err != nil {
		return fmt.Errorf("state: decode: %w", err)
	}
	return nil
}
