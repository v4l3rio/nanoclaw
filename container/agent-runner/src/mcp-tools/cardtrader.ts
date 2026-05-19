/**
 * CardTrader API MCP tools (read-only).
 *
 * Wraps the CardTrader Full API v2 (https://api.cardtrader.com/api/v2).
 * Auth is handled by the OneCLI gateway — the proxy injects the Bearer
 * token at request time. No token is read from env here. If the proxy is
 * unconfigured for `api.cardtrader.com`, calls return 401 and the tool
 * surfaces it to the agent.
 *
 * Scope: read-only. Mutating endpoints (cart write, products CRUD, order
 * actions, bulk ops, wishlist create/delete) are intentionally omitted.
 */
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const BASE_URL = process.env.CARDTRADER_BASE_URL || 'https://api.cardtrader.com/api/v2';
const USER_AGENT = 'nanoclaw-cardtrader-mcp/1.0';

type QueryValue = string | number | boolean | undefined | null;

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(BASE_URL.replace(/\/$/, '') + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function ctGet(path: string, query?: Record<string, QueryValue>): Promise<{ ok: boolean; status: number; body: unknown; text?: string }> {
  const url = buildUrl(path, query);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
    });
  } catch (e) {
    return { ok: false, status: 0, body: null, text: e instanceof Error ? e.message : String(e) };
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body, text };
}

function asResult(label: string, r: { ok: boolean; status: number; body: unknown; text?: string }) {
  if (!r.ok) {
    const detail = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    const hint =
      r.status === 401
        ? '\n\nHint: 401 from CardTrader. The OneCLI gateway likely has no credential matching `api.cardtrader.com`. Ask the user to add the CardTrader bearer token to the OneCLI vault (web UI at http://127.0.0.1:10254) and ensure this agent has secret mode `all` or the secret explicitly assigned.'
        : r.status === 429
          ? '\n\nHint: 429 rate-limited. CardTrader caps global traffic at 200 req/10s, marketplace/products at 10 req/s, jobs at 1 req/s.'
          : r.status === 0
            ? '\n\nHint: network error reaching api.cardtrader.com. Check HTTPS_PROXY and CA bundle.'
            : '';
    return {
      content: [
        {
          type: 'text' as const,
          text: `${label} — HTTP ${r.status}\n${detail || r.text || '(empty body)'}${hint}`,
        },
      ],
    };
  }
  const json = typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2);
  return { content: [{ type: 'text' as const, text: `${label} — HTTP ${r.status}\n${json}` }] };
}

// ---------------------------------------------------------------------------
// Reference endpoints
// ---------------------------------------------------------------------------

function maskSecret(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '(empty)';
  const head = value.slice(0, 4);
  return `${head}…(${value.length} chars, masked)`;
}

function redactInfoBody(body: unknown): { body: unknown; redacted: boolean } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { body, redacted: false };
  const clone: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  let redacted = false;
  for (const key of ['shared_secret', 'sharedSecret', 'webhook_secret', 'webhookSecret']) {
    if (key in clone) {
      clone[key] = maskSecret(clone[key]);
      redacted = true;
    }
  }
  return { body: clone, redacted };
}

const info: McpToolDefinition = {
  tool: {
    name: 'cardtrader_info',
    description:
      'CardTrader: ping the API and return app/user info. Use to verify authentication and connectivity before heavier calls. By default the webhook `shared_secret` is masked — pass `reveal_secret: true` only if the user explicitly asks to see it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        reveal_secret: {
          type: 'boolean',
          description:
            'Optional. Default false. If true, show the webhook shared_secret in clear. Only set when the user explicitly asks for it.',
        },
      },
    },
  },
  async handler(args) {
    const reveal = args.reveal_secret === true;
    const r = await ctGet('/info');
    if (!r.ok || reveal) return asResult('GET /info', r);
    const { body, redacted } = redactInfoBody(r.body);
    const wrapped = { ...r, body };
    const result = asResult('GET /info', wrapped);
    if (redacted) {
      result.content.push({
        type: 'text' as const,
        text: 'ℹ️  webhook shared_secret masked. Pass reveal_secret: true only if the user explicitly asks to see it.',
      });
    }
    return result;
  },
};

