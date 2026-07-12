# registry/ — EL MÉTODO como data

Todo lo que Fluxo aplica a los proyectos de los clientes, como **datos y markdown** (nunca en Go). Se **carga de
aiuda-forge v1** casi intacto (F0-05) y se limpia para v2.

```
agents/       roles (analyst, pm, architect, ux, scrum-master, dev, reviewer, art-director, …) — .md + .yaml
skills/       capacidades reutilizables (la NUEVA `brain-write` llega en F1-02)
workflows/    ceremonias como data (design, sprint-planning, review, retro, release, iterate)
templates/    lo que se scaffoldea en el repo del cliente (.github/, verify harnesses) por stack
stacks/       (pendiente) perfiles de stack — hoy viven como variantes en templates/github-native/<perfil>
providers/    ✅ canales de ejecución como data (claude.yaml, copilot.yaml) — ver docs/02; los carga `control/internal/runtime`
methods/      ✅ (F5-02) jerarquía de backlog + gates como data (scrum.yaml, kanban.yaml) — los carga `control/internal/method`
```

Regla de oro: si estás por escribir un `if` sobre metodología en Go, va acá en su lugar.

## Cargado de v1 (F0-05)

Copiado **verbatim** de `aiuda-forge/engine/registry` (auditado 2026-07-11): `agents/`, `skills/`, `workflows/`,
`templates/`. NO se copió `backends/` (los canales de v1) — su esquema v2 es distinto y lo (re)define **F4-02** en
`providers/`. NO hay `stacks/` como dir aún: en v1 los perfiles de stack son las variantes de
`templates/github-native/` (`aiuda-flutter-firebase`, `python-fastapi-react`, `react-supabase`); extraer un `stacks/`
dedicado se difiere a cuando una fase lo necesite (no se inventa ahora).

**Validación:** `python3 registry/validate.py` (requiere PyYAML) — parsea todo YAML, exige `id` top-level, verifica
el par `.md`+`.yaml` por agente y `steps` no vacío por workflow. Verde = registry sano. Corre en CI (F0-03).
