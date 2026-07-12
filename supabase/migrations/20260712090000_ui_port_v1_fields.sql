-- F6P-02 · Campos que el UI de v1 muestra y el schema v2 aún no tenía (para el port 100%).
-- stories: la card/detalle del board de v1 usan estos. sprints: el /flow Ciclo usa las ceremonias.
-- epics: el New-Story modal + el eyebrow del detalle. Todo aditivo, nullable; RLS ya aplica por tenant.

alter table stories
  add column if not exists body text,
  add column if not exists acceptance text,
  add column if not exists run_id text,
  add column if not exists epic_id text,
  add column if not exists pr_url text,
  add column if not exists session_url text,
  add column if not exists external_ref text,
  add column if not exists repo text,
  add column if not exists kind text not null default 'story',
  add column if not exists screen_key text,
  add column if not exists agent_lost text;

alter table sprints
  add column if not exists goal text,
  add column if not exists planned_at timestamptz,
  add column if not exists planning_run_id uuid,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_run_id uuid,
  add column if not exists retro_at timestamptz,
  add column if not exists retro_run_id uuid;

create table if not exists epics (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  project_id uuid not null,
  key text,
  title text,
  created_at timestamptz not null default now()
);
alter table epics enable row level security;
drop policy if exists epics_tenant on epics;
create policy epics_tenant on epics
  using (tenant_id = (auth.jwt() ->> 'tenant')::uuid)
  with check (tenant_id = (auth.jwt() ->> 'tenant')::uuid);
