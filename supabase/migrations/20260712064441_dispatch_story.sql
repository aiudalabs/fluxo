-- F6-01 / F3-03 · dispatch_story — the atomic dispatch applier, callable from the
-- board via PostgREST RPC. It is SECURITY INVOKER, so it runs AS the caller and
-- RLS applies (a tenant can only dispatch its own story). It bundles the two
-- guards that kill the flap (L-ARCH-2), atomically:
--
--   1. LIVE-RUN GUARD (F3-03): if the story already has a running run, refuse —
--      never a second paid run, regardless of what the story status reads.
--   2. STATE MACHINE (F2-02): the ready→running transition is enforced by the
--      stories trigger, so a non-ready story cannot be dispatched.
--
-- Everything is one transaction: if the transition is illegal, the run insert
-- rolls back too. No partial dispatch.

create function public.dispatch_story(p_story_id uuid)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_tenant  uuid := (auth.jwt() ->> 'tenant')::uuid;
  v_project uuid;
  v_run     uuid;
begin
  -- Story must be visible to the caller (RLS) — else it's another tenant's or gone.
  select project_id into v_project from public.stories where id = p_story_id;
  if v_project is null then
    raise exception 'story % not found', p_story_id using errcode = 'no_data_found';
  end if;

  -- Live-run guard: refuse if a run is already running for this story.
  if exists (
    select 1 from public.runs where story_id = p_story_id and status = 'running'
  ) then
    raise exception 'story % already has a live run', p_story_id using errcode = 'raise_exception';
  end if;

  -- Transition first (the trigger validates ready→running); then reserve the run.
  update public.stories set status = 'running' where id = p_story_id;
  insert into public.runs (tenant_id, project_id, story_id)
    values (v_tenant, v_project, p_story_id)
    returning id into v_run;

  return v_run;
end;
$$;

comment on function public.dispatch_story(uuid) is
  'Atomic dispatch: live-run guard + state-machine transition + run reservation. RLS-scoped (F6-01/F3-03).';

grant execute on function public.dispatch_story(uuid) to authenticated;
