# 09 · Manual de usuario

Cómo operar Fluxo — de una idea a software mergeado, gobernado y trazable. Para el **operador de la
fábrica** (agencia / dev-shop). No cubre instalación (ver `08-instalacion-y-config.md`).

> **La tesis en una línea:** vos describís el trabajo y aprobás las decisiones; el sistema diseña el
> backlog, despacha agentes al GitHub del cliente, y proyecta todo de vuelta a un board trazable. El
> determinismo está donde el error es barato (identidad, aislamiento, estados); el juicio (diseño,
> código, review) lo hacen agentes.

---

## 0. Conceptos

| Término | Qué es |
|---|---|
| **Proyecto** | Un producto/cliente. Tiene un repo de GitHub, un backlog y un *brain*. |
| **Studio** | Donde se diseña: la idea recorre fases (discovery → PRD → schema → UI → arquitectura → backlog) con **gates**. |
| **Gate** | Un punto de aprobación humana entre fases: *Aprobar · Responder preguntas · Pedir cambios*. |
| **Story / Sprint** | La unidad de trabajo. Un sprint agrupa stories; se despacha entero (1 PR cierra todas). |
| **Board** | El kanban: `backlog → ready → running → en review → done` (+ `failed`). |
| **Conductor** | El worker que despacha, proyecta (GitHub=verdad), aprueba workflows y auto-mergea. |
| **Brain** | El registro append-only de todo lo que pasó (diseño, decisiones, versiones) — auditable. |
| **Registry** | El *método*: los agents/skills/workflows/templates que se usan, y el prompt exacto por corrida. |

---

## 1. Crear un proyecto

1. **Entrá con GitHub** (arriba a la derecha). Fluxo actúa como vos.
2. **Nuevo proyecto**: nombre + elegí la **cuenta/org** y el **repo** (nuevo o existente).
   - ⚠️ La cuenta/org tiene que tener la **App de Fluxo instalada** — si no, el proyecto no se puede
     materializar. Fluxo te muestra el link de instalación en el momento (no te deja crear a ciegas).
3. Fluxo crea el repo (si es nuevo) y lo *scaffoldea*: instala los workflows de agente/review/QA.

---

## 2. Diseñar en el Studio

1. Abrí **Studio** y escribí la **idea** ("¿Qué querés construir?").
2. El motor de diseño corre las fases. **Cada fase congela en un gate** hasta que lo resolvés:
   - **Aprobar** → sigue a la próxima fase.
   - **Responder preguntas** → el agente te pregunta lo que le falta; respondés y sigue.
   - **Pedir cambios** → re-corre la fase con tu feedback.
3. El resultado de cada fase es un **documento versionado** en el brain (PRD, schema, UI, arquitectura).
4. La última fase produce el **backlog**: épicas → sprints → stories con criterios de aceptación y deps.

> Podés ver todas las versiones de cada doc en el **Brain** (chips vN) — cada una rinde su contenido real.

---

## 3. Publicar el backlog → Issues

Cuando el backlog está aprobado, se **publica al repo del cliente**: cada story se espeja como un
**Issue** de GitHub, con el grafo de dependencias (`blocked_by`). Desde acá el board opera sobre issues reales.

---

## 4. Configurar la autonomía (Settings)

**Settings → Autonomía** define cómo despacha el conductor:

| Setting | Opciones | Qué hace |
|---|---|---|
| `execution_unit` | `story` / `sprint` | Despachar una story, o un **sprint entero** (1 run → 1 PR que cierra todas sus issues). |
| `dispatch_mode` | `manual` / `auto` | `manual` = vos clickeás ▶ en el board · `auto` = el worker despacha solo por tick. |
| `merge_mode` | `manual` / `auto` | `manual` = vos mergeás el PR · `auto` = el conductor mergea si pasa el gate. |
| `workflow_approval` | `off` / `auto_if_safe` | `auto_if_safe` = auto-aprueba los runs `action_required` **salvo** que el diff toque `.github/workflows/**`. |
| `max_concurrency` | número | Cuántas unidades en vuelo a la vez. |

