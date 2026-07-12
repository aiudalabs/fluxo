# design/ — runtime de diseño (Agent SDK)

Corre los **agentes de diseño** del `registry/` por el **Claude Agent SDK** (D2): el
loop vive en el SDK, el **rol vive en markdown** (`registry/agents/<id>.md`). Cumple
la regla de oro y cierra **L-D2** (resolver `$step.output.text` bien).

```
src/resolve.ts   resolución de inputs del workflow — el fix de L-D2 (output.text)
src/agent.ts     loadAgent (rol .md + modelo del .yaml) + runAgent (query() → output.text)
src/run.ts       verify: corre un agente real y prueba la cadena del resolver
```

## Correr

Requiere `CLAUDE_CODE_OAUTH_TOKEN` en el entorno (el SDK spawnea el CLI `claude` que
autentica con ese token — **nunca** se hardcodea). Node 22.6+ (type stripping).

```bash
npm install
npm test                         # tests puros del resolver (sin API)
set -a; . ../.env; set +a        # trae CLAUDE_CODE_OAUTH_TOKEN
npm run run-agent -- analyst     # corrida real: analyst → brief en output.text
```

## Estado (F5-01)

- ✅ Un agente de fase (rol .md) corre por el SDK y devuelve `{ output: { text } }`.
- ✅ Resolver de `$step.output.text` (L-D2) con tests; la cadena entre fases funciona.
- **Próximo (incremental):** wirear las **skills** del `.yaml` (append al system prompt)
  y el **tool MCP `brain-write`** (F1-02) vía la opción `mcpServers` del SDK, y orquestar
  el workflow `design.yaml` completo con sus `human_gate` (F5-04).
