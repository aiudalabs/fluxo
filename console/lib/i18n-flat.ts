// F6-04 · i18n for the console — español-first (docs/00-vision), inglés available.
// Dependency-free (no next-intl): a flat es/en dictionary + t(). Strings are externalized
// here so the UI carries no hardcoded copy (closes L-UX-6: "i18n a medias" → i18n completo;
// the old "Forja" brand is gone — everything is Fluxo). Interpolation: t("key", { n: 3 }).

export type Locale = "es" | "en";
export const LOCALES: Locale[] = ["es", "en"];
export const DEFAULT_LOCALE: Locale = ((): Locale => {
  const env = process.env.NEXT_PUBLIC_LOCALE;
  return env === "en" ? "en" : "es";
})();

type Dict = Record<string, string>;

const es: Dict = {
  "app.title": "Fluxo · Console",
  "app.tagline": "La consola es una vista sobre el brain — el registro auditable por proyecto.",
  "home.openProjects": "Ver proyectos →",
  "common.loading": "Cargando…",
  "common.project": "proyecto",
  "nav.projects": "← Proyectos",
  "nav.studio": "Studio",
  "nav.board": "Board",
  "nav.flow": "Flow",
  "nav.brain": "Brain",
  "projects.title": "Proyectos",
  "projects.tagline": "Elegí un proyecto para entrar a su Studio, board y brain.",
  "projects.open": "Abrir →",
  "projects.none": "Configurá NEXT_PUBLIC_DEV_PROJECT_ID para ver un proyecto de dev.",
  "board.title": "Board",
  "board.readError": "No se pudo leer el board: {msg}",
  "board.dispatch": "Despachar",
  "board.blockedBy": "⛔ bloqueada por {n}",
  "studio.title": "Studio",
  "studio.designState": "Estado del diseño:",
  "studio.run.running": "En curso",
  "studio.run.awaiting_gate": "Esperando aprobación",
  "studio.run.awaiting_handoff": "Listo para publicar",
  "studio.run.done": "Terminado",
  "studio.run.failed": "Falló",
  "studio.backlogPublished": "Backlog publicado — ver ejecución en el board →",
  "studio.noRun": "Todavía no hay una design-run para este proyecto.",
  "studio.readError": "No se pudo leer el Studio: {msg}",
  "studio.pickArtifact": "Elegí un documento o mockup para verlo.",
  "studio.gateApproved": "✓ aprobado",
  "studio.gateChanges": "↺ cambios pedidos",
  "gate.label": "◆ Gate — {gate} · intento {n}",
  "gate.openQuestions": "Preguntas abiertas — respondelas para resolverlas:",
  "gate.answerPlaceholder": "Tu respuesta…",
  "gate.answerBtn": "Responder y regenerar",
  "gate.orFeedback": "…o pedí cambios con feedback libre:",
  "gate.feedbackPlaceholder": "Qué corregir…",
  "gate.reviseBtn": "Pedir cambios",
  "gate.approveBtn": "Aprobar y continuar",
  "brain.readError": "No se pudo leer el brain: {msg}",
  "brain.empty": "Sin eventos todavía para este proyecto.",
  "brain.all": "todos",
  "brain.trailToggle": "Trazabilidad requisito→issue→PR",
  "brain.trailTitle": "Trazabilidad requisito → issue → PR",
  "brain.trailEmpty":
    "Aún no hay eventos de trazabilidad. Se escriben al publicar el backlog a Issues y al mergear cada PR (F1-03 · llega con F5-03, el handoff al repo del cliente).",
  "brain.why": "Por qué: {v}",
  "brain.rejected": "Rechazado: {v}",
  "brain.whyNot": "Por qué no: {v}",
  "brain.instead": "En su lugar: {v}",
  "kind.decision": "decisión",
  "kind.gate_answer": "gate",
  "kind.rejected_design": "descartado",
  "kind.provenance": "trazabilidad",
};

const en: Dict = {
  "app.title": "Fluxo · Console",
  "app.tagline": "The console is a view over the brain — the per-project auditable registry.",
  "home.openProjects": "See projects →",
  "common.loading": "Loading…",
  "common.project": "project",
  "nav.projects": "← Projects",
  "nav.studio": "Studio",
  "nav.board": "Board",
  "nav.flow": "Flow",
  "nav.brain": "Brain",
  "projects.title": "Projects",
  "projects.tagline": "Pick a project to enter its Studio, board and brain.",
  "projects.open": "Open →",
  "projects.none": "Set NEXT_PUBLIC_DEV_PROJECT_ID to see a dev project.",
  "board.title": "Board",
  "board.readError": "Couldn't read the board: {msg}",
  "board.dispatch": "Dispatch",
  "board.blockedBy": "⛔ blocked by {n}",
  "studio.title": "Studio",
  "studio.designState": "Design state:",
  "studio.run.running": "Running",
  "studio.run.awaiting_gate": "Awaiting approval",
  "studio.run.awaiting_handoff": "Ready to publish",
  "studio.run.done": "Done",
  "studio.run.failed": "Failed",
  "studio.backlogPublished": "Backlog published — see execution on the board →",
  "studio.noRun": "No design run for this project yet.",
  "studio.readError": "Couldn't read the Studio: {msg}",
  "studio.pickArtifact": "Pick a doc or mockup to view it.",
  "studio.gateApproved": "✓ approved",
  "studio.gateChanges": "↺ changes requested",
  "gate.label": "◆ Gate — {gate} · attempt {n}",
  "gate.openQuestions": "Open questions — answer them to resolve:",
  "gate.answerPlaceholder": "Your answer…",
  "gate.answerBtn": "Answer & regenerate",
  "gate.orFeedback": "…or request changes with free-form feedback:",
  "gate.feedbackPlaceholder": "What to fix…",
  "gate.reviseBtn": "Request changes",
  "gate.approveBtn": "Approve & continue",
  "brain.readError": "Couldn't read the brain: {msg}",
  "brain.empty": "No events yet for this project.",
  "brain.all": "all",
  "brain.trailToggle": "Requirement→issue→PR trail",
  "brain.trailTitle": "Requirement → issue → PR trail",
  "brain.trailEmpty":
    "No traceability events yet. They're written on backlog publish to Issues and on each PR merge (F1-03 · arrives with F5-03, the client-repo handoff).",
  "brain.why": "Why: {v}",
  "brain.rejected": "Rejected: {v}",
  "brain.whyNot": "Why not: {v}",
  "brain.instead": "Instead: {v}",
  "kind.decision": "decision",
  "kind.gate_answer": "gate",
  "kind.rejected_design": "rejected",
  "kind.provenance": "trace",
};

const DICTS: Record<Locale, Dict> = { es, en };

// t reads a key for a locale and interpolates {name} placeholders. A missing key returns
// the key itself (visible, not silently blank) — so a gap surfaces instead of hiding.
export function t(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const raw = DICTS[locale][key] ?? DICTS[DEFAULT_LOCALE][key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name) => (name in vars ? String(vars[name]) : `{${name}}`));
}
