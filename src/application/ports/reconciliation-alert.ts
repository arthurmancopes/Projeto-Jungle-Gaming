import type { MoneyProps } from "../../domain/money";

/** Divergências entre saldo e ledger nunca são corrigidas em silêncio: são sinalizadas por aqui. */
export interface ReconciliationAlert {
  mismatchDetected(info: {
    walletId: string;
    difference: MoneyProps;
    checkedEntries: number;
    correlationId: string;
  }): void;
}
