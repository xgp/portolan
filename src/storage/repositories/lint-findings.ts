/** Persistence for `lint_findings` (docs/DEVIATIONS.md D23). */
import type { Database } from '../database.js';
import type { LintFindingRecord } from './types.js';

export class LintFindingRepository {
  constructor(private readonly db: Database) {}

  insertMany(apiVersionId: string, findings: readonly LintFindingRecord[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO lint_findings (api_version_id, rule, severity, pointer, message)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const f of findings) stmt.run(apiVersionId, f.rule, f.severity, f.pointer, f.message);
  }

  /** Every finding for a version, most severe first. */
  listForVersion(apiVersionId: string): LintFindingRecord[] {
    return this.db
      .prepare(
        `SELECT rule, severity, pointer, message FROM lint_findings WHERE api_version_id = ?
         ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warn' THEN 1 WHEN 'info' THEN 2 ELSE 3 END,
                  pointer, rule, rowid`,
      )
      .all(apiVersionId) as unknown as LintFindingRecord[];
  }

  /** Findings at or below `pointer` — the operation object and everything inside it. */
  listUnder(apiVersionId: string, pointer: string, limit: number): LintFindingRecord[] {
    return this.db
      .prepare(
        `SELECT rule, severity, pointer, message FROM lint_findings
         WHERE api_version_id = ? AND (pointer = ? OR substr(pointer, 1, ?) = ?)
         ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warn' THEN 1 WHEN 'info' THEN 2 ELSE 3 END,
                  pointer, rule, rowid
         LIMIT ?`,
      )
      .all(
        apiVersionId,
        pointer,
        pointer.length + 1,
        `${pointer}/`,
        limit,
      ) as unknown as LintFindingRecord[];
  }

  hasVersion(apiVersionId: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM lint_findings WHERE api_version_id = ? LIMIT 1')
        .get(apiVersionId) !== undefined
    );
  }
}
