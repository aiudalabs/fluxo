// jwtRefresh — helpers PUROS (sin browser ni red) para el refresh silencioso del JWT de sesión.
// Deuda-chica 🔴 (2026-07-20): el JWT de sesión vencía sin refresh → "JWT expired" a mitad de una
// sesión larga (el E2E lo mordió). El cliente usa needsRefresh() para cambiar el token por uno
// fresco ANTES de que venza. Testeable en node (atob es global en node 18+ y en el browser).

// decodeExp: el claim `exp` (epoch segundos) de un JWT, o null si no parsea / no lo trae.
export function decodeExp(jwt: string): number | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: unknown };
    return typeof json.exp === "number" ? json.exp : null;
  } catch {
    return null;
  }
}

// needsRefresh: ¿el JWT vence dentro de `thresholdS` segundos (o ya venció)? Un JWT sin exp NO se
// refresca (no sabemos cuándo vence — no es nuestro caso, pero es el default seguro).
export function needsRefresh(jwt: string, nowS: number, thresholdS: number): boolean {
  const exp = decodeExp(jwt);
  if (exp === null) return false;
  return exp - nowS < thresholdS;
}
