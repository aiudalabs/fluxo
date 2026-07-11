# 00 · Visión y alcance

## Qué es Fluxo
Una **fábrica de software gobernada, para agencias**. Toma el brief de un cliente en español, lo convierte en un
**backlog gateado y trazable** (discovery → PRD → arquitectura → UI → backlog, con aprobación humana en cada fase),
lo ejecuta con agentes en **el GitHub del cliente**, y guarda todo el conocimiento en un **registro auditable (el
brain)** que la agencia le muestra al cliente.

## El moat (lo que sobrevive a la commoditización)
Generar un spec/backlog ya es gratis (GitHub Spec Kit) y correr agentes multi-modelo viene incluido en Copilot
(Agent HQ). **No competimos ahí.** Lo que se cobra es el **envoltorio**:
- **Registro auditable y persistente** por proyecto/cliente (decisiones, respuestas de gates, diseños rechazados,
  provenance requisito→issue→PR) — lo que el vibecoding pierde. *Esto es el producto.*
- **Gates humanos como workflow** + **UI de equipo** (grafo de deps + click-para-despachar + preview en vivo).
- **Español-first**, en el propio GitHub del cliente, sin lock-in del modelo.

## ICP
Agencia / dev-shop boutique **LATAM**, 3-20 devs, que entrega software a la medida a clientes externos sobre GitHub.
Vendido como plan de **agencia** ($199-500/mo) o done-with-you — **NO** self-serve por asiento.

## Modelo de negocio (credenciales/plata)
La ejecución corre en el GitHub del cliente con **sus** credenciales (su Copilot / sus keys de Claude en su org) →
cero COGS para Fluxo, sin revender compute. El tier "managed keys / factura única" es un **runtime cloud opcional**
(upsell), NO el default. Ver `02-capa-runtime.md`.

## Lo que NO somos
- No es para el indie/vibe-coder "idea→app" (eso es Lovable/Bolt/v0).
- No es un CLI para un dev solo (eso es Spec Kit).
- No reimplementamos el runtime multi-agente de GitHub — lo **envolvemos**.
- No somos multica (referencia externa del patrón de runtimes; despacha tickets sueltos — nosotros orquestamos
  sprints/deps/gates ARRIBA del runtime).

## Definición de "terminado" (norte del proyecto)
El `05-ejemplo-e2e.md` (la peluquería de Doña Rosa) corre **de punta a punta**: idea → diseño gateado → backlog en su
GitHub → agentes implementan (mobile + web + backend) → verificación real (no solo "arranca") → PR → web publicada +
app móvil distribuida → todo trazable en el brain → un change-request re-entra el ciclo. Incluye la **última milla**
que la auditoría marcó faltante (ver `03-roadmap.md`, fase "Entrega").
