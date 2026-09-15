# Exemplo HTTP completo — V3 Stateless

Use placeholders; nunca coloque secrets ou um Project State Token real em documentação ou logs.

```http
POST /video/projects/start
x-api-key: <configured-in-gpt-builder>
Content-Type: application/json

{
  "concept": "A forest adventure",
  "model": "veo-3.1-fast",
  "duration": 70,
  "resolution": "720p",
  "aspect_ratio": "16:9",
  "visualBible": {
    "style": "Cinematic 2D animation",
    "characters": [{ "id": "lia", "description": "Explorer with a yellow backpack" }],
    "environment": "Warm enchanted forest",
    "continuityRules": ["Keep Lia, lighting, and travel direction consistent"]
  },
  "scenes": [
    { "sequence": 1, "prompt": "Self-contained scene 1", "continuityInstructions": "Repeat visual continuity" },
    { "sequence": 2, "prompt": "Self-contained scene 2", "continuityInstructions": "Repeat visual continuity" },
    { "sequence": 3, "prompt": "Self-contained scene 3", "continuityInstructions": "Repeat visual continuity" },
    { "sequence": 4, "prompt": "Self-contained scene 4", "continuityInstructions": "Repeat visual continuity" },
    { "sequence": 5, "prompt": "Self-contained scene 5", "continuityInstructions": "Repeat visual continuity" },
    { "sequence": 6, "prompt": "Self-contained scene 6", "continuityInstructions": "Repeat visual continuity" },
    { "sequence": 7, "prompt": "Self-contained scene 7", "continuityInstructions": "Repeat visual continuity" },
    { "sequence": 8, "prompt": "Self-contained scene 8", "continuityInstructions": "Repeat visual continuity" },
    { "sequence": 9, "prompt": "Self-contained scene 9", "continuityInstructions": "Repeat visual continuity" }
  ]
}
```

O cliente preserva `<LATEST_PROJECT_STATE>` e, após autorização de custo, inicia no máximo uma cena:

```http
POST /video/projects/advance
x-api-key: <configured-in-gpt-builder>
Content-Type: application/json

{ "projectState": "<LATEST_PROJECT_STATE>" }
```

Se a cena estiver `processing`, consulte somente seu status:

```http
POST /video/projects/status
x-api-key: <configured-in-gpt-builder>
Content-Type: application/json

{ "projectState": "<LATEST_PROJECT_STATE>" }
```

`status` faz no máximo um GET ao provider, nunca inicia cena e nunca faz POST pago. Cada resposta substitui o token anterior. Quando a cena concluir, somente uma chamada posterior a `advance` inicia a próxima. Repita sem paralelismo até o projeto retornar `assembling`; então:

```http
POST /video/projects/render
x-api-key: <configured-in-gpt-builder>
Content-Type: application/json

{ "projectState": "<LATEST_PROJECT_STATE>" }
```

Resposta imediata (HTTP 202 significa job aceito, não vídeo concluído):

```json
{
  "projectId": "<PROJECT_ID>",
  "renderJobId": "<RENDER_JOB_ID>",
  "status": "processing",
  "projectState": null,
  "downloadUrl": null,
  "outputExpiresAt": null,
  "error": null
}
```

Consulta textual/JSON autenticada, reutilizando sempre os mesmos IDs e sem criar outro render job:

```http
GET /video/projects/<PROJECT_ID>/render/<RENDER_JOB_ID>
x-api-key: <configured-in-gpt-builder>
```

Se continuar `processing`, o GPT informa isso e aguarda nova interação antes de consultar novamente. Quando `completed`, a resposta contém `<LATEST_PROJECT_STATE>` e uma URL absoluta temporária. O GPT substitui o token interno e mostra apenas a URL:

```json
{
  "projectId": "<PROJECT_ID>",
  "renderJobId": "<RENDER_JOB_ID>",
  "status": "completed",
  "projectState": "<LATEST_PROJECT_STATE>",
  "downloadUrl": "https://snapgen-middleware.onrender.com/video/projects/output/<PROJECT_ID>?access=<SIGNED_TEMPORARY_ACCESS>",
  "outputExpiresAt": "<ISO_DATE_TIME>",
  "error": null
}
```

O navegador acessa `downloadUrl` diretamente. Esse GET não exige `x-api-key`; o token assinado da própria URL autoriza somente o projeto/output até sua expiração.
