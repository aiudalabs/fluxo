// Estimar tokens desde el LOG de un run de la Action cuando NO hay execution file (cancel/timeout).
// claude-code-action con `show_full_output: true` vuelca el stream-json de la sesión al log del run:
// eventos `{"type":"assistant","message":{"id":"msg_…","usage":{…}}}` con el usage FINAL por mensaje.
// Sumamos el usage deduplicado por message-id (el stream emite el mismo msg más de una vez → tomar el
// de mayor output_tokens) para no doble-contar. El modelo sale de `message.model`.
//
// Es una ESTIMACIÓN honesta: sin el evento `result`/execution file no hay costUSD autoritativo. El
// cache_read domina el costo real (cada turno re-lee el prefijo cacheado), y ese lo capturamos bien.

import type { TokenCounts } from "./pricing.ts";

export interface LogUsage extends TokenCounts { model: string | null; messages: number }

// stripLogPrefixes: el log que devuelve la API de Actions (o `gh run view --log`) viene con líneas
// `job<TAB>step<TAB>TIMESTAMP <contenido>`. Nos quedamos SOLO con el contenido del step del action,
// sin el timestamp — así el stream-json queda reconstruible. Acepta también el log crudo (sin tabs).
export function stripLogPrefixes(raw: string): string {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const parts = line.split("\t");
    const body = parts.length >= 3 ? parts.slice(2).join("\t") : line;
    // Quitar el timestamp ISO inicial (con o sin BOM) si está.
    out.push(body.replace(/^﻿?\s*\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, ""));
  }
  return out.join("\n");
}

// decodeConcatenatedJson: el log intercala objetos JSON (pretty-printed) con marcadores `##[…]` y texto
// plano. Caminamos el texto decodificando cada objeto JSON top-level y salteando lo que no parsea.
function decodeConcatenatedJson(text: string): unknown[] {
  const objs: unknown[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const j = text.indexOf("{", i);
    if (j < 0) break;
    try {
      // JSON.parse no soporta "resto después del objeto"; usamos un intento incremental por longitud.
      const [obj, end] = rawDecodeFrom(text, j);
      objs.push(obj);
      i = end;
    } catch {
      i = j + 1;
    }
  }
  return objs;
}

// rawDecodeFrom: decodifica UN objeto JSON que empieza en `start` y devuelve [obj, indiceFin]. Encuentra
// el cierre balanceando llaves respetando strings/escapes (equivalente a json.raw_decode de Python).
function rawDecodeFrom(text: string, start: number): [unknown, number] {
  let depth = 0, inStr = false, esc = false;
  for (let k = start; k < text.length; k++) {
    const ch = text[k];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, k + 1);
        return [JSON.parse(slice), k + 1];
      }
    }
  }
  throw new Error("objeto JSON sin cerrar");
}

// usageFromActionLog: recorre los objetos, junta el usage por message-id (dedup por mayor output), suma.
export function usageFromActionLog(rawLog: string): LogUsage {
  const text = stripLogPrefixes(rawLog);
  const objs = decodeConcatenatedJson(text);
  const byId = new Map<string, TokenCounts>();
  let model: string | null = null;

  const visit = (o: unknown): void => {
    if (Array.isArray(o)) { for (const v of o) visit(v); return; }
    if (!o || typeof o !== "object") return;
    const rec = o as Record<string, unknown>;
    const id = rec.id;
    const usage = rec.usage;
    if (typeof id === "string" && id.startsWith("msg") && usage && typeof usage === "object") {
      const u = usage as Record<string, unknown>;
      const cur: TokenCounts = {
        inputTokens: Number(u.input_tokens) || 0,
        outputTokens: Number(u.output_tokens) || 0,
        cacheWriteTokens: Number(u.cache_creation_input_tokens) || 0,
        cacheReadTokens: Number(u.cache_read_input_tokens) || 0,
      };
      const prev = byId.get(id);
      // Dedup: el stream emite el msg varias veces; el de mayor output_tokens es el final.
      if (!prev || cur.outputTokens >= prev.outputTokens) byId.set(id, cur);
      if (!model && typeof rec.model === "string") model = rec.model;
    }
    for (const v of Object.values(rec)) visit(v);
  };
  for (const o of objs) visit(o);

  const tot: LogUsage = { model, messages: byId.size, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
  for (const u of byId.values()) {
    tot.inputTokens += u.inputTokens;
    tot.outputTokens += u.outputTokens;
    tot.cacheWriteTokens += u.cacheWriteTokens;
    tot.cacheReadTokens += u.cacheReadTokens;
  }
  return tot;
}
