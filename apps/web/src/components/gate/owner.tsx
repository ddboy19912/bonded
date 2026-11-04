import type { ReactNode } from "react";
import { useAccount } from "wagmi";
import { Button } from "@/components/shadcn/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/shadcn/empty";
import { Spinner } from "@/components/shadcn/spinner";
import { useOwnerSession } from "../../lib/owner-session";
import { ErrorText } from "../ui";
import { ConnectButton } from "../wallet";

const WORDS = {
  wallet: "The gate accounts your wallet owns show here.",
  signIn: "Sign in to see them",
  signInHint: "One signature, no gas.",
};

/**
 * Shows its children to the signed-in owner, and asks for the wallet and sign-in until then, in
 * `page`: the page around the ask. `words` says why, where the usual reason doesn't fit.
 */
export function SignedIn({
  page,
  words = WORDS,
  children,
}: {
  page: (body: ReactNode) => ReactNode;
  words?: typeof WORDS;
  children: (session: string) => ReactNode;
}) {
  const { isConnected } = useAccount();
  const owner = useOwnerSession();
  const session = owner.session?.session;
  if (!isConnected)
    return page(
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Connect your wallet</EmptyTitle>
          <EmptyDescription>{words.wallet}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <ConnectButton />
        </EmptyContent>
      </Empty>,
    );
  if (!session)
    return page(
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{words.signIn}</EmptyTitle>
          <EmptyDescription>{words.signInHint}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button disabled={owner.signingIn} onClick={() => void owner.signIn()}>
            {owner.signingIn && <Spinner aria-hidden />}
            {owner.signingIn ? "Sign in your wallet…" : "Sign in"}
          </Button>
          <ErrorText error={owner.error} />
        </EmptyContent>
      </Empty>,
    );
  return children(session);
}
