import { describe, expect, test } from "bun:test";
import { canonicalJson, computePayloadHash, type WagerPayload } from "../../src/application/payload-hash";

const payload: WagerPayload = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

describe("payloadHash", () => {
  test("JSON canônico ordena chaves em todos os níveis e omite undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: "x", c: undefined, b: [2, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"b":[2,{"y":2,"z":1}],"d":"x"},"b":1}',
    );
  });

  test("é SHA-256 em hex e determinístico", () => {
    const hash = computePayloadHash(payload);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computePayloadHash({ ...payload })).toBe(hash);
  });

  test("ordem das chaves e campos extras de transporte não alteram o hash", () => {
    const shuffled = {
      money: { currency: "BRL", amount: "25.00" },
      kind: "BET",
      gameId: "fortune-chimp",
      roundId: "round-987",
      walletId: payload.walletId,
      playerId: payload.playerId,
      externalTransactionId: "transaction-123",
      providerId: "provider-a",
      idempotencyKey: "provider-a:transaction-123",
      messageId: "msg-1",
    } as WagerPayload;
    expect(computePayloadHash(shuffled)).toBe(computePayloadHash(payload));
  });

  test("amount é normalizado: 25, 25.0 e 25.00 são o mesmo payload", () => {
    const hash = computePayloadHash(payload);
    expect(computePayloadHash({ ...payload, money: { amount: "25", currency: "BRL" } })).toBe(hash);
    expect(computePayloadHash({ ...payload, money: { amount: "25.0", currency: "BRL" } })).toBe(hash);
  });

  test.each([
    ["valor", { money: { amount: "25.01", currency: "BRL" } }],
    ["moeda", { money: { amount: "25.00", currency: "USD" } }],
    ["kind", { kind: "WIN" }],
    ["rodada", { roundId: "round-988" }],
    ["wallet", { walletId: "outra" }],
    ["referência", { referenceExternalTransactionId: "bet-1" }],
  ])("payload divergente em %s produz hash diferente (conflito, não replay)", (_name, change) => {
    expect(computePayloadHash({ ...payload, ...change })).not.toBe(computePayloadHash(payload));
  });
});
