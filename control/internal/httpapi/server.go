// Package httpapi is the control-plane HTTP surface.
//
// It stays thin (docs/01-arquitectura.md): health probes plus read endpoints for
// tickets/runs that delegate to the state store. Every state request carries the
// caller's tenant token straight through to Postgres, where RLS scopes it — the
// API never filters by tenant itself (F2-03; kills L-SEC-1/2/6).
package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/aiudalabs/fluxo/control/internal/state"
)

// StateStore is the read surface over the execution state. *state.Store satisfies
// it; tests use a fake. It is nil when Supabase is not configured.
type StateStore interface {
	ListStories(ctx context.Context, token, projectID string) ([]state.Story, error)
	ListRuns(ctx context.Context, token, projectID string) ([]state.Run, error)
}

// Server holds the HTTP routing for the control plane.
type Server struct {
	corsOrigin string
	store      StateStore
	mux        *http.ServeMux
}

// New builds a Server whose routes are ready to serve. corsOrigin is the single
// browser origin allowed to call the API; store may be nil (state endpoints then
// return 503).
func New(corsOrigin string, store StateStore) *Server {
	s := &Server{corsOrigin: corsOrigin, store: store, mux: http.NewServeMux()}
	s.mux.HandleFunc("GET /healthz", s.handleHealthz)
	s.mux.HandleFunc("GET /readyz", s.handleReadyz)
	s.mux.HandleFunc("GET /stories", s.handleListStories)
	s.mux.HandleFunc("GET /runs", s.handleListRuns)
	return s
}

// Handler returns the http.Handler with cross-cutting middleware applied.
func (s *Server) Handler() http.Handler {
	return s.withCORS(s.mux)
}

func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleReadyz(w http.ResponseWriter, _ *http.Request) {
	// Body key is deliberately not a story-status word, so the status-literal arch
	// lint stays strict without special-casing this handler.
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleListStories(w http.ResponseWriter, r *http.Request) {
	token, projectID, ok := s.stateParams(w, r)
	if !ok {
		return
	}
	stories, err := s.store.ListStories(r.Context(), token, projectID)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, stories)
}

func (s *Server) handleListRuns(w http.ResponseWriter, r *http.Request) {
	token, projectID, ok := s.stateParams(w, r)
	if !ok {
		return
	}
	runs, err := s.store.ListRuns(r.Context(), token, projectID)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, runs)
}

// stateParams validates the shared preconditions for state endpoints and returns
// the caller token + project scope. It writes the error response itself and
// returns ok=false when a precondition fails.
func (s *Server) stateParams(w http.ResponseWriter, r *http.Request) (token, projectID string, ok bool) {
	if s.store == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "state store not configured"})
		return "", "", false
	}
	token = bearerToken(r)
	if token == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "missing bearer token"})
		return "", "", false
	}
	projectID = r.URL.Query().Get("project_id")
	if projectID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "project_id is required"})
		return "", "", false
	}
	return token, projectID, true
}

func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if after, found := strings.CutPrefix(h, "Bearer "); found {
		return strings.TrimSpace(after)
	}
	return ""
}

func (s *Server) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", s.corsOrigin)
		w.Header().Set("Vary", "Origin")
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
