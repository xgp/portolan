/**
 * Raising specification flaws with the project that publishes the document
 * (docs/DEVIATIONS.md D22).
 *
 * Portolan corrects its own copy of a document either way; this module decides where the
 * flaw should be reported and, when an operator has allowed it, reports it. Every
 * outbound request goes through {@link safeFetch}, so the network policy and
 * `allowed_hosts` apply to GitHub exactly as to any other destination.
 */
import type { PortolanConfig } from '../config/schema.js';
import type { Logger } from '../logging.js';
import type { NetworkPolicyOptions } from '../net/address-policy.js';
import { safeFetch } from '../net/safe-fetch.js';
import { isRecord, type OpenApiDocument } from '../openapi/types.js';
import type { UpstreamIssueStatus } from '../storage/repositories/types.js';

/**
 * Where the repository came from. Only `config` and `spec_url` are trusted to receive an
 * issue filed with the operator's token: the others are claims made by an agent or by the
 * document's own content, so they get a draft link instead (the D5 reasoning, applied to
 * a GitHub token rather than an API credential).
 */
export type RepositorySource = 'config' | 'spec_url' | 'add_api' | 'spec_metadata';

export interface UpstreamRepository {
  repo: string;
  source: RepositorySource;
}

const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*)\/[A-Za-z0-9._-]+$/;

/** GitHub URL segments that look like an owner but are site sections. */
const RESERVED_OWNERS = new Set([
  'about',
  'apps',
  'collections',
  'enterprise',
  'explore',
  'features',
  'login',
  'marketplace',
  'orgs',
  'pricing',
  'settings',
  'sponsors',
  'topics',
]);

export function isRepositoryName(value: string): boolean {
  return REPO_PATTERN.test(value);
}

/** `owner/name` for a URL on GitHub (or the configured GitHub Enterprise host), if any. */
export function repositoryFromUrl(raw: string, webUrl = 'https://github.com'): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  const host = url.hostname.toLowerCase();
  const webHost = new URL(webUrl).hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);
  const isRaw = host === 'raw.githubusercontent.com';
  if (!isRaw && host !== webHost && host !== 'github.com' && host !== 'www.github.com') {
    return undefined;
  }
  const [owner, name] = segments;
  if (!owner || !name || (!isRaw && RESERVED_OWNERS.has(owner.toLowerCase()))) return undefined;
  const repo = `${owner}/${name.replace(/\.git$/, '')}`;
  return isRepositoryName(repo) ? repo : undefined;
}

/** Links a document gives for its own home: `info.contact.url`, `externalDocs`, `x-origin`. */
function metadataUrls(document: OpenApiDocument): string[] {
  const urls: string[] = [];
  const info = isRecord(document.info) ? document.info : {};
  if (isRecord(info.contact) && typeof info.contact.url === 'string') urls.push(info.contact.url);
  if (isRecord(document.externalDocs) && typeof document.externalDocs.url === 'string') {
    urls.push(document.externalDocs.url);
  }
  // APIs.guru and similar aggregators record where they took a document from.
  const origins = Array.isArray(info['x-origin']) ? info['x-origin'] : [];
  for (const origin of origins) {
    if (isRecord(origin) && typeof origin.url === 'string') urls.push(origin.url);
  }
  return urls;
}

