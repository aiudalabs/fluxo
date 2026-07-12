package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func newTestServer() *Server {
	s := New("test", "0.0.1")
	s.Register(Tool{
		Name:        "echo",
		Description: "echoes back",
		InputSchema: json.RawMessage(`{"type":"object","properties":{"msg":{"type":"string"}}}`),
		Handler: func(_ context.Context, args json.RawMessage) (string, error) {
			var a struct {
				Msg string `json:"msg"`
			}
			_ = json.Unmarshal(args, &a)
			if a.Msg == "boom" {
				return "", errTest
			}
			return "echo:" + a.Msg, nil
		},
	})
	return s
}

var errTest = &testError{"handler failed"}

type testError struct{ s string }

func (e *testError) Error() string { return e.s }

func do(t *testing.T, s *Server, msg string) rpcResponse {
	t.Helper()
	resp, has := s.handle(context.Background(), []byte(msg))
	if !has {
		t.Fatal("expected a response, got none")
	}
	return resp
}

func TestInitialize(t *testing.T) {
	resp := do(t, newTestServer(), `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
	if resp.Error != nil {
		t.Fatalf("unexpected error: %v", resp.Error)
	}
	res := resp.Result.(map[string]any)
	if res["protocolVersion"] != protocolVersion {
		t.Errorf("protocolVersion = %v", res["protocolVersion"])
	}
	if _, ok := res["capabilities"].(map[string]any)["tools"]; !ok {
		t.Error("capabilities.tools missing")
	}
}

func TestToolsList(t *testing.T) {
	resp := do(t, newTestServer(), `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	tools := resp.Result.(map[string]any)["tools"].([]map[string]any)
	if len(tools) != 1 || tools[0]["name"] != "echo" {
		t.Fatalf("tools/list = %v", tools)
	}
	if tools[0]["inputSchema"] == nil {
		t.Error("inputSchema missing")
	}
}

func TestToolsCallSuccess(t *testing.T) {
	resp := do(t, newTestServer(), `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"msg":"hi"}}}`)
	res := resp.Result.(map[string]any)
	if res["isError"].(bool) {
		t.Fatal("unexpected isError")
	}
	content := res["content"].([]map[string]any)
	if content[0]["text"] != "echo:hi" {
		t.Errorf("text = %v", content[0]["text"])
	}
}

func TestToolsCallHandlerErrorIsToolError(t *testing.T) {
	resp := do(t, newTestServer(), `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"echo","arguments":{"msg":"boom"}}}`)
	if resp.Error != nil {
		t.Fatal("handler error must be a tool result (isError), not a protocol error")
	}
	res := resp.Result.(map[string]any)
	if !res["isError"].(bool) {
		t.Error("expected isError=true")
	}
}

func TestUnknownToolAndMethod(t *testing.T) {
	if r := do(t, newTestServer(), `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"nope"}}`); r.Error == nil {
		t.Error("unknown tool should error")
	}
	if r := do(t, newTestServer(), `{"jsonrpc":"2.0","id":6,"method":"does/notexist"}`); r.Error == nil || r.Error.Code != -32601 {
		t.Errorf("unknown method should be -32601, got %v", r.Error)
	}
}

func TestNotificationGetsNoReply(t *testing.T) {
	_, has := newTestServer().handle(context.Background(), []byte(`{"jsonrpc":"2.0","method":"notifications/initialized"}`))
	if has {
		t.Error("a notification (no id) must not get a reply")
	}
}

func TestServeDrivesFullHandshake(t *testing.T) {
	// initialize → notifications/initialized → tools/call. The notification must
	// NOT produce a reply, so we expect exactly two response lines.
	in := strings.NewReader(strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo","arguments":{"msg":"x"}}}`,
	}, "\n"))

	var out strings.Builder
	if err := newTestServer().Serve(context.Background(), in, &out); err != nil {
		t.Fatalf("Serve: %v", err)
	}

	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected 2 response lines (notification silent), got %d: %q", len(lines), out.String())
	}
	if !strings.Contains(lines[0], `"protocolVersion"`) {
		t.Errorf("first response should be initialize result: %q", lines[0])
	}
	if !strings.Contains(lines[1], "echo:x") {
		t.Errorf("second response should carry tool output: %q", lines[1])
	}
}
