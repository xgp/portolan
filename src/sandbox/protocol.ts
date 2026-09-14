/**
 * The parent/sandbox RPC protocol (SPEC.md §34).
 *
 * Newline-delimited JSON over the sandbox process's stdin and stdout. The sandbox can
 * only ask the parent to perform an `api_call`; it has no other channel to anything.
 * Credentials never cross this boundary in either direction.
 */

/** Parent to sandbox. */
export type HostMessage =
  | {
      type: 'start';
      code: string;
      input: unknown;
      limits: { maxLogEntries: number; maxLogBytes: number; maxOutputBytes: number };
    }
  | { type: 'api_result'; id: string; result: unknown }
  | { type: 'api_error'; id: string; error: { code: string; message: string; details?: unknown } };

/** Sandbox to parent. */
export type SandboxMessage =
  | { type: 'ready' }
  | {
      type: 'api_call';
      id: string;
      request: {
        operation_id: string;
        parameters?: Record<string, unknown>;
        body?: unknown;
        content_type?: string;
      };
    }
  | { type: 'log'; level: string; message: string }
  | { type: 'result'; result: unknown }
  | { type: 'error'; message: string; name?: string };

export function encodeMessage(message: HostMessage | SandboxMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Incremental newline-delimited JSON decoder.
 *
 * The buffer is capped. Only the sandbox runtime writes to the pipe (user code cannot
 * reach stdout), but a decoder that grows without bound on a frame that never ends would
 * let a sandbox fault become a parent-process memory problem.
 */
export class MessageDecoder {
  private buffer = '';
  /** Set after an overflow: input is discarded until the next frame boundary. */
  private resyncing = false;

  constructor(private readonly maxBufferBytes = 8 * 1024 * 1024) {}

  push(chunk: string): unknown[] {
    let input = chunk;

    if (this.resyncing) {
      const boundary = input.indexOf('\n');
      if (boundary === -1) return [];
      // The rest of the oversized frame is gone; resume at the next complete one.
      input = input.slice(boundary + 1);
      this.resyncing = false;
    }

    if (this.buffer.length + input.length > this.maxBufferBytes) {
      this.buffer = '';
      this.resyncing = true;
      const boundary = input.indexOf('\n');
      if (boundary === -1) return [];
      input = input.slice(boundary + 1);
      this.resyncing = false;
    }

    this.buffer += input;
    const messages: unknown[] = [];
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line !== '') {
        try {
          messages.push(JSON.parse(line));
        } catch {
          // A malformed frame is dropped: the sandbox is untrusted and must not be able
          // to crash the parent by writing garbage to stdout.
        }
      }
      index = this.buffer.indexOf('\n');
    }
    return messages;
  }
}
