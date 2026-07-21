# registry/capabilities/ — integraciones externas BYO como data

Una **capability** es una integración externa que el cliente **posee** (BYO, cero COGS — D7):
Firebase, Vercel, Supabase, Railway, Gemini, Test Lab… Cada una vive como un `.yaml` (data,
golden rule #1/#5). Decidido en **D8** (`docs/06-decisiones.md`); secuencia de construcción en
**P6-2b** (`docs/11-sprints-pendientes.md`).

## Por qué existen

El E2E (2026-07-20) probó que el scrum-master emitió un AC **no-despachable** en S-fbmig-1:
*"Existe el proyecto Firebase en plan Blaze con billing account configurada"* — ningún agente crea
un proyecto GCP + billing. Una story de **build** con **provisioning humano** adentro rompe el
self-serve para todo stack con provisioning. La cura es método + data: declarar la frontera humana
como capability, y un gate determinista que caza cuando se cuela en un AC.

## Schema (`<id>.yaml`)

```yaml
id: firebase                 # requerido (validate.py exige top-level id)
name: Firebase
provisioning:                # la grada HUMANA: lo que el usuario crea one-time
  summary: "..."             # qué crea el humano (resumen)
  guide: "https://…"         # link guiado para el onboarding
  markers: ["plan blaze", …] # frases que, en un AC de BUILD, delatan provisioning colado (las lee el gate)
secret:                      # el/los secret(s) BYO que el usuario siembra (Actions secret)
  name: FIREBASE_SERVICE_ACCOUNT
  kind: service_account_json
  description: "..."
probe:                       # cómo el onboarding verifica 🟢 el secret
  kind: firebase_service_account
  hint: "..."
emulator: true               # true ⇒ el agente construye/testea local contra el emulador (sin proyecto real)
```

## Cómo se usa (data-driven, cero metodología en código)

1. **El stack declara qué capabilities necesita** — `registry/stacks/<stack>.yaml` `capabilities: [...]`.
2. **El architect** vuelca a `docs/provisioning.yaml` la grada `accounts:` (frontera humana), cada
   item referenciando una `capability`.
3. **El scrum-master** NUNCA re-enuncia un item de `accounts` como AC de build: referencia el secret
   (`deploy usando $FIREBASE_SERVICE_ACCOUNT`) y emite solo ACs que el agente cumple (build + test
   contra el emulador; deploy contra el proyecto ya concedido).
4. **El gate determinista** (design-time, `design/src/repodocs.ts` + `handoff.ts`) cruza los ACs del
   backlog contra los `markers` de las capabilities de frontera humana y **reporta** al brain
   (`handoff_backlog_provisioning_leak`) si alguno se coló — misma convención de reporte-no-traba que
   `uncoveredScreens`/`missingMockups` (parse heurístico).
5. **El onboarding self-serve** (P6-2) resuelve cada capability: checklist + link guiado + siembra el
   secret + probe 🟢; el **readiness gate** del dispatch no despacha una story hasta que su capability
   esté 🟢.