export function detectRepository(input: {
  configured: string | undefined;
  requested: string | null | undefined;
  sourceUri: string | null;
  document: OpenApiDocument;
  webUrl: string;
}): UpstreamRepository | undefined {
  if (input.configured) return { repo: input.configured, source: 'config' };
  if (input.requested) return { repo: input.requested, source: 'add_api' };
  const fromSource = input.sourceUri ? repositoryFromUrl(input.sourceUri, input.webUrl) : undefined;
  if (fromSource) return { repo: fromSource, source: 'spec_url' };
  for (const url of metadataUrls(input.document)) {
    const repo = repositoryFromUrl(url, input.webUrl);
    if (repo) return { repo, source: 'spec_metadata' };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Issue content
// ---------------------------------------------------------------------------

export interface IssueFinding {
  title: string;
  description?: string | null;
  patch?: unknown[] | null;
}

export interface IssueDraft {
  title: string;
  body: string;
  /** Searched for before filing, so two installations do not report the same flaw twice. */
  fingerprint: string;
}

const MAX_LISTED_FINDINGS = 50;

export function composeIssue(input: {
  apiName: string;
  sourceUri: string | null;
  infoVersion: string | null;
  origin: 'portolan' | 'agent';
  findings: readonly IssueFinding[];
  fingerprint: string;
}): IssueDraft {
  const { findings } = input;
  const single = findings.length === 1 ? findings[0] : undefined;
  const title = single
    ? `OpenAPI document: ${single.title}`
    : `OpenAPI document: ${findings.length} structural problems`;

  const where = input.sourceUri
    ? `\`${input.sourceUri}\``
    : `the ${input.apiName} OpenAPI document`;
  const version = input.infoVersion ? ` (info.version ${input.infoVersion})` : '';
  const lines: string[] = [];

  if (single) {
    lines.push(`A problem was found in ${where}${version}.`, '');
    lines.push(`**${single.title}**`, '');
    if (single.description) lines.push(single.description, '');
  } else {
    lines.push(
      `${where}${version} has ${findings.length} problems that a strict OpenAPI validator rejects:`,
      '',
    );
    for (const finding of findings.slice(0, MAX_LISTED_FINDINGS)) lines.push(`- ${finding.title}`);
    if (findings.length > MAX_LISTED_FINDINGS) {
      lines.push(`- …and ${findings.length - MAX_LISTED_FINDINGS} more`);
    }
    lines.push('');
  }

  const patch = findings.flatMap((finding) => finding.patch ?? []);
  if (patch.length > 0) {
    lines.push(
      'Suggested fix, as an [RFC 6902](https://www.rfc-editor.org/rfc/rfc6902) JSON Patch against the document:',
      '',
      '```json',
      JSON.stringify(patch.slice(0, MAX_LISTED_FINDINGS * 2), null, 2),
      '```',
      '',
    );
  }

  const finder =
    input.origin === 'agent' ? 'an agent calling this API through' : 'the import validation in';
  lines.push(
    '---',
    `Found by ${finder} [Portolan](https://github.com/xgp/portolan), which has applied this ` +
      'correction to its local copy of the document. This issue was opened automatically.',
    '',
    `Portolan fingerprint: \`${input.fingerprint}\``,
  );

  return { title: truncate(title, 200), body: lines.join('\n'), fingerprint: input.fingerprint };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Long enough for a useful prefilled issue, short enough not to crowd an agent's context. */
const MAX_DRAFT_URL_LENGTH = 4000;

/** A prefilled "new issue" URL, truncating the body to stay under {@link MAX_DRAFT_URL_LENGTH}. */
export function draftIssueUrl(webUrl: string, repo: string, draft: IssueDraft): string {
  const base = `${webUrl.replace(/\/+$/, '')}/${repo}/issues/new`;
  let body = draft.body;
  for (;;) {
    const url = `${base}?title=${encodeURIComponent(draft.title)}&body=${encodeURIComponent(body)}`;
    if (url.length <= MAX_DRAFT_URL_LENGTH || body.length < 200) return url;
    body = `${body.slice(0, Math.floor(body.length * 0.8))}\n\n…(truncated)`;
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export interface UpstreamIssueOutcome {
  repo: string;
  status: UpstreamIssueStatus;
  url: string;
  title: string;
  /** Why an issue was not filed, when `status` is not `filed` or `existing`. */
  message?: string;
}

export interface UpstreamReporterOptions {
  config: PortolanConfig['feedback'];
  policy: NetworkPolicyOptions;
  timeoutMs: number;
  maxRedirects: number;
  logger: Logger;
  /** Issues filed against `repo` in the last 24 hours. */
  filedInLastDay: (repo: string) => number;
}

export class UpstreamReporter {
  constructor(private readonly options: UpstreamReporterOptions) {}

  get enabled(): boolean {
    return this.options.config.upstream_issues !== 'off';
  }

  async report(target: UpstreamRepository, draft: IssueDraft): Promise<UpstreamIssueOutcome> {
    const { config } = this.options;
    const draftUrl = draftIssueUrl(config.github.web_url, target.repo, draft);
    const asDraft = (status: UpstreamIssueStatus, message?: string): UpstreamIssueOutcome => ({
      repo: target.repo,
      status,
      url: draftUrl,
      title: draft.title,
      ...(message ? { message } : {}),
    });

    if (config.upstream_issues !== 'file') return asDraft('draft');
    if (target.source !== 'config' && target.source !== 'spec_url') {
      return asDraft(
        'draft',
        `The repository was taken from ${target.source === 'add_api' ? 'add_api' : "the document's own metadata"}, so Portolan did not file the issue itself. Add it under feedback.repositories in config.yaml to allow that.`,
      );
    }
    if (this.options.filedInLastDay(target.repo) >= config.github.max_issues_per_repo_per_day) {
      return asDraft(
        'rate_limited',
        `Portolan has already filed ${config.github.max_issues_per_repo_per_day} issues against ${target.repo} in the last 24 hours.`,
      );
    }
    const token = config.github.token_env ? process.env[config.github.token_env] : undefined;
    if (!token) {
      return asDraft('failed', `The environment variable ${config.github.token_env} is not set.`);
    }

    try {
      const existing = await this.findExisting(target.repo, draft.fingerprint, token);
      if (existing) {
        return { repo: target.repo, status: 'existing', url: existing, title: draft.title };
      }
      const created = await this.github('POST', `/repos/${target.repo}/issues`, token, {
        title: draft.title,
        body: draft.body,
      });
      const url = isRecord(created) && typeof created.html_url === 'string' ? created.html_url : '';
      this.options.logger.info({ repo: target.repo, url }, 'filed upstream specification issue');
      return { repo: target.repo, status: 'filed', url: url || draftUrl, title: draft.title };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger.warn({ repo: target.repo, error: message }, 'upstream issue not filed');
      return asDraft('failed', message);
    }
  }

  private async findExisting(repo: string, fingerprint: string, token: string) {
    const query = encodeURIComponent(`repo:${repo} is:issue in:body "${fingerprint}"`);
    const result = await this.github('GET', `/search/issues?q=${query}&per_page=1`, token);
    const items: unknown[] = isRecord(result) && Array.isArray(result.items) ? result.items : [];
    const first = items[0];
    return isRecord(first) && typeof first.html_url === 'string' ? first.html_url : undefined;
  }

  private async github(method: string, path: string, token: string, body?: unknown) {
    const { config, policy, timeoutMs, maxRedirects } = this.options;
    const response = await safeFetch(`${config.github.api_url.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'portolan',
        'x-github-api-version': '2022-11-28',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      timeoutMs,
      maxBytes: 1_048_576,
      maxRedirects,
      policy,
    });
    const text = response.body.toString('utf8');
    if (response.status < 200 || response.status >= 300) {
      let detail = '';
      try {
        const parsed: unknown = JSON.parse(text);
        if (isRecord(parsed) && typeof parsed.message === 'string') detail = `: ${parsed.message}`;
      } catch {
        // Not JSON; the status alone has to do.
      }
      throw new Error(
        `GitHub returned HTTP ${response.status} for ${method} ${path.split('?')[0]}${detail}`,
      );
    }
    return text ? (JSON.parse(text) as unknown) : undefined;
  }
}
