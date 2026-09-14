# SnapGen Middleware V2

Middleware stateless em Node.js + TypeScript para integrar uma Custom GPT Action aos modelos de vídeo do SnapGen. A API pública recebe JSON, aplica validação específica por modelo e converte cada operação para o formato multipart documentado pelo SnapGen.

## Arquitetura

```text
GitHub -> deploy automático no Render -> snapgen-middleware -> SnapGen

ChatGPT GPT Action
  -> HTTPS + MIDDLEWARE_API_KEY
  -> https://snapgen-middleware.onrender.com
  -> registry + adapter do modelo
  -> multipart/form-data + SNAPGEN_API_KEY
  -> SnapGen -> provedor de vídeo
```

O `VideoModelRegistry` concentra capacidades, defaults, validação e seleção de endpoint. O controller permanece desacoplado do SnapGen pela interface `VideoProvider`.

## Compatibilidade V1

Os endpoints V1 continuam disponíveis sem alterações:

- `POST /video/generate`
- `GET /video/:uuid`
- `GET /health`
- `GET /privacy`

O payload V1 de Veo e sua resposta normalizada continuam válidos. Clientes existentes não precisam migrar. A V2 apenas amplia os modelos e adiciona operações.

## Endpoints V2

Todos os endpoints `/video/*` exigem `x-api-key: MIDDLEWARE_API_KEY`.

### `GET /video/models`

Lista modelos e capacidades seguras. Consulte-o quando o modelo ou os parâmetros compatíveis não forem conhecidos.

```json
{
  "models": [
    {
      "id": "veo-3.1-fast",
      "family": "veo",
      "supportsTextToVideo": true,
      "supportsImageToVideo": true,
      "supportsExtend": true,
      "resolutions": ["720p", "1080p"],
      "aspectRatios": ["16:9"],
      "durations": [8],
      "modes": [],
      "maxReferenceImages": 3
    }
  ]
}
```

### `POST /video/generate`

Geração text-to-video ou image-to-video:

```json
{
  "prompt": "A cinematic car driving along a coastal road",
  "model": "veo-3.1-fast",
  "duration": 8,
  "resolution": "720p",
  "aspect_ratio": "16:9",
  "mode_image": "frame",
  "ref_images": ["https://example.com/start.jpg"]
}
```

Resposta preservada da V1:

```json
{
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "status": "processing",
  "provider": "snapgen",
  "model": "veo-3.1-fast"
}
```

Cada URL `ref_images` é repetida no multipart. Para Grok, o adapter usa o campo documentado `file_urls`; nos demais modelos habilitados usa `ref_images`. Nunca é enviado `ref_images[]` ou JSON arbitrário.

### `POST /video/extend`

Extende uma geração existente. O UUID de origem é convertido internamente para o campo SnapGen `ref_history`.

```json
{
  "prompt": "Continue the scene as the car enters the city",
  "model": "veo-3.1-fast",
  "source_uuid": "550e8400-e29b-41d4-a716-446655440000"
}
```

```json
{
  "uuid": "7d9f6f50-18a1-4ff0-bd1f-5a83639928ad",
  "status": "processing",
  "provider": "snapgen",
  "operation": "extend",
  "model": "veo-3.1-fast"
}
```

Veo, Grok 3 e Seedance possuem extensão habilitada conforme a documentação fornecida. O modelo, duração, resolução e aspecto efetivos são herdados pelo SnapGen da geração de origem.

### `POST /video/storyboard`

Cria um storyboard Grok de 2 a 10 cenas. Cada cena dura 6 ou 10 segundos e o total não pode ultrapassar 45 segundos.

```json
{
  "model": "grok-video",
  "aspect_ratio": "landscape",
  "resolution": "720p",
  "scenes": [
    { "prompt": "Sunrise over a mountain range", "duration": 6 },
    { "prompt": "A river flows into the valley", "duration": 10 }
  ]
}
```

### `GET /video/:uuid`

Consulta qualquer geração, extensão ou storyboard. Códigos SnapGen `0/1` são normalizados para `processing`, `2` para `completed` e `3/-2` para `failed`. `videoUrl` só é devolvida quando documentada na resposta concluída.

## Modelos habilitados

- Veo: `veo-3.1`, `veo-3.1-fast`, `veo-3.1-lite`, `veo-2`, `omni-flash`
- Grok: `grok-3`, `grok-lower`
- Seedance: `seedance-2`, `seedance-2-omni`, `seedance-2-mini`, `seedance-2-5-omni`
- Flux: `flux-3`
- MiniMax: `minimax-h3`
- Kling: `kling-video-3-0`, `kling-video-2-6`, `kling-video-o1`, `kling-video-2-5`, `kling-video-2-1-10s`, `kling-video-2-1-5s`, `kling-video-1-6-10s`, `kling-video-1-6-5s`

Consulte `GET /video/models` ou [docs/snapgen-model-capabilities.md](docs/snapgen-model-capabilities.md) para combinações de duração, resolução, aspecto, modo, referências e extensão.

## Uploads, referências e webhooks

A V2 aceita URLs HTTP(S) de imagens de referência e permanece stateless. Não há endpoint de upload: o filesystem efêmero do Render não é um storage público confiável, e nenhum serviço pago foi imposto ao projeto.

Uploads futuros devem ficar atrás de uma abstração de storage e implementar limite de tamanho, allowlist MIME, nomes aleatórios, expiração e cleanup. Modelos Kling motion/edit não estão habilitados porque exigem upload e inspeção de vídeo.

