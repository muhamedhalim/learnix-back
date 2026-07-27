export class HealthCheckTimeoutError extends Error {
  constructor(
    public readonly componentId: string,
    public readonly timeoutMs: number,
  ) {
    super(`${componentId} health check exceeded ${timeoutMs.toString()}ms`);
    this.name = 'HealthCheckTimeoutError';
  }
}

export async function withHealthTimeout<T>(
  componentId: string,
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new HealthCheckTimeoutError(componentId, timeoutMs)),
      timeoutMs,
    );
    timer.unref();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
