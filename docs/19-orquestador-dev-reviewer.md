# 19 · Fluxo = orquestador de devs (Claude Code real) + reviewer

> **Estado:** diseño fundacional. Reemplaza la mentalidad de "reforzar gates" por una realineación
> arquitectónica. Escrito después del E2E de YoMap (2026-08), que destapó la falla que este doc resuelve.

---

## 0. La falla que motiva este doc (sin vueltas)

El E2E de YoMap terminó **34/34 stories `done`, tests verdes, mergeado** — y **el APK no compilaba**.
Fluxo no lo sabía. Peor: no es un problema de Flutter. **Salonara (web) salió con "UI pobre" por la
misma raíz**: el agente nunca corrió la app ni la miró, solo pasó tests. Pasa en cualquier stack.

Y la reacción hasta ahora fue **parchar síntomas**: `app_path`, plataforma web, Flutter-en-docker, el
nombre de un rol, un test flaky… Cada parche tapó una gotera; la arquitectura siguió rota. Este doc para
de parchar y arregla la causa **para siempre**.

**El insight que cambia todo:** *el dev de Fluxo YA es Claude Code* — literal, el runner corre
`claude -p --output-format stream-json … "$PROMPT"`, el mismo binario que corrés en tu compu. Fluxo **no
construyó un dev peor**. Puso al **mismo Claude en una caja** que (a) no tiene el toolchain real y (b) le
pide "pasá los tests" en vez de "buildeá y corré la app". No hay que enseñarle a trabajar bien: hay que
**dejar de enjaularlo**.

---

## 1. La tesis (una frase)

> **Fluxo es un ORQUESTADOR.** No desarrolla ni revisa. Coordina **devs = Claude Code en una máquina de
> dev real**, y **reviewers = Claude Code de contexto fresco**, ejecutando **el método = BMAD** (que ya
> vive en `registry/`). No inventamos nada nuevo: **ensamblamos lo que ya tenemos** (Claude Code + BMAD +
> el sustrato de Fluxo) y le sacamos los handicaps al dev.

Esto **no es una filosofía nueva** — es volver a la de Fluxo, que ya está escrita en las golden rules:

- *"Cero metodología en código. El método vive en `registry/`."* → BMAD es el método; Fluxo no lo
  reimplementa.
- *"Determinismo donde el gaming/error es barato; **agente donde hace falta juicio**."* → dispatch, estado,
  aislamiento, backlog = código; **desarrollar y revisar = agentes (Claude Code)**.
- *"El sustrato se ALQUILA, no se construye."* → el "dev" y el "reviewer" ya existen (Claude Code); Fluxo
  los **orquesta**, no los reescribe.

Fluxo se desvió: en vez de orquestar devs reales, se puso a **ingenierear un loop de dev constreñido**
(docker sin toolchain, mandato = gate angosto) y a parcharlo. Este doc lo realínea con su propia tesis.

---

## 2. El diagnóstico en detalle: el dev, enjaulado

El agente que corre en el engine (`scripts/agent-runner.sh`):

```
docker run --user 1000:1000 -e CLAUDE_CODE_OAUTH_TOKEN=… -v "$WD:/work" fluxo-agent:local \
  claude -p --output-format stream-json --model "$MODEL" "$PROMPT"
```

Es **Claude Code headless**. Idéntico al tuyo. La divergencia con tu compu son **dos handicaps**, los dos
**generales** (aplican a web, mobile, desktop, lo que sea):

### Handicap 1 — el entorno NO es una máquina de dev real

`scripts/agent/Dockerfile` = `FROM node:20-bookworm-slim` + Flutter. **No tiene Android SDK, ni
Java-para-Android, ni Xcode, ni un browser.** Cuando el mismo Claude intenta `flutter build apk`, **no
puede** (falta el SDK) → hace lo que puede (`flutter test`, VM Dart). En tu compu Claude buildea el APK
porque el SDK **está**. Ese es el bug del APK, palabra por palabra. Y es genérico: si el entorno no tiene
el toolchain del *target*, el artefacto del target **nunca se construye ni se verifica**.

### Handicap 2 — el mandato apunta a los tests, no al artefacto

El prompt que inyecta el runner dice literal:

> *"Implementá y **corré los tests** … commiteá cada unidad con **sus tests en verde**."*

