# 23 · Blueprint del sucesor — BMAD + delegación total al harness

> **Estado:** borrador de dirección (2026-08-08), escrito junto con la radiografía (`docs/21`) y el
> análisis de agentes (`docs/22`). NO es un roadmap comprometido: es la hipótesis de diseño a validar
> con el experimento de §6.

## 0. El objetivo en una frase

Conservar lo que Fluxo demostró que vale (método gateado, review independiente, gates deterministas,
trazabilidad) **eliminando el sustrato propio de ejecución** — que es donde se fueron los días de
operación y 15 de los 17 incidentes.

La prueba ácida del sucesor: **"probar la app construida" tiene que costar lo mismo que con Claude
Code a mano** (`flutter run`, un preview channel de hosting) — porque ES Claude Code quien lo hace.

## 1. Principios (los invariantes del diseño)

1. **Cero orquestación propia.** Ni worker, ni scheduler, ni motor de workflows, ni runner de agentes,
   ni infra de preview. Si una necesidad parece pedir uno, la respuesta es un harness existente o no
   se hace. *(Señal de alarma: el día que escribamos un loop que "pollea una cola", paramos.)*
2. **Una sola fuente de verdad por estado.** El backlog vive en GitHub Issues/Projects. El código y su
   historia en git. Las decisiones en markdown en el repo. No hay Postgres espejo que reconciliar.
3. **El método es texto versionado en el repo del proyecto.** Personas, gates, contratos de verify —
   heredados del `registry/` de Fluxo, colgados del esqueleto BMAD, instalados como archivos
   (`.claude/`, `docs/`, `.github/`) por el scaffold inicial.
4. **Delegar la ejecución, no la responsabilidad.** El harness hace; los GATES deciden. Los tres gates
   con evidencia de Fluxo se conservan como CI del repo (no como servicio nuestro): provisioning-lint,
   test-verify, y el reviewer fresco con mandato build+RUN.
5. **Money-safe por construcción.** Nada dispara gasto sin un humano o un gate aprobado; toda entrada
   se valida ANTES del primer token pago (lección del run sobre el pedido vacío).
6. **Un solo cliente hasta que duela.** Nada de multi-tenant/RLS/Vault/billing hasta el segundo
   cliente pagando. La agencia opera por repo, no por plataforma.

## 2. Arquitectura propuesta (lo mínimo que cierra los 6 casos de uso)

| Caso de uso (docs/21 §4) | Fluxo v2 (construido) | Sucesor (delegado) |
|---|---|---|
| Idea → backlog gateado | design_runs + Studio + worker | **BMAD en Claude Code** (fases + gates del framework); salida = docs/ + issues |
| Backlog → código | engine propio en VPS | **Issue asignado al agente** (Claude Code Actions o Copilot coding agent); un issue = una rama = un PR |
| Review independiente | build_jobs kind=review + poller | **Práctica portada**: workflow/slash-command "reviewer fresco, build+RUN, findings, P0 reabre" |
| App corriendo | preview-runner + emulador + shim + seed | **Lo que el stack ya da**: `flutter run` / emulador local del harness, preview channels de Firebase Hosting / Vercel para demos al cliente |
| Incrementos | increment_requests + iterate.yaml | **Sesión BMAD de delta** sobre el repo existente → issues nuevos |
| Trazabilidad | brain en Postgres + console | **El repo ES el brain**: docs/ + issues + PRs + decisiones en markdown |

Piezas de código propio previstas: **el scaffold** (instala método+gates en un repo nuevo) y, si hace
falta, **un CLI fino** de conveniencia. Presupuesto: si el pegamento supera ~1-2k LOC, releer §1.

## 3. Qué se carga de Fluxo, literalmente

- `registry/agents/*.md` → personas (dev por stack, reviewer, art-director, iteration-planner) como
  agentes/skills del harness.
- `registry/stacks/*.yaml` + templates → manifiestos de stack + scaffold de CI (los workflows de
  verify ya corren en Actions hoy; se llevan casi tal cual).
- `provisioning-lint` completo (motor genérico + tablas por stack).
- El mandato del reviewer (docs/19 §3) y el formato de findings con severity.
- `docs/04-lecciones.md` + la tabla de incidentes de `docs/21 §5` → contratos del método del sucesor.
- El contrato preview-aware del stack flutter-firebase (P1 de docs/20) — útil igual en local.

Qué NO viaja: design/src (9.7k LOC), console (13.4k), scripts del VPS (1.1k), las 27 migraciones.

## 4. Riesgos principales (del premortem — detalle en docs/22)

Los tres que más pesan y su mitigación de diseño:
- **"Reconstruimos Fluxo sin darnos cuenta"** → el presupuesto duro de LOC de pegamento + el invariante 1
  con su señal de alarma explícita.
- **"El harness delegado no rinde cuentas"** → los gates viven en CI del repo (no en el harness) y el
  reviewer fresco es obligatorio para cerrar sprint; "done ⟺ 0 P0" se conserva.
- **"BMAD cambia o no encaja"** → BMAD se usa como esqueleto vendored (copiado al repo), no como
  dependencia viva; nuestras personas/gates son nuestros archivos.

## 5. Qué decide el research de mercado (docs/22 §3)

La elección concreta del ejecutor delegado (Claude Code Actions vs Copilot coding agent vs ambos según
repo), y si algún builder con preview nativo cubre la demo-al-cliente mejor que los preview channels
del stack. El blueprint no se casa con un vendor: el método es texto y corre en cualquiera.

## 6. El experimento de validación (antes de comprometer nada)

**Un producto chico real, de punta a punta, SIN tocar Fluxo:**
1. Scaffold de un repo con método BMAD + gates portados (un día de trabajo, máximo).
2. Diseño gateado en Claude Code (BMAD) → issues en GitHub.
3. Ejecutar 1 sprint delegando issues al agente elegido.
4. Review fresco con build+RUN antes de cerrar.
5. Demo navegable al final (preview channel del stack).

Criterios de éxito (mismas métricas de vida-o-muerte del premortem): idea→demo en < 1 día de reloj,
$ por sprint ≤ el de Fluxo, **cero incidentes de infra propia**, y el dueño operando solo desde el
harness + GitHub. Si falla, se documenta por qué y se decide con datos.

## 7. Qué pasa con Fluxo v2 mientras tanto

- **Freeze de features**: no se construye F5/F9/F10. Solo se mantiene lo desplegado (YoMap sigue
  operable; los previews siguen sirviendo para demos).
- El VPS y prod quedan como están hasta que el experimento de §6 dé veredicto.
- Nada se borra: `main` + este paquete de docs son el archivo permanente del aprendizaje.
