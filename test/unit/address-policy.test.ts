import { describe, expect, it } from 'vitest';
import {
  classifyAddress,
  hostMatches,
  isAddressAllowed,
  isHostAllowed,
  type NetworkPolicyOptions,
} from '../../src/net/address-policy.js';

const denyAll: NetworkPolicyOptions = {
  allowPrivateAddresses: false,
  allowLoopback: false,
  allowHttp: false,
  allowedHosts: [],
};

describe('address classification', () => {
  it.each([
    ['8.8.8.8', 'public'],
    ['1.1.1.1', 'public'],
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback'],
    ['0.0.0.0', 'unspecified'],
    ['10.0.0.5', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.254', 'private'],
    ['172.32.0.1', 'public'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'private'],
    ['169.254.1.1', 'link_local'],
    ['169.254.169.254', 'metadata'],
    ['169.254.170.2', 'metadata'],
    ['100.100.100.200', 'metadata'],
    ['192.0.0.192', 'metadata'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['198.18.0.1', 'reserved'],
  ])('classifies IPv4 %s as %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['2606:4700:4700::1111', 'public'],
    ['fd00::1', 'private'],
    ['fc00::1', 'private'],
    ['fe80::1', 'link_local'],
    ['ff02::1', 'multicast'],
    ['fd00:ec2::254', 'metadata'],
  ])('classifies IPv6 %s as %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  // The classic bypass: an IPv4-mapped IPv6 literal hiding a loopback or metadata address.
  it.each([
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:169.254.169.254', 'metadata'],
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:8.8.8.8', 'public'],
    ['2002:7f00:0001::', 'loopback'],
    ['2002:a9fe:a9fe::', 'metadata'],
    ['64:ff9b::7f00:1', 'loopback'],
  ])('sees through the %s encoding and classifies it as %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it('treats unparsable input as reserved rather than public', () => {
    expect(classifyAddress('not-an-address')).toBe('reserved');
    expect(classifyAddress('999.1.1.1')).toBe('reserved');
    expect(classifyAddress('')).toBe('reserved');
  });
});

describe('address policy', () => {
  it('blocks loopback, private, link-local and metadata by default', () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.1.1', '169.254.169.254', '::1']) {
      expect(isAddressAllowed(address, denyAll).allowed).toBe(false);
    }
    expect(isAddressAllowed('8.8.8.8', denyAll).allowed).toBe(true);
  });

  it('permits loopback and private addresses only when explicitly configured', () => {
    expect(isAddressAllowed('127.0.0.1', { ...denyAll, allowLoopback: true }).allowed).toBe(true);
    expect(isAddressAllowed('10.0.0.1', { ...denyAll, allowLoopback: true }).allowed).toBe(false);
    expect(isAddressAllowed('10.0.0.1', { ...denyAll, allowPrivateAddresses: true }).allowed).toBe(
      true,
    );
  });

  // SPEC.md §12 lists metadata services without a permitting flag; no combination enables them.
  it('never permits a metadata address, whatever the configuration', () => {
    const permissive: NetworkPolicyOptions = {
      allowPrivateAddresses: true,
      allowLoopback: true,
      allowHttp: true,
      allowedHosts: [],
    };
    for (const address of [
      '169.254.169.254',
      '::ffff:169.254.169.254',
      'fd00:ec2::254',
      '100.100.100.200',
    ]) {
      const decision = isAddressAllowed(address, permissive);
      expect(decision.allowed, address).toBe(false);
      expect(decision.category).toBe('metadata');
    }
  });
});

describe('host allowlist', () => {
  it('allows everything when the list is empty', () => {
    expect(isHostAllowed('anything.example.com', denyAll)).toBe(true);
  });

  it('restricts to listed hosts when configured', () => {
    const policy = { ...denyAll, allowedHosts: ['api.stripe.com', '*.example.com'] };
    expect(isHostAllowed('api.stripe.com', policy)).toBe(true);
    expect(isHostAllowed('API.STRIPE.COM', policy)).toBe(true);
    expect(isHostAllowed('a.example.com', policy)).toBe(true);
    expect(isHostAllowed('example.com', policy)).toBe(true);
    expect(isHostAllowed('evil.com', policy)).toBe(false);
    expect(isHostAllowed('api.stripe.com.evil.com', policy)).toBe(false);
  });

  it('does not let a wildcard match a sibling suffix', () => {
    expect(hostMatches('notexample.com', '*.example.com')).toBe(false);
    expect(hostMatches('a.b.example.com', '*.example.com')).toBe(true);
  });
});

describe('pinned DNS lookup (docs/DEVIATIONS.md D7)', () => {
  it('answers in both shapes net.connect may ask for', async () => {
    const { createPinnedLookup } = await import('../../src/net/safe-fetch.js');
    const lookup = createPinnedLookup([{ address: '93.184.216.34', family: 4 }]);

    // Happy-eyeballs form: net.connect passes all:true and expects an array. Answering
    // with the scalar form here fails the connection with ERR_INVALID_IP_ADDRESS.
    let all: unknown;
    lookup('example.com', { all: true }, (_err, value) => (all = value));
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }]);

    // Classic form.
    let address: unknown;
    let family: unknown;
    lookup('example.com', {}, (_err, value, fam) => {
      address = value;
      family = fam;
    });
    expect(address).toBe('93.184.216.34');
    expect(family).toBe(4);
  });

  it('returns every validated address so IPv6/IPv4 fallback still works', async () => {
    const { createPinnedLookup } = await import('../../src/net/safe-fetch.js');
    const lookup = createPinnedLookup([
      { address: '::1', family: 6 },
      { address: '127.0.0.1', family: 4 },
    ]);
    let all: unknown;
    lookup('localhost', { all: true }, (_err, value) => (all = value));
    // Pinning to only the first address would strand a host whose AAAA record is
    // unroutable, which is common on IPv4-only networks.
    expect(all).toEqual([
      { address: '::1', family: 6 },
      { address: '127.0.0.1', family: 4 },
    ]);
  });

  it('ignores the hostname it is handed and always returns the validated address', async () => {
    const { createPinnedLookup } = await import('../../src/net/safe-fetch.js');
    const lookup = createPinnedLookup([{ address: '10.1.2.3', family: 4 }]);
    let result: unknown;
    // Even if something later in the stack re-resolves a different name, the socket can
    // only go to the address that was validated.
    lookup('attacker-controlled.example.com', { all: true }, (_err, value) => (result = value));
    expect(result).toEqual([{ address: '10.1.2.3', family: 4 }]);
  });
});
