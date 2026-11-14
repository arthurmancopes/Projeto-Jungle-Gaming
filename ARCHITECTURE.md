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
| `interfaces/`      | módulo NestJS, controllers, filtro de erros, inicialização do consumidor e dos workers   | `application`, `infrastructure` |

O domínio não importa NestJS nem MikroORM, e os casos de uso também não usam decorators do Nest: são classes puras, montadas no módulo por factories. A persistência usa `EntitySchema` (linhas puras) separados do domínio, e mappers reconstroem o domínio pelas factories `rehydrate`.

Todas as instâncias da aplicação são idênticas: cada uma serve HTTP, consome a fila e roda os workers. Nenhuma coordenação entre instâncias existe fora do banco.

## 2. ORM: MikroORM

Escolhido por ser o preferencial do desafio e pelos recursos usados diretamente na solução:

- `em.transactional()` delimita a transação única do use case;
- transação, lock de linha e SQL nativo passam pelo mesmo `EntityManager`, sem conexão paralela;
- Unit of Work explícita: cada execução do use case usa um `EntityManager` em fork, sem estado compartilhado entre requisições;
- migrations versionadas com `up()` e `down()`.

As leituras simples usam o `QueryBuilder` e devolvem linhas puras, sem passar pelo Identity Map. Isso é intencional: uma leitura com lock nunca pode reaproveitar um estado carregado antes do lock. As escritas são SQL explícito pelo próprio `EntityManager` (`INSERT ... ON CONFLICT DO NOTHING`, `UPDATE` condicionado à `version`, `FOR UPDATE SKIP LOCKED`), dentro da mesma transação, porque essas instruções são a própria garantia de idempotência e concorrência e devem ficar visíveis no código.

Nível de isolamento: `READ COMMITTED` (padrão do PostgreSQL). É suficiente porque toda leitura que precede uma escrita financeira acontece depois do lock da linha da wallet.

## 3. Dinheiro

| Ponto                          | Decisão                                                   |
| ------------------------------ | --------------------------------------------------------- |
| Contratos (HTTP, SQS, eventos) | string decimal com 2 casas: `"25.00"`                     |
| Domínio                        | `Money` imutável sobre `decimal.js`                       |
| Banco                          | `numeric(20,2)` + coluna `currency char(3)`               |
| Mapeamento ORM                 | propriedade `string` sobre coluna `numeric(20,2)`, com guarda de tipo no mapper |

Em nenhum ponto o valor passa por `number`. O driver `pg` devolve `numeric` como string, e o mapper de persistência lança erro se receber qualquer outro tipo, em vez de converter.

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

Índices além das constraints: parcial em `outbox_messages (occurred_at) WHERE published_at IS NULL` (busca do publisher e cálculo do outbox lag), parcial em `wager_transactions (next_reference_attempt_at) WHERE status = 'PENDING_REFERENCE'` (busca do worker de referências) e `wallet_ledger_entries (wallet_id, seq)` (paginação e reconciliação).

As migrations têm `up()` e `down()` e são aplicadas por `bun run migration:up` / `migration:down`, com a lista de migrations declarada explicitamente no código (sem descoberta por glob), o que funciona igual em qualquer sistema operacional.

O ledger é de entrada simples (um lançamento por movimentação). Partidas dobradas ficaram fora de escopo: exigiriam contas de contrapartida (casa, provedor) que o desafio não modela.

## 5. Concorrência

**Estratégia: lock pessimista na linha da wallet**, com `version` e `CHECK` como defesas adicionais.

```sql
SELECT ... FROM wallets WHERE id = $1 FOR NO KEY UPDATE;
-- ... regras de domínio, em memória ...
UPDATE wallets SET balance = $2, version = $3, updated_at = $4
 WHERE id = $1 AND version = $5;   -- version lida sob o lock
```

Por que pessimista e não otimista:

