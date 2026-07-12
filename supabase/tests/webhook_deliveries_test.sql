-- F3-01 · webhook_deliveries is service-internal: no client role (anon/
-- authenticated) may read raw webhook payloads. RLS is on with NO policies and
-- no grants, so a client SELECT is denied outright.

begin;
create extension if not exists pgtap;
select plan(2);

insert into public.webhook_deliveries (delivery_id, event_type, action, repo, payload)
  values ('test-delivery-1', 'pull_request', 'opened', 'rosa/peluqueria', '{}');

set local role authenticated;
select set_config('request.jwt.claims', '{"tenant":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}', true);

select throws_ok(
  $$ select * from public.webhook_deliveries $$,
  '42501',
  null,
  'authenticated cannot read webhook_deliveries (service-only)'
);

reset role;
select set_config('request.jwt.claims', '', true);
set local role anon;
select throws_ok(
  $$ select * from public.webhook_deliveries $$,
  '42501',
  null,
  'anon cannot read webhook_deliveries (service-only)'
);

select * from finish();
rollback;
