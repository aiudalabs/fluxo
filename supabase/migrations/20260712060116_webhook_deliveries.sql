-- F3-01 · webhook_deliveries — the durable, idempotent landing zone for GitHub
-- webhooks (PR / checks / workflow_run). The receiver Edge Function verifies the
-- HMAC signature, then records the delivery here; the Maestro (F3-02) reconciles
-- from it. Idempotency is a UNIQUE delivery_id: GitHub retries the same delivery,
-- and a retry must never produce a second effect.
--
-- This is service-internal infrastructure written/read only by the Edge Functions
-- (service_role, which bypasses RLS). RLS is enabled with NO policies so no
-- client role (anon/authenticated) can ever read raw webhook payloads. tenant_id/
-- project_id are resolved by the Maestro from the repo, and may be null until then.

create table public.webhook_deliveries (
  id           bigint generated always as identity primary key,
  delivery_id  text not null unique,           -- GitHub X-GitHub-Delivery (idempotency key)
  event_type   text not null,                  -- X-GitHub-Event (pull_request, check_run, workflow_run…)
  action       text,                           -- payload.action when present
  repo         text,                           -- payload.repository.full_name (→ tenant/project in F3-02)
  tenant_id    uuid,
  project_id   uuid,
  payload      jsonb not null default '{}'::jsonb,
  received_at  timestamptz not null default now(),
  processed_at timestamptz                     -- set by the Maestro once reconciled
);

create index webhook_deliveries_unprocessed_idx
  on public.webhook_deliveries (received_at)
  where processed_at is null;

comment on table public.webhook_deliveries is
  'Idempotent landing zone for signed GitHub webhooks. Service-only (RLS, no policies). F3-01.';

-- Lock it down: RLS on, no policies, no client grants. Only service_role (bypass)
-- touches it.
alter table public.webhook_deliveries enable row level security;
revoke all on public.webhook_deliveries from anon, authenticated;
