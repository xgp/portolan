/**
 * A coding agent driven over the Agent Client Protocol (docs/DEVIATIONS.md D24).
 *
 * Portolan is the ACP *client*: it starts an adapter (`claude-agent-acp`, `codex-acp`) as
 * a child process, speaks newline-delimited JSON-RPC over its stdio, and uses whatever
 * account the user is already logged in with. The agent only ever reads a prompt and
 * writes text back. Everything it is shown comes from a third-party document, so it is
 * treated as an agent that may be prompt-injected:
 *
 * - The client advertises no file-system or terminal capability and refuses every
 *   permission request.
 * - Each adapter is started with its own tools switched off: Claude Code with no
 *   built-in tools and no user settings (so no hooks or MCP servers), Codex read-only
 *   with shell, apps, plugins and web search disabled.
 * - If a tool call is reported anyway, the turn is cancelled and its output discarded.
 * - The process runs in an empty temporary directory, with an environment built from an
 *   allowlist. Every variable a Portolan credential is read from is removed.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { accessSync, constants, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { Readable, Writable, type Readable as NodeReadable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type { Logger } from '../logging.js';

export type AgentName = 'claude' | 'codex';

/**
 * The official adapters, and the agent CLI each one fronts. When an adapter is not
 * installed but its CLI is, it is run through npx at the version pinned here — the one
 * Portolan was tested against — rather than whatever is latest.
 */
export const ADAPTERS: Readonly<
  Record<AgentName, { command: string; cli: string; package: string }>
> = {
  claude: {
    command: 'claude-agent-acp',
    cli: 'claude',
    package: '@agentclientprotocol/claude-agent-acp@0.94.0',
  },
  codex: { command: 'codex-acp', cli: 'codex', package: '@agentclientprotocol/codex-acp@2.2.2' },
};

export interface AgentSpec {
  name: AgentName;
  command: string;
  args: readonly string[];
  /** Extra variables to pass through, beyond {@link ENV_ALLOWLIST}. */
  env: readonly string[];
}

export interface AcpAgentOptions {
  logger: Logger;
  /** Variables never passed to the agent, whatever the allowlist says. */
  secretEnv: ReadonlySet<string>;
  promptTimeoutMs: number;
  model?: string | undefined;
}

/**
 * `exited` and `tool_use` end the agent's usefulness for the job; `failed` is one prompt
 * going wrong (a timeout, a refusal) and the next may succeed.
 */
export type AgentFailureReason = 'not_found' | 'unauthenticated' | 'exited' | 'failed' | 'tool_use';

export class AgentError extends Error {
  constructor(
    readonly reason: AgentFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

/** Variables an adapter needs to find its binary, its login and the network. */
const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TMPDIR',
  'TEMP',
  'TMP',
  'TERM',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SYSTEMROOT',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
];
const ENV_PREFIXES = [
  'LC_',
  'XDG_',
  'ANTHROPIC_',
  'CLAUDE_',
  'OPENAI_',
  'CODEX_',
  // npx needs the user's registry, cache and proxy settings to fetch an adapter.
  'npm_config_',
  'NPM_CONFIG_',
];

/** Codex features that give the model a way to read, run or fetch anything. */
const CODEX_LOCKDOWN = {
  features: {
    shell_tool: false,
    unified_exec: false,
    apps: false,
    plugins: false,
    browser_use: false,
    computer_use: false,
    code_mode_host: false,
    multi_agent: false,
    image_generation: false,
    view_image: false,
    goals: false,
    skill_search: false,
    tool_suggest: false,
  },
  include_apply_patch_tool: false,
  web_search: 'disabled',
  mcp_servers: {},
};

/** Claude Agent SDK options: no built-in tools, and none of the user's settings files. */
const CLAUDE_LOCKDOWN = {
  claudeCode: {
    options: {
      tools: [],
      settingSources: [],
      mcpServers: {},
      allowDangerouslySkipPermissions: false,
      persistSession: false,
    },
  },
};

export function buildAgentEnv(
  spec: AgentSpec,
  secretEnv: ReadonlySet<string>,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  const passthrough = new Set([...ENV_ALLOWLIST, ...spec.env]);
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || secretEnv.has(key)) continue;
    if (passthrough.has(key) || ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      env[key] = value;
    }
  }
  if (spec.name === 'codex') {
    env.CODEX_CONFIG = JSON.stringify(CODEX_LOCKDOWN);
    env.INITIAL_AGENT_MODE = 'read-only';
    env.NO_BROWSER = '1';
  }
  return env;
}

