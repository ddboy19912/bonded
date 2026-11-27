# Deployments

Bonded's contracts are deployed on three testnets. Each chain has a `<chainId>.json` file here with every address, written only after the deployment is confirmed on chain.

Addresses differ between chains, so always read them from `<chainId>.json` (or `@bondedhq/shared`), never from another chain.

## Networks

| Chain                   | Chain id | Deploy block | Explorer                                     | File                               |
| ----------------------- | -------- | ------------ | -------------------------------------------- | ---------------------------------- |
| Robinhood Chain testnet | 46630    | 139,637,933  | https://explorer.testnet.chain.robinhood.com | [`46630.json`](46630.json)         |
| Arbitrum Sepolia        | 421614   | 321,171,750  | https://sepolia.arbiscan.io                  | [`421614.json`](421614.json)       |
| Ethereum Sepolia        | 11155111 | 11,957,720   | https://sepolia.etherscan.io                 | [`11155111.json`](11155111.json)   |

`0x6eB99ec2A4b5b7379E07a53352B41D132BE5443b` owns every contract that has an owner, and is the attester, the dispute council and the cover treasury. On testnet this is a single key. The contracts were deployed by `0xd42FA5ae8949710479954ae78D1b12Ff2e50A841`, which has since been rotated out and is no longer an attester.

The waiting period is 0 on these deployments, so the demo loop runs without waiting.

**Test tokens.** tUSDG, tTSLA, tAMZN and tNVDA, with MockOracle and DemoRouter, are testnet stand-ins. They have no value.

### Robinhood Chain testnet (46630)

