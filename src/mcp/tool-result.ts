/**
 * Translation between application results and MCP tool results.
 *
 * SPEC.md §25 errors are returned as tool results with `isError: true` carrying the
 * error envelope, not as JSON-RPC protocol errors, so an agent can read and recover from
 * them (docs/DEVIATIONS.md D15).
 */
import { toErrorEnvelope } from '../errors/errors.js';

export interface McpToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Serialize a payload, truncating when it would exceed `max_tool_response_bytes`. */
export function toolSuccess(payload: unknown, maxBytes: number): McpToolResult {
  const text = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return {
      content: [{ type: 'text', text }],
      ...(isRecord(payload) ? { structuredContent: payload } : {}),
    };
  }

  const notice = {
    error: {
      code: 'RESPONSE_TOO_LARGE',
      message:
        `The tool result is ${Buffer.byteLength(text, 'utf8')} bytes, which exceeds the ` +
        `configured max_tool_response_bytes of ${maxBytes}. Narrow the request — fewer ` +
        'operations per inspect_api call, a smaller page size, or a run_api_code script ' +
        'that reduces the data before returning it.',
      details: { bytes: Buffer.byteLength(text, 'utf8'), limit: maxBytes },
    },
  };
  const noticeText = JSON.stringify(notice, null, 2);
  return {
    content: [{ type: 'text', text: noticeText }],
    structuredContent: notice,
    isError: true,
  };
}

export function toolError(error: unknown): McpToolResult {
  const envelope = toErrorEnvelope(error);
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope as unknown as Record<string, unknown>,
    isError: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
