import type { ReactNode } from "react";
import { useOwnerSession } from "../../lib/owner-session";
import { SignInButton } from "../sign-in";
import { Section } from "../ui";

/** The three ways the gate sees a payment, for someone who hasn't signed in yet. */
const WAYS = [
  {
    title: "Ask first",
    text: "Your code asks Bonded before each payment. This is the only way to stop one.",
  },
  {
    title: "Cards",
    text: "Your card provider asks Bonded before each charge, and a charge that breaks a rule is declined.",
  },
  {
    title: "Watch",
    text: "Bonded reads payments after they're made, and alerts you. It can't stop them.",
  },
] as const;

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
      <Section
        label="Your accounts"
        title="Sign in to see your gate accounts"
        intro="With your email, a passkey or a crypto wallet."
      >
        <SignInButton
          size="lg"
          wallet={{
            signIn: () => void owner.signIn(),
            signingIn: owner.signingIn,
            error: owner.error,
          }}
        />
        <ol className="mt-14 grid gap-x-8 gap-y-8 sm:grid-cols-3" aria-label="How the gate works">
          {WAYS.map((w, i) => (
            <li key={w.title} className="flex flex-col gap-3 border-t border-line pt-4">
              <span className="eyebrow">{String(i + 1).padStart(2, "0")}</span>
              <strong className="h-section">{w.title}</strong>
              <span className="max-w-xs text-[15px] leading-relaxed text-muted">{w.text}</span>
            </li>
          ))}
        </ol>
      </Section>,
    );
  return children(session);
}
