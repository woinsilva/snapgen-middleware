# Configuração do Custom GPT V2

## Identificação

- Nome: **SnapGen AI Video Studio**
- Produção: `https://snapgen-middleware.onrender.com`
- Privacy Policy: `https://snapgen-middleware.onrender.com/privacy`

## Authentication da Action

No GPT Builder, configure:

- Authentication: **API Key**
- Authentication type: **Custom**
- Header: `x-api-key`
- Valor: use a `MIDDLEWARE_API_KEY` administrada fora do schema. Nunca coloque o valor no YAML ou nas Instructions.

O `SNAPGEN_API_KEY` pertence exclusivamente ao ambiente do middleware e nunca deve ser configurado no Custom GPT.

## Schema

1. Abra a configuração de Actions do GPT Builder.
2. Crie ou atualize a Action do SnapGen Middleware.
3. Cole integralmente o conteúdo de `openapi-gpt.yaml` no campo Schema.
4. Confirme que o Builder reconhece as operações:
   - `getVideoModels`
   - `generateVideo`
   - `getVideoGenerationStatus`
   - `extendVideo`
   - `generateStoryboard`
   - `healthCheck`
5. Configure a autenticação sem inserir a chave no schema.

`GET /privacy` não foi incluído como Action porque retorna HTML e não é necessário ao comportamento conversacional. A mesma URL está configurada separadamente como Privacy Policy.

## Instructions

Substitua integralmente as instruções V1 pelo conteúdo de `GPT-INSTRUCTIONS-V2.md`.

As instruções fazem `getVideoModels` ser a fonte dinâmica de capabilities, impedem retry automático de operações pagas e preservam o UUID para consultas de status.

## Verificação no Builder

Antes de salvar ou publicar:

- confirme o servidor `https://snapgen-middleware.onrender.com`;
- confirme o header `x-api-key`;
- confirme que nenhuma credencial foi colada no schema ou nas Instructions;
- confirme que a Privacy Policy abre publicamente;
- confirme que as seis operationIds foram importadas sem duplicidade;
- teste primeiro `healthCheck` e `getVideoModels`;
- em teste pago, envie no máximo uma geração e nunca repita o POST automaticamente;
- acompanhe a geração somente por `getVideoGenerationStatus` com o UUID retornado.

## Fluxo V1 preservado

O schema continua aceitando:

```json
{
  "prompt": "...",
  "model": "veo-3.1-fast",
  "duration": 8,
  "resolution": "720p",
  "aspect_ratio": "16:9"
}
```

Envie o objeto com `generateVideo` e acompanhe o UUID retornado com `getVideoGenerationStatus`.

## Limitações conhecidas

- O GPT mantém o UUID no contexto da conversa atual; isso não é armazenamento permanente fora da conversa.
- A Action aceita referências por URL HTTP(S), mas não oferece upload próprio de arquivos.
- Actions podem sofrer timeout enquanto o provedor continua processando; um timeout nunca autoriza repetir um POST pago.
- O GPT não deve fazer polling contínuo. O usuário pode pedir “verifique novamente” para reutilizar o UUID.
- Um GPT pode usar Apps ou Actions, mas não os dois ao mesmo tempo.
- Actions não ficam disponíveis em Pro mode; selecione um modelo compatível com Actions.
- Restrições do workspace podem exigir que `snapgen-middleware.onrender.com` esteja na lista de domínios permitidos.
- O ChatGPT pode solicitar confirmação do usuário antes de executar uma Action.
