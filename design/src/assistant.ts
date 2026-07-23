// P5-1 · AI Assistant — corre un turno de chat con el claude-agent-sdk (token de suscripción, el
// mismo que el worker ya usa para diseñar). Vive en el WORKER (ambiente probado: debian-slim +
// USER node + SDK), NO en el console (alpine/root = incierto); el console PROXEA a este runner.
//
// El estado del proyecto se PRE-FETCHEA e inyecta en el system prompt. El bot responde sobre el estado
// y SUGIERE acciones (pedir incremento / despachar / aprobar gate) pero NO las ejecuta — el usuario las
// confirma desde la UI (tarjeta ```fluxo-action```). Las tools READ (leer un doc/story/backlog) son un
// incremento posterior (P5-1 · Pieza 3), pasadas por `mcpServers`.
//
// STREAMING (P5-1 · Pieza 2): con `includePartialMessages` el SDK emite deltas de texto por token; el
// callback `onDelta` los reenvía (el worker los sirve como SSE) para que el chat se sienta vivo en vez
// de "pensando…" 14–40s. El texto final (fuente de verdad para parsear el bloque fluxo-action) se
// acumula de los mensajes `assistant`; si no llegaran parciales, el resultado sigue correcto (un solo
// chunk al cerrar).

import { query } from "@anthropic-ai/claude-agent-sdk";

export interface ChatMsg { role: "user" | "assistant"; content: string }

// El tipo de `query` que usamos (subconjunto): un factory que devuelve un async-iterable de mensajes
// del SDK. Se puede inyectar (`queryFn`) para testear sin spawnear el CLI real.
export type QueryFn = typeof query;

// sseEvent · framing SSE puro (testeable): un objeto → una línea `data: {json}\n\n`.
export function sseEvent(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function role(state: string): string {
  return `Sos el **AI Assistant de Fluxo** para UN proyecto. Fluxo es una fábrica de software gobernada:
convierte un brief en un backlog gateado y lo construye con agentes en el GitHub del cliente. El usuario
es una agencia/dev-shop. Respondé en **español**, conciso, claro, sin jerga interna.

Tenés el ESTADO ACTUAL del proyecto abajo — usalo para responder (qué está trabado y por qué, cuánto se
gastó, qué falta, qué conviene hacer). **NO inventes** datos que no estén en el estado; si no sabés, decilo.
Si necesitás detalle que no está en el resumen (el cuerpo de una story, un doc del brain, el backlog
completo), usá las tools de lectura disponibles antes de responder.

## Proponer una acción (confirmable)
Cuando el usuario claramente quiere que HAGAS algo, explicá en prosa qué vas a proponer y **terminá el
mensaje con UN bloque** (elegí el tipo según lo que pide):

Agregar una feature/mejora al producto (incremento / change-request):
\`\`\`fluxo-action
{"type":"increment","summary":"<1 línea>","instructions":"<pedido completo, autocontenido, para el planner de iteración>"}
\`\`\`

Despachar el build de lo que esté listo (CUESTA $ — el conductor dispara un agente):
\`\`\`fluxo-action
{"type":"dispatch","summary":"<qué se despacha>","target":"<key de story/sprint (ej S1-01, SP1) o \\"next\\" para lo primero listo>"}
\`\`\`

Aprobar el gate de diseño que está esperando en el Studio:
\`\`\`fluxo-action
{"type":"gate","summary":"<qué gate>","outcome":"approve"}
\`\`\`

Reglas: **UN** bloque por mensaje, al final; SOLO si el usuario claramente quiere actuar (nunca en
preguntas informativas). Vos **NO ejecutás** nada — el usuario confirma la tarjeta en la UI. Sé honesto:
si algo no está listo (no hay nada para despachar, no hay gate esperando), decilo en vez de proponerlo.

=== ESTADO DEL PROYECTO ===
${state}
=== FIN DEL ESTADO ===`;
}

export interface RunAssistantOpts {
  stateSummary: string;
  messages: ChatMsg[];
  model?: string;
  onDelta?: (delta: string) => void;         // Pieza 2: streaming — cada delta de texto del SDK.
  mcpServers?: Record<string, unknown>;      // Pieza 3: tools READ (createSdkMcpServer).
  allowedTools?: string[];                   // Pieza 3: whitelist de tools.
  maxTurns?: number;                         // >1 cuando hay tools (tool-call → respuesta).
  queryFn?: QueryFn;                         // inyectable para tests.
}

// runAssistant corre UN turno de chat y devuelve el texto de la respuesta. Con onDelta, además emite
// deltas incrementales (streaming). model default = sonnet (rápido/barato para chat).
export async function runAssistant(opts: RunAssistantOpts): Promise<string> {
  const q = opts.queryFn ?? query;
  const history = opts.messages.map((m) => `${m.role === "user" ? "Usuario" : "Asistente"}: ${m.content}`).join("\n\n");
  let final = "";      // de los mensajes `assistant` — fuente de verdad del texto final.
  let streamed = "";   // de los deltas parciales — para el live + fallback si no hay `assistant`.
  for await (const message of q({
    prompt: `${history}\n\nAsistente:`,
    options: {
      systemPrompt: role(opts.stateSummary),
      model: opts.model ?? "claude-sonnet-5",
      allowedTools: opts.allowedTools ?? [],
      mcpServers: opts.mcpServers,
      settingSources: [],
      permissionMode: "default",
      includePartialMessages: true,   // Pieza 2: emite stream_event con deltas de texto.
      maxTurns: opts.maxTurns ?? 1,
      cwd: "/tmp",
    },
  } as Parameters<QueryFn>[0])) {
    if (message.type === "stream_event") {
      const ev = message.event;
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        streamed += ev.delta.text;
        opts.onDelta?.(ev.delta.text);
      }
    } else if (message.type === "assistant") {
      for (const block of message.message.content) if (block.type === "text") final += block.text;
    } else if (message.type === "result" && message.subtype === "success" && !final) {
      final = message.result;
    }
  }
  return (final || streamed).trim() || "(sin respuesta)";
}
