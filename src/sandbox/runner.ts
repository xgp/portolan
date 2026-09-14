/**
 * The Deno sandbox runner (SPEC.md §31–§36, §54).
 *
 * Spawns a Deno process with every permission explicitly denied and talks to it over
 * stdin/stdout. The script's only capability is `api.call()`, which the parent performs
 * on its behalf — applying exactly the same policy, authentication and OpenAPI validation
 * as the `call_api` tool, because it is the same code path (SPEC.md §33).
 *
 * There is deliberately no in-process fallback. If Deno is unavailable, `run_api_code`
 * fails with SANDBOX_UNAVAILABLE; the alternative would be executing agent-supplied code
 * with `vm` or `eval` as the only boundary, which SPEC.md §34 forbids
 * (docs/DEVIATIONS.md D12).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Catalog } from '../catalog/catalog.js';
import type { PortolanConfig } from '../config/schema.js';
import { PortolanError, toErrorEnvelope } from '../errors/errors.js';
import type { Caller } from '../execution/caller.js';
import type { Logger } from '../logging.js';
import type { RequestContext, RunApiCodeInput, RunApiCodeResult } from '../services/types.js';
import { encodeMessage, MessageDecoder, type SandboxMessage } from './protocol.js';

/**
 * Every Deno permission, denied explicitly.
 *
 * Deno's permissions are already deny-by-default; naming each one means a future Deno
 * release that changes a default cannot silently widen the sandbox. `--no-prompt` turns
 * any permission request into an immediate throw rather than a hang waiting on a TTY.
 */
export const DENO_FLAGS = [
  'run',
  '--no-prompt',
  '--no-remote',
  '--cached-only',
  '--no-config',
  '--no-lock',
  '--quiet',
  '--deny-read',
  '--deny-write',
  '--deny-net',
  '--deny-env',
  '--deny-run',
  '--deny-ffi',
  '--deny-sys',
  '--deny-import',
] as const;

const RUNTIME_FILE = 'runtime.js';

function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** Locate the runtime script next to this module, in src/ or in dist/. */
export function runtimePath(): string {
  return join(moduleDir(), RUNTIME_FILE);
}

/** Find the Deno binary: explicit config, then PATH, then the usual install locations. */
export function findDeno(configuredPath?: string): string | null {
  const candidates: string[] = [];
  if (configuredPath) candidates.push(configuredPath);
  if (process.env.PORTOLAN_DENO_PATH) candidates.push(process.env.PORTOLAN_DENO_PATH);

  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir) candidates.push(join(dir, 'deno'));
  }
  candidates.push(
    join(homedir(), '.deno', 'bin', 'deno'),
    '/usr/local/bin/deno',
    '/usr/bin/deno',
    '/opt/homebrew/bin/deno',
  );

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

export interface SandboxRunnerOptions {
  config: PortolanConfig;
  logger: Logger;
  caller: Caller;
  catalog: Catalog;
}

interface SandboxLimits {
  timeoutMs: number;
  maxApiCalls: number;
  maxTotalResponseBytes: number;
  maxOutputBytes: number;
  maxLogEntries: number;
  maxLogBytes: number;
}

export class SandboxRunner {
  constructor(private readonly options: SandboxRunnerOptions) {}

  /** Whether a usable Deno runtime is present. Used by `portolan doctor`. */
  status(): {
    available: boolean;
    denoPath: string | null;
    runtime: string;
    runtimeExists: boolean;
  } {
    const denoPath = findDeno(this.options.config.sandbox.deno_path);
    const runtime = runtimePath();
    return {
      available: denoPath !== null && existsSync(runtime),
      denoPath,
      runtime,
      runtimeExists: existsSync(runtime),
    };
  }

