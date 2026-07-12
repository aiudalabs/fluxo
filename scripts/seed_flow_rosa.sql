-- Seed de Flow para Rosa — títulos/goals de los sprints (para las vistas Ciclo/Grafo/
-- Sprints). Idempotente; asume que los sprints SP1/SP2/SP3 ya existen (seed del board).
update sprints set title='Reservar y ver servicios', goal='La clienta reserva sola: servicios, horario y sus turnos.'
  where project_id='d1d1d1d1-0000-0000-0000-0000000000f1' and key='SP1';
update sprints set title='Panel de Rosa', goal='Rosa administra su día y manda recordatorios.'
  where project_id='d1d1d1d1-0000-0000-0000-0000000000f1' and key='SP2';
update sprints set title='Seña y marca', goal='Cobro de seña online y estética de la peluquería.'
  where project_id='d1d1d1d1-0000-0000-0000-0000000000f1' and key='SP3';
