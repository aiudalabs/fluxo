import { Suspense } from "react";
import Studio from "./Studio";

// F6-02 · Studio for the current project. The project layout supplies context (client +
// tenant token) and nav; this page renders only the Studio surface. Suspense: Studio usa
// useSearchParams (?run=) → Next lo exige envuelto para el prerender.
export default function StudioPage() {
  return (
    <Suspense fallback={<div className="studio-shell"><div className="placeholder"><span className="spin" /></div></div>}>
      <Studio />
    </Suspense>
  );
}