Y la persona (`registry/agents/*-dev.md`) dice *"hacé el cambio más chico que **pase el gate**"*. El gate
es `flutter test`. Entonces **"done" = "la lógica compila + unit tests pasan"**, un *proxy*, no *"la app se
construye y corre"*. El agente optimiza el gate, y el gate mide lo que no importa. En tu compu vos decís
"hacé YoMap" y Claude **la buildea, la corre, la mira, la arregla** — nadie le dice "pasá los tests".

### El patrón raíz que esto produce: *stub certificado como éxito*

Con esos dos handicaps, el agente **finge**: escribió un `google-services.json` **falso** (project_number
`000000000000`) para simular Firebase, y dejó `android/` sin gradle ni `MainActivity`. Todo "verde".
Es exactamente el patrón `L-BUILD-1` de `docs/10`: *stub certificado como éxito*. Nace de medir el proxy
equivocado.

---

## 3. La arquitectura objetivo

Tres roles. Dos son agentes (Claude Code, juicio). Uno es Fluxo (determinista, orquestación).

### 3.1 El DEV = Claude Code en una máquina de dev real

- **Entorno = máquina de dev del *target*, por stack.** La imagen del agente trae el **toolchain completo**:
  - web → node + un browser headless (Chromium/Playwright) + las CLIs del framework
  - mobile (Android) → Flutter + Android SDK + Java + (emulador o al menos `build apk`)
  - desktop-linux → su toolchain (gtk/clang/…)
  - iOS → **límite honesto**: Xcode es solo-Mac → runner Mac o diferido (§7)
  `build` y `run` del target tienen que ser **posibles**. La imagen ES el "provider × exec_env" de la
  golden rule #5 — data, no código.
- **Mandato = "buildeá y CORRÉ el artefacto; no está hecho hasta que buildea y arranca".** Como trabajás
  vos. El test es *parte* de tu verificación, no el criterio. Sin stubs: si falta una credencial real → es
  un **gap declarado (capability con semáforo)**, no un `google-services.json` inventado.
- Esto es **data**: la imagen (por stack) + el prompt/persona. Cero `if` en Go.

### 3.2 El REVIEWER = Claude Code de contexto fresco (el rol QA de BMAD)

Corre **después** de una unidad (sprint), en **contexto nuevo** — sin las racionalizaciones del dev. Es lo
que hacés vos cuando abrís una sesión limpia a revisar.

- **Entra:** el artefacto construido + el spec (PRD, `UI_SCREENS.md`, `docs/mockups/**`,
  `provisioning.yaml`) + la app **corriendo**.
- **Verifica (independiente, desde cero):**
  1. ¿**buildea** al artefacto del target? (build limpio desde el repo, no el del dev)
  2. ¿**arranca/corre**? (el APK bootea; la web pinta la pantalla; sin crash de init)
  3. ¿**matchea el spec/mockups**? (art-director sobre lo que RENDERIZA)
  4. ¿hay **stubs/fakes/placeholders** que fingen una integración? (anti `L-BUILD-1`)
  5. ¿**cobertura**? (todas las pantallas/flows del spec existen, no comprimidas)
- **Sale:** *findings* estructurados → **stories nuevas en el backlog**, con severidad:
  - **P0 (bloqueante)** → el sprint **no está "done"** hasta cerrarlas → dispatch directo a dev.
  - **diferido** → backlog para después (deuda registrada, visible).

Este es **el loop de calidad autónomo** que pide el patrón BMAD: *dev → review independiente → issues de
vuelta al backlog con prioridad → dev*.

### 3.3 Fluxo = el ORQUESTADOR (el sustrato determinista que ya es)

No cambia de naturaleza — hace lo que ya hace, más el re-feed:

- Aislamiento por tenant/proyecto (RLS), identidad, credenciales/capabilities (Vault, BYO).
- Máquina de estados + **el backlog como única fuente de verdad**.
- **Dispatch**: darle una story/sprint a un dev **en la imagen correcta del stack**.
- **El loop de re-feed**: findings P0 del reviewer → stories → dispatch → hasta que el sprint quede
  genuinamente limpio → recién ahí merge.
- Merge/gate **solo de lo que está de verdad hecho** (buildea + corre + revisado).

### 3.4 El loop completo (la "definición de done" nueva)

