/**
 * Correcting specifications and raising flaws upstream (docs/DEVIATIONS.md D20–D22).
 *
 * The GitHub API is a local HTTP server recording what it receives, so the filing path
 * is exercised over real HTTP through the same SSRF-safe fetch used everywhere else.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { inspectOperations } from '../../src/catalog/inspector.js';
import { createTestCatalog, readSpec, type TestCatalog } from '../fixtures/helpers.js';

let harness: TestCatalog | undefined;

function catalog(overrides: Record<string, unknown> = {}) {
  harness = createTestCatalog(overrides);
  return harness.catalog;
}

afterEach(() => {
  harness?.close();
  harness = undefined;
});

/** A small valid document with one operation and a known query parameter set. */
function usersSpec(version = '1', extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Users', version },
    servers: [{ url: 'https://users.example.com' }],
    paths: {
      '/users': {
        get: {
          operationId: 'listUsers',
          parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
          responses: { '200': { description: 'OK' } },
          ...extra,
        },
      },
    },
  });
}

const ADD_LIMIT = [
  { op: 'test', path: '/paths/~1users/get/parameters/0/name', value: 'q' },
  {
    op: 'add',
    path: '/paths/~1users/get/parameters/-',
    value: { name: 'limit', in: 'query', schema: { type: 'integer' } },
  },
];
const LIMIT_ISSUE = {
  title: 'GET /users omits the limit query parameter',
  description: 'The API honours ?limit=N but the document does not declare it.',
};

function queryParameterNames(c: ReturnType<typeof catalog>, apiId = 'users'): string[] {
  const inspected = inspectOperations(c, apiId, ['listUsers']);
  return (inspected.operations[0]?.parameters.query ?? []).map((p) => p.name);
}

describe('automatic repairs (D21)', () => {
  it('imports a document the validator would reject, and lists what it repaired', async () => {
    const c = catalog();
    const result = await c.addApi({ specContent: readSpec('repairable.yaml') });
    expect(result.status).toBe('added');
    expect(result.api_version).toBe('unspecified');
    expect(result.corrections_total).toBe(6);
    expect(
      result.corrections?.every((x) => x.origin === 'portolan' && x.status === 'applied'),
    ).toBe(true);
    const inspected = inspectOperations(c, result.api_id, ['getUser']);
    expect(inspected.operations[0]?.parameters.path).toEqual([
      expect.objectContaining({ name: 'id', required: true }),
    ]);
  });

  it('does not report the same repairs again on an unchanged re-import', async () => {
    const c = catalog();
    await c.addApi({ specContent: readSpec('repairable.yaml'), upstreamRepo: 'acme/api' });
    const again = await c.addApi({ specContent: readSpec('repairable.yaml'), replace: true });
    expect(again.status).toBe('unchanged');
    expect(again.corrections).toBeUndefined();
    expect(again.upstream_issues).toBeUndefined();
  });

  it('marks a repair resolved once the upstream document no longer needs it', async () => {
    const c = catalog();
    await c.addApi({ specContent: readSpec('repairable.yaml'), apiId: 'r' });
    const fixed = readSpec('repairable.yaml').replace(
      'title: Repairable API',
      "title: Repairable API\n  version: '2'",
    );
    const result = await c.addApi({ specContent: fixed, apiId: 'r', replace: true });
    expect(result.corrections).toEqual([
      expect.objectContaining({ title: 'info.version is missing', status: 'resolved' }),
    ]);
  });
});

