# torch-alerts

Watches the **Torch launchpad** factory on **Robinhood Chain** and posts rich, shareable, trader-focused alerts with **custom PNG launch cards** to a public Telegram channel and to **per-user filtered DM subscribers**.

- Factory: `0x7891eA889899928aFE637e4Cca8106188427776a`
- Real Torch tokens have vanity addresses ending in **`1111`** and are verified via `factory.isTorchToken(address)`

## What each alert includes

- **Single Unified Message**: Dark-themed 1200×675 PNG launch card + formatted HTML caption + inline buttons in a single Telegram post.
- **Market Cap in USD (`$`) + ETH**: e.g. `~$5,670 (2.52 ETH)` (live ETH/USD spot conversion).
- **Key Stats**: Ticker & Name, tap-to-copy Contract Address (`…1111`), Dev Buy, Buy/Sell Tax, Pool LP Fee, Anti-Snipe decay window, Creator link, and `Liquidity Locked` badge.
- **1-Click Action & Share Buttons**:
  - `🔥 Trade $TICKER on Torch` (`https://app.torchpad.fun/trade/robinhood/{address}`)
  - `🐦 Share on X` & `📲 Share on TG` (embeds the same PNG launch card image)
  - `🔍 Token Explorer` & `🧾 Launch Tx`

## Per-User Personal Filter Commands (DM the Bot)

Any user can message the bot (`@Thorn0_Bot`) in a private chat to subscribe and set their own personal alert criteria:

- `/start` — Subscribe to receive personal DM launch alerts (receives all launches by default)
- `/setminmc <value>` — Set minimum starting market cap in ETH (e.g. `/setminmc 1.5`, or `/setminmc 0` to disable)
- `/setmaxtax <value>` — Set maximum buy tax percentage (e.g. `/setmaxtax 3` for max 3% buy tax)
- `/antisnipe [on|off]` — Only alert on launches that have anti-snipe protection enabled
- `/setmindevbuy <value>` — Set minimum initial creator buy in ETH (e.g. `/setmindevbuy 0.02`)
- `/graduated [on|off]` — Enable or disable **Graduated ("Launch Complete" ~10x)** alerts (enabled by default)
- `/setminx <number>` — Only alert on graduated tokens if the multiple is at least this value (e.g. `/setminx 10` for 10x, `/setminx 15` for 15x)
- `/filters` — Show your current personal filter settings (including graduated preferences)
- `/resetfilters` — Reset your filters to default (receive everything)
- `/stop` — Pause personal DM alerts
- `/latest` — Receive the full card & alert for the most recent launch
- `/status` — Check bot status, last scanned block, subscriber count & latest launch
- `/help` — Show available commands

### How delivery works
1. **Public Channel**: When `POST_TO_CHANNEL=true` (default), every launch passing the global `.env` filters is posted to `TELEGRAM_CHANNEL_ID`.
2. **Per-User DMs**: Each subscribed user's personal filters (stored in memory and persisted to `data/users.json`) are evaluated independently. Matching users receive the alert in their private DM with the bot.

## Setup & Run Locally

```bash
npm install
cp .env.example .env   # fill in TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID
npm run test-alert     # post ONE alert for the most recent real launch
npm run dev            # run the watcher + bot commands from TypeScript source
npm run build          # compile TypeScript to dist/
npm start              # run compiled production build (node dist/index.js)
npm test               # run unit tests
```

## Deploying to Render (Background Worker)

1. Push this repository to GitHub.
2. In the [Render Dashboard](https://dashboard.render.com/), click **New +** → **Background Worker** (or **Blueprint** to auto-import [`render.yaml`](./render.yaml)).
3. Connect your GitHub repository and configure:
   - **Runtime**: `Node`
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
4. Add the required Environment Variables in Render:
   - `RPC_URL` = `https://rpc.mainnet.chain.robinhood.com`
   - `TELEGRAM_BOT_TOKEN` = `<your BotFather token>`
   - `TELEGRAM_CHANNEL_ID` = `@your_channel` (or numeric `-100...` ID)
   - *(Optional)* Any filter or runtime variables from [`.env.example`](./.env.example).
