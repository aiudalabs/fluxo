-- F4 (docs/19 §3.4) · severity de origen-finding en stories.
-- El REVIEWER autónomo (contexto fresco) produce findings post-sprint; una P0 se re-inyecta como
-- story de origen-finding en el MISMO sprint → el gate "sprint done ⟺ 0 P0" (design/src/reviewGate.ts)
-- la reconoce y bloquea el cierre del sprint hasta que esté 'done'. Una 'deferred' va al backlog del
-- sprint siguiente y NO bloquea.
--
-- Aditivo y nullable: null = story normal (no nació de un finding) → el gate pasa trivial, así los
-- proyectos legacy sin reviewer NO cambian de comportamiento. RLS ya aplica por tenant (columna nueva
-- de una tabla ya scopeada por project_id/tenant_id).

alter table public.stories
  add column if not exists severity text
    check (severity is null or severity in ('P0', 'deferred'));

-- Índice parcial: el gate consulta "¿este sprint tiene P0 abiertas?" — filtra por severity no-null.
create index if not exists stories_severity_idx
  on public.stories (project_id, sprint_id)
  where severity is not null;
