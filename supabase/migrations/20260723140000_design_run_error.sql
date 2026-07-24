-- Addendum P5-1 (co-piloto de operaciones) · Persistir el PORQUÉ de un design-run fallido. Hoy el
-- mensaje del error se pierde en stdout del worker: la UI/assistant solo saben "failed", no "failed
-- porque un 525 transitorio de Supabase cortó la fase data_model". Con el error + si fue transitorio
-- (5xx/525 tras agotar reintentos) o fatal, `buildStateSummary` y la tool `get_run_status` pueden
-- explicar la causa y proponer la acción "Reanudar" (endpoint /design/resume) con contexto real.
--
-- design_runs ya tiene replica identity full + está en la publicación supabase_realtime → las nuevas
-- columnas viajan en el UPDATE (el banner de run fallido del Studio las puede mostrar). Sin cambio de
-- RLS: las columnas heredan las policies de la tabla.
alter table public.design_runs
  add column if not exists error      text,
  add column if not exists error_kind text check (error_kind in ('transient','fatal'));

comment on column public.design_runs.error is 'Mensaje del error que dejó el run failed (últ. línea del catch de main.ts). Null si no falló / se recuperó.';
comment on column public.design_runs.error_kind is 'transient (5xx/525 tras agotar reintentos) | fatal — ayuda al assistant a explicar la causa y a decidir si proponer resume.';
