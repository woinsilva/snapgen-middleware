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

O cliente preserva `<LATEST_PROJECT_STATE>`, informa o máximo planejado e, após uma única autorização do projeto, inicia o job para todas as cenas restantes:

```http
POST /video/projects/generation
x-api-key: <configured-in-gpt-builder>
Content-Type: application/json

{ "projectState": "<LATEST_PROJECT_STATE>" }
```

Resposta HTTP 202:

```json
{
  "projectId": "<PROJECT_ID>",
  "generationJobId": "<GENERATION_JOB_ID>",
  "status": "processing",
  "projectState": "<LATEST_PROJECT_STATE>",
  "scenes": { "total": 9, "completed": 0, "processing": 1, "pending": 8 },
  "progress": 5,
  "maxPaidOperations": 9,
  "error": null
}
```

Em uma interação posterior, consulte somente o mesmo job:

```http
GET /video/projects/<PROJECT_ID>/generation/<GENERATION_JOB_ID>
x-api-key: <configured-in-gpt-builder>
```

O status nunca cria outro job. O worker faz polling controlado e gera cenas estritamente em sequência. Cada resposta substitui o token anterior. Consulte no máximo uma vez por interação. Quando retornar `assembling`, inicie separadamente o render:

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
