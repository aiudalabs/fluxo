-- F2-01 · pgTAP: per-table cross-tenant isolation for sprints/stories/runs/events
-- (closes L-ARCH-1/3). For each table, as the client-facing `authenticated` role
-- with tenant A's claim: it sees ONLY its own rows, sees NONE of tenant B's, and
-- cannot insert under tenant B. Plus: a composite (project_id, id) FK blocks a
-- cross-project reference (L-ARCH-3). Transactional — rolled back, no residue.

begin;
create extension if not exists pgtap;
select plan(13);

-- Fixed ids so we can wire the FK graph across two tenants.
-- Tenant A
insert into public.sprints (id, tenant_id, project_id, key)
  values ('a5a5a5a5-0000-0000-0000-000000000051','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','aaaaaaaa-0000-0000-0000-0000000000f1','S1');
insert into public.stories (id, tenant_id, project_id, sprint_id, key)
  values ('a7a7a7a7-0000-0000-0000-000000000071','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','aaaaaaaa-0000-0000-0000-0000000000f1','a5a5a5a5-0000-0000-0000-000000000051','S1-01');
insert into public.runs (id, tenant_id, project_id, story_id)
  values ('a9a9a9a9-0000-0000-0000-000000000091','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','aaaaaaaa-0000-0000-0000-0000000000f1','a7a7a7a7-0000-0000-0000-000000000071');
insert into public.events (tenant_id, project_id, story_id, run_id, kind)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','aaaaaaaa-0000-0000-0000-0000000000f1','a7a7a7a7-0000-0000-0000-000000000071','a9a9a9a9-0000-0000-0000-000000000091','dispatched');

-- Tenant B
insert into public.sprints (id, tenant_id, project_id, key)
  values ('b5b5b5b5-0000-0000-0000-000000000052','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','bbbbbbbb-0000-0000-0000-0000000000f2','S1');
insert into public.stories (id, tenant_id, project_id, sprint_id, key)
  values ('b7b7b7b7-0000-0000-0000-000000000072','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','bbbbbbbb-0000-0000-0000-0000000000f2','b5b5b5b5-0000-0000-0000-000000000052','S1-01');
insert into public.runs (id, tenant_id, project_id, story_id)
  values ('b9b9b9b9-0000-0000-0000-000000000092','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','bbbbbbbb-0000-0000-0000-0000000000f2','b7b7b7b7-0000-0000-0000-000000000072');
insert into public.events (tenant_id, project_id, story_id, run_id, kind)
  values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','bbbbbbbb-0000-0000-0000-0000000000f2','b7b7b7b7-0000-0000-0000-000000000072','b9b9b9b9-0000-0000-0000-000000000092','dispatched');

-- Become tenant A (authenticated).
select set_config('request.jwt.claims', '{"tenant":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}', true);
set local role authenticated;

-- sprints
select is((select count(*)::int from public.sprints), 1, 'sprints: tenant A sees only its own row');
select is((select count(*)::int from public.sprints where tenant_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), 0, 'sprints: tenant B invisible to A');
select throws_ok($$insert into public.sprints (tenant_id, project_id, key) values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','bbbbbbbb-0000-0000-0000-0000000000f2','x')$$, '42501', null, 'sprints: cross-tenant INSERT rejected');

-- stories
select is((select count(*)::int from public.stories), 1, 'stories: tenant A sees only its own row');
select is((select count(*)::int from public.stories where tenant_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), 0, 'stories: tenant B invisible to A');
select throws_ok($$insert into public.stories (tenant_id, project_id, key) values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','bbbbbbbb-0000-0000-0000-0000000000f2','x')$$, '42501', null, 'stories: cross-tenant INSERT rejected');

-- runs
select is((select count(*)::int from public.runs), 1, 'runs: tenant A sees only its own row');
select is((select count(*)::int from public.runs where tenant_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), 0, 'runs: tenant B invisible to A');
select throws_ok($$insert into public.runs (tenant_id, project_id, story_id) values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','bbbbbbbb-0000-0000-0000-0000000000f2','b7b7b7b7-0000-0000-0000-000000000072')$$, '42501', null, 'runs: cross-tenant INSERT rejected');

-- events
select is((select count(*)::int from public.events), 1, 'events: tenant A sees only its own row');
select is((select count(*)::int from public.events where tenant_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), 0, 'events: tenant B invisible to A');
select throws_ok($$insert into public.events (tenant_id, project_id, story_id, kind) values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','bbbbbbbb-0000-0000-0000-0000000000f2','b7b7b7b7-0000-0000-0000-000000000072','x')$$, '42501', null, 'events: cross-tenant INSERT rejected');

-- Composite FK: a run in project A referencing project B's story is rejected
-- (foreign_key_violation 23503), even though the RLS tenant check passes — no
-- cross-project references (L-ARCH-3).
select throws_ok($$insert into public.runs (tenant_id, project_id, story_id) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','aaaaaaaa-0000-0000-0000-0000000000f1','b7b7b7b7-0000-0000-0000-000000000072')$$, '23503', null, 'runs: cross-project story reference rejected by composite FK');

select * from finish();
rollback;
