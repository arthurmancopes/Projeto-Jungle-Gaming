import type { MoneyProps } from "../domain/money";
import { NotFoundError } from "./errors";
import type { ReconciliationAlert } from "./ports/reconciliation-alert";
import type { UnitOfWork } from "./ports/unit-of-work";

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Compara o saldo materializado com o saldo reconstruído pelo ledger.
 * Divergência NÃO é corrigida: é sinalizada (log + métrica) e devolvida na resposta.
 */
export class ReconcileWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly alert: ReconciliationAlert,
  ) {}

  async execute(walletId: string, correlationId: string): Promise<ReconciliationResult> {
    const snapshot = UUID.test(walletId) ? await this.uow.run((ctx) => ctx.ledger.reconcile(walletId)) : undefined;
    if (!snapshot) throw new NotFoundError(`Wallet ${walletId}`);

    const difference = snapshot.storedBalance.subtract(snapshot.calculatedBalance);
    const consistent = difference.isZero();
    if (!consistent) {
      this.alert.mismatchDetected({
        walletId,
        difference: difference.toJSON(),
        checkedEntries: snapshot.checkedEntries,
        correlationId,
      });
    }
    return {
      walletId,
      storedBalance: snapshot.storedBalance.toJSON(),
      calculatedBalance: snapshot.calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: snapshot.checkedEntries,
    };
  }
}