/** Resolve `command` against PATH the way a shell would, without running anything. */
export function findExecutable(
  command: string,
  path: string | undefined = process.env.PATH,
): string | undefined {
  const candidates = isAbsolute(command)
    ? [command]
    : command.includes('/')
      ? []
      : (path ?? '')
          .split(delimiter)
          .flatMap((dir) =>
            dir === ''
              ? []
              : process.platform === 'win32'
                ? ['', '.cmd', '.exe'].map((ext) => join(dir, command + ext))
                : [join(dir, command)],
          );
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

export class AcpAgent {
  private constructor(
    readonly spec: AgentSpec,
    private readonly child: ChildProcessByStdio<Writable, NodeReadable, NodeReadable>,
    private readonly connection: acp.ClientConnection,
    private readonly cwd: string,
    private readonly options: AcpAgentOptions,
    /** Rejects once the process exits; already handled, so it is safe to race repeatedly. */
    private readonly exited: Promise<never>,
    private readonly canClose: boolean,
  ) {}

  /** Start the adapter and complete ACP initialization. */
  static async start(spec: AgentSpec, options: AcpAgentOptions): Promise<AcpAgent> {
    const executable = findExecutable(spec.command);
    if (!executable) {
      throw new AgentError('not_found', `'${spec.command}' was not found on PATH`);
    }
    const cwd = mkdtempSync(join(tmpdir(), 'portolan-agent-'));
    const child = spawn(executable, [...spec.args], {
      cwd,
      env: buildAgentEnv(spec, options.secretEnv),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    const exited = new Promise<never>((_, reject) => {
      child.once('error', (error) =>
        reject(new AgentError('failed', `could not start ${spec.command}: ${error.message}`)),
      );
      child.once('exit', (code, signal) =>
        reject(
          new AgentError(
            'exited',
            `${spec.command} exited (${signal ?? code})${stderr ? `: ${lastLine(stderr)}` : ''}`,
          ),
        ),
      );
    });
    exited.catch(() => undefined);

    const app = acp
      .client({ name: 'portolan' })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        options.logger.warn(
          { agent: spec.name, tool: params.toolCall.title },
          'refused an enrichment agent permission request',
        );
        return { outcome: { outcome: 'cancelled' } };
      });
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const connection = app.connect(stream);

    try {
      const init = await Promise.race([
        connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: 'portolan', version: '0.1.0' },
        }),
        exited,
        timeout(options.promptTimeoutMs, `${spec.command} did not initialize`),
      ]);
      const canClose = init.agentCapabilities?.sessionCapabilities?.close != null;
      return new AcpAgent(spec, child, connection, cwd, options, exited, canClose);
    } catch (error) {
      connection.close();
      child.kill('SIGKILL');
      rmSync(cwd, { recursive: true, force: true });
      throw toAgentError(error);
    }
  }

  /**
   * Run one prompt in a fresh session and return the agent's reply. A session per prompt
   * keeps each batch independent and its context small.
   */
  async prompt(text: string): Promise<string> {
    const session = await this.guard(
      this.connection.agent
        .buildSession({
          cwd: this.cwd,
          mcpServers: [],
          ...(this.spec.name === 'claude' ? { _meta: CLAUDE_LOCKDOWN } : {}),
        })
        .start(),
      'did not open a session',
    );
    try {
      if (this.options.model) await this.selectModel(session, this.options.model);

      const done = session.prompt(text);
      done.catch(() => undefined);
      let reply = '';
      let toolUse: string | undefined;
      const read = async () => {
        for (;;) {
          const message = await session.nextUpdate();
          if (message.kind === 'stop') return message.stopReason;
          const update = message.update;
          if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
            reply += update.content.text;
          } else if (update.sessionUpdate === 'tool_call' && toolUse === undefined) {
            // The agent was started without tools; one appearing means the lockdown did
            // not hold. Stop the turn and discard whatever it produced.
            toolUse = update.title;
            await this.connection.agent.notify(acp.methods.agent.session.cancel, {
              sessionId: session.sessionId,
            });
          }
        }
      };
      let stopReason: acp.StopReason;
      try {
        stopReason = await this.guard(read(), 'did not answer');
      } catch (error) {
        await this.connection.agent
          .notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId })
          .catch(() => undefined);
        throw error;
      }
      if (toolUse !== undefined) {
        throw new AgentError('tool_use', `${this.spec.name} tried to use a tool (${toolUse})`);
      }
      if (stopReason !== 'end_turn') {
        throw new AgentError('failed', `${this.spec.name} stopped with '${stopReason}'`);
      }
      return reply;
    } finally {
      session.dispose();
      if (this.canClose) {
        await this.connection.agent
          .request(acp.methods.agent.session.close, { sessionId: session.sessionId })
          .catch(() => undefined);
      }
    }
  }

  close(): void {
    this.connection.close();
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    timer.unref();
    this.child.once('exit', () => clearTimeout(timer));
    rmSync(this.cwd, { recursive: true, force: true });
  }

  private async selectModel(session: acp.ActiveSession, model: string): Promise<void> {
    const option = session.newSessionResponse.configOptions?.find(
      (candidate) => candidate.category === 'model' || candidate.id === 'model',
    );
    if (!option) {
      this.options.logger.warn({ agent: this.spec.name, model }, 'agent offers no model choice');
      return;
    }
    await this.connection.agent.request(acp.methods.agent.session.setConfigOption, {
      sessionId: session.sessionId,
      configId: option.id,
      value: model,
    });
  }

  /** Race `work` against the prompt timeout and the process exiting. */
  private async guard<T>(work: Promise<T>, what: string): Promise<T> {
    try {
      return await Promise.race([
        work,
        this.exited,
        timeout(this.options.promptTimeoutMs, `${this.spec.name} ${what} in time`),
      ]);
    } catch (error) {
      throw toAgentError(error);
    }
  }
}

function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new AgentError('failed', message)), ms);
    timer.unref();
  });
}

/** ACP's `auth_required` error, which an adapter returns when nobody is logged in. */
const AUTH_REQUIRED = acp.RequestError.authRequired().code;

function toAgentError(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  if (error instanceof acp.RequestError && error.code === AUTH_REQUIRED) {
    return new AgentError('unauthenticated', 'the agent is not logged in');
  }
  return new AgentError('failed', error instanceof Error ? error.message : String(error));
}

function lastLine(text: string): string {
  return (
    text
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? ''
  );
}
