-- run_costs — costo por run del conductor (F-spend). claude-code-action emite modelUsage/costUSD;
-- el claude.yml lo suma y postea un comentario con el marcador <!-- fluxo:cost {...} --> en el
-- primer issue del run. El worker parsea ese comentario y hace UPSERT acá (idempotente por run_id).
-- El tenant lo LEE por RLS; el worker ESCRIBE con service_role (path de sistema). Un run = una fila.
create table if not exists public.run_costs (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  project_id        uuid not null references public.projects(id) on delete cascade,
  run_id            text not null,
  issues            text,
  usd               numeric(12,6) not null default 0,
  input_tokens      bigint not null default 0,
  output_tokens     bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  created_at        timestamptz not null default now(),
  unique (project_id, run_id)
);

alter table public.run_costs enable row level security;
revoke all on public.run_costs from anon, authenticated;
grant select on public.run_costs to authenticated;

create index if not exists run_costs_project_idx on public.run_costs (project_id, created_at desc);

-- RLS: cada tenant ve SOLO sus costos (mismo claim que projects). Las escrituras son del worker
-- (service_role, que bypassa RLS) — no hay policy de insert para authenticated a propósito.
create policy run_costs_select_own_tenant on public.run_costs
  for select to authenticated
  using (tenant_id = (auth.jwt() ->> 'tenant')::uuid);

alter publication supabase_realtime add table public.run_costs;

comment on table public.run_costs is 'Costo por run del conductor (usd + tokens), parseado del comentario fluxo:cost. RLS por tenant; escribe el worker (service_role). F-spend.';
