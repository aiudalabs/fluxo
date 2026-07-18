# 10 · Backlog de CALIDAD DE BUILD (hallazgos de validación por ejecución)

> Backlog **acumulativo** de defectos observados **ejecutando** proyectos que Fluxo construyó (no
> leyéndolos). Es feedback sobre el **método** (registry: agents/skills/workflows/gates), no sobre la
> plataforma. Fuente inicial: validación de **Idearium** (2026-07-18, n=1) por un agente que corrió el
> proyecto. Varios hallazgos son **estructurales**, no accidentales. **Vienen más issues** — este doc crece.

---

## ⭐ EL PATRÓN RAÍZ (lo más importante)

**Fluxo escribe lógica de negocio y arquitectura excelentes, pero STUBBEA las fronteras de I/O y
después construye tests + métricas que CERTIFICAN el stub como éxito.**

El idiom es siempre el mismo: una *"interfaz intercambiable cuyo docstring describe la implementación
de producción que no existe"* (`"A real deployment swaps this for..."`), cableada con un doble
en-memoria en los tests. Resultado: una suite verde que prueba la lógica (scheduling/templating —
real y buena) pero da la **falsa impresión de que la entrega funciona**. La suite verde NO es
evidencia de los requisitos P0 de entrega.

**El error conceptual central: confunde "cableado" (wired) con "conectado" (connected).**

> Regla derivada: si el agente arregla la mentalidad de **"no auto-certificar stubs"**, los 7 errores
> de abajo se caen solos (los puntos 1–3 de recomendaciones son el mismo problema desde 3 ángulos).

---

## Lo que Fluxo hizo GENUINAMENTE BIEN (no romper al arreglar)

Verificado ejecutando Idearium:
- **Lógica de negocio sólida y correcta.** 134 tests backend + 175 Flutter pasan, `analyze` limpio, APK
  compila (54 MB), corre en emulador, login real contra el backend, integración full-stack real (ítem
  creado por API apareció en la UI).
- **Cifrado AES-256-GCM real** (crypto.py, TypeDecorator) — contenido NO en texto plano en la DB.
- **OAuth de verdad**: PyJWKClient contra los JWKS reales de Google/Apple, RS256 + audience + issuer. No mockeado.
- **NLP temporal honesto**: devuelve `None` ante ambigüedad, nunca auto-aplica — sugiere y el usuario confirma.
- **Aislamiento cross-tenant correcto**: 404 (no 403) para no filtrar IDs. Verificado usuario B ↛ datos de A.
- **Arquitectura de fondo buena**: interfaces intercambiables, máquinas de estado limpias, delete atómico que propaga al grafo.

---

## Los 7 errores concretos (Idearium)

| # | Requisito | Qué está mal | Cómo se verificó |
|---|---|---|---|
| 1 | **FR-12 push (P0)** | `LoggingPushSender` es el ÚNICO sender: loguea y devuelve `True`. Sin FCM/APNs, sin `google-services.json`/`firebase_options.dart`. | En vivo: `delivery_rate = 1.0` enviando CERO pushes. NFR-07 se auto-certifica. |
| 2 | **FR-29 reset email** | `LoggingEmailSender` por default. La API responde "recibirás instrucciones" pero el email va a un log — que además **imprime el token de reset en texto plano**. | Request de reset → solo una línea de log. |
| 3 | **NFR-06 refresh token** | `AuthApiClient.refresh` existe pero tiene **cero call sites**. La sesión rompe a los 15 min: ni refresca ni desloguea. | grep exhaustivo en `lib/` y `test/`. |
| 4 | **FR-11 (data loss)** | `calendar_screen._reassign` hardcodea `scheduledEndAt: null` → reagendar un bloque con duración **borra la duración silenciosamente**. | En vivo: bloque 10:00–12:00 → reasignar inicio → `end: None`. |
| 5 | **Secretos** | `jwt_secret_key="dev-secret-change-me"`, clave AES y salt son defaults funcionales. **Arranca en prod con clave JWT pública** (falla ABIERTO). | Lectura de config.py; nada impide el boot. |
| 6 | **CI** | `suite-integrity.yml` protege contra borrar tests, pero **ningún workflow los EJECUTA**. Vigila tests que nunca corre. | Ningún workflow invoca `pytest`/`flutter test`. |
| 7 | **Deploy** | Sin Dockerfile, sin DB de prod elegida (SQLite default no serverless), y el APK release apunta a `api.idearium.app` que es **NXDOMAIN**. | `nslookup` + inspección del build. |

