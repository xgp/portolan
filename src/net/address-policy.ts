/**
 * IP address classification and destination policy (SPEC.md §12, §30).
 *
 * Classification is done on resolved IP addresses, never on hostnames, because a
 * hostname tells you nothing about where a connection will actually land.
 */
import { isIP } from 'node:net';

export type AddressCategory =
  | 'public'
  | 'loopback'
  | 'private'
  | 'link_local'
  | 'metadata'
  | 'multicast'
  | 'reserved'
  | 'unspecified';

/**
 * Cloud instance-metadata endpoints. These are always refused: no configuration flag
 * enables them, because reaching one is never a legitimate use of an API catalog and is
 * the highest-value SSRF target there is.
 */
const METADATA_ADDRESSES = new Set([
  '169.254.169.254', // AWS, GCP, Azure, DigitalOcean, OpenStack
  '169.254.170.2', // AWS ECS task metadata
  '100.100.100.200', // Alibaba Cloud
  '192.0.0.192', // Oracle Cloud
  'fd00:ec2::254', // AWS IMDS over IPv6
]);

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function inCidr(address: number, prefix: string, bits: number): boolean {
  const base = ipv4ToInt(prefix);
  if (base === null) return false;
  const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
  return (address & mask) >>> 0 === (base & mask) >>> 0;
}

function classifyIpv4(address: string): AddressCategory {
  if (METADATA_ADDRESSES.has(address)) return 'metadata';
  const value = ipv4ToInt(address);
  if (value === null) return 'reserved';

  if (inCidr(value, '0.0.0.0', 8)) return 'unspecified';
  if (inCidr(value, '127.0.0.0', 8)) return 'loopback';
  if (inCidr(value, '169.254.0.0', 16)) return 'link_local';
  if (inCidr(value, '10.0.0.0', 8)) return 'private';
  if (inCidr(value, '172.16.0.0', 12)) return 'private';
  if (inCidr(value, '192.168.0.0', 16)) return 'private';
  if (inCidr(value, '100.64.0.0', 10)) return 'private'; // carrier-grade NAT
  if (inCidr(value, '192.0.0.0', 24)) return 'reserved';
  if (inCidr(value, '192.0.2.0', 24)) return 'reserved';
  if (inCidr(value, '198.18.0.0', 15)) return 'reserved';
  if (inCidr(value, '198.51.100.0', 24)) return 'reserved';
  if (inCidr(value, '203.0.113.0', 24)) return 'reserved';
  if (inCidr(value, '224.0.0.0', 4)) return 'multicast';
  if (inCidr(value, '240.0.0.0', 4)) return 'reserved';
  return 'public';
}

