# console/ — UI (Next.js, vista sobre el brain)

Lee Supabase directo (RLS + Realtime) — casi sin backend propio. Se **porta de aiuda-forge** (flow, studio, tickets,
statusToken, el diagrama del ciclo) re-apuntando el data-layer a Supabase.

Superficies: **board + grafo de deps con click-para-despachar**, **Studio** (pipeline de diseño gateado, que al
publicar el backlog **linkea a ejecución** — no se queda mudo, L-UX-1), **brain explorer** (timeline auditable +
trail requisito→issue→PR), **preview embebido**, **gates conversacionales**. i18n es/en, español-first.

Se construye en Fase 6 (con un brain explorer mínimo ya en F1-04).

## Estado (F1-04 ✅ — brain explorer mínimo)

Next.js 15 (App Router, TS) + `@supabase/supabase-js`. Ruta `/brain/[projectId]`: timeline por proyecto que lee
`brain_events` **directo de Supabase con RLS + Realtime** (sin backend propio). Nuevos appends (p. ej. de `brain-mcp`)
aparecen sin polling (mata L-ARCH-4).

**Dev-shim de auth (temporal):** hasta que exista el login real (GitHub OAuth → JWT con claim `tenant`), el cliente
usa un JWT de tenant pre-minteado vía `NEXT_PUBLIC_DEV_TENANT_JWT` (para REST y para `realtime.setAuth`). Cuando llegue
la auth real, esa var y el shim desaparecen y se usa la sesión del usuario.

```bash
cp .env.local.example .env.local        # completá URL + anon key
node scripts/mint-dev-jwt.mjs <tenant-uuid>   # → NEXT_PUBLIC_DEV_TENANT_JWT (SUPABASE_JWT_SECRET en env)
npm install && npm run dev              # http://localhost:3000/brain/<project-uuid>
```

Verificación del data-path (RLS + Realtime, mismo cliente que la UI): `node scripts/verify-brain.mjs`.

