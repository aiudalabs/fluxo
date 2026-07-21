# 13 · Diseño — Deploy · A3: auto-provision N2 (OAuth + crear el proyecto Firebase del cliente)

> **Estado: DISEÑO, no construido.** A3 = el **N2 auto-provision** que D3 y D7 **difieren a v1.1** (docs/06 D7
> línea 79: *"Es el provisioning-auto que D3 difirió a v1.1"*). Este doc carga el método (diseño antes que build)
> y enumera las **decisiones abiertas ⚠️** que el humano debe tomar ANTES de escribir código — sin comprometer
> costo ni lock-in. No se registra ningún OAuth app, no se cablea ningún secret, no se toca `control/`/`console`.
>
> **Serie «Deploy · A»:** A1 ✅ (Flutter-web preview → Hosting) · A2 ✅ (Firebase Test Lab verify) · **A3 ⚪ (este doc).**

---

## 1 · Qué resuelve A3 (y qué NO)

**Hoy (N1, self-serve manual — P6-2b):** el usuario, en un checklist con semáforos 🟢, **crea a mano** su proyecto
Firebase (Blaze + billing), genera la service-account key, y la pega como Actions secret `FIREBASE_SERVICE_ACCOUNT`
(el umbrella que A1/A2/build-apk consumen). Funciona y es cero-COGS, pero el paso "creá el proyecto + billing + SA"
es fricción real.

