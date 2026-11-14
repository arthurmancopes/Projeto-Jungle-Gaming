import { createHash } from "node:crypto";
import { InvalidTransactionError } from "../domain/errors";
import { WagerTransactionProcessed, WalletBalanceChanged, type EventContext } from "../domain/events";
import { Money, type MoneyProps } from "../domain/money";
import { OutboxMessage } from "../domain/outbox-message";
import { WagerTransaction } from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { DuplicateWalletError } from "./errors";
import { canonicalJson } from "./payload-hash";
import type { Clock, IdGenerator } from "./ports/system";
import type { UnitOfWork } from "./ports/unit-of-work";

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cria a wallet. Saldo inicial > 0 gera, na MESMA transação SQL, a transação
 * interna OPENING e o lançamento CREDIT correspondente.
 */
export class CreateWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(command: CreateWalletCommand): Promise<WalletView> {
    if (typeof command.playerId !== "string" || !UUID.test(command.playerId)) {
      throw new InvalidTransactionError("playerId must be a UUID");
    }
    const initialBalance = Money.from(command.initialBalance);
    const now = this.clock.now();
    const walletId = this.ids.next();
    const openingTransactionId = this.ids.next();

    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: command.playerId,
      initialBalance,
      openingEntryId: this.ids.next(),
      openingTransactionId,
      now,
    });

    return this.uow.run(async (ctx) => {
      if (!(await ctx.wallets.insertIfAbsent(wallet))) {
        throw new DuplicateWalletError(command.playerId, wallet.currency);
      }

      if (openingEntry) {
        const opening = WagerTransaction.createOpening({
          id: openingTransactionId,
          walletId,
          playerId: command.playerId,
          payloadHash: createHash("sha256")
            .update(canonicalJson({ walletId, playerId: command.playerId, money: initialBalance.toJSON() }))
            .digest("hex"),
          money: initialBalance,
          now,
        });
        opening.markProcessed({ observedBalance: wallet.balance, at: now });
        await ctx.transactions.insertIfAbsent(opening);
        await ctx.ledger.append(openingEntry);

        const eventContext = (): EventContext => ({
          eventId: this.ids.next(),
          correlationId: command.correlationId,
          causationId: opening.id,
          occurredAt: now,
        });
        await ctx.outbox.add(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, eventContext())));
        await ctx.outbox.add(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, eventContext())));
      }

      return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
    });
  }
}
