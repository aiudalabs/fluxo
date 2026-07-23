-- Extensiones que un proyecto Supabase trae por defecto y un Postgres pelado no. Corre en el init-dir
-- ANTES de la emulación y de las migraciones de la app. `pgcrypto` da gen_random_uuid()/crypt() que las
-- migraciones suelen asumir (Supabase lo instala en el schema `extensions`; acá alcanza con public).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
