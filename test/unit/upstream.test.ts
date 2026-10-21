/** Upstream repository detection and issue composition (docs/DEVIATIONS.md D22). */
import { describe, expect, it } from 'vitest';
import {
  composeIssue,
  detectRepository,
  draftIssueUrl,
  repositoryFromUrl,
} from '../../src/feedback/upstream.js';

describe('repositoryFromUrl', () => {
  it('recognises GitHub file, raw and repository URLs', () => {
    expect(repositoryFromUrl('https://raw.githubusercontent.com/acme/api/main/openapi.yaml')).toBe(
      'acme/api',
    );
    expect(repositoryFromUrl('https://github.com/acme/api/blob/main/spec/openapi.json')).toBe(
      'acme/api',
    );
    expect(repositoryFromUrl('https://github.com/acme/api.git')).toBe('acme/api');
  });

  it('ignores other hosts, site sections and plain http', () => {
    expect(repositoryFromUrl('https://example.com/acme/api/openapi.yaml')).toBeUndefined();
    expect(repositoryFromUrl('https://github.com/orgs/acme')).toBeUndefined();
    expect(repositoryFromUrl('https://github.com/acme')).toBeUndefined();
    expect(repositoryFromUrl('http://github.com/acme/api')).toBeUndefined();
    expect(repositoryFromUrl('not a url')).toBeUndefined();
  });

  it('recognises a configured GitHub Enterprise host', () => {
    expect(
      repositoryFromUrl(
        'https://git.corp.example/team/svc/raw/main/a.yaml',
        'https://git.corp.example',
      ),
    ).toBe('team/svc');
  });
});

describe('detectRepository', () => {
  const document = { info: { contact: { url: 'https://github.com/meta/repo' } } };
  const base = {
    configured: undefined,
    requested: undefined,
    sourceUri: null,
    document,
    webUrl: 'https://github.com',
  };

  it('prefers configuration, then add_api, then the spec URL, then document metadata', () => {
    expect(
      detectRepository({
        ...base,
        configured: 'cfg/repo',
        requested: 'agent/repo',
        sourceUri: 'https://raw.githubusercontent.com/src/repo/main/a.yaml',
      }),
    ).toEqual({ repo: 'cfg/repo', source: 'config' });
    expect(
      detectRepository({
        ...base,
        requested: 'agent/repo',
        sourceUri: 'https://raw.githubusercontent.com/src/repo/main/a.yaml',
      }),
    ).toEqual({ repo: 'agent/repo', source: 'add_api' });
    expect(
      detectRepository({
        ...base,
        sourceUri: 'https://raw.githubusercontent.com/src/repo/main/a.yaml',
      }),
    ).toEqual({ repo: 'src/repo', source: 'spec_url' });
    expect(detectRepository(base)).toEqual({ repo: 'meta/repo', source: 'spec_metadata' });
  });

  it('reads x-origin, as recorded by API aggregators', () => {
    expect(
      detectRepository({
        ...base,
        document: {
          info: { 'x-origin': [{ url: 'https://raw.githubusercontent.com/o/r/HEAD/x.json' }] },
        },
      }),
    ).toEqual({ repo: 'o/r', source: 'spec_metadata' });
  });

  it('returns undefined when nothing points at a repository', () => {
    expect(detectRepository({ ...base, document: {} })).toBeUndefined();
  });
});

describe('composeIssue', () => {
  it('includes the description, the patch, the source and a searchable fingerprint', () => {
    const draft = composeIssue({
      apiName: 'Acme',
      sourceUri: 'https://raw.githubusercontent.com/acme/api/main/openapi.yaml',
      infoVersion: '2.1',
      origin: 'agent',
      fingerprint: 'abcdef0123456789',
      findings: [
        {
          title: 'GET /users omits the limit parameter',
          description: 'The API accepts ?limit=N.',
          patch: [{ op: 'add', path: '/paths/~1users/get/parameters/-', value: { name: 'limit' } }],
        },
      ],
    });
    expect(draft.title).toBe('OpenAPI document: GET /users omits the limit parameter');
    expect(draft.body).toContain('The API accepts ?limit=N.');
    expect(draft.body).toContain('"/paths/~1users/get/parameters/-"');
    expect(draft.body).toContain('openapi.yaml');
    expect(draft.body).toContain('(info.version 2.1)');
    expect(draft.body).toContain('Portolan fingerprint: `abcdef0123456789`');
  });

  it('summarises many findings in one issue', () => {
    const findings = Array.from({ length: 60 }, (_, i) => ({ title: `problem ${i}` }));
    const draft = composeIssue({
      apiName: 'Acme',
      sourceUri: null,
      infoVersion: null,
      origin: 'portolan',
      fingerprint: 'f',
      findings,
    });
    expect(draft.title).toBe('OpenAPI document: 60 structural problems');
    expect(draft.body).toContain('- problem 49');
    expect(draft.body).not.toContain('- problem 50');
    expect(draft.body).toContain('…and 10 more');
  });
});

describe('draftIssueUrl', () => {
  it('builds a prefilled new-issue link short enough to open', () => {
    const url = draftIssueUrl('https://github.com', 'acme/api', {
      title: 'A title',
      body: 'x'.repeat(50_000),
      fingerprint: 'f',
    });
    expect(url.startsWith('https://github.com/acme/api/issues/new?title=A%20title&body=')).toBe(
      true,
    );
    expect(url.length).toBeLessThanOrEqual(4000);
  });
});
