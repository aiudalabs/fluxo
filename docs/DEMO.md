# Demo funcional — Fluxo v2 (idea → diseño → board)

El arco completo, autónomo, contra Supabase local + el Agent SDK real. Muestra:
**escribo una idea → se crea el proyecto → el diseño se genera solo → apruebo los gates →
el backlog se publica al board.**

## 0. Prerrequisitos (una vez)
```bash
cd ~/projects/genai/fluxo
supabase start                 # Postgres + PostgREST + Realtime local (si no está arriba)
supabase db reset              # aplica migraciones (OJO: borra datos; re-seedear si querés Rosa)
(cd console && npm install && npm run dev)   # console en http://localhost:3000
```
El `.env` en la raíz ya tiene: `SUPABASE_*`, `CLAUDE_CODE_OAUTH_TOKEN`, y la GitHub App.

## 1. Prender el trigger automático (workflow lean para el demo)
En otra terminal:
```bash
cd ~/projects/genai/fluxo
set -a; source .env; set +a
# override a Supabase local por si el .env apunta a prod:
export SUPABASE_URL=http://127.0.0.1:54321
export SUPABASE_ANON_KEY="$(supabase status | awk '/anon key/{print $NF}')"
export SUPABASE_SERVICE_ROLE_KEY="$(supabase status | awk '/service_role key/{print $NF}')"
export SUPABASE_JWT_SECRET="$(supabase status | awk '/JWT secret/{print $NF}')"

node --experimental-strip-types design/src/watch.ts --workflow=demo-design
```
El poller queda escuchando. `demo-design` = 3 fases (Descubrimiento → PRD → Backlog) y 3
gates — ágil para demo. (Sin `--workflow` usa `design`, el completo de 8 fases.)

## 2. Crear un proyecto desde la UI
1. Abrí **http://localhost:3000**.
2. Escribí una idea (ej. *"Una app para reservar canchas de pádel por hora, con pago online y recordatorios"*), ponele nombre y repo, **Start the design**.
3. Aterrizás en el **Overview** del proyecto nuevo (vacío).

## 3. Ver el diseño generarse solo
- En ≤15s el poller lo detecta y arranca el diseño (lo ves en la terminal del watch).
- Andá al **Studio**: la fase **Descubrimiento** pasa a *running* y en ~30-60s aparece
  **BRIEF.md** generado por el agente, con el gate **Review** esperándote.

## 4. Aprobar los gates (Studio)
En cada fase, en el panel del gate: **Aprobar** (o *Responder preguntas* / *Pedir cambios*).
- Discovery ✓ → arranca **PRD** → aparece PRD.md → gate.
- PRD ✓ → arranca **Backlog** → aparece backlog.yaml → gate.
- **Backlog ✓ → el handoff publica el backlog** al board.

## 5. El board se llena
Andá al **Board**: las stories reales del backlog, con lane, sprint, ACs y dependencias.
También en **Flow** (Ciclo/Grafo) y **Overview** (progreso).

---

### Notas
- **Costo**: cada fase es una llamada real al Agent SDK (tokens). `demo-design` (3 fases) es
  el más barato; `design` (8) es el completo.
- **Reset del demo**: para empezar limpio, borrá el proyecto de prueba en la DB
  (`delete from projects where name = '<nombre>'`) — stories/sprints/design_runs se van con él
  (o límpialos aparte si no hay cascade).
- **Un proyecto = un design run**: el poller no re-arranca uno que ya tiene run.
- **Sandbox**: hoy el worker corre en el host (como en v1). Sandboxear los agentes de diseño
  es trabajo futuro.
