-- P5-4 · MEMORIA del AI Assistant (persistencia de conversación). Hasta ahora el chat vivía en
-- useState([]) del console → se perdía al recargar/navegar. Estas dos tablas le dan historia real:
-- el tenant CREA/LEE/renombra/borra sus conversaciones y appendea mensajes; el bubble se persiste
-- del lado console (el worker sigue recibiendo {messages} y no escribe nada). El worker, si alguna
-- vez necesitara leerlas, usa service_role (bypassa RLS) — no hay policy de escritura para él.
--
-- RLS: idéntica al resto del schema (F1-01/F2-01) — tenant_id en cada fila (incl. messages, golden
-- rule 3: toda tabla lleva tenant_id + policy propia), scopeada a auth.jwt()->>'tenant' (fail-closed
-- si falta el claim). Test de fuga cross-tenant en supabase/tests/ (bloqueante en CI).

-- ── Conversaciones (hilos) ────────────────────────────────────────────────────────────────────────
create table if not exists public.assistant_conversations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  project_id  uuid not null references public.projects(id) on delete cascade,
  title       text,                    -- derivado del primer mensaje; el tenant lo puede renombrar
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Como projects (F5-P1): el cliente NUNCA setea tenant_id — sale del claim del JWT (mismo valor que
-- exige el RLS with-check). Un insert desde el browser no puede forjar otro tenant.
alter table public.assistant_conversations alter column tenant_id set default (auth.jwt() ->> 'tenant')::uuid;

alter table public.assistant_conversations enable row level security;
revoke all on public.assistant_conversations from anon, authenticated;
-- El tenant es dueño de sus hilos: crea, lee, renombra (update title) y borra (cascade a messages).
grant select, insert, update, delete on public.assistant_conversations to authenticated;

create index if not exists assistant_conversations_project_idx
  on public.assistant_conversations (project_id, created_at desc);

create policy conv_select_own_tenant on public.assistant_conversations
  for select to authenticated
  using (tenant_id = (auth.jwt() ->> 'tenant')::uuid);

create policy conv_insert_own_tenant on public.assistant_conversations
  for insert to authenticated
  with check (tenant_id = (auth.jwt() ->> 'tenant')::uuid);

create policy conv_update_own_tenant on public.assistant_conversations
  for update to authenticated
  using (tenant_id = (auth.jwt() ->> 'tenant')::uuid)
  with check (tenant_id = (auth.jwt() ->> 'tenant')::uuid);

create policy conv_delete_own_tenant on public.assistant_conversations
  for delete to authenticated
  using (tenant_id = (auth.jwt() ->> 'tenant')::uuid);

-- ── Mensajes (append-only del lado cliente) ───────────────────────────────────────────────────────
create table if not exists public.assistant_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.assistant_conversations(id) on delete cascade,
  tenant_id       uuid not null,
  project_id      uuid not null references public.projects(id) on delete cascade,
  role            text not null check (role in ('user','assistant')),
  content         text not null,
  created_at      timestamptz not null default now()
);

alter table public.assistant_messages alter column tenant_id set default (auth.jwt() ->> 'tenant')::uuid;

alter table public.assistant_messages enable row level security;
revoke all on public.assistant_messages from anon, authenticated;
-- Solo select/insert: los mensajes no se editan ni borran de a uno (borrar el hilo cascadea).
grant select, insert on public.assistant_messages to authenticated;

create index if not exists assistant_messages_conversation_idx
  on public.assistant_messages (conversation_id, created_at);

create policy msg_select_own_tenant on public.assistant_messages
  for select to authenticated
  using (tenant_id = (auth.jwt() ->> 'tenant')::uuid);

create policy msg_insert_own_tenant on public.assistant_messages
  for insert to authenticated
  with check (tenant_id = (auth.jwt() ->> 'tenant')::uuid);

-- ── Realtime (para que el chat viva sin polling, y sobreviva multi-pestaña) ────────────────────────
alter publication supabase_realtime add table public.assistant_conversations;
alter publication supabase_realtime add table public.assistant_messages;

comment on table public.assistant_conversations is 'Hilos del AI Assistant (P5-4). El tenant CREA/LEE/renombra/borra; RLS por tenant. La persistencia la escribe el console (el worker recibe {messages} y no escribe).';
comment on table public.assistant_messages is 'Mensajes de una conversación del AI Assistant (P5-4). Append-only del lado cliente (select/insert). RLS por tenant.';
