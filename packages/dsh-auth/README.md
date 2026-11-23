# @huaqiu/dsh-auth

Huaqiu account plugin: browser↔node credential flow for the Huaqiu PCB EDA tool set.

- Dual-face package. Browser half: auth.eda.cn overlay iframe + strict-origin postMessage
  handling + localStorage cache + push to node. Node half: `huaqiuAuth` capability
  (`getAccessToken` / `getUserInfo`) backed by an in-memory cache fed over the
  plugin-owned `webServer` route `/api/v1/huaqiu/auth`.
- **HQ Edge host mode.** When the plugin is loaded with a `config.hqEdgeBaseUrl`
  (injected by the HQ Edge supervisor as overlay entry `config`), the node half
  fetches the operator credential directly from HQ Edge's
  `GET /api/v1/auth/token` and is authoritative on boot — no browser login
  required. Resolution order inside `getUserInfo()`: host session → pushed
  (browser) session → persisted file (`~/.dsh/auth/session.json`) → null.
  Env fallback (`HQ_EDGE_BASE_URL` / `HQ_EDGE_AUTH_PATH` / `HQ_EDGE_HOST_TTL_SECONDS`)
  covers installs without a supervisor. See `src/host.ts`.
- Node-side persistence: the last known session is written to `~/.dsh/auth/session.json`
  on every `setCredentials`, so standalone auth survives a process restart (previously
  the in-memory cache was empty until the next browser login).
- **Huaqiu AI gateway, out of the box (standalone).** After a browser login the node
  half mirrors the EDA token into `HUAQIU_API_KEY` through the in-memory credential
  channel (`src/standaloneCredentials.ts`), and seeds the `llm-pi-ai` provider `huaqiu`
  (OpenAI-compatible, `auto-model`, 1M/256k, text+image) plus `agent-default-model`
  into the settings document (`src/provider.ts`). Endpoints come from the same
  `HQ_AI_ENV` selector HQ Edge uses — `prod` → `www.eda.cn`, `test` →
  `fdatasheets.com`, gateway root `/user-rest/ai/v1` — overridable per endpoint with
  `HQ_AI_GATEWAY_URL` / `HQ_AI_SUBSCRIPTION_BALANCES_URL` /
  `HQ_AI_SUBSCRIPTION_ORIGIN` / `HQ_AI_PROFILE_URL`. The SAME selector also drives the
  subscription-balance endpoint, the subscription origin the browser uses for GEN/ERC
  and the「Go to profile」URL (`GET /api/v1/huaqiu/auth/config` reports all three),
  so a `test` build never mixes a test gateway with a prod quota page. Host mode keeps
  HQ Edge as the owner: the supervisor writes those rows and concrete URLs, and this
  plugin only mirrors the token.
- Phase 0A POC. The chosen browser→host channel is a `webServer` route
  (`apiProxy`'s dispatch table is closed — see `docs/tasks/phase0-implementation-spec.md` §7).
- Status: host mode + persistence + standalone gateway provisioning implemented
  (spec `docs/tasks/dsh-auth-artifact.md`).
