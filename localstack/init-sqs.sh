#!/bin/bash
set -euo pipefail

# DLQ primeiro: a fila principal precisa do ARN dela na redrive policy.
awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,MessageRetentionPeriod=1209600

DLQ_URL=$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)

# maxReceiveCount=5: após 5 entregas sem ack, a mensagem vai para a DLQ.
awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"

# Destino dos eventos de integração publicados pela outbox.
awslocal sqs create-queue \
  --queue-name wagering-events.fifo \
  --attributes FifoQueue=true

echo "SQS queues ready"
