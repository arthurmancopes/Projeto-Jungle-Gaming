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

Duas execuções seguidas, em 14/11/2026, com os mesmos parâmetros. A segunda já registra o tempo de drenagem da outbox e os retries por componente.

### HTTP

| Cenário | Execução | Requisições | Vazão | p50 | p95 | p99 | máx | Erro | Conflitos de lock | Outbox: lag máx / pendentes máx | Outbox zera em |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 200 wallets | 1ª | 19.796 | **658,8 req/s** | 73 ms | 121 ms | 145 ms | 298 ms | 0% | 0 | 22,8 s / 27.677 | não medido |
| 200 wallets | 2ª | 22.934 | **763,1 req/s** | 62 ms | 118 ms | 146 ms | 238 ms | 0% | 0 | 22,7 s / 33.674 | **52,6 s** |
| 1 wallet quente | 1ª | 2.091 | **135,2 req/s** | 296 ms | 1.035 ms | 1.571 ms | 2.533 ms | 0% | 0 | 0,3 s / 65 | não medido |
| 1 wallet quente | 2ª | 2.052 | **133,5 req/s** | 296 ms | 973 ms | 1.480 ms | 2.432 ms | 0% | 0 | 0,6 s / 140 | 0,5 s |

Nenhum 5xx, nenhum 409, nenhum erro de rede. Os replays (cerca de 5% das requisições, 2.262 no total das duas execuções) devolveram `200` sem novo débito.

### SQS

| Execução | Mensagens | Até processar todas | Vazão | Ponta a ponta p50 | p95 | p99 | máx | Conflitos de lock |
|---|---|---|---|---|---|---|---|---|
| 1ª | 3.000 em 100 wallets | 22,0 s | **136,7 msg/s** | 10,5 s | 19,7 s | 20,5 s | 20,6 s | 0 |
| 2ª | 3.000 em 100 wallets | 21,6 s | **139,2 msg/s** | 10,3 s | 19,4 s | 20,1 s | 20,3 s | 0 |

### Correção sob carga

- **0 inconsistências**: saldo == ledger em 698 wallets na 1ª execução e em 899 na 2ª (todo o banco, inclusive as wallets de todos os testes anteriores).
- 0 conflitos de lock e 0 respostas 5xx nas duas execuções.
- Retries: 0 na 2ª execução, em todos os componentes. A 1ª teve 1 retry no cenário HTTP distribuído e 1 no SQS, sem registro do componente; como o HTTP não refaz requisições, o do cenário HTTP só pode ter vindo dos workers, provavelmente uma falha momentânea de publicação no LocalStack.

### Variação entre execuções

A wallet quente e o SQS variaram menos de 2% entre as execuções. O cenário distribuído variou 16% (659 → 763 req/s), com o p95 praticamente igual (121 → 118 ms): a diferença está na mediana, o que é consistente com uma máquina compartilhada em que gerador, aplicação e banco disputam CPU. Duas execuções não bastam para um intervalo de confiança; servem para mostrar a ordem de grandeza e a estabilidade das caudas.

## Análise

### 1. Carga distribuída: o limite é o banco por requisição, não o lock

A lei de Little confere com os números: 50 clientes ÷ 763 req/s = 66 ms de tempo médio por requisição, praticamente o p50 medido na 2ª execução (62 ms); na 1ª, 50 ÷ 659 = 76 ms contra p50 de 73 ms. Ou seja, os clientes nunca ficaram ociosos e a vazão é exatamente o que a latência permite.

Essa latência não vem de disputa de lock (0 conflitos, wallets diferentes não se bloqueiam): vem de fila por conexão e de idas e voltas ao banco. Há 50 requisições simultâneas para 30 conexões (3 instâncias × 10), e cada transação faz cerca de nove instruções SQL em sequência (inbox, insert idempotente, leitura com lock, update do saldo, update da transação, ledger, duas linhas de outbox e commit). Com o PostgreSQL atrás da camada de rede do Docker Desktop, cada ida e volta custa mais do que custaria em um servidor Linux.

A latência é estável: p99 de cerca de 145 ms nas duas execuções, pouco mais que o dobro do p50.

### 2. Wallet quente: o preço esperado do lock pessimista

