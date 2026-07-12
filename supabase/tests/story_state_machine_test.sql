-- F2-02 · pgTAP: the story state machine. Legal transitions pass; illegal ones are
-- rejected at the single enforced point (the trigger); a story cannot be born in a
-- non-initial state; updated_at is stamped on a real transition.

begin;
create extension if not exists pgtap;
select plan(8);

-- Declared edges exist as data (the graph is declared, not hard-coded).
select ok(
  (select count(*) from public.story_status_transitions) >= 14,
  'legal transitions are declared as data'
);
select ok(
  exists(select 1 from public.story_status_transitions where from_status='ready' and to_status='running'),
  'ready -> running is a declared edge'
);

-- Seed a story as owner (bypasses RLS) — born 'backlog' per the birth rule.
insert into public.sprints (id, tenant_id, project_id, key)
  values ('c5c5c5c5-0000-0000-0000-000000000051','cccccccc-cccc-cccc-cccc-cccccccccccc','cccccccc-0000-0000-0000-0000000000f1','S1');
insert into public.stories (id, tenant_id, project_id, key)
  values ('c7c7c7c7-0000-0000-0000-000000000071','cccccccc-cccc-cccc-cccc-cccccccccccc','cccccccc-0000-0000-0000-0000000000f1','S1-01');

-- Birth rule: a story cannot be inserted in a non-initial state.
select throws_like(
  $$insert into public.stories (tenant_id, project_id, key, status)
    values ('cccccccc-cccc-cccc-cccc-cccccccccccc','cccccccc-0000-0000-0000-0000000000f1','S1-02','done')$$,
  '%illegal story birth status%',
  'a story cannot be born in a non-initial state'
);

-- Legal path: backlog -> ready -> running.
select lives_ok(
  $$update public.stories set status='ready' where id='c7c7c7c7-0000-0000-0000-000000000071'$$,
  'legal transition backlog -> ready'
);
select lives_ok(
  $$update public.stories set status='running' where id='c7c7c7c7-0000-0000-0000-000000000071'$$,
  'legal transition ready -> running'
);

-- Illegal jump: running -> done is not a declared edge.
select throws_like(
  $$update public.stories set status='done' where id='c7c7c7c7-0000-0000-0000-000000000071'$$,
  '%illegal story transition%',
  'illegal transition running -> done is rejected'
);

-- updated_at is stamped on a real transition (running -> review here).
update public.stories set updated_at = '2000-01-01' where id='c7c7c7c7-0000-0000-0000-000000000071';
update public.stories set status='review' where id='c7c7c7c7-0000-0000-0000-000000000071';
select ok(
  (select updated_at from public.stories where id='c7c7c7c7-0000-0000-0000-000000000071') > '2020-01-01',
  'updated_at is stamped on a transition'
);

-- A no-op status update is allowed (idempotent writes don't trip the machine).
select lives_ok(
  $$update public.stories set title='same status' where id='c7c7c7c7-0000-0000-0000-000000000071'$$,
  'non-status update is allowed'
);

select * from finish();
rollback;
