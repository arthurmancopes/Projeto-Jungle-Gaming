# ARCHITECTURE — Distributed Wagering Processor

Este documento registra as decisões técnicas, os trade-offs e as limitações da solução.
A regra que orienta todas elas: **o PostgreSQL é a fonte da verdade das invariantes**. Broker, cache e código de aplicação são otimizações ou primeiras linhas de defesa, nunca a garantia final.

## 1. Visão geral

```
            HTTP (provedores)                SQS wager-transactions.fifo
                   │                                     │
          ┌────────▼────────┐                  ┌─────────▼─────────┐
          │   Controllers   │                  │    SQS Consumer   │
          └────────┬────────┘                  └─────────┬─────────┘
                   └───────────────┬─────────────────────┘
                                   ▼
                    SubmitWagerTransaction (use case único)
                                   │  1 transação SQL
        ┌──────────────┬───────────┼────────────┬──────────────┐
        ▼              ▼           ▼            ▼              ▼
     inbox     wager_transactions wallets  ledger_entries   outbox
                                                               │
                                              Outbox Publisher (worker)
                                                               ▼
                                                  SQS wagering-events.fifo
```

Camadas (dependências apontam sempre para dentro):

| Camada             | Conteúdo                                                                                 | Pode depender de        |
| ------------------ | ---------------------------------------------------------------------------------------- | ----------------------- |
| `domain/`          | `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, inbox/outbox, eventos, erros | nada (só `decimal.js`)  |
| `application/`     | use cases e portas (repositórios, relógio, gerador de id, identidade do provedor)        | `domain`                |
| `infrastructure/`  | MikroORM, migrations, SQS, workers, logs, métricas                                       | `application`, `domain` |
| `interfaces/http/` | controllers, DTOs, filtro de exceções                                                    | `application`           |

O domínio não importa NestJS nem MikroORM. As entidades de persistência são classes separadas, e mappers convertem entre elas e o domínio usando as factories `rehydrate`.

Todas as instâncias da aplicação são idênticas: cada uma serve HTTP, consome a fila e roda os workers. Nenhuma coordenação entre instâncias existe fora do banco.

## 2. ORM: MikroORM

Escolhido por ser o preferencial do desafio e pelos recursos usados diretamente na solução:

- `em.transactional()` delimita a transação única do use case;
- `LockMode.PESSIMISTIC_WRITE` gera o `SELECT ... FOR UPDATE` da wallet;
- Unit of Work explícita: cada execução do use case usa um `EntityManager` em fork, sem estado compartilhado entre requisições;
- migrations versionadas com `up()` e `down()`.

Onde o ORM não expressa bem a intenção (`INSERT ... ON CONFLICT DO NOTHING`, `FOR UPDATE SKIP LOCKED`), uso SQL nativo pelo próprio `EntityManager`, dentro da mesma transação.

Nível de isolamento: `READ COMMITTED` (padrão do PostgreSQL). É suficiente porque toda leitura que precede uma escrita financeira acontece depois do lock da linha da wallet.

## 3. Dinheiro

| Ponto                          | Decisão                                                   |
| ------------------------------ | --------------------------------------------------------- |
| Contratos (HTTP, SQS, eventos) | string decimal com 2 casas: `"25.00"`                     |
| Domínio                        | `Money` imutável sobre `decimal.js`                       |
| Banco                          | `numeric(20,2)` + coluna `currency char(3)`               |
| Mapeamento ORM                 | tipo customizado que lê e grava `numeric` como **string** |

Em nenhum ponto o valor passa por `number`. O driver `pg` já devolve `numeric` como string, e o tipo customizado impede a conversão.

Validação de entrada por expressão regular (`^(0|[1-9]\d*)(\.\d{1,2})?$`) antes de construir o `Decimal`. Isso rejeita por construção `NaN`, `Infinity`, notação científica, string vazia, sinal, mais de 2 casas e `amount` enviado como número JSON.

Não há arredondamento: as únicas operações são soma e subtração de valores com 2 casas, que são exatas. Como reversão parcial está fora de escopo, não existe multiplicação nem divisão.

O modelo é multi-moeda (toda operação compara moedas e lança `CurrencyMismatchError`), embora os cenários usem apenas `BRL`.

## 4. Schema e garantias no banco

Cada invariante tem uma constraint correspondente. O código de aplicação valida antes para devolver erros legíveis, mas a correção não depende dele.

| Invariante                                    | Mecanismo no banco                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| Uma wallet por `playerId` + `currency`        | `UNIQUE (player_id, currency)`                                                |
| Saldo nunca negativo                          | `CHECK (balance >= 0)` em `wallets` e `CHECK (balance_after >= 0)` no ledger  |
| Idempotência                                  | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`  |
| Referência obrigatória em `REFUND`/`ROLLBACK` | `CHECK` condicionado ao `kind`                                                |
| Uma reversão por referência                   | índice único parcial em `reference_transaction_id` para reversões `PROCESSED` |
| Um lançamento por transação e wallet          | `UNIQUE (transaction_id, wallet_id)`                                          |
| Aritmética do lançamento                      | `CHECK (balance_after = balance_before ± amount)` conforme `direction`        |
| Ledger imutável                               | trigger `BEFORE UPDATE OR DELETE` que lança exceção                           |
| Dedup de mensagens                            | `PRIMARY KEY (consumer_name, message_id)` no inbox                            |
| Domínios de `kind`, `status`, `direction`     | `CHECK ... IN (...)`                                                          |

