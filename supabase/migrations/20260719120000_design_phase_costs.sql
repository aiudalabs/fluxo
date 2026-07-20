-- P4-2 (Observabilidad) · costo/tokens/latencia por FASE de diseño.
-- Hasta ahora solo se logueaba el costo del BUILD (run_costs, vía claude-code-action). El costo del
-- DISEÑO (los agentes SDK por fase) no se persistía. El SDK lo reporta en el result message; el
-- AgentRunner lo pasa (PhaseResult.usage) y el Sink lo escribe acá al completar la fase.
--
-- Mismos nombres de columna que run_costs (usd/input_tokens/output_tokens/cache_read_tokens) para que
-- la vista Observabilidad una diseño+build de forma uniforme. Nullable: fases viejas (pre-P4-2) quedan
-- en null (el UI muestra "—"). Overwrite con la última corrida (un revise sobrescribe; acumular = v2).
-- Aditivo: no toca RLS (las policies de design_phases ya aplican a las columnas nuevas).

alter table public.design_phases
  add column if not exists usd               numeric(12,6),
  add column if not exists input_tokens      bigint,
  add column if not exists output_tokens     bigint,
  add column if not exists cache_read_tokens bigint,
  add column if not exists duration_ms       bigint,
  add column if not exists model             text;

comment on column public.design_phases.usd is 'P4-2: costo USD de la última corrida de esta fase (agente SDK). null = fase pre-instrumentación.';
