# control/ — pegamento Go mínimo

El plano de control: API HTTP, resolución de tenant (JWT→tenant_id), y el **dispatch a la capa de runtime**
(interfaz `Runtime`, ver `docs/02-capa-runtime.md`). Objetivo: **lo más delgado posible** — casi todo el estado y el
aislamiento viven en Postgres+RLS; la reconciliación en Edge Functions (Maestro). Aquí NO va metodología (regla de
oro) ni lógica de aislamiento a mano (eso es RLS).

## Estado (F0-04 ✅)

Skeleton mínimo, **solo stdlib** (sin deps — regla de Noel). Módulo `github.com/aiudalabs/fluxo/control`.

```
control/
  cmd/control/         binario (boot, health, shutdown grácil)
  internal/config/     config por env (CONTROL_ADDR, CONTROL_CORS_ORIGIN) — puro/testeable
  internal/httpapi/    HTTP: GET /healthz, GET /readyz (JSON), CORS de origen único
```

Correr: `go run ./cmd/control` (o `go build ./cmd/control`). Probar: `curl localhost:8080/healthz`.
Verificar: `go vet ./... && go test ./...`.

Subpaquetes esperados (fases próximas): `runtime/` (adaptadores, F4), `delivery/` (última milla, F8),
resolución de tenant (JWT→tenant_id). Tests primero. NO metodología, NO aislamiento a mano (eso es RLS).
