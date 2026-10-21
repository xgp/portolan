/**
 * `portolan enrich` (docs/DEVIATIONS.md D24).
 *
 * Runs enrichment in the foreground, for APIs registered before an agent was available or
 * for a catalog managed without a long-running server. `serve` does the same work in the
 * background.
 */
import { createPortolan } from '../app.js';
import { loadConfig } from '../config/config.js';
import type { EnrichmentRun } from '../enrichment/enricher.js';
import { PortolanError } from '../errors/errors.js';

export interface EnrichOptions {
  configPath?: string;
  apiIds: string[];
  /** Called with each API's outcome as soon as it is known. */
  onRun?: (run: EnrichmentRun) => void;
}

export async function runEnrich(options: EnrichOptions): Promise<EnrichmentRun[]> {
  const { config } = loadConfig(options.configPath);
  const app = createPortolan({ config });
  try {
    if (!app.enricher.enabled) {
      throw new PortolanError('CONFIG_INVALID', 'enrichment.agent is "off".');
    }
    if (app.enricher.candidates().length === 0) {
      throw new PortolanError(
        'CONFIG_INVALID',
        `No ACP adapter is installed for enrichment.agent "${config.enrichment.agent}". Install @agentclientprotocol/claude-agent-acp or @agentclientprotocol/codex-acp, or set enrichment.agents.<name>.command.`,
      );
    }
    const apiIds =
      options.apiIds.length > 0
        ? options.apiIds.map((id) => app.catalog.getApi(id).id)
        : app.catalog
            .listApis()
            .map((api) => api.id)
            .filter((id) => {
              const pending = app.enricher.pendingWork(id);
              return pending.operations.length > 0 || pending.api;
            });
    const runs: EnrichmentRun[] = [];
    for (const apiId of apiIds) {
      const run = await app.enricher.enrich(apiId);
      runs.push(run);
      options.onRun?.(run);
    }
    return runs;
  } finally {
    app.close();
  }
}

export function formatEnrichmentRun(run: EnrichmentRun): string {
  const parts = [
    `${run.api_id}: ${run.operations_enriched} operation(s) described`,
    run.agent ? `by ${run.agent}` : null,
    run.api_enriched ? 'and the API summarised' : null,
  ].filter(Boolean);
  const lines = [
    `${parts.join(' ')}; ${run.findings} finding(s); ${run.operations_pending} operation(s) still pending`,
  ];
  for (const error of run.errors.slice(0, 5)) lines.push(`  ! ${error}`);
  return lines.join('\n');
}
