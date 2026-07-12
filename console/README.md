# console/ — UI (Next.js, vista sobre el brain)

Lee Supabase directo (RLS + Realtime) — casi sin backend propio. Se **porta de aiuda-forge** (flow, studio, tickets,
statusToken, el diagrama del ciclo) re-apuntando el data-layer a Supabase.

Superficies: **board + grafo de deps con click-para-despachar**, **Studio** (pipeline de diseño gateado, que al
publicar el backlog **linkea a ejecución** — no se queda mudo, L-UX-1), **brain explorer** (timeline auditable +
trail requisito→issue→PR), **preview embebido**, **gates conversacionales**. i18n es/en, español-first.

Se construye en Fase 6 (con un brain explorer mínimo ya en F1-04).

## Convención de rutas — **project-first** (no re-litigar)

La IA es **project-first**: estás *dentro de un proyecto* y cambiás de vista, no al revés.

```
app/projects/page.tsx                       ← lista / switcher de proyectos
app/projects/[projectId]/layout.tsx         ← contexto del proyecto UNA vez:
                                              cliente supabase + tenant token (realtime.setAuth) + nav
app/projects/[projectId]/studio/page.tsx    (+ Studio.tsx co-locado)
app/projects/[projectId]/board/page.tsx     (+ Board.tsx)
app/projects/[projectId]/brain/page.tsx     (+ BrainExplorer.tsx)
```

- El **layout de proyecto** (`lib/project.tsx` · `ProjectShell`) es el ÚNICO lugar que arma el contexto: crea el
  cliente supabase y **arma el tenant token en el socket de realtime una sola vez**. Las features leen el cliente de
  `useProject()` y **no re-arman** nada — solo renderizan su superficie para `projectId`.
- Patrón: `page.tsx` + Componente co-locado (una feature = una carpeta bajo `[projectId]/`).
- La URL lleva el estado: `http://localhost:3000/projects/<uuid>/{studio|board|brain}`.

## Estado (F1-04 ✅ — brain explorer mínimo)

Next.js 15 (App Router, TS) + `@supabase/supabase-js`. Ruta `/projects/[projectId]/brain`: timeline por proyecto que
lee `brain_events` **directo de Supabase con RLS + Realtime** (sin backend propio). Nuevos appends (p. ej. de
`brain-mcp`) aparecen sin polling (mata L-ARCH-4).

**Dev-shim de auth (temporal):** hasta que exista el login real (GitHub OAuth → JWT con claim `tenant`), el cliente
usa un JWT de tenant pre-minteado vía `NEXT_PUBLIC_DEV_TENANT_JWT` (para REST y para `realtime.setAuth`). Cuando llegue
la auth real, esa var y el shim desaparecen y se usa la sesión del usuario.

```bash
cp .env.local.example .env.local        # completá URL + anon key
node scripts/mint-dev-jwt.mjs <tenant-uuid>   # → NEXT_PUBLIC_DEV_TENANT_JWT (SUPABASE_JWT_SECRET en env)
npm install && npm run dev              # http://localhost:3000/projects/<project-uuid>/brain
```

Verificación del data-path (RLS + Realtime, mismo cliente que la UI): `node scripts/verify-brain.mjs`.

