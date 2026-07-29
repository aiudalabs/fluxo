-- Bóveda de credenciales del TENANT (docs/16). Las credenciales (Claude token, GitHub PAT, …) son del
-- USUARIO, no del proyecto: se cargan UNA vez y Fluxo las siembra en cada repo. Antes se sembraban
-- por-proyecto y NO se guardaban (pass-through) → re-tipear en cada proyecto. Ahora se custodian
-- cifradas en Supabase Vault y se propagan solas.
--
-- Modelo: `tenant_credentials` mapea (tenant, nombre) → un secret de vault.secrets (el valor CIFRADO).
-- El tenant VE qué nombres tiene seteados (RLS select), NUNCA el valor (vive en vault, solo service_role
-- lo descifra para sembrar). Escrituras/lecturas del valor van por RPCs security-definer (service_role).

create table if not exists public.tenant_credentials (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  name        text not null,          -- CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_GITHUB_PAT, …
  secret_id   uuid not null,          -- → vault.secrets.id (valor cifrado)
  updated_at  timestamptz not null default now(),
  unique (tenant_id, name)
);

alter table public.tenant_credentials enable row level security;
revoke all on public.tenant_credentials from anon, authenticated;
grant select on public.tenant_credentials to authenticated;   -- ven los NOMBRES (qué está seteado), no el valor

-- Cada tenant ve SOLO sus credenciales (nombres + updated_at). El valor NO está en esta tabla.
create policy tc_select_own on public.tenant_credentials
  for select to authenticated
  using (tenant_id = (auth.jwt() ->> 'tenant')::uuid);

comment on table public.tenant_credentials is 'Credenciales del tenant (Claude token, GitHub PAT, …) → vault.secrets cifrado. Se cargan una vez y Fluxo las siembra en cada repo. RLS: el tenant ve nombres, no valores. docs/16.';

-- ── RPCs (security definer → acceden a vault; execute solo service_role) ─────────────────────────
-- tenant_credential_set: upsert del valor en Vault + el mapping. Crea el secret cifrado la 1ª vez,
-- lo actualiza después. Devuelve void.
create or replace function public.tenant_credential_set(p_tenant uuid, p_name text, p_value text)
returns void language plpgsql security definer set search_path = public, vault as $$
declare v_sid uuid;
begin
  select secret_id into v_sid from public.tenant_credentials where tenant_id = p_tenant and name = p_name;
  if v_sid is null then
    v_sid := vault.create_secret(p_value, 'tenant_cred:' || p_tenant || ':' || p_name, 'Fluxo tenant credential');
    insert into public.tenant_credentials (tenant_id, name, secret_id) values (p_tenant, p_name, v_sid);
  else
    perform vault.update_secret(v_sid, p_value);
    update public.tenant_credentials set updated_at = now() where secret_id = v_sid;
  end if;
end $$;

-- tenant_credential_get: el valor DESCIFRADO de una credencial (para sembrarla en un repo). Solo lo
-- llama el server con service_role. null si no está seteada.
create or replace function public.tenant_credential_get(p_tenant uuid, p_name text)
returns text language sql security definer set search_path = public, vault as $$
  select ds.decrypted_secret
  from public.tenant_credentials tc
  join vault.decrypted_secrets ds on ds.id = tc.secret_id
  where tc.tenant_id = p_tenant and tc.name = p_name;
$$;

revoke all on function public.tenant_credential_set(uuid, text, text) from public, anon, authenticated;
revoke all on function public.tenant_credential_get(uuid, text) from public, anon, authenticated;
grant execute on function public.tenant_credential_set(uuid, text, text) to service_role;
grant execute on function public.tenant_credential_get(uuid, text) to service_role;
