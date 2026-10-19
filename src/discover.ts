import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import { describePolicy, type Policy } from './write-control.js';
import { hints } from './hint-provider.js';

// The description budget is the whole point of lazy mode: descriptions carry
// a CAPPED vocabulary, and the complete catalog stays in this tool's RESULT.
const CURATED_OPS_CAP = 10;
const GENERATED_GROUPS_CAP = 6;

function opVocabulary(registry: ToolRegistry, service: string): string {
  const { curated, generated } = registry.opNames(service);
  const parts: string[] = [];
  if (curated.length > 0) {
    const shown = curated.slice(0, CURATED_OPS_CAP);
    const more = curated.length - shown.length;
    parts.push(`${shown.join(', ')}${more > 0 ? ` +${more} more` : ''}`);
  }
  if (generated.length > 0) {
    // Compresses to resource groups: denser than any truncated name list.
    const counts = new Map<string, number>();
    for (const op of generated) {
      const group = op.split('_')[0];
      counts.set(group, (counts.get(group) ?? 0) + 1);
    }
    const groups = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const shown = groups.slice(0, GENERATED_GROUPS_CAP).map(([g]) => g);
    const more = groups.length - shown.length;
    parts.push(`${generated.length} generated ops: ${shown.join(', ')}${more > 0 ? ` +${more} areas` : ''}`);
  }
  return parts.join('; ');
}

// SDK ToolAnnotations is a closed type, so widen the register signature
// locally (same idiom as generated/_shared.ts).
type WideRegister = (
  name: string,
  config: { description: string; inputSchema: z.ZodRawShape; _meta?: Record<string, unknown> },
  handler: (args: Record<string, unknown>) => unknown,
) => void;

export function registerDiscoverTools(registry: ToolRegistry, policy: Policy): void {
  const registerMeta = registry.registerMeta as unknown as WideRegister;
  // stdio-only semantics: over stateless HTTP the mode is forced curated and these are no-ops.
  registerMeta(
    'discover_all',
    {
      description:
        'Reveal ALL curated Google tools at once (instead of per-service discovery). Use when ' +
        'starting substantial Google work; prefer these over google_api_call. Pair with discover_reset.',
      inputSchema: {},
      _meta: { 'anthropic/alwaysLoad': true },
    },
    async () => {
      const changed = registry.expand();
      const counts = registry.visibleCount();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              expanded: changed,
              visibleTools: counts.eager + counts.revealed,
              note: changed
                ? 'Curated tools are now advertised. Generated long-tail tools still appear per-service via {service}_discover.'
                : 'Surface was already expanded (or the configured mode already advertises curated tools).',
            }),
          },
        ],
      };
    },
  );

  registerMeta(
    'discover_reset',
    {
      description:
        'Collapse the tool surface back to the configured default, reclaiming context budget ' +
        'after heavy Google work. All tools remain callable by name after collapsing.',
      inputSchema: {},
      _meta: { 'anthropic/alwaysLoad': true },
    },
    async () => {
      const changed = registry.collapse();
      const counts = registry.visibleCount();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              collapsed: changed,
              visibleTools: counts.eager + counts.revealed,
              note: 'Hidden tools stay callable by name (graceful dispatch); re-expand any time with discover_all.',
            }),
          },
        ],
      };
    },
  );

  for (const service of registry.services()) {
    registerMeta(
      `${service}_discover`,
      {
        description:
          (registry.mode === 'lazy'
            ? `Discover ${service}: lists the catalog and reveals its hidden tools; call first, then call the tool by name. `
            : `List the ${service} catalog (reveals any still-hidden ${service} tools). `) +
          `Ops: ${opVocabulary(registry, service)}.`,
        inputSchema: {
          query: z.string().optional().describe('Filter keyword'),
        },
        _meta: { 'anthropic/alwaysLoad': true },
      },
      async ({ query }) => {
        const operations = registry.catalog(service, query as string | undefined);
        registry.reveal(service);
        const rendered = hints()?.render({ kind: 'policy_summary', policy });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                service,
                operations,
                writeControl: rendered?.hint ?? describePolicy(policy),
                // catalog() falls back to a full one-line listing when nothing matches, so this is never empty.
                next: 'Call the chosen tool by its exact name. A client that loads tools on demand may need its own tool-search or load step before the call succeeds.',
              }),
            },
          ],
        };
      },
    );
  }
}
