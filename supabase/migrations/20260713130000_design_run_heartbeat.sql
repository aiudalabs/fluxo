-- Opción B (crash-resume) · heartbeat/lease del run de diseño. main.ts renueva heartbeat_at
-- cada ~30s mientras vive (incluso bloqueado en un gate congelado, porque el poll cede al
-- event loop). El worker re-adopta un run como HUÉRFANO solo si su heartbeat está VENCIDO
-- (>90s): así distingue "proceso muerto" (worker/máquina reiniciada, hijo caído) de "fase
-- larga o gate congelado con proceso VIVO" — sin este lease, al reiniciar el worker se
-- duplicaría un main.ts que sobrevivió (spawn no-detached no muere con el padre).
alter table public.design_runs
  add column if not exists heartbeat_at timestamptz not null default now();
