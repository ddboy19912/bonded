/**
 * Whether a sidebar link matches the current address. Links to one page with and without
 * `?mine=1` ("Agents" and "Your agents", "Cover pool" and "Your underwriting") are different
 * entries, so only the one whose `mine` matches is active. `except` lists child pages that have
 * their own link (Test your agent sits under /agents, Verify a receipt under /gate), so the parent
 * link stays quiet there.
 */
export function isNavActive(
  to: string,
  pathname: string,
  search: string,
  end = false,
  except: readonly string[] = [],
): boolean {
  const [path, query = ""] = to.split("?");
  const mine = (q: string) => new URLSearchParams(q).get("mine") === "1";
  const under = (p: string) => pathname === p || pathname.startsWith(`${p}/`);
  const onPath = end ? pathname === path : under(path!);
  return onPath && !except.some(under) && mine(query) === mine(search);
}

/** The pages that live on the test chain: agents and their vaults, claims, the pool, bounties. */
const ON_CHAIN = ["/agents", "/vaults", "/claims", "/underwrite", "/bounties", "/arena"];
/** Pages under an on-chain path that have nothing to do with the chain. */
const OFF_CHAIN = ["/agents/test"];

/**
 * Whether a page shows on-chain state, and so wears the TESTNET badge and the test-token note.
 * Testing an agent, the payment gate and the benchmarks are not testnet things.
 */
export function isOnChainPath(pathname: string): boolean {
  const under = (p: string) => pathname === p || pathname.startsWith(`${p}/`);
  return ON_CHAIN.some(under) && !OFF_CHAIN.some(under);
}
