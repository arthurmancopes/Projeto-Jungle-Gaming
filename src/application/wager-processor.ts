import type { EventContext } from "../domain/events";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../domain/events";
import { OutboxMessage } from "../domain/outbox-message";
import { applyWagerTransaction, type WagerOutcome } from "../domain/wager-rules";
import { WagerTransactionStatus, type WagerTransaction } from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";
import { WalletNotFoundError } from "./errors";
import type { Clock, IdGenerator } from "./ports/system";
import type { TransactionContext } from "./ports/unit-of-work";

export interface ProcessedWager {
  wallet: Wallet;
  outcome: WagerOutcome;
}

/**
 * Núcleo do processamento, compartilhado pela submissão (HTTP/SQS) e pelo
 * reprocessamento de referências pendentes. Roda sempre DENTRO de uma transação SQL
 * e pressupõe que a linha da transação já existe no banco.
 *
 * Ordem: lock da wallet -> leitura da referência -> regras -> wallet + ledger +
 * transação + outbox. Tudo é confirmado junto no commit.
 */
export class WagerProcessor {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async process(ctx: TransactionContext, tx: WagerTransaction, correlationId: string): Promise<ProcessedWager> {
    // 1. Serializa todas as operações desta wallet (e só dela).
    const wallet = await ctx.wallets.findByIdForUpdate(tx.walletId);
    if (!wallet) throw new WalletNotFoundError(tx.walletId);

    // 2. A referência é lida depois do lock: enxerga tudo que já foi commitado nesta wallet.
    let reference: WagerTransaction | undefined;
    let referenceAlreadyReversed = false;
    if (tx.resolvesReference() && tx.referenceExternalTransactionId !== undefined) {
      reference = await ctx.transactions.findByProviderAndExternalId(
        tx.providerId,
        tx.referenceExternalTransactionId,
      );
      if (reference && tx.requiresReference()) {
        referenceAlreadyReversed = await ctx.transactions.existsProcessedReversalOf(reference.id);
      }
    }

    // 3. Regras de domínio (em memória).
    const now = this.clock.now();
    const versionBefore = wallet.version;
    const outcome = applyWagerTransaction({
      wallet,
      transaction: tx,
      reference,
      referenceAlreadyReversed,
      ledgerEntryId: this.ids.next(),
      now,
    });

    // 4. Persistência: saldo e lançamento sempre juntos.
    const entry = outcome.status === WagerTransactionStatus.Processed ? outcome.entry : undefined;
    if (entry) {
      await ctx.wallets.save(wallet, versionBefore);
    }
    await ctx.transactions.update(tx);
    if (entry) {
      await ctx.ledger.append(entry);
    }

    // 5. Eventos na outbox, na mesma transação. Nada é publicado aqui.
    const eventContext = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId,
      causationId: tx.id,
      occurredAt: now,
    });
    switch (outcome.status) {
      case WagerTransactionStatus.Processed:
        await ctx.outbox.add(OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, eventContext())));
        if (entry) {
          await ctx.outbox.add(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, eventContext())));
        }
        break;
      case WagerTransactionStatus.Rejected:
        await ctx.outbox.add(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, eventContext())));
        break;
      case WagerTransactionStatus.PendingReference:
        // Só na primeira vez; novas tentativas do worker não republicam o evento.
        if (tx.referenceAttempts === 0) {
          await ctx.outbox.add(OutboxMessage.enqueue(WagerTransactionPendingReference.from(tx, eventContext())));
        }
        break;
    }

    return { wallet, outcome };
  }
}
