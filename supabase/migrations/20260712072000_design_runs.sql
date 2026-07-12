-- F6-02 · Design-run state: the pipeline the Studio renders and the human gates live in.
--
-- The design engine (F5-04, design/src/engine.ts) is pure orchestration over injected
-- ports. This is the state those ports read/write so the whole thing is projected to the
-- Studio by Realtime (RLS + Realtime, no bespoke backend — same shape as board/brain):
--
--   design_runs   — one row per design run of a project (its status).
--   design_phases — one row per phase (discovery, prd, …); carries the HARVESTED
--                   artifacts (workdir-harvest, D5) so Studio can show docs/mockups.
--   design_gates  — one row per gate ask; CONVERSATIONAL (F5-04): the human resolves it
--                   with approve / revise+feedback / answers to the open questions. The
--                   orchestrator waits on status flipping to 'resolved'.
--
-- Isolation is identical to the state schema (F2-01): tenant_id + project_id on every
-- table, RLS scoped to auth.jwt()->>'tenant' (fail-closed on a missing claim), composite
-- (project_id, id) FKs so a phase/gate can never point at another project's run.

-- ── design_runs ───────────────────────────────────────────────────────────────
create table public.design_runs (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  project_id uuid not null,
  workflow   text not null default 'design',
  status     text not null default 'running'
             check (status in ('running','awaiting_gate','awaiting_handoff','done','failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, id)
);
create index design_runs_project_idx on public.design_runs (project_id, created_at desc);

-- ── design_phases ─────────────────────────────────────────────────────────────
create table public.design_phases (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  project_id uuid not null,
  run_id     uuid not null,
  phase_id   text not null,
  label      text not null default '',
  ord        int  not null default 0,
  status     text not null default 'pending'
             check (status in ('pending','running','awaiting_gate','done','failed')),
  -- Harvested artifacts: [{ "path": "docs/BRIEF.md", "kind": "doc", "content": "…" }].
  -- The brain holds the durable audit copy (kind=artifact); this is the render copy.
  artifacts  jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, id),
  unique (run_id, phase_id),
  foreign key (project_id, run_id) references public.design_runs (project_id, id) on delete cascade
);
create index design_phases_run_idx on public.design_phases (run_id, ord);
create index design_phases_project_idx on public.design_phases (project_id);

-- ── design_gates ──────────────────────────────────────────────────────────────
create table public.design_gates (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  project_id     uuid not null,
  run_id         uuid not null,
  phase_id       text not null,      -- the phase this gate guards
  gate_id        text not null,      -- e.g. discovery_gate
  reason         text not null default '',
  open_questions jsonb not null default '[]'::jsonb,   -- string[] surfaced from the doc
  attempt        int  not null default 1,
  status         text not null default 'pending' check (status in ('pending','resolved')),
  outcome        text check (outcome in ('approve','revise')),  -- null until resolved
  feedback       text,
  answers        jsonb,              -- [{ "q": "...", "a": "..." }]
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz,
  unique (project_id, id),
  foreign key (project_id, run_id) references public.design_runs (project_id, id) on delete cascade
);
create index design_gates_run_idx on public.design_gates (run_id, created_at desc);
create index design_gates_pending_idx on public.design_gates (project_id, status);

-- ── RLS: tenant-scoped select/insert/update on all three (fail-closed). The
--    orchestrator writes runs/phases and inserts gates as the tenant; Studio updates
--    phases' status and RESOLVES gates as the tenant. Append-only isn't wanted here
--    (a gate row is mutated in place on resolve), but delete/truncate stay revoked.
do $$
declare t text;
begin
  foreach t in array array['design_runs','design_phases','design_gates'] loop
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
    execute format($p$
      create policy %1$s_update_own_tenant on public.%1$I
        for update to authenticated
        using (tenant_id = (auth.jwt() ->> 'tenant')::uuid)
        with check (tenant_id = (auth.jwt() ->> 'tenant')::uuid)
    $p$, t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
    execute format('revoke delete, truncate on public.%I from authenticated', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- ── Realtime: Studio subscribes to all three (tenant-isolated by RLS). replica
--    identity full so UPDATEs (status flips, gate resolutions) carry the changed row.
alter table public.design_runs   replica identity full;
alter table public.design_phases replica identity full;
alter table public.design_gates  replica identity full;
alter publication supabase_realtime add table public.design_runs;
alter publication supabase_realtime add table public.design_phases;
alter publication supabase_realtime add table public.design_gates;

comment on table public.design_runs   is 'One design run per project. RLS-scoped by tenant. Projected to Studio by Realtime.';
comment on table public.design_phases is 'A design phase + its harvested artifacts (workdir-harvest, D5). RLS-scoped.';
comment on table public.design_gates  is 'A conversational human gate (F5-04): approve / revise+feedback / answer open questions. RLS-scoped.';
