import Studio from "./Studio";

// F6-02 · Studio — the gated design pipeline as a view over Supabase Realtime. It walks
// the phases, shows the harvested docs/mockups (workdir-harvest, D5), resolves gates
// conversationally (F5-04), and links to execution once the backlog is published. State
// (the project) is in the URL.
export default async function StudioPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return (
    <main style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem 1.25rem" }}>
      <h1 style={{ marginBottom: 4 }}>Studio</h1>
      <p style={{ color: "var(--muted)", marginTop: 0, fontFamily: "ui-monospace, monospace", fontSize: 13 }}>
        project {projectId}
      </p>
      <Studio projectId={projectId} />
    </main>
  );
}