Índices além das constraints: parcial em `outbox_messages (next_attempt_at) WHERE published_at IS NULL`, parcial em `wager_transactions (next_attempt_at) WHERE status = 'PENDING_REFERENCE'` e `wallet_ledger_entries (wallet_id, seq)` para a paginação.

O ledger é de entrada simples (um lançamento por movimentação). Partidas dobradas ficaram fora de escopo: exigiriam contas de contrapartida (casa, provedor) que o desafio não modela.

## 5. Concorrência

**Estratégia: lock pessimista na linha da wallet**, com `version` e `CHECK` como defesas adicionais.

```sql
SELECT * FROM wallets WHERE id = $1 FOR UPDATE;
-- ... regras de domínio ...
UPDATE wallets SET balance = $2, version = version + 1, updated_at = now()
 WHERE id = $1 AND version = $3;
```

Por que pessimista e não otimista:

- a wallet de um jogador ativo é um recurso quente. Com lock otimista, N apostas simultâneas geram N-1 conflitos e retries; com `FOR UPDATE`, elas formam fila no banco e cada uma executa uma vez;
- o resultado é determinístico, o que torna o cenário obrigatório (100.00, duas apostas de 80.00) simples de provar: a segunda transação só lê o saldo depois do commit da primeira, vê 20.00 e é rejeitada;
- a unidade de bloqueio é a linha da wallet. Wallets diferentes nunca se bloqueiam, portanto não há lock global.

O `UPDATE ... WHERE version = ?` e o `CHECK (balance >= 0)` não deveriam disparar nunca. Existem para que um bug futuro no caminho de lock vire erro explícito em vez de saldo corrompido.

**Ordem de aquisição de locks**, igual em todos os caminhos (HTTP, fila, retrier), para evitar deadlock:

1. linha do inbox (quando vem da fila);
2. linha da transação (insert por `idempotency_key`);
3. linha da wallet.

A referência de um `REFUND`/`ROLLBACK` é lida **depois** do lock da wallet. Como a referência precisa pertencer à mesma wallet, esse lock também serializa reversões concorrentes sobre a mesma transação. O índice único parcial é a garantia final contra reversão dupla.

`version` começa em `1` e só incrementa quando o saldo muda (`LOSS` e rejeições não alteram a wallet).

## 6. Idempotência

Persistente, baseada em constraint única. Nenhum cache participa.

Fluxo dentro da transação:

1. `INSERT INTO wager_transactions ... ON CONFLICT DO NOTHING`.
2. Se inseriu: é a primeira vez, segue o processamento.
3. Se não inseriu: carrega a linha existente.
   - `payload_hash` diferente → conflito (`IDEMPOTENCY_CONFLICT`, HTTP 409);
   - `payload_hash` igual → replay: devolve o status, o `failureCode` e o `observed_balance` gravados, com `idempotentReplay: true`.