**A3 (N2, objetivo):** el *feel* de "un click" — el usuario **autoriza a Fluxo por OAuth** y Fluxo **crea el proyecto
en la cuenta del cliente** vía las APIs de Google, mintea la SA umbrella con los roles que A1/A2 ya nombran, y siembra
el secret. El app queda **en la cuenta del cliente** (BYO intacto, cero-COGS). **No** es N3 (Fluxo hostea) — eso está
DESCARTADO por D7 (rompe golden rule #5).

**Lo que A3 NO elimina:** el humano **igual** elige/tiene una **billing account** (Blaze) — crear un proyecto sin
billing no habilita nada pago. A3 mueve el trabajo (crea el proyecto por él) pero **la cuenta de facturación sigue
siendo frontera humana** (D8): nadie factura por el cliente sin su consentimiento explícito.

---

## 2 · Flujo end-to-end (target)

```
1. Usuario en el console → "Conectar Firebase automáticamente" (alternativa al checklist manual de P6-2b).
2. OAuth con Google (consent screen de Fluxo) → scope cloud-platform → Fluxo recibe un refresh token del usuario.
3. Console lista las billing accounts del usuario (Cloud Billing API: billingAccounts.list) → el usuario ELIGE una.
   ⟵ frontera humana inherente (D8): elegir quién paga es del humano, no automatizable.
4. Fluxo crea el proyecto GCP        → Cloud Resource Manager v3: projects.create
5. Fluxo linkea el billing           → Cloud Billing:  projects.updateBillingInfo (la account del paso 3)
6. Fluxo añade Firebase al proyecto  → Firebase Management API: projects:addFirebase
7. Fluxo habilita Firestore/APIs     → serviceusage: services.enable (firestore, testlab, hosting, appdistro…)
8. Fluxo mintea la SA umbrella       → IAM: serviceAccounts.create + serviceAccounts.keys.create
   y le concede los 4 roles que ya nombra registry/capabilities/firebase.yaml
   (hosting.admin, cloudtestservice.testAdmin, firebase.analyticsViewer, firebaseappdistro.admin)
9. Fluxo siembra el Actions secret FIREBASE_SERVICE_ACCOUNT en el repo del cliente (gh secret set, ya existe el path).
10. A partir de acá, deploy.yml (A1) / device-verify.yml (A2) / build-apk.yml funcionan sin más pasos.
```

**El punto clave de cierre:** A3 **produce exactamente el mismo artefacto** que el self-serve manual — el secret
`FIREBASE_SERVICE_ACCOUNT` con los 4 roles. Todo lo aguas abajo (A1/A2/build-apk) **ya está construido y no cambia**.
A3 es solo un **camino alternativo, más corto, para llegar al mismo secret**. Eso lo hace aditivo y de bajo riesgo
para lo ya shippeado.

### APIs de Google involucradas (verificar rev exacta al construir)
| Paso | API | Método | Nota |
|---|---|---|---|
| Crear proyecto | Cloud Resource Manager v3 | `projects.create` | requiere `resourcemanager.projects.create` en el **parent** (org/folder); **no** asocia billing |
| Elegir/linkear billing | Cloud Billing | `billingAccounts.list` + `projects.updateBillingInfo` | el usuario elige la account (paso humano) |
| Añadir Firebase | Firebase Management API | `projects:addFirebase` | convierte el GCP project en un Firebase project |
| Habilitar servicios | Service Usage | `services.enable` | Firestore, Test Lab, Hosting, App Distribution |
| Mintear la SA umbrella | IAM | `serviceAccounts.create` + `keys.create` + `setIamPolicy` | genera el JSON = el secret; concede los 4 roles |

Fuentes: [Resource Manager projects.create](https://cloud.google.com/resource-manager/reference/rest/v1/projects/create) ·
[Creating & managing projects](https://docs.cloud.google.com/resource-manager/docs/creating-managing-projects).

---

## 3 · Encaje con el modelo existente (D8 capabilities)

A3 **no reemplaza** el modelo capability-aware de P6-2b — lo **extiende con un segundo modo de resolución**:

- La capability `firebase.yaml` ya declara `provisioning` (lo que el humano hace one-time) + `secret`
  (`FIREBASE_SERVICE_ACCOUNT`) + `probe`. Hoy el onboarding resuelve el semáforo 🟢 con **siembra manual**.
- A3 agrega una capability-property nueva, algo como `provisioning.auto` (data): declara que esta capability
  **puede** auto-provisionarse por OAuth, con qué APIs y qué scope. El onboarding ofrece **"crear automáticamente"**
  como alternativa al checklist, y al terminar deja el **mismo** secret 🟢. El readiness gate del dispatch (Paso 3 de
  P6-2b) **no cambia** — sigue mirando si el secret está 🟢, sin importar cómo llegó ahí.
- Golden rule #1/#5 intactas: el *método* (qué capability, qué APIs, qué roles) es **data** en `registry/`; el
  *pegamento* (el flujo OAuth genérico) es código en `control/`/`console`, **agnóstico** de Firebase — la próxima
  plataforma auto-provisionable (Vercel, Supabase) reusa el mismo pegamento declarando su `provisioning.auto`.

---

## 4 · Decisiones abiertas ⚠️ (bloquean el build — son del humano)

1. **⚠️ OAuth app propia de Fluxo.** N2 exige que Fluxo registre un **OAuth 2.0 client de Google** (client_id +
   client_secret **de Fluxo**, con consent screen verificada por Google para el scope `cloud-platform`, que es
   *sensitive/restricted* → **verification review de Google**, semanas de lead time). Esto es lo primero que rompe el
   "puro BYO": Fluxo pasa a tener una credencial propia en el flujo. **Decisión:** ¿registramos el OAuth app (Noel,
   one-time en Google Cloud Console)? ¿bajo qué dominio de consent (fluxo.aiudalabs.com)?

2. **⚠️ Storage del refresh token.** El refresh token del usuario **puede crear recursos facturables** en su GCP →
   secreto de altísimo valor. La constitución nombra **Vault** como el sustrato para tokens (tabla CARGAR/REEMPLAZAR).
   **Decisión:** ¿storage en Vault (¿está disponible en el Supabase self-hosted/managed que usamos?), o Supabase con
   columna cifrada (pgcrypto/KMS) como puente? ¿el token se **descarta** tras provisionar (one-shot) o se **guarda**
   para re-provisionar/gestionar? (One-shot minimiza superficie; guardarlo habilita "gestionar tu infra desde Fluxo"
   pero es más riesgo.)

3. **⚠️ Alcance del scope / mínimo privilegio.** `cloud-platform` es amplísimo. ¿Se puede acotar a los scopes mínimos
   (resourcemanager + billing + firebase + iam) para reducir el consent y el blast-radius? Google exige justificar
   scopes sensibles en la verification. **Decisión:** el set de scopes mínimo viable.

4. **⚠️ Parent del proyecto (org vs sin-org).** `projects.create` requiere permiso en un **parent** (organización o
   folder). Muchos usuarios boutique LATAM **no tienen una GCP Organization** (cuentas Gmail personales) → crean
   proyectos "sin parent". **Decisión:** ¿soportamos ambos? ¿qué pasa si el usuario no tiene permiso de crear en su
   org corporativa?

5. **⚠️ Manejo de fallo parcial / idempotencia.** El flujo son ~6 llamadas API que pueden fallar a mitad (proyecto
   creado, billing NO linkeado). **Decisión:** ¿reintentos idempotentes por paso? ¿rollback (borrar el proyecto a
   medio crear) o dejar-y-reanudar? (La lección L-AUTO / histéresis: nunca derivar "listo" de una lectura parcial.)

---

## 5 · Qué se construiría (slice v1.1, cuando las ⚠️ se decidan)

- **Data:** extender `registry/capabilities/firebase.yaml` con `provisioning.auto` (apis, scopes, roles a conceder).
  Genérico: el schema de capability gana el bloque, no solo Firebase.
- **Pegamento (agnóstico):** un flujo OAuth en `console` (callback) + `control`/worker que ejecuta la secuencia de
  APIs **leyendo qué hacer de la capability data** (cero `if platform == firebase`). Storage del token según ⚠️2.
- **UI:** en el checklist de capabilities (Settings → Canal de build), un botón **"Crear automáticamente"** junto a
  la guía manual; al terminar, el semáforo pasa a 🟢 igual que la siembra manual.
- **Tests:** el pegamento OAuth+secuencia con las APIs de Google **mockeadas** (como P6-2b testeó el gate contra el
  registry real con la capa GitHub mockeada); un test de fallo-parcial (paso 5 falla → estado consistente).
- **Seguridad:** test de que el token nunca se loguea ni se persiste fuera del store decidido; revocación
  (`oauth2.revoke`) cuando el usuario desconecta.

**Explícitamente fuera del slice v1.1:** gestión continua de la infra del cliente desde Fluxo (solo provisioning
one-shot); auto-provision de Vercel/Supabase (mismo pegamento, otra capability — después de validar con Firebase).

---

## 6 · Recomendación

A3 es **aditivo y de bajo riesgo para lo ya shippeado** (produce el mismo secret que A1/A2 consumen), pero su
construcción **está bloqueada por las 5 decisiones ⚠️** — sobre todo la #1 (OAuth app + verification de Google, con
lead time de semanas) y la #2 (storage del token / Vault). Ninguna es codeable sin tu llamada; adivinar cualquiera
mete lock-in irreversible (regla #6). Por eso D3/D7 lo pusieron en **v1.1** — y este diseño confirma que fue la
decisión correcta: el valor de N1 self-serve (ya shippeado) es alto y A3 es una **optimización de fricción**, no un
desbloqueo de capacidad.

**Próximo paso cuando quieras A3:** resolver las ⚠️ (arrancando por #1 y #2), y recién ahí abrir el build del slice §5.

---

*Estado: diseño abierto. Fuente: docs/06 D7/D8 · docs/11 serie «Deploy · A» · transcript de planificación 2026-07-20.*
