# 20 · Que la app SALGA CORRIENDO — emulador para el preview + keys guardadas para el build real

> **Estado (2026-08-07):** dirección ACORDADA con el usuario. Reemplaza el
> enfoque "derivar el config del SA" que se exploró en la sesión anterior (over-engineered). El core
> derivado (`scripts/provision-runtime-config.sh`, commit `51b94a3`) queda como alternativa opcional,
> NO como el camino elegido.
>
> **P1 + P2 CONSTRUIDOS** (2026-08-07): convención preview-aware en el método + receta de preview con
> emulador, seed y edge same-origin. 11 tests nuevos (315/315 en verde, typecheck limpio). **Todavía NO
> validado en vivo** — falta rsync del registry+runner al VPS y una corrida real. Ver §6.

## 0. El problema (feedback del usuario, sin vueltas)

Fluxo pide/siembra el `FIREBASE_SERVICE_ACCOUNT` (server-side, para el CI/deploy) pero **nunca el
config de RUNTIME que la app necesita para CORRER** — `google-services.json`/`firebase_options.dart`
real + la Google Maps API key. Por eso el artefacto **compila pero no arranca de verdad** (mapa en
blanco, Firebase no conecta) y **"App en vivo" muestra el cascarón, no la app**. Una fábrica que
entrega apps "a medias" no se vende.

## 1. La tesis correcta (la que acordamos)

Separar **dos modos** que se estaban mezclando:

| | Firebase | Google Maps |
|---|---|---|
| **App en vivo (preview, EVALUAR)** | **EMULADOR** + proyecto `demo-*` + seed → cero credenciales reales | key guardada, o mapa mock |
| **Build REAL (deploy a usuarios)** | `google-services.json` **que el usuario nos da**, guardado e inyectado | key guardada e inyectada |

- **Preview = emular.** El Firebase Local Emulator Suite corre con un proyecto **demo** (`demo-yomap`):
  un `google-services.json`/`firebase_options.dart` con `project_id: demo-*` y valores dummy que apuntan
  al emulador. Auth/Firestore/Functions/Storage → **todo emulado**, + **seed data** → el preview arranca
  **poblado y navegable**, sin una sola credencial real ni tocar el Firebase de verdad del cliente.
  (Mismo espíritu que la receta `react-supabase` con `SEED_DEMO` + `supabase-emulation.sql`.)
- **Lo único que NO se emula: Google Maps** (los tiles vienen de Google). En el preview: una Maps key
  guardada (restringida) **o** un mapa mock/placeholder con un cartelito.
- **Build real = guardar-y-usar.** Para lo que se despliega a usuarios finales, el usuario **da una vez**
  el `google-services.json` + la Maps key; Fluxo los guarda (**tenant credentials en Vault**) y los
  **inyecta al compilar**. Sin magia de derivar — simple, honesto, robusto.

**Requisito único para que el emulador funcione:** la app tiene que **apuntar al emulador en modo
preview** (leer `FIREBASE_*_EMULATOR_HOST` / un flag). Se hace **convención del scaffold**: el
`flutter-dev` genera la app "preview-aware" — si la env del emulador está seteada, conecta ahí; si no,
usa el config real. Chico y limpio.

## 2. Piezas a construir

### P1 · App "preview-aware" (convención del scaffold) — MÉTODO (data)
- `registry/agents/flutter-dev.md` (+ el template/persona): la app inicializa Firebase leyendo
  `FIREBASE_*_EMULATOR_HOST` (o un `--dart-define=USE_FIREBASE_EMULATOR`) y, si está, llama
  `useFirestoreEmulator`/`connectAuthEmulator`/etc. Sin la env → config real (build de deploy).
- Es la única pieza que toca lo que el dev genera. Todo lo demás es infra/preview.

### P2 · Receta "App en vivo" para Flutter con emulador — INFRA (registry + preview-runner)
- `registry/templates/github-native/aiuda-flutter-firebase/.fluxo/preview/` (hoy NO existe; solo
  react-supabase tiene receta). Contenido:
  - `compose.yml.tmpl`: (a) service `emulator` = firebase-tools corriendo `firebase emulators:start
    --project demo-yomap` (Auth+Firestore+Functions+Storage); (b) service `build` = imagen flutter,
    corre `flutter build web --dart-define=USE_FIREBASE_EMULATOR=true --dart-define=FIRESTORE_EMULATOR_HOST=...`
    apuntando al emulador, one-shot; (c) service `web` = `caddy:2-alpine` file_server sirviendo
    `build/web` con **SPA-fallback** (`try_files {path} /index.html`) — necesario porque el
    preview-runner health-chequea `/api/health` (línea ~325 de `scripts/preview-runner.sh`) y Flutter
    web es estático → sin fallback daría 404.
  - `edge.Caddyfile`: rutea `/` → `web`.
  - `seed.sh` / `seed data`: poblar el emulador (usuarios demo con password conocida `FluxoDemo123!`,
    datos de ejemplo) para que el preview sea EVALUABLE (bug del 2026-07-29: sin seed arranca vacío).
