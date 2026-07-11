# control/ — pegamento Go mínimo

El plano de control: API HTTP, resolución de tenant (JWT→tenant_id), y el **dispatch a la capa de runtime**
(interfaz `Runtime`, ver `docs/02-capa-runtime.md`). Objetivo: **lo más delgado posible** — casi todo el estado y el
aislamiento viven en Postgres+RLS; la reconciliación en Edge Functions (Maestro). Aquí NO va metodología (regla de
oro) ni lógica de aislamiento a mano (eso es RLS).

Se crea en F0-04. Subpaquetes esperados: `runtime/` (adaptadores), `delivery/` (última milla). Tests primero.
