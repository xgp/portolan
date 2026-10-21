/**
 * Enriching registered APIs with a local coding agent (docs/DEVIATIONS.md D24).
 *
 * After an import commits, the API is queued. One job runs at a time: it starts an
 * agent, asks it to describe the operations that have no enrichment yet — least
 * documented first, at most `max_operations_per_api` — in batches, then asks for a
 * description of the API as a whole, and rebuilds the search index so the new text is
 * searchable. Nothing here can fail an import or a tool call; failures are logged.
 *
 * What the agent writes is stored beside the document, never in it: the specification
 * stays authoritative (SPEC.md §3.3) and its hash, versions and corrections are
 * unaffected.
 */
import type { PortolanConfig } from '../config/schema.js';
import { secretEnvNames } from '../config/config.js';
import type { Logger } from '../logging.js';
import type { EnrichmentSummary } from '../services/types.js';
import { transaction, type Database } from '../storage/database.js';
import { ApiRepository } from '../storage/repositories/apis.js';
import { EnrichmentRepository, operationContentHash } from '../storage/repositories/enrichments.js';
import { OperationRepository } from '../storage/repositories/operations.js';
import { SearchIndexRepository } from '../storage/repositories/search-index.js';
import type { OperationRecord } from '../storage/repositories/types.js';
import {
  AcpAgent,
  ADAPTERS,
  AgentError,
  findExecutable,
  type AgentName,
  type AgentSpec,
} from './acp-agent.js';
import {
  apiPrompt,
  briefApi,
  briefOperation,
  operationsPrompt,
  parseApiReply,
  parseOperationsReply,
} from './prompts.js';

export interface EnrichmentRun {
  api_id: string;
  agent: AgentName | null;
  operations_enriched: number;
  operations_pending: number;
  api_enriched: boolean;
  findings: number;
  failed_batches: number;
  errors: string[];
}

export interface EnricherOptions {
  db: Database;
  config: PortolanConfig;
  logger: Logger;
}

/** How long an agent that failed to start or authenticate is skipped. */
const RETRY_UNAVAILABLE_MS = 15 * 60 * 1000;

const AGENT_ORDER: readonly AgentName[] = ['claude', 'codex'];