O polling continua sendo o mecanismo de status. Webhooks SnapGen exigem configuração externa, verificação criptográfica e idempotência; por isso estão documentados como evolução futura, não expostos parcialmente.

## Retry e segurança de cobrança

- POSTs de geração, extensão e storyboard nunca recebem retry automático.
- Somente o GET idempotente de status tenta novamente em HTTP 429 ou 5xx.
- O UUID existente deve sempre ser reutilizado durante polling.

## Configuração

```env
PORT=3000
SNAPGEN_API_KEY=
MIDDLEWARE_API_KEY=
SNAPGEN_BASE_URL=https://api.snapgen.ai
SNAPGEN_TIMEOUT_MS=30000
ALLOWED_ORIGINS=*
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=30
NODE_ENV=development
LOG_LEVEL=info
PROJECT_STATE_SECRET=
```

O `.env` real é ignorado pelo Git e pelo contexto Docker. Nunca configure `SNAPGEN_API_KEY` no GPT.

`PROJECT_STATE_SECRET` habilita as rotas stateless da V3 e deve ser um secret independente com pelo menos 32 caracteres. Sem ele, V1/V2 continuam funcionando e a V3 retorna `503 V3_NOT_CONFIGURED`.

## Projetos de vídeo stateless (V3)

A V3 adiciona `/video/projects/start`, `/video/projects/continue`, `/video/projects/render` e uma rota temporária de download. Ela usa um Project State Token assinado em vez de banco ou worker. O cliente deve preservar somente o token mais recente. Consulte [docs/stateless-v3.md](docs/stateless-v3.md) para fluxo, risco de replay, budget guard, segurança de mídia e limites da entrega efêmera.

## Render

1. Conecte o repositório GitHub ao Render.
2. Crie um Web Service usando o `Dockerfile`.
3. Cadastre as variáveis acima e use `NODE_ENV=production`.
4. Não fixe `PORT`; o Render fornece esse valor.
5. Valide `https://snapgen-middleware.onrender.com/health`.

O servidor escuta em `0.0.0.0` e usa a porta do ambiente com fallback local 3000.

## Desenvolvimento local

```powershell
npm install
npm run dev
```

Validação:

```powershell
npm run typecheck
npm run lint
npm run build
npm test
docker compose config
```

Docker local é opcional e iniciado somente quando o desenvolvedor decidir:

```powershell
docker compose up -d --build
```

## GPT Action

Importe `openapi.yaml`. No GPT Builder configure **Authentication → API Key → Custom**, header `x-api-key`, usando `MIDDLEWARE_API_KEY`.

Privacy Policy pública:

https://snapgen-middleware.onrender.com/privacy

### Instructions V2 para o Custom GPT

```text
Quando o usuário pedir um vídeo, preserve os parâmetros explicitamente fornecidos.

Chame getVideoModels quando precisar descobrir modelos, capacidades ou combinações compatíveis. Nunca invente capacidades. Se os parâmetros forem incompatíveis, explique a incompatibilidade antes de gerar e ofereça apenas opções retornadas pela API.

Use generateVideo para text-to-video. Quando houver uma URL HTTP(S) válida de imagem e o modelo suportar image-to-video, envie-a em ref_images. Não invente ou altere URLs.

Use extendVideo somente quando o usuário pedir continuação, houver um UUID existente e o modelo informar supportsExtend=true. Não use geração nova como substituto silencioso para extend.

Use createVideoStoryboard para pedidos explícitos de múltiplas cenas quando as restrições de Grok forem atendidas.

Após receber um UUID, informe que a operação foi iniciada. Use getVideoGenerationStatus com o mesmo UUID para consultar o andamento.

Se o status for processing, informe o progresso e continue reutilizando o UUID. Nunca gere novamente apenas porque ainda está processando e nunca repita automaticamente uma operação paga.

Se o status for completed, entregue videoUrl somente quando a API retornar uma URL não nula. Nunca invente uma URL.

Se o status for failed, informe o erro retornado e não afirme que o vídeo foi criado.

Nunca revele ou solicite SNAPGEN_API_KEY. A Action usa somente MIDDLEWARE_API_KEY configurada pelo administrador.
```

## Observabilidade e segurança

- Request ID recebido ou gerado é devolvido e propagado ao SnapGen.
- Logs estruturados registram operação, modelo, provider, input mode, UUID, status upstream e duração, sem prompt completo ou secrets.
- Helmet, CORS configurável, limite JSON de 1 MB, Zod, rate limit e timeout permanecem ativos.
- O container executa como usuário não-root.

## Migração V1 para V2

Nenhuma mudança é necessária para consumidores V1. Para adotar recursos V2:

1. Consulte `/video/models`.
2. Continue usando `/video/generate` com o modelo escolhido.
3. Use `/video/extend` somente com modelos compatíveis.
4. Use `/video/storyboard` para cenas Grok.
5. Continue consultando qualquer UUID em `/video/:uuid`.

## Troubleshooting

- `UNSUPPORTED_MODEL`: consulte `/video/models` e use um ID retornado.
- `VALIDATION_ERROR`: corrija o campo indicado conforme as capacidades do modelo.
- `UNSUPPORTED_OPERATION`: o modelo não oferece a operação solicitada.
- HTTP 401: confira `MIDDLEWARE_API_KEY`; erros de credencial upstream exigem conferir `SNAPGEN_API_KEY` no Render.
- HTTP 429: aguarde a janela indicada; não repita POSTs pagos automaticamente.
- HTTP 502: procure o log seguro `snapgen_request` pelo `requestId`.
- HTTP 504: verifique conectividade ou ajuste `SNAPGEN_TIMEOUT_MS`.
