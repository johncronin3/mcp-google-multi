import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type Policy, isAllowed, writeDisabledResult } from './write-control.js';
import { compactResult, trimEnabled } from './trim.js';
import { fanoutAccountField, invalidAccountsResult, parseAccountSelector, runFanout } from './fanout.js';
import type { ArgKind, ArgShape } from './arg-normalize.js';
import { suggestKeys } from './arg-strict.js';

export type Cud = 'read' | 'create' | 'update' | 'delete';

export interface ToolEntry {
  name: string;
  service: string;
  cud: Cud;
  description: string;
  inputShape: z.ZodRawShape;
  annotations: Record<string, unknown>;
  meta: boolean;
}

export interface CatalogOperation {
  tool: string;
  summary: string;
  args: string[];
  cud: Cud;
}

interface ToolConfig {
  description?: string;
  inputSchema?: z.ZodRawShape;
  annotations?: Record<string, unknown>;
  // Set only by generated tools (cud from HTTP semantics at gen time): open-ended
  // Discovery verbs (undeploy, wipeout, …) would slip past name-based write-control.
  cud?: Cud;
}

const CUD_OVERRIDES: Record<string, Cud> = {
  drive_untrash: 'update',
  drive_transfer: 'create',
  // Session meta, not a Google write — else read-only hosted never reaches hostedSetGrantRefusal.
  set_grant: 'read',
};

const SERVICE_OVERRIDES: Record<string, string> = {
  reports_activities_list: 'admin',
};

// read tools that write local files — same savePath fanned across accounts would clobber
const FANOUT_EXCLUDE = new Set(['gmail_download_attachment', 'drive_download', 'drive_export']);

/** Unwrap optional/default/nullable to the declared scalar kind (zod 4 defs). */
function scalarKindOf(field: unknown): ArgKind {
  type Def = { type?: string; innerType?: unknown };
  let cur = field as { _zod?: { def?: Def } } | undefined;
  for (let i = 0; i < 4 && cur?._zod?.def; i++) {
    const def = cur._zod.def;
    if (def.type === 'number') return 'number';
    if (def.type === 'boolean') return 'boolean';
    if (def.type === 'optional' || def.type === 'default' || def.type === 'nullable') {
      cur = def.innerType as typeof cur;
      continue;
    }
    return 'other';
  }
  return 'other';
}

function isAccountEnum(field: unknown): boolean {
  return (field as { _zod?: { def?: { type?: string } } } | undefined)?._zod?.def?.type === 'enum';
}

const DELETE_VERB = /(^|_)(delete|remove|trash|clear|empty)(_|$)/;
const CREATE_VERB = /(^|_)(create|add|insert|send|upload|copy|import|append|submit|duplicate|share|quick)(_|$)/;
const UPDATE_VERB = /(^|_)(update|patch|modify|set|move|write|format|merge|unmerge|sort|replace|resize|publish|resolve)(_|$)/;

export function inferCud(name: string): Cud {
  const override = CUD_OVERRIDES[name];
  if (override) return override;
  if (DELETE_VERB.test(name)) return 'delete';
  if (CREATE_VERB.test(name)) return 'create';
  if (UPDATE_VERB.test(name)) return 'update';
  return 'read';
}

export class ToolRegistry {
  readonly tools: ToolEntry[] = [];
  readonly policy: Policy;
  readonly registerTool: McpServer['registerTool'];
  private readonly revealed = new Set<string>();
  private readonly jsonSchemaCache = new Map<string, unknown>();
  private readonly argShapeCache = new Map<string, ArgShape>();
  private readonly compactOutput = trimEnabled();
  private registeringMeta = false;

