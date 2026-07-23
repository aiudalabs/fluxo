-- Emulación GENÉRICA de las partes de un proyecto Supabase que un Postgres fresco NO trae: el schema
-- `auth`, los roles anon/authenticated/service_role/authenticator, y las funciones auth.uid()/auth.role()
-- que las policies RLS invocan. Un proyecto Supabase real provisiona todo esto por vos.
--
-- El preview-runner PREFIERE la emulación PROPIA del repo si existe (backend/test/setup/supabase-emulation.sql
-- — la que la app usa en sus tests), y cae a ESTA genérica si el repo no trae una. Así "al menos un caso
-- Supabase" arranca aunque el repo no haya declarado su emulación. Los cuerpos de auth.uid()/auth.role()
-- son la implementación pública documentada de Supabase (supabase/postgres `auth-schema.sql`), para que un
-- JWT firmado por el backend se interprete igual que en una DB Supabase-hosteada.
--
-- NO va bajo backend/drizzle/ (el set de migraciones de producción): correrlo contra un Supabase real
-- chocaría con objetos que `supabase_auth_admin` ya posee. Vive solo para el preview/tests locales.

DO $$ BEGIN
  CREATE ROLE anon NOLOGIN NOINHERIT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE ROLE authenticated NOLOGIN NOINHERIT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD 'authenticator';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT anon TO authenticator;
GRANT authenticated TO authenticator;
GRANT service_role TO authenticator;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Stand-in mínimo de auth.users: lo que un `id references auth.users(id)` + los flujos de auth locales
-- (email/password/phone) necesitan. Un Supabase real tiene ~30 columnas; acá alcanza con estas.
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  phone text,
  encrypted_password text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON auth.users TO service_role, authenticated, anon;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.sub', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
  LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;

-- Grants en `public` que Supabase da por defecto; las policies RLS (de las migraciones reales) son el
-- borde real — estos GRANTs solo dejan a los roles LLEGAR a las tablas para que RLS corra.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated, service_role;
