# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas de vários provedores de jogos, por HTTP e por SQS, mantendo saldo e ledger corretos com mensagens duplicadas, fora de ordem e processadas por várias instâncias ao mesmo tempo.

As decisões técnicas, os trade-offs e as limitações estão em [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Stack

Bun 1.x · TypeScript (strict) · NestJS · MikroORM · PostgreSQL 16 · AWS SQS (LocalStack) · Docker Compose · pino · prom-client

## Pré-requisitos

- [Bun](https://bun.sh) 1.x
- Docker com Docker Compose (Docker Desktop no Windows e no macOS)

## Setup

```bash
bun install
bun run infra:up          # PostgreSQL + LocalStack (cria as filas FIFO e a DLQ)
bun run migration:up      # aplica o schema
bun run start             # API em http://localhost:3000, consumidor SQS e workers
```

Para desfazer o schema: `bun run migration:down`. Para ver o estado: `bun run migration:status`.
Para derrubar a infra e apagar os dados: `bun run infra:down`.

## Testes

Os testes de integração e de concorrência usam PostgreSQL e LocalStack reais. Suba a infra e aplique as migrations antes.

```bash
bun run test:unit          # domínio, sem dependências externas
bun run test:integration   # API HTTP, persistência, idempotência, SQS, outbox, workers
bun run test:concurrency   # disputa de saldo e 3 instâncias da aplicação em processos separados
bun test                   # tudo
bun run typecheck
```

Não deixe `bun run start` rodando enquanto os testes de integração e de concorrência executam: a aplicação consumiria as mesmas filas.

Os logs das instâncias criadas pelo teste `multi-instance` ficam em `temp/instances/`.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` | sobe a aplicação completa |
| `bun run dev` | idem, recarregando ao salvar |
| `bun run infra:up` / `infra:down` | sobe / derruba PostgreSQL e LocalStack |
| `bun run migration:up` / `migration:down` / `migration:status` | migrations |
| `bun run test:unit` / `test:integration` / `test:concurrency` | suítes de teste |
| `bun run typecheck` | `tsc --noEmit` |

## Configuração

Todas as variáveis têm padrão que funciona com o Docker Compose local (veja `.env.example`).

| Variável | Padrão | Uso |
|---|---|---|
| `PORT` | `3000` | porta HTTP |
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:5432/wagering` | PostgreSQL |
| `DB_POOL_MAX` | `20` | conexões por instância |
| `SQS_ENDPOINT` | `http://localhost:4566` | LocalStack |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `us-east-1`, `test`, `test` | credenciais do LocalStack |
| `WORKERS_ENABLED` | `true` | `false` sobe só a API HTTP |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` | `30` | tempo até outra instância assumir uma mensagem abandonada |
| `SQS_WAIT_TIME_SECONDS` | `10` | duração do long polling do consumidor |
| `OUTBOX_INTERVAL_MS` | `500` | intervalo do publicador da outbox |
| `PENDING_REFERENCE_INTERVAL_MS` | `1000` | intervalo do worker de referências pendentes |
| `SHUTDOWN_TIMEOUT_MS` | `20000` | espera pelas mensagens em andamento no `SIGTERM` |
| `LOG_LEVEL` | `info` | nível dos logs JSON |

Para rodar várias instâncias localmente, suba cada uma com um `PORT` diferente. Elas não precisam saber umas das outras: a coordenação é feita pelo banco.

## API

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | cria wallet (saldo inicial gera transação `OPENING` e lançamento no ledger) |
| `GET` | `/wallets/:walletId` | consulta wallet |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=50` | ledger paginado por cursor opaco |
| `POST` | `/wallets/:walletId/reconciliation` | compara saldo materializado com o ledger |
| `POST` | `/wagering/transactions` | submete transação (header `Idempotency-Key` obrigatório) |
| `GET` | `/wagering/transactions/:transactionId` | consulta por id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | consulta por id do provedor |
| `GET` | `/health/live`, `/health/ready` | liveness e readiness (PostgreSQL e SQS) |
| `GET` | `/metrics` | métricas Prometheus |

Status HTTP de `POST /wagering/transactions`:

| Status | Significado | Reenviar? |
|---|---|---|
| `201` | processada | — |
| `200` | replay idêntico (`idempotentReplay: true`) | — |
| `202` | aceita, aguardando a transação referenciada | não; consultar depois |
| `400` | payload inválido ou header ausente | não, corrigir |
| `404` | wallet inexistente ou de outro jogador | não, corrigir |
| `409` | mesma `Idempotency-Key` com payload diferente | não, corrigir |
| `422` | rejeitada por regra de negócio (ver `failureCode`) | não |
| `503` | falha transitória (`Retry-After`) | sim, com a mesma key |

### Exemplo

No PowerShell, use `curl.exe` em vez de `curl`.

```bash
# 1. Criar a wallet
curl -s -X POST http://localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

# 2. Apostar (troque WALLET_ID pelo id devolvido acima)
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123",
       "playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"WALLET_ID",
       "roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'

# 3. Repetir o mesmo comando devolve o mesmo resultado com "idempotentReplay": true (HTTP 200)

# 4. Conferir o ledger
curl -s -X POST http://localhost:3000/wallets/WALLET_ID/reconciliation
```

### Pela fila

Mensagens no formato da seção 10 do desafio, enviadas para `wager-transactions.fifo` com `MessageGroupId` igual ao `walletId`:

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id WALLET_ID --message-deduplication-id msg-123 \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{...}}'
```

Os eventos de integração (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`) são publicados em `wagering-events.fifo`.

## Estrutura

```
src/
├── domain/            Money, Wallet, WagerTransaction, ledger, inbox/outbox, eventos, regras
├── application/       casos de uso e portas (sem NestJS nem MikroORM)
├── infrastructure/    MikroORM, migrations, SQS, workers, logs, métricas
├── interfaces/        módulo NestJS, controllers, inicialização dos workers
├── app.ts             montagem da aplicação
└── main.ts            ponto de entrada
test/
├── unit/              domínio puro
├── integration/       PostgreSQL e LocalStack reais
└── concurrency/       paralelismo real e múltiplos processos
localstack/init-sqs.sh criação das filas FIFO, da DLQ e da redrive policy
```

## Autenticação

Não implementada, por decisão documentada no `ARCHITECTURE.md` (seção 15). O ponto de extensão é o `AuthGuard` aplicado aos controllers (exceto health e métricas) e a porta `ProviderIdentityPort`.

## Problemas comuns

- **`bun` ou `docker` não reconhecido no terminal:** feche e reabra o VS Code depois de instalar, para o PATH atualizar.
- **`bun install` lento ou com arquivos travados:** pastas sincronizadas (OneDrive, Dropbox) atrapalham o `node_modules`. Pause a sincronização ou mova o repositório para fora dela.
- **Testes de mensageria falhando de forma intermitente:** verifique se não há uma instância de `bun run start` consumindo as filas.
