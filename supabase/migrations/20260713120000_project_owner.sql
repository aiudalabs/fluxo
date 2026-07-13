-- F5-P10 · owner_id del proyecto = el usuario que lo creó (sub del JWT de sesión = app_users.id).
-- Default del claim, como tenant_id: el browser no lo setea. El worker lo usa para resolver el
-- token OAuth del dueño y crear el repo COMO ese usuario (funciona en cuentas personales Y orgs;
-- el installation token de la App solo servía para orgs con la App instalada).
alter table public.projects
  alter column owner_id set default
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid;
