/** Persistence for `spec_corrections` (docs/DEVIATIONS.md D20, D21). */
import type { Database } from '../database.js';
import { nowIso } from '../database.js';
import type { CorrectionRecord, CorrectionStatus, UpstreamIssueStatus } from './types.js';

type Row = Record<string, unknown>;

function toCorrection(row: Row): CorrectionRecord {
  return {
    id: row.id as string,
    apiId: row.api_id as string,
    origin: row.origin as CorrectionRecord['origin'],
    kind: row.kind as string,
    fingerprint: row.fingerprint as string,
    title: row.title as string,
    description: (row.description as string | null) ?? null,
    patchJson: (row.patch_json as string | null) ?? null,
    status: row.status as CorrectionStatus,
    upstreamRepo: (row.upstream_repo as string | null) ?? null,
    upstreamIssueUrl: (row.upstream_issue_url as string | null) ?? null,
    upstreamIssueStatus: (row.upstream_issue_status as UpstreamIssueStatus | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export class CorrectionRepository {
  constructor(private readonly db: Database) {}

  /** Every correction for an API, oldest first: the order agent patches are replayed in. */
  listForApi(apiId: string): CorrectionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM spec_corrections WHERE api_id = ? ORDER BY created_at, rowid')
      .all(apiId) as Row[];
    return rows.map(toCorrection);
  }

  get(apiId: string, id: string): CorrectionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM spec_corrections WHERE api_id = ? AND id = ?')
      .get(apiId, id) as Row | undefined;
    return row ? toCorrection(row) : null;
  }

  insert(
    record: Omit<
      CorrectionRecord,
      'createdAt' | 'updatedAt' | 'upstreamRepo' | 'upstreamIssueUrl' | 'upstreamIssueStatus'
    >,
  ): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO spec_corrections
           (id, api_id, origin, kind, fingerprint, title, description, patch_json, status,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.apiId,
        record.origin,
        record.kind,
        record.fingerprint,
        record.title,
        record.description,
        record.patchJson,
        record.status,
        now,
        now,
      );
  }

  setStatus(id: string, status: CorrectionStatus): void {
    this.db
      .prepare('UPDATE spec_corrections SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, nowIso(), id);
  }

  setUpstreamIssue(
    ids: readonly string[],
    issue: { repo: string; url: string | null; status: UpstreamIssueStatus },
  ): void {
    const stmt = this.db.prepare(
      `UPDATE spec_corrections
         SET upstream_repo = ?, upstream_issue_url = ?, upstream_issue_status = ?,
             upstream_issue_at = ?, updated_at = ?
       WHERE id = ?`,
    );
    const now = nowIso();
    for (const id of ids) stmt.run(issue.repo, issue.url, issue.status, now, now, id);
  }

  /** Issues Portolan itself filed against `repo` since `since`, for the daily cap. */
  countFiledSince(repo: string, since: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT upstream_issue_url) AS n FROM spec_corrections
         WHERE upstream_repo = ? AND upstream_issue_status = 'filed' AND upstream_issue_at >= ?`,
      )
      .get(repo, since) as { n: number };
    return row.n;
  }
}
