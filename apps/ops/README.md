# Ops dashboard

A small local page that shows whether everything Bonded pays for or depends on is still running. It is never deployed.

```bash
pnpm ops
```

Then open http://127.0.0.1:4545. The page checks again every 5 minutes.

## What it checks

- **Services:** the API's `/status` (API, Arena gateway and its lanes), the test queue (checks and previews running and waiting; low when one has waited over 30 minutes or lost its worker), the web app, the blog and the docs.
- **Gas wallets:** the testnet ETH balance of every wallet key found in `.env` (keeper, deployer, demo agent, bounty hunter, attester, gate anchor and the demo roles), plus any address listed in `OPS_WATCH_ADDRESSES`. The keeper matters most. If it runs dry, on-chain actions stop.
- **Credits:** OpenRouter credits left, read with `OPENROUTER_API_KEY`.
- **Check by hand:** Railway, Phala, Vercel, GitHub billing, UptimeRobot, Resend and the domain renewal. These have no simple API, so the page links to each dashboard.

## Settings

All optional, in `.env`:

| Variable                 | Default                                    |
| ------------------------ | ------------------------------------------ |
| `OPS_MIN_ETH`            | `0.01` (alert when a wallet goes below it) |
| `OPS_MIN_OPENROUTER_USD` | `5`                                        |
| `OPS_PORT`               | `4545`                                     |
| `OPS_API_URL`            | the Railway API URL                        |
| `OPS_WEB_URL`            | `https://www.bondedhq.xyz`                 |
| `RPC_URL`                | the public Robinhood testnet RPC           |
| `OPS_WATCH_ADDRESSES`    | none: extra wallets to watch, `Label=0x…,Label=0x…` (no keys) |

The server binds to 127.0.0.1 and reads keys only on the server side, so they never reach the browser. Note that the keeper on Railway may use a different key from your local `KEEPER_KEY`. Check that the keeper address shown here matches the one Railway uses, and add Railway's keeper, attester and gate anchor addresses to `OPS_WATCH_ADDRESSES` when they differ.
