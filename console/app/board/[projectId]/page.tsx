import Board from "./Board";

// F6-01 · The board lives entirely on Realtime over Supabase (no bespoke backend
// for reads) and dispatches via the dispatch_story RPC. State (the project) is in
// the URL.
export default async function BoardPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return (
    <main style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem 1.25rem" }}>
      <h1 style={{ marginBottom: 4 }}>Board</h1>
      <p style={{ color: "var(--muted)", marginTop: 0, fontFamily: "ui-monospace, monospace", fontSize: 13 }}>
        project {projectId}
      </p>
      <Board projectId={projectId} />
    </main>
  );
}
