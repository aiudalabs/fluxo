// preview-seed.mjs — puebla el Firebase Emulator Suite del preview (docs/20 · P2).
//
// UN PREVIEW VACÍO NO SE PUEDE EVALUAR (bug del 2026-07-29: la app arrancaba sin datos ni login y el
// usuario "no la podía probar"). Acá sembramos dos cosas:
//   1) WORLD STATE — las fixtures que el repo YA declara para e2e-verify: `.fluxo/verify/e2e/seed/`,
//      un archivo por documento con nombre `<coleccion>.<docId>.json`. Reusamos esa data en vez de
//      inventar otra: es la misma que el stack declara como "lo que preexiste al usuario".
//   2) UNA CUENTA DEMO con password CONOCIDA, para que se pueda entrar a la app. Opcionalmente el repo
//      puede declarar más en `.fluxo/preview/users.json` (lista de {email,password,displayName}).
//
// SIN DEPENDENCIAS a propósito: habla el REST del emulador con `fetch` (node ≥18). Así el seed no
// necesita `npm install` ni el firebase-admin del repo — arranca en segundos y no depende de que el
// árbol del cliente tenga sus deps instaladas.
//
// Corre con la red del contenedor del emulador (network_mode: service:emulator), así que los hosts por
// default son 127.0.0.1.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_ID = process.env.PROJECT_ID || 'demo-fluxo';
const FIRESTORE_HOST = process.env.FIRESTORE_HOST || '127.0.0.1:8085';
const AUTH_HOST = process.env.AUTH_HOST || '127.0.0.1:9099';
const REPO = process.env.REPO_PATH || '/repo';
const DEMO_EMAIL = process.env.DEMO_EMAIL || 'demo@preview.fluxo.dev';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'FluxoDemo123!';

// ── JSON plano → "typed values" del REST de Firestore ──────────────────────────────────────────────
// Espeja lo que hace firebase-admin con el MISMO objeto (`db.doc().set(body)`), para que una fixture
// sembrada acá y la misma fixture sembrada por `.fluxo/verify/e2e/seed.mjs` produzcan el mismo
// documento: enteros → integerValue, resto de números → doubleValue, sin magia de fechas (un string
// queda string, igual que en el Admin SDK).
export function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (typeof v === 'object') return { mapValue: { fields: toFirestoreFields(v) } };
  throw new Error(`tipo no soportado en una fixture de seed: ${typeof v}`);
}

export function toFirestoreFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toFirestoreValue(v);
  return fields;
}

// `<coleccion>.<docId>.json` → {collection, docId}. Devuelve null si el nombre no respeta el contrato.
export function parseFixtureName(fileName) {
  if (!fileName.endsWith('.json')) return null;
  const [collection, docId, ...rest] = fileName.slice(0, -'.json'.length).split('.');
  if (!collection || !docId || rest.length) return null;
  return { collection, docId };
}

// ── REST del emulador ──────────────────────────────────────────────────────────────────────────────
// `Bearer owner` es el token que el emulador de Firestore acepta como admin (bypassa las rules) — es
// el mecanismo del emulador, no una credencial real.
async function putDoc(collection, docId, body) {
  const url =
    `http://${FIRESTORE_HOST}/v1/projects/${PROJECT_ID}/databases/(default)/documents/` +
    `${encodeURIComponent(collection)}?documentId=${encodeURIComponent(docId)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ fields: toFirestoreFields(body) }),
  });
  if (!res.ok) throw new Error(`Firestore ${collection}/${docId}: HTTP ${res.status} ${await res.text()}`);
}

async function createUser({ email, password, displayName }) {
  const url = `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName, returnSecureToken: true }),
  });
  const payload = await res.json().catch(() => ({}));
  // EMAIL_EXISTS no es un fallo: el preview se regenera sobre un emulador que puede traer estado.
  if (!res.ok && payload?.error?.message !== 'EMAIL_EXISTS') {
    throw new Error(`Auth ${email}: HTTP ${res.status} ${JSON.stringify(payload)}`);
  }
  return payload.localId || null;
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  // 1) world state — las fixtures que el repo ya declara para e2e-verify.
  const seedDir = join(REPO, '.fluxo/verify/e2e/seed');
  let docs = 0;
  if (existsSync(seedDir)) {
    for (const file of readdirSync(seedDir).filter((f) => f.endsWith('.json'))) {
      const parsed = parseFixtureName(file);
      if (!parsed) {
        console.warn(`seed: salteo ${file} — se esperaba <coleccion>.<docId>.json`);
        continue;
      }
      const body = JSON.parse(readFileSync(join(seedDir, file), 'utf8'));
      await putDoc(parsed.collection, parsed.docId, body);
      docs++;
    }
    console.log(`seed: ${docs} documento(s) de world state desde ${seedDir}`);
  } else {
    // No es un error: un proyecto sin fixtures previsualiza igual, sólo que vacío. Lo decimos fuerte
    // porque "el preview arrancó pero no muestra nada" casi siempre es ESTO.
    console.warn(`seed: no existe ${seedDir} — el preview va a arrancar SIN datos de ejemplo.`);
  }

  // 2) cuentas demo — sin esto no se puede ni entrar a la app.
  const usersFile = join(REPO, '.fluxo/preview/users.json');
  const users = existsSync(usersFile)
    ? JSON.parse(readFileSync(usersFile, 'utf8'))
    : [{ email: DEMO_EMAIL, password: DEMO_PASSWORD, displayName: 'Demo Fluxo' }];
  for (const user of users) {
    const uid = await createUser(user);
    console.log(`seed: usuario demo ${user.email} (password ${user.password})${uid ? ` uid=${uid}` : ''}`);
  }
  console.log('seed: listo.');
}

// Sólo corre si se ejecuta directo — importarlo (los tests del kernel) no dispara el seed.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`seed: FALLÓ — ${err.message}`);
    process.exit(1);
  });
}
