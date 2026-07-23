-- P5-4 · pgTAP: cross-tenant leak test for assistant_conversations + assistant_messages
-- (closes L-ARCH-1 for the new tables). As the client-facing `authenticated` role with
-- tenant A's claim: for each table it sees ONLY its own rows, sees NONE of tenant B's, and
-- cannot forge a row under tenant B (RLS WITH CHECK → 42501). Plus same-tenant insert lives.
-- Transactional — rolled back, no residue.

begin;
create extension if not exists pgtap;
select plan(8);

-- Projects for both tenants (FK target). Seed as owner (postgres bypasses RLS).
insert into public.projects (id, tenant_id, name) values
  ('aaaaaaaa-0000-0000-0000-0000000000f1','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','A'),
  ('bbbbbbbb-0000-0000-0000-0000000000f2','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','B');

-- One conversation + one message per tenant.
insert into public.assistant_conversations (id, tenant_id, project_id, title) values
  ('a1a1a1a1-0000-0000-0000-0000000000c1','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','aaaaaaaa-0000-0000-0000-0000000000f1','hilo A'),
  ('b1b1b1b1-0000-0000-0000-0000000000c2','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','bbbbbbbb-0000-0000-0000-0000000000f2','hilo B');
insert into public.assistant_messages (conversation_id, tenant_id, project_id, role, content) values
  ('a1a1a1a1-0000-0000-0000-0000000000c1','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','aaaaaaaa-0000-0000-0000-0000000000f1','user','hola A'),
  ('b1b1b1b1-0000-0000-0000-0000000000c2','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','bbbbbbbb-0000-0000-0000-0000000000f2','user','hola B');

-- Become tenant A (authenticated).
select set_config('request.jwt.claims', '{"tenant":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}', true);
set local role authenticated;

-- assistant_conversations
select is((select count(*)::int from public.assistant_conversations), 1, 'conversations: tenant A sees only its own row');
select is((select count(*)::int from public.assistant_conversations where tenant_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), 0, 'conversations: tenant B invisible to A (cross-tenant read REJECTED)');
select throws_ok(
  $$ insert into public.assistant_conversations (tenant_id, project_id, title)
     values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','bbbbbbbb-0000-0000-0000-0000000000f2','forjado') $$,
  '42501', null, 'conversations: cross-tenant INSERT rejected by RLS');
select lives_ok(
  $$ insert into public.assistant_conversations (tenant_id, project_id, title)
     values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','aaaaaaaa-0000-0000-0000-0000000000f1','otro hilo A') $$,
  'conversations: same-tenant INSERT succeeds');

-- assistant_messages
select is((select count(*)::int from public.assistant_messages), 1, 'messages: tenant A sees only its own row');
select is((select count(*)::int from public.assistant_messages where tenant_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), 0, 'messages: tenant B invisible to A (cross-tenant read REJECTED)');
select throws_ok(
  $$ insert into public.assistant_messages (conversation_id, tenant_id, project_id, role, content)
     values ('b1b1b1b1-0000-0000-0000-0000000000c2','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','bbbbbbbb-0000-0000-0000-0000000000f2','user','forjado') $$,
  '42501', null, 'messages: cross-tenant INSERT rejected by RLS');
select lives_ok(
  $$ insert into public.assistant_messages (conversation_id, tenant_id, project_id, role, content)
     values ('a1a1a1a1-0000-0000-0000-0000000000c1','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','aaaaaaaa-0000-0000-0000-0000000000f1','assistant','respuesta A') $$,
  'messages: same-tenant INSERT succeeds');

select * from finish();
rollback;
