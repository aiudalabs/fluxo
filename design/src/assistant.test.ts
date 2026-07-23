import { test } from "node:test";
import assert from "node:assert/strict";
import { runAssistant, sseEvent, type QueryFn } from "./assistant.ts";

// Un fake de `query` del SDK: devuelve un async-iterable de los mensajes que le pasemos. Así testeamos
// la acumulación de deltas + selección del texto final SIN spawnear el CLI real.
function fakeQuery(messages: unknown[]): QueryFn {
  return (() => (async function* () { for (const m of messages) yield m; })()) as unknown as QueryFn;
}
const delta = (text: string) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
const asstMsg = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
const result = (text: string) => ({ type: "result", subtype: "success", result: text });

const base = { stateSummary: "estado", messages: [{ role: "user" as const, content: "hola" }] };

test("sseEvent: framea un objeto como línea SSE data: {json}\\n\\n", () => {
  assert.equal(sseEvent({ delta: "hi" }), 'data: {"delta":"hi"}\n\n');
  assert.equal(sseEvent({ done: true, text: "x" }), 'data: {"done":true,"text":"x"}\n\n');
});

test("runAssistant: streaming — onDelta recibe cada delta y el final sale del mensaje assistant", async () => {
  const got: string[] = [];
  const text = await runAssistant({
    ...base,
    onDelta: (d) => got.push(d),
    queryFn: fakeQuery([delta("Ho"), delta("la"), asstMsg("Hola")]),
  });
  assert.deepEqual(got, ["Ho", "la"]);   // los deltas llegaron incrementales
  assert.equal(text, "Hola");            // el texto final = fuente de verdad (mensaje assistant)
});

test("runAssistant: sin parciales (solo assistant) devuelve el texto igual", async () => {
  const got: string[] = [];
  const text = await runAssistant({ ...base, onDelta: (d) => got.push(d), queryFn: fakeQuery([asstMsg("Respuesta")]) });
  assert.deepEqual(got, []);
  assert.equal(text, "Respuesta");
});

test("runAssistant: si no hay mensaje assistant, cae a los deltas acumulados", async () => {
  const text = await runAssistant({ ...base, queryFn: fakeQuery([delta("solo "), delta("deltas")]) });
  assert.equal(text, "solo deltas");
});

test("runAssistant: fallback al result cuando no hubo texto de assistant", async () => {
  const text = await runAssistant({ ...base, queryFn: fakeQuery([result("desde result")]) });
  assert.equal(text, "desde result");
});

test("runAssistant: sin nada devuelve el placeholder", async () => {
  const text = await runAssistant({ ...base, queryFn: fakeQuery([]) });
  assert.equal(text, "(sin respuesta)");
});
