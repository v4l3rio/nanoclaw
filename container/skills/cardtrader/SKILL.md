---
name: cardtrader
description: Search card prices on CardTrader. Use whenever the user asks about card prices, buying/selling cards, market value, or comparing offers on CardTrader. Works for Magic: The Gathering, Pokémon, Yu-Gi-Oh!, and other TCGs.
allowed-tools: Bash(agent-browser:*)
---

# CardTrader Price Search

Search and extract card prices from cardtrader.com using the browser.

## Quick workflow

```bash
# 1. Search for a card
agent-browser open "https://www.cardtrader.com/en/search?q=<card+name>"
agent-browser wait --load networkidle
agent-browser snapshot -i

# 2. Click the correct card from results
agent-browser click @eN   # ref of the matching card link

# 3. Read price listings on the card page
agent-browser wait --load networkidle
agent-browser snapshot -i
```

## Search URL patterns

```bash
# General search (works across all games)
agent-browser open "https://www.cardtrader.com/en/search?q=Black+Lotus"

# Search scoped to a game
agent-browser open "https://www.cardtrader.com/en/magic/blueprints?q=Black+Lotus"
agent-browser open "https://www.cardtrader.com/en/pokemon/blueprints?q=Charizard"
agent-browser open "https://www.cardtrader.com/en/yugioh/blueprints?q=Blue-Eyes+White+Dragon"
```

## Reading prices

After navigating to a card's listing page:

1. Take a snapshot to see price listings:
   ```bash
   agent-browser snapshot -i
   ```
2. Prices are shown per seller with: price, condition (NM/EX/GD/PL), language, quantity, foil status
3. The lowest available price is usually shown at the top

## Filtering listings

After opening a card page, use the filter panel (left sidebar):
- **Language**: English, Italian, Japanese, etc.
- **Condition**: NM (Near Mint), EX (Excellent), GD (Good), PL (Poor)
- **Foil**: Regular / Foil
- **Expansion**: filter by set

```bash
# Example: filter by language after page load
agent-browser snapshot -i
# Find the language filter dropdown and click it
agent-browser click @eN   # language filter ref
agent-browser snapshot -i
agent-browser click @eN   # select "English" or other language
agent-browser wait --load networkidle
agent-browser snapshot -i
```

## Extracting price data

To get all listings in a structured way:

```bash
# Get the text content of the listings section
agent-browser snapshot -s ".product-table, [data-testid='listings'], .marketplace-listing" 
# Or get the full page snapshot and extract prices manually
agent-browser snapshot
```

## Presenting results

Always show:
- Card name and expansion/set
- Lowest price available (with condition and language)
- A few representative offers if multiple price tiers exist (NM, EX, GD)
- Currency (€ for EU sellers, $ for US sellers)
- Direct link to the card page

Example output format:
```
**Lightning Bolt** (Magic: The Gathering)
Set: Alpha Edition

💰 Prices on CardTrader:
• NM / English: €45.00 (cheapest)
• EX / English: €38.00
• GD / English: €22.00

🔗 https://www.cardtrader.com/en/magic/...
```

## Common issues

- **Captcha/bot check**: If you encounter a CAPTCHA, take a screenshot and report back to the user.
- **Ambiguous results**: If the search returns multiple cards with the same name (different sets), ask the user which set they mean before clicking.
- **No results**: Try a broader search term or check the spelling.
- **Login wall**: Most prices are visible without login. If a login is required, report back.
