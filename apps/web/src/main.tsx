import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { wagmiConfig } from "./wagmi";
import { robinhoodTestnet } from "./config";
import { AppLayout, SiteLayout } from "./App";
import { OperatorTokenProvider } from "./components/wallet";
import { Landing } from "./pages/Landing";
import { Arena } from "./pages/Arena";
import { Episode } from "./pages/Episode";
import { Agent } from "./pages/Agent";
import { Vaults } from "./pages/Vaults";
import { Vault } from "./pages/Vault";
import { Underwrite } from "./pages/Underwrite";
import { Claims } from "./pages/Claims";
import { Leaderboard } from "./pages/Leaderboard";
import { BondedIndex } from "./pages/BondedIndex";
import { IndexModel } from "./pages/IndexModel";
import { Bounties } from "./pages/Bounties";
import { NotFound } from "./pages/NotFound";
import { NewAgent } from "./pages/NewAgent";
import { TestAgent } from "./pages/TestAgent";
import { Agents } from "./pages/Agents";
import { Overview } from "./pages/Overview";
import { AttackDetail, Attacks } from "./pages/Attacks";
import { Sentinel } from "./pages/Sentinel";
import { Status } from "./pages/Status";
import { Inbox } from "./pages/Inbox";
import { Gate } from "./pages/Gate";
import { GateAccount } from "./pages/GateAccount";
import { GateVerify } from "./pages/GateVerify";
import { Privacy } from "./pages/Privacy";
import { SharedReport } from "./pages/SharedReport";
import "./index.css";

const router = createBrowserRouter([
  {
    element: <SiteLayout />,
    children: [
      { path: "/", element: <Landing /> },
      { path: "/privacy", element: <Privacy /> },
    ],
  },
  {
    element: <AppLayout />,
    children: [
      { path: "/overview", element: <Overview /> },
      { path: "/arena", element: <Arena /> },
      { path: "/arena/episodes/:eventId", element: <Episode /> },
      { path: "/attacks", element: <Attacks /> },
      { path: "/sentinel", element: <Sentinel /> },
      { path: "/attacks/:id", element: <AttackDetail /> },
      { path: "/agents", element: <Agents /> },
      { path: "/agents/new", element: <NewAgent /> },
      { path: "/agents/test", element: <TestAgent /> },
      { path: "/agents/:id", element: <Agent /> },
      { path: "/vaults", element: <Vaults /> },
      { path: "/vaults/:address", element: <Vault /> },
      { path: "/underwrite", element: <Underwrite /> },
      { path: "/claims", element: <Claims /> },
      { path: "/leaderboard", element: <Leaderboard /> },
      { path: "/index", element: <BondedIndex /> },
      { path: "/index/:model", element: <IndexModel /> },
      { path: "/bounties", element: <Bounties /> },
      { path: "/status", element: <Status /> },
      { path: "/inbox", element: <Inbox /> },
      { path: "/gate", element: <Gate /> },
      { path: "/gate/verify", element: <GateVerify /> },
      { path: "/gate/:accountId", element: <GateAccount /> },
      { path: "/shared/:token", element: <SharedReport /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000 } } });
// The wallet button and modal in the app's style: brand blue, Geist, its near-black surfaces.
const base = darkTheme({
  accentColor: "#2f5ff5",
  accentColorForeground: "#ffffff",
  borderRadius: "large",
});
const walletTheme = {
  ...base,
  fonts: { body: '"Geist Variable", "Geist", ui-sans-serif, system-ui, sans-serif' },
  colors: {
    ...base.colors,
    modalBackground: "#0d0e11",
    connectButtonBackground: "#0d0e11",
    connectButtonInnerBackground: "#141519",
    generalBorder: "rgba(255,255,255,0.1)",
  },
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider initialChain={robinhoodTestnet} theme={walletTheme} modalSize="compact">
          <OperatorTokenProvider>
            <RouterProvider router={router} />
          </OperatorTokenProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