| Contract | Address | What it does |
|---|---|---|
| BondedRegistry | [`0x109D98d2ab039273FB07D08617FbD353Ca8747F2`](https://explorer.testnet.chain.robinhood.com/address/0x109D98d2ab039273FB07D08617FbD353Ca8747F2) | agents, scores and attesters |
| MandateVaultFactory | [`0x89cA6deC91C737A44DA7D3efc9f6Db7b1Ff23FC6`](https://explorer.testnet.chain.robinhood.com/address/0x89cA6deC91C737A44DA7D3efc9f6Db7b1Ff23FC6) | creates Mandate Vaults |
| MandateModuleFactory | [`0xbC510cec5F2011DCDdeA108086206FBd1d30b48F`](https://explorer.testnet.chain.robinhood.com/address/0xbC510cec5F2011DCDdeA108086206FBd1d30b48F) | creates MandateModules for ERC-7579 smart accounts |
| CoverManager | [`0xCbDFB40b1A53adcf142Aa784609cFe2B9F33698D`](https://explorer.testnet.chain.robinhood.com/address/0xCbDFB40b1A53adcf142Aa784609cFe2B9F33698D) | buys and renews cover |
| CoverPool | [`0xba8f66D2BBb87B66f42faE0F83Be14A180BF21F9`](https://explorer.testnet.chain.robinhood.com/address/0xba8f66D2BBb87B66f42faE0F83Be14A180BF21F9) | holds the capital that pays claims |
| OperatorBond | [`0xd0819B59E1E53160B783c7aB479De783BC6865a5`](https://explorer.testnet.chain.robinhood.com/address/0xd0819B59E1E53160B783c7aB479De783BC6865a5) | operators' bonds |
| ClaimsEngine | [`0x0e263aaE54F5562e6841b4b536f32c2ecE0A1EEd`](https://explorer.testnet.chain.robinhood.com/address/0x0e263aaE54F5562e6841b4b536f32c2ecE0A1EEd) | pays claims from on-chain breach records |
| DisputeModule | [`0xcd04e14dD1d4766A7F65117780f8Fc7a27003471`](https://explorer.testnet.chain.robinhood.com/address/0xcd04e14dD1d4766A7F65117780f8Fc7a27003471) | disputes and the council's decisions |
| BountyBoard | [`0xc76C5ecCeAE524fCb10fB4257Ba28475c0f05332`](https://explorer.testnet.chain.robinhood.com/address/0xc76C5ecCeAE524fCb10fB4257Ba28475c0f05332) | attack bounties |
| tUSDG | [`0x722211FDE33d059EA934dcA6f5D6340d098f4AE0`](https://explorer.testnet.chain.robinhood.com/address/0x722211FDE33d059EA934dcA6f5D6340d098f4AE0) | test dollar, the base asset |
| tTSLA | [`0xBE837997591B51430300cb45569ea79cDF861Fa6`](https://explorer.testnet.chain.robinhood.com/address/0xBE837997591B51430300cb45569ea79cDF861Fa6) | test token |
| tAMZN | [`0x614d52313bc2B4E0667a4ee930720430BB699801`](https://explorer.testnet.chain.robinhood.com/address/0x614d52313bc2B4E0667a4ee930720430BB699801) | test token |
| tNVDA | [`0x3CC1B76c98306D178f7ab992F6760952539022d4`](https://explorer.testnet.chain.robinhood.com/address/0x3CC1B76c98306D178f7ab992F6760952539022d4) | test token |
| MockOracle | [`0x9d7eAd687fA1C9aD6E1f5ce62CB94c7C9b008304`](https://explorer.testnet.chain.robinhood.com/address/0x9d7eAd687fA1C9aD6E1f5ce62CB94c7C9b008304) | test prices, set by the owner |
| DemoRouter | [`0x36537761aFBA9b6cBd8D8494AaCB9502B1a231F8`](https://explorer.testnet.chain.robinhood.com/address/0x36537761aFBA9b6cBd8D8494AaCB9502B1a231F8) | test swaps |
| GateAnchor | [`0x4434F0D9fEF49EE2E017fb1082C1F3EefABcf5a4`](https://explorer.testnet.chain.robinhood.com/address/0x4434F0D9fEF49EE2E017fb1082C1F3EefABcf5a4) | the payment gate's daily log roots and rule hashes |

### Arbitrum Sepolia (421614)

| Contract | Address | What it does |
|---|---|---|
| BondedRegistry | [`0x836aF1176812561d692eCb4f05303a03b078e903`](https://sepolia.arbiscan.io/address/0x836aF1176812561d692eCb4f05303a03b078e903) | agents, scores and attesters |
| MandateVaultFactory | [`0xeD9593848721E56b5f7EeAa9C1e96c05B2D910E7`](https://sepolia.arbiscan.io/address/0xeD9593848721E56b5f7EeAa9C1e96c05B2D910E7) | creates Mandate Vaults |
| MandateModuleFactory | [`0x12c386bbC1462b915F1c13eDA7669Db3d5AdD407`](https://sepolia.arbiscan.io/address/0x12c386bbC1462b915F1c13eDA7669Db3d5AdD407) | creates MandateModules for ERC-7579 smart accounts |
| CoverManager | [`0xcc1Ee2045D9A75b3192BAE13E4A0de13B7050842`](https://sepolia.arbiscan.io/address/0xcc1Ee2045D9A75b3192BAE13E4A0de13B7050842) | buys and renews cover |
| CoverPool | [`0x374855e2B2a08Be72F4d9b9D1C83D7663BEBebA4`](https://sepolia.arbiscan.io/address/0x374855e2B2a08Be72F4d9b9D1C83D7663BEBebA4) | holds the capital that pays claims |
| OperatorBond | [`0x027Da33006fD6d077854D30f15C06ECB80030E47`](https://sepolia.arbiscan.io/address/0x027Da33006fD6d077854D30f15C06ECB80030E47) | operators' bonds |
| ClaimsEngine | [`0xD695711DBa47e03940b76EF379E3648C020C91D9`](https://sepolia.arbiscan.io/address/0xD695711DBa47e03940b76EF379E3648C020C91D9) | pays claims from on-chain breach records |
| DisputeModule | [`0x61F56C5e8e3E4c260249462E5040aA5DAa45f689`](https://sepolia.arbiscan.io/address/0x61F56C5e8e3E4c260249462E5040aA5DAa45f689) | disputes and the council's decisions |
| BountyBoard | [`0xF0f77618dc5EE72B560Ab266cF4bc28F01d4FC0C`](https://sepolia.arbiscan.io/address/0xF0f77618dc5EE72B560Ab266cF4bc28F01d4FC0C) | attack bounties |
| tUSDG | [`0xbD937FDfF3CB767E1d05a46a67040F1A71F9415F`](https://sepolia.arbiscan.io/address/0xbD937FDfF3CB767E1d05a46a67040F1A71F9415F) | test dollar, the base asset |
| tTSLA | [`0xC7e5d48F66cBAe3cce2f4A00527fBF32137a34A5`](https://sepolia.arbiscan.io/address/0xC7e5d48F66cBAe3cce2f4A00527fBF32137a34A5) | test token |
| tAMZN | [`0x5D5B6ee27e881bB94b362589cab8D17d10113280`](https://sepolia.arbiscan.io/address/0x5D5B6ee27e881bB94b362589cab8D17d10113280) | test token |
| tNVDA | [`0x5A7f2d29131Ba3AC7E1CF1da5D2f5Bda1259D44C`](https://sepolia.arbiscan.io/address/0x5A7f2d29131Ba3AC7E1CF1da5D2f5Bda1259D44C) | test token |
| MockOracle | [`0xA832A97Ed8f2Cf53d92847025703A465F2764126`](https://sepolia.arbiscan.io/address/0xA832A97Ed8f2Cf53d92847025703A465F2764126) | test prices, set by the owner |
| DemoRouter | [`0x74D0485F9ad53126368C6618CD27A87984EfbA50`](https://sepolia.arbiscan.io/address/0x74D0485F9ad53126368C6618CD27A87984EfbA50) | test swaps |

### Ethereum Sepolia (11155111)

| Contract | Address | What it does |
|---|---|---|
| BondedRegistry | [`0x374855e2B2a08Be72F4d9b9D1C83D7663BEBebA4`](https://sepolia.etherscan.io/address/0x374855e2B2a08Be72F4d9b9D1C83D7663BEBebA4) | agents, scores and attesters |
| MandateVaultFactory | [`0x027Da33006fD6d077854D30f15C06ECB80030E47`](https://sepolia.etherscan.io/address/0x027Da33006fD6d077854D30f15C06ECB80030E47) | creates Mandate Vaults |
| MandateModuleFactory | [`0xF4a0aBADC795f1f78A7935205Dc73D531BDDEb33`](https://sepolia.etherscan.io/address/0xF4a0aBADC795f1f78A7935205Dc73D531BDDEb33) | creates MandateModules for ERC-7579 smart accounts |
| CoverManager | [`0x61F56C5e8e3E4c260249462E5040aA5DAa45f689`](https://sepolia.etherscan.io/address/0x61F56C5e8e3E4c260249462E5040aA5DAa45f689) | buys and renews cover |
| CoverPool | [`0xF0f77618dc5EE72B560Ab266cF4bc28F01d4FC0C`](https://sepolia.etherscan.io/address/0xF0f77618dc5EE72B560Ab266cF4bc28F01d4FC0C) | holds the capital that pays claims |
| OperatorBond | [`0xcc1Ee2045D9A75b3192BAE13E4A0de13B7050842`](https://sepolia.etherscan.io/address/0xcc1Ee2045D9A75b3192BAE13E4A0de13B7050842) | operators' bonds |
| ClaimsEngine | [`0x86b6677994DEE899d4b7D16Df78A802eEf3DF9a8`](https://sepolia.etherscan.io/address/0x86b6677994DEE899d4b7D16Df78A802eEf3DF9a8) | pays claims from on-chain breach records |
| DisputeModule | [`0xEAcc211aBe784f16daC594cB2228E9a1166035e1`](https://sepolia.etherscan.io/address/0xEAcc211aBe784f16daC594cB2228E9a1166035e1) | disputes and the council's decisions |
| BountyBoard | [`0xD695711DBa47e03940b76EF379E3648C020C91D9`](https://sepolia.etherscan.io/address/0xD695711DBa47e03940b76EF379E3648C020C91D9) | attack bounties |
| tUSDG | [`0x5D5B6ee27e881bB94b362589cab8D17d10113280`](https://sepolia.etherscan.io/address/0x5D5B6ee27e881bB94b362589cab8D17d10113280) | test dollar, the base asset |
| tTSLA | [`0x5A7f2d29131Ba3AC7E1CF1da5D2f5Bda1259D44C`](https://sepolia.etherscan.io/address/0x5A7f2d29131Ba3AC7E1CF1da5D2f5Bda1259D44C) | test token |
| tAMZN | [`0xA832A97Ed8f2Cf53d92847025703A465F2764126`](https://sepolia.etherscan.io/address/0xA832A97Ed8f2Cf53d92847025703A465F2764126) | test token |
| tNVDA | [`0x2a57aB965C4C51aebDF594Ef3307FffA57645047`](https://sepolia.etherscan.io/address/0x2a57aB965C4C51aebDF594Ef3307FffA57645047) | test token |
| MockOracle | [`0x8aADe81092D5E019ab523f65Af663843f2c2fcf4`](https://sepolia.etherscan.io/address/0x8aADe81092D5E019ab523f65Af663843f2c2fcf4) | test prices, set by the owner |
| DemoRouter | [`0x09fD7De07b56e323301c5599067Ec38a3607A27B`](https://sepolia.etherscan.io/address/0x09fD7De07b56e323301c5599067Ec38a3607A27B) | test swaps |

Earlier deployments are no longer used by the hosted service. Their addresses are in this file's git history.

## Deploying

Put a funded, testnet-only key in the repo root's `.env` as `DEPLOYER_PRIVATE_KEY` (copy [`.env.example`](../../../.env.example); a shell variable works too), then from the repo root:

```bash
pnpm contracts:deploy robinhood   # or: arbitrum, sepolia, or any RPC URL
```

Set `WAITING_PERIOD=0` in `.env` to run the demo loop right away, as these deployments do.

Extra arguments after the chain go to `forge script`. Ethereum Sepolia charges more gas to create a contract than forge expects, so give every transaction more headroom (unused gas isn't charged):

```bash
contracts/evm/script/deploy.sh sepolia --gas-estimate-multiplier 750
```

The deploy runs two steps:

1. **`Deploy.s.sol --broadcast`** deploys and writes `<chainId>.pending.json`. This file alone doesn't prove anything was deployed.
2. **`RecordDeployment.s.sol`** runs only if every transaction succeeded. It checks every address has code and the contracts are wired to each other, then writes `<chainId>.json` and deletes the pending file.

If step 2 fails on a flaky RPC, re-run it alone: `forge script script/RecordDeployment.s.sol --rpc-url <rpc>`.

If the RPC drops out during step 1, `forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast --slow --resume` sends the rest. Two things to watch:

- If a transaction was mined but forge never saw its receipt, the resume fails with "nonce too low". Fetch it (`cast receipt <hash> --rpc-url <rpc> --json`), append it to `receipts` in `broadcast/Deploy.s.sol/<chainId>/run-latest.json`, and resume again.
- The resume rewrites the pending file with wrong, simulated addresses. Rebuild it from the `contractAddress` of each CREATE in `run-latest.json` before running step 2.

Sepolia's gas price can jump. Check `cast gas-price` first, and cap a resume with `--with-gas-price 10000000 --priority-gas-price 1000000` (both are needed).

For a free dry run that simulates everything and writes nothing: `forge script script/Deploy.s.sol --rpc-url <rpc>`.

## Smoke run

This runs the demo loop against a deployment: register, vault, bond, cover, breach, claim. The claim must pay 4,500.

With only `DEPLOYER_PRIVATE_KEY` set, the deployer plays every role. Set `OPERATOR_KEY`, `AGENT_KEY`, `USER_KEY` and `ATTESTER_KEY` in `.env` to use separate wallets.

```bash
pnpm contracts:smoke robinhood   # or: arbitrum, or any RPC URL
```

| Chain                   | RPC                                           |
| ----------------------- | --------------------------------------------- |
| Robinhood Chain testnet | `https://rpc.testnet.chain.robinhood.com/rpc` |
| Arbitrum Sepolia        | `https://sepolia-rollup.arbitrum.io/rpc`      |
