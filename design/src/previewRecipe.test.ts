// Tests de las RECETAS DE PREVIEW (docs/20 · P2). La receta es data (compose + Caddyfile + scripts),
// pero tiene tres contratos que se rompen en silencio y sólo se notan como "el preview salió vacío":
//   1. los {{placeholders}} del compose ⊆ los que el preview-runner sustituye;
//   2. el shim que puentea el http:// hardcodeado de los SDK de FlutterFire al origen https;
//   3. el ruteo del edge, que tiene que cubrir los prefijos de path que emiten esos SDK.
// Todo esto se testea sin docker: es parseo de texto y una función de reescritura de URLs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEMPLATES = join(ROOT, "registry", "templates", "github-native");
const FLUTTER_PREVIEW = join(TEMPLATES, "aiuda-flutter-firebase", ".fluxo", "preview");

// ── 1) contrato receta ↔ preview-runner ──────────────────────────────────────────────────────────
// El runner rendereza el compose con un sed de lista FIJA. Una receta que estrena un placeholder sin
// tocar el runner deja un path literal `{{x}}` en el compose → el preview levanta roto y el error
// aparece lejísimos de la causa. Este test es el que hace que ese cambio de contrato duela acá.
function placeholdersSubstitutedByRunner(): Set<string> {
  const runner = readFileSync(join(ROOT, "scripts", "preview-runner.sh"), "utf8");
  return new Set(Array.from(runner.matchAll(/-e "s#\{\{([a-z_]+)\}\}#/g), (m) => m[1]));
}

function stacksWithPreviewRecipe(): string[] {
  return readdirSync(TEMPLATES).filter((s) => existsSync(join(TEMPLATES, s, ".fluxo/preview/compose.yml.tmpl")));
}

test("toda receta de preview usa sólo placeholders que el preview-runner sustituye", () => {
  const known = placeholdersSubstitutedByRunner();
  const stacks = stacksWithPreviewRecipe();
  assert.ok(stacks.length > 0, "no encontré ninguna receta de preview — ¿se movió el layout?");
  for (const stack of stacks) {
    const tmpl = readFileSync(join(TEMPLATES, stack, ".fluxo/preview/compose.yml.tmpl"), "utf8");
    const used = new Set(Array.from(tmpl.matchAll(/\{\{([a-z_]+)\}\}/g), (m) => m[1]));
    for (const name of used) {
      assert.ok(
        known.has(name),
        `la receta de ${stack} usa {{${name}}} y preview-runner.sh no lo sustituye ` +
          `(agregalo al sed del RECIPE path, si no el compose se rendereza con el literal)`,
      );
    }
  }
});

test("la receta flutter-firebase monta el recipe_dir donde sus propios scripts esperan estar", () => {
  const tmpl = readFileSync(join(FLUTTER_PREVIEW, "compose.yml.tmpl"), "utf8");
  // Los scripts se invocan por path absoluto dentro del contenedor; si el mount y el command se
  // desincronizan, el servicio muere con "no such file" recién en runtime.
  assert.match(tmpl, /\{\{recipe_dir\}\}:\/etc\/fluxo\/recipe:ro/);
  for (const script of ["emulator-entrypoint.sh", "build-web.sh", "preview-seed.mjs"]) {
    assert.ok(existsSync(join(FLUTTER_PREVIEW, script)), `falta ${script} en la receta`);
    assert.ok(tmpl.includes(`/etc/fluxo/recipe/${script}`), `el compose no invoca ${script}`);
  }
});

// ── 2) el shim http→same-origin ──────────────────────────────────────────────────────────────────
// Sin esto no hay preview: firebase_auth_web y cloud_functions arman 'http://host:port' hardcodeado y
// el browser bloquea el mixed content contra una página https.
// Carga el shim en un sandbox con un DOM mínimo y devuelve tanto su `rewrite` como los canales
// parcheados, para poder ejercitarlos de verdad (no sólo leer la función).
function loadShim(pageOrigin: string) {
  const opened: string[] = [];
  const fetched: string[] = [];
  const sockets: string[] = [];
  const beacons: string[] = [];
  const { protocol, host } = new URL(pageOrigin);

  class FakeXHR {
    open(_method: string, url: string) {
      opened.push(url);
    }
  }
  class FakeWS {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url: string) {
      sockets.push(url);
    }
  }
  const win: Record<string, unknown> = {
    location: { origin: pageOrigin, protocol, host },
    fetch: (input: unknown) => {
      fetched.push(typeof input === "string" ? input : String((input as { url: string }).url));
      return Promise.resolve({});
    },
    WebSocket: FakeWS,
  };
  const nav = { sendBeacon: (u: string) => beacons.push(u) };
  const ctx = createContext({
    window: win,
    XMLHttpRequest: FakeXHR,
    navigator: nav,
    console: { info: () => {} },
    URL,
    Request,
    Array,
  });
  runInContext(readFileSync(join(FLUTTER_PREVIEW, "preview-shim.js"), "utf8"), ctx);

  const shim = win["__fluxoPreviewShim"] as { rewrite: (u: string) => string };
  return {
    rewrite: shim.rewrite,
    fetch: win.fetch as (input: string) => Promise<unknown>,
    XHR: FakeXHR,
    WebSocket: win.WebSocket as new (url: string) => unknown,
    sendBeacon: (u: string) => (ctx.navigator as typeof nav).sendBeacon(u),
    opened,
    fetched,
    sockets,
    beacons,
  };
}

const PAGE = "https://preview-p1234.2.25.78.202.sslip.io";

test("el shim reescribe al origen de la página el http:// que arman los SDK", () => {
  const { rewrite } = loadShim(PAGE);
  // Auth (firebase_auth_web hardcodea http://): el path ya lleva el discriminador del emulador.
  assert.equal(
    rewrite("http://fluxo-emulator:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key"),
    `${PAGE}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
  );
  // Firestore WebChannel.
  assert.equal(
    rewrite("http://fluxo-emulator:8085/google.firestore.v1.Firestore/Listen/channel?VER=8"),
    `${PAGE}/google.firestore.v1.Firestore/Listen/channel?VER=8`,
  );
  // Callable de functions: /<projectId>/<region>/<fn>.
  assert.equal(
    rewrite("http://fluxo-emulator:5001/demo-fluxo/us-central1/createBooking"),
    `${PAGE}/demo-fluxo/us-central1/createBooking`,
  );
});

test("el shim NO toca https, relativas, ni el propio origen", () => {
  const { rewrite } = loadShim(PAGE);
  // Los assets del engine de Flutter (canvaskit) salen por https a gstatic: romperlos rompe la app.
  const canvaskit = "https://www.gstatic.com/flutter-canvaskit/abc/canvaskit.wasm";
  assert.equal(rewrite(canvaskit), canvaskit);
  assert.equal(rewrite("/assets/FontManifest.json"), "/assets/FontManifest.json");
  assert.equal(rewrite("main.dart.js"), "main.dart.js");
  // Mismo host que la página (preview servido por http en dev local) → no hay nada que puentear.
  const local = loadShim("http://127.0.0.1:8900");
  assert.equal(local.rewrite("http://127.0.0.1:8900/v1/projects/demo-fluxo"), "http://127.0.0.1:8900/v1/projects/demo-fluxo");
});

test("el shim parchea fetch, XHR, WebSocket y sendBeacon", async () => {
  const shim = loadShim(PAGE);

  await shim.fetch("http://fluxo-emulator:8085/v1/projects/demo-fluxo/databases/(default)/documents/providers");
  new shim.XHR().open("POST", "http://fluxo-emulator:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword");
  new shim.WebSocket("ws://fluxo-emulator:8085/socket");
  shim.sendBeacon("http://fluxo-emulator:8085/beacon");

  assert.equal(shim.fetched[0], `${PAGE}/v1/projects/demo-fluxo/databases/(default)/documents/providers`);
  assert.equal(shim.opened[0], `${PAGE}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword`);
  // ws:// sobre una página https tiene que salir wss:// o el browser lo bloquea igual que el http.
  assert.equal(shim.sockets[0], `wss://${new URL(PAGE).host}/socket`);
  assert.equal(shim.beacons[0], `${PAGE}/beacon`);
});

// ── 3) el edge cubre los prefijos que emiten los SDK ─────────────────────────────────────────────
test("el edge del preview flutter rutea cada prefijo de emulador a su puerto", () => {
  const caddy = readFileSync(join(FLUTTER_PREVIEW, "edge.Caddyfile"), "utf8");
  // Puertos = los que declara stack.verify.yaml; los prefijos = los que exponen los emuladores.
  const routes: Array<[string, string]> = [
    ["/identitytoolkit.googleapis.com/*", "emulator:9099"],
    ["/securetoken.googleapis.com/*", "emulator:9099"],
    ["/google.firestore.v1.Firestore/*", "emulator:8085"],
    ["/v1/*", "emulator:8085"],
    ["/demo-fluxo/*", "emulator:5001"],
    ["/v0/b/*", "emulator:9199"],
  ];
  for (const [path, upstream] of routes) {
    const block = new RegExp(`handle ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[^}]*${upstream}`);
    assert.match(caddy, block, `el edge no rutea ${path} a ${upstream}`);
  }
  // El SPA-fallback es lo que hace que el health-check del runner (/api/health) dé 200 sobre un
  // build estático; sin él el preview nunca pasa a `live`.
  assert.match(caddy, /try_files \{path\} \/index\.html/);
});

// ── 4) el seeder ─────────────────────────────────────────────────────────────────────────────────
// Un preview vacío no se puede evaluar. El seeder habla el REST del emulador sin deps, así que la
// conversión JSON→typed-values es código nuestro y tiene que espejar lo que hace firebase-admin con
// la MISMA fixture (las comparte con e2e-verify).
const seeder = await import(join(FLUTTER_PREVIEW, "preview-seed.mjs"));

test("el seeder convierte JSON a los typed values del REST de Firestore", () => {
  const { toFirestoreValue, toFirestoreFields } = seeder;
  assert.deepEqual(toFirestoreValue("Clinica Norte"), { stringValue: "Clinica Norte" });
  assert.deepEqual(toFirestoreValue(true), { booleanValue: true });
  assert.deepEqual(toFirestoreValue(null), { nullValue: null });
  // Entero vs decimal: firebase-admin serializa los enteros como integerValue (string, por el rango
  // de int64) y el resto como doubleValue. Mandar 3 como doubleValue cambiaría el tipo del campo.
  assert.deepEqual(toFirestoreValue(3), { integerValue: "3" });
  assert.deepEqual(toFirestoreValue(3.5), { doubleValue: 3.5 });
  assert.deepEqual(toFirestoreValue(["a", 1]), {
    arrayValue: { values: [{ stringValue: "a" }, { integerValue: "1" }] },
  });
  assert.deepEqual(toFirestoreValue({ n: { deep: false } }), {
    mapValue: { fields: { n: { mapValue: { fields: { deep: { booleanValue: false } } } } } },
  });
  // La fixture real que el stack ya trae para e2e-verify.
  assert.deepEqual(toFirestoreFields({ name: "Clinica Norte", available: true }), {
    name: { stringValue: "Clinica Norte" },
    available: { booleanValue: true },
  });
});

test("el seeder respeta el naming <coleccion>.<docId>.json de las fixtures del stack", () => {
  const { parseFixtureName } = seeder;
  assert.deepEqual(parseFixtureName("providers.prov1.json"), { collection: "providers", docId: "prov1" });
  assert.deepEqual(parseFixtureName("availability.prov1_slot1.json"), {
    collection: "availability",
    docId: "prov1_slot1",
  });
  // Ruido que no es una fixture: se saltea, no rompe el seed.
  assert.equal(parseFixtureName("README.md"), null);
  assert.equal(parseFixtureName("sinpunto.json"), null);
  assert.equal(parseFixtureName("a.b.c.json"), null);
});

test("las fixtures que el stack ya declara son sembrables por el seeder del preview", () => {
  const seedDir = join(TEMPLATES, "aiuda-flutter-firebase", ".fluxo/verify/e2e/seed");
  const files = readdirSync(seedDir).filter((f) => f.endsWith(".json.tmpl"));
  assert.ok(files.length > 0, "el stack no declara fixtures de seed");
  for (const file of files) {
    const parsed = seeder.parseFixtureName(file.replace(/\.tmpl$/, ""));
    assert.ok(parsed, `la fixture ${file} no respeta <coleccion>.<docId>.json`);
    const body = JSON.parse(readFileSync(join(seedDir, file), "utf8"));
    assert.doesNotThrow(() => seeder.toFirestoreFields(body), `no puedo convertir ${file}`);
  }
});

// El seeder corriendo DE VERDAD contra un servidor que habla como el emulador: valida el
// descubrimiento de fixtures en el árbol del repo, los paths REST exactos y el payload de signUp.
// Sin esto, un typo en una URL sólo se descubre con un preview vacío en producción.
test("el seeder siembra world state + cuenta demo por el REST del emulador", async () => {
  const { createServer } = await import("node:http");
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");

  const repo = mkdtempSync(join(tmpdir(), "fluxo-seed-"));
  mkdirSync(join(repo, ".fluxo/verify/e2e/seed"), { recursive: true });
  writeFileSync(join(repo, ".fluxo/verify/e2e/seed/providers.prov1.json"), '{"name":"Clinica Norte","available":true}');
  writeFileSync(join(repo, ".fluxo/verify/e2e/seed/notas.txt"), "ruido que no es fixture");

  const seen: Array<{ url: string; body: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url!, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ localId: "uid-demo" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  try {
    await promisify(execFile)("node", [join(FLUTTER_PREVIEW, "preview-seed.mjs")], {
      env: {
        ...process.env,
        REPO_PATH: repo,
        PROJECT_ID: "demo-fluxo",
        FIRESTORE_HOST: `127.0.0.1:${port}`,
        AUTH_HOST: `127.0.0.1:${port}`,
        DEMO_EMAIL: "demo@preview.fluxo.dev",
        DEMO_PASSWORD: "FluxoDemo123!",
      },
    });
  } finally {
    server.close();
  }

  const doc = seen.find((r) => r.url.includes("/documents/"));
  assert.ok(doc, "el seeder no escribió ningún documento");
  assert.equal(
    doc.url,
    "/v1/projects/demo-fluxo/databases/(default)/documents/providers?documentId=prov1",
    "el path REST de Firestore tiene que llevar el projectId, la base (default) y el documentId",
  );
  assert.deepEqual(JSON.parse(doc.body), {
    fields: { name: { stringValue: "Clinica Norte" }, available: { booleanValue: true } },
  });

  const signup = seen.find((r) => r.url.includes("accounts:signUp"));
  assert.ok(signup, "el seeder no creó la cuenta demo — sin login el preview no se puede evaluar");
  assert.match(signup.url, /^\/identitytoolkit\.googleapis\.com\/v1\/accounts:signUp\?key=/);
  assert.deepEqual(JSON.parse(signup.body), {
    email: "demo@preview.fluxo.dev",
    password: "FluxoDemo123!",
    displayName: "Demo Fluxo",
    returnSecureToken: true,
  });
  // El .txt no es una fixture: se saltea sin romper el seed.
  assert.equal(seen.filter((r) => r.url.includes("/documents/")).length, 1);
});

test("los puertos del edge y del entrypoint coinciden con stack.verify.yaml", () => {
  const verify = readFileSync(
    join(TEMPLATES, "aiuda-flutter-firebase", ".fluxo/verify/stack.verify.yaml.tmpl"),
    "utf8",
  );
  // stack.verify.yaml es la fuente: e2e-verify y el preview tienen que hablar del mismo backend.
  assert.match(verify, /--project demo-fluxo/);
  assert.match(verify, /9099/);
  assert.match(verify, /8085/);
  const entrypoint = readFileSync(join(FLUTTER_PREVIEW, "emulator-entrypoint.sh"), "utf8");
  assert.match(entrypoint, /"auth":\s*\{ "host": "0\.0\.0\.0", "port": 9099 \}/);
  assert.match(entrypoint, /"firestore":\s*\{ "host": "0\.0\.0\.0", "port": 8085 \}/);
  // 0.0.0.0 no es cosmético: con el default (127.0.0.1) ningún otro contenedor alcanza el emulador.
  assert.ok(!entrypoint.includes('"host": "127.0.0.1"'), "el emulador no puede bindear a 127.0.0.1");
});
