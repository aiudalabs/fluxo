import BrainExplorer from "./BrainExplorer";

// Server component: it only passes the projectId down. All data access happens in
// the client component directly against Supabase (RLS + Realtime) — no bespoke
// backend (F1-04 AC: "sin backend propio nuevo").
export default async function BrainPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "2rem 1.25rem" }}>
      <h1 style={{ marginBottom: 4 }}>Brain</h1>
      <p style={{ color: "var(--muted)", marginTop: 0, fontFamily: "ui-monospace, monospace", fontSize: 13 }}>
        project {projectId}
      </p>
      <BrainExplorer projectId={projectId} />
    </main>
  );
}
