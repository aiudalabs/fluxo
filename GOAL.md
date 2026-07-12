# GOAL — misión de build autónomo

> Pegá esto (o apuntá tu loop a este archivo) al arrancar una sesión de desarrollo en `projects/genai/fluxo`.

## Misión
Construir Fluxo v2 **hasta que esté completo**: `docs/03-roadmap.md` 100% en `[x]` y el `docs/05-ejemplo-e2e.md`
(Doña Rosa) corriendo de punta a punta. No pares hasta eso, salvo un bloqueo real (definido abajo).

## La barra para molestar al humano (casi NUNCA) — LEÉ ESTO PRIMERO

Este build es AUTÓNOMO. Por default **procedés, no preguntás.** Solo se para y se pregunta cuando se cumplen las
**TRES** a la vez:
(a) la decisión es irreversible / con costo real / outward-facing (plata, lock-in, algo público), **y**
(b) NINGÚN doc la pre-responde (ni una recomendación en `06-decisiones`), **y**
(c) bloquea TODO el trabajo restante (no queda ni una sola tarea desbloqueada por hacer).
Si no se cumplen las tres → **decidí con un default sensato, dejá una línea en la bitácora (`default: <qué> porque
<doc/razón>`), y seguí.** Eso es lo correcto — no es "adivinar".

**NUNCA preguntes por:**
- **Ordenamiento de trabajo.** Si una tarea está bloqueada, hacé TODAS las demás desbloqueadas, en orden del roadmap.
  Prohibido "¿cuál de las dos hago?" — se hacen las dos.
- **Si parar / hacer checkpoint.** No ofrezcas parar. Seguí hasta que TODO esté `[x]` o hasta un bloqueo real. El
  humano corta si quiere; vos no proponés cortar.
- **Un default ya documentado.** Una recomendación en `06-decisiones` (u otro doc) ES la decisión. Tomala y seguí.
- **Deps ya sancionadas por los docs** (Next.js, @supabase/supabase-js, Claude Agent SDK; `control/` stdlib-first).
  Solo una dep NOVEL fuera de los docs amerita una nota — y aun así preferí stdlib/lo ya aprobado y seguí.
- **D4 (repo remoto).** Solo bloquea `git push` y los required-checks en vivo. **Nunca frenes trabajo local por D4.**
  Construí y commiteá local; batcheá lo que "necesita push" y seguilo cuando no quede NADA local por hacer.
- **Detalles de implementación con un camino obvio** (un shim de dev, un helper stdlib, el orden de dos migraciones):
  elegí y seguí.

## Protocolo (cada iteración)
1. Leé `CLAUDE.md` y `docs/` (00→06). Orientate: ¿en qué fase estamos?
2. En `docs/03-roadmap.md`, tomá la **primera tarea `[ ]`** respetando fases y dependencias. NO saltees fases.
3. ¿Bloqueada? Aplicá "la barra" de arriba. En la práctica: tomá la siguiente tarea desbloqueada y seguí — sin
   preguntar cuál. Solo se para si NO queda ninguna tarea desbloqueada **y** lo que falta cumple las tres condiciones.
4. Implementá la tarea contra su **AC**:
   - lo determinista (estado, aislamiento, Maestro, runtime) → **tests primero**, y **nunca** debilites un test.
   - datos → migración + **RLS policy** + test de fuga cross-tenant.
   - metodología → en `registry/` (data/markdown), **nunca** en Go (regla de oro).
   - respetá `04-lecciones`: si estás por reintroducir un bug L-*, PARÁ.
5. **Verificá de verdad**: corré tests/linters/migraciones; para UI, drivealo (no declares "listo" sin correr).
6. Marcá la tarea `[x]`, actualizá la **Bitácora** al pie de `03-roadmap.md` (fecha · fase · qué quedó), y commiteá
   (convencional, chico, verde). Una tarea = un commit (o un branch/PR si el flujo lo pide).
7. Repetí.

## Reglas duras
- Preferí una verdad incómoda ("no puedo cerrar esto sin decidir X") a un avance falso. Nunca `[x]` sin verificar.
- Cero metodología en Go. Aislamiento por RLS. El sustrato se alquila. (Ver golden rules en `CLAUDE.md`.)
- Commits en inglés convencional; docs/UX en español.
- Si la arquitectura de un doc te queda corta para una tarea, **actualizá el doc** en el mismo commit — los docs son
  la fuente de verdad, no la memoria de la sesión.

## Primer paso concreto
Si nada está hecho: la primera tarea es **F0-01** (confirmar la apuesta de plataforma en `06-decisiones` D1). Si el
fundador ya la confirmó, seguí con F0-02.
