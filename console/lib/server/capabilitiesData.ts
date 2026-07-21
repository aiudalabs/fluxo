// P6-2b · Paso 2 — pegamento del console para las CAPABILITIES self-serve. El resolver del MÉTODO
// vive en design/src/capabilities.ts (data-driven, una sola fuente de verdad — golden rule #1);
// acá el console agrega solo lo suyo: (a) resolver el registryDir del filesystem (mismo patrón que
// /api/registry), (b) la WHITELIST de secrets que el PUT del canal acepta sembrar — el nombre del
// Actions secret de cada capability RESUELTA del proyecto ∪ el token de Claude (el canal de siempre).
// NUNCA se siembra un secret arbitrario que mande el cliente: solo lo que el registry declara para
// el stack del proyecto.
import path from "path";
import { resolveProjectCapabilities, type ResolvedCapability } from "../../../design/src/capabilities.ts";

export type { ResolvedCapability };
export { resolveProjectCapabilities };

// El canal de build de Claude: su secret está SIEMPRE permitido (es el canal, no una capability del
// registry — ver channel/route.ts). Los demás salen del stack del proyecto vía el registry.
export const CLAUDE_SECRET = "CLAUDE_CODE_OAUTH_TOKEN";

// registryDir: en dev el registry vive un nivel arriba del cwd del console (../registry); en el
// contenedor se fija por REGISTRY_DIR. Idéntico a console/app/api/registry/route.ts.
export function registryDir(): string {
  return process.env.REGISTRY_DIR ?? path.resolve(process.cwd(), "..", "registry");
}

// secretWhitelist: el set de nombres de Actions secret que el PUT puede sembrar para ESTE proyecto =
// el token de Claude ∪ el secret de cada capability resuelta (las que declaran uno). Data-driven.
export function secretWhitelist(caps: ResolvedCapability[]): Set<string> {
  const w = new Set<string>([CLAUDE_SECRET]);
  for (const c of caps) if (c.secret) w.add(c.secret);
  return w;
}

// isAllowedSecret: ¿este nombre de secret está permitido para sembrar en este proyecto? La guardia de
// seguridad del PUT — un secret fuera de esta whitelist se rechaza (nunca se siembra algo arbitrario).
export function isAllowedSecret(caps: ResolvedCapability[], name: string): boolean {
  return secretWhitelist(caps).has(name);
}
