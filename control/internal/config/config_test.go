package config

import "testing"

func TestLoadDefaults(t *testing.T) {
	cfg := Load(func(string) (string, bool) { return "", false })

	if cfg.Addr != defaultAddr {
		t.Errorf("Addr = %q, want %q", cfg.Addr, defaultAddr)
	}
	if cfg.CORSOrigin != defaultCORSOrigin {
		t.Errorf("CORSOrigin = %q, want %q", cfg.CORSOrigin, defaultCORSOrigin)
	}
}

func TestLoadOverridesFromEnv(t *testing.T) {
	env := map[string]string{
		"CONTROL_ADDR":        ":9090",
		"CONTROL_CORS_ORIGIN": "https://fluxo.aiudalabs.com",
	}
	cfg := Load(func(k string) (string, bool) {
		v, ok := env[k]
		return v, ok
	})

	if cfg.Addr != ":9090" {
		t.Errorf("Addr = %q, want :9090", cfg.Addr)
	}
	if cfg.CORSOrigin != "https://fluxo.aiudalabs.com" {
		t.Errorf("CORSOrigin = %q, want the overridden origin", cfg.CORSOrigin)
	}
}

func TestLoadIgnoresEmptyEnv(t *testing.T) {
	// An env var that is set but empty must not clobber the default.
	cfg := Load(func(k string) (string, bool) {
		if k == "CONTROL_ADDR" {
			return "", true
		}
		return "", false
	})

	if cfg.Addr != defaultAddr {
		t.Errorf("empty CONTROL_ADDR should keep default; got %q", cfg.Addr)
	}
}