- a wallet de um jogador ativo é um recurso quente. Com lock otimista, N apostas simultâneas geram N-1 conflitos e retries; com o lock de linha, elas formam fila no banco e cada uma executa uma vez;
- o resultado é determinístico, o que torna o cenário obrigatório (100.00, duas apostas de 80.00) simples de provar: a segunda transação só lê o saldo depois do commit da primeira, vê 20.00 e é rejeitada;
- a unidade de bloqueio é a linha da wallet. Wallets diferentes nunca se bloqueiam, portanto não há lock global.

**Por que `FOR NO KEY UPDATE` e não `FOR UPDATE`.** A primeira versão usava `FOR UPDATE`, e o teste de 30 apostas concorrentes na mesma wallet falhou com `deadlock detected` (SQLSTATE `40P01`). A causa: o `INSERT` em `wager_transactions` valida a FK para `wallets` tomando `FOR KEY SHARE` na linha da wallet. Duas transações que já inseriram suas linhas seguram esse lock compartilhado, e `FOR UPDATE` conflita com ele, então cada uma espera a outra. `FOR NO KEY UPDATE` é o lock que um `UPDATE` de colunas não-chave já toma: é compatível com `FOR KEY SHARE` e continua exclusivo entre processadores da mesma wallet. Como o MikroORM não tem um `LockMode` para ele, essa leitura é SQL nativo.

O `UPDATE ... WHERE version = ?` e o `CHECK (balance >= 0)` não deveriam disparar nunca. Existem para que um bug futuro no caminho de lock vire erro explícito em vez de saldo corrompido.

**Ordem de aquisição de locks**, igual em todos os caminhos (HTTP, fila, retrier), para evitar deadlock:

1. linha do inbox (quando vem da fila);
2. linha da transação (insert por `idempotency_key`);
3. linha da wallet.

A referência de um `REFUND`/`ROLLBACK` é lida **depois** do lock da wallet. Como a referência precisa pertencer à mesma wallet, esse lock também serializa reversões concorrentes sobre a mesma transação. O índice único parcial é a garantia final contra reversão dupla.

`version` começa em `1` e só incrementa quando o saldo muda (`LOSS` e rejeições não alteram a wallet).

**Espera por lock limitada.** Cada transação define `SET LOCAL lock_timeout = '5s'`. Uma wallet disputada além disso faz a operação falhar como transitória (`CONCURRENCY_CONFLICT`, HTTP `503` com `Retry-After`; na fila, nova entrega com backoff) e incrementa `wallet_lock_conflicts_total`, em vez de segurar a conexão indefinidamente.

## 6. Idempotência

Persistente, baseada em constraint única. Nenhum cache participa.

Fluxo dentro da transação:

1. `INSERT INTO wager_transactions ... ON CONFLICT DO NOTHING`.
2. Se inseriu: é a primeira vez, segue o processamento.
3. Se não inseriu: carrega a linha existente.
   - `payload_hash` diferente → conflito (`IDEMPOTENCY_CONFLICT`, HTTP 409);
   - `payload_hash` igual → replay: devolve o status, o `failureCode` e o `observed_balance` gravados, com `idempotentReplay: true`.

Se duas requisições idênticas chegam ao mesmo tempo, o segundo `INSERT` fica bloqueado pelo índice único até o commit do primeiro e então cai no caminho de replay. É isso que garante um único débito no teste das 50 requisições paralelas. Se a primeira transação fizer rollback, o segundo `INSERT` passa e processa normalmente.