Se duas requisições idênticas chegam ao mesmo tempo, o segundo `INSERT` fica bloqueado pelo índice único até o commit do primeiro e então cai no caminho de replay. É isso que garante um único débito no teste das 50 requisições paralelas. Se a primeira transação fizer rollback, o segundo `INSERT` passa e processa normalmente.

O replay devolve o saldo **observado no processamento original** (regra 7), por isso `observed_balance` é gravado na própria transação, inclusive para `LOSS` e `REJECTED`.

Também é conflito a mesma dupla `(providerId, externalTransactionId)` com uma `Idempotency-Key` diferente.

### Algoritmo do `payloadHash`

`SHA-256` (hex, 64 caracteres) do JSON canônico do subconjunto de negócio:

- campos: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency`, `referenceExternalTransactionId`;
- chaves ordenadas alfabeticamente em todos os níveis, sem espaços, UTF-8;
- `money.amount` normalizado para 2 casas (`"25"`, `"25.0"` e `"25.00"` produzem o mesmo hash);
- campos opcionais ausentes são omitidos;
- ficam de fora: header, `messageId`, `occurredAt` e qualquer metadado de transporte.

HTTP e SQS produzem o mesmo hash para a mesma operação, então um replay é reconhecido mesmo quando chega por canais diferentes.

## 7. Máquina de estados da transação

```
create() ──► PENDING ──────────────► PROCESSED   (terminal)
                │  ├────────────────► REJECTED    (terminal)
                │  └────────────────► FAILED      (terminal)
                ▼
        PENDING_REFERENCE ──────────► PROCESSED | REJECTED | FAILED
