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

/** Incremental newline-delimited JSON decoder. */
export class MessageDecoder {
  private buffer = '';

  push(chunk: string): unknown[] {
    this.buffer += chunk;
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
