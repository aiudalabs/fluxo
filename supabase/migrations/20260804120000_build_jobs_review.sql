-- F4 (docs/19 §5) · el REVIEWER autónomo como job del engine. Reusa build_jobs (mismo poller/runner
-- del agente) con un discriminador `kind`: 'build' (el default de siempre) | 'review' (el reviewer
-- de contexto fresco que buildea+corre el incremento del sprint y produce findings).
--
-- Un review-job NO abre PR: corre reviewer.md contra el código MERGEADO del sprint, escribe findings a
-- /work/findings.json, y el runner los PATCHea a `findings`. El worker (TS) los aplica vía
-- store.publishFindings (RLS por tenant + partición de reviewGate.ts): P0 → mismo sprint (re-bloquea),
-- deferred → sprint siguiente. `applied_at` marca que el worker ya los procesó (idempotente).
-- Todo aditivo y nullable → los build-jobs existentes (kind default 'build') no cambian.

alter table public.build_jobs
  add column if not exists kind text not null default 'build'
    check (kind in ('build', 'review')),
  add column if not exists findings jsonb,        -- lo que el reviewer escribió (raw), lo llena el runner
  add column if not exists applied_at timestamptz, -- cuándo el worker corrió publishFindings (idempotencia)
  add column if not exists sprint_key text,        -- el sprint revisado (para el ctx de publishFindings)
  add column if not exists next_sprint_key text;   -- a dónde van las findings 'deferred'
