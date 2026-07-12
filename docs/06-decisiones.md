# 06 · Decisiones (ADR ligero)

Decisiones tomadas (✅) y abiertas (⚠️ — bloquean tareas del roadmap; no adivinar si tienen costo/lock-in irreversible).

## ✅ D0 · Rebuild, no refactor ni greenfield (2026-07-11)
La versión actual (aiuda-forge v1) se **rehace** sobre la arquitectura v2, **cargando el método** (registry, consola,
harnesses) y **reemplazando el sustrato** (store/conductor/scoping/tokens/canales → Postgres-RLS/Maestro/Vault/
Runtime×Provider). Razón: los bugs son arquitectónicos y recurren; no hay tenants de pago vivos; el activo valioso es
portable; el tiempo no es restricción. NO es el "trap del rewrite" porque lo bueno es portable y lo malo es
alquilable. Ejecución por strangler. (Ver auditoría aiuda-forge 2026-07-11 + `04-lecciones`.)

## ✅ D1 · Apuesta de plataforma del sustrato: **Supabase managed** (2026-07-11)
**Decidido: Supabase** (Postgres + RLS + Realtime + Auth GitHub-OAuth + Vault + Edge Functions) + **Vercel/CF** para
preview. Razón (análisis de costos): la comparación NO es "Supabase vs nuestra Postgres" — es **baterías alquiladas
vs baterías DIY**. RLS es de Postgres (gratis en cualquiera); el costo real son Auth/Realtime/Vault/Edge, que
self-hostear una Postgres pelada te obliga a **construir a mano** — exactamente la costura de auth + Vault-plaintext +
polling que la auditoría de v1 marcó como bugs (L-SEC-3, L-ARCH-4). El ahorro (~$25/mo Pro vs ~$0 en el VPS) es ruido
frente a las semanas de dev + ops que ahorra; matchea la tesis "casi cero infra bespoke".
**Salida futura (bajo lock-in de datos):** abajo es Postgres estándar → los datos son portables (pg_dump). El lock-in
está en las baterías. Reconsiderar self-host (Supabase OSS en el VPS, o Postgres+baterías propias) cuando haya
escala/ingresos que paguen el ops, o cuando Realtime/bandwidth sean una línea material. Mantener el schema como
Postgres+RLS estándar para que esa salida sea barata.

## ✅ D2 · Runtime SDK de los agentes de diseño: **Claude Agent SDK** (2026-07-12)
**Decidido: Claude Agent SDK** (el loop en el SDK, el rol en markdown → cumple "el agente vive en markdown").
Confirmado por el fundador. La versión/pineo se fija al llegar a **F5-01** (aún no se instala nada). No bloqueaba
F1-02: el tool MCP `brain_write` es protocolo abierto y se construyó/verificó standalone (cualquier cliente MCP lo
consume); el Agent SDK lo consumirá en F5.

## ⚠️ D3 · Alcance de la "última milla" en v1.0
¿La primera versión vendible incluye Fase 8 completa (tiendas + provisioning de infra del cliente) o corta en
"web publicada + app distribuida a link de prueba" y deja tiendas para v1.1? Afecta el corte de F8. A definir cuando
se llegue a Fase 7.

## ✅ D4 · Repo remoto / org: **github.com/aiudalabs/fluxo (privado)** (2026-07-12)
**Decidido:** el repo vive en `github.com/aiudalabs/fluxo`, **privado**. `origin` seteado, commits pusheados, CI
corriendo en Actions. El módulo Go `github.com/aiudalabs/fluxo/control` (elegido en F0-04) **coincide** con la org →
sin rename. Desde acá, el flujo puede pushear.
> **Pendiente menor (no bloqueante):** el flip del gate `db`/leak a **required check** en branch protection espera
> plan pago de GitHub. Por ahora la CI corre en cada push/PR y va **roja ante una fuga** (probado localmente que el
> stage `db` sale exit 1) — suficiente en trunk. Cuando haya branch protection, marcar `db` (y `control`) como
> required en `main`.

---
*Cuando una decisión se resuelve, moverla a ✅ con fecha y una línea de por qué, y desbloquear su tarea en el roadmap.*
