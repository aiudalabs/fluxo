-- Settings del proyecto (F6P-Settings) · un jsonb en projects para la config de autonomía,
-- canal por defecto y routing por lane. Editable por el tenant (la policy update ya existe).
-- El worker (service_role) lo lee para respetar los knobs. NADA de secretos acá: el
-- CLAUDE_CODE_OAUTH_TOKEN nunca se guarda en Fluxo — vive solo como Actions secret del repo
-- (BYO), sembrado vía gh y verificado por un probe live (no un flag en DB).
--
-- Shape (todos opcionales; la UI aplica defaults):
--   {
--     channel:            "claude_action" | "copilot",   -- canal de build por defecto
--     merge_mode:         "manual" | "auto",
--     execution_unit:     "sprint" | "story",
--     max_concurrency:    int,                            -- 0 = ilimitado
--     workflow_approval:  "manual" | "auto_if_safe",
--     lanes: { "<lane>": { channel?: "claude_action"|"copilot", model?: string } }
--   }
alter table public.projects
  add column if not exists settings jsonb not null default '{}'::jsonb;

comment on column public.projects.settings is
  'Config del proyecto (autonomía/merge/canal/routing por lane). Sin secretos. F6P-Settings.';
