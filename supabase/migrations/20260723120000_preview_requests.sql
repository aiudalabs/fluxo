-- release v2 (docs/14) · Cola de PREVIEWS EFÍMEROS ("App en vivo"): el usuario pide ver la app corriendo
-- navegable → el preview-runner (scripts/preview-runner.sh, HOST-level, con docker) la levanta en un
-- contenedor descartable + túnel público, y estampa preview_url. Mismo patrón que increment_requests:
-- el tenant INSERTA (pide) y LEE (ve estado/URL); el runner ACTUALIZA con service_role (bypassa RLS).
--
-- Por qué HOST-level y no el worker: el worker corre non-root SIN docker socket (modelo de seguridad —
-- corre design runs). Los previews necesitan docker en el host → un runner aparte lo hace. Ver docs/14.
create table if not exists public.preview_requests (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  project_id   uuid not null references public.projects(id) on delete cascade,
  ref          text,                    -- rama/sprint a previsualizar (default: la rama por defecto del repo)
  status       text not null default 'pending'
                 check (status in ('pending','building','live','expired','failed')),
  preview_url  text,                    -- URL pública del túnel (cuando status='live')
  error        text,                    -- mensaje si status='failed'
  expires_at   timestamptz,             -- cuándo el reaper lo baja (efímero de verdad)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.preview_requests enable row level security;
revoke all on public.preview_requests from anon, authenticated;
grant select, insert on public.preview_requests to authenticated;

create index if not exists preview_requests_project_idx
  on public.preview_requests (project_id, created_at desc);
-- El runner busca trabajo por status; parcial para que el índice sea chico.
create index if not exists preview_requests_pending_idx
  on public.preview_requests (created_at)
  where status in ('pending','building','live');

create policy preview_select_own_tenant on public.preview_requests
  for select to authenticated
  using (tenant_id = (auth.jwt() ->> 'tenant')::uuid);

create policy preview_insert_own_tenant on public.preview_requests
  for insert to authenticated
  with check (tenant_id = (auth.jwt() ->> 'tenant')::uuid);

alter publication supabase_realtime add table public.preview_requests;

comment on table public.preview_requests is 'Cola de previews efímeros (release v2 / docs/14). El tenant encola (ref); el preview-runner HOST-level levanta el stack + túnel y estampa preview_url. RLS por tenant; el runner actualiza status/url con service_role.';
