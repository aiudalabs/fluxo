-- F1-01 · pgTAP: cross-tenant leak test for brain_events (closes L-ARCH-1).
--
-- Proves, as the client-facing `authenticated` role, that:
--   1-2. a tenant sees ONLY its own rows (another tenant's rows are invisible),
--   3.   a tenant cannot forge a row under another tenant (RLS WITH CHECK),
--   4.   a tenant can append under its own tenant,
--   5-6. no client can UPDATE or DELETE (append-only).
--
-- Run: `supabase test db` (or pg_prove against supabase/tests). The whole test is
-- wrapped in a transaction and rolled back — it leaves no residue.

begin;
create extension if not exists pgtap;
select plan(6);

-- Two tenants. Seed as the table owner (postgres bypasses RLS) so both tenants
-- have history regardless of any single claim.
insert into public.brain_events (tenant_id, project_id, kind, payload, actor) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a1a1a1a1-0000-0000-0000-000000000001', 'gate.approved', '{}', 'system'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a1a1a1a1-0000-0000-0000-000000000001', 'decision',      '{}', 'system'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b2b2b2b2-0000-0000-0000-000000000002', 'gate.approved', '{}', 'system');

-- Become a real client: role `authenticated`, JWT claim tenant = A.
select set_config('request.jwt.claims', '{"tenant":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}', true);
set local role authenticated;

-- 1. Tenant A sees exactly its own two rows.
select is(
  (select count(*)::int from public.brain_events),
  2,
  'tenant A sees only its own 2 rows'
);

-- 2. Tenant B's rows are invisible to tenant A (the L-ARCH-1 leak, rejected).
select is(
  (select count(*)::int from public.brain_events
     where tenant_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  0,
  'tenant B rows are invisible to tenant A (cross-tenant read REJECTED)'
);

-- 3. Tenant A cannot forge a row under tenant B (INSERT WITH CHECK).
select throws_ok(
  $$ insert into public.brain_events (tenant_id, project_id, kind, payload, actor)
     values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
             'b2b2b2b2-0000-0000-0000-000000000002', 'forged', '{}', 'attacker') $$,
  '42501',
  null,
  'cross-tenant INSERT is rejected by RLS'
);

-- 4. Tenant A can append under its own tenant.
select lives_ok(
  $$ insert into public.brain_events (tenant_id, project_id, kind, payload, actor)
     values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
             'a1a1a1a1-0000-0000-0000-000000000001', 'decision', '{}', 'tenantA') $$,
  'same-tenant INSERT succeeds'
);

-- 5. Append-only: no UPDATE for a client.
select throws_ok(
  $$ update public.brain_events set kind = 'tamper'
       where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' $$,
  '42501',
  null,
  'UPDATE denied (append-only)'
);

-- 6. Append-only: no DELETE for a client.
select throws_ok(
  $$ delete from public.brain_events
       where tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' $$,
  '42501',
  null,
  'DELETE denied (append-only)'
);

select * from finish();
rollback;
