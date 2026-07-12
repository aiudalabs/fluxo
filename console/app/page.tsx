import Link from "next/link";

const devProject = process.env.NEXT_PUBLIC_DEV_PROJECT_ID;

export default function Home() {
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "3rem 1.25rem" }}>
      <h1>Fluxo · Console</h1>
      <p style={{ color: "var(--muted)" }}>
        La consola es una vista sobre el <strong>brain</strong> — el registro auditable por proyecto.
      </p>
      <p>
        {devProject ? (
          <Link href={`/brain/${devProject}`}>Abrir el brain explorer del proyecto de dev →</Link>
        ) : (
          <span style={{ color: "var(--muted)" }}>
            Configurá <code>NEXT_PUBLIC_DEV_PROJECT_ID</code> y navegá a <code>/brain/&lt;project_id&gt;</code>.
          </span>
        )}
      </p>
    </main>
  );
}