const listGames: McpToolDefinition = {
  tool: {
    name: 'cardtrader_list_games',
    description:
      'CardTrader: list all games supported on the platform (Magic, Pokémon, Yu-Gi-Oh!, etc.). Returns each game with its numeric `id` — needed to scope other queries.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    return asResult('GET /games', await ctGet('/games'));
  },
};

const listCategories: McpToolDefinition = {
  tool: {
    name: 'cardtrader_list_categories',
    description:
      'CardTrader: list product categories. Optional `game_id` narrows to one game. Categories distinguish singles, sealed product, accessories, etc.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        game_id: { type: 'number', description: 'Optional. Filter categories by game id (from cardtrader_list_games).' },
      },
    },
  },
  async handler(args) {
    return asResult('GET /categories', await ctGet('/categories', { game_id: args.game_id as number | undefined }));
  },
};

const listExpansions: McpToolDefinition = {
  tool: {
    name: 'cardtrader_list_expansions',
    description:
      'CardTrader: list every expansion (set) across all games. Response is large — cache the `id` you need and reuse it.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    return asResult('GET /expansions', await ctGet('/expansions'));
  },
};

const listBlueprints: McpToolDefinition = {
  tool: {
    name: 'cardtrader_list_blueprints',
    description:
      'CardTrader: list sellable items (blueprints). A blueprint is one card printing — distinct from a marketplace listing. Pass `expansion_id` to scope (strongly recommended; unscoped responses can be huge).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        expansion_id: { type: 'number', description: 'Recommended. Expansion id from cardtrader_list_expansions.' },
      },
    },
  },
  async handler(args) {
    return asResult(
      'GET /blueprints/export',
      await ctGet('/blueprints/export', { expansion_id: args.expansion_id as number | undefined }),
    );
  },
};

// ---------------------------------------------------------------------------
// Marketplace
// ---------------------------------------------------------------------------

const searchProducts: McpToolDefinition = {
  tool: {
    name: 'cardtrader_search_products',
    description:
      'CardTrader: search the marketplace for current listings. One of `blueprint_id` or `expansion_id` is REQUIRED. Optional filters: `foil`, `language`, `only_zero` (CardTrader Zero / hub-eligible sellers only). Returns active offers with price, condition, seller, quantity. Rate limit: 10 req/s.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        blueprint_id: { type: 'number', description: 'Most specific. Filters to one card printing.' },
        expansion_id: { type: 'number', description: 'Broader. Filters to one set.' },
        foil: { type: 'boolean', description: 'Optional. true = foil only, false = non-foil only.' },
        language: { type: 'string', description: 'Optional. Language code (e.g. "en", "it", "jp", "de", "fr").' },
        only_zero: {
          type: 'boolean',
          description:
            'Optional. If true, keep only listings from sellers eligible for CardTrader Zero (user.can_sell_via_hub === true). Filter is applied client-side after fetch.',
        },
      },
    },
  },
  async handler(args) {
    const blueprintId = args.blueprint_id as number | undefined;
    const expansionId = args.expansion_id as number | undefined;
    if (!blueprintId && !expansionId) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Missing required parameter: provide either blueprint_id or expansion_id.',
          },
        ],
      };
    }
    const r = await ctGet('/marketplace/products', {
      blueprint_id: blueprintId,
      expansion_id: expansionId,
      foil: args.foil as boolean | undefined,
      language: args.language as string | undefined,
    });
    if (r.ok && args.only_zero === true && r.body) {
      const filterArr = (arr: unknown[]): unknown[] =>
        arr.filter((l) => {
          const obj = l as { user?: { can_sell_via_hub?: boolean } } | null;
          return obj?.user?.can_sell_via_hub === true;
        });
      if (Array.isArray(r.body)) {
        r.body = filterArr(r.body);
      } else if (typeof r.body === 'object') {
        const obj = r.body as Record<string, unknown>;
        for (const k of Object.keys(obj)) {
          if (Array.isArray(obj[k])) obj[k] = filterArr(obj[k] as unknown[]);
        }
      }
    }
    return asResult('GET /marketplace/products', r);
  },
};

