package brain

import (
	"crypto/hmac"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestMintTenantJWTStructureAndClaims(t *testing.T) {
	const secret = "test-secret-at-least-32-characters-long!!"
	tok, err := mintTenantJWT(secret, "tenant-abc", "brain-mcp", 1000, 2000)
	if err != nil {
		t.Fatalf("mint: %v", err)
	}

	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatalf("token has %d segments, want 3", len(parts))
	}

	// Signature must verify against the same secret (and only that secret).
	want := sign(parts[0]+"."+parts[1], secret)
	if !hmac.Equal([]byte(parts[2]), []byte(want)) {
		t.Error("signature does not verify against the signing secret")
	}
	bad := sign(parts[0]+"."+parts[1], "wrong-secret")
	if hmac.Equal([]byte(parts[2]), []byte(bad)) {
		t.Error("signature verified against the WRONG secret")
	}

	claims := decodeClaims(t, parts[1])
	if claims["role"] != "authenticated" {
		t.Errorf("role = %v, want authenticated", claims["role"])
	}
	if claims["tenant"] != "tenant-abc" {
		t.Errorf("tenant = %v, want tenant-abc", claims["tenant"])
	}
	if claims["exp"].(float64) != 2000 {
		t.Errorf("exp = %v, want 2000", claims["exp"])
	}
}

func TestMintTenantJWTRejectsEmptyInputs(t *testing.T) {
	if _, err := mintTenantJWT("", "t", "s", 1, 2); err == nil {
		t.Error("expected error on empty secret")
	}
	if _, err := mintTenantJWT("secret", "", "s", 1, 2); err == nil {
		t.Error("expected error on empty tenant id")
	}
}

// decodeClaims verifies the payload is standard base64url JSON (what PostgREST
// will parse), not just something our own code round-trips.
func decodeClaims(t *testing.T, seg string) map[string]any {
	t.Helper()
	raw, err := base64.RawURLEncoding.DecodeString(seg)
	if err != nil {
		t.Fatalf("payload not base64url: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("payload not JSON: %v", err)
	}
	return m
}
