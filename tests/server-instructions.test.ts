import { describe, it, expect } from 'vitest';
import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { createMcpServer } from '../src/compose.js';

async function initializeResult(instructions?: string): Promise<Record<string, unknown>> {
  const server = createMcpServer('0.0.0-test', instructions === undefined ? {} : { instructions });
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const reply = new Promise<JSONRPCMessage>((resolve) => {
    client.onmessage = (m) => resolve(m);
  });
  await server.connect(serverSide);
  await client.start();
  await client.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
  });
  const msg = (await reply) as { result?: Record<string, unknown> };
  await server.close();
  expect(msg.result).toBeDefined();
  return msg.result!;
}

describe('createMcpServer instructions', () => {
  it('sends the host-supplied instructions in the initialize result', async () => {
    const result = await initializeResult('Use account_list first.');
    expect(result.instructions).toBe('Use account_list first.');
    expect(result.serverInfo).toMatchObject({ name: 'mcp-google-multi', version: '0.0.0-test' });
  });

  it('sends no instructions by default', async () => {
    const result = await initializeResult();
    expect(result).not.toHaveProperty('instructions');
  });

  it('treats blank instructions as none', async () => {
    const result = await initializeResult('   ');
    expect(result).not.toHaveProperty('instructions');
  });
});