const listShippingMethods: McpToolDefinition = {
  tool: {
    name: 'cardtrader_list_shipping_methods',
    description:
      'CardTrader: list shipping methods offered by a specific seller. Use after picking an offer in cardtrader_search_products to show realistic total cost.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        username: { type: 'string', description: 'Required. CardTrader seller username.' },
      },
      required: ['username'],
    },
  },
  async handler(args) {
    return asResult(
      'GET /shipping_methods',
      await ctGet('/shipping_methods', { username: args.username as string }),
    );
  },
};

// ---------------------------------------------------------------------------
// Cart (read-only view)
// ---------------------------------------------------------------------------

const getCart: McpToolDefinition = {
  tool: {
    name: 'cardtrader_get_cart',
    description:
      'CardTrader: read the authenticated user\'s current cart. Read-only — this MCP does not expose cart writes or purchase.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    return asResult('GET /cart', await ctGet('/cart'));
  },
};

// ---------------------------------------------------------------------------
// Wishlists (read-only)
// ---------------------------------------------------------------------------

const listWishlists: McpToolDefinition = {
  tool: {
    name: 'cardtrader_list_wishlists',
    description: 'CardTrader: list the authenticated user\'s wishlists. Supports pagination and game filter.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        page: { type: 'number', description: 'Optional. Page number (1-based).' },
        limit: { type: 'number', description: 'Optional. Items per page.' },
        game_id: { type: 'number', description: 'Optional. Restrict to one game.' },
      },
    },
  },
  async handler(args) {
    return asResult(
      'GET /wishlists',
      await ctGet('/wishlists', {
        page: args.page as number | undefined,
        limit: args.limit as number | undefined,
        game_id: args.game_id as number | undefined,
      }),
    );
  },
};

const getWishlist: McpToolDefinition = {
  tool: {
    name: 'cardtrader_get_wishlist',
    description: 'CardTrader: fetch a single wishlist with its full content (deck items, quantities, etc.).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Required. Wishlist id from cardtrader_list_wishlists.' },
      },
      required: ['id'],
    },
  },
  async handler(args) {
    return asResult(`GET /wishlists/${args.id}`, await ctGet(`/wishlists/${args.id}`));
  },
};

// ---------------------------------------------------------------------------
// Inventory (the user's own stock — read-only views)
// ---------------------------------------------------------------------------

const listUserExpansions: McpToolDefinition = {
  tool: {
    name: 'cardtrader_list_user_expansions',
    description:
      'CardTrader: list the expansions the authenticated user has stock in. Useful to scope a follow-up cardtrader_list_user_products query.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    return asResult('GET /expansions/export', await ctGet('/expansions/export'));
  },
};

const listUserProducts: McpToolDefinition = {
  tool: {
    name: 'cardtrader_list_user_products',
    description:
      'CardTrader: list the authenticated user\'s own products (their inventory). Filter by `blueprint_id` for one printing or `expansion_id` for one set. Unfiltered responses can be huge.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        blueprint_id: { type: 'number', description: 'Optional. Most specific filter.' },
        expansion_id: { type: 'number', description: 'Optional. Filter by set.' },
      },
    },
  },
  async handler(args) {
    return asResult(
      'GET /products/export',
      await ctGet('/products/export', {
        blueprint_id: args.blueprint_id as number | undefined,
        expansion_id: args.expansion_id as number | undefined,
      }),
    );
  },
};

const getJob: McpToolDefinition = {
  tool: {
    name: 'cardtrader_get_job',
    description:
      'CardTrader: check the status of an async bulk job by UUID. Rate limit: 1 req/s. (Useful when inspecting a job started outside this MCP, since bulk endpoints are not exposed here.)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        uuid: { type: 'string', description: 'Required. Job UUID.' },
      },
      required: ['uuid'],
    },
  },
  async handler(args) {
    return asResult(`GET /jobs/${args.uuid}`, await ctGet(`/jobs/${args.uuid}`));
  },
};

