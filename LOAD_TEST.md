# Teste de carga

Este documento registra o ambiente, a metodologia, os resultados e a análise do teste de carga. Não há meta de vazão; o objetivo é entender onde estão os limites do desenho e confirmar que as garantias financeiras se mantêm sob carga.

## Como rodar

```bash
bun run infra:up && bun run migration:up
bun run test:load
```

O relatório sai no terminal e em `load-test-results/latest.md` (e em um `.json` com todos os números). Não rode `bun run start` nem outros testes ao mesmo tempo.

Parâmetros por variável de ambiente: `LOAD_INSTANCES` (3), `LOAD_CONCURRENCY` (50), `LOAD_DURATION_S` (30), `LOAD_HOT_DURATION_S` (15), `LOAD_WALLETS` (200), `LOAD_SQS_MESSAGES` (3000), `LOAD_DB_POOL_MAX` (10).

## Ambiente

| Item | Valor |
|---|---|
| Máquina | notebook, Intel Core i7-12700H (20 threads), 15,7 GB de RAM |
| SO | Windows 11 (NT 10.0.26200) |
| Runtime | Bun 1.4.4 |
| Banco | PostgreSQL 16.16 em Docker Desktop (WSL 2) |
| Broker | LocalStack 3 (SQS FIFO) em Docker Desktop |
| Aplicação | 3 instâncias (processos separados), pool de 10 conexões cada, logs em `warn` |

Gerador de carga, as três instâncias, o PostgreSQL e o LocalStack rodam **na mesma máquina** e disputam a mesma CPU.

## Metodologia

- **Instâncias reais.** O script sobe três processos `bun src/main.ts`, idênticos aos de produção (API, consumidor SQS e workers), e distribui as requisições entre eles em rodízio.
- **Carga em laço fechado.** Cada um dos 50 clientes virtuais envia uma requisição e só envia a próxima quando recebe a resposta. A vazão medida é, portanto, a capacidade sob 50 requisições simultâneas, não a resposta a uma taxa de chegada fixa.
- **Mistura de operações (HTTP):** 75% `BET` (1,00 a 20,00), 15% `WIN`, 5% `LOSS` e 5% replay de uma `Idempotency-Key` já aceita. Rodadas aleatórias por wallet.
- **Cenários:**
  1. 200 wallets com saldo inicial de 5.000,00, por 30 s;
  2. uma única wallet ("quente") com todos os clientes, por 15 s;
  3. 3.000 mensagens SQS enfileiradas de uma vez em 100 wallets, consumidas pelas três instâncias.
- **Aquecimento** de 5 s antes da medição, descartado.
- **Isolamento entre cenários.** Antes de cada cenário o script espera a outbox esvaziar, para que a publicação atrasada de um não pese no seguinte.
- **Medição:**
  - latência HTTP no cliente, da requisição até o fim da leitura da resposta;
  - latência SQS do envio da mensagem até o `processed_at` gravado pela aplicação (mesmo relógio do host);
  - conflitos de lock, retries e estado da outbox lidos do `/metrics` das instâncias, a outbox amostrada a cada segundo;
  - taxa de erro = respostas 5xx, status inesperados e falhas de rede sobre o total (422 e replays não são erro).
- **Verificação final:** saldo materializado igual ao saldo reconstruído pelo ledger para **todas** as wallets do banco.

## Resultados

Uma execução, em 14/11/2026.

### HTTP

| Cenário | Requisições | Vazão | p50 | p95 | p99 | máx | Erro | Conflitos de lock | Outbox: lag máx / pendentes máx |
|---|---|---|---|---|---|---|---|---|---|
| 200 wallets | 19.796 | **658,8 req/s** | 73 ms | 121 ms | 145 ms | 298 ms | 0% | 0 | **22,8 s / 27.677** |
| 1 wallet quente | 2.091 | **135,2 req/s** | 296 ms | 1.035 ms | 1.571 ms | 2.533 ms | 0% | 0 | 0,3 s / 65 |

