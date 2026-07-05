import { once } from 'node:events';
import { WriteStream } from 'node:fs';

/**
 * Write to a stream respecting backpressure: when the internal buffer is full,
 * await 'drain' before continuing. Prevents unbounded memory growth on large
 * exports where the producer outpaces disk I/O.
 */
export async function writeBackpressured(
  stream: WriteStream,
  chunk: string | Buffer,
): Promise<void> {
  if (!stream.write(chunk)) {
    await once(stream, 'drain');
  }
}

/** Resolve once the write stream has fully flushed and closed. */
export async function endStream(stream: WriteStream): Promise<void> {
  stream.end();
  await once(stream, 'finish');
}
