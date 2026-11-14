import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import { config } from "../config";

export function createSqsClient(): SQSClient {
  return new SQSClient({
    region: config.aws.region,
    endpoint: config.aws.endpoint,
    credentials: { accessKeyId: config.aws.accessKeyId, secretAccessKey: config.aws.secretAccessKey },
  });
}

/** Readiness: a fila principal precisa estar alcançável. */
export async function checkSqs(client: SQSClient, timeoutMs = 2000): Promise<void> {
  await client.send(new GetQueueUrlCommand({ QueueName: config.queues.wagerTransactions }), {
    abortSignal: AbortSignal.timeout(timeoutMs),
  });
}