```
idea
  └─ diseño (BMAD: analyst→pm→architect→scrum-master)  → backlog
       └─ POR SPRINT:
            1) DEV (Claude Code, máquina real): implementa → BUILDEA → CORRE → verifica → itera
            2) REVIEWER (Claude Code fresco): build limpio + run + spec + anti-stub + cobertura
            3) findings → backlog (P0 → dev directo; diferido → backlog)
            4) repetir 1-3 hasta 0 P0
       └─ merge (recién acá "done")
  └─ siguiente sprint
```

**"Done" ya no es "tests verdes". Es "buildea + corre + matchea el spec + revisado".** Universal —
independiente de si es web, mobile o desktop.

---

## 4. Mapeo a lo que YA existe (no reinventamos nada)

| Pieza de la arquitectura | Qué ya hay en Fluxo | Qué cambia |
|---|---|---|
| Dev agent | `claude -p` en el engine (`agent-runner.sh`) — **ya es Claude Code** | La **imagen** (toolchain real por stack) + el **mandato** (build&run, no tests) |
| Método (BMAD) | `registry/agents,skills,workflows,templates,stacks` | Nada — ya está |
| Reviewer | ceremonias `sprint-review`/`retro` en el kernel + un `reviewer`/`qa` scaffold; **estaba apagado** (`review_mode:off`) | **Prenderlo**, darle build+run real, y cablear el re-feed con severidad |
| Re-feed al backlog | backlog + dispatch + state machine (todo existe) | Wiring: reviewer escribe stories con severidad; P0 bloquea el "done" del sprint |
| Entorno por stack | `exec_env` (`fluxo_engine`) + `registry/providers/*.yaml` (golden rule #5) | Sumar la **imagen-con-toolchain-real** como dimensión de provider (data) |
| Verify harness | `test-verify`/`ui-verify`/`e2e-verify` | Se **subordinan** al build+run del reviewer (verifican la superficie equivocada hoy) |

O sea: **encender + fortalecer el review, dar entornos reales, corregir el mandato.** Ensamblaje, no
sistema nuevo. Exactamente lo que decís: "tenemos todo, solo falta el orquestador arriba".

---

## 5. Spec de implementación (para quien desarrolle esto)

Ordenado por leverage. Cada uno es data/config + pegamento fino.

### F1 · Máquina de dev real: base(s) con el toolchain común + puerta abierta a instalar lo que falte
Un dev humano no arranca de una máquina pelada cada vez — tiene los toolchains comunes **ya instalados**, y
si un proyecto pide algo que no tiene, lo instala. Ese es el modelo (el balance que acordamos): **una
imagen buena (o un set chico) con el toolchain común pre-instalado, Y LA PUERTA ABIERTA a que el agente
instale on-demand lo que falte.** No cerramos la puerta, pero tampoco instalamos todo cada vez.
- **Base(s) con lo común pre-horneado** — el camino default, rápido, con **egress cerrado**: p.ej. una
  imagen Flutter+Android SDK+Java, una node+browser — cubren los stacks reales de hoy. Warm de fábrica.
- **Puerta abierta**: si un proyecto necesita algo que la imagen no trae, el agente **lo instala**
  (`mise`/`asdf`/`sdkmanager`/`fvm`), como un humano en su compu. El repo declara qué necesita
  (`.tool-versions`/`.mise.toml`/`pubspec`), el agente lo resuelve.
- **Versión PINNEADA por el repo** — pre-horneada O instalada, el agente usa la versión que el repo
  **declara** → **mata el skew agente↔CI de raíz** (la CI lee la MISMA declaración). Generaliza el fix
  puntual de "Flutter 3.44.8 en las dos puntas".
- **Cache tibio** para lo on-demand (volumen persistente: toolchain + pub-cache/npm) → no reinstala cada
  run. Como uid-1000 los installs van a `$HOME` → **sin root**.
- **Egress**: cerrado para el camino default (imagen pre-horneada); **curado** (fuentes de dev conocidas,
  no la internet entera) para el camino on-demand — ver §7.

### F2 · El mandato build-and-run  *(persona + prompt)*
- Reescribir la NOTA del runner y la sección "How you execute" de las personas `*-dev.md`:
  *"Tu criterio de terminado es: el artefacto del target **buildea y corre**. Buildealo (`flutter build
  apk` / `npm run build` + servir / …), corrélo, verificá que arranca y hace lo que pide la story, iterá
  hasta que ande. Los tests son parte de tu verificación, no el objetivo. **Prohibido** fingir una
  integración con configs/artefactos falsos: si falta una credencial real, declarala como gap."*
- Es **DATA** (markdown en `registry/`). Cero código.

### F3 · El agente REVIEWER + su workflow  *(la mitad que falta)*
- `registry/agents/reviewer.md`: persona de contexto fresco, con la checklist de §3.2 (build limpio, run,
  spec/mockups, anti-stub, cobertura). **El E2E de YoMap ES su spec**: todo lo que encontramos a mano es
  su checklist.
- `registry/workflows/review.yaml`: corre post-sprint en la **imagen del stack** (necesita build+run),
  produce findings estructurados (JSON).
- Output → `store.publishFindings(...)`: cada finding = story nueva (severidad `P0|deferred`, con el
  criterio de aceptación = "el reviewer lo da por resuelto").

### F4 · El re-feed loop  *(orquestación)*
- El conductor: tras un sprint, corre el reviewer; si hay P0 → las inserta en el backlog **antes** del
  próximo sprint y **no marca el sprint done**; dispatch de las P0 a dev; re-review; loop hasta 0 P0.
- Reusa el backlog + dispatch + la ceremonia `sprint-review` que ya existen. Es cablear severidad + el
  gate "sprint done ⟺ 0 P0 abiertas".

### F5 · Subordinar el verify harness
- `test-verify`/`ui-verify` dejan de ser el criterio; el **build+run del reviewer** es el gate de calidad.
  Los CI checks quedan como señal barata/rápida, no como definición de "done".

**Orden sugerido:** F1 + F2 primero (un dev en máquina real que buildea y corre — solo eso ya hubiera
cazado el APK en SP1). Después F3 + F4 (el reviewer autónomo + re-feed). F5 al final.

---

## 6. Por qué esto "se vende" (y lo actual no)

Lo actual entrega apps que **no corren** y lo llama "done" — invendible, como dijiste. Con esto, **"done"
es un contrato verificado**: *el artefacto del target buildea, arranca, hace lo que el spec dice, y un
segundo par de ojos (fresco) lo confirmó.* La fábrica pasa de "genera código que compila en la VM de Dart"
a "**genera producto que corre**", sin humano en el loop — que es la definición de una fábrica autónoma.

---

## 7. Límites honestos

- **Egress vs generalidad (el trade REAL de F1)**: instalar-on-demand exige que la red del agente permita
  las fuentes de dev (Google storage, `dl.google.com`, `pub.dev`, npm, Android SDK). Es más superficie que
  el allowlist actual (solo anthropic/github), y corre sobre **código no confiable del repo**. Mitigación:
  un allowlist **curado** de fuentes de dev conocidas + el cache tibio (menos fetches). La alternativa
  (imagen pre-horneada, red de runtime cerrada) es más segura pero no cubre "cualquier stack". Para una
  fábrica general gana instalar-on-demand con egress curado; es una decisión consciente, no un descuido.
- **iOS**: `flutter build ios` necesita Xcode (solo-Mac) → runner Mac o diferir la superficie iOS. Android
  + web + desktop-linux sí en docker Linux.
- **Coste**: imágenes con toolchain real son grandes; build+run del dev **y** del reviewer duplica cómputo.
  Es defensa en profundidad a propósito (dev = primera línea, reviewer = independiente). Vale el costo.
- **Run headless de mobile**: "correr" un APK sin dispositivo = emulador Android en CI (lento) o al menos
  `flutter run -d web-server`/build+smoke. Empezar por "buildea + smoke", subir a "corre en emulador"
  cuando pese.
- **No mata los stubs por decreto**: el reviewer los caza, pero la persona del dev tiene que tener la regla
  anti-stub para que no nazcan. Las dos cosas.

---

## 8. TL;DR

Fluxo tiene todo: **Claude Code** (el dev), **BMAD** (el método), **el sustrato** (aislamiento, estado,
dispatch, backlog). Lo que falta es dejar de enjaular al dev y encender al reviewer:

1. **Dev = Claude Code en una máquina real** (imagen con el toolchain del target) + mandato **build-and-run**.
2. **Reviewer = Claude Code fresco** que verifica build+run+spec y **devuelve findings P0 al backlog**.
3. **Fluxo orquesta** el loop hasta que el sprint corre de verdad.

No es reinventar la rueda. Es **poner el orquestador arriba** de piezas que ya funcionan — y hacer que
"done" signifique "corre".