O replay devolve o saldo **observado no processamento original** (regra 7), por isso `observed_balance` é gravado na própria transação, inclusive para `LOSS` e `REJECTED`. Uma transação ainda `PENDING_REFERENCE` não tem saldo observado; o replay dela devolve o status pendente e o saldo atual.

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
- `FAILED` existe no modelo e no schema para erro permanente de infraestrutura em uma transação já persistida, mas **nenhum fluxo atual o produz**: falhas de infraestrutura fazem rollback da transação SQL inteira e são tratadas como transitórias (nova tentativa), então nunca deixam uma transação gravada pela metade. O estado fica disponível para um caso futuro, como dado irrecuperável encontrado pelo worker.
- `PENDING_REFERENCE → PENDING_REFERENCE` é a única transição não terminal repetível: cada tentativa sem sucesso do worker incrementa `reference_attempts` e reagenda.
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
5. **Wallet inexistente ou que não pertence ao `playerId`**: a transação não é persistida (a FK exige a wallet) e a resposta é `WALLET_NOT_FOUND` (HTTP `404`). É a única rejeição que não fica auditável na tabela; fica registrada em log. Na fila, é tratada como resultado de negócio: a mensagem é confirmada, não reenviada.
6. **`OPENING`** é criado apenas por `POST /wallets`, com `providerId = "internal"` e `idempotencyKey = "opening:{walletId}"`. O `kind` é recusado na validação da API e da fila.
7. **Valor zero** é rejeitado como payload inválido para operações que movem saldo (só `LOSS` aceita `0.00`).
8. **Referência em `BET` é payload inválido; em `LOSS` é apenas informativa** (gravada, mas não resolvida nem validada).

### Referências fora de ordem

Referência ausente → a transação é gravada como `PENDING_REFERENCE`, o evento `WagerTransactionPendingReference` vai para a outbox e a resposta HTTP é `202`.

Um worker agendado, presente em todas as instâncias, lista os ids das pendentes vencidas e processa cada uma em sua própria transação SQL: trava a linha com `FOR NO KEY UPDATE SKIP LOCKED` (reavaliando `status = 'PENDING_REFERENCE'` sob o lock) e reexecuta o mesmo `WagerProcessor` da submissão, incluindo o lock da wallet. Dois workers nunca processam a mesma pendência ao mesmo tempo, e uma pendência já resolvida por outro worker é simplesmente pulada.

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

Corpo de erro único em todos os endpoints: `{ "code", "message", "correlationId" }`. No `422`, o corpo traz esses campos e também o resultado da transação (`transactionId`, `status`, `failureCode`, `balance`, `idempotentReplay`). Um replay devolve o status HTTP da situação original: `422` para rejeitada, `202` para ainda pendente, `200` para processada.

`X-Correlation-Id` é aceito na entrada (quando bem formado) ou gerado, e devolvido em toda resposta.

## 11. Consumo da fila

- Long polling em `wager-transactions.fifo`, `MessageGroupId = walletId`. A ordenação por grupo reduz contenção e desordem, mas é só otimização: a correção vem do banco.
- O consumidor chama **o mesmo use case** do HTTP, passando `messageId` para o registro no inbox.
- O `DeleteMessage` (ack) acontece somente depois do commit.

**Inbox.** `INSERT ... ON CONFLICT DO NOTHING` em `(consumer_name, message_id)`, na mesma transação do efeito financeiro. Mensagem já processada → ack sem efeito. Mesmo `messageId` com `payload_hash` diferente → erro permanente.

**Classificação de erros:**

| Tipo        | Exemplos                                                            | Tratamento                                                 |
| ----------- | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| Negócio     | saldo insuficiente, referência inválida, wallet inexistente         | transação `REJECTED` é commitada (ou, sem wallet, nada é gravado), ack |
| Transitório | banco indisponível, timeout de lock, deadlock, erro desconhecido    | sem ack; `ChangeMessageVisibility` com backoff de 2s a 60s |
| Permanente  | JSON inválido, contrato inválido (inclusive `amount` numérico), `kind = OPENING`, conflito de idempotência ou de inbox | envio explícito para a DLQ (com o motivo em atributo) e ack |

Dentro de um lote recebido, mensagens de grupos (wallets) diferentes são processadas em paralelo e as do mesmo grupo em ordem. Se uma falha de forma transitória, as seguintes do mesmo grupo são devolvidas à fila sem processar, preservando a ordem.