Com todos os clientes na mesma wallet, as transações formam fila na linha da wallet. 1 ÷ 134 req/s = **7,5 ms**: é o tempo em que cada transação segura o lock, praticamente igual nas duas execuções. A latência média esperada pela lei de Little é 50 ÷ 134 = 373 ms, e a cauda é longa (p99 de 1,5 s), porque o PostgreSQL não atende a fila de lock em ordem estrita de chegada.

Esse é o trade-off documentado no `ARCHITECTURE.md`: uma wallet processa no máximo algo em torno de 135 transações por segundo neste ambiente, em troca de zero retries e de um resultado determinístico. Para a wallet de um jogador, é uma ordem de grandeza acima de qualquer ritmo real de apostas. Nenhuma requisição chegou perto do `lock_timeout` de 5 s.

Os 7,5 ms são quase todos idas e voltas entre a aplicação e o banco **com o lock já tomado** (update do saldo, da transação, ledger, outbox e commit). É a primeira coisa a otimizar se uma wallet precisar de mais vazão (ver "Melhorias").

### 3. SQS: o consumidor é o gargalo da fila, não o banco

As mesmas três instâncias processaram 660 a 760 req/s por HTTP, mas só cerca de 138 msg/s pela fila. O banco não é o limite aqui: o limite é o desenho do consumidor.

- Cada instância faz **um** `ReceiveMessage` por vez, de no máximo 10 mensagens, processa o lote, confirma cada mensagem com um `DeleteMessage` separado e só então busca o próximo. 138 msg/s ÷ 3 instâncias ≈ 46 msg/s, ou cerca de 220 ms por ciclo de 10 mensagens.
- Em FIFO, mensagens do mesmo grupo (wallet) não são entregues em paralelo, o que limita ainda mais o que cada `ReceiveMessage` devolve.

A latência ponta a ponta (p50 de cerca de 10 s) **não é tempo de processamento**: é tempo de espera na fila. As 3.000 mensagens entraram em 1 s e foram consumidas de forma linear ao longo de 22 s, então a mensagem mediana esperou metade disso. Com o consumidor folgado, essa latência seria a de uma transação mais um ciclo de polling.

### 4. Outbox: o gargalo mais importante encontrado

No cenário distribuído, a outbox chegou a 33.674 eventos pendentes na 2ª execução, o evento mais antigo esperou **22,7 s** para ser publicado, e a outbox só zerou **52,6 s depois do fim da carga**.

As contas da 2ª execução, aproximadas:

| Etapa | Conta | Resultado |
|---|---|---|
| Geração de eventos | 21.791 transações × ~1,95 evento (`BET` e `WIN` geram 2, `LOSS` gera 1) | ~42.500 eventos em 30 s, **~1.400 eventos/s** |
| Publicação durante a carga | ~42.500 gerados − 33.674 pendentes no fim | ~8.800 em 30 s, **~290 eventos/s** |
| Publicação depois da carga | 33.674 pendentes em 52,6 s | **~640 eventos/s** |

Durante o pico, a publicação ficou cerca de 5 vezes abaixo da geração. Depois que a carga parou, o mesmo publicador dobrou de ritmo: ele disputa banco e CPU com o processamento das transações.

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
- **Duas execuções**, sem desvio padrão nem intervalo de confiança.
- **Caminho de rejeição pouco exercitado.** Com saldos iniciais altos, nenhuma aposta foi rejeitada (0 respostas 422). O custo do caminho de rejeição não foi medido sob carga.

## Melhorias que os números sugerem

Em ordem de impacto esperado:

1. **Publicador da outbox:** `SendMessageBatch` (10 eventos por chamada), lotes maiores e publicação fora da transação que reserva o lote (reserva com `claimed_until`, publica, marca). É o gargalo de maior impacto e o mais simples de atacar.
2. **Consumidor SQS:** vários `ReceiveMessage` simultâneos por instância e `DeleteMessageBatch`. Escalar o número de instâncias também ajuda, porque o FIFO distribui grupos diferentes entre consumidores.
3. **Menos idas e voltas com o lock tomado:** juntar update do saldo, update da transação, ledger e outbox em uma única instrução (CTE). Reduziria os 7,5 ms por transação da wallet quente e a latência do caso distribuído.
4. **Pool e instâncias:** com 50 requisições simultâneas e 30 conexões, parte da latência é fila por conexão. Vale medir com mais conexões, lembrando que o PostgreSQL tem limite total de conexões.
