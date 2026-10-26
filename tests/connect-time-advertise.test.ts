import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, connectTimeDiscoveryMode } from '../src/registry.js';
import type { Policy } from '../src/write-control.js';

const POLICY: Policy = { profile: 'safe-writes', readOnly: false, allow: [], deny: [] };

function setup(mode: 'lazy' | 'curated' | 'eager') {
  let listHandler: (() => Promise<{ tools: { name: string }[] }>) | undefined;
  const server = {
    registerTool: () => 'ok',
    sendToolListChanged: vi.fn(),
    server: {
      setRequestHandler: (_method: string, handler: () => Promise<{ tools: { name: string }[] }>) => {
        listHandler = handler;
      },
    },
  };
  const registry = new ToolRegistry(server as never, POLICY, mode);
  registry.registerTool('gmail_send', { description: 'Send mail', inputSchema: { account: z.string() } }, () => {});
  registry.registerTool('drive_upload', { description: 'Upload a file', inputSchema: { account: z.string() } }, () => {});
  registry.registerTool(
    'gmail_users_labels_get',
    { description: 'generated', inputSchema: { account: z.string() }, cud: 'read' } as never,
    () => {},
  );
  registry.registerMeta('gmail_discover', { description: 'meta', inputSchema: {} }, () => {});
  registry.installListHandler();
  const names = async () => (await listHandler!()).tools.map((t) => t.name);
  return { registry, server, names };
}

describe('connectTimeDiscoveryMode', () => {
  it('advertises curated tools unless the operator asked for eager', () => {
    expect(connectTimeDiscoveryMode({} as NodeJS.ProcessEnv)).toBe('curated');
    expect(connectTimeDiscoveryMode({ GOOGLE_DISCOVERY: '' } as NodeJS.ProcessEnv)).toBe('curated');
    expect(connectTimeDiscoveryMode({ GOOGLE_DISCOVERY: 'lazy' } as NodeJS.ProcessEnv)).toBe('curated');
    expect(connectTimeDiscoveryMode({ GOOGLE_DISCOVERY: 'curated' } as NodeJS.ProcessEnv)).toBe('curated');
    expect(connectTimeDiscoveryMode({ GOOGLE_DISCOVERY: 'eager' } as NodeJS.ProcessEnv)).toBe('eager');
  });
});

describe('connect-time advertise vs discover-only', () => {
  it('house connect mode lists curated tools before any discover; generated stays hidden', async () => {
    const mode = connectTimeDiscoveryMode({ GOOGLE_DISCOVERY: 'lazy' } as NodeJS.ProcessEnv);
    const { names, server } = setup(mode);
    const listed = await names();
    expect(listed).toEqual(expect.arrayContaining(['gmail_send', 'drive_upload', 'gmail_discover']));
    expect(listed).not.toContain('gmail_users_labels_get');
    expect(server.sendToolListChanged).not.toHaveBeenCalled();
  });

  it('lazy (stdio default) hides curated tools until reveal', async () => {
    const { registry, names } = setup('lazy');
    const before = await names();
    expect(before).toEqual(['gmail_discover']);
    expect(before).not.toContain('gmail_send');
    expect(before).not.toContain('drive_upload');

    registry.reveal('gmail');
    registry.reveal('drive');
    const after = await names();
    expect(after).toEqual(expect.arrayContaining(['gmail_send', 'drive_upload', 'gmail_users_labels_get']));
  });
});
