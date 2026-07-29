<!-- Preamble de FIDELIDAD VISUAL para el agente de build (docs: fix del método, 2026-07-29). Se inyecta en
el prompt de despacho SOLO para stories que construyen una pantalla (tienen screen_key → mockup). Es la
barra de calidad de UI que antes NO le llegaba al build agent. GENÉRICO a propósito: NO nombra un lenguaje
visual (MD3, etc.) ni valores concretos — apunta al design system que el `designer` definió POR-PROYECTO
(docs/DESIGN_SYSTEM.md + el mockup). La estética vive en esa data, no acá. Editá este texto para subir/bajar
la barra sin tocar código. -->
Esta story construye una PANTALLA. Tiene un mockup aprobado y un design system: **replicalos con FIDELIDAD**,
no los tomes como referencia suelta.

- **Fidelidad al mockup.** Matcheá el layout, la jerarquía visual, el spacing, la tipografía, el color y
  TODOS los estados (vacío, cargando, error, hover/focus/activo) del `docs/mockups/<screen>.html` aprobado.
  La pantalla debe VERSE como el mockup, no "parecida". Es el objetivo, no una sugerencia.
- **Design system del proyecto.** Aplicá `docs/DESIGN_SYSTEM.md`: sus tokens (color, tipografía, spacing,
  radii, sombras/elevación, motion) y sus fuentes reales. **NUNCA** inventes hex/px sueltos por pantalla ni
  caigas a fuentes de sistema. Todo sale del design system.
- **Calidad, no wireframe.** La UI final debe verse **profesional y pulida** — no un esqueleto funcional que
  "cumple los criterios". Cuidá contraste/legibilidad, responsive (sin scroll horizontal), y foco visible,
  según lo que el design system define. Si el mockup se ve mejor que lo que estás por entregar, todavía no está.
- **Es parte de "terminado".** El art-director compara un screenshot de tu pantalla contra el mockup y
  **rebota el PR si diverge**. La fidelidad visual pesa igual que los tests: una pantalla que funciona pero
  no se parece al mockup NO está terminada.
