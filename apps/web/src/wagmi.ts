import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  injectedWallet,
  metaMaskWallet,
  phantomWallet,
  rabbyWallet,
  rainbowWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { createConfig, http, type Connector } from "wagmi";
import { robinhoodTestnet, rpcUrl } from "./config";

const projectId =
  (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined)?.trim() ?? "";
const connectors = connectorsForWallets(
  [
    {
      groupName: "Wallets",
      wallets: [
        phantomWallet,
        rabbyWallet,
        ...(projectId ? [metaMaskWallet, rainbowWallet, walletConnectWallet] : []),
        injectedWallet,
      ],
    },
  ],
  // Injected wallets do not use a project ID. QR/mobile connectors require a real one.
  { appName: "Bonded", projectId },
);

/** RainbowKit owns wallet selection and connection. Reads use the configured chain RPC. */
export const wagmiConfig = createConfig({
  chains: [robinhoodTestnet],
  connectors,
  transports: { [robinhoodTestnet.id]: http(rpcUrl) },
});

/**
 * Connecting never asks the wallet to change networks. RainbowKit asks for Robinhood Chain testnet
 * at connect, and wagmi cancels the whole connection when the wallet refuses or can't add the
 * network, so such a wallet couldn't even sign in (a signed message, which works on any network).
 * Transactions ask for the network themselves, right before they send (lib/network.ts).
 */
const leaveNetwork = (connectors: readonly Connector[]) => {
  for (const connector of connectors) {
    const tagged = connector as Connector & { leavesNetwork?: true };
    if (tagged.leavesNetwork) continue;
    const connect = connector.connect.bind(connector);
    tagged.connect = ((params) => connect({ ...params, chainId: undefined })) as typeof connect;
    tagged.leavesNetwork = true;
  }
};
leaveNetwork(wagmiConfig.connectors);
// Wallets found later (EIP-6963: Talisman, Rabby, Phantom…) join the list after startup.
wagmiConfig._internal.connectors.subscribe(leaveNetwork);

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
