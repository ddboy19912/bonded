import type { ReactNode } from "react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/shadcn/empty";
import { useOwnerSession } from "../../lib/owner-session";
import { SignInButton } from "../sign-in";

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
  const owner = useOwnerSession();
  const session = owner.session?.session;
  // An email account or a wallet: the gate accounts the signed-in owner made show here.
  if (!session)
    return page(
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Sign in to see your gate accounts</EmptyTitle>
          <EmptyDescription>With your email, a passkey or a crypto wallet.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="items-center">
          <SignInButton
            wallet={{
              signIn: () => void owner.signIn(),
              signingIn: owner.signingIn,
              error: owner.error,
            }}
          />
        </EmptyContent>
      </Empty>,
    );
  return children(session);
}