export class Enricher {
  private readonly apis: ApiRepository;
  private readonly operations: OperationRepository;
  private readonly enrichments: EnrichmentRepository;
  private readonly index: SearchIndexRepository;
  private readonly settings: PortolanConfig['enrichment'];
  private readonly secretEnv: ReadonlySet<string>;
  private readonly unavailable = new Map<AgentName, { reason: string; until: number }>();
  private readonly queue = new Set<string>();
  private worker: Promise<void> | null = null;
  private current: AcpAgent | null = null;
  private closed = false;
  /** Jobs run one at a time, whether queued or called directly. */
  private exclusive: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: EnricherOptions) {
    this.apis = new ApiRepository(options.db);
    this.operations = new OperationRepository(options.db);
    this.enrichments = new EnrichmentRepository(options.db);
    this.index = new SearchIndexRepository(options.db);
    this.settings = options.config.enrichment;
    this.secretEnv = secretEnvNames(options.config);
  }

  get enabled(): boolean {
    return this.settings.agent !== 'off';
  }

  /** Agents the configuration allows, in the order they are tried. */
  private get agentNames(): readonly AgentName[] {
    const choice = this.settings.agent;
    return choice === 'off' ? [] : choice === 'auto' ? AGENT_ORDER : [choice];
  }

  /** Agents that are configured and installed, in the order they would be tried. */
  candidates(): AgentSpec[] {
    return this.agentNames.flatMap((name): AgentSpec[] => {
      const configured = { name, ...this.settings.agents[name] };
      if (findExecutable(configured.command)) return [configured];
      // The adapter is not installed, but the agent is: run the pinned adapter with npx.
      const adapter = ADAPTERS[name];
      if (
        this.settings.npx_fallback &&
        configured.command === adapter.command &&
        findExecutable(adapter.cli) &&
        findExecutable('npx')
      ) {
        return [
          { ...configured, command: 'npx', args: ['-y', adapter.package, ...configured.args] },
        ];
      }
      return [];
    });
  }

  /** Queue `apiId` and return at once; the work happens in the background. */
  schedule(apiId: string): EnrichmentSummary {
    if (!this.enabled) return { status: 'disabled' };
    const pending = this.pendingWork(apiId);
    if (pending.operations.length === 0 && !pending.api) return { status: 'up_to_date' };
    const candidates = this.usableCandidates();
    if (candidates.length === 0) {
      return {
        status: 'unavailable',
        message: this.unavailableMessage(),
      };
    }
    this.queue.add(apiId);
    this.kick();
    return { status: 'queued', agent: candidates[0]!.name, pending: pending.operations.length };
  }

  /** Queue every API that has work outstanding, e.g. at startup. */
  scheduleAll(): void {
    if (!this.enabled || this.usableCandidates().length === 0) return;
    for (const api of this.apis.list()) {
      const pending = this.pendingWork(api.id);
      if (pending.operations.length > 0 || pending.api) this.queue.add(api.id);
    }
    this.kick();
  }

  /** Resolves once the queue is empty. */
  async idle(): Promise<void> {
    while (this.worker) await this.worker;
  }

  /** Stop: the running agent is killed and queued work is dropped. */
  close(): void {
    this.closed = true;
    this.queue.clear();
    this.current?.close();
  }

  /** Enrich one API now — after any job already running — and report what happened. */
  enrich(apiId: string): Promise<EnrichmentRun> {
    const job = this.exclusive.then(() => this.runJob(apiId));
    this.exclusive = job.catch(() => undefined);
    return job;
  }

  private async runJob(apiId: string): Promise<EnrichmentRun> {
    const run: EnrichmentRun = {
      api_id: apiId,
      agent: null,
      operations_enriched: 0,
      operations_pending: 0,
      api_enriched: false,
      findings: 0,
      failed_batches: 0,
      errors: [],
    };
    const pending = this.pendingWork(apiId);
    run.operations_pending = pending.operations.length;
    if (pending.operations.length === 0 && !pending.api) return run;
    const api = this.apis.get(apiId)!;
    const version = this.apis.getCurrentVersion(apiId)!;
    const document: unknown = JSON.parse(version.specJson);

    let agent = await this.acquire(run);
    try {
      let i = 0;
      while (agent && i < pending.operations.length && !this.closed) {
        const batch = pending.operations.slice(i, i + this.settings.batch_size);
        const briefs = batch.map((op) => briefOperation(op, document));
        try {
          const reply = await agent.prompt(operationsPrompt(api.name, briefs));
          const parsed = parseOperationsReply(reply, briefs);
          if (this.closed) break;
          for (const op of batch) {
            const payload = parsed.get(op.canonicalId);
            if (!payload) continue;
            this.enrichments.upsert({
              apiId,
              target: 'operation',
              contentHash: operationContentHash(op.operationJson),
              canonicalId: op.canonicalId,
              payloadJson: JSON.stringify(payload),
              agent: agent.spec.name,
            });
            run.operations_enriched += 1;
            run.findings += payload.findings?.length ?? 0;
          }
          if (parsed.size === 0) {
            run.failed_batches += 1;
            run.errors.push(`${agent.spec.name}: reply was not usable JSON`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (error instanceof AgentError && error.reason === 'unauthenticated') {
            // Not logged in shows up on the first prompt, not at start-up. Fall back to
            // the next agent and retry the same batch.
            this.markUnavailable(agent.spec.name, message, run);
            agent.close();
            agent = await this.acquire(run);
            continue;
          }
          run.failed_batches += 1;
          run.errors.push(`${agent.spec.name}: ${message}`);
          if (error instanceof AgentError && error.reason !== 'failed') {
            agent.close();
            agent = null;
            break;
          }
        }
        i += this.settings.batch_size;
      }

      if (agent && pending.api && !this.closed) {
        try {
          const reply = await agent.prompt(
            apiPrompt(
              briefApi(
                api.name,
                api.description ?? version.infoDescription,
                api.tags,
                this.operations.listForVersion(version.id),
              ),
            ),
          );
          const payload = parseApiReply(reply);
          if (payload && !this.closed) {
            this.enrichments.upsert({
              apiId,
              target: 'api',
              contentHash: version.specHash,
              canonicalId: null,
              payloadJson: JSON.stringify(payload),
              agent: agent.spec.name,
            });
            run.api_enriched = true;
          }
        } catch (error) {
          run.errors.push(
            `${agent.spec.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } finally {
      agent?.close();
      this.current = null;
    }

    if (!this.closed && (run.operations_enriched > 0 || run.api_enriched)) this.reindex(apiId);
    run.operations_pending = this.closed
      ? run.operations_pending
      : this.pendingWork(apiId).operations.length;
    return run;
  }

  /** What the agent would be asked about for the API's current version. */
  pendingWork(apiId: string): { operations: OperationRecord[]; api: boolean } {
    const api = this.apis.get(apiId);
    const version = api ? this.apis.getCurrentVersion(apiId) : null;
    if (!api || !version) return { operations: [], api: false };
    const done = this.enrichments.mapForApi(apiId, 'operation');
    const operations = selectOperations(
      this.operations.listForVersion(version.id),
      this.settings.max_operations_per_api,
    ).filter((op) => !done.has(operationContentHash(op.operationJson)));
    return { operations, api: !this.enrichments.get(apiId, 'api', version.specHash) };
  }

  private kick(): void {
    if (this.worker || this.closed) return;
    this.worker = (async () => {
      while (!this.closed && this.queue.size > 0) {
        const apiId = this.queue.values().next().value!;
        this.queue.delete(apiId);
        try {
          const run = await this.enrich(apiId);
          this.options.logger.info({ ...run, errors: run.errors.slice(0, 3) }, 'enriched api');
        } catch (error) {
          this.options.logger.warn(
            { api_id: apiId, err: error instanceof Error ? error.message : String(error) },
            'enrichment failed',
          );
        }
      }
    })().finally(() => {
      this.worker = null;
    });
  }

  /** Start the first candidate that works, remembering the ones that did not. */
  private async acquire(run: EnrichmentRun): Promise<AcpAgent | null> {
    for (const spec of this.usableCandidates()) {
      try {
        const agent = await AcpAgent.start(spec, {
          logger: this.options.logger,
          secretEnv: this.secretEnv,
          promptTimeoutMs: this.settings.prompt_timeout_ms,
          model: this.settings.model,
        });
        if (this.closed) {
          agent.close();
          return null;
        }
        this.current = agent;
        run.agent = spec.name;
        return agent;
      } catch (error) {
        this.markUnavailable(
          spec.name,
          error instanceof Error ? error.message : String(error),
          run,
        );
      }
    }
    return null;
  }

  private markUnavailable(name: AgentName, reason: string, run: EnrichmentRun): void {
    this.unavailable.set(name, { reason, until: Date.now() + RETRY_UNAVAILABLE_MS });
    run.errors.push(`${name}: ${reason}`);
    this.options.logger.warn({ agent: name, reason }, 'enrichment agent unavailable');
  }

  private usableCandidates(): AgentSpec[] {
    const now = Date.now();
    return this.candidates().filter((spec) => (this.unavailable.get(spec.name)?.until ?? 0) <= now);
  }

  private unavailableMessage(): string {
    const failed = [...this.unavailable.entries()].map(
      ([name, { reason }]) => `${name}: ${reason}`,
    );
    if (failed.length > 0) return failed.join('; ');
    return `No ACP adapter found on PATH (${this.agentNames
      .map((name) => this.settings.agents[name].command)
      .join(', ')}), and no agent CLI to run one for with npx.`;
  }

  private reindex(apiId: string): void {
    transaction(this.options.db, () => {
      const api = this.apis.get(apiId);
      const version = api ? this.apis.getCurrentVersion(apiId) : null;
      if (!api || !version) return;
      this.index.reindexApi({ api, version });
      this.index.reindexOperations(apiId, this.operations.listForVersion(version.id));
    });
  }
}

/**
 * The operations most in need of a description, up to `limit`: none at all first, then
 * the shortest, in path order within each.
 */
export function selectOperations(
  operations: readonly OperationRecord[],
  limit: number,
): OperationRecord[] {
  const documentation = (op: OperationRecord) =>
    (op.description?.trim().length ?? 0) + (op.summary?.trim().length ?? 0);
  return [...operations]
    .sort(
      (a, b) =>
        documentation(a) - documentation(b) ||
        a.path.localeCompare(b.path) ||
        a.method.localeCompare(b.method),
    )
    .slice(0, limit);
}
