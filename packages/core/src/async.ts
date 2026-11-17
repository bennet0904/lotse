/**
 * Bridges callback-style producers (process output, sockets) to async
 * iteration, which is how events flow through the framework.
 */
export interface Channel<T> extends AsyncIterable<T> {
  push(value: T): void;
  /** Ends the iteration; with an error the consumer's loop throws it. */
  close(error?: unknown): void;
}

export function createChannel<T>(): Channel<T> {
  const queue: T[] = [];
  let waiting: (() => void) | undefined;
  let closed = false;
  let failure: unknown;
  const wake = () => {
    const w = waiting;
    waiting = undefined;
    w?.();
  };
  return {
    push(value) {
      if (closed) return;
      queue.push(value);
      wake();
    },
    close(error) {
      if (closed) return;
      closed = true;
      failure = error;
      wake();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length > 0) yield queue.shift() as T;
        if (closed) {
          if (failure !== undefined) throw failure;
          return;
        }
        await new Promise<void>((resolve) => {
          waiting = resolve;
        });
      }
    },
  };
}

/** Splits a stream of chunks into lines, keeping partial lines until they are complete. */
export function lineSplitter(onLine: (line: string) => void): { write(chunk: string | Buffer): void; flush(): void } {
  let rest = "";
  return {
    write(chunk) {
      rest += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const lines = rest.split(/\r?\n|\r/);
      rest = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    },
    flush() {
      if (rest) onLine(rest);
      rest = "";
    },
  };
}