```

- `PENDING` nunca é visível fora da transação SQL: o commit sempre grava um dos outros quatro estados.
- Qualquer transição a partir de um estado terminal lança `InvalidTransactionStateError`. É erro de programação, não caminho de negócio.
- `FAILED` fica reservado para erro permanente de infraestrutura identificado ao processar uma transação já persistida (por exemplo, dado irrecuperável encontrado pelo retrier).
- `rehydrate` reconstrói o estado sem revalidar transições.

## 8. Regras de negócio e interpretações adotadas

| Operação               | Direção no ledger |
| ---------------------- | ----------------- |
| `BET`                  | `DEBIT`           |
| `WIN`                  | `CREDIT`          |
| `LOSS`                 | sem lançamento    |
| `REFUND` de `BET`      | `CREDIT`          |
| `ROLLBACK` de `BET`    | `CREDIT`          |
| `ROLLBACK` de `WIN`    | `DEBIT`           |
| `ROLLBACK` de `REFUND` | `DEBIT`           |

Interpretações além do enunciado:

1. **Uma referência só pode ser revertida uma vez, por qualquer tipo.** O enunciado proíbe duas reversões do mesmo tipo. Permitir `REFUND` e `ROLLBACK` sobre a mesma `BET` creditaria o valor duas vezes, então a segunda reversão é rejeitada com `ALREADY_REVERSED`. Para desfazer um `REFUND`, o provedor envia um `ROLLBACK` do próprio `REFUND`.
2. **Só reversões `PROCESSED` consomem a referência.** Uma reversão rejeitada não impede uma tentativa posterior com outro `externalTransactionId`.
3. **Referência existente, mas não `PROCESSED`**: se estiver `REJECTED`/`FAILED`, a reversão é rejeitada com `REFERENCE_NOT_PROCESSED`; se estiver `PENDING_REFERENCE`, a reversão também fica `PENDING_REFERENCE`.
4. **`WIN` com referência é opcional.** Quando informada, passa pelas mesmas validações (mesmo provider, player, wallet, moeda e rodada, e precisa ser uma `BET`). `WIN` sem referência é aceito.
5. **Wallet inexistente ou que não pertence ao `playerId`**: a transação não é persistida (a FK exige a wallet) e a resposta é `WALLET_NOT_FOUND`. É a única rejeição que não fica auditável na tabela; fica registrada em log e métrica.
6. **`OPENING`** é criado apenas por `POST /wallets`, com `providerId = "internal"` e `idempotencyKey = "opening:{walletId}"`. O `kind` é recusado na validação da API e da fila.
7. **Valor zero** é rejeitado como payload inválido para operações que movem saldo (só `LOSS` aceita `0.00`).
8. **Referência em `BET` é payload inválido; em `LOSS` é apenas informativa** (gravada, mas não resolvida nem validada).

### Referências fora de ordem

Referência ausente → a transação é gravada como `PENDING_REFERENCE`, o evento `WagerTransactionPendingReference` vai para a outbox e a resposta HTTP é `202`.

Um worker agendado busca as pendentes vencidas com `FOR UPDATE SKIP LOCKED` e reexecuta a resolução pelo mesmo caminho do use case (incluindo o lock da wallet).

- backoff: `min(2^tentativa, 60)` segundos;
- limite: 10 tentativas, cerca de 5 minutos no total;
- esgotado: `REJECTED` com `REFERENCE_NOT_FOUND` e evento `WagerTransactionRejected`.

Justificativa do limite: desordem em entrega at-least-once costuma se resolver em segundos. Cinco minutos cobrem um redeploy ou uma indisponibilidade curta do provedor sem manter indefinidamente uma pendência que afeta a conciliação. Os dois valores são configuráveis.

## 9. Códigos de falha

| Código                    | Situação                                     | Ação esperada do provedor                      |
| ------------------------- | -------------------------------------------- | ---------------------------------------------- |
| `INVALID_PAYLOAD`         | campos ausentes, `kind` inválido, reversão sem referência, valor zero | corrigir o payload |
| `INVALID_MONEY`           | valor ou moeda malformados                   | corrigir o payload                             |
| `CURRENCY_MISMATCH`       | moeda diferente da wallet ou da referência   | corrigir o payload                             |
| `WALLET_NOT_FOUND`        | wallet inexistente ou de outro player        | corrigir o payload                             |
| `INSUFFICIENT_FUNDS`      | `BET` maior que o saldo                      | desistir                                       |
| `REVERSAL_WOULD_OVERDRAW` | reversão deixaria o saldo negativo           | desistir e tratar operacionalmente             |
| `REFERENCE_NOT_FOUND`     | referência não chegou dentro do limite       | reenviar com novo id se a referência existir   |
| `REFERENCE_MISMATCH`      | referência de outro player, wallet ou rodada | corrigir o payload                             |
| `INVALID_REFERENCE_KIND`  | ex.: `REFUND` apontando para `WIN`           | corrigir o payload                             |
| `REFERENCE_NOT_PROCESSED` | referência foi rejeitada ou falhou           | desistir                                       |
| `AMOUNT_MISMATCH`         | valor diferente do da referência             | corrigir o payload                             |
| `ALREADY_REVERSED`        | referência já revertida                      | desistir                                       |
| `IDEMPOTENCY_CONFLICT`    | mesma key, payload diferente                 | corrigir (usar nova key ou o payload original) |

`INSUFFICIENT_FUNDS` e `REVERSAL_WOULD_OVERDRAW` são distintos de propósito: o primeiro é rotina do jogo; o segundo indica que o jogador já gastou um crédito que está sendo desfeito e pede atenção operacional.

## 10. Mapeamento HTTP

| Situação                                        | Status                           | Reenviar?             |
| ----------------------------------------------- | -------------------------------- | --------------------- |
| Transação processada                            | `201`                            | —                     |
| Replay idempotente                              | `200` (`idempotentReplay: true`) | —                     |
| Aceita, aguardando referência                   | `202`                            | não; consultar depois |
| Payload inválido ou header ausente              | `400`                            | não, corrigir         |
| Recurso não encontrado                          | `404`                            | não                   |
| Conflito de idempotência ou wallet duplicada    | `409`                            | não, corrigir         |
| Rejeição por regra de negócio                   | `422` com `failureCode`          | não                   |
| PostgreSQL ou SQS indisponível, timeout de lock | `503` com `Retry-After`          | sim, mesma key        |

Corpo de erro único em todos os endpoints: `{ "code", "message", "correlationId" }`. Um replay de transação rejeitada devolve o mesmo `422` original.

## 11. Consumo da fila

- Long polling em `wager-transactions.fifo`, `MessageGroupId = walletId`. A ordenação por grupo reduz contenção e desordem, mas é só otimização: a correção vem do banco.
- O consumidor chama **o mesmo use case** do HTTP, passando `messageId` para o registro no inbox.
- O `DeleteMessage` (ack) acontece somente depois do commit.

**Inbox.** `INSERT ... ON CONFLICT DO NOTHING` em `(consumer_name, message_id)`, na mesma transação do efeito financeiro. Mensagem já processada → ack sem efeito. Mesmo `messageId` com `payload_hash` diferente → erro permanente.

**Classificação de erros:**

| Tipo        | Exemplos                                                            | Tratamento                                                 |
| ----------- | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| Negócio     | saldo insuficiente, referência inválida                             | transação `REJECTED` é commitada, ack                      |
| Transitório | banco indisponível, timeout de lock, deadlock                       | sem ack; `ChangeMessageVisibility` com backoff exponencial |
| Permanente  | JSON inválido, schema inválido, `kind = OPENING`, conflito de inbox | envio explícito para a DLQ e ack                           |

A redrive policy (`maxReceiveCount = 5`) é a rede de segurança: uma mensagem que falha repetidamente por motivo não classificado vai para `wager-transactions-dlq.fifo` sem intervenção.

**Crash depois do commit e antes do ack.** A mensagem volta após o visibility timeout, o inbox identifica a duplicata e o consumidor apenas faz o ack. Nenhum efeito é reaplicado.

**Shutdown (`SIGTERM`).** O consumidor para de buscar mensagens, aguarda as que estão em andamento até um prazo e, para as que não concluírem, devolve a visibilidade (`VisibilityTimeout = 0`) para outra instância assumir.

## 12. Transactional Outbox

Os eventos são gravados em `outbox_messages` na mesma transação do efeito financeiro. Nada é publicado antes do commit, porque quem publica é um worker separado que só enxerga linhas commitadas.

```sql
SELECT * FROM outbox_messages
 WHERE published_at IS NULL
   AND (next_attempt_at IS NULL OR next_attempt_at <= now())
 ORDER BY occurred_at
 LIMIT 50
 FOR UPDATE SKIP LOCKED;
