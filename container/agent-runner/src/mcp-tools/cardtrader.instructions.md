## CardTrader (read-only)

You have a suite of `cardtrader_*` MCP tools that wrap the CardTrader Full API v2. They are READ-ONLY by design — no cart writes, no purchases, no inventory mutations.

**When to use**

- The user asks about card prices, availability, expansions, or marketplace listings on CardTrader.
- The user wants to inspect their own CardTrader account: cart contents, wishlists, inventory, orders, CT0 box.

**Auth**

Authentication is transparent: the OneCLI gateway injects the CardTrader bearer token for any request to `api.cardtrader.com`. You don't see or handle the token. If you get a 401, the token isn't configured in the vault — tell the user and stop, don't retry.

**Tool families**

- Reference: `cardtrader_info`, `cardtrader_list_games`, `cardtrader_list_categories`, `cardtrader_list_expansions`, `cardtrader_list_blueprints`.
- Marketplace: `cardtrader_search_products` (the price-lookup tool — needs `blueprint_id` or `expansion_id`), `cardtrader_list_shipping_methods`.
- Account: `cardtrader_get_cart`, `cardtrader_list_wishlists`, `cardtrader_get_wishlist`.
- Inventory (user's own stock): `cardtrader_list_user_expansions`, `cardtrader_list_user_products`, `cardtrader_get_job`, `cardtrader_get_product_import`, `cardtrader_get_product_import_skipped`.
- Orders: `cardtrader_list_orders`, `cardtrader_get_order`.
- CardTrader Zero: `cardtrader_list_ct0_box_items`, `cardtrader_get_ct0_box_item`.

**Price lookup workflow**

To answer "how much does card X cost on CardTrader?":

1. `cardtrader_list_games` → find the game id (cache it; rarely changes).
2. `cardtrader_list_expansions` → find the expansion id for the printing the user means. If ambiguous, ask the user which set.
3. `cardtrader_list_blueprints` with that `expansion_id` → find the specific blueprint id for the card.
4. `cardtrader_search_products` with `blueprint_id` (plus optional `foil`/`language`) → get current listings.
5. Present: lowest price, condition, language, seller, plus a couple of representative tiers if prices vary.

If the user gives a card name only, do step 3 by scanning blueprint names within the expansion. If multiple expansions are plausible, ask before fetching listings.

**Rate limits**

- Global: 200 req / 10s.
- `cardtrader_search_products`: 10 req/s.
- `cardtrader_get_job`: 1 req/s.

Batch your queries. Don't loop unbounded scans of `cardtrader_list_expansions` or `cardtrader_list_blueprints` without an `expansion_id` — responses are huge and will eat context.

**Output**

Each tool returns the raw JSON body with an `HTTP <status>` header line. On errors, the tool includes a one-line diagnostic hint (401 → vault not configured, 429 → rate-limited, etc.). Summarise for the user; don't dump full JSON unless they ask.

**Limitations to disclose if asked**

- No cart add/remove or checkout.
- No inventory create/update/delete or bulk operations.
- No order actions (shipping, cancellation).
- No wishlist create/delete.

For those, the user must use the CardTrader website directly.
