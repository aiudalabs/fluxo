// Command brain-mcp is the MCP tool server for the brain (F1-02). It exposes a
// single tool, `brain_write`, that appends an append-only event to
// public.brain_events for ONE project. The design-agent runtime launches it with
// the project context injected via env (FLUXO_TENANT_ID / FLUXO_PROJECT_ID), so
// the agent supplies only kind/payload/actor and can never write another tenant's
// rows — RLS enforces it (see registry/skills/brain-write.md, docs/01).
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/aiudalabs/fluxo/control/internal/brain"
	"github.com/aiudalabs/fluxo/control/internal/mcp"
)

const version = "0.1.0"

var brainWriteSchema = json.RawMessage(`{
  "type": "object",
  "properties": {
    "kind":    {"type": "string", "enum": ["decision", "gate_answer", "rejected_design", "provenance"]},
    "payload": {"type": "object", "description": "per-kind structured content; see the brain-write skill"},
    "actor":   {"type": "string", "description": "who produced it: an agent id, human:<user>, or system"}
  },
  "required": ["kind", "actor"],
  "additionalProperties": false
}`)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "brain-mcp:", err)
		os.Exit(1)
	}
}

func run() error {
	writer, err := brain.NewWriter(brain.Config{
		SupabaseURL: os.Getenv("SUPABASE_URL"),
		AnonKey:     os.Getenv("SUPABASE_ANON_KEY"),
		JWTSecret:   os.Getenv("SUPABASE_JWT_SECRET"),
		TenantID:    os.Getenv("FLUXO_TENANT_ID"),
		ProjectID:   os.Getenv("FLUXO_PROJECT_ID"),
	})
	if err != nil {
		return err
	}

	srv := mcp.New("fluxo-brain", version)
	srv.Register(mcp.Tool{
		Name:        "brain_write",
		Description: "Append one append-only event (decision, gate_answer, rejected_design, provenance) to the project's brain. tenant/project are injected from context.",
		InputSchema: brainWriteSchema,
		Handler:     brainWriteHandler(writer),
	})

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	return srv.Serve(ctx, os.Stdin, os.Stdout)
}

func brainWriteHandler(writer *brain.Writer) mcp.ToolHandler {
	return func(ctx context.Context, args json.RawMessage) (string, error) {
		var in struct {
			Kind    string          `json:"kind"`
			Payload json.RawMessage `json:"payload"`
			Actor   string          `json:"actor"`
		}
		if err := json.Unmarshal(args, &in); err != nil {
			return "", fmt.Errorf("invalid arguments: %w", err)
		}
		if err := writer.Append(ctx, brain.Event{Kind: in.Kind, Payload: in.Payload, Actor: in.Actor}); err != nil {
			return "", err
		}
		return fmt.Sprintf("brain: %s appended", in.Kind), nil
	}
}
