# Ops dashboard

A small local page that shows whether everything Bonded pays for or depends on is still running. It is never deployed.

```bash
pnpm ops
```

Then open http://127.0.0.1:4545. The page checks again every 5 minutes.

## What it checks

- **Services:** the API's `/status` (API and Arena gateway lanes), the web app and the blog.
- **Gas wallets:** the testnet ETH balance of every wallet key found in `.env` (keeper, deployer, demo agent, bounty hunter, and the demo roles). The keeper matters most. If it runs dry, on-chain actions stop.
- **Credits:** OpenRouter credits left, read with `OPENROUTER_API_KEY`.
- **Check by hand:** Railway, Phala, Vercel, GitHub billing and the domain renewal. These have no simple API, so the page links to each dashboard.

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

The server binds to 127.0.0.1 and reads keys only on the server side, so they never reach the browser. Note that the keeper on Railway may use a different key from your local `KEEPER_KEY`. Check that the keeper address shown here matches the one Railway uses.
