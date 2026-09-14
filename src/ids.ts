/** Identifier helpers shared across layers. */
import { createHash, randomBytes } from 'node:crypto';

/**
 * A sortable, URL-safe request identifier (SPEC.md §57): 48 bits of millisecond
 * timestamp followed by 40 bits of randomness, base32-encoded.
 */
export function newRequestId(): string {
  const now = Date.now();
  const time = Buffer.alloc(6);
  time.writeUIntBE(now, 0, 6);
  return `${base32(time)}${base32(randomBytes(5))}`.toLowerCase();
}

const B32 = '0123456789abcdefghjkmnpqrstvwxyz';

function base32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}
