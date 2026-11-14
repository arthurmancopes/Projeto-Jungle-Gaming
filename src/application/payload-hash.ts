import { createHash } from "node:crypto";
import { Money, type MoneyProps } from "../domain/money";

/** Subconjunto de campos de negócio que entra no hash. Header e metadados de transporte ficam de fora. */
export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/** JSON canônico: chaves ordenadas em todos os níveis, sem espaços, campos undefined omitidos. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number in canonical JSON");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${members.join(",")}}`;
  }
  throw new TypeError(`unsupported value in canonical JSON: ${typeof value}`);
}

/**
 * payloadHash = SHA-256 (hex) do JSON canônico dos campos de negócio.
 * O amount é normalizado para 2 casas, então "25", "25.0" e "25.00" produzem o mesmo hash.
 * Os campos são copiados um a um: propriedades extras no payload não alteram o hash.
 */
export function computePayloadHash(payload: WagerPayload): string {
  const business = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: Money.from(payload.money).toJSON(),
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  };
  return createHash("sha256").update(canonicalJson(business), "utf8").digest("hex");
}
