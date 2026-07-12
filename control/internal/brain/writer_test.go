package brain

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testConfig(supabaseURL string) Config {
	return Config{
		SupabaseURL: supabaseURL,
		AnonKey:     "anon-key",
		JWTSecret:   "test-secret-at-least-32-characters-long!!",
		TenantID:    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		ProjectID:   "a1a1a1a1-0000-0000-0000-000000000001",
	}
}

func TestAppendSendsScopedRowAndTenantJWT(t *testing.T) {
	var gotAuth, gotAPIKey, gotPath string
	var gotRow map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotAPIKey = r.Header.Get("apikey")
		gotPath = r.URL.Path
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &gotRow)
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	wr, err := NewWriter(testConfig(srv.URL))
	if err != nil {
		t.Fatalf("NewWriter: %v", err)
	}
	err = wr.Append(context.Background(), Event{
		Kind: "decision", Payload: json.RawMessage(`{"title":"x"}`), Actor: "architect",
	})
	if err != nil {
		t.Fatalf("Append: %v", err)
	}

	if gotPath != "/rest/v1/brain_events" {
		t.Errorf("path = %q, want /rest/v1/brain_events", gotPath)
	}
	if gotAPIKey != "anon-key" {
		t.Errorf("apikey = %q, want anon-key", gotAPIKey)
	}
	// The bearer token must be a tenant-scoped JWT signed with our secret.
	tok := strings.TrimPrefix(gotAuth, "Bearer ")
	if tok == gotAuth || tok == "" {
		t.Fatalf("Authorization not a Bearer token: %q", gotAuth)
	}
	parts := strings.Split(tok, ".")
	if len(parts) != 3 || !verifySig(parts, testConfig("").JWTSecret) {
		t.Error("bearer token is not a validly-signed JWT")
	}

	// The row must carry the injected tenant/project — not anything the caller chose.
	if gotRow["tenant_id"] != "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" {
		t.Errorf("tenant_id = %v, want injected tenant", gotRow["tenant_id"])
	}
	if gotRow["project_id"] != "a1a1a1a1-0000-0000-0000-000000000001" {
		t.Errorf("project_id = %v, want injected project", gotRow["project_id"])
	}
	if gotRow["kind"] != "decision" || gotRow["actor"] != "architect" {
		t.Errorf("kind/actor not forwarded: %v / %v", gotRow["kind"], gotRow["actor"])
	}
}

func TestAppendErrorsOnNonCreated(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden) // e.g. RLS rejection
		_, _ = w.Write([]byte(`{"message":"new row violates row-level security policy"}`))
	}))
	defer srv.Close()

	wr, _ := NewWriter(testConfig(srv.URL))
	err := wr.Append(context.Background(), Event{Kind: "decision", Actor: "x"})
	if err == nil {
		t.Fatal("expected error on 403, got nil")
	}
	if !strings.Contains(err.Error(), "403") {
		t.Errorf("error should mention status: %v", err)
	}
}

func TestAppendValidates(t *testing.T) {
	wr, _ := NewWriter(testConfig("http://unused"))
	if err := wr.Append(context.Background(), Event{Kind: "", Actor: "x"}); err == nil {
		t.Error("expected error on empty kind")
	}
	if err := wr.Append(context.Background(), Event{Kind: "decision", Actor: ""}); err == nil {
		t.Error("expected error on empty actor")
	}
}

func TestNewWriterRequiresConfig(t *testing.T) {
	if _, err := NewWriter(Config{SupabaseURL: "x"}); err == nil {
		t.Error("expected error on incomplete config")
	}
}

func verifySig(parts []string, secret string) bool {
	return parts[2] == sign(parts[0]+"."+parts[1], secret)
}
