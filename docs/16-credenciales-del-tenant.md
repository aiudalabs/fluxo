# 16 · Credenciales del tenant (bóveda + propagación)

**El problema:** las credenciales que un run necesita (el token de Claude Code, el GitHub PAT para
corridas largas, mañana otras) se sembraban **por-proyecto** y **no se guardaban** (pass-through directo
a los Actions secrets del repo). Consecuencia: cada proyecto nuevo = re-tipear las mismas credenciales.

**La tesis (pedido del usuario, 2026-07-28):** *"las credenciales son MÍAS, no de cada proyecto."* Se
cargan **una vez** a nivel **tenant**, y **todo proyecto las hereda**.

## El modelo

```
tenant  ──(carga una vez)──▶  bóveda de Fluxo (Supabase Vault, cifrado)
                                     │  propaga (gh secret set)
                                     ▼
                    Actions secrets de CADA repo del tenant
```

- **Almacenamiento:** `tenant_credentials` mapea `(tenant, nombre) → vault.secrets.id` (el valor
  **cifrado** en Supabase Vault). El tenant **ve los nombres** que tiene seteados (RLS select), **nunca
  el valor** (vive en la bóveda; solo el service_role lo descifra para sembrar, vía RPCs security-definer
  `tenant_credential_set` / `tenant_credential_get`).
- **Registro data-driven** (`console/lib/server/tenantCredentials.ts` · `CREDENTIAL_REGISTRY`): las
  credenciales a nivel plataforma. Hoy: `CLAUDE_CODE_OAUTH_TOKEN` (canal de build) y `CLAUDE_GITHUB_PAT`
  (corridas largas + trigger de review). Sumar una es agregar al registro; el nombre = el Actions secret
  que lee el `claude.yml`.
- **Propagación:** `propagateToRepo(tenant, slug, ghToken)` siembra cada credencial seteada en los Actions
  secrets del repo con **`gh secret set`** (la MISMA vía del canal por-proyecto, pero automática y global).
  Idempotente. Cifra con la public key del repo — el valor no queda en logs.

## Flujo de usuario

1. **Console → menú de usuario → «🔐 Mis credenciales»** (`/account/credentials`, nivel cuenta).
2. Pegás cada valor una vez → se guarda cifrado en la bóveda **y se propaga a todos tus repos actuales**.
3. **«↻ Sincronizar a mis proyectos»** re-siembra todas en todos tus repos (tras crear un proyecto nuevo,
   o al rotar una credencial).

## La decisión de fondo (asumida)

Antes Fluxo **no guardaba** las credenciales (pass-through). Para "cargar una vez → aplicar a todo
proyecto futuro", Fluxo **las custodia** cifradas en Vault. Es un cambio de postura consciente (Fluxo pasa
a ser custodio de credenciales sensibles), alineado con la golden rule "tokens → Vault". Descartada la
alternativa **GitHub Org secrets** (nativa, cero-storage) porque requiere que el cliente use una org y
sembrar en GitHub, no en Fluxo — el usuario quiere "todo desde Fluxo".

## Pendiente (para que un proyecto NUEVO herede 100% automático)

Hoy la propagación es **console-side** (token del usuario, `gh secret set`): cubre los repos actuales al
guardar, y los nuevos con un click de «Sincronizar». Para que un proyecto recién **escafoldado** herede
las credenciales **sin ningún click**, falta engancharlo en el **worker** (el scaffold del repo es worker,
async): tras crear el repo, leer las credenciales del tenant (RPC service_role) y sembrarlas con el App
token. Requiere sembrar secrets desde el worker (crypto sealed-box con la public key del repo, o `gh` en
la imagen del worker) — es el follow-up. Mientras, «Sincronizar a mis proyectos» lo cubre en un click.

## Otros pendientes
- [ ] Auto-seed en el scaffold del worker (proyecto nuevo → credenciales sin click).
- [ ] Sumar las credenciales de capability (Firebase, etc.) al mismo modelo tenant-level (hoy siguen por-proyecto).
- [ ] Borrado de credencial (hoy set/rotate; falta un delete que limpie también el vault.secret).
- [ ] Probe de "sembrada en el repo" en la UI (además de "guardada en la bóveda").
