-- F1-01 · brain_events — the append-only, multi-tenant audit log (the "brain").
--
-- This is the moat (docs/00-vision): every decision, gate answer, rejected design
-- and provenance link is appended here and never mutated. Isolation is RLS, in one
-- place (golden rule 3); there is no hand-rolled WHERE-by-tenant anywhere in Go.
--
-- Kills L-ARCH-1 (cross-tenant read/write) by construction:
--   * RLS scopes every row to auth.jwt()->>'tenant'. A missing claim yields NULL,
--     which matches no row — fail-closed.
--   * Append-only: `authenticated` is granted only SELECT + INSERT. UPDATE/DELETE
--     are neither granted nor policied, so a client cannot tamper with history.
--   * `service_role` (backend) has BYPASSRLS by Supabase default and writes via
--     the control plane / Edge Functions — never the browser.

create table public.brain_events (
  id         bigint generated always as identity primary key,
  tenant_id  uuid        not null,
  project_id uuid        not null,
  kind       text        not null,
  payload    jsonb       not null default '{}'::jsonb,
  actor      text        not null,
  ts         timestamptz not null default now()
);

comment on table public.brain_events is
  'Append-only multi-tenant audit log (the brain). RLS-scoped by tenant claim. F1-01.';

-- Timeline reads are always scoped to a project within a tenant, newest first.
create index brain_events_tenant_project_ts_idx
  on public.brain_events (tenant_id, project_id, ts desc);

alter table public.brain_events enable row level security;

-- The only two verbs a client may perform, each scoped to its own tenant. The
-- SELECT policy makes another tenant's rows literally unreadable; the INSERT
-- WITH CHECK makes forging a row under another tenant impossible.
create policy brain_events_select_own_tenant
  on public.brain_events
  for select
  to authenticated
  using (tenant_id = (auth.jwt() ->> 'tenant')::uuid);

create policy brain_events_insert_own_tenant
  on public.brain_events
  for insert
  to authenticated
  with check (tenant_id = (auth.jwt() ->> 'tenant')::uuid);

-- Append-only + least privilege: authenticated gets SELECT/INSERT only; anon gets
-- nothing (the brain is never public). Explicit REVOKE of UPDATE/DELETE/TRUNCATE
-- defends against any permissive default-privilege grant.
revoke all on public.brain_events from anon;
grant select, insert on public.brain_events to authenticated;
revoke update, delete, truncate on public.brain_events from authenticated;