```

- `SKIP LOCKED` permite vários publishers: cada um pega um lote disjunto, sem esperar pelos outros.
- Publicação em `wagering-events.fifo` com `MessageGroupId = aggregateId` e `MessageDeduplicationId = eventId`.
- Sucesso → `published_at`. Falha → `attempts + 1` e `next_attempt_at` com backoff.
- Se o processo morre depois de publicar e antes de marcar, o lock é liberado e outra instância republica. A garantia é **at-least-once**, e o consumidor deduplica por `eventId`. A deduplicação do FIFO cobre a janela de 5 minutos, mas não é a garantia.

Eventos (uma subclasse de `IntegrationEvent` por tipo, com `eventType` e `version` no tipo):

| Evento                             | Quando                               |
| ---------------------------------- | ------------------------------------ |
| `WagerTransactionProcessed`        | transação aplicada, inclusive `LOSS` |
| `WagerTransactionRejected`         | rejeição por regra de negócio        |
| `WalletBalanceChanged`             | somente quando o saldo muda          |
| `WagerTransactionPendingReference` | referência ausente                   |

`correlationId` vem do header `X-Correlation-Id` ou do `messageId` (gerado quando ausente); `causationId` é o id da transação. `data` usa `MoneyProps`, nunca a instância de `Money`.

## 13. Reconciliação e paginação

- `POST /wallets/:id/reconciliation` soma o ledger (`CREDIT` positivo, `DEBIT` negativo) no banco e compara com `wallets.balance`, em uma transação `REPEATABLE READ` somente leitura, para que as duas leituras vejam o mesmo snapshot.
- Divergência **não é corrigida**: gera log de erro, incrementa a métrica e a resposta volta com `consistent: false`.
- O ledger é paginado por `seq` (`bigserial`): `WHERE wallet_id = ? AND seq > ? ORDER BY seq LIMIT ?`. O cursor é o `seq` em base64url, opaco para o cliente e estável sob inserções concorrentes.

## 14. Observabilidade

Logs em JSON (pino) com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`. Valores monetários e payloads completos não são logados.

