#!/usr/bin/env node
/**
 * A stand-in ACP agent for the enrichment tests (docs/DEVIATIONS.md D24).
 *
 *   node fake-acp-agent.mjs --mode=<mode>
 *
 * describe    answer every prompt with plausible JSON, plus things the client must drop
 * env         describe each operation with the names of the variables it was given
 * permission  ask for permission to read a file, and report the answer
 * tool        start a tool call, then wait to be cancelled
 * auth        refuse to open a session: nobody is logged in
 * garbage     answer in prose
 * hang        never answer
 *
 * When FAKE_ACP_LOG names a file, every request is appended to it as a JSON line.
 */
import { appendFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const mode = (process.argv.find((arg) => arg.startsWith('--mode=')) ?? '--mode=describe').slice(7);
const log = process.env.FAKE_ACP_LOG;
const record = (method, params) => {
  if (log) appendFileSync(log, `${JSON.stringify({ method, mode, params })}\n`);
};

let sessions = 0;
const cancelled = new Set();

function dataOf(prompt) {
  const text = prompt.map((block) => (block.type === 'text' ? block.text : '')).join('');
  const start = text.indexOf('BEGIN DATA\n');
  const end = text.indexOf('\nEND DATA');
  return JSON.parse(text.slice(start + 'BEGIN DATA\n'.length, end));
}

function describe(data, describeOne) {
  if (!data.operations || typeof data.operations[0] === 'string') {
    return {
      description: 'An API for zebracorn wrangling.',
      keywords: ['unicornish', 'x'.repeat(200)],
    };
  }
  return {
    operations: [
      ...data.operations.map((op) => ({
        id: op.id,
        description: describeOne(op),
        parameters: {
          ...Object.fromEntries((op.parameters ?? []).map((p) => [p.name, `About ${p.name}.`])),
          'not-a-parameter': 'Must be dropped.',
        },
        fields: Object.fromEntries(
          (op.body_fields ?? []).map((f) => [f.name, `The ${f.name} field.`]),
        ),
        findings: [{ severity: 'warn', message: `Fake finding for ${op.id}.` }],
      })),
      { id: 'ghost-operation', description: 'Not in the brief; must be dropped.' },
    ],
  };
}

const app = acp
  .agent({ name: 'fake-acp-agent' })
  .onRequest(acp.methods.agent.initialize, ({ params }) => {
    record('initialize', params);
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { sessionCapabilities: { close: {} } },
      agentInfo: { name: 'fake-acp-agent', version: '1.0.0' },
      authMethods: [],
    };
  })
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    record('session/new', params);
    if (mode === 'auth') throw acp.RequestError.authRequired();
    sessions += 1;
    return { sessionId: `session-${sessions}` };
  })
  .onRequest(acp.methods.agent.session.close, ({ params }) => {
    record('session/close', params);
    return {};
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    record('session/cancel', params);
    cancelled.add(params.sessionId);
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    record('session/prompt', { sessionId: params.sessionId });
    const say = (text) =>
      client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      });

    if (mode === 'hang') return new Promise(() => {});
    if (mode === 'garbage') {
      await say('I would rather write a poem about this API.');
      return { stopReason: 'end_turn' };
    }
    if (mode === 'tool') {
      await say('{"operations": []}');
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-1',
          title: 'Read ~/.ssh/id_rsa',
          kind: 'read',
          status: 'in_progress',
        },
      });
      while (!cancelled.has(params.sessionId)) await new Promise((r) => setTimeout(r, 10));
      return { stopReason: 'cancelled' };
    }

    let note = '';
    if (mode === 'permission') {
      const answer = await client.request(acp.methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'call-1', title: 'Read ~/.ssh/id_rsa', kind: 'read' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      });
      note = ` permission:${answer.outcome.outcome}`;
    }
    const data = dataOf(params.prompt);
    const reply = describe(data, (op) =>
      mode === 'env'
        ? `env: ${Object.keys(process.env).sort().join(' ')}`
        : `Fake description of ${op.id} for zebracorn search.\u0007${note}`,
    );
    // Prose and a code fence around the JSON, as real agents produce.
    await say('Here is the JSON you asked for:\n```json\n');
    await say(JSON.stringify(reply));
    await say('\n```\n');
    return { stopReason: 'end_turn' };
  });

app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
