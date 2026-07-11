# GOAL — misión de build autónomo

> Pegá esto (o apuntá tu loop a este archivo) al arrancar una sesión de desarrollo en `projects/genai/fluxo`.

## Misión
Construir Fluxo v2 **hasta que esté completo**: `docs/03-roadmap.md` 100% en `[x]` y el `docs/05-ejemplo-e2e.md`
(Doña Rosa) corriendo de punta a punta. No pares hasta eso, salvo que te bloquee una decisión ⚠️ de `docs/06-decisiones.md`.

## Protocolo (cada iteración)
1. Leé `CLAUDE.md` y `docs/` (00→06). Orientate: ¿en qué fase estamos?
2. En `docs/03-roadmap.md`, tomá la **primera tarea `[ ]`** respetando fases y dependencias. NO saltees fases.
3. ¿La tarea depende de una decisión ⚠️ sin resolver en `06-decisiones`? → NO adivines si tiene costo/lock-in
   irreversible. Anotá la pregunta, dejá la tarea, y tomá la siguiente tarea desbloqueada. Si TODO lo desbloqueado
   está hecho y solo quedan tareas bloqueadas por decisiones, **PARÁ y pedí la decisión** (no inventes).
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
