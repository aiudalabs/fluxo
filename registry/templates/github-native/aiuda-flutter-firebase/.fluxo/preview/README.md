# Receta de preview — aiuda-flutter-firebase (docs/20 · P2)

"App en vivo" para una app Flutter + Firebase, **sin una sola credencial real**: el preview corre
contra el **Firebase Emulator Suite** con un proyecto `demo-*` y datos sembrados. Nunca toca el
Firebase del cliente.

La consume `scripts/preview-runner.sh` (RECIPE path) desde el **registry** del VPS
(`/opt/fluxo/registry/...`), no desde el repo del cliente.

## Las piezas

| archivo | qué hace |
|---|---|
| `compose.yml.tmpl` | los 4 servicios: `emulator` · `build` (one-shot) · `seed` (one-shot) · `edge` |
| `emulator-entrypoint.sh` | genera el config del emulador y lo arranca (functions/storage condicionales) |
| `build-web.sh` | detecta la app, compila a web con los `--dart-define` del emulador, inyecta el shim, publica |
| `preview-shim.js` | puente `http://` → mismo origen HTTPS (ver abajo: sin esto no hay preview) |
| `preview-seed.mjs` | siembra world state + la cuenta demo por el REST del emulador |
| `edge.Caddyfile` | un solo origen: la app en `/`, cada emulador en su prefijo de path |

## Lo que hay que entender antes de tocar esto

**1. El shim no es un adorno — es el único camino.** En WEB, los SDK de FlutterFire arman la URL del
emulador con `http://` **hardcodeado**: `firebase_auth_web` (`origin = 'http://$host:$port'`),
`cloud_functions` (`_origin = 'http://…'`) y `cloud_firestore` (que descarta `sslEnabled` en web; el
JS SDK computa `ssl: isCloudWorkstation(host)`, false para cualquier host que no sea de Google).
El preview se sirve por HTTPS ⇒ esos pedidos serían **mixed content** y el browser los bloquea.
El shim parchea `fetch`/`XHR`/`WebSocket` y reescribe al origen de la página **antes** de emitir, así
que la app puede seguir usando las APIs idiomáticas (`useAuthEmulator(host, port)`) sin saber nada.

**2. El ruteo es por PATH, no por puerto.** Los emuladores exponen prefijos distintos
(`/identitytoolkit.googleapis.com/*` auth, `/google.firestore.v1.Firestore/*` y `/v1/*` firestore,
`/<projectId>/<region>/<fn>` functions, `/v0/b/*` storage) y no chocan con los assets de Flutter web.
Por eso todo entra por un solo origen con TLS.

**3. Los puertos y el projectId salen de `.fluxo/verify/stack.verify.yaml`** (auth 9099, firestore
8085, functions 5001, `demo-fluxo`). Un solo vocabulario para e2e-verify y para el preview: si cambiás
uno, cambiá los dos (hay un test que lo verifica).

**4. Las rules van ABIERTAS a propósito.** El preview es para evaluar la UI; con las rules reales y una
cuenta demo, media app renderiza vacía y parece rota. Quien verifica las rules es `e2e-verify`
(`no_client_over_read`) y el reviewer autónomo.

**5. La app tiene que ser preview-aware** (docs/20 · P1, contrato en
`.github/instructions/app.instructions.md`). Si no lo es, `build-web.sh` **falla fuerte** con la
instrucción concreta en vez de publicar un cascarón vacío — que es justo el problema que docs/20 vino
a resolver.

## Límites conocidos

- **Google Maps no se emula** (los tiles los sirve Google). Sin `PREVIEW_MAPS_API_KEY` en el runner, la
  app se previsualiza igual y el mapa queda en blanco. La key guardada es docs/20 · P3.
- **Functions**: sólo se emulan si el repo trae `functions/package.json` y sus deps instalan. Si el
  build de TypeScript falla, el preview arranca sin callables (mejor eso que ningún preview).
- El primer preview de un proyecto es lento: `flutter build web` en frío + descarga de los `.jar` de
  los emuladores. Los volúmenes `pubcache`/`emulatorcache` hacen rápidas las regeneraciones.

## Debug

```bash
# en el VPS
docker compose -p fluxo-preview-<pid> ps
docker compose -p fluxo-preview-<pid> logs build      # ¿compiló? ¿pasó el gate de preview-aware?
docker compose -p fluxo-preview-<pid> logs emulator   # ¿levantaron auth+firestore?
docker compose -p fluxo-preview-<pid> logs seed       # ¿sembró? ¿cuántos docs?
```

En el browser, la consola imprime `[fluxo-preview] shim de emulador activo …` y
`window.__fluxoPreviewShim.rewritten` dice cuántas URLs se reescribieron. Si es `0` y la app no trae
datos, la app **no** está hablando con el emulador (revisá la init preview-aware).