  constructor(
    private readonly server: McpServer,
    policy: Policy,
  ) {
    this.policy = policy;
    this.registerTool = ((name: string, config: ToolConfig, handler: (...a: unknown[]) => unknown) => {
      const service =
        SERVICE_OVERRIDES[name] ?? (name.includes('_') ? name.slice(0, name.indexOf('_')) : name);
      const cud = config.cud ?? inferCud(name);
      // destructiveHint=false claims "additive only" (MCP spec) — updates overwrite, so they stay true.
      const annotations = {
        readOnlyHint: cud === 'read',
        destructiveHint: cud === 'delete' || cud === 'update',
        ...config.annotations,
      };

      // never fan out meta tools: google_api_call infers cud=read but executes writes
      let inputShape = config.inputSchema ?? {};
      let baseHandler = handler;
      if (cud === 'read' && !this.registeringMeta && !FANOUT_EXCLUDE.has(name) && isAccountEnum(inputShape.account)) {
        const description = (inputShape.account as z.ZodType).description ?? 'Google account alias';
        inputShape = { ...inputShape, account: fanoutAccountField(description) };
        baseHandler = async (...args: unknown[]) => {
          const first = args[0] as { account?: string } | undefined;
          const parsed = parseAccountSelector(typeof first?.account === 'string' ? first.account : '');
          if (!parsed.ok) return invalidAccountsResult(parsed.invalid, undefined, parsed.reason);
          if (!parsed.fanout) return handler({ ...first, account: parsed.aliases[0] }, ...args.slice(1));
          return runFanout(handler, args, parsed.aliases);
        };
      }

      this.tools.push({
        name,
        service,
        cud,
        description: config.description ?? '',
        inputShape,
        annotations,
        meta: this.registeringMeta,
      });
      const guarded =
        cud === 'read'
          ? baseHandler
          : (...args: unknown[]) =>
              isAllowed({ name, service, cud }, policy)
                ? baseHandler(...args)
                : writeDisabledResult({ name, service, cud }, policy);
      const finalHandler = this.compactOutput
        ? async (...args: unknown[]) => compactResult(await (guarded(...args) as Promise<Parameters<typeof compactResult>[0]>))
        : guarded;
      const { cud: _cud, ...sdkConfig } = config;
      return (server.registerTool as (...a: unknown[]) => unknown)(name, { ...sdkConfig, inputSchema: inputShape, annotations }, finalHandler);
    }) as McpServer['registerTool'];
  }

  registerMeta: McpServer['registerTool'] = ((name: string, config: unknown, handler: unknown) => {
    this.registeringMeta = true;
    try {
      return (this.registerTool as (...a: unknown[]) => unknown)(name, config, handler);
    } finally {
      this.registeringMeta = false;
    }
  }) as McpServer['registerTool'];

  services(): string[] {
    return [...new Set(this.tools.filter((t) => !t.meta).map((t) => t.service))];
  }

  /** Declared input-schema keys + scalar kinds for one tool (tools/call arg
   * normalization; the kind drives value coercion on renamed keys). */
  argShape(name: string): ArgShape | undefined {
    const cached = this.argShapeCache.get(name);
    if (cached) return cached;
    const entry = this.tools.find((t) => t.name === name);
    if (!entry) return undefined;
    const shape = new Map<string, ArgKind>();
    for (const [key, field] of Object.entries(entry.inputShape)) shape.set(key, scalarKindOf(field));
    this.argShapeCache.set(name, shape);
    return shape;
  }

  /** Declared argument keys for a tool, in declaration order; undefined when
   * the tool is not registered. Backs unknown-argument screening, which needs
   * the full key list rather than argShape's scalar-kind subset view. */
  declaredKeys(name: string): readonly string[] | undefined {
    const entry = this.tools.find((t) => t.name === name);
    return entry ? Object.keys(entry.inputShape) : undefined;
  }

