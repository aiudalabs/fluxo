// Package config loads the control-plane configuration from the environment.
//
// The control plane is intentionally thin (see docs/01-arquitectura.md): almost
// all state and isolation live in Postgres+RLS. Config here is only the wiring
// the process needs to boot — no business logic, no methodology (golden rule).
package config

const (
	defaultAddr       = ":8080"
	defaultCORSOrigin = "http://localhost:3000"
)

// Config is the resolved runtime configuration of the control plane.
type Config struct {
	// Addr is the TCP address the HTTP API listens on (CONTROL_ADDR).
	Addr string
	// CORSOrigin is the single allowed browser origin for the console
	// (CONTROL_CORS_ORIGIN).
	CORSOrigin string
	// SupabaseURL is the Supabase project URL (SUPABASE_URL); the state store
	// derives its PostgREST base from it. Empty ⇒ state endpoints are disabled.
	SupabaseURL string
	// SupabaseAnonKey is the anon apikey for REST gateway passthrough
	// (SUPABASE_ANON_KEY).
	SupabaseAnonKey string
}

// Lookup mirrors os.LookupEnv: it returns the value and whether it was set.
// Taking it as a parameter keeps Load pure and testable.
type Lookup func(key string) (string, bool)

// Load resolves the configuration, falling back to defaults for any variable
// that is unset or set to the empty string.
func Load(lookup Lookup) Config {
	return Config{
		Addr:            envOr(lookup, "CONTROL_ADDR", defaultAddr),
		CORSOrigin:      envOr(lookup, "CONTROL_CORS_ORIGIN", defaultCORSOrigin),
		SupabaseURL:     envOr(lookup, "SUPABASE_URL", ""),
		SupabaseAnonKey: envOr(lookup, "SUPABASE_ANON_KEY", ""),
	}
}

func envOr(lookup Lookup, key, fallback string) string {
	if v, ok := lookup(key); ok && v != "" {
		return v
	}
	return fallback
}
