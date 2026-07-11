# 06 · Decisiones (ADR ligero)

Decisiones tomadas (✅) y abiertas (⚠️ — bloquean tareas del roadmap; no adivinar si tienen costo/lock-in irreversible).

## ✅ D0 · Rebuild, no refactor ni greenfield (2026-07-11)
La versión actual (aiuda-forge v1) se **rehace** sobre la arquitectura v2, **cargando el método** (registry, consola,
harnesses) y **reemplazando el sustrato** (store/conductor/scoping/tokens/canales → Postgres-RLS/Maestro/Vault/
Runtime×Provider). Razón: los bugs son arquitectónicos y recurren; no hay tenants de pago vivos; el activo valioso es
portable; el tiempo no es restricción. NO es el "trap del rewrite" porque lo bueno es portable y lo malo es
alquilable. Ejecución por strangler. (Ver auditoría aiuda-forge 2026-07-11 + `04-lecciones`.)

## ⚠️ D1 · Apuesta de plataforma del sustrato (BLOQUEA F1+)
**Recomendado (default de trabajo): Supabase** (Postgres + RLS + Realtime + Auth GitHub-OAuth + Vault + Edge Functions)
+ **Vercel/CF** para preview. Razón: es literalmente "el sustrato alquilado" del principio; RLS+Realtime hacen el
aislamiento y la proyección sin código; ya existe el stack profile `react-supabase` (dogfooding). Reversible-ish
(Postgres es Postgres; Vercel↔CF).
**Alternativa:** Postgres self-host + auth/realtime/vault propios (menos lock-in, más código — contradice "casi cero
infra"). **Estado:** a CONFIRMAR por el fundador antes de F1-01. Si no hay objeción, se procede con Supabase.

## ⚠️ D2 · Runtime SDK de los agentes de diseño
Recomendado: **Claude Agent SDK** (el loop en el SDK, el rol en markdown → cumple "el agente vive en markdown").
Confirmar versión/pineo antes de F5-01.

## ⚠️ D3 · Alcance de la "última milla" en v1.0
¿La primera versión vendible incluye Fase 8 completa (tiendas + provisioning de infra del cliente) o corta en
"web publicada + app distribuida a link de prueba" y deja tiendas para v1.1? Afecta el corte de F8. A definir cuando
se llegue a Fase 7.

## ⚠️ D4 · Repo remoto / org
¿Dónde vive este repo (github.com/aiudalabs/fluxo? privado?) y con qué billing? Necesario antes del primer push.

---
*Cuando una decisión se resuelve, moverla a ✅ con fecha y una línea de por qué, y desbloquear su tarea en el roadmap.*
