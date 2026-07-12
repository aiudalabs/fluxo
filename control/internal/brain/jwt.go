package brain

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
)

// mintTenantJWT builds an HS256 Supabase JWT scoped to one tenant. The token
// carries role=authenticated and a custom `tenant` claim, so that when the brain
// writer presents it to Supabase REST, PostgREST runs the request AS the
// authenticated role with request.jwt.claims->>'tenant' set — and the
// brain_events RLS policy (auth.jwt()->>'tenant') enforces isolation for real.
// No service_role bypass.
//
// Stdlib only (HMAC-SHA256 + base64url); no JWT dependency. In prod the signing
// secret comes from Vault (L-SEC-3), never a plaintext file.
func mintTenantJWT(secret, tenantID, subject string, issuedAt, expiresAt int64) (string, error) {
	if secret == "" {
		return "", fmt.Errorf("brain: empty JWT secret")
	}
	if tenantID == "" {
		return "", fmt.Errorf("brain: empty tenant id")
	}

	header := map[string]string{"alg": "HS256", "typ": "JWT"}
	claims := map[string]any{
		"role":   "authenticated",
		"aud":    "authenticated",
		"sub":    subject,
		"tenant": tenantID,
		"iat":    issuedAt,
		"exp":    expiresAt,
	}

	hSeg, err := encodeSegment(header)
	if err != nil {
		return "", err
	}
	cSeg, err := encodeSegment(claims)
	if err != nil {
		return "", err
	}

	signingInput := hSeg + "." + cSeg
	sig := sign(signingInput, secret)
	return signingInput + "." + sig, nil
}

func encodeSegment(v any) (string, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", fmt.Errorf("brain: marshal jwt segment: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func sign(signingInput, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(signingInput))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