**Menor confianza** (análisis estático, no verificado en ejecución): layout del grafo O(n²) por tick
(jank a ~500 nodos en el layout inicial). FR-24 (filtrado grafo) / FR-16 (recurrentes) ausentes — pero
nunca estuvieron en el backlog → gap **spec→backlog**, no de ejecución.

---

## Las 7 recomendaciones (el fix del MÉTODO)

1. **Nunca cablear un `Logging*`/`InMemory*` como default de PRODUCCIÓN en un requisito P0 de I/O.** O
   se implementa la integración real, o el stub **falla ruidosamente**, o el requisito se marca
   **explícitamente NO-HECHO** en el backlog. Prohibido el default silencioso.
2. **Ninguna métrica debe medir el valor de retorno de un stub.** `delivery_rate = 1.0` desde un sender
   que siempre devuelve `True` es la señal de alarma. Las métricas de éxito miden el **efecto real**.
3. **Distinguir "cableado" de "hecho" en el status reportado.** Si algo está conectado a un placeholder,
   el reporte lo dice — no lo declara completo.
4. **Emitir la historia de deployment**: Dockerfile, DB de producción, config real — o marcarlos
   **diferidos explícitamente**. No dejar un default de dev como si fuera desplegable.
5. **Secretos que fallen CERRADOS**: negarse a bootear en prod con los defaults de desarrollo.
6. **El CI debe EJECUTAR los tests que protege**, no solo contar marcadores.
7. **Validar por EJECUCIÓN, no por suite verde**, en las fronteras de I/O: un test que capture la llamada
   real (o el emulador de FCM/Auth) en vez de un doble en-memoria.

---

## Mapeo a lo que YA existe (para no tratarlo como net-new)

- **#6 (CI no corre tests) + #7 (deploy) + recomendación 6–7** ≈ **F7 (verify harness)** del roadmap
  (`03-roadmap.md`): verify como check REQUERIDO, no `continue-on-error`; y **F8 (última milla)**:
  Dockerfile, provisioning de infra/DB/dominio del cliente. Este reporte los **agudiza con evidencia**.
- **El "verde-pero-vacío"** ya es **L-AUTO-3** en `04-lecciones.md` ("el humano era el único QA"). Este
  hallazgo lo **extiende**: no es solo verify-que-skipea, es **stub-certificado-como-éxito** — más profundo.
- **Viola golden rule 6** (`CLAUDE.md`): "NUNCA debilitar un test para que pase". Acá el test no se
  debilita — se **construye alrededor del stub** para que pase. Mismo espíritu, más sutil.
- **El fix es del MÉTODO**: registry/agents (personas que no deben cablear stubs como prod-default),
  registry/skills (el reviewer/verify debe medir efecto real), y los gates (`claude-review.yml` debe
  exigir "connected", no "wired"; `suite-integrity.yml` debe además EJECUTAR).

## Meta-lección propuesta (para `04-lecciones` cuando se implemente)
**L-BUILD-1 · Stub certificado como éxito.** Un requisito P0 de I/O cableado a un `Logging*`/`InMemory*`
default + métricas que miden el retorno del stub = falso verde. → El método debe: (a) prohibir el
default de stub silencioso en P0-I/O (falla ruidoso o marca NO-HECHO), (b) métricas que midan efecto
real, (c) status que distinga wired≠connected, (d) verify por ejecución en las fronteras.

---

*Estado: abierto. Más hallazgos de validación se agregan acá (el usuario reportará más issues).*