Métricas (Prometheus, em `GET /metrics`):

| Métrica                                              | Tipo                                         |
| ---------------------------------------------------- | -------------------------------------------- |
| `wager_transactions_total{kind,status,failure_code}` | counter                                      |
| `wager_duplicates_total{source}`                     | counter                                      |
| `wager_retries_total{reason}`                        | counter                                      |
| `wager_dlq_messages_total`                           | counter                                      |
| `wallet_lock_conflicts_total`                        | counter                                      |
| `outbox_lag_seconds`                                 | gauge (idade do evento pendente mais antigo) |
| `outbox_pending_messages`                            | gauge                                        |
| `wager_processing_duration_seconds{source}`          | histogram                                    |
| `wallet_reconciliation_mismatch_total`               | counter                                      |

Health: `/health/live` só indica que o processo responde; `/health/ready` executa `SELECT 1` e `GetQueueAttributes`. Ambos sem autenticação.

## 15. Autenticação (não implementada)

Decisão: não implementar, conforme permitido pela seção 2 do desafio, para concentrar o tempo em correção financeira, concorrência e idempotência.

Pontos de extensão no código:

- `AuthGuard` (no-op) aplicado a todos os controllers, exceto health;
- `ProviderIdentityPort`, que devolve a identidade do chamador. A implementação atual confia no `providerId` do payload.

Desenho que eu adotaria, com Keycloak no Docker Compose:

1. cada provedor é um client confidencial e obtém token por **client credentials** (OAuth 2.0);
2. o `AuthGuard` valida o JWT (assinatura via JWKS, `iss`, `aud`, `exp`);
3. o token carrega um claim `provider_id`; o `ProviderIdentityPort` o expõe e o use case rejeita requisições em que ele difere do `providerId` do corpo;
4. endpoints administrativos (criação de wallet, reconciliação) exigem um role separado.

Mensagens da fila são tratadas como canal interno confiável, mas o `providerId` da mensagem passa pelas mesmas validações de domínio.

## 16. Testes

- **Unidade** (`test/unit`): domínio puro, sem I/O.
- **Integração** (`test/integration`): PostgreSQL e LocalStack reais via Docker Compose. Nenhum mock de banco ou de SQS.
- **Concorrência** (`test/concurrency`): paralelismo real com `Promise.all` e com 3 ou mais processos (`Bun.spawn`) contra o mesmo banco.

Todo teste de integração e de concorrência termina verificando `wallet.balance == saldo reconstruído pelo ledger`.

## 17. Trade-offs e limitações conhecidas

- **Wallet quente é serializada.** O lock pessimista limita a vazão de uma única wallet ao tempo de uma transação. Aceitável para um jogador; para contas agregadas de alto volume seria preciso outra modelagem.
- **Publicação com lock aberto.** O publisher mantém o lock das linhas da outbox durante a chamada ao SQS. É simples e seguro, mas segura uma conexão pelo tempo da chamada. Alternativa: marcar um `claimed_until` e publicar fora da transação.
- **Outbox por polling.** O atraso mínimo de publicação é o intervalo do polling. `LISTEN/NOTIFY` reduziria a latência.
- **Sem retenção.** Inbox, outbox publicada e transações antigas não são expurgadas nem particionadas.
- **Rejeição por wallet inexistente não é persistida** (seção 8, item 5).
- **Reversão parcial e partidas dobradas** estão fora de escopo.
- **Uma moeda nos cenários.** O modelo é multi-moeda e os conflitos são testados, mas não há conversão.
- **Ordenação entre eventos de agregados diferentes** não é garantida, apenas por `aggregateId`.
