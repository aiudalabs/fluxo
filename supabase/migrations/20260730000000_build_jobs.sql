-- F1 (docs/17) · cola de builds para el ExecEnv `fluxo_engine`.
-- El dispatch (console/worker) para un proyecto con settings.exec_env='fluxo_engine' NO hace
-- workflow_dispatch a GitHub Actions: inserta una fila acá. Un poller host-level (fluxo-agent-runner,
-- como el fluxo-preview-runner) la levanta y corre scripts/agent-runner.sh (docker + token Pro/Max).
-- Mismo patrón/pega que increment_requests y las preview requests.

create table if not exists public.build_jobs (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  project_id   uuid not null references public.projects(id) on delete cascade,
  label        text not null,               -- slug para la rama/log (ej. s-vfix-7 o sprint-sp-vfix-3)
  prompt       text not null,               -- el prompt del kernel (storyPrompt/sprintPrompt)
  issues       text default '',             -- csv de issue numbers, para "Closes #N" del PR
  story_keys   text[] not null default '{}',-- las stories que cubre (para reconciliar status al terminar)
  model        text not null default 'claude-opus-4-8',
  status       text not null default 'pending' check (status in ('pending','running','done','failed')),
  pr_url       text,
  cost_usd     numeric,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists build_jobs_pending_idx on public.build_jobs (status, created_at)
  where status = 'pending';
create index if not exists build_jobs_project_idx on public.build_jobs (project_id);

-- RLS: el tenant ve sus jobs; el poller/worker escribe con service_role (bypass).
alter table public.build_jobs enable row level security;
drop policy if exists build_jobs_tenant_read on public.build_jobs;
create policy build_jobs_tenant_read on public.build_jobs
  for select using (tenant_id = (auth.jwt() ->> 'tenant')::uuid);
