// Portolan sandbox runtime (SPEC.md §33, §34).
//
// This file runs inside a Deno process started with every permission explicitly denied.
// Deno is the security boundary; nothing in this file is relied upon to contain the
// script. What this file does is remove the *capability objects* from the global scope
// before user code runs, so a script has nothing to reach for even by name, and mediate
// every api.call() through a newline-delimited JSON RPC to the parent process.
//
// It is plain JavaScript executed by Deno, not by Node or tsc, so it is copied into
// dist/ verbatim rather than compiled.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Capture the primitives the runtime needs BEFORE the globals are removed. Everything
// below must use these captured bindings: `lockDownGlobals()` deletes `Deno`, so any
// later reference to it by name would throw a ReferenceError inside the runtime itself.
const stdin = Deno.stdin;
const stdout = Deno.stdout;
const exit = Deno.exit.bind(Deno);

function send(message) {
  return stdout.write(encoder.encode(`${JSON.stringify(message)}\n`));
}

let buffer = '';
const pending = new Map();
let onStart = null;

async function readLoop() {
  const chunk = new Uint8Array(65536);
  for (;;) {
    const n = await stdin.read(chunk);
    if (n === null) break;
    buffer += decoder.decode(chunk.subarray(0, n), { stream: true });
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line !== '') {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          message = null;
        }
        if (message) dispatch(message);
      }
      index = buffer.indexOf('\n');
    }
  }
}

function dispatch(message) {
  if (message.type === 'start' && onStart) {
    const handler = onStart;
    onStart = null;
    handler(message);
    return;
  }
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.type === 'api_result') entry.resolve(message.result);
  else if (message.type === 'api_error') entry.reject(makeApiError(message.error));
}

function makeApiError(error) {
  const err = new Error(error && error.message ? error.message : 'api.call failed');
  err.name = 'ApiCallError';
  err.code = error && error.code ? error.code : 'SANDBOX_RUNTIME_ERROR';
  if (error && error.details !== undefined) err.details = error.details;
  return err;
}

let callCounter = 0;

function makeApi() {
  const call = (request) => {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      return Promise.reject(
        new TypeError(
          'api.call expects an object: { operation_id, parameters?, body?, content_type? }',
        ),
      );
    }
    if (typeof request.operation_id !== 'string' || request.operation_id === '') {
      return Promise.reject(new TypeError('api.call requires a string operation_id'));
    }
    const id = String(++callCounter);
    const payload = { operation_id: request.operation_id };
    if (request.parameters !== undefined) payload.parameters = request.parameters;
    if (request.body !== undefined) payload.body = request.body;
    if (request.content_type !== undefined) payload.content_type = request.content_type;

    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ type: 'api_call', id, request: payload }).catch(reject);
    });
  };
  return Object.freeze({ call });
}

function makeConsole(limits) {
  let entries = 0;
  let bytes = 0;
  const write =
    (level) =>
    (...args) => {
      if (entries >= limits.maxLogEntries || bytes >= limits.maxLogBytes) return;
      let text;
      try {
        text = args.map((arg) => (typeof arg === 'string' ? arg : safeStringify(arg))).join(' ');
      } catch {
        text = '[unserializable log argument]';
      }
      if (text.length > 2000) text = `${text.slice(0, 2000)}… [truncated]`;
      entries += 1;
      bytes += text.length;
      void send({ type: 'log', level, message: text });
    };
  return Object.freeze({
    log: write('log'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    debug: write('debug'),
  });
}

function safeStringify(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) return '[circular]';
      seen.add(val);
    }
    if (typeof val === 'bigint') return val.toString();
    if (typeof val === 'function') return '[function]';
    return val;
  });
}

/**
 * Remove capability-bearing globals. With every Deno permission denied these already
 * throw, but deleting them means a script cannot even hold a reference to one, and the
 * failure it sees is a plain ReferenceError rather than a permission error that hints at
 * what might be reachable.
 */
function lockDownGlobals() {
  const remove = [
    'Deno',
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'Worker',
    'SharedWorker',
    'BroadcastChannel',
    'navigator',
    'localStorage',
    'sessionStorage',
    'caches',
    'Cache',
    'CacheStorage',
    'process',
    'require',
  ];
  for (const name of remove) {
    try {
      delete globalThis[name];
    } catch {
      try {
        Object.defineProperty(globalThis, name, { value: undefined, configurable: true });
      } catch {
        // Non-configurable and unreachable: Deno's permission denial still applies.
      }
    }
  }
}

async function main() {
  const start = await new Promise((resolve) => {
    onStart = resolve;
    readLoop().catch(() => undefined);
    void send({ type: 'ready' });
  });

  const api = makeApi();
  const console = makeConsole(start.limits);
  const input = start.input;

  // The user's code is compiled with AsyncFunction so that top-level `return` and `await`
  // both work, and so the script sees exactly the three bindings SPEC.md §33 specifies.
  // This is not the security boundary — the permissionless Deno process is.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  let script;
  try {
    script = new AsyncFunction('api', 'input', 'console', start.code);
  } catch (error) {
    await send({ type: 'error', name: 'SyntaxError', message: String(error && error.message) });
    exit(0);
    return;
  }

  lockDownGlobals();

  let result;
  try {
    result = await script(api, input, console);
  } catch (error) {
    const name = error && error.name ? String(error.name) : 'Error';
    const message = error && error.message ? String(error.message) : String(error);
    await send({ type: 'error', name, message });
    exit(0);
    return;
  }

  let serialized;
  try {
    serialized = result === undefined ? null : JSON.parse(JSON.stringify(result));
  } catch {
    await send({
      type: 'error',
      name: 'SerializationError',
      message: 'The script returned a value that is not JSON-serializable.',
    });
    exit(0);
    return;
  }

  const text = JSON.stringify(serialized);
  if (text.length > start.limits.maxOutputBytes) {
    await send({
      type: 'error',
      name: 'OutputTooLarge',
      message: `The script returned ${text.length} bytes, which exceeds the ${start.limits.maxOutputBytes}-byte limit. Reduce or summarise the data before returning it.`,
    });
    exit(0);
    return;
  }

  await send({ type: 'result', result: serialized });
  exit(0);
}

main().catch(async (error) => {
  try {
    await send({ type: 'error', name: 'InternalError', message: String(error && error.message) });
  } finally {
    exit(0);
  }
});