A redrive policy (`maxReceiveCount = 5`) é a rede de segurança: uma mensagem que falha repetidamente por motivo não classificado vai para `wager-transactions-dlq.fifo` sem intervenção.

**Crash depois do commit e antes do ack.** A mensagem volta após o visibility timeout, o inbox identifica a duplicata e o consumidor apenas faz o ack. Nenhum efeito é reaplicado.

**Shutdown (`SIGTERM`).** O consumidor interrompe o long polling, aguarda as mensagens em andamento até `SHUTDOWN_TIMEOUT_MS` (padrão 20s) e devolve a visibilidade (`VisibilityTimeout = 0`) das que não concluíram, para outra instância assumir na hora. Isso roda no `beforeApplicationShutdown` do Nest, antes de o pool do banco fechar, para que as mensagens em andamento ainda consigam fazer commit. Os workers agendados terminam o ciclo atual antes de sair.

O visibility timeout (padrão 30s, `SQS_VISIBILITY_TIMEOUT_SECONDS`) é o tempo que uma instância morta sem aviso leva para "devolver" o que estava processando.

Uma instância morta no meio de um long polling (`SQS_WAIT_TIME_SECONDS`, padrão 10s) pode deixar a requisição aberta no broker; uma mensagem entregue a ela fica invisível até o visibility timeout, embora ninguém a processe. Os testes mostraram isso no LocalStack depois de `SIGKILL`. Não afeta a correção, porque a mensagem volta e é processada normalmente, mas atrasa a entrega em até `WaitTimeSeconds + VisibilityTimeout`. Por isso o visibility timeout deve ser curto o bastante para a latência aceitável de recuperação, e longo o bastante para cobrir o processamento de um lote.

## 12. Transactional Outbox

Os eventos são gravados em `outbox_messages` na mesma transação do efeito financeiro. Nada é publicado antes do commit, porque quem publica é um worker separado que só enxerga linhas commitadas.

```sql
SELECT ... FROM outbox_messages
 WHERE published_at IS NULL
   AND (next_attempt_at IS NULL OR next_attempt_at <= $now)
 ORDER BY occurred_at, id
 LIMIT 50
 FOR UPDATE SKIP LOCKED;
```

- `SKIP LOCKED` permite vários publishers: cada um pega um lote disjunto, sem esperar pelos outros.
- Publicação em `wagering-events.fifo` com `MessageGroupId = aggregateId` e `MessageDeduplicationId = eventId`.
- Sucesso → `published_at`. Falha → `attempts + 1` e `next_attempt_at` com backoff (2s, 4s, 8s... até 5 minutos).
- Ordem por agregado: dentro do lote, eventos do mesmo `aggregateId` são publicados em sequência e, se um falhar, os seguintes daquele agregado ficam para o próximo ciclo. Agregados diferentes são publicados em paralelo.
- Se o processo morre depois de publicar e antes de marcar, o lock é liberado e outra instância republica. A garantia é **at-least-once**, e o consumidor deduplica por `eventId`. A deduplicação do FIFO cobre a janela de 5 minutos, mas não é a garantia.

Eventos (uma subclasse de `IntegrationEvent` por tipo, com `eventType` e `version` no tipo):

| Evento                             | Quando                               |
| ---------------------------------- | ------------------------------------ |
| `WagerTransactionProcessed`        | transação aplicada, inclusive `LOSS` |
| `WagerTransactionRejected`         | rejeição por regra de negócio        |
| `WalletBalanceChanged`             | somente quando o saldo muda          |
| `WagerTransactionPendingReference` | referência ausente                   |

`correlationId` vem do header `X-Correlation-Id` (HTTP), do `messageId` (fila) ou é `pending-reference:{id}` (worker); `causationId` é o id da transação. `data` usa `MoneyProps`, nunca a instância de `Money`.

Este repositório não contém um consumidor de `wagering-events.fifo`: os eventos são o contrato de saída. Quem os consumir deve deduplicar por `eventId`.

## 13. Reconciliação e paginação

