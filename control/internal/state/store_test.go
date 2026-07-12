package state

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestListStoriesScopesByProjectNotTenant(t *testing.T) {
	var gotQuery, gotAuth, gotAPIKey, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		gotAuth = r.Header.Get("Authorization")
		gotAPIKey = r.Header.Get("apikey")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"id":"s1","project_id":"p1","key":"S1-01","status":"backlog","blocked_by":[]}]`))
	}))
	defer srv.Close()

	store, err := NewStore(srv.URL, "anon-key")
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	stories, err := store.ListStories(context.Background(), "tenant-token", "p1")
	if err != nil {
		t.Fatalf("ListStories: %v", err)
	}

	if gotPath != "/rest/v1/stories" {
		t.Errorf("path = %q, want /rest/v1/stories", gotPath)
	}
	if gotAPIKey != "anon-key" {
		t.Errorf("apikey = %q", gotAPIKey)
	}
	if gotAuth != "Bearer tenant-token" {
		t.Errorf("Authorization = %q, want the caller token", gotAuth)
	}
	// The security invariant: NO tenant filter is sent — RLS scopes by tenant.
	if contains(gotQuery, "tenant") {
		t.Errorf("query must not filter by tenant (RLS does that); got %q", gotQuery)
	}
	if !contains(gotQuery, "project_id=eq.p1") {
		t.Errorf("query should scope by project_id; got %q", gotQuery)
	}
	if len(stories) != 1 || stories[0].Status != StatusBacklog {
		t.Errorf("unexpected stories: %+v", stories)
	}
}

func TestListRunsSendsTokenNoTenantFilter(t *testing.T) {
	var gotQuery, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		gotAuth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()

	store, _ := NewStore(srv.URL, "anon-key")
	if _, err := store.ListRuns(context.Background(), "tok", "p1"); err != nil {
		t.Fatalf("ListRuns: %v", err)
	}
	if gotAuth != "Bearer tok" {
		t.Errorf("Authorization = %q", gotAuth)
	}
	if contains(gotQuery, "tenant") {
		t.Errorf("runs query must not filter by tenant; got %q", gotQuery)
	}
}

func TestGetRequiresToken(t *testing.T) {
	store, _ := NewStore("http://unused", "anon")
	if _, err := store.ListStories(context.Background(), "", "p1"); err == nil {
		t.Error("expected error when caller token is empty")
	}
}

func TestNewStoreValidates(t *testing.T) {
	if _, err := NewStore("", "anon"); err == nil {
		t.Error("expected error on empty restURL")
	}
	if _, err := NewStore("http://x", ""); err == nil {
		t.Error("expected error on empty anonKey")
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
