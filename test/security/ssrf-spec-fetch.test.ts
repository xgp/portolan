/**
 * SSRF tests for specification fetching and $ref resolution (SPEC.md §12, §45, §54).
 * Every case must fail closed.
 */
import { describe, expect, it } from 'vitest';
import { createTestCatalog, readSpec } from '../fixtures/helpers.js';
import { assertUrlAllowed, resolveAllowedAddress } from '../../src/net/safe-fetch.js';
import type { NetworkPolicyOptions } from '../../src/net/address-policy.js';

const defaultPolicy: NetworkPolicyOptions = {
  allowPrivateAddresses: false,
  allowLoopback: false,
  allowHttp: false,
  allowedHosts: [],
};

/** A catalog with Portolan's shipped defaults, not the permissive test settings. */
function strictCatalog() {
  return createTestCatalog({ network: {} });
}

describe('URL scheme restrictions (SPEC.md §12)', () => {
  it.each([
    'file:///etc/passwd',
    'file://localhost/etc/passwd',
    'ftp://example.com/spec.json',
    'data:application/json,{}',
    'gopher://example.com/',
    'jar:file:///etc/passwd!/',
    'ws://example.com/',
  ])('refuses to fetch %s', (url) => {
    expect(() => assertUrlAllowed(url, defaultPolicy)).toThrow(/not supported|not a valid/);
  });

  it('refuses plain http until it is explicitly enabled', () => {
    expect(() => assertUrlAllowed('http://example.com/s.json', defaultPolicy)).toThrow(/http:/);
    expect(() =>
      assertUrlAllowed('http://example.com/s.json', { ...defaultPolicy, allowHttp: true }),
    ).not.toThrow();
  });

  it('refuses a URL with embedded credentials', () => {
    expect(() => assertUrlAllowed('https://user:pass@example.com/s.json', defaultPolicy)).toThrow(
      /must not embed credentials/,
    );
  });

  it('enforces network.allowed_hosts', () => {
    const policy = { ...defaultPolicy, allowedHosts: ['specs.example.com'] };
    expect(() => assertUrlAllowed('https://specs.example.com/s.json', policy)).not.toThrow();
    expect(() => assertUrlAllowed('https://evil.example.com/s.json', policy)).toThrow(
      /not in network.allowed_hosts/,
    );
  });
});

describe('address restrictions (SPEC.md §12, §54)', () => {
  it.each([
    ['loopback', '127.0.0.1'],
    ['IPv6 loopback', '[::1]'],
    ['cloud metadata', '169.254.169.254'],
    ['AWS ECS metadata', '169.254.170.2'],
    ['link-local', '169.254.1.1'],
    ['private 10/8', '10.0.0.1'],
    ['private 192.168/16', '192.168.1.1'],
    ['IPv4-mapped loopback', '[::ffff:127.0.0.1]'],
    ['IPv4-mapped metadata', '[::ffff:169.254.169.254]'],
  ])('blocks a literal %s address', async (_label, host) => {
    await expect(
      resolveAllowedAddress(host.replace(/^\[|\]$/g, ''), defaultPolicy),
    ).rejects.toThrow(/blocked/);
  });

  it('blocks localhost by name', async () => {
    await expect(resolveAllowedAddress('localhost', defaultPolicy)).rejects.toThrow(/blocked/);
  });

  it('still blocks the metadata service when private addresses are permitted', async () => {
    const permissive: NetworkPolicyOptions = {
      allowPrivateAddresses: true,
      allowLoopback: true,
      allowHttp: true,
      allowedHosts: [],
    };
    await expect(resolveAllowedAddress('169.254.169.254', permissive)).rejects.toThrow(
      /metadata addresses are always blocked/,
    );
  });
});

describe('add_api never reads the filesystem (SPEC.md §11, §45)', () => {
  it('refuses a file: spec_url', async () => {
    const harness = strictCatalog();
    try {
      await expect(harness.catalog.addApi({ specUrl: 'file:///etc/passwd' })).rejects.toMatchObject(
        { code: 'NETWORK_DESTINATION_BLOCKED' },
      );
    } finally {
      harness.close();
    }
  });

  it('refuses a filesystem path presented as a spec_url', async () => {
    const harness = strictCatalog();
    try {
      await expect(harness.catalog.addApi({ specUrl: '/etc/passwd' })).rejects.toMatchObject({
        code: 'NETWORK_DESTINATION_BLOCKED',
      });
    } finally {
      harness.close();
    }
  });

  it('refuses a metadata-service spec_url', async () => {
    const harness = strictCatalog();
    try {
      await expect(
        harness.catalog.addApi({
          specUrl: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
        }),
      ).rejects.toMatchObject({ code: 'NETWORK_DESTINATION_BLOCKED' });
    } finally {
      harness.close();
    }
  });

  it('does not resolve a file: $ref inside an inline specification', async () => {
    const harness = strictCatalog();
    try {
      // The reference must not be readable; the import fails rather than inlining
      // /etc/passwd into the catalog.
      await expect(
        harness.catalog.addApi({ specContent: readSpec('file-ref.yaml') }),
      ).rejects.toMatchObject({ code: 'SPEC_INVALID' });
    } finally {
      harness.close();
    }
  });
});