  /** Keys spelling a similar concept elsewhere in the same service, for the
   * hint on a call whose key matched nothing. Kept only when a key is declared
   * by at least two tools in the service or by a curated one, so one-off
   * generated parameters do not become advice. */
  siblingSpellings(tool: string, unknownKeys: string[]): Array<{ key: string; tools: string[] }> {
    const self = this.tools.find((t) => t.name === tool);
    if (!self) return [];
    const declared = new Set(Object.keys(self.inputShape));
    const byKey = new Map<string, { tools: string[]; curated: boolean }>();
    for (const t of this.tools) {
      if (t.service !== self.service || t.name === tool) continue;
      for (const key of Object.keys(t.inputShape)) {
        if (declared.has(key)) continue;
        const e = byKey.get(key) ?? { tools: [], curated: false };
        e.tools.push(t.name);
        if (!t.meta) e.curated = true;
        byKey.set(key, e);
      }
    }
    const candidates = [...byKey.entries()].filter(([, e]) => e.tools.length >= 2 || e.curated);
    // Reuse the tiered matcher rather than a substring test: the motivating
    // case (parentId against parentFolderId) fails containment and edit
    // distance alike, which is the whole reason that matcher exists.
    const keys = candidates.map(([key]) => key);
    const hits = new Set(unknownKeys.flatMap((k) => suggestKeys(k, keys)));
    return candidates
      .filter(([key]) => hits.has(key))
      .slice(0, 2)
      .map(([key, e]) => ({ key, tools: e.tools }));
  }

  catalog(service: string, query?: string): CatalogOperation[] {
    const q = query?.trim().toLowerCase();
    return this.tools
      .filter((t) => !t.meta && t.service === service)
      .filter((t) => !q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
      .map((t) => ({
        tool: t.name,
        summary: t.description,
        args: Object.keys(t.inputShape),
        cud: t.cud,
      }));
  }

  /**
   * Mark a service's operational tools as listable.
   * @param notify when true (default), emit tools/list_changed for clients that
   *   re-fetch after discover. Pass false at boot so the first tools/list already
   *   includes the service (needed for Claude Desktop/Cowork, which does not treat
   *   list_changed + progressive reveal as selectable deferred tools).
   */
  reveal(service: string, opts?: { notify?: boolean }): boolean {
    if (this.revealed.has(service)) return false;
    this.revealed.add(service);
    if (opts?.notify !== false) this.server.sendToolListChanged();
    return true;
  }

  /**
   * Pre-reveal services from GOOGLE_REVEAL_AT_BOOT (CSV of service names, or
   * `all`/`*`). Used so clients that cannot select deferred tools still see
   * high-value surfaces (especially `drive`) on the initial tools/list.
   */
  revealAtBootFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
    const raw = (env.GOOGLE_REVEAL_AT_BOOT || '').trim();
    if (!raw) return [];
    const known = new Set(this.services());
    const wanted =
      raw === '*' || raw.toLowerCase() === 'all'
        ? [...known]
        : raw.split(',').map((s) => s.trim()).filter(Boolean);
    const revealed: string[] = [];
    for (const service of wanted) {
      if (!known.has(service)) {
        process.stderr.write(`GOOGLE_REVEAL_AT_BOOT: unknown service "${service}" ignored\n`);
        continue;
      }
      if (this.reveal(service, { notify: false })) revealed.push(service);
    }
    return revealed;
  }

  isVisible(tool: ToolEntry): boolean {
    return tool.meta || this.revealed.has(tool.service);
  }

  visibleCount(): { eager: number; revealed: number; hidden: number } {
    const meta = this.tools.filter((t) => t.meta).length;
    const visible = this.tools.filter((t) => !t.meta && this.isVisible(t)).length;
    return { eager: meta, revealed: visible, hidden: this.tools.length - meta - visible };
  }

  // Replaces the SDK list handler so hidden tools stay registered (and callable —
  // graceful dispatch) while tools/list only advertises the visible set.
  installListHandler(): void {
    if (this.tools.length === 0) {
      throw new Error('installListHandler() requires at least one registered tool');
    }
    this.server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.tools.filter((t) => this.isVisible(t)).map((t) => this.toToolJson(t)),
    }));
  }

  private toToolJson(tool: ToolEntry): { name: string; description: string; inputSchema: unknown; annotations: Record<string, unknown> } {
    let inputSchema = this.jsonSchemaCache.get(tool.name);
    if (!inputSchema) {
      inputSchema = z.toJSONSchema(z.object(tool.inputShape), { target: 'draft-7', io: 'input' });
      this.jsonSchemaCache.set(tool.name, inputSchema);
    }
    return {
      name: tool.name,
      description: tool.description,
      inputSchema,
      annotations: tool.annotations,
    };
  }
}
