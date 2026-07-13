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

## 1. Correr Fluxo (console + WORKER)
El **worker** es lo que hace que "crear proyecto → arranca el diseño" funcione. Sin él, un
proyecto nuevo queda inerte. La forma correcta de correr Fluxo local levanta ambos:
```bash
cd ~/projects/genai/fluxo
WORKFLOW=demo-design ./scripts/dev.sh    # console (:3000) + worker, workflow lean (demo)
# ./scripts/dev.sh                        # workflow de diseño completo (8 fases)
```
`demo-design` = 3 fases (Descubrimiento → PRD → Backlog) y 3 gates — ágil/barato para demo.

> Solo el worker (si el console ya corre aparte): `cd design && npm run worker -- --workflow=demo-design`
> El worker reconcilia por tick: proyecto nuevo (sin design_run ni stories) → diseño; story
> `ready` → build. Es infra backend; en prod es un servicio desplegado, no un script manual.

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

## 5. El board se llena — Y el repo se crea
Al aprobar el **backlog gate**, el handoff:
- publica las stories al **Board** (lane, sprint, ACs, dependencias) — también visible en **Flow** y **Overview**.
- **crea el repo en GitHub** (`aiudalabs/<slug>`), **commitea los docs de diseño** (BRIEF/PRD/backlog…)
  y **abre un issue por story** (título `[S1-01] …`, labels lane+sprint, body con ACs + deps).
- reconcilia `project.repo` + `story.external_ref` (`github:owner/repo#N`) → el board/drawer linkean al issue real.

Requiere la GitHub App con **Administration + Contents + Issues: write** y credenciales en `.env`
(`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`). Sin ellas, el handoff degrada con gracia: publica
solo al board. Verificado en vivo: `github.com/aiudalabs/fluxo-demo-padel` (repo + 3 docs + 4 issues).

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
