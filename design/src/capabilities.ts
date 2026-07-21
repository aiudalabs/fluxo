// P6-2b · CAPABILITIES como data (golden rule #1/#5, D8). Una capability es una integración
// externa BYO (Firebase, Vercel, Supabase, Gemini…): declara qué provisioning HUMANO one-time
// requiere, el/los secret(s) BYO, un probe 🟢, y si permite emulador. El stack declara qué
// capabilities necesita (registry/stacks/<stack>.yaml). Este módulo LEE ese registry y lo tipa;
// no interpreta metodología — solo transporta la data que el architect (provisioning.yaml) y el
// gate determinista (repodocs.ts/handoff.ts) consumen.
//
// La grada `accounts:` de docs/provisioning.yaml es la FRONTERA HUMANA: "el humano crea el
// proyecto/cuenta + billing PRIMERO". Nunca un AC de build. `resolveFrontierMarkers` resuelve, para
// un run, qué markers de provisioning debe cazar el gate (accounts declarados ∪ capabilities del
// stack), leyendo los markers de cada capability desde el registry.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

export interface CapabilityProvisioning {
  // Resumen humano de lo que el usuario crea one-time (link guiado va en `guide`).
  summary?: string;
  guide?: string;
  // markers: frases que, si aparecen en un AC de BUILD, delatan que el provisioning humano se coló
  // como criterio no-despachable (ningún agente crea un proyecto GCP + billing). Las lee el gate.
  markers?: string[];
}
export interface Capability {
  id: string;
  name?: string;
  provisioning?: CapabilityProvisioning;
  // secret/probe se dejan laxos (data BYO consumida por el onboarding, no por el gate de Paso 1).
  secret?: Record<string, unknown>;
  probe?: Record<string, unknown>;
  emulator?: boolean;
}

// loadCapability: registry/capabilities/<id>.yaml → Capability. null si no existe/no parsea.
export function loadCapability(registryDir: string, id: string): Capability | null {
  try {
    const doc = yaml.load(readFileSync(join(registryDir, "capabilities", `${id}.yaml`), "utf8"));
    if (!doc || typeof doc !== "object") return null;
    return doc as Capability;
  } catch {
    return null;
  }
}

// stackCapabilities: los ids de capability que un stack declara necesitar
// (registry/stacks/<stack>.yaml `capabilities: [...]`). Stack sin manifest → [] (degrada).
export function stackCapabilities(registryDir: string, stackId: string): string[] {
  try {
    const doc = yaml.load(readFileSync(join(registryDir, "stacks", `${stackId}.yaml`), "utf8")) as {
      capabilities?: unknown;
    };
    return Array.isArray(doc?.capabilities) ? doc.capabilities.map((c) => String(c).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

interface ProvisioningDoc {
  stack?: unknown;
  accounts?: Array<{ capability?: unknown } | null>;
}

// parseStack: el `stack:` declarado en docs/provisioning.yaml (el architect §8). null si falta/no
// parsea. Es la llave para resolver `registry/stacks/<stack>.yaml` → sus capabilities.
export function parseStack(provisioningYaml: string): string | null {
  try {
    const doc = (yaml.load(provisioningYaml) ?? {}) as ProvisioningDoc;
    const s = doc.stack != null ? String(doc.stack).trim() : "";
    return s || null;
  } catch {
    return null;
  }
}

// parseAccountCapabilities: los capability ids del bloque `accounts:` de provisioning.yaml — la
// grada de frontera humana que el architect declara. Ausente/malformado → [] (proyecto viejo).
export function parseAccountCapabilities(provisioningYaml: string): string[] {
  let doc: ProvisioningDoc;
  try {
    doc = (yaml.load(provisioningYaml) ?? {}) as ProvisioningDoc;
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const a of doc.accounts ?? []) {
    if (a?.capability != null) ids.push(String(a.capability).trim());
  }
  return ids.filter(Boolean);
}

// resolveFrontierMarkers: para un run, capability id → markers de provisioning que el gate debe
// cazar. Frontera = lo declarado en `accounts:` ∪ las capabilities del stack (robustez: aun si el
// architect olvidó `accounts`, el stack ya declara firebase). Sin provisioning.yaml → {} (gate off).
export function resolveFrontierMarkers(registryDir: string, workdir: string): Record<string, string[]> {
  let raw: string;
  try {
    raw = readFileSync(join(workdir, "docs", "provisioning.yaml"), "utf8");
  } catch {
    return {};
  }
  let doc: ProvisioningDoc = {};
  try {
    doc = (yaml.load(raw) ?? {}) as ProvisioningDoc;
  } catch {
    return {};
  }
  const ids = new Set<string>(parseAccountCapabilities(raw));
  if (doc.stack) for (const c of stackCapabilities(registryDir, String(doc.stack).trim())) ids.add(c);

  const out: Record<string, string[]> = {};
  for (const id of ids) {
    const markers = loadCapability(registryDir, id)?.provisioning?.markers ?? [];
    if (markers.length) out[id] = markers;
  }
  return out;
}

// ResolvedCapability: la forma que el onboarding self-serve necesita de una capability — nombre para
// mostrar, el nombre del Actions secret BYO que el usuario siembra, y la guía humana de provisioning.
// `secret` es null si la capability no declara uno (nada que sembrar).
export interface ResolvedCapability {
  id: string;
  name: string;
  secret: string | null;
  summary?: string;
  guide?: string;
}

function secretName(cap: Capability): string | null {
  const n = cap.secret?.name;
  return typeof n === "string" && n.trim() ? n.trim() : null;
}

// resolveProjectCapabilities: dado el contenido de docs/provisioning.yaml de un proyecto (venga del
// brain o del filesystem), resuelve sus capabilities contra el registry REAL. Set de ids = las del
// bloque `accounts:` ∪ las que declara el stack (misma unión robusta que resolveFrontierMarkers: aun
// si el architect olvidó `accounts`, el stack ya declara firebase). Orden estable (stack primero, en
// orden de declaración; luego accounts extra). Capability inexistente en el registry → se saltea.
export function resolveProjectCapabilities(registryDir: string, provisioningYaml: string): ResolvedCapability[] {
  const stack = parseStack(provisioningYaml);
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    const t = id.trim();
    if (t && !seen.has(t)) { seen.add(t); ids.push(t); }
  };
  if (stack) for (const id of stackCapabilities(registryDir, stack)) push(id);
  for (const id of parseAccountCapabilities(provisioningYaml)) push(id);

  const out: ResolvedCapability[] = [];
  for (const id of ids) {
    const cap = loadCapability(registryDir, id);
    if (!cap) continue;
    out.push({
      id,
      name: cap.name ?? id,
      secret: secretName(cap),
      summary: cap.provisioning?.summary,
      guide: cap.provisioning?.guide,
    });
  }
  return out;
}
