import { ProjectShell } from "@/lib/project";

// Project-first layout: establishes the project context (supabase client + tenant token
// on the realtime socket) ONCE and renders the nav between the project's views. Child
// pages (studio/board/brain) render only their surface — they don't re-arm context.
export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <ProjectShell projectId={projectId}>{children}</ProjectShell>;
}
