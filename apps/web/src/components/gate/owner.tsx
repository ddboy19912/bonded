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

/**
 * Shows its children to the signed-in owner, and asks for the wallet and sign-in until then, in
 * `page`: the page around the ask.
 */
export function SignedIn({
  page,
  children,
}: {
  page: (body: ReactNode) => ReactNode;
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
          <EmptyDescription>The gate accounts your wallet owns show here.</EmptyDescription>
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
          <EmptyTitle>Sign in to see them</EmptyTitle>
          <EmptyDescription>One signature, no gas.</EmptyDescription>
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
