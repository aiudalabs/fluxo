import Registry from "./Registry";

// F-registry · el método visible: agents/skills/workflows/providers/templates que Fluxo usa, +
// el prompt EXACTO que se manda al engine por corrida. Read-only (ver v1 RegistryView; el CRUD
// no-code queda diferido). Context/nav del layout de proyecto.
export default function RegistryPage() {
  return <Registry />;
}