**Settings → Canal de build**: pegá el `CLAUDE_CODE_OAUTH_TOKEN` **rotado** (generalo con
`claude setup-token`) — se siembra como Actions secret del repo (BYO, **nunca se guarda en Fluxo**).
El probe pasa a 🟢 cuando el canal está listo.

---

## 5. Despachar y monitorear (el loop)

### El board (kanban)
- Las stories con **deps cumplidas y despachables** aparecen en la columna **Ready** con el botón **▶**.
  (Las que están en Backlog esperan deps / cupo / gate cross-sprint.)
- **Click ▶ Despachar** → la unidad salta a **running** (marca running *antes* de disparar = nunca
  doble-run pago) y arranca el agente en las Actions del cliente.
- También podés despachar desde el **drawer** del ticket (mismo botón).

### La vista Agentes
- **Sesiones activas** (running) con link "ver sesión".
- **Cola de PRs** (en review).
- **Aprobar workflow**: si un run quedó `action_required`, lo aprobás desde acá (el guard de
  `.github/workflows/**` aplica igual — un PR que toca workflows no se aprueba con un click).

### Qué esperar, en orden
```
backlog → ready → (▶) running → (PR abierto) en review → (merge) done → desbloquea el próximo
```
1. Clickeás ▶ → **running**.
2. El agente implementa y abre un **PR** (`Closes #N`).
3. La **proyección** (worker) mueve la story a **en review** (+ pr_url).
4. `claude-review` revisa el PR contra los criterios de aceptación.
5. Mergeás el PR (o el conductor lo hace si `merge_mode=auto`).
6. El issue cierra → la proyección marca **done** → el próximo sprint/story gana su ▶.

---

## 6. Ver el método (Registry) y el gasto (Spend)

- **Registry** → qué agents/skills/workflows/templates se usan, y la solapa **"Por corrida"** te
  muestra **el prompt exacto** que se le manda al engine por sprint/story. (Útil para debug: si un run
  sale raro, mirás acá qué recibió.)
- **Spend** → el **costo real por run** (usd + tokens) que el conductor captura del run. Total
  acumulado + tabla por run. *(Se captura desde el primer run que corra con el paso de reporte de costo.)*

---

## 7. Auto-merge de verdad: branch protection

Para que el gate del reviewer **bloquee** el auto-merge (y no mergee un PR sin revisar), el repo del
cliente necesita **branch protection** en `main`:
- **Require pull request review** + **Require status checks** (los jobs de `claude-review` y `suite-integrity`).

> Sin branch protection, `merge_mode=auto` podría mergear un PR `CLEAN` antes de que corra el reviewer.
> El predicado del conductor es correcto; el *enforcement* real lo da la branch protection.

---

## 8. Cuando algo sale mal (recuperación)

- **Agente perdido / run vacío**: si un run termina sin producir trabajo, el conductor lo detecta
  (label `agent:failed` / histéresis) y **devuelve la story a backlog** para re-despachar — no queda
  trabada. El drawer muestra el motivo; el botón **Recuperar** la confirma lista.
- **Story `failed`**: reencolable desde el drawer (transición legal → vuelve a ready).
- **Borrar una story**: desde el drawer (destructivo, con confirmación; bloquea si otras dependen de ella).

---

## 9. Ciclo continuo (change requests)

Un proyecto **vivo** puede recibir nuevos briefs: se re-entra al Studio con un *change request* y el
motor produce un **delta backlog** (nuevos sprints/stories sobre lo ya existente), sin re-planear todo.
*(Fase de roadmap; ver `03-roadmap.md`.)*

---

## 10. Reglas de oro para el operador

1. **Empezá barato**: una story (o SP1), `merge_mode=manual`, `max_concurrency=1`. Recién después
   sprint-mode / auto-merge.
2. **El dispatch cuesta plata** (dispara un agente real en las Actions). El ▶ es tuyo.
3. **Rotá el token del canal** — nunca reuses uno que apareció en un chat/log.
4. **Branch protection** antes de confiar en el auto-merge.
5. **GitHub es la verdad**: el board refleja lo que pasó en el repo (proyección), no al revés.
```
