-- F6-01 / F3-03 · pgTAP for dispatch_story: it dispatches a ready story once
-- (run reserved + story→running), refuses a second dispatch while a run is live
-- (the flap guard), refuses a non-ready story (state machine), and is RLS-scoped.

begin;
create extension if not exists pgtap;
select plan(6);

-- Tenant D, one project, one story born backlog.
insert into public.stories (id, tenant_id, project_id, key)
  values ('d7d7d7d7-0000-0000-0000-000000000071','dddddddd-dddd-dddd-dddd-dddddddddddd','dddddddd-0000-0000-0000-0000000000f1','S1-01');

select set_config('request.jwt.claims', '{"tenant":"dddddddd-dddd-dddd-dddd-dddddddddddd"}', true);
set local role authenticated;

-- A backlog story cannot be dispatched (backlog→running is not a legal edge).
select throws_ok(
  $$ select public.dispatch_story('d7d7d7d7-0000-0000-0000-000000000071') $$,
  null, null,
  'dispatch refuses a non-ready story (state machine)'
);

-- Move it to ready, then dispatch succeeds.
update public.stories set status = 'ready' where id = 'd7d7d7d7-0000-0000-0000-000000000071';
select isnt(
  (select public.dispatch_story('d7d7d7d7-0000-0000-0000-000000000071')),
  null,
  'dispatch returns a run id for a ready story'
);
select is(
  (select status from public.stories where id = 'd7d7d7d7-0000-0000-0000-000000000071'),
  'running',
  'story is now running'
);
select is(
  (select count(*)::int from public.runs where story_id = 'd7d7d7d7-0000-0000-0000-000000000071' and status = 'running'),
  1,
  'exactly one live run was reserved'
);

-- Second dispatch is refused while the run is live (the read-lag / flap guard).
select throws_ok(
  $$ select public.dispatch_story('d7d7d7d7-0000-0000-0000-000000000071') $$,
  null, null,
  'dispatch refuses a second run while one is live (L-ARCH-2)'
);

-- Another tenant cannot dispatch this story (RLS: story not found for them).
select set_config('request.jwt.claims', '{"tenant":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"}', true);
select throws_ok(
  $$ select public.dispatch_story('d7d7d7d7-0000-0000-0000-000000000071') $$,
  null, null,
  'a different tenant cannot dispatch this story (RLS)'
);

select * from finish();
rollback;