  async run(input: RunApiCodeInput, context: RequestContext): Promise<RunApiCodeResult> {
    const { config, logger, caller, catalog } = this.options;
    const started = Date.now();

    // Fail before spawning anything if the API or environment is wrong.
    catalog.getApi(input.apiId);
    catalog.resolveEnvironment(input.apiId, input.environment);

    const limits = this.resolveLimits(input);

    if (Buffer.byteLength(input.code, 'utf8') > config.limits.sandbox_max_code_bytes) {
      throw new PortolanError(
        'INVALID_ARGUMENT',
        `The script is larger than the ${config.limits.sandbox_max_code_bytes}-byte limit.`,
        { limit: config.limits.sandbox_max_code_bytes },
      );
    }
    const serializedInput = JSON.stringify(input.input ?? null);
    if (Buffer.byteLength(serializedInput, 'utf8') > config.limits.sandbox_max_input_bytes) {
      throw new PortolanError(
        'INVALID_ARGUMENT',
        `The script input is larger than the ${config.limits.sandbox_max_input_bytes}-byte limit.`,
        { limit: config.limits.sandbox_max_input_bytes },
      );
    }

    const status = this.status();
    if (!status.denoPath) {
      throw new PortolanError(
        'SANDBOX_UNAVAILABLE',
        'run_api_code needs the Deno runtime, which was not found. Install Deno (https://deno.land) or set sandbox.deno_path in config.yaml. The other Portolan tools are unaffected; use call_api for individual requests.',
        { searched_path: true },
      );
    }
    if (!status.runtimeExists) {
      throw new PortolanError(
        'SANDBOX_UNAVAILABLE',
        `The sandbox runtime was not found at ${status.runtime}. Reinstall Portolan or re-run the build.`,
        { runtime: status.runtime },
      );
    }

    const child = spawn(status.denoPath, [...DENO_FLAGS, status.runtime], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // An empty environment: nothing about the host reaches the sandbox process, even
      // before Deno's own --deny-env takes effect.
      env: {},
      windowsHide: true,
    });

    const session = new SandboxSession({
      child,
      limits,
      apiId: input.apiId,
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      caller,
      context,
      logger,
    });

    try {
      const outcome = await session.run(input.code, input.input ?? null);
      const durationMs = Date.now() - started;
      logger.info(
        {
          request_id: context.requestId,
          api_id: input.apiId,
          api_calls: session.apiCalls,
          duration_ms: durationMs,
        },
        'sandbox run complete',
      );
      return {
        result: outcome,
        api_calls: session.apiCalls,
        duration_ms: durationMs,
        logs: session.logs,
      };
    } finally {
      session.terminate();
    }
  }

  private resolveLimits(input: RunApiCodeInput): SandboxLimits {
    const { limits } = this.options.config;
    return {
      timeoutMs: Math.min(
        input.timeoutMs ?? limits.sandbox_timeout_ms,
        limits.sandbox_max_timeout_ms,
      ),
      maxApiCalls: Math.min(
        input.maxApiCalls ?? limits.sandbox_max_api_calls,
        limits.sandbox_max_api_calls_hard,
      ),
      maxTotalResponseBytes: limits.sandbox_max_total_response_bytes,
      maxOutputBytes: limits.sandbox_max_output_bytes,
      maxLogEntries: limits.sandbox_max_log_entries,
      maxLogBytes: limits.sandbox_max_log_bytes,
    };
  }
}

interface SessionOptions {
  child: ChildProcessWithoutNullStreams;
  limits: SandboxLimits;
  apiId: string;
  environment?: string;
  caller: Caller;
  context: RequestContext;
  logger: Logger;
}

/** One sandbox process and the RPC conversation with it. */
class SandboxSession {
  readonly logs: string[] = [];
  apiCalls = 0;

  private readonly decoder = new MessageDecoder();
  private totalResponseBytes = 0;
  private settled = false;
  private timer: NodeJS.Timeout | undefined;
  private resolve!: (value: unknown) => void;
  private reject!: (error: unknown) => void;
  private stderr = '';

  constructor(private readonly options: SessionOptions) {}