Status: 18.881 `201` e 915 `200` (replays, 4,6% do total) no primeiro cenário; 1.991 `201` e 100 `200` no segundo. Nenhum 5xx, nenhum 409, nenhum erro de rede.

### SQS

| Mensagens | Enfileiramento | Até processar todas | Vazão | Ponta a ponta p50 | p95 | p99 | máx | Conflitos de lock |
|---|---|---|---|---|---|---|---|---|
| 3.000 em 100 wallets | 1,1 s | 22,0 s | **136,7 msg/s** | 10,5 s | 19,7 s | 20,5 s | 20,6 s | 0 |

### Correção sob carga

- **0 de 698 wallets inconsistentes**: saldo == ledger em todo o banco, inclusive nas wallets de todos os testes anteriores.
- 0 conflitos de lock, 0 respostas 5xx. Os 1.015 replays devolveram `200` sem novo débito.
- Houve 1 retry no cenário 1 e 1 no cenário SQS. Esta execução não separou os retries por componente (o script foi corrigido depois; ver "Limitações"). No cenário 1 só os workers podem ter feito retry, já que o HTTP não refaz requisições, então o mais provável é uma falha momentânea de publicação da outbox no LocalStack.

## Análise

### 1. Carga distribuída: o limite é o banco por requisição, não o lock

A lei de Little confere com os números: 50 clientes ÷ 658,8 req/s = 76 ms de tempo médio por requisição, praticamente o p50 medido (73 ms). Ou seja, os clientes nunca ficaram ociosos e a vazão é exatamente o que a latência permite.

Os 73 ms não vêm de disputa de lock (0 conflitos, wallets diferentes não se bloqueiam): vêm de fila por conexão e de idas e voltas ao banco. Há 50 requisições simultâneas para 30 conexões (3 instâncias × 10), e cada transação faz cerca de nove instruções SQL em sequência (inbox, insert idempotente, leitura com lock, update do saldo, update da transação, ledger, duas linhas de outbox e commit). Com o PostgreSQL atrás da camada de rede do Docker Desktop, cada ida e volta custa mais do que custaria em um servidor Linux.

A latência é estável: p99 de 145 ms, só duas vezes o p50.

### 2. Wallet quente: o preço esperado do lock pessimista

Com todos os clientes na mesma wallet, as transações formam fila na linha da wallet. 1 ÷ 135,2 req/s = **7,4 ms**: é o tempo em que cada transação segura o lock. A latência média esperada pela lei de Little é 50 ÷ 135,2 = 370 ms, e a cauda é longa (p99 de 1,6 s), porque o PostgreSQL não atende a fila de lock em ordem estrita de chegada.

Esse é o trade-off documentado no `ARCHITECTURE.md`: uma wallet processa no máximo algo em torno de 135 transações por segundo neste ambiente, em troca de zero retries e de um resultado determinístico. Para a wallet de um jogador, é uma ordem de grandeza acima de qualquer ritmo real de apostas. Nenhuma requisição chegou perto do `lock_timeout` de 5 s.

Os 7,4 ms são quase todos idas e voltas entre a aplicação e o banco **com o lock já tomado** (update do saldo, da transação, ledger, outbox e commit). É a primeira coisa a otimizar se uma wallet precisar de mais vazão (ver "Melhorias").

### 3. SQS: o consumidor é o gargalo da fila, não o banco

As mesmas três instâncias processaram 658 req/s por HTTP, mas só 137 msg/s pela fila. O banco não é o limite aqui: o limite é o desenho do consumidor.

- Cada instância faz **um** `ReceiveMessage` por vez, de no máximo 10 mensagens, processa o lote, confirma cada mensagem com um `DeleteMessage` separado e só então busca o próximo. 137 msg/s ÷ 3 instâncias ≈ 46 msg/s, ou cerca de 220 ms por ciclo de 10 mensagens.
- Em FIFO, mensagens do mesmo grupo (wallet) não são entregues em paralelo, o que limita ainda mais o que cada `ReceiveMessage` devolve.

