// Package brain writes append-only events to the brain (public.brain_events,
// F1-01) through Supabase's REST API. Isolation is enforced by RLS: the writer
// presents a tenant-scoped JWT and writes AS the authenticated role, so the
// database — not this code — guarantees a tenant can only write its own rows.
package brain

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Config is the substrate + identity the writer needs. Tenant/Project are the
// injected project context (never chosen by the calling agent); Secret signs the
// tenant JWT (from Vault in prod, env in dev).
type Config struct {
	RestURL   string // e.g. http://127.0.0.1:54321/rest/v1
	AnonKey   string // Supabase apikey header (gateway passthrough)
	JWTSecret string // signs the tenant JWT
	TenantID  string // injected project context
	ProjectID string // injected project context
}

// Event is what an agent appends. TenantID/ProjectID are filled from Config, not
// from the agent — the agent supplies only Kind/Payload/Actor.
type Event struct {
	Kind    string          `json:"kind"`
	Payload json.RawMessage `json:"payload"`
	Actor   string          `json:"actor"`
}

// Writer appends events to the brain for one project.
type Writer struct {
	cfg   Config
	http  *http.Client
	now   func() time.Time
	subj  string
	jwtTL time.Duration
}

// NewWriter validates config and returns a ready Writer.
func NewWriter(cfg Config) (*Writer, error) {
	for name, v := range map[string]string{
		"RestURL": cfg.RestURL, "AnonKey": cfg.AnonKey, "JWTSecret": cfg.JWTSecret,
		"TenantID": cfg.TenantID, "ProjectID": cfg.ProjectID,
	} {
		if v == "" {
			return nil, fmt.Errorf("brain: missing config %s", name)
		}
	}
	return &Writer{
		cfg:   cfg,
		http:  &http.Client{Timeout: 10 * time.Second},
		now:   time.Now,
		subj:  "brain-mcp",
		jwtTL: 2 * time.Minute,
	}, nil
}

// Append writes one event. It mints a short-lived tenant JWT, POSTs the row to
// PostgREST, and returns an error unless the row is created (201). A cross-tenant
// attempt is rejected by RLS at the database and surfaces here as an error.
func (w *Writer) Append(ctx context.Context, ev Event) error {
	if ev.Kind == "" || ev.Actor == "" {
		return fmt.Errorf("brain: kind and actor are required")
	}
	payload := ev.Payload
	if len(payload) == 0 {
		payload = json.RawMessage(`{}`)
	}

	now := w.now()
	tok, err := mintTenantJWT(w.cfg.JWTSecret, w.cfg.TenantID, w.subj, now.Unix(), now.Add(w.jwtTL).Unix())
	if err != nil {
		return err
	}

	row := map[string]any{
		"tenant_id":  w.cfg.TenantID,
		"project_id": w.cfg.ProjectID,
		"kind":       ev.Kind,
		"payload":    payload,
		"actor":      ev.Actor,
	}
	body, err := json.Marshal(row)
	if err != nil {
		return fmt.Errorf("brain: marshal row: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, w.cfg.RestURL+"/brain_events", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("brain: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("apikey", w.cfg.AnonKey)
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Prefer", "return=minimal")

	resp, err := w.http.Do(req)
	if err != nil {
		return fmt.Errorf("brain: post event: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("brain: append rejected (status %d): %s", resp.StatusCode, bytes.TrimSpace(snippet))
	}
	return nil
}
