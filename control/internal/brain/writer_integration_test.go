package brain

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"testing"
)

// TestAppendAgainstLocalSupabase exercises the real path: mint a tenant JWT, POST
// to PostgREST, and let RLS enforce isolation. Skipped unless the local Supabase
// env is present (set via: set -a; . ./.env; set +a). Run from repo root or
// control/ with those vars exported.
func TestAppendAgainstLocalSupabase(t *testing.T) {
	restBase := os.Getenv("SUPABASE_URL")
	anon := os.Getenv("SUPABASE_ANON_KEY")
	secret := os.Getenv("SUPABASE_JWT_SECRET")
	if restBase == "" || anon == "" || secret == "" {
		t.Skip("SUPABASE_URL/ANON_KEY/JWT_SECRET not set — skipping integration test")
	}
	rest := restBase + "/rest/v1"

	tenantA := "11111111-2222-3333-4444-555555555555"
	tenantB := "99999999-8888-7777-6666-555555555555"
	project := "12121212-0000-0000-0000-000000000001"

	cfg := Config{RestURL: rest, AnonKey: anon, JWTSecret: secret, TenantID: tenantA, ProjectID: project}
	wr, err := NewWriter(cfg)
	if err != nil {
		t.Fatalf("NewWriter: %v", err)
	}

	// 1. Same-tenant append succeeds (RLS WITH CHECK passes).
	kind := "decision"
	if err := wr.Append(context.Background(), Event{
		Kind: kind, Payload: json.RawMessage(`{"title":"integration-smoke"}`), Actor: "test",
	}); err != nil {
		t.Fatalf("same-tenant append should succeed: %v", err)
	}

	// 2. Tenant A can read back its row (RLS SELECT allows own tenant).
	tokA, _ := mintTenantJWT(secret, tenantA, "test", 0, 1<<62)
	rows := restGet(t, rest+"/brain_events?project_id=eq."+project+"&kind=eq."+kind, anon, tokA)
	if len(rows) == 0 {
		t.Error("tenant A should see its own appended row")
	}

	// 3. Tenant B sees none of tenant A's rows (cross-tenant read REJECTED).
	tokB, _ := mintTenantJWT(secret, tenantB, "test", 0, 1<<62)
	rowsB := restGet(t, rest+"/brain_events?project_id=eq."+project, anon, tokB)
	if len(rowsB) != 0 {
		t.Errorf("tenant B must not see tenant A rows, saw %d (L-ARCH-1 leak!)", len(rowsB))
	}

	// 4. Forging a row under tenant B with tenant A's token is rejected by RLS.
	if status := restPostTenant(t, rest+"/brain_events", anon, tokA, map[string]any{
		"tenant_id": tenantB, "project_id": project, "kind": "forged", "payload": map[string]any{}, "actor": "attacker",
	}); status == http.StatusCreated {
		t.Error("cross-tenant INSERT via REST must be rejected by RLS, but it succeeded")
	}
}

func restGet(t *testing.T, url, anon, bearer string) []map[string]any {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("apikey", anon)
	req.Header.Set("Authorization", "Bearer "+bearer)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	var out []map[string]any
	_ = json.Unmarshal(b, &out)
	return out
}

func restPostTenant(t *testing.T, url, anon, bearer string, row map[string]any) int {
	t.Helper()
	b, _ := json.Marshal(row)
	req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("apikey", anon)
	req.Header.Set("Authorization", "Bearer "+bearer)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	return resp.StatusCode
}