- El `preview-runner.sh` ya tiene el RECIPE path (líneas 285-308) que renderiza `compose.yml.tmpl` con
  sed y levanta; `$stack` sale de `projects.settings.stack` (línea 235) = `aiuda-flutter-firebase`.
  Verificar el health-check para estático (SPA-fallback) y el naming del container de ingress.
- **Maps en el preview:** inyectar la Maps key guardada (P3) en `web/index.html` antes del build, o
  dejar el mapa mock si no hay key.

### P3 · Store de "keys que el usuario da" — tenant credentials (Vault) + inyección al build real
- Extender `CREDENTIAL_REGISTRY` (`console/lib/server/tenantCredentials.ts:15`) con:
  `GOOGLE_SERVICES_JSON` (base64 del google-services.json real) y `MAPS_API_KEY`. (Es el pending
  explícito de docs/16:79 "sumar las credenciales de capability al modelo tenant-level".)
- UI para que el usuario los suba (`console/app/account/credentials/page.tsx` ya existe para los otros).
- **Materialización al build (el paso que HOY no existe):** un step en los workflows que corren
  `flutter build` (`build-apk.yml.tmpl`, `deploy.yml.tmpl`, `ui-verify.yml.tmpl`, `device-verify.yml.tmpl`)
  que base64-decodea `GOOGLE_SERVICES_JSON` → `apps/<app>/android/app/google-services.json` e inyecta
  `MAPS_API_KEY` en el `AndroidManifest.xml` **antes** del build. **Molde exacto: el keystore** en
  `build-apk.yml.tmpl:80` (`echo "$KS_B64" | base64 -d > release.keystore`). El mismo step va en el
  agent-runner del engine (`scripts/agent-runner.sh`) para que el APK del engine sea real.
- `google-services.json` gitignoreado (no commitear config de env).
- **Gate (cierra con F4):** regla en `provisioning-lint` — `google-services.json` con
  `project_number == 000…` o Maps key placeholder ⇒ **falla**. Hoy el regex anti-placeholder
  (`provisioning_lint.py.tmpl:122`) no caza `MAPS_API_KEY_PLACEHOLDER` → apretarlo.

## 3. Orden sugerido
1. **P2 (receta preview con emulador + seed)** → el win visible: **YoMap corriendo en App en vivo sin
   una credencial real.** Necesita P1 (app preview-aware) para que conecte al emulador — hacer P1+P2
   juntas para YoMap (re-scaffold / corrección) y validar una preview.
2. **P3 (store de keys + inyección al build real + gate)** → para el APK/deploy que el cliente publica.
3. Maps: key guardada (P3) o mock; el mapa renderiza cuando hay key real.

## 4. Lo que YA está hecho (contexto)
- **F4 — reviewer autónomo** (docs/19): construido, desplegado, VALIDADO (cazó un P0 real que los tests
  escondían), de primera clase en la UI. Es el que caza "compila pero no corre".
- **G1 core (derivar del SA)** — explorado y validado (`scripts/provision-runtime-config.sh`,
  `51b94a3`): funciona (registró `com.aiuda.yomap` en reservas-belleza + derivó el google-services.json
  real) pero **NO es el camino elegido** — quedó como alternativa. El camino es §1 (emular + guardar).
- reservas-belleza (`514846756386`) es el Firebase BYO histórico de YoMap; la SA `Fluxo YoMap E2E`
  existe ahí. Para el preview con emulador **no se necesita**.

## 4-bis. Lo CONSTRUIDO en P1+P2 (2026-08-07) y el hallazgo que cambió el diseño

**El hallazgo (verificado contra el source de los plugins, no inferido):** en WEB, los tres SDK de
FlutterFire arman la URL del emulador con **`http://` hardcodeado** — `firebase_auth_web` 6.2.6
(`final String origin = 'http://$host:$port'`), `cloud_functions` 6.3.6 (`_origin = 'http://…'`) y
`cloud_firestore` 6.8.0 (que **descarta** `sslEnabled` en web; el JS SDK computa
`ssl: isCloudWorkstation(host)`, false para todo host que no termine en `.cloudworkstations.dev`).
El preview se sirve por HTTPS ⇒ **mixed content ⇒ el browser bloquea todo**. O sea: la versión ingenua
de P1 ("que la app llame `useAuthEmulator` y listo") **no funciona** en un preview hosteado.

**La resolución:** el puente http→https vive en la INFRA (P2), no en la app. Así P1 queda idiomático
(y sirve igual para dev local y para mobile, donde no hay problema de esquema).