const getProductImport: McpToolDefinition = {
  tool: {
    name: 'cardtrader_get_product_import',
    description: 'CardTrader: status of a CSV product import by id.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Required. Product import id.' },
      },
      required: ['id'],
    },
  },
  async handler(args) {
    return asResult(`GET /product_imports/${args.id}`, await ctGet(`/product_imports/${args.id}`));
  },
};

const getProductImportSkipped: McpToolDefinition = {
  tool: {
    name: 'cardtrader_get_product_import_skipped',
    description: 'CardTrader: list rows skipped during a CSV product import (errors, unmatched blueprints, etc.).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Required. Product import id.' },
      },
      required: ['id'],
    },
  },
  async handler(args) {
    return asResult(`GET /product_imports/${args.id}/skipped`, await ctGet(`/product_imports/${args.id}/skipped`));
  },
};

// ---------------------------------------------------------------------------
// Orders (read-only)
// ---------------------------------------------------------------------------

const listOrders: McpToolDefinition = {
  tool: {
    name: 'cardtrader_list_orders',
    description:
      'CardTrader: list the authenticated user\'s orders. All filters optional. `order_as` chooses buyer or seller perspective; `state` filters by lifecycle stage.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        page: { type: 'number', description: 'Page number (1-based).' },
        limit: { type: 'number', description: 'Items per page.' },
        from: { type: 'string', description: 'ISO date — orders updated on/after.' },
        to: { type: 'string', description: 'ISO date — orders updated on/before.' },
        from_id: { type: 'number', description: 'Lower bound order id.' },
        to_id: { type: 'number', description: 'Upper bound order id.' },
        state: { type: 'string', description: 'Order state (e.g. "paid", "shipped", "cancelled").' },
        order_as: { type: 'string', enum: ['buyer', 'seller'], description: 'Perspective.' },
        sort: { type: 'string', description: 'Sort field (e.g. "updated_at_desc").' },
      },
    },
  },
  async handler(args) {
    return asResult(
      'GET /orders',
      await ctGet('/orders', {
        page: args.page as number | undefined,
        limit: args.limit as number | undefined,
        from: args.from as string | undefined,
        to: args.to as string | undefined,
        from_id: args.from_id as number | undefined,
        to_id: args.to_id as number | undefined,
        state: args.state as string | undefined,
        order_as: args.order_as as string | undefined,
        sort: args.sort as string | undefined,
      }),
    );
  },
};

const getOrder: McpToolDefinition = {
  tool: {
    name: 'cardtrader_get_order',
    description: 'CardTrader: fetch a single order with full detail (line items, addresses, tracking, state history).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Required. Order id.' },
      },
      required: ['id'],
    },
  },
  async handler(args) {
    return asResult(`GET /orders/${args.id}`, await ctGet(`/orders/${args.id}`));
  },
};

// ---------------------------------------------------------------------------
// CT0 Box items (CardTrader Zero purchases)
// ---------------------------------------------------------------------------

const listCt0BoxItems: McpToolDefinition = {
  tool: {
    name: 'cardtrader_list_ct0_box_items',
    description: 'CardTrader: list items in the user\'s CardTrader Zero (CT0) consolidated box.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    return asResult('GET /ct0_box_items', await ctGet('/ct0_box_items'));
  },
};

const getCt0BoxItem: McpToolDefinition = {
  tool: {
    name: 'cardtrader_get_ct0_box_item',
    description: 'CardTrader: detail of a single CT0 box item.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Required. CT0 box item id.' },
      },
      required: ['id'],
    },
  },
  async handler(args) {
    return asResult(`GET /ct0_box_items/${args.id}`, await ctGet(`/ct0_box_items/${args.id}`));
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerTools([
  info,
  listGames,
  listCategories,
  listExpansions,
  listBlueprints,
  searchProducts,
  listShippingMethods,
  getCart,
  listWishlists,
  getWishlist,
  listUserExpansions,
  listUserProducts,
  getJob,
  getProductImport,
  getProductImportSkipped,
  listOrders,
  getOrder,
  listCt0BoxItems,
  getCt0BoxItem,
]);
