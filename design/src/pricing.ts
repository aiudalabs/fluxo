// Tabla de precios por modelo (USD por token) — para ESTIMAR el costo de un run cuando la Action se
// cancela/timeoutea y no deja el `claude-execution-output.json` (el costUSD que calcula el propio
// claude-code-action solo se escribe al terminar). Con esto el spend deja de mentir $0 en runs cortados.
//
// FUENTE: LiteLLM `model_prices_and_context_window.json` — la tabla machine-readable de-facto que usan
// LiteLLM y Langfuse para costear. Subset de modelos Claude "planos" (como los reporta el CLI en el log).
//   https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
//   snapshot: 2026-07-24. NO transcrito a mano: generado del JSON (evita errores de dedo).
// Para refrescar: volver a generar el subset del JSON de LiteLLM (mismo criterio: keys claude-* con
// opus/sonnet/haiku/fable). Si un modelo no está acá, la estimación devuelve null (se marca "desconocido"
// en vez de inventar un precio — golden rule: nunca fabricar valores).

export interface ModelPrice {
  inUSD: number;         // input_cost_per_token
  outUSD: number;        // output_cost_per_token
  cacheReadUSD: number;  // cache_read_input_token_cost
  cacheWriteUSD: number; // cache_creation_input_token_cost
}

// Subset Claude de LiteLLM (USD/token). Keys = model ids tal como los reporta el CLI.
export const CLAUDE_PRICES: Record<string, ModelPrice> = {
  "claude-3-7-sonnet-20250219": { inUSD: 3e-06, outUSD: 1.5e-05, cacheReadUSD: 3e-07, cacheWriteUSD: 3.75e-06 },
  "claude-3-haiku-20240307": { inUSD: 2.5e-07, outUSD: 1.25e-06, cacheReadUSD: 3e-08, cacheWriteUSD: 3e-07 },
  "claude-3-opus-20240229": { inUSD: 1.5e-05, outUSD: 7.5e-05, cacheReadUSD: 1.5e-06, cacheWriteUSD: 1.875e-05 },
  "claude-4-opus-20250514": { inUSD: 1.5e-05, outUSD: 7.5e-05, cacheReadUSD: 1.5e-06, cacheWriteUSD: 1.875e-05 },
  "claude-4-sonnet-20250514": { inUSD: 3e-06, outUSD: 1.5e-05, cacheReadUSD: 3e-07, cacheWriteUSD: 3.75e-06 },
  "claude-fable-5": { inUSD: 1e-05, outUSD: 5e-05, cacheReadUSD: 1e-06, cacheWriteUSD: 1.25e-05 },
  "claude-haiku-4-5": { inUSD: 1e-06, outUSD: 5e-06, cacheReadUSD: 1e-07, cacheWriteUSD: 1.25e-06 },
  "claude-haiku-4-5-20251001": { inUSD: 1e-06, outUSD: 5e-06, cacheReadUSD: 1e-07, cacheWriteUSD: 1.25e-06 },
  "claude-opus-4-1": { inUSD: 1.5e-05, outUSD: 7.5e-05, cacheReadUSD: 1.5e-06, cacheWriteUSD: 1.875e-05 },
  "claude-opus-4-1-20250805": { inUSD: 1.5e-05, outUSD: 7.5e-05, cacheReadUSD: 1.5e-06, cacheWriteUSD: 1.875e-05 },
  "claude-opus-4-20250514": { inUSD: 1.5e-05, outUSD: 7.5e-05, cacheReadUSD: 1.5e-06, cacheWriteUSD: 1.875e-05 },
  "claude-opus-4-5": { inUSD: 5e-06, outUSD: 2.5e-05, cacheReadUSD: 5e-07, cacheWriteUSD: 6.25e-06 },
  "claude-opus-4-5-20251101": { inUSD: 5e-06, outUSD: 2.5e-05, cacheReadUSD: 5e-07, cacheWriteUSD: 6.25e-06 },
  "claude-opus-4-6": { inUSD: 5e-06, outUSD: 2.5e-05, cacheReadUSD: 5e-07, cacheWriteUSD: 6.25e-06 },
  "claude-opus-4-6-20260205": { inUSD: 5e-06, outUSD: 2.5e-05, cacheReadUSD: 5e-07, cacheWriteUSD: 6.25e-06 },
  "claude-opus-4-7": { inUSD: 5e-06, outUSD: 2.5e-05, cacheReadUSD: 5e-07, cacheWriteUSD: 6.25e-06 },
  "claude-opus-4-7-20260416": { inUSD: 5e-06, outUSD: 2.5e-05, cacheReadUSD: 5e-07, cacheWriteUSD: 6.25e-06 },
  "claude-opus-4-8": { inUSD: 5e-06, outUSD: 2.5e-05, cacheReadUSD: 5e-07, cacheWriteUSD: 6.25e-06 },
  "claude-sonnet-4-20250514": { inUSD: 3e-06, outUSD: 1.5e-05, cacheReadUSD: 3e-07, cacheWriteUSD: 3.75e-06 },
  "claude-sonnet-4-5": { inUSD: 3e-06, outUSD: 1.5e-05, cacheReadUSD: 3e-07, cacheWriteUSD: 3.75e-06 },
  "claude-sonnet-4-5-20250929": { inUSD: 3e-06, outUSD: 1.5e-05, cacheReadUSD: 3e-07, cacheWriteUSD: 3.75e-06 },
  "claude-sonnet-4-6": { inUSD: 3e-06, outUSD: 1.5e-05, cacheReadUSD: 3e-07, cacheWriteUSD: 3.75e-06 },
  "claude-sonnet-5": { inUSD: 2e-06, outUSD: 1e-05, cacheReadUSD: 2e-07, cacheWriteUSD: 2.5e-06 },
};

export interface TokenCounts { inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number }

// priceForModel: matchea un model id del log a la tabla. Exacto primero; si no, normaliza quitando el
// sufijo de fecha (`-YYYYMMDD`) y el `-vN:0` de bedrock, y prueba el prefijo más largo. null si no hay
// precio conocido (el caller marca "modelo desconocido" en vez de inventar).
export function priceForModel(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  if (CLAUDE_PRICES[model]) return CLAUDE_PRICES[model];
  const norm = model.replace(/^(?:[a-z]+\.)?anthropic\./, "").replace(/-v\d+:\d+$/, "");
  if (CLAUDE_PRICES[norm]) return CLAUDE_PRICES[norm];
  const base = norm.replace(/-\d{8}$/, "");
  if (CLAUDE_PRICES[base]) return CLAUDE_PRICES[base];
  // Último recurso: el prefijo conocido más largo (p.ej. "claude-sonnet-5-<algo>" → "claude-sonnet-5").
  let best: string | null = null;
  for (const k of Object.keys(CLAUDE_PRICES)) if (norm.startsWith(k) && (!best || k.length > best.length)) best = k;
  return best ? CLAUDE_PRICES[best] : null;
}

// costUSD: aplica la tarifa por-token. cache_read y cache_write se cobran distinto del input normal.
export function costUSD(t: TokenCounts, price: ModelPrice): number {
  return t.inputTokens * price.inUSD
    + t.outputTokens * price.outUSD
    + t.cacheReadTokens * price.cacheReadUSD
    + t.cacheWriteTokens * price.cacheWriteUSD;
}
