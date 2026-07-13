// Labels de colores para los issues de GitHub (portado de v1 engine/internal/export.go, que
// usaba sprint=azul, lane=verde, epic=púrpura). Acá vamos más lejos: CADA sprint su color y
// CADA lane su color, para distinguir de un vistazo en la vista de issues de GitHub — sprints,
// lanes (ramas de desarrollo) y épica se leen por color. Determinista: el mismo nombre siempre
// da el mismo color (idempotente al re-exportar).

export interface LabelSpec {
  name: string;
  color: string; // 6 hex, sin '#'
  description: string;
}

// Púrpura reservado para la épica (como v1). No lo reusan las otras paletas.
const EPIC_COLOR = "5319e7";

// Colores curados por lane conocida (agentes del registry) — tonos "de marca" reconocibles.
// Lane desconocida → cae a LANE_PALETTE por hash (estable).
const LANE_COLORS: Record<string, string> = {
  "python-dev": "3572a5",     // azul python
  "react-dev": "149eca",      // cian react
  "react-supabase": "3ecf8e", // verde supabase
  "flutter-dev": "027dfd",    // azul flutter
  "firebase-dev": "ffa000",   // ámbar firebase
  "qa-tester": "6e5494",      // violeta
  "product-advisor": "bf5700",// naranja
  "scrum-master": "0b7285",   // teal
};

// Paletas distintas (excluyen el púrpura de épica). Colores GitHub-safe (contraste ok).
const LANE_PALETTE = ["0e8a16", "d93f0b", "b60205", "006b75", "1d76db", "e99695", "fbca04", "5b21b6"];
const SPRINT_PALETTE = ["1d76db", "0e8a16", "d93f0b", "fbca04", "006b75", "b60205", "0052cc", "c2185b", "00838f", "7b1fa2"];

// djb2 — hash estable para mapear un nombre a un índice de paleta.
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function laneColor(owner: string): string {
  return LANE_COLORS[owner] ?? LANE_PALETTE[hash(owner) % LANE_PALETTE.length];
}

// sprintColor: por NÚMERO de sprint si el key es "SP3" (colores en orden → gradiente legible
// por sprint); si no tiene número, por hash del key.
export function sprintColor(key: string): string {
  const digits = key.replace(/\D/g, "");
  const idx = digits ? parseInt(digits, 10) - 1 : hash(key);
  return SPRINT_PALETTE[((idx % SPRINT_PALETTE.length) + SPRINT_PALETTE.length) % SPRINT_PALETTE.length];
}

// labelSpecsFor: los labels (con color) de una story — sprint, lane, épica. Los NOMBRES son
// los que van al issue; el mismo spec siembra el label (EnsureLabel) y etiqueta el issue.
export function labelSpecsFor(story: { sprint?: string; lane?: string; epic_id?: string }): LabelSpec[] {
  const out: LabelSpec[] = [];
  if (story.sprint) out.push({ name: story.sprint, color: sprintColor(story.sprint), description: "Sprint" });
  if (story.lane) out.push({ name: story.lane, color: laneColor(story.lane), description: "Lane / agente" });
  if (story.epic_id) out.push({ name: story.epic_id, color: EPIC_COLOR, description: "Épica" });
  return out;
}
