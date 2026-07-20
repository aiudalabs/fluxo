// P5-1 · AI Assistant — corre un turno de chat con el claude-agent-sdk (token de suscripción, el
// mismo que el worker ya usa para diseñar). Vive en el WORKER (ambiente probado: debian-slim +
// USER node + SDK), NO en el console (alpine/root = incierto); el console PROXEA a este runner.
//
// v1 = READ-ONLY: el estado del proyecto se PRE-FETCHEA e inyecta en el system prompt (sin custom
// tools todavía). El bot responde sobre el estado y SUGIERE acciones (pedir incremento / despachar /
// aprobar gate) pero NO las ejecuta — el usuario las confirma desde la UI. Las tools de acción
// (con el patrón de confirmación) son el próximo incremento de P5-1.

import { query } from "@anthropic-ai/claude-agent-sdk";

export interface ChatMsg { role: "user" | "assistant"; content: string }

function role(state: string): string {
  return `Sos el **AI Assistant de Fluxo** para UN proyecto. Fluxo es una fábrica de software gobernada:
convierte un brief en un backlog gateado y lo construye con agentes en el GitHub del cliente. El usuario
es una agencia/dev-shop. Respondé en **español**, conciso, claro, sin jerga interna.

Tenés el ESTADO ACTUAL del proyecto abajo — usalo para responder (qué está trabado y por qué, cuánto se
gastó, qué falta, qué conviene hacer). **NO inventes** datos que no estén en el estado; si no sabés, decilo.

## Proponer un incremento (acción confirmable)
Cuando el usuario claramente quiere **agregar una feature o mejora** al producto ya construido (un
incremento / change-request), explicá en prosa qué vas a proponer y **terminá el mensaje con UN bloque**:

\`\`\`fluxo-action
{"type":"increment","summary":"<qué se pedirá, 1 línea>","instructions":"<el pedido completo, autocontenido y claro para el planner de iteración>"}
\`\`\`

Reglas del bloque: SOLO si el usuario quiere agregar algo concreto (nunca en preguntas informativas);
**UN** bloque por mensaje, al final; el \`instructions\` debe ser **autocontenido** (el planner lo lee sin
más contexto). Vos **NO ejecutás** nada — el usuario confirma la tarjeta en la UI. Para **despachar** un
build o **aprobar un gate**, por ahora solo sugerilo en prosa (sin bloque; se hacen desde el board / Studio).

=== ESTADO DEL PROYECTO ===
${state}
=== FIN DEL ESTADO ===`;
}

// runAssistant corre UN turno y devuelve el texto de la respuesta (v1 sin streaming — de-riesga el
// loop; el streaming SSE es un incremento posterior). model default = sonnet (rápido/barato para chat).
export async function runAssistant(opts: { stateSummary: string; messages: ChatMsg[]; model?: string }): Promise<string> {
  const history = opts.messages.map((m) => `${m.role === "user" ? "Usuario" : "Asistente"}: ${m.content}`).join("\n\n");
  let text = "";
  for await (const message of query({
    prompt: `${history}\n\nAsistente:`,
    options: {
      systemPrompt: role(opts.stateSummary),
      model: opts.model ?? "claude-sonnet-5",
      allowedTools: [],          // v1 read-only: sin tools de archivo ni de acción
      settingSources: [],
      permissionMode: "default",
      maxTurns: 1,
      cwd: "/tmp",               // el CLI corre en un dir; no toca archivos (allowedTools vacío)
    },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) if (block.type === "text") text += block.text;
    } else if (message.type === "result" && message.subtype === "success" && !text) {
      text = message.result;
    }
  }
  return text.trim() || "(sin respuesta)";
}
