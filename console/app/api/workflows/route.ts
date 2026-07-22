// /api/workflows · los workflows de diseño ELEGIBLES por un proyecto, con sus fases derivadas del
// YAML del registry (misma función del motor). El dropdown de Settings los consume para no
// hardcodear la lista de fases. Read-only, método (no dato de tenant) → sin scope de sesión.
import { NextResponse } from "next/server";
import { designWorkflowOptions } from "@/lib/server/workflowPhases";

export async function GET() {
  try {
    return NextResponse.json({ workflows: designWorkflowOptions() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
