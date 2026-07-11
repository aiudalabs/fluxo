# registry/ — EL MÉTODO como data

Todo lo que Fluxo aplica a los proyectos de los clientes, como **datos y markdown** (nunca en Go). Se **carga de
aiuda-forge v1** casi intacto (F0-05) y se limpia para v2.

```
agents/       roles (analyst, pm, architect, ux, scrum-master, dev, reviewer, art-director, …) — .md + .yaml
skills/       capacidades reutilizables (incl. la NUEVA `brain-write`)
workflows/    ceremonias como data (design, sprint-planning, review, retro, release, iterate)
templates/    lo que se scaffoldea en el repo del cliente (.github/, verify harnesses) por stack
stacks/       perfiles de stack (aiuda-flutter-firebase, python-fastapi-react, react-supabase)
providers/    NUEVO: canales de ejecución como data (claude.yaml, copilot.yaml, …) — ver docs/02
```

Regla de oro: si estás por escribir un `if` sobre metodología en Go, va acá en su lugar.
