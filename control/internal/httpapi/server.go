// Package httpapi is the control-plane HTTP surface.
//
// F0-04 scope: a process that boots, answers health/readiness probes, and
// applies a single CORS origin for the console. No tenant resolution, no
// dispatch, no business logic yet — those arrive in later phases (see
// docs/03-roadmap.md and docs/02-capa-runtime.md).
package httpapi

import (
	"encoding/json"
	"net/http"
)

// Server holds the HTTP routing for the control plane.
type Server struct {
	corsOrigin string
	mux        *http.ServeMux
}

// New builds a Server whose routes are ready to serve. corsOrigin is the single
// browser origin allowed to call the API.
func New(corsOrigin string) *Server {
	s := &Server{corsOrigin: corsOrigin, mux: http.NewServeMux()}
	s.mux.HandleFunc("GET /healthz", s.handleHealthz)
	s.mux.HandleFunc("GET /readyz", s.handleReadyz)
	return s
}

// Handler returns the http.Handler with cross-cutting middleware applied.
func (s *Server) Handler() http.Handler {
	return s.withCORS(s.mux)
}

func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleReadyz reports whether the process is ready to serve. With no
// downstream dependencies wired yet it is always ready; readiness will grow a
// real check (DB reachability) when control gains dependencies.
func (s *Server) handleReadyz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
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
