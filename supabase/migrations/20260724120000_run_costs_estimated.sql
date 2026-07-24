-- run_costs: costo ESTIMADO para runs cancelados/timeout. El happy-path (claude-execution-output.json →
-- marcador fluxo:cost) solo existe si la Action TERMINA; un run cancelado/timeout gastó plata real pero
-- registraba $0 (invisible en spend). El worker ahora estima el costo parseando los tokens del LOG del
-- run (bloques usage del stream-json) y aplicando la tabla de precios de LiteLLM. Estas columnas marcan
-- esas filas como estimadas y guardan el modelo + cache_write (que el marcador happy-path no capturaba).
alter table public.run_costs
  add column if not exists estimated boolean not null default false,
  add column if not exists model text,
  add column if not exists cache_write_tokens bigint not null default 0;

comment on column public.run_costs.estimated is 'true = costo estimado del log (run cancelado/timeout, sin execution file); false = autoritativo del claude-execution-output.json.';