describe('agent corrections through add_api (D20)', () => {
  it('corrects the registered document in place, without a spec source', async () => {
    const c = catalog();
    await c.addApi({ specContent: usersSpec(), apiId: 'users', aliases: ['people'] });
    const before = c.getCurrentVersion('users').id;

    const result = await c.addApi({ apiId: 'users', issue: LIMIT_ISSUE, patches: ADD_LIMIT });
    expect(result.status).toBe('corrected');
    expect(result.corrections).toEqual([
      expect.objectContaining({ origin: 'agent', status: 'applied', title: LIMIT_ISSUE.title }),
    ]);
    expect(c.getCurrentVersion('users').id).not.toBe(before);
    expect(queryParameterNames(c)).toEqual(['q', 'limit']);
    // Library metadata supplied earlier is kept, not reset from info.title.
    expect(c.getApi('users').aliases).toEqual(['people']);
  });

  it('treats a resubmitted patch as the same correction, not a second one', async () => {
    const c = catalog();
    await c.addApi({ specContent: usersSpec(), apiId: 'users' });
    const first = await c.addApi({ apiId: 'users', issue: LIMIT_ISSUE, patches: ADD_LIMIT });
    const second = await c.addApi({ apiId: 'users', issue: LIMIT_ISSUE, patches: ADD_LIMIT });
    expect(second.status).toBe('unchanged');
    expect(second.corrections?.[0]?.id).toBe(first.corrections?.[0]?.id);
    expect(queryParameterNames(c)).toEqual(['q', 'limit']);
  });

  it('keeps a correction across a re-import of the same upstream document', async () => {
    const c = catalog();
    await c.addApi({ specContent: usersSpec(), apiId: 'users' });
    await c.addApi({ apiId: 'users', issue: LIMIT_ISSUE, patches: ADD_LIMIT });
    const reimport = await c.addApi({ specContent: usersSpec(), apiId: 'users', replace: true });
    expect(reimport.status).toBe('unchanged');
    expect(queryParameterNames(c)).toEqual(['q', 'limit']);
  });

  it('replays a correction onto a new upstream version it still fits', async () => {
    const c = catalog();
    await c.addApi({ specContent: usersSpec('1'), apiId: 'users' });
    await c.addApi({ apiId: 'users', issue: LIMIT_ISSUE, patches: ADD_LIMIT });
    const v2 = await c.addApi({ specContent: usersSpec('2'), apiId: 'users', replace: true });
    expect(v2.status).toBe('replaced');
    expect(v2.api_version).toBe('2');
    expect(queryParameterNames(c)).toEqual(['q', 'limit']);
  });

  it('marks a correction stale when the upstream document changes underneath it', async () => {
    const c = catalog();
    await c.addApi({ specContent: usersSpec('1'), apiId: 'users' });
    await c.addApi({ apiId: 'users', issue: LIMIT_ISSUE, patches: ADD_LIMIT });
    const upstreamFixed = usersSpec('2', {
      parameters: [
        { name: 'limit', in: 'query', schema: { type: 'integer' } },
        { name: 'q', in: 'query', schema: { type: 'string' } },
      ],
    });
    const result = await c.addApi({ specContent: upstreamFixed, apiId: 'users', replace: true });
    expect(result.corrections).toEqual([expect.objectContaining({ status: 'stale' })]);
    expect(result.warnings.join(' ')).toMatch(/no longer applies/);
    expect(queryParameterNames(c)).toEqual(['limit', 'q']);
  });

  it('reverts a correction, returning to the earlier version rather than duplicating it', async () => {
    const c = catalog();
    await c.addApi({ specContent: usersSpec(), apiId: 'users' });
    const original = c.getCurrentVersion('users').id;
    const added = await c.addApi({ apiId: 'users', issue: LIMIT_ISSUE, patches: ADD_LIMIT });
    const id = added.corrections![0]!.id;

    const reverted = await c.addApi({ apiId: 'users', revertCorrections: [id] });
    expect(reverted.status).toBe('corrected');
    expect(reverted.corrections).toEqual([expect.objectContaining({ id, status: 'reverted' })]);
    expect(c.getCurrentVersion('users').id).toBe(original);
    expect(queryParameterNames(c)).toEqual(['q']);

    // ...and a re-import does not bring it back.
    await c.addApi({ specContent: usersSpec('2'), apiId: 'users', replace: true });
    expect(queryParameterNames(c)).toEqual(['q']);
  });

  it('refuses a patch that does not apply, and changes nothing', async () => {
    const c = catalog();
    await c.addApi({ specContent: usersSpec(), apiId: 'users' });
    const before = c.getCurrentVersion('users').id;
    await expect(
      c.addApi({
        apiId: 'users',
        issue: LIMIT_ISSUE,
        patches: [{ op: 'replace', path: '/paths/users/get/summary', value: 'x' }],
      }),
    ).rejects.toMatchObject({ code: 'SPEC_PATCH_INVALID', message: /~1/ });
    expect(c.getCurrentVersion('users').id).toBe(before);
  });

  it('refuses a patch whose result is not a valid OpenAPI document', async () => {
    const c = catalog();
    await c.addApi({ specContent: usersSpec(), apiId: 'users' });
    await expect(
      c.addApi({
        apiId: 'users',
        issue: { title: 'break it' },
        patches: [{ op: 'remove', path: '/paths/~1users/get/responses/200/description' }],
      }),
    ).rejects.toMatchObject({ code: 'SPEC_PATCH_INVALID', message: /not a valid OpenAPI/ });
  });

  it('requires an issue with patches, and an api_id without a spec source', async () => {
    const c = catalog();
    await c.addApi({ specContent: usersSpec(), apiId: 'users' });
    await expect(c.addApi({ apiId: 'users', patches: ADD_LIMIT })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(c.addApi({ issue: LIMIT_ISSUE, patches: ADD_LIMIT })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(c.addApi({ apiId: 'nope', issue: LIMIT_ISSUE })).rejects.toMatchObject({
      code: 'API_NOT_FOUND',
    });
    await expect(c.addApi({ apiId: 'users', revertCorrections: ['c_nope'] })).rejects.toMatchObject(
      {
        code: 'INVALID_ARGUMENT',
      },
    );
  });

  it('records a flaw reported without a fix, leaving the document as it is', async () => {
    const c = catalog();
    await c.addApi({ specContent: usersSpec(), apiId: 'users' });
    const result = await c.addApi({
      apiId: 'users',
      issue: { title: 'GET /users returns 500 for an empty q', description: 'Seen repeatedly.' },
    });
    expect(result.status).toBe('unchanged');
    expect(result.corrections).toEqual([
      expect.objectContaining({ origin: 'agent', status: 'reported' }),
    ]);
  });
});

describe('upstream issues (D22)', () => {
  it('drafts a prefilled issue link by default when the repository is known', async () => {
    const c = catalog();
    await c.addApi({ specContent: usersSpec(), apiId: 'users' });
    const result = await c.addApi({
      apiId: 'users',
      issue: LIMIT_ISSUE,
      patches: ADD_LIMIT,
      upstreamRepo: 'acme/users-api',
    });
    expect(result.upstream_issues).toEqual([
      expect.objectContaining({
        repo: 'acme/users-api',
        status: 'draft',
        correction_ids: [result.corrections![0]!.id],
      }),
    ]);
    const url = new URL(result.upstream_issues![0]!.url);
    expect(url.origin + url.pathname).toBe('https://github.com/acme/users-api/issues/new');
    expect(url.searchParams.get('title')).toBe(`OpenAPI document: ${LIMIT_ISSUE.title}`);
    expect(url.searchParams.get('body')).toContain(LIMIT_ISSUE.description);
  });

  it('remembers upstream_repo for later corrections and repairs found before it was known', async () => {
    const c = catalog();
    const first = await c.addApi({ specContent: readSpec('repairable.yaml'), apiId: 'r' });
    expect(first.warnings.join(' ')).toMatch(/No upstream repository is known/);

    const later = await c.addApi({ apiId: 'r', upstreamRepo: 'acme/repairable' });
    expect(later.upstream_issues).toEqual([
      expect.objectContaining({ repo: 'acme/repairable', status: 'draft' }),
    ]);
    expect(later.upstream_issues![0]!.title).toBe('OpenAPI document: 6 structural problems');

    const correction = await c.addApi({ apiId: 'r', issue: { title: 'something else' } });
    expect(correction.upstream_issues?.[0]?.repo).toBe('acme/repairable');
  });

  it('does nothing upstream when feedback is off', async () => {
    const c = catalog({ feedback: { upstream_issues: 'off' } });
    await c.addApi({ specContent: usersSpec(), apiId: 'users' });
    const result = await c.addApi({
      apiId: 'users',
      issue: LIMIT_ISSUE,
      patches: ADD_LIMIT,
      upstreamRepo: 'acme/users-api',
    });
    expect(result.upstream_issues).toBeUndefined();
    expect(result.corrections).toHaveLength(1);
  });

  describe('filing on GitHub', () => {
    let server: Server;
    let apiUrl: string;
    const received: { method: string; url: string; auth: string; body: string }[] = [];
    let existingIssue: string | undefined;

    beforeAll(async () => {
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
        req.on('end', () => {
          received.push({
            method: req.method ?? '',
            url: req.url ?? '',
            auth: req.headers.authorization ?? '',
            body,
          });
          res.setHeader('content-type', 'application/json');
          if (req.url?.startsWith('/search/issues')) {
            const items = existingIssue ? [{ html_url: existingIssue }] : [];
            res.end(JSON.stringify({ total_count: items.length, items }));
          } else if (req.method === 'POST' && req.url === '/repos/acme/users-api/issues') {
            res.statusCode = 201;
            res.end(JSON.stringify({ html_url: 'https://github.com/acme/users-api/issues/7' }));
          } else {
            res.statusCode = 404;
            res.end(JSON.stringify({ message: 'Not Found' }));
          }
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      process.env.PORTOLAN_TEST_GITHUB_TOKEN = 'ghp_test_token';
    });

    afterAll(async () => {
      delete process.env.PORTOLAN_TEST_GITHUB_TOKEN;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    afterEach(() => {
      received.length = 0;
      existingIssue = undefined;
    });

    const filing = (extra: Record<string, unknown> = {}) => ({
      feedback: {
        upstream_issues: 'file',
        repositories: { users: 'acme/users-api' },
        github: { token_env: 'PORTOLAN_TEST_GITHUB_TOKEN', api_url: apiUrl, ...extra },
      },
    });

    it('files the issue with the configured token for a configured repository', async () => {
      const c = catalog(filing());
      await c.addApi({ specContent: usersSpec(), apiId: 'users' });
      const result = await c.addApi({ apiId: 'users', issue: LIMIT_ISSUE, patches: ADD_LIMIT });
      expect(result.upstream_issues).toEqual([
        expect.objectContaining({
          status: 'filed',
          url: 'https://github.com/acme/users-api/issues/7',
        }),
      ]);
      const post = received.find((r) => r.method === 'POST')!;
      expect(post.auth).toBe('Bearer ghp_test_token');
      const issue = JSON.parse(post.body) as { title: string; body: string };
      expect(issue.title).toBe(`OpenAPI document: ${LIMIT_ISSUE.title}`);
      expect(issue.body).toMatch(/Portolan fingerprint: `[0-9a-f]{16}`/);

      // Filed once: the same correction is not filed again.
      received.length = 0;
      await c.addApi({ apiId: 'users', issue: LIMIT_ISSUE, patches: ADD_LIMIT });
      expect(received).toEqual([]);
    });

    it('links an existing issue with the same fingerprint instead of filing a duplicate', async () => {
      existingIssue = 'https://github.com/acme/users-api/issues/3';
      const c = catalog(filing());
      await c.addApi({ specContent: usersSpec(), apiId: 'users' });
      const result = await c.addApi({ apiId: 'users', issue: LIMIT_ISSUE, patches: ADD_LIMIT });
      expect(result.upstream_issues?.[0]).toMatchObject({ status: 'existing', url: existingIssue });
      expect(received.some((r) => r.method === 'POST')).toBe(false);
    });

    it('only drafts for a repository an agent named, never files with the token', async () => {
      const c = catalog({
        feedback: {
          upstream_issues: 'file',
          github: { token_env: 'PORTOLAN_TEST_GITHUB_TOKEN', api_url: apiUrl },
        },
      });
      await c.addApi({ specContent: usersSpec(), apiId: 'users' });
      const result = await c.addApi({
        apiId: 'users',
        issue: LIMIT_ISSUE,
        patches: ADD_LIMIT,
        upstreamRepo: 'victim/unrelated',
      });
      expect(result.upstream_issues?.[0]).toMatchObject({
        status: 'draft',
        repo: 'victim/unrelated',
      });
      expect(result.upstream_issues?.[0]?.message).toMatch(/feedback\.repositories/);
      expect(received).toEqual([]);
    });

    it('stops filing at the daily cap and drafts instead', async () => {
      const c = catalog(filing({ max_issues_per_repo_per_day: 0 }));
      await c.addApi({ specContent: usersSpec(), apiId: 'users' });
      const result = await c.addApi({ apiId: 'users', issue: LIMIT_ISSUE, patches: ADD_LIMIT });
      expect(result.upstream_issues?.[0]?.status).toBe('rate_limited');
      expect(received).toEqual([]);
    });

    it('reports a GitHub failure without failing the correction', async () => {
      const c = catalog({
        feedback: {
          upstream_issues: 'file',
          repositories: { users: 'acme/missing' },
          github: { token_env: 'PORTOLAN_TEST_GITHUB_TOKEN', api_url: apiUrl },
        },
      });
      await c.addApi({ specContent: usersSpec(), apiId: 'users' });
      const result = await c.addApi({ apiId: 'users', issue: LIMIT_ISSUE, patches: ADD_LIMIT });
      expect(result.status).toBe('corrected');
      expect(result.upstream_issues?.[0]).toMatchObject({
        status: 'failed',
        message: expect.stringMatching(/HTTP 404/),
      });
      expect(result.upstream_issues?.[0]?.url).toMatch(
        /^https:\/\/github\.com\/acme\/missing\/issues\/new/,
      );
    });

    it('is subject to the network policy like any other destination', async () => {
      const c = catalog({
        ...filing(),
        network: { allow_loopback: false, allow_http: true },
      });
      await c.addApi({ specContent: usersSpec(), apiId: 'users' });
      const result = await c.addApi({ apiId: 'users', issue: LIMIT_ISSUE, patches: ADD_LIMIT });
      expect(result.upstream_issues?.[0]?.status).toBe('failed');
      expect(received).toEqual([]);
    });
  });
});
