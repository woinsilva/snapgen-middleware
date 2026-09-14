# SnapGen Middleware

Middleware stateless em Node.js + TypeScript para integrar uma GPT Action ao SnapGen. A API pública recebe JSON, valida o contrato e converte internamente a geração para `multipart/form-data`, sem expor a credencial do SnapGen.

## Arquitetura de produção

Deploy:

```text
GitHub
  -> deploy pelo Render
  -> snapgen-middleware
  -> SnapGen
```

Runtime:

```text
ChatGPT GPT Action
  -> HTTPS + MIDDLEWARE_API_KEY
  -> https://snapgen-middleware.onrender.com
  -> snapgen-middleware
  -> multipart/form-data + SNAPGEN_API_KEY
  -> SnapGen API
  -> Veo
```

O Render é o ambiente de produção e usa o `Dockerfile` do projeto. O servidor lê `PORT` do ambiente, usa `3000` como fallback local e escuta em `0.0.0.0`.

`POST /video/generate` e `GET /video/:uuid` são independentes da implementação do provedor por meio da interface `VideoProvider`. Isso permite adicionar outros provedores no futuro mantendo o contrato público.

Cada requisição aceita opcionalmente `x-request-id`. Quando ausente, o middleware gera um UUID, devolve-o no mesmo header e o encaminha ao SnapGen. Os logs são JSON estruturado e não contêm prompts, headers ou API keys.

## Configuração

Copie `.env.example` para `.env` somente na primeira instalação. Nunca substitua um `.env` já configurado.

```powershell
Copy-Item .env.example .env
```

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
```

- `SNAPGEN_API_KEY`: usada exclusivamente pelo backend para chamar o SnapGen.
- `MIDDLEWARE_API_KEY`: exigida em `x-api-key` nas rotas `/video/*`.
- `SNAPGEN_BASE_URL`: origem da API, sem `/uapi/v1` no final.
- `SNAPGEN_TIMEOUT_MS`: timeout upstream; expiração retorna HTTP 504.
- `ALLOWED_ORIGINS`: `*` ou origins separadas por vírgula.
- `RATE_LIMIT_WINDOW_MS` e `RATE_LIMIT_MAX`: proteção das rotas de vídeo; `/health` não é limitado.
- `LOG_LEVEL`: `debug`, `info`, `warn`, `error` ou `silent`.

O `.env` real é excluído pelo `.gitignore` e `.dockerignore`.

## Deploy no Render

1. Conecte o repositório GitHub ao Render.
2. Crie um Web Service usando o `Dockerfile` do repositório.
3. Configure no Render todas as variáveis de ambiente acima. Use `NODE_ENV=production`.
4. Não fixe `PORT`: o Render fornece esse valor automaticamente.
5. Após o deploy, valide:

```text
https://snapgen-middleware.onrender.com/health
```

O Docker local não é necessário para produção.

## Desenvolvimento local

Com Node.js 22 ou superior:

```powershell
npm install
npm run dev
```

Validação local:

```powershell
npm run typecheck
npm run lint
npm run build
npm test
```

Docker permanece disponível opcionalmente e só é iniciado manualmente pelo desenvolvedor:

```powershell
docker compose up -d --build
docker compose ps
docker compose logs -f
docker compose down
```

## Endpoints

### Health

```bash
curl https://snapgen-middleware.onrender.com/health
```

Resposta:

```json
{"status":"ok"}
```

### Gerar vídeo

```bash
curl -X POST https://snapgen-middleware.onrender.com/video/generate \
  -H "Content-Type: application/json" \
  -H "x-api-key: SUA_MIDDLEWARE_API_KEY" \
  -H "x-request-id: identificador-opcional" \
  -d '{
    "prompt": "A red sports car driving along a coastal road at sunset",
    "model": "veo-3.1-fast",
    "duration": 8,
    "resolution": "720p",
    "aspect_ratio": "16:9"
  }'
```

Resposta normalizada quando o SnapGen aceita a criação e retorna `uuid` ou `conversion_uuid`:

```json
{
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "status": "processing",
  "provider": "snapgen",
  "model": "veo-3.1-fast"
}
```

O status presente na resposta de criação não é interpretado como status de histórico. O objetivo desse endpoint é confirmar o aceite e devolver o identificador.

### Consultar geração

```bash
curl https://snapgen-middleware.onrender.com/video/UUID \
  -H "x-api-key: SUA_MIDDLEWARE_API_KEY"
```

No endpoint de histórico, o SnapGen documenta `1` como processamento, `2` como concluído e `3` como falha. O middleware converte esses valores para `processing`, `completed` e `failed`. `videoUrl` vem exclusivamente de `generated_video[0].video_url` e só é exposta quando a geração está concluída.

Para imagens de referência, cada URL HTTP(S) é enviada como um campo multipart separado chamado exatamente `ref_images`, conforme a documentação do SnapGen. O limite é 2 em `frame` e 3 em `ingredient`.

## GPT Action

O arquivo `openapi.yaml` descreve o middleware, não a API do SnapGen. O GPT envia somente `application/json`.

No GPT Builder:

1. Importe `openapi.yaml`.
2. Em **Authentication**, selecione **API Key**.
3. Use **Type: Custom**.
4. Configure o header `x-api-key`.
5. Use o valor de `MIDDLEWARE_API_KEY`.

Nunca configure `SNAPGEN_API_KEY` no GPT.

```text
GPT -- MIDDLEWARE_API_KEY --> Render/middleware -- SNAPGEN_API_KEY --> SnapGen
```

### Instructions sugeridas para o GPT

```text
Quando o usuário solicitar um vídeo, chame generateVideo. Nunca chame o SnapGen diretamente.

Respeite model, resolution, duration, aspect_ratio, mode_image e ref_images fornecidos pelo usuário. Não altere parâmetros explícitos sem necessidade.

Depois que generateVideo retornar um UUID, informe que a geração foi iniciada. Use getVideoGenerationStatus com o mesmo UUID para consultar o andamento.

Se o status for processing, informe que o vídeo ainda está sendo processado e apresente o progresso retornado. Não invente prazo de conclusão.

Se o status for completed, informe videoUrl somente quando a operação retornar uma URL não nula. Nunca invente uma URL.

Se o status for failed, informe o erro retornado e não afirme que o vídeo foi criado.

Nunca revele ou solicite SNAPGEN_API_KEY. A Action usa somente a chave do middleware configurada pelo administrador.
```

## Segurança e troubleshooting

- Helmet aplica headers defensivos e o JSON é limitado a 1 MB.
- Zod rejeita payloads inválidos ou campos desconhecidos.
- Stack traces não são retornadas em produção.
- O container executa como usuário `node`, não como root.
- HTTP 401 do middleware: confira `MIDDLEWARE_API_KEY`.
- HTTP 401/403 do SnapGen: confira `SNAPGEN_API_KEY` e o estado da conta.
- HTTP 429: aguarde a janela do rate limit ou ajuste as variáveis correspondentes.
- HTTP 502 com resposta inválida: procure o log `snapgen_request`, que registra apenas chaves do body, tipo/valor seguro do status, UUID e duração.
- HTTP 504: verifique conectividade ou ajuste `SNAPGEN_TIMEOUT_MS`.
