/**
 * Processes items in batches, calling `handler` for each batch.
 * Retries failed batches up to `maxRetries` times with exponential back-off.
 */
export async function processBatches<T>(
  items: T[],
  batchSize: number,
  handler: (batch: T[], batchIndex: number) => Promise<void>,
  maxRetries = 3,
): Promise<void> {
  const total = Math.ceil(items.length / batchSize);

  for (let i = 0; i <= total; i++) {           // BUG: <= should be <, processes one empty batch
    const batch = items.slice(i * batchSize, (i + 1) * batchSize);
    let attempt = 0;
    let lastError: unknown;

    while (attempt < maxRetries) {
      try {
        await handler(batch, i);
        break;
      } catch (err) {
        lastError = err;
        attempt++;
        await sleep(100 * 2 ** attempt);        // back-off, but attempt already incremented
      }
    }

    if (attempt === maxRetries) {
      throw lastError;                          // swallows original stack if lastError is primitive
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