- `POST /wallets/:id/reconciliation` soma o ledger (`CREDIT` positivo, `DEBIT` negativo) no banco e compara com `wallets.balance`. As duas leituras saem de uma única instrução SQL (`JOIN` + `GROUP BY`), portanto do mesmo snapshot.
- Divergência **não é corrigida**: gera log de erro, incrementa a métrica e a resposta volta com `consistent: false`.
- O ledger é paginado por `seq` (`bigserial`): `WHERE wallet_id = ? AND seq > ? ORDER BY seq LIMIT ?`. O cursor é o `seq` com prefixo de versão, em base64url, opaco para o cliente e estável sob inserções concorrentes.

## 14. Observabilidade

Logs em JSON (pino) com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`. Payloads completos não são logados, nem corpo ou query string das requisições. A única quantia que aparece em log é a diferença de uma reconciliação divergente, necessária para o diagnóstico.

Métricas (Prometheus, em `GET /metrics`, sem autenticação):

| Métrica | Tipo | O que mede |
|---|---|---|
| `wager_transactions_total{source,kind,status,failure_code}` | counter | transações concluídas pela primeira vez (replays não contam) |
| `wager_duplicates_total{source,reason}` | counter | replays detectados, por `idempotency_key` ou `inbox` |
| `wager_retries_total{component}` | counter | novas tentativas do consumidor SQS, da outbox e do worker de referências |
| `wager_dlq_messages_total{reason}` | counter | mensagens enviadas para a DLQ pelo consumidor |
| `sqs_dlq_messages` | gauge | profundidade da DLQ, inclusive mensagens movidas pela redrive policy |
| `wallet_lock_conflicts_total` | counter | timeout de lock, deadlock ou `version` divergente |
| `outbox_lag_seconds` | gauge | idade do evento pendente mais antigo (0 com a outbox vazia) |
| `outbox_pending_messages` | gauge | eventos ainda não publicados |
| `wager_processing_duration_seconds{source,outcome}` | histogram | latência do processamento |
| `wallet_reconciliation_mismatch_total` | counter | reconciliações com divergência |

`source` é `http`, `sqs` ou `pending_reference`. Os contadores de negócio são incrementados só depois do commit, para que uma transação desfeita não seja contada. Os gauges de outbox e DLQ são calculados no momento da coleta; se o banco ou o SQS estiverem indisponíveis, a coleta mantém o último valor em vez de falhar (o readiness já sinaliza o problema). Também são exportadas as métricas padrão do processo (CPU, memória, event loop).

Logs: além das linhas de domínio, cada requisição HTTP gera uma linha com método, rota (sem query string), status, duração e `correlationId`. Os logs internos do NestJS passam pelo mesmo logger, então toda a saída é JSON.

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

```bash
bun run test:unit          # sem dependências externas
bun run test:integration   # PostgreSQL + LocalStack reais
bun run test:concurrency   # PostgreSQL + LocalStack reais, inclui 3 processos da aplicação
```

| Pasta | Arquivo | O que cobre |
|---|---|---|
| `test/unit` | `money`, `wallet`, `ledger-entry`, `wager-transaction`, `wager-rules`, `payload-hash`, `messaging`, `observability` | `Money` (escala, entradas inválidas, conflito de moeda), invariantes da `Wallet`, transições, regras de BET/WIN/LOSS/REFUND/ROLLBACK, hash canônico, eventos, inbox/outbox, métricas e alerta de reconciliação |
| `test/integration` | `submit-wager` | atomicidade entre wallet, ledger, transação e outbox; idempotência persistente; reversões; inbox; constraints do schema (ledger imutável, saldo não negativo, unicidade, aritmética) |
| `test/integration` | `http-api` | todos os endpoints, status HTTP por situação, cursor do ledger, reconciliação, health, métricas |
| `test/integration` | `messaging` | consumidor SQS, redelivery, worker morto depois do commit e antes do ack, DLQ, shutdown, dois publishers na mesma outbox, crash antes de publicar, retry do broker, referência fora de ordem e expiração |
| `test/concurrency` | `wallet-contention` | cenário obrigatório 100.00 / 2 × 80.00, mesma aposta 50 vezes em paralelo, disputa de saldo, wallets distintas em paralelo |
| `test/concurrency` | `multi-instance` | 3 processos reais da aplicação: HTTP distribuído, fila consumida pelas três, outbox drenada pelos três publishers, instância morta com `SIGKILL` no meio da carga, `SIGTERM` gracioso, reinício completo do serviço |

Todo teste de integração e de concorrência verifica `wallet.balance == saldo reconstruído pelo ledger`, calculado no banco em `numeric`. O último teste de `multi-instance` verifica a invariante para **todas** as wallets do banco.

Onde há dublês, eles simulam só a falha, nunca o banco ou a fila:

- no teste de falha transitória do consumidor, o caso de uso é trocado por um que sempre lança `TransientInfrastructureError` (simula o banco fora do ar); a fila, a redrive policy e a DLQ são reais;
- "processo morto antes do ack" usa o cliente SQS real com uma falha injetada no `DeleteMessage`;
- "processo morto antes de marcar a publicação" usa a unidade de trabalho real com um `throw` antes do commit;
- o relógio é avançado artificialmente para vencer backoffs sem esperar minutos.

## 17. Trade-offs e limitações conhecidas

- **Wallet quente é serializada.** O lock pessimista limita a vazão de uma única wallet ao tempo de uma transação. Aceitável para um jogador; para contas agregadas de alto volume seria preciso outra modelagem.
- **Publicação com lock aberto.** O publisher mantém o lock das linhas da outbox durante a chamada ao SQS, publicando um evento por chamada. É simples e seguro, mas segura uma conexão pelo tempo da chamada e limitou a publicação a ~300 eventos/s no teste de carga. Alternativa: marcar um `claimed_until`, publicar fora da transação com `SendMessageBatch` e só então marcar.
- **Outbox por polling.** O atraso mínimo de publicação é o intervalo do polling. `LISTEN/NOTIFY` reduziria a latência.
- **Sem retenção.** Inbox, outbox publicada e transações antigas não são expurgadas nem particionadas.
- **Rejeição por wallet inexistente não é persistida** (seção 8, item 5).
- **Reversão parcial e partidas dobradas** estão fora de escopo.
- **Uma moeda nos cenários.** O modelo é multi-moeda e os conflitos são testados, mas não há conversão.
- **Ordenação entre eventos de agregados diferentes** não é garantida, apenas por `aggregateId`.
- **`SIGTERM` no Windows.** O Windows não entrega `SIGTERM` a processos; o encerramento é sempre forçado. O desligamento gracioso funciona em Linux e macOS (e em contêineres); o teste correspondente é pulado no Windows, e a recuperação após encerramento forçado é coberta pelo teste de `SIGKILL`.
- **`FAILED` não é produzido** por nenhum fluxo atual (seção 7).
- **LocalStack, não AWS.** O comportamento de FIFO, redrive e visibilidade foi validado no LocalStack. Na AWS real, `PurgeQueue` tem limite de uma chamada por minuto (usado só nos testes) e a cota de mensagens em voo por grupo pode diferir.
- **Vazão medida, não otimizada.** O teste de carga (`LOAD_TEST.md`) mostrou de 660 a 760 req/s com wallets distribuídas e cerca de 135 req/s numa única wallet (7,5 ms de lock por transação), sem erros e sem inconsistência. Também mostrou dois gargalos fora do caminho financeiro: o publicador da outbox ficou cerca de 5 vezes abaixo da taxa de geração de eventos no pico (lag de 23 s, 53 s para zerar depois da carga) e o consumidor SQS processa um lote de 10 mensagens por vez por instância (cerca de 138 msg/s com três instâncias). As melhorias estão listadas no `LOAD_TEST.md`.
