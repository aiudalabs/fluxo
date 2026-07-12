-- F5-P1 · projects — la tabla que faltaba: hasta ahora el proyecto dev vivía en una env
-- var (NEXT_PUBLIC_DEV_PROJECT_ID) + un JWT pre-minteado. Esto la hace real: el `/` entry
-- inserta una fila acá, la lista de proyectos la lee, y el resto del schema (stories/
-- sprints/design_runs/brain_events) ya referencia project_id.
--
-- Isolation idéntica al resto (F1-01/F2-01): tenant_id en cada fila, RLS scopeada a
-- auth.jwt()->>'tenant' (fail-closed si falta el claim). owner_id = el usuario que lo creó
-- (auth.uid()); nullable mientras el auth real (GitHub OAuth) no exista — el dev-shim no
-- tiene un user real, solo el tenant.

create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  owner_id    uuid,                       -- auth.uid() del creador; null en el dev-shim
  name        text not null,
  description text,
  org         text,                       -- owner/org de GitHub (ej. "aiudalabs")
  repo        text,                       -- URL https del repo; null hasta que se cree
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index projects_tenant_idx on public.projects (tenant_id, created_at desc);

-- El cliente NUNCA setea tenant_id: sale por default del claim `tenant` del JWT (mismo
-- valor que exige el RLS with-check). Así un insert desde el browser no puede forjar otro
-- tenant ni necesita conocer su propio tenant_id.
alter table public.projects alter column tenant_id set default (auth.jwt() ->> 'tenant')::uuid;

alter table public.projects enable row level security;

-- El cliente lee/crea/actualiza solo lo de su tenant (fail-closed). No delete/truncate.
create policy projects_select_own_tenant on public.projects
  for select to authenticated
  using (tenant_id = (auth.jwt() ->> 'tenant')::uuid);
create policy projects_insert_own_tenant on public.projects
  for insert to authenticated
  with check (tenant_id = (auth.jwt() ->> 'tenant')::uuid);
create policy projects_update_own_tenant on public.projects
  for update to authenticated
  using (tenant_id = (auth.jwt() ->> 'tenant')::uuid)
  with check (tenant_id = (auth.jwt() ->> 'tenant')::uuid);

grant select, insert, update on public.projects to authenticated;
revoke delete, truncate on public.projects from authenticated;
revoke all on public.projects from anon;

-- Realtime: la lista de proyectos se actualiza sola cuando se crea uno.
alter table public.projects replica identity full;
alter publication supabase_realtime add table public.projects;

comment on table public.projects is 'Proyectos del tenant. RLS-scoped. El `/` entry inserta; la lista los lee. F5-P1.';

-- Seed: el proyecto dev "Rosa la peluquería" como fila real (antes solo env var), para
-- que las vistas existentes sigan andando y tengan un nombre real que leer.
insert into public.projects (id, tenant_id, name, description, org, repo)
values (
  'd1d1d1d1-0000-0000-0000-0000000000f1',
  'd1d1d1d1-0000-0000-0000-0000000000a1',
  'Rosa la peluquería',
  'Una app donde la clienta reserva sola y Rosa administra su agenda — con recordatorios por WhatsApp y seña online.',
  'aiudalabs',
  null
)
on conflict (id) do nothing;
