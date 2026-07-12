// Package mcp is a minimal Model Context Protocol server over stdio — just enough
// of the protocol (initialize, tools/list, tools/call) to expose Fluxo's tools to
// any MCP client (the design-agent SDK, Claude Code, a test harness). Stdlib only;
// no SDK dependency. Messages are newline-delimited JSON-RPC 2.0, per the MCP
// stdio transport.
package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
)

const protocolVersion = "2024-11-05"

// ToolHandler runs a tool call. It receives the raw `arguments` object and
// returns human/agent-readable text, or an error (surfaced as an MCP tool error).
type ToolHandler func(ctx context.Context, arguments json.RawMessage) (string, error)

// Tool is a registered capability.
type Tool struct {
	Name        string
	Description string
	InputSchema json.RawMessage
	Handler     ToolHandler
}

// Server dispatches JSON-RPC messages to registered tools.
type Server struct {
	name    string
	version string
	tools   map[string]Tool
	order   []string
}

// New returns an empty server identified by name/version.
func New(name, version string) *Server {
	return &Server{name: name, version: version, tools: map[string]Tool{}}
}

// Register adds a tool. Later registrations override an earlier same-named one.
func (s *Server) Register(t Tool) {
	if _, exists := s.tools[t.Name]; !exists {
		s.order = append(s.order, t.Name)
	}
	s.tools[t.Name] = t
}

// Serve reads newline-delimited JSON-RPC messages from in and writes responses to
// out until in is exhausted or ctx is cancelled.
func (s *Server) Serve(ctx context.Context, in io.Reader, out io.Writer) error {
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	enc := json.NewEncoder(out)
	for scanner.Scan() {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		resp, hasResp := s.handle(ctx, line)
		if hasResp {
			if err := enc.Encode(resp); err != nil {
				return err
			}
		}
	}
	return scanner.Err()
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// handle processes one message. It returns (response, true) for requests and
// (_, false) for notifications (no id) — which get no reply, per JSON-RPC.
func (s *Server) handle(ctx context.Context, raw []byte) (rpcResponse, bool) {
	var req rpcRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return errorResponse(nil, -32700, "parse error"), true
	}
	// A notification has no id — process side effects but never reply.
	if len(req.ID) == 0 {
		return rpcResponse{}, false
	}

	switch req.Method {
	case "initialize":
		return okResponse(req.ID, s.initializeResult()), true
	case "tools/list":
		return okResponse(req.ID, s.toolsListResult()), true
	case "tools/call":
		return s.callTool(ctx, req), true
	default:
		return errorResponse(req.ID, -32601, "method not found: "+req.Method), true
	}
}

func (s *Server) initializeResult() map[string]any {
	return map[string]any{
		"protocolVersion": protocolVersion,
		"capabilities":    map[string]any{"tools": map[string]any{}},
		"serverInfo":      map[string]any{"name": s.name, "version": s.version},
	}
}

func (s *Server) toolsListResult() map[string]any {
	list := make([]map[string]any, 0, len(s.order))
	for _, name := range s.order {
		t := s.tools[name]
		schema := t.InputSchema
		if len(schema) == 0 {
			schema = json.RawMessage(`{"type":"object"}`)
		}
		list = append(list, map[string]any{
			"name":        t.Name,
			"description": t.Description,
			"inputSchema": schema,
		})
	}
	return map[string]any{"tools": list}
}

func (s *Server) callTool(ctx context.Context, req rpcRequest) rpcResponse {
	var params struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "invalid params")
	}
	tool, ok := s.tools[params.Name]
	if !ok {
		return errorResponse(req.ID, -32602, "unknown tool: "+params.Name)
	}

	text, err := tool.Handler(ctx, params.Arguments)
	if err != nil {
		// Tool errors are reported in the result with isError, not as a protocol
		// error — the client/agent sees the message and can react.
		return okResponse(req.ID, toolResult(fmt.Sprintf("error: %v", err), true))
	}
	return okResponse(req.ID, toolResult(text, false))
}

func toolResult(text string, isErr bool) map[string]any {
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": text}},
		"isError": isErr,
	}
}

func okResponse(id json.RawMessage, result any) rpcResponse {
	return rpcResponse{JSONRPC: "2.0", ID: id, Result: result}
}

func errorResponse(id json.RawMessage, code int, msg string) rpcResponse {
	return rpcResponse{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: code, Message: msg}}
}
