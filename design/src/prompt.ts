// F6-02 · Compose a phase's prompt from its resolved inputs, plus any reviewer feedback
// or answered open questions carried back by a gate (F5-04). This replaces the F5-01
// OUTPUT_DIRECTIVE (which forced the doc into the reply text): under workdir-harvest the
// agent writes its deliverables to disk as the role asks, so the prompt tells it WHICH
// files to write and WHICH prior artifacts to read from the workdir.
//
// Convention over the workflow's declared inputs (registry/workflows/design.yaml):
//   • `output` / `provisioning`  → deliverable PATHS the phase writes to the workdir
//   • keys ending in `_path`      → prior artifacts the phase reads from the workdir
//   • everything else             → inline text context (e.g. brief: $discovery.output.text)

export interface QA {
  q: string;
  a: string;
}

export interface ComposeInput {
  inputs: Record<string, unknown>;
  feedback?: string;
  answers?: QA[];
}

const WRITE_KEYS = new Set(["output", "provisioning"]);
const isReadPath = (key: string) => key.endsWith("_path");

export function composePrompt({ inputs, feedback, answers }: ComposeInput): string {
  const writes: string[] = [];
  const reads: string[] = [];
  const context: string[] = [];

  for (const [key, raw] of Object.entries(inputs)) {
    if (raw == null) continue;
    const val = String(raw);
    if (WRITE_KEYS.has(key)) {
      writes.push(val);
    } else if (isReadPath(key)) {
      reads.push(val);
    } else {
      context.push(`### ${key}\n${val}`);
    }
  }

  const parts: string[] = [];
  parts.push(
    "# Runtime de diseño (workdir-harvest)\n" +
      "Trabajás en un workdir aislado. Producí tus entregables ESCRIBIÉNDOLOS A DISCO en las " +
      "rutas indicadas (relativas al workdir) usando tus tools de escritura. NO pegues el documento " +
      "en tu respuesta de texto — el runtime cosecha los archivos del workdir.",
  );
  if (writes.length) {
    parts.push("## Entregables — escribí cada uno a disco\n" + writes.map((p) => `- \`${p}\``).join("\n"));
  }
  if (reads.length) {
    parts.push(
      "## Insumos ya en el workdir — leelos con tu tool de lectura\n" + reads.map((p) => `- \`${p}\``).join("\n"),
    );
  }
  if (context.length) {
    parts.push("## Contexto\n" + context.join("\n\n"));
  }
  if (feedback && feedback.trim()) {
    parts.push(
      "## Corrección del revisor\nUna versión anterior fue rechazada en el gate. Atendé cada punto:\n" + feedback.trim(),
    );
  }
  if (answers && answers.length) {
    parts.push(
      "## Respuestas a las preguntas abiertas\n" +
        "El revisor respondió las preguntas que dejaste abiertas — incorporalas y quitá esas incógnitas del doc:\n" +
        answers.map((a) => `- **${a.q}** → ${a.a}`).join("\n"),
    );
  }
  return parts.join("\n\n");
}