/** Expand an IPv6 address to its eight 16-bit groups. */
function expandIpv6(address: string): number[] | null {
  const zone = address.indexOf('%');
  const bare = (zone === -1 ? address : address.slice(0, zone)).toLowerCase();

  // Embedded IPv4 (::ffff:1.2.3.4 and friends) — convert the tail to two groups.
  const v4Match = /^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(bare);
  let text = bare;
  if (v4Match?.[1] && v4Match[2]) {
    const value = ipv4ToInt(v4Match[2]);
    if (value === null) return null;
    text = `${v4Match[1]}${((value >>> 16) & 0xffff).toString(16)}:${(value & 0xffff).toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':').filter((s) => s !== '') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':').filter((s) => s !== '') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 && head.length !== 8) return null;
  if (fill < 0) return null;

  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const parsed = groups.map((g) => Number.parseInt(g || '0', 16));
  return parsed.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ? null : parsed;
}

function classifyIpv6(address: string): AddressCategory {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (METADATA_ADDRESSES.has(normalized)) return 'metadata';
  const groups = expandIpv6(normalized);
  if (!groups) return 'reserved';

  // `::` and `::1` are handled before the IPv4-compatible branch below, which would
  // otherwise read `::1` as the embedded IPv4 address 0.0.0.1.
  if (groups.every((g) => g === 0)) return 'unspecified';
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return 'loopback';

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible: classify the embedded address,
  // otherwise ::ffff:127.0.0.1 would sail past an IPv4-only loopback check.
  const isMapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  const isCompat =
    groups.slice(0, 6).every((g) => g === 0) && !(groups[6] === 0 && groups[7] === 0);
  if (isMapped || isCompat) {
    const g6 = groups[6] ?? 0;
    const g7 = groups[7] ?? 0;
    const v4 = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
    return classifyIpv4(v4);
  }
  // 6to4 (2002::/16) embeds an IPv4 address in the next 32 bits.
  if (groups[0] === 0x2002) {
    const g1 = groups[1] ?? 0;
    const g2 = groups[2] ?? 0;
    const v4 = `${(g1 >> 8) & 0xff}.${g1 & 0xff}.${(g2 >> 8) & 0xff}.${g2 & 0xff}`;
    const embedded = classifyIpv4(v4);
    if (embedded !== 'public') return embedded;
  }
  // NAT64 well-known prefix 64:ff9b::/96.
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    const g6 = groups[6] ?? 0;
    const g7 = groups[7] ?? 0;
    const v4 = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
    return classifyIpv4(v4);
  }

  const first = groups[0] ?? 0;
  if ((first & 0xfe00) === 0xfc00) return 'private'; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return 'link_local'; // fe80::/10
  if ((first & 0xff00) === 0xff00) return 'multicast'; // ff00::/8
  return 'public';
}

export function classifyAddress(address: string): AddressCategory {
  const version = isIP(address.replace(/^\[|\]$/g, ''));
  if (version === 4) return classifyIpv4(address);
  if (version === 6) return classifyIpv6(address);
  return 'reserved';
}

export interface NetworkPolicyOptions {
  allowPrivateAddresses: boolean;
  allowLoopback: boolean;
  allowHttp: boolean;
  /** When non-empty, the destination hostname must appear here (SPEC.md §30). */
  allowedHosts: readonly string[];
}

export interface AddressDecision {
  allowed: boolean;
  category: AddressCategory;
  reason?: string;
}

export function isAddressAllowed(address: string, policy: NetworkPolicyOptions): AddressDecision {
  const category = classifyAddress(address);
  switch (category) {
    case 'public':
      return { allowed: true, category };
    case 'loopback':
      return policy.allowLoopback
        ? { allowed: true, category }
        : {
            allowed: false,
            category,
            reason: 'loopback addresses are blocked (set network.allow_loopback to permit them)',
          };
    case 'private':
    case 'link_local':
      return policy.allowPrivateAddresses
        ? { allowed: true, category }
        : {
            allowed: false,
            category,
            reason:
              `${category === 'private' ? 'private-network' : 'link-local'} addresses are blocked ` +
              '(set network.allow_private_addresses to permit them)',
          };
    case 'metadata':
      return {
        allowed: false,
        category,
        reason: 'cloud instance-metadata addresses are always blocked',
      };
    default:
      return {
        allowed: false,
        category,
        reason: `${category} addresses are never routable targets`,
      };
  }
}

/** Match a host against an allowlist entry, supporting a leading `*.` wildcard. */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const p = pattern.toLowerCase().replace(/\.$/, '');
  if (p.startsWith('*.')) return h === p.slice(2) || h.endsWith(p.slice(1));
  return h === p;
}

export function isHostAllowed(host: string, policy: NetworkPolicyOptions): boolean {
  if (policy.allowedHosts.length === 0) return true;
  return policy.allowedHosts.some((pattern) => hostMatches(host, pattern));
}

/** SPEC.md §12: only http(s) URLs are ever fetched. file:, ftp:, data:, gopher: are not. */
export const ALLOWED_PROTOCOLS = new Set(['https:', 'http:']);
