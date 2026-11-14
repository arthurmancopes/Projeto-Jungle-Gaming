import { z } from "zod";

/** Contrato da mensagem de entrada (seção 10 do desafio). */
const wagerMessageSchema = z.object({
  messageId: z.string().min(1).max(255),
  type: z.literal("WagerTransactionRequested"),
  occurredAt: z.string().min(1),
  data: z.object({
    providerId: z.string(),
    externalTransactionId: z.string(),
    idempotencyKey: z.string().min(1),
    playerId: z.string(),
    walletId: z.string(),
    roundId: z.string(),
    gameId: z.string(),
    kind: z.string(),
    // amount precisa ser string: um número JSON é recusado aqui.
    money: z.object({ amount: z.string(), currency: z.string() }),
    referenceExternalTransactionId: z.string().optional(),
  }),
});

export type WagerMessage = z.infer<typeof wagerMessageSchema>;

export type ParsedWagerMessage = { ok: true; message: WagerMessage } | { ok: false; reason: string };

/** Valida o envelope. As regras de formato dos campos de negócio ficam no caso de uso. */
export function parseWagerMessage(body: string | undefined): ParsedWagerMessage {
  if (!body) return { ok: false, reason: "empty body" };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, reason: "body is not valid JSON" };
  }
  const parsed = wagerMessageSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid message" };
  }
  return { ok: true, message: parsed.data };
}
