# 20 · Que la app SALGA CORRIENDO — emulador para el preview + keys guardadas para el build real

> **Estado (2026-08-07):** dirección ACORDADA con el usuario, pendiente de construir. Reemplaza el
> enfoque "derivar el config del SA" que se exploró en la sesión anterior (over-engineered). El core
> derivado (`scripts/provision-runtime-config.sh`, commit `51b94a3`) queda como alternativa opcional,
> NO como el camino elegido.

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
