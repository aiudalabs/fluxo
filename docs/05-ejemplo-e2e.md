# 05 · Ejemplo end-to-end = spec de aceptación (Doña Rosa)

Este ejemplo es la **prueba de aceptación** del proyecto: cuando corre de punta a punta (Fase 10), Fluxo v2 está
terminado. Cada paso mapea a fases del `03-roadmap`.

## El caso
**Doña Rosa** tiene una peluquería. Quiere: (1) una **app móvil** para que sus clientas reserven turno, y (2) una
**web** para ella ver y ordenar los turnos. En español. → Es el stack multi-superficie (Flutter customer + web admin +
backend).

## El recorrido (y qué fase lo entrega)
1. **Rosa cuenta la idea en español.** → Studio / diseño (registry, Agent SDK · F5).
2. **Fluxo diseña por fases y Rosa aprueba cada una** (◆ gate): discovery → PRD → arquitectura → UI + mockup
   navegable → backlog. Todo se guarda en el brain. → F1 (brain), F5 (diseño), F6-02 (Studio), F5-04 (gates
   conversacionales).
3. **Sale el backlog ordenado como Issues en el GitHub de Rosa**, con grafo `blocked_by`. → F5-03, F2 (estado).
4. **Agentes implementan, en la nube de Rosa, con sus llaves** — elegís Runtime (dónde) × Provider (qué CLI); cada
   tarea en su ExecEnv aislado. Lanes: mobile (Flutter), web (React), backend. → F4 (capa de runtime).
5. **Verificación real antes de aceptar:** pruebas + revisión + **la pantalla se ve como el dibujo** (juez-visión) +
   el app habla con el backend (cross-lane). → F7.
6. **Cada tarea llega como PR** que se aprueba con un click (o auto-merge según autonomía). → F3 (Maestro), F7-01.
7. **La WEB:** preview en vivo por branch (tipo Lovable) → publicar a prod en el dominio de Rosa. → F8-01/02.
8. **La APP MÓVIL:** build firmado → distribución a link de prueba → (opt-in) tiendas. → F8-03/04.
9. **Todo trazable en el brain:** pedido → tarea → PR → publicado. → F1-03, F6-03.
10. **Change-request** ("recordatorio por WhatsApp") re-entra como tarea nueva y recorre el mismo ciclo (incluye infra
    nueva). → F8-05, L-LM-6.

## Criterios de aceptación duros (Fase 10)
- [ ] Un usuario nuevo (agencia) hace onboarding, conecta su GitHub, y crea el proyecto "Bella" sin tocar la DB a mano.
- [ ] El diseño gateado produce backlog con lanes mobile+web+backend y deps correctas, en el repo del cliente.
- [ ] Al menos una story de CADA lane se implementa, verifica (incluida verificación visual y cross-lane) y mergea sola
      hasta donde la autonomía lo permita.
- [ ] La web queda publicada y accesible; la app móvil queda distribuida a un link de prueba instalable.
- [ ] El brain muestra el trail requisito→issue→PR→publicado de al menos una feature, presentable al cliente.
- [ ] Dos proyectos de dos tenants distintos con la misma story-id NO se pisan (test de fuga cross-tenant verde).
- [ ] Un change-request re-entra el ciclo y actualiza el producto.

## Lo honesto
Los pasos 1-6 son el spine y se cierran temprano. Los pasos 7-8 (verificación visual real + entrega/tiendas + infra
del cliente) son la **última milla** que a v1 le faltaba — están en Fase 7 y 8, y son parte de "terminado", no un
extra.
