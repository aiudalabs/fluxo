// Credenciales del TENANT (docs/16) — las credenciales son del USUARIO, no del proyecto: se cargan una
// vez y Fluxo las siembra en cada repo. Valor cifrado en Supabase Vault (RPCs security-definer);
// propagación = `gh secret set` (la MISMA vía que el canal por-proyecto, pero automática y global).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { admin } from "@/lib/server/githubAuth";

const pexec = promisify(execFile);

// Registro DATA-DRIVEN de las credenciales a nivel plataforma (tuyas, aplican a todos tus proyectos).
// Sumar una es agregar acá (nombre = el Actions secret que lee el claude.yml). Las de capability
// (Firebase, etc.) pueden sumarse a este modelo después con el mismo mecanismo.
export interface CredentialDescriptor { name: string; label: string; description: string; docsUrl?: string; optional?: boolean }
export const CREDENTIAL_REGISTRY: CredentialDescriptor[] = [
  {
    name: "CLAUDE_CODE_OAUTH_TOKEN",
    label: "Token de Claude Code",
    description: "El canal de build: autentica al agente Claude que corre en las Actions de tus repos. Obligatorio para despachar.",
    docsUrl: "https://docs.claude.com/en/docs/claude-code/github-actions",
  },
  {
    name: "CLAUDE_GITHUB_PAT",
    label: "GitHub PAT (fine-grained)",
    description: "Token de GitHub para el git/PR del agente. Sin esto, el token interno expira a la 1h y las corridas largas pierden el trabajo. Fine-grained con Contents + Pull requests: Read/write. Además dispara claude-review.",
    docsUrl: "https://github.com/settings/personal-access-tokens",
    optional: true,
  },
];
const KNOWN = new Set(CREDENTIAL_REGISTRY.map((c) => c.name));

export interface TenantCredentialStatus { name: string; label: string; description: string; docsUrl?: string; optional?: boolean; set: boolean; updatedAt: string | null }

// listTenantCredentials: el registro ∪ qué está seteado (nombres + updated_at). NUNCA el valor.
export async function listTenantCredentials(tenant: string): Promise<TenantCredentialStatus[]> {
  const { data } = await admin().from("tenant_credentials").select("name,updated_at").eq("tenant_id", tenant);
  const setByName = new Map((data ?? []).map((r) => [r.name as string, r.updated_at as string]));
  return CREDENTIAL_REGISTRY.map((c) => ({
    ...c, set: setByName.has(c.name), updatedAt: setByName.get(c.name) ?? null,
  }));
}

// setTenantCredential: guarda el valor cifrado en Vault (RPC). Valida que el nombre sea del registro.
export async function setTenantCredential(tenant: string, name: string, value: string): Promise<void> {
  if (!KNOWN.has(name)) throw new Error(`credencial «${name}» no reconocida`);
  const { error } = await admin().rpc("tenant_credential_set", { p_tenant: tenant, p_name: name, p_value: value });
  if (error) throw new Error(`vault set ${name}: ${error.message}`);
}

// getTenantCredential: el valor descifrado (para sembrar en un repo). null si no está.
export async function getTenantCredential(tenant: string, name: string): Promise<string | null> {
  const { data, error } = await admin().rpc("tenant_credential_get", { p_tenant: tenant, p_name: name });
  if (error) throw new Error(`vault get ${name}: ${error.message}`);
  return (data as string | null) || null;
}

// tenantRepoSlugs: los slugs (owner/repo) de los proyectos del tenant con repo. Para propagar a todos.
export async function tenantRepoSlugs(tenant: string): Promise<string[]> {
  const { data } = await admin().from("projects").select("repo").eq("tenant_id", tenant).not("repo", "is", null);
  const out: string[] = [];
  for (const r of data ?? []) {
    const m = String((r as { repo: string }).repo).replace(/\/$/, "").match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (m) out.push(`${m[1]}/${m[2]}`);
  }
  return [...new Set(out)];
}

// propagateToRepo: siembra TODAS las credenciales seteadas del tenant en los Actions secrets de un repo,
// con el token de GitHub del usuario (permiso Secrets:write de la App). Idempotente. Devuelve los
// nombres sembrados y los que fallaron. `gh secret set` cifra con la public key del repo.
export async function propagateToRepo(
  tenant: string, slug: string, ghToken: string,
): Promise<{ seeded: string[]; failed: Array<{ name: string; error: string }> }> {
  const creds = await listTenantCredentials(tenant);
  const seeded: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  for (const c of creds) {
    if (!c.set) continue;
    const value = await getTenantCredential(tenant, c.name);
    if (!value) continue;
    try {
      await pexec("gh", ["secret", "set", c.name, "--repo", slug, "--body", value], { env: { ...process.env, GH_TOKEN: ghToken } });
      seeded.push(c.name);
    } catch (e) {
      failed.push({ name: c.name, error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    }
  }
  return { seeded, failed };
}
