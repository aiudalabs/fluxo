-- F5-P8 (A) · Auth con GitHub. Dos tablas que solo toca el SERVIDOR (Route Handlers con
-- service_role); NUNCA el browser. Por eso: RLS on + CERO policies para authenticated/anon
-- (fail-closed total) — solo service_role (BYPASSRLS por default de Supabase) las lee/escribe.
--
--   app_users     — un usuario Fluxo por identidad de GitHub. tenant_id = su aislamiento RLS
--                   (cada usuario es su propio tenant por ahora; multi-miembro después).
--   github_tokens — el token OAuth user-to-server (+ refresh) para actuar como el usuario
--                   (crear repos en su org, Copilot). Es la ÚNICA credencial de identidad que
--                   Fluxo persiste; el token del LLM NO se guarda (se siembra al repo, F5-P9).

create table public.app_users (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null unique default gen_random_uuid(),
  gh_id      bigint not null unique,
  gh_login   text not null,
  email      text,
  created_at timestamptz not null default now()
);

create table public.github_tokens (
  user_id       uuid primary key references public.app_users (id) on delete cascade,
  gh_login      text not null,
  access_token  text not null,
  refresh_token text,
  expires_at    timestamptz,
  updated_at    timestamptz not null default now()
);

-- RLS on, sin grants ni policies para roles de cliente → intocables desde el browser.
alter table public.app_users     enable row level security;
alter table public.github_tokens enable row level security;
revoke all on public.app_users     from anon, authenticated;
revoke all on public.github_tokens from anon, authenticated;

comment on table public.app_users     is 'Usuario Fluxo por identidad GitHub. tenant_id = aislamiento RLS. Solo server (service_role). F5-P8.';
comment on table public.github_tokens is 'Token OAuth user-to-server (+refresh) del usuario. Única credencial de identidad persistida. Solo server. F5-P8.';
