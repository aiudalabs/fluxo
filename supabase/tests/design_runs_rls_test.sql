-- F6-02 · pgTAP: cross-tenant isolation for design_runs/phases/gates, plus the
-- conversational gate resolution round-trip and a cross-project FK block. As the
-- client-facing `authenticated` role with tenant A's claim: A sees only its own rows,
-- none of B's, cannot insert under B; A can RESOLVE its own gate (the F5-04 update path);
-- a phase referencing B's run is rejected by the composite FK. Transactional — rolled back.

begin;
create extension if not exists pgtap;
select plan(13);

-- Tenant A
insert into public.design_runs (id, tenant_id, project_id)
  values ('a1a1a1a1-0000-0000-0000-0000000000d1','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','aaaaaaaa-0000-0000-0000-0000000000f1');
insert into public.design_phases (id, tenant_id, project_id, run_id, phase_id, label, ord)
  values ('a2a2a2a2-0000-0000-0000-0000000000d2','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','aaaaaaaa-0000-0000-0000-0000000000f1','a1a1a1a1-0000-0000-0000-0000000000d1','discovery','Descubrimiento',0);
insert into public.design_gates (id, tenant_id, project_id, run_id, phase_id, gate_id, reason, open_questions)
  values ('a3a3a3a3-0000-0000-0000-0000000000d3','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','aaaaaaaa-0000-0000-0000-0000000000f1','a1a1a1a1-0000-0000-0000-0000000000d1','discovery','discovery_gate','revisa','["¿Seña?"]'::jsonb);

-- Tenant B
insert into public.design_runs (id, tenant_id, project_id)
  values ('b1b1b1b1-0000-0000-0000-0000000000d1','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','bbbbbbbb-0000-0000-0000-0000000000f2');
insert into public.design_phases (id, tenant_id, project_id, run_id, phase_id, label, ord)
  values ('b2b2b2b2-0000-0000-0000-0000000000d2','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','bbbbbbbb-0000-0000-0000-0000000000f2','b1b1b1b1-0000-0000-0000-0000000000d1','discovery','Descubrimiento',0);
insert into public.design_gates (id, tenant_id, project_id, run_id, phase_id, gate_id, reason)
  values ('b3b3b3b3-0000-0000-0000-0000000000d3','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','bbbbbbbb-0000-0000-0000-0000000000f2','b1b1b1b1-0000-0000-0000-0000000000d1','discovery','discovery_gate','revisa');

-- Become tenant A (authenticated).
select set_config('request.jwt.claims', '{"tenant":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}', true);
set local role authenticated;

-- design_runs
select is((select count(*)::int from public.design_runs), 1, 'design_runs: tenant A sees only its own');
select is((select count(*)::int from public.design_runs where tenant_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), 0, 'design_runs: tenant B invisible to A');
select throws_ok($$insert into public.design_runs (tenant_id, project_id) values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','bbbbbbbb-0000-0000-0000-0000000000f2')$$, '42501', null, 'design_runs: cross-tenant INSERT rejected');

-- design_phases
select is((select count(*)::int from public.design_phases), 1, 'design_phases: tenant A sees only its own');
select is((select count(*)::int from public.design_phases where tenant_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), 0, 'design_phases: tenant B invisible to A');
select throws_ok($$insert into public.design_phases (tenant_id, project_id, run_id, phase_id) values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','bbbbbbbb-0000-0000-0000-0000000000f2','b1b1b1b1-0000-0000-0000-0000000000d1','prd')$$, '42501', null, 'design_phases: cross-tenant INSERT rejected');

-- design_gates
select is((select count(*)::int from public.design_gates), 1, 'design_gates: tenant A sees only its own');
select is((select count(*)::int from public.design_gates where tenant_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), 0, 'design_gates: tenant B invisible to A');
select throws_ok($$insert into public.design_gates (tenant_id, project_id, run_id, phase_id, gate_id) values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','bbbbbbbb-0000-0000-0000-0000000000f2','b1b1b1b1-0000-0000-0000-0000000000d1','discovery','g')$$, '42501', null, 'design_gates: cross-tenant INSERT rejected');

-- The conversational resolution path (F5-04): tenant A resolves its OWN gate with an
-- answer to the open question. The UPDATE lands.
update public.design_gates
  set status='resolved', outcome='revise', answers='[{"q":"¿Seña?","a":"Sí, 30%"}]'::jsonb, resolved_at=now()
  where id='a3a3a3a3-0000-0000-0000-0000000000d3';
select is((select status from public.design_gates where id='a3a3a3a3-0000-0000-0000-0000000000d3'), 'resolved', 'design_gates: A can resolve its own gate (answer path)');
select is((select answers->0->>'a' from public.design_gates where id='a3a3a3a3-0000-0000-0000-0000000000d3'), 'Sí, 30%', 'design_gates: the answer is stored');

-- A cannot resolve tenant B's gate (RLS hides the row → 0 rows updated).
update public.design_gates set status='resolved' where id='b3b3b3b3-0000-0000-0000-0000000000d3';
select is((select count(*)::int from public.design_gates where id='b3b3b3b3-0000-0000-0000-0000000000d3' and status='resolved'), 0, 'design_gates: A cannot resolve B''s gate (RLS)');

-- Composite FK: a phase in project A referencing project B's run is rejected (23503),
-- even though the tenant check passes — no cross-project references (L-ARCH-3).
select throws_ok($$insert into public.design_phases (tenant_id, project_id, run_id, phase_id) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','aaaaaaaa-0000-0000-0000-0000000000f1','b1b1b1b1-0000-0000-0000-0000000000d1','prd')$$, '23503', null, 'design_phases: cross-project run reference rejected by composite FK');

select * from finish();
rollback;
