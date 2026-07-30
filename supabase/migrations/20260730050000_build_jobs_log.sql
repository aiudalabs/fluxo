-- Observabilidad del ExecEnv fluxo_engine (docs/17): el tailer host-level (fluxo-engine-tail) escribe
-- acá el log/progreso del agente en vivo; el console (EngineBuilds) lo muestra por Realtime.
alter table public.build_jobs add column if not exists log text;
alter table public.build_jobs add column if not exists progress jsonb;