A latência ponta a ponta (p50 de 10,5 s) **não é tempo de processamento**: é tempo de espera na fila. As 3.000 mensagens entraram em 1,1 s e foram consumidas de forma linear ao longo de 22 s, então a mensagem mediana esperou metade disso. Com o consumidor folgado, essa latência seria a de uma transação mais um ciclo de polling.

### 4. Outbox: o gargalo mais importante encontrado

No cenário 1, a outbox chegou a 27.677 eventos pendentes, e o evento mais antigo esperou **22,8 s** para ser publicado.

As contas, aproximadas:

| Etapa | Conta | Resultado |
|---|---|---|
| Geração de eventos | 18.881 transações × ~1,95 evento (`BET` e `WIN` geram 2, `LOSS` gera 1) | ~36.800 eventos em 30 s, ~1.200 eventos/s |
| Publicação | ~36.800 gerados − 27.677 pendentes no fim | ~9.100 em 30 s, **~300 eventos/s** para as três instâncias |

A publicação ficou cerca de 4 vezes abaixo da geração. Nesse ritmo, esvaziar o acúmulo leva da ordem de 90 s, mas esta execução não mediu esse tempo (ver "Limitações").

Isso não afeta a correção: o efeito financeiro e o evento são gravados juntos, e o evento é publicado depois, com atraso, mas sem perda. Afeta quem consome os eventos: sob pico, eles chegam com dezenas de segundos de atraso, e é exatamente isso que a métrica `outbox_lag_seconds` existe para mostrar.

A causa está no publicador:

- cada evento é enviado com um `SendMessage` separado, em vez de `SendMessageBatch` (10 por chamada);
- os lotes são de 50 eventos;
- a transação do lote, e com ela uma conexão do banco, fica aberta durante as chamadas ao broker.

## O que estes números não mostram

- **Tudo na mesma máquina.** Gerador, instâncias, banco e broker disputam a mesma CPU. Os números absolutos valem para comparar cenários entre si, não para dimensionar produção.
- **Docker Desktop no Windows.** O PostgreSQL roda numa VM WSL 2, com rede e disco mais lentos que em um servidor Linux. Isso pesa diretamente nas idas e voltas por transação.
- **LocalStack, não AWS.** As chamadas ao SQS real têm latência de rede de outra ordem; o consumidor e o publicador seriam ainda mais sensíveis ao número de chamadas por mensagem.
- **Laço fechado.** Com taxa de chegada fixa (laço aberto), a cauda da latência seria maior quando o sistema saturasse, porque as requisições não esperariam a anterior terminar ("coordinated omission").
- **Uma única execução**, sem repetição nem desvio padrão.
- **Caminho de rejeição pouco exercitado.** Com saldos iniciais altos, nenhuma aposta foi rejeitada (0 respostas 422). O custo do caminho de rejeição não foi medido sob carga.
- **Tempo de drenagem da outbox não registrado nesta execução.** O script esperava a outbox esvaziar entre cenários sem gravar quanto tempo levava. Ele foi corrigido e agora registra esse tempo e os retries por componente; uma nova execução preenche os dois.

## Melhorias que os números sugerem

Em ordem de impacto esperado:

1. **Publicador da outbox:** `SendMessageBatch` (10 eventos por chamada), lotes maiores e publicação fora da transação que reserva o lote (reserva com `claimed_until`, publica, marca). É o gargalo de maior impacto e o mais simples de atacar.
2. **Consumidor SQS:** vários `ReceiveMessage` simultâneos por instância e `DeleteMessageBatch`. Escalar o número de instâncias também ajuda, porque o FIFO distribui grupos diferentes entre consumidores.
3. **Menos idas e voltas com o lock tomado:** juntar update do saldo, update da transação, ledger e outbox em uma única instrução (CTE). Reduziria os 7,4 ms por transação da wallet quente e a latência do caso distribuído.
4. **Pool e instâncias:** com 50 requisições simultâneas e 30 conexões, parte da latência é fila por conexão. Vale medir com mais conexões, lembrando que o PostgreSQL tem limite total de conexões.
