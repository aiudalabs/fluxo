-- Seed de diseño para el proyecto dev "Rosa la peluquería" — para que el Studio portado
-- de v1 renderice con contenido real (fases + docs + gate conversacional + versiones).
-- Idempotente: limpia el run previo del proyecto y reinserta.

do $$
declare
  v_tenant  uuid := 'd1d1d1d1-0000-0000-0000-0000000000a1';
  v_project uuid := 'd1d1d1d1-0000-0000-0000-0000000000f1';
  v_run     uuid := 'd1d1d1d1-0000-0000-0000-00000000d001';
begin
  delete from design_gates  where project_id = v_project;
  delete from design_phases where project_id = v_project;
  delete from design_runs   where project_id = v_project;
  delete from brain_events  where project_id = v_project and kind = 'artifact';

  -- Run en curso, esperando el gate de UI.
  insert into design_runs (id, tenant_id, project_id, workflow, status)
  values (v_run, v_tenant, v_project, 'design', 'awaiting_gate');

  -- Fases (stepper del riel). discovery/prd/architecture aprobadas; ui esperando gate;
  -- mockups/backlog pendientes. artifacts = docs cosechados (markdown real).
  insert into design_phases (tenant_id, project_id, run_id, phase_id, label, ord, status, artifacts) values
  (v_tenant, v_project, v_run, 'discovery', 'Descubrimiento', 1, 'done', jsonb_build_array(
    jsonb_build_object('path','docs/BRIEF.md','kind','doc','content',
$md$# Brief — Rosa la peluquería

## El problema
Rosa maneja su peluquería con un cuaderno y WhatsApp. Pierde turnos por dobles reservas,
no recuerda quién debe seña, y los clientes la interrumpen todo el día para preguntar horarios.

## Quién lo usa
- **La clienta** — quiere reservar un turno desde el celular, ver servicios y precios, y que le
  recuerden el día antes.
- **Rosa (dueña)** — quiere ver su día de un vistazo, cobrar señas, y reprogramar sin llamar.

## La idea en una frase
Una app donde la clienta reserva sola y Rosa administra su agenda — con recordatorios por
WhatsApp y seña online para bajar los plantones.
$md$)))
  ,
  (v_tenant, v_project, v_run, 'prd', 'PRD', 2, 'done', jsonb_build_array(
    jsonb_build_object('path','docs/PRD.md','kind','doc','content',
$md$# PRD — Rosa la peluquería

## Objetivo
Reducir turnos perdidos y liberar a Rosa del teléfono. Éxito = 80% de las reservas hechas por
la clienta sin intervención, y plantones por debajo del 10%.

## Historias núcleo (MVP)
1. La clienta ve los servicios y sus duraciones/precios.
2. La clienta reserva un turno (día + hora disponibles).
3. La clienta paga una seña al reservar.
4. Rosa ve el panel del día y reprograma o cancela.
5. Recordatorio por WhatsApp el día previo.
6. Login con Google para la clienta.

## Fuera de alcance (v1)
- Multi-sucursal, comisiones por empleada, inventario de productos.
$md$)))
  ,
  (v_tenant, v_project, v_run, 'architecture', 'Arquitectura', 3, 'done', jsonb_build_array(
    jsonb_build_object('path','docs/ARCHITECTURE.md','kind','doc','content',
$md$# Arquitectura — Rosa la peluquería

## Stack
- **App**: Flutter (clienta + dueña en una sola app, roles por claim).
- **Backend**: Firebase (Auth Google, Firestore, Cloud Functions, FCM para push).
- **Pagos**: Mercado Pago Checkout Pro para la seña.

## Modelo de datos (resumen)
- `services` — nombre, duración, precio.
- `slots` — turnos generados del horario de Rosa.
- `bookings` — turno + clienta + estado (reservado/señado/cumplido/cancelado).

## Reglas clave
- Una reserva toma el slot en una transacción → sin dobles reservas.
- El recordatorio es una Cloud Function programada (día previo, 18:00).
$md$)))
  ,
  (v_tenant, v_project, v_run, 'ui', 'Pantallas', 4, 'awaiting_gate', jsonb_build_array(
    jsonb_build_object('path','docs/UI_SCREENS.md','kind','doc','content',
$md$# Pantallas — Rosa la peluquería

## Clienta
1. **Servicios** — lista con foto, duración y precio.
2. **Elegir horario** — calendario con slots libres del servicio elegido.
3. **Reservar + seña** — resumen y botón de pago (Mercado Pago).
4. **Mis turnos** — próximos y pasados; reprogramar/cancelar.

## Dueña (Rosa)
5. **Panel del día** — turnos de hoy en línea de tiempo; tocar para ver/editar.
6. **Home de la marca** — estética de la peluquería (colores, logo).

## Preguntas abiertas
- ¿La seña es un monto fijo o un % del servicio?
- ¿Rosa quiere confirmar cada reserva a mano, o se confirman solas al pagar la seña?
$md$)))
  ,
  (v_tenant, v_project, v_run, 'mockups', 'Mockups', 5, 'pending', '[]'::jsonb),
  (v_tenant, v_project, v_run, 'backlog',  'Backlog',  6, 'pending', '[]'::jsonb);

  -- Gate conversacional pendiente sobre la fase de UI (aprobar / pedir cambios / responder).
  insert into design_gates (tenant_id, project_id, run_id, phase_id, gate_id, reason, open_questions, attempt, status)
  values (v_tenant, v_project, v_run, 'ui', 'ui_gate',
    'Revisá las pantallas antes de generar los mockups. Confirmá el flujo de seña y confirmación.',
    jsonb_build_array(
      '¿La seña es un monto fijo o un % del servicio?',
      '¿Rosa confirma cada reserva a mano, o se confirman solas al pagar la seña?'
    ), 1, 'pending');

  -- Versiones del PRD en el brain (append-only) → los chips v1/v2 del reader. Cada evento
  -- guarda su `content` para que ver una versión vieja rinda el cuerpo real de esa versión.
  insert into brain_events (tenant_id, project_id, kind, payload, actor, ts) values
  (v_tenant, v_project, 'artifact', jsonb_build_object('path','docs/PRD.md','message','design: publish prd (discovery_gate approved)','content',
$md$# PRD — Rosa la peluquería

## Objetivo
Reducir turnos perdidos y liberar a Rosa del teléfono.

## Historias núcleo (MVP)
1. La clienta ve los servicios y sus duraciones/precios.
2. La clienta reserva un turno (día + hora disponibles).
3. Rosa ve el panel del día y reprograma o cancela.
4. Recordatorio por WhatsApp el día previo.
5. Login con Google para la clienta.

## Fuera de alcance (v1)
- Seña online, multi-sucursal, inventario.
$md$), 'agent:pm', now() - interval '2 hours'),
  (v_tenant, v_project, 'artifact', jsonb_build_object('path','docs/PRD.md','message','design: publish prd (revisión: agregar seña online)','content',
$md$# PRD — Rosa la peluquería

## Objetivo
Reducir turnos perdidos y liberar a Rosa del teléfono. Éxito = 80% de las reservas hechas por
la clienta sin intervención, y plantones por debajo del 10%.

## Historias núcleo (MVP)
1. La clienta ve los servicios y sus duraciones/precios.
2. La clienta reserva un turno (día + hora disponibles).
3. La clienta paga una seña al reservar.
4. Rosa ve el panel del día y reprograma o cancela.
5. Recordatorio por WhatsApp el día previo.
6. Login con Google para la clienta.

## Fuera de alcance (v1)
- Multi-sucursal, comisiones por empleada, inventario de productos.
$md$), 'agent:pm', now() - interval '20 minutes');
end $$;
