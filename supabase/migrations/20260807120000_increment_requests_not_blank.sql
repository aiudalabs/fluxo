-- Guard: un pedido de incremento EN BLANCO no puede entrar a la cola.
--
-- Por qué: la columna era `text not null`, que acepta '' — y el worker levanta CUALQUIER pedido
-- `pending` y spawnea main.ts --workflow=iterate, o sea que un pedido vacío DISPARA UN RUN PAGO del
-- iteration-planner sobre un change-request inexistente. Pasó de verdad (2026-08-07): un pedido
-- quedó con instructions='' por un bug del caller, el worker lo tomó en <20s y hubo que matar el
-- proceso a mano. No hay validación de servidor donde ponerla: el console INSERTA directo en la tabla
-- con el JWT del tenant (no pasa por una route de API), así que la base es el único lugar honesto.
--
-- 20 caracteres es un piso deliberadamente bajo: no juzga la calidad del pedido, sólo ataja el vacío
-- y el dedazo. El pedido más corto de los que ya existen tiene 188.
alter table public.increment_requests
  add constraint increment_requests_instructions_not_blank
  check (length(btrim(instructions)) >= 20);
