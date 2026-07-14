import Spend from "./Spend";

// F-spend · el gasto del proyecto: costo por run (usd + tokens) que el conductor guarda en
// run_costs (parseado del comentario fluxo:cost que postea claude.yml). Context/nav del layout.
export default function SpendPage() {
  return <Spend />;
}
