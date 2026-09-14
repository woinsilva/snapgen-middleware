# SnapGen Middleware

Middleware stateless em Node.js + TypeScript. Ele recebe JSON, valida o contrato, converte a geração para `multipart/form-data` e chama o SnapGen sem expor a credencial do provedor.

## Arquitetura

```text
Cliente/GPT Action
  -> Express (request ID, Helmet, CORS, rate limit e autenticação)
  -> VideoProvider
  -> SnapGenVideoProvider
  -> API SnapGen
```

`POST /video/generate` e `GET /video/:uuid` permanecem estáveis. A interface `VideoProvider` permite adicionar Google Veo, Kling, Seedance ou ComfyUI futuramente sem acoplar o controller a esses serviços.

Cada requisição aceita opcionalmente `x-request-id`. Quando ausente, o middleware gera um UUID, devolve-o no mesmo header e o encaminha ao SnapGen. Logs são JSON estruturado e não contêm prompts, headers ou API keys.

Conforme a documentação SnapGen fornecida em `docs-content.zip`, cada URL de `ref_images` é enviada em um campo multipart separado chamado exatamente `ref_images`, preservando a ordem. O limite é 2 URLs HTTP(S) em `frame` e 3 em `ingredient`. Não há armazenamento local nem banco de dados.

## Pré-requisitos

- Node.js 22 ou superior
- npm
- Docker Desktop para execução em container

## Configuração

