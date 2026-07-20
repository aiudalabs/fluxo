-- P5-2 · Cola de CHANGE-REQUESTS (pedir un incremento: "agregá X al producto ya construido").
-- El motor ya existe (registry/workflows/iterate.yaml + agente iteration-planner: lee el backlog
-- existente → emite un DELTA de sprints/stories NUEVOS; el handoff los APPENDea). Falta el disparador:
-- el USUARIO encola un pedido (instructions), el WORKER lo levanta y spawnea main.ts con
-- --workflow=iterate. Esta tabla es la cola.
--
-- RLS: el tenant INSERTA (crea el pedido) y LEE (ve el estado). El worker ACTUALIZA el status con
-- service_role (bypassa RLS) — no hay policy de update para authenticated a propósito.
create table if not exists public.increment_requests (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  project_id   uuid not null references public.projects(id) on delete cascade,
  instructions text not null,
  status       text not null default 'pending' check (status in ('pending','running','done','failed')),
  run_id       uuid,     -- el design_run (iterate) que el worker creó para este pedido
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.increment_requests enable row level security;
revoke all on public.increment_requests from anon, authenticated;
grant select, insert on public.increment_requests to authenticated;

create index if not exists increment_requests_project_idx on public.increment_requests (project_id, status, created_at desc);

create policy increment_select_own_tenant on public.increment_requests
  for select to authenticated
  using (tenant_id = (auth.jwt() ->> 'tenant')::uuid);

create policy increment_insert_own_tenant on public.increment_requests
  for insert to authenticated
  with check (tenant_id = (auth.jwt() ->> 'tenant')::uuid);

alter publication supabase_realtime add table public.increment_requests;

comment on table public.increment_requests is 'Cola de change-requests (P5-2). El tenant encola (instructions); el worker levanta pending → spawn main.ts --workflow=iterate. RLS por tenant; el worker actualiza status con service_role.';
