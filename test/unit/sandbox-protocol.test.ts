/** The sandbox RPC framing (SPEC.md §34). */
import { describe, expect, it } from 'vitest';
import { encodeMessage, MessageDecoder } from '../../src/sandbox/protocol.js';

describe('message framing', () => {
  it('round-trips a message', () => {
    const decoder = new MessageDecoder();
    const encoded = encodeMessage({ type: 'api_result', id: '1', result: { a: 1 } });
    expect(encoded.endsWith('\n')).toBe(true);
    expect(decoder.push(encoded)).toEqual([{ type: 'api_result', id: '1', result: { a: 1 } }]);
  });

  it('reassembles a message split across chunks', () => {
    const decoder = new MessageDecoder();
    expect(decoder.push('{"type":"re')).toEqual([]);
    expect(decoder.push('ady"}\n')).toEqual([{ type: 'ready' }]);
  });

  it('handles several messages in one chunk', () => {
    const decoder = new MessageDecoder();
    expect(decoder.push('{"type":"ready"}\n{"type":"log","level":"log","message":"x"}\n')).toEqual([
      { type: 'ready' },
      { type: 'log', level: 'log', message: 'x' },
    ]);
  });

  it('drops a malformed frame rather than throwing', () => {
    const decoder = new MessageDecoder();
    // An untrusted process must not be able to crash the parent with bad output.
    expect(decoder.push('not json\n{"type":"ready"}\n')).toEqual([{ type: 'ready' }]);
  });

  it('ignores blank lines', () => {
    const decoder = new MessageDecoder();
    expect(decoder.push('\n\n{"type":"ready"}\n')).toEqual([{ type: 'ready' }]);
  });

  it('does not grow without bound on a frame that never ends', () => {
    const decoder = new MessageDecoder(1024);
    for (let i = 0; i < 100; i++) expect(decoder.push('x'.repeat(500))).toEqual([]);
    // The oversized frame is abandoned and the decoder resynchronizes at the next
    // boundary rather than treating the residue as the start of a message.
    expect(decoder.push(`${'x'.repeat(200)}\n{"type":"ready"}\n`)).toEqual([{ type: 'ready' }]);
  });

  it('resumes cleanly when the boundary arrives in a later chunk', () => {
    const decoder = new MessageDecoder(64);
    expect(decoder.push('y'.repeat(200))).toEqual([]);
    expect(decoder.push('y'.repeat(200))).toEqual([]);
    expect(decoder.push('tail\n')).toEqual([]);
    expect(decoder.push('{"type":"ready"}\n')).toEqual([{ type: 'ready' }]);
  });
});