  run(code: string, input: unknown): Promise<unknown> {
    const { child, limits } = this.options;

    const promise = new Promise<unknown>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });

    this.timer = setTimeout(() => {
      this.fail(
        new PortolanError(
          'SANDBOX_TIMEOUT',
          `The script did not finish within ${limits.timeoutMs}ms and was terminated.`,
          { timeout_ms: limits.timeoutMs, api_calls: this.apiCalls },
        ),
      );
    }, limits.timeoutMs);
    this.timer.unref?.();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      for (const message of this.decoder.push(chunk)) {
        void this.handle(message as SandboxMessage, code, input);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Bounded: a runaway sandbox must not be able to grow the parent's memory.
      if (this.stderr.length < 8192) this.stderr += chunk;
    });

    child.on('error', (error) => {
      this.fail(
        new PortolanError('SANDBOX_UNAVAILABLE', `Could not start the sandbox: ${error.message}`),
      );
    });

    child.on('exit', (code_, signal) => {
      if (this.settled) return;
      this.fail(
        new PortolanError(
          'SANDBOX_RUNTIME_ERROR',
          `The sandbox exited unexpectedly (code ${String(code_)}, signal ${String(signal)}).${
            this.stderr ? ` stderr: ${this.stderr.slice(0, 500)}` : ''
          }`,
          {},
        ),
      );
    });

    return promise;
  }

  private async handle(message: SandboxMessage, code: string, input: unknown): Promise<void> {
    if (this.settled) return;

    switch (message.type) {
      case 'ready':
        this.send({
          type: 'start',
          code,
          input,
          limits: {
            maxLogEntries: this.options.limits.maxLogEntries,
            maxLogBytes: this.options.limits.maxLogBytes,
            maxOutputBytes: this.options.limits.maxOutputBytes,
          },
        });
        return;

      case 'log':
        if (this.logs.length < this.options.limits.maxLogEntries) {
          this.logs.push(`[${message.level}] ${message.message}`);
        }
        return;

      case 'api_call':
        await this.performApiCall(message);
        return;

      case 'result':
        this.succeed(message.result);
        return;

      case 'error':
        this.fail(
          new PortolanError(
            message.name === 'OutputTooLarge'
              ? 'SANDBOX_OUTPUT_TOO_LARGE'
              : 'SANDBOX_RUNTIME_ERROR',
            message.message,
            { ...(message.name ? { error_name: message.name } : {}), api_calls: this.apiCalls },
          ),
        );
        return;
    }
  }

  private async performApiCall(
    message: Extract<SandboxMessage, { type: 'api_call' }>,
  ): Promise<void> {
    const { limits, caller, context, apiId, environment } = this.options;

    if (this.apiCalls >= limits.maxApiCalls) {
      this.fail(
        new PortolanError(
          'SANDBOX_CALL_LIMIT',
          `The script exceeded its limit of ${limits.maxApiCalls} API calls. Raise max_api_calls, or reduce the number of requests the script makes.`,
          { max_api_calls: limits.maxApiCalls },
        ),
      );
      return;
    }
    this.apiCalls += 1;

    try {
      const result = await caller.call(
        {
          apiId,
          operationId: message.request.operation_id,
          ...(environment !== undefined ? { environment } : {}),
          ...(message.request.parameters !== undefined
            ? { parameters: message.request.parameters }
            : {}),
          ...(message.request.body !== undefined ? { body: message.request.body } : {}),
          ...(message.request.content_type !== undefined
            ? { contentType: message.request.content_type }
            : {}),
        },
        context,
      );

      // SPEC.md §35: cap the cumulative bytes one script may pull.
      this.totalResponseBytes += Buffer.byteLength(
        JSON.stringify(result.response.body ?? ''),
        'utf8',
      );
      if (this.totalResponseBytes > limits.maxTotalResponseBytes) {
        this.fail(
          new PortolanError(
            'RESPONSE_TOO_LARGE',
            `The script has read ${this.totalResponseBytes} bytes of API responses, exceeding the ${limits.maxTotalResponseBytes}-byte cumulative limit.`,
            { limit: limits.maxTotalResponseBytes },
          ),
        );
        return;
      }

      this.send({ type: 'api_result', id: message.id, result });
    } catch (error) {
      // The script sees a structured error it can branch on; it never sees a stack trace
      // or anything credential-bearing.
      const envelope = toErrorEnvelope(error).error;
      this.send({
        type: 'api_error',
        id: message.id,
        error: { code: envelope.code, message: envelope.message, details: envelope.details },
      });
    }
  }

  private send(message: Parameters<typeof encodeMessage>[0]): void {
    if (this.settled) return;
    try {
      this.options.child.stdin.write(encodeMessage(message));
    } catch {
      // The sandbox has already gone; the exit handler reports it.
    }
  }

  private succeed(value: unknown): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timer);
    this.resolve(value);
  }

  private fail(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timer);
    this.terminate();
    this.reject(error);
  }

  terminate(): void {
    const { child } = this.options;
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGKILL');
  }
}
