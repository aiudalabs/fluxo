-- F2-01 · The execution state model: sprints → stories → runs, plus an operational
-- events log. This is the state that v1 kept in SQLite and corrupted across tenants
-- (L-ARCH-1/3) or couldn't index (L-ARCH-5). v2 makes isolation impossible to skip:
--
--   * Every table carries tenant_id + project_id and RLS-scopes reads/writes to
--     auth.jwt()->>'tenant' — the DB rejects cross-tenant access (kills L-ARCH-1/3).
--   * Composite (project_id, id) foreign keys keep every reference inside one
--     project, so a run/event can never point at another project's story.
--   * Indexes on project_id (and status) replace v1's unindexed scans (L-ARCH-5).
--
-- The legal STATE TRANSITIONS (which status may follow which) are added in F2-02 as
-- a single enforced mutation point; here we only pin the allowed status *values*.

-- ── sprints ───────────────────────────────────────────────────────────────────
create table public.sprints (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  project_id uuid not null,
  key        text not null,
  title      text not null default '',
  position   int  not null default 0,
  created_at timestamptz not null default now(),
  unique (project_id, key),
  unique (project_id, id)   -- target for composite FKs below
);
create index sprints_project_idx on public.sprints (project_id);

-- ── stories ───────────────────────────────────────────────────────────────────
create table public.stories (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  project_id uuid not null,
  sprint_id  uuid,
  key        text not null,
  title      text not null default '',
  lane       text not null default '',
  status     text not null default 'backlog'
             check (status in ('backlog','ready','running','review','done','failed','blocked')),
  blocked_by uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, key),
  unique (project_id, id),
  foreign key (project_id, sprint_id) references public.sprints (project_id, id) on delete set null
);
create index stories_project_idx on public.stories (project_id);
create index stories_project_status_idx on public.stories (project_id, status);
create index stories_sprint_idx on public.stories (sprint_id);

-- ── runs ──────────────────────────────────────────────────────────────────────
create table public.runs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  project_id  uuid not null,
  story_id    uuid not null,
  runtime     text not null default '',
  provider    text not null default '',
  status      text not null default 'running'
              check (status in ('running','done','failed','lost')),
  session_ref text,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  unique (project_id, id),
  foreign key (project_id, story_id) references public.stories (project_id, id) on delete cascade
);
create index runs_project_idx on public.runs (project_id);
create index runs_story_idx on public.runs (story_id);
create index runs_project_status_idx on public.runs (project_id, status);

-- ── events (append-only operational log for the Maestro, F3) ───────────────────
create table public.events (
  id         bigint generated always as identity primary key,
  tenant_id  uuid not null,
  project_id uuid not null,
  story_id   uuid,
  run_id     uuid,
  kind       text not null,
  payload    jsonb not null default '{}'::jsonb,
  ts         timestamptz not null default now(),
  foreign key (project_id, story_id) references public.stories (project_id, id) on delete cascade,
  foreign key (project_id, run_id)   references public.runs    (project_id, id) on delete cascade
);
create index events_project_ts_idx on public.events (project_id, ts desc);
create index events_run_idx on public.events (run_id);
create index events_story_idx on public.events (story_id);

-- ── RLS: one tenant, one scope. Reads/writes are gated on the tenant claim; a
--    missing claim yields NULL and matches nothing (fail-closed). Writes flow
--    through the control plane as the tenant (RLS-enforced), so there is no
--    hand-rolled WHERE-by-tenant in Go (kills L-SEC-1/2/6, L-CQ-2 — see F2-03).
do $$
declare t text;
begin
  foreach t in array array['sprints','stories','runs','events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format($p$
      create policy %1$s_select_own_tenant on public.%1$I
        for select to authenticated
        using (tenant_id = (auth.jwt() ->> 'tenant')::uuid)
    $p$, t);
    execute format($p$
      create policy %1$s_insert_own_tenant on public.%1$I
        for insert to authenticated
        with check (tenant_id = (auth.jwt() ->> 'tenant')::uuid)
    $p$, t);
    execute format('revoke all on public.%I from anon', t);
  end loop;

  -- Mutable entities also get an UPDATE policy (both USING and WITH CHECK scoped);
  -- events is append-only, so it gets none.
  foreach t in array array['sprints','stories','runs'] loop
    execute format($p$
      create policy %1$s_update_own_tenant on public.%1$I
        for update to authenticated
        using (tenant_id = (auth.jwt() ->> 'tenant')::uuid)
        with check (tenant_id = (auth.jwt() ->> 'tenant')::uuid)
    $p$, t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
    execute format('revoke delete, truncate on public.%I from authenticated', t);
  end loop;

  grant select, insert on public.events to authenticated;
  revoke update, delete, truncate on public.events from authenticated;
end $$;

comment on table public.stories is 'Unit of work. Status transitions are enforced in F2-02. RLS-scoped by tenant.';
comment on table public.runs is 'An execution attempt of a story on a runtime×provider. RLS-scoped by tenant.';
comment on table public.events is 'Append-only operational event log consumed by the Maestro (F3). RLS-scoped.';