Copie `.env.example` para `.env` somente na primeira instalação. Não substitua um `.env` já configurado.

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
CLOUDFLARE_TUNNEL_TOKEN=
```

- `SNAPGEN_API_KEY`: segredo usado exclusivamente pelo backend para chamar o SnapGen.
- `MIDDLEWARE_API_KEY`: segredo exigido no header `x-api-key` das rotas `/video/*`.
- `SNAPGEN_BASE_URL`: origem da API, sem `/uapi/v1` no final.
- `SNAPGEN_TIMEOUT_MS`: timeout upstream; expiração retorna HTTP 504.
- `ALLOWED_ORIGINS`: `*` ou lista separada por vírgula.
- `RATE_LIMIT_WINDOW_MS` e `RATE_LIMIT_MAX`: janela e limite das rotas de vídeo. `/health` não é limitado.
- `LOG_LEVEL`: `debug`, `info`, `warn`, `error` ou `silent`.
- `CLOUDFLARE_TUNNEL_TOKEN`: necessário somente no Compose opcional do túnel.

O `.env` está excluído pelo `.gitignore` e `.dockerignore`.

## Execução local

```powershell
npm install
npm run dev
```

Build local:

```powershell
npm run typecheck
npm run lint
npm run build
npm test
npm start
```

O serviço fica em `http://localhost:3000`.

## Docker e inicialização automática no Windows

No Docker Desktop, abra:

**Settings → General → Start Docker Desktop when you sign in**

Execute uma vez:

```powershell
docker compose up -d --build
```

Como o serviço usa `restart: unless-stopped`, o fluxo esperado passa a ser:

```text
Windows inicia
  -> Docker Desktop inicia
  -> Docker Engine inicia
  -> snapgen-middleware inicia
```

Comandos úteis:

```powershell
docker compose ps
docker compose logs -f
docker compose restart
docker compose down
```

## Endpoints

### Health

```bash
curl http://localhost:3000/health
```

### Gerar vídeo

```bash
curl -X POST http://localhost:3000/video/generate \
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

Resposta normalizada:

```json
{
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "status": "processing",
  "provider": "snapgen",
  "model": "veo-3.1-fast"
}
```

### Consultar geração

```bash
curl http://localhost:3000/video/UUID \
  -H "x-api-key: SUA_MIDDLEWARE_API_KEY"
```

O SnapGen documenta `status=1` como processamento, `2` como concluído e `3` como falha. O middleware converte esses valores para `processing`, `completed` e `failed`. `videoUrl` vem exclusivamente de `generated_video[0].video_url` e só é exposta quando a geração está concluída.

## Cloudflare Tunnel opcional

Um GPT hospedado não acessa localhost. O túnel permite o fluxo:

```text
ChatGPT
  -> HTTPS Cloudflare
  -> Cloudflare Tunnel
  -> http://snapgen-middleware:3000
  -> SnapGen
```

Não é necessário abrir porta no roteador. Crie um túnel gerenciado no painel Cloudflare, configure o hostname público para o serviço `http://snapgen-middleware:3000` e adicione o token ao `.env`:

```env
CLOUDFLARE_TUNNEL_TOKEN=seu-token-do-tunel
```

Inicie middleware e túnel:

```powershell
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d --build
```

Para parar ambos:

```powershell
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml down
```

Ambos usam `restart: unless-stopped` e reiniciam com o Docker. O comando Docker normal não exige token e continua funcionando sem o túnel.

### Quick Tunnel para desenvolvimento

O Quick Tunnel cria uma URL pública temporária `https://xxxxx.trycloudflare.com` sem exigir domínio ou `CLOUDFLARE_TUNNEL_TOKEN`. O Named Tunnel acima continua disponível separadamente para uso futuro em produção.

Inicie o middleware e o Quick Tunnel:

```powershell
docker compose -f docker-compose.yml -f docker-compose.quick-tunnel.yml up -d --build
```

Veja os logs e procure pela URL `trycloudflare.com`:

```powershell
docker compose -f docker-compose.yml -f docker-compose.quick-tunnel.yml logs -f cloudflared-quick
```

Para mostrar somente a URL no PowerShell:

```powershell
docker compose -f docker-compose.yml -f docker-compose.quick-tunnel.yml logs cloudflared-quick | Select-String -Pattern 'https://[-a-z0-9]+\.trycloudflare\.com'
```

A URL é efêmera e pode mudar sempre que o container do Quick Tunnel for recriado. Para pará-lo junto com o middleware:

```powershell
docker compose -f docker-compose.yml -f docker-compose.quick-tunnel.yml down
```

## Configuração da GPT Action

1. Publique o middleware por HTTPS.
2. Troque `https://video.example.com` em `openapi.yaml` pelo hostname público.
3. Importe `openapi.yaml` no GPT Builder.
4. Em **Authentication**, escolha:
   - API Key
   - Type: Custom
   - Header: `x-api-key`
   - Value: o valor de `MIDDLEWARE_API_KEY`

Nunca configure `SNAPGEN_API_KEY` no GPT.

```text
GPT -- MIDDLEWARE_API_KEY --> middleware -- SNAPGEN_API_KEY --> SnapGen
```

### Instructions prontas para o GPT

```text
Quando o usuário solicitar a geração de um vídeo, chame generateVideo. Nunca chame o SnapGen diretamente.

Respeite model, resolution, duration, aspect_ratio, mode_image e ref_images explicitamente fornecidos pelo usuário. Não altere parâmetros explícitos sem uma razão necessária e informada.

Depois que generateVideo retornar um UUID, informe que a geração foi iniciada e preserve esse UUID. Use getVideoGenerationStatus com o mesmo UUID para consultar o andamento quando necessário ou quando o usuário pedir atualização.

Se o status for processing, diga claramente que o vídeo ainda está sendo processado e informe o progresso retornado. Não invente prazo de conclusão.

Se o status for completed, informe videoUrl somente quando a operação tiver retornado uma URL não nula. Nunca invente, complete ou suponha uma URL de vídeo.

Se o status for failed, informe o erro retornado pela operação e não afirme que um vídeo foi criado.

Nunca revele, solicite ou mencione SNAPGEN_API_KEY. A autenticação da Action usa somente a chave do middleware configurada pelo administrador.
```

## Segurança e troubleshooting

- Helmet aplica headers defensivos; JSON é limitado a 1 MB.
- Zod rejeita payloads desconhecidos ou inválidos.
- Stack traces não são retornadas em produção.
- O container executa como usuário `node`, não como root.
- HTTP 401 do middleware: confira `MIDDLEWARE_API_KEY`.
- HTTP 401/403 do SnapGen: confira `SNAPGEN_API_KEY` e a conta.
- HTTP 429: aguarde a janela do rate limit ou ajuste as variáveis correspondentes.
- HTTP 504: verifique conectividade ou ajuste `SNAPGEN_TIMEOUT_MS`.
- Container não reinicia: confirme o início automático do Docker Desktop e que o container não foi parado manualmente.
