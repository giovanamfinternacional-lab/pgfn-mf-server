# PGFN Server - M&F Internacional

Servidor que consulta a situação de dívida ativa na PGFN (Procuradoria-Geral da Fazenda Nacional)
e grava o resultado automaticamente no Bitrix24.

## Como funciona

1. O Bitrix24 chama `POST /pgfn-consultar` com `{ "company_id": 123 }`
2. O servidor busca o CNPJ da empresa no Bitrix24 (campo `UF_CRM_1588255955`)
3. Consulta o site da PGFN usando um navegador headless
4. Grava o resultado de volta na empresa no Bitrix24

## Endpoints

- `GET /health` — verifica se o servidor está no ar
- `POST /pgfn-consultar` — dispara a consulta (requer `company_id` no corpo da requisição)

## Variável de ambiente

- `PGFN_API_KEY` (opcional, recomendado) — chave de segurança. Se configurada, toda chamada a
  `/pgfn-consultar` deve incluir o header `x-api-key: <chave>` ou `?key=<chave>` na URL.

## Deploy

Hospedado no Render.com (plano gratuito). Veja `render.yaml` para a configuração.