- **P1 · convención preview-aware** — contrato completo con el código Dart en
  `registry/templates/.../aiuda-flutter-firebase/.github/instructions/app.instructions.md.tmpl`
  (sección "Firebase init: preview-aware"), + el deber de mantenerla en `registry/agents/flutter-dev.md`.
  Los defaults de los `--dart-define` son los que YA declara `stack.verify.yaml` (`demo-fluxo`,
  9099/8085/5001) → un `firebase emulators:start` local anda sin pasar ninguno.
- **P2 · receta** en `registry/templates/.../aiuda-flutter-firebase/.fluxo/preview/`
  (`compose.yml.tmpl` · `emulator-entrypoint.sh` · `build-web.sh` · `preview-shim.js` ·
  `preview-seed.mjs` · `edge.Caddyfile` · `README.md`). Decisiones que valen: **un solo origen**
  ruteado **por prefijo de path** a cada emulador; **rules abiertas a propósito** (el preview evalúa la
  UI; las rules las verifica e2e-verify + el reviewer); **seed reusa las fixtures de e2e-verify** +
  cuenta demo (`demo@preview.fluxo.dev` / `FluxoDemo123!`); **imagen = `fluxo-agent-dev:local`**, la
  misma "máquina de dev real" del engine (cero skew de Flutter, y ya trae Java para los emuladores JVM).
- **`scripts/preview-runner.sh`**: placeholders `recipe_dir` + `maps_api_key`, auto-build de la imagen
  de dev si falta (mismo patrón self-heal que agent-runner), espera hasta ~12 min (un `flutter build
  web` en frío no entraba en los 5 min) y un **guard fail-loud** si queda un placeholder sin sustituir.
- **Gate de honestidad**: si la app NO es preview-aware, `build-web.sh` **falla con la instrucción
  concreta** en vez de publicar un cascarón vacío — que es exactamente el bug que este doc vino a matar.
- **11 tests** (`design/src/previewRecipe.test.ts`): contrato receta↔runner (placeholders), semántica
  del shim (incluido "no tocar https/relativas"), ruteo del edge, conversión JSON→typed-values del
  seeder y el seeder corriendo contra un stub del REST del emulador.

## 5. Referencias de código (para desarrollar en frío)
- Preview: `scripts/preview-runner.sh` (RECIPE path ~285-308, gen_env ~135-163, health ~316-325);
  receta molde `registry/templates/github-native/react-supabase/.fluxo/preview/`.
- Tenant creds: `console/lib/server/tenantCredentials.ts` (registry + `propagateToRepo`),
  `supabase/migrations/20260728120000_tenant_credentials.sql` (Vault), docs/16.
- Build/inyección: `registry/templates/github-native/aiuda-flutter-firebase/.github/workflows/build-apk.yml.tmpl`
  (patrón keystore línea ~80); `scripts/agent-runner.sh` (engine build).
- Lint: `registry/templates/github-native/_common/.fluxo/verify/provisioning_lint.py.tmpl` (~122 el
  regex placeholder), `.../aiuda-flutter-firebase/.fluxo/verify/provisioning.rules.yaml.tmpl` (~33 la
  regla de la Maps key).
- Capabilities: `registry/capabilities/firebase.yaml`, `design/src/capabilities.ts`.

## 6. Lo que FALTA para ver YoMap corriendo (en orden)

1. **Desplegar al VPS** — la receta la lee el runner desde el registry del VPS, y el runner cambió:
   ```bash
   rsync -az --delete --exclude .git registry/ root@2.25.78.202:/opt/fluxo/registry/
   rsync -az scripts/preview-runner.sh root@2.25.78.202:/opt/fluxo/preview-runner.sh
   ssh root@2.25.78.202 'chmod +x /opt/fluxo/preview-runner.sh && systemctl restart fluxo-preview-runner'
   ```
   (rsync **pierde el bit +x** → sin el `chmod` systemd falla con `203/EXEC`.)
2. **La app de YoMap todavía NO es preview-aware** → hoy el preview va a fallar con el mensaje del gate
   (que es la verdad, no un bug). Cerrarlo **como capacidad, no a mano**: una story despachada al repo
   del cliente que implemente la init preview-aware de `app.instructions.md`. **Cuesta plata** (dispara
   un agente real) y toca un repo de cliente → pedir el OK antes.
3. **Validar la preview en vivo** y recién ahí dar P2 por cerrado.
4. **P3** (store de `GOOGLE_SERVICES_JSON` + `MAPS_API_KEY` como tenant credentials, inyección al build
   real, gate de lint). El hook ya está: el runner acepta `PREVIEW_MAPS_API_KEY` y `build-web.sh` la
   inyecta en `web/index.html`; falta el origen (Vault) y la UI.
