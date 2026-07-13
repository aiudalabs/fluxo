-- F-CONDUCTOR-01 · PROYECCIÓN (GitHub = verdad) — el bypass del trigger del state machine.
--
-- La proyección deriva el estado de una story desde GitHub (issue cerrado → done, PR abierto →
-- review, agente perdido → backlog) y lo ESCRIBE. Pero GitHub puede hacer transiciones que el
-- trigger F2-02 prohíbe a propósito: reabrir un done→backlog, saltar running→done (el agente
-- mergeó su propio PR), volver review→backlog cuando el agente se pierde. Son legales SOLO para
-- stories espejadas en GitHub, donde GitHub es la autoridad — no para escrituras del tenant.
--
-- DECISIÓN (PLAN §5, recomendada): un RPC dedicado `project_external_status` SECURITY DEFINER que
-- marca un GUC transaction-local `fluxo.external_sync=on` antes del UPDATE. El trigger honra ese
-- flag y SOLO entonces salta la validación de aristas legales. El flag es local a la transacción
-- (is_local=true) y cada request de PostgREST es una transacción, así que no hay fuga entre
-- llamadas. El RPC se otorga únicamente a service_role (el worker): el tenant NO puede llamarlo
-- ni setear el GUC → para el tenant, el state machine sigue intacto (golden rule 5).

-- ── 1) El trigger honra el bypass ──────────────────────────────────────────────
-- Redefinición aditiva (create or replace) del enforce_story_transition de F2-02: idéntico salvo
-- que, con fluxo.external_sync='on', una transición no-declarada se permite (GitHub manda).
create or replace function public.enforce_story_transition()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'backlog' then
      raise exception 'illegal story birth status %, must be backlog', new.status
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- UPDATE: un status sin cambio siempre pasa; un cambio debe ser una arista declarada,
  -- SALVO que sea una escritura de proyección (GitHub = verdad, flag external_sync).
  if new.status is distinct from old.status then
    if coalesce(current_setting('fluxo.external_sync', true), '') <> 'on'
       and not exists (
         select 1 from public.story_status_transitions
         where from_status = old.status and to_status = new.status
       ) then
      raise exception 'illegal story transition % -> %', old.status, new.status
        using errcode = 'check_violation';
    end if;
    new.updated_at = now();
  end if;

  return new;
end;
$$;

-- ── 2) El RPC de escritura externa ─────────────────────────────────────────────
-- Aplica el estado derivado por la proyección. SECURITY DEFINER (corre como el owner) para poder
-- marcar el GUC; scoped por p_story_id (el worker pasa una story concreta que ya leyó por proyecto).
-- Cuando el agente se pierde (p_agent_lost) limpia los anclajes de sesión (run_id/pr_url/session_url)
-- y vuelve a backlog re-despachable, con el badge agent_lost (equivalente a MarkAgentLost+ClearStorySession de v1).
create or replace function public.project_external_status(
  p_story_id   uuid,
  p_status     text,
  p_pr_url     text default null,
  p_agent_lost text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Local a esta transacción: el trigger lo verá en el UPDATE de abajo y se resetea al terminar.
  perform set_config('fluxo.external_sync', 'on', true);

  update public.stories
     set status      = p_status,
         updated_at  = now(),
         agent_lost  = p_agent_lost,
         pr_url      = case
                         when p_agent_lost is not null then null       -- perdido → limpiar anclaje
                         when p_pr_url is not null      then p_pr_url   -- nuevo PR ligado
                         else pr_url end,
         run_id      = case when p_agent_lost is not null then null else run_id end,
         session_url = case when p_agent_lost is not null then null else session_url end
   where id = p_story_id;
end;
$$;

comment on function public.project_external_status(uuid,text,text,text) is
  'Escritura de proyección (GitHub = verdad). Bypassa el state machine vía GUC transaction-local. Solo service_role. F-CONDUCTOR-01.';

-- Solo el worker (service_role). El tenant NO puede hacer external-sync.
revoke all on function public.project_external_status(uuid,text,text,text) from public;
revoke all on function public.project_external_status(uuid,text,text,text) from anon;
revoke all on function public.project_external_status(uuid,text,text,text) from authenticated;
grant execute on function public.project_external_status(uuid,text,text,text) to service_role;
