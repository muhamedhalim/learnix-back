import type { Logger } from '@nestjs/common';

import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';

export interface SqsPollerOptions {
  region: string;
  queueUrl: string;
  /** Return true when the message may be deleted; false (or a throw) leaves it for redelivery. */
  handle: (message: Message) => Promise<boolean>;
  logger: Logger;
  client?: SQSClient;
}

/**
 * Long-polling SQS consumer loop. A message is deleted only after `handle` accepted it, so a
 * failure is retried by SQS (and, via the queue's redrive policy, ends in a DLQ). `stop()` aborts
 * the in-flight long poll and resolves when the loop has exited.
 */
export function startSqsPoller(options: SqsPollerOptions): { stop: () => Promise<void> } {
  const abort = new AbortController();
  const client = options.client ?? new SQSClient({ region: options.region });

  const loop = (async (): Promise<void> => {
    while (!abort.signal.aborted) {
      try {
        const received = await client.send(
          new ReceiveMessageCommand({
            QueueUrl: options.queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 20,
          }),
          { abortSignal: abort.signal },
        );
        for (const message of received.Messages ?? []) {
          let accepted = false;
          try {
            accepted = await options.handle(message);
          } catch (err) {
            options.logger.error(`SQS handler failed: ${(err as Error).message}`);
          }
          if (accepted && message.ReceiptHandle !== undefined) {
            await client.send(
              new DeleteMessageCommand({
                QueueUrl: options.queueUrl,
                ReceiptHandle: message.ReceiptHandle,
              }),
            );
          }
        }
      } catch (err) {
        if (abort.signal.aborted) return;
        options.logger.warn(`SQS poll failed: ${(err as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
  })();

  return {
    stop: async (): Promise<void> => {
      abort.abort();
      await loop.catch(() => undefined);
    },
  };
}
