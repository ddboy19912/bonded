import { useQuery } from "@tanstack/react-query";
import { byoaApi } from "./byoa-api";
import { gateApi } from "./gate";
import { useOwnerSession } from "./owner-session";

/**
 * How many tests and gate accounts the signed-in owner has (email, passkey or wallet session), for
 * the sidebar's counts and the Overview's ways in. Nothing is asked until someone is signed in, and
 * both places share one query each.
 */
export function useOwnCounts() {
  const { session } = useOwnerSession();
  const token = session?.session;
  const tests = useQuery({
    queryKey: ["previews-total", token],
    queryFn: () => byoaApi.listPreviews(token!, { limit: 1 }),
    enabled: Boolean(token),
    retry: false,
  });
  const accounts = useQuery({
    queryKey: ["gate-accounts", token],
    queryFn: () => gateApi.accounts(token!),
    enabled: Boolean(token),
    retry: false,
  });
  return {
    tests: tests.data?.total ?? tests.data?.items.length,
    accounts: accounts.data?.items.length,
  };
}
