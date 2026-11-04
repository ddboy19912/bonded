import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useAccount } from "wagmi";
import { gateApi } from "../lib/gate";
import { useOwnerSession } from "../lib/owner-session";
import { ConnectButton } from "../components/wallet";
import { Button, Card, EmptyState, ErrorText, Input, LinkButton, Page } from "../components/ui";

const BACK = { to: "/gate", label: "Payment gate" };

/** Stripe's rules for a company cardholder's name. */
const COMPANY = /^[A-Za-z0-9/\-&:().' ]{1,24}$/;
const twoWords = (name: string) => name.trim().split(/\s+/).length >= 2;

/**
 * Where Stripe sends the owner back after they approve Bonded (/gate/stripe-return). The company's
 * name and address make the cardholder its cards are issued to. Stripe's code lasts five minutes
 * and works once, so it's spent only when this form is sent (apps/api/GATE.md, "The card route").
 */
export function GateStripeReturn() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { isConnected } = useAccount();
  const owner = useOwnerSession();
  const session = owner.session?.session;
  const code = params.get("code");
  const state = params.get("state") ?? "";
  // The account comes back inside the state; the API checks the state is genuine.
  const accountId = state.split(".")[0] ?? "";
  const [name, setName] = useState("");
  const [line1, setLine1] = useState("");
  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [country, setCountry] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const company = name.trim();
  const countryCode = country.trim().toUpperCase();
  const nameError =
    company && (!COMPANY.test(company) || !twoWords(company))
      ? "Use at least two words and 24 characters at most: letters, numbers and / - & : ( ) . '"
      : null;
  const ready =
    company &&
    !nameError &&
    line1.trim() &&
    city.trim() &&
    postalCode.trim() &&
    /^[A-Z]{2}$/.test(countryCode);

  if (!code || !accountId)
    return (
      <Page title="Connect Stripe" back={BACK}>
        <EmptyState
          title="Stripe wasn't connected"
          action={
            <LinkButton to="/gate" kind="secondary">
              Back to the payment gate
            </LinkButton>
          }
        >
          Nothing changed. You can connect again from the gate page.
        </EmptyState>
      </Page>
    );
  return (
    <Page
      title="One last step"
      eyebrow="Connect Stripe"
      back={BACK}
      intro="Stripe is connected. Your agent's cards are issued in your company's name, so add it here."
    >
      {!isConnected && !session ? (
        <EmptyState title="Connect your wallet" action={<ConnectButton />}>
          Use the wallet that owns this gate account.
        </EmptyState>
      ) : !session ? (
        <EmptyState
          title="Sign in to finish"
          action={
            <Button loading={owner.signingIn} onClick={() => void owner.signIn()}>
              Sign in
            </Button>
          }
        >
          One signature, no gas. Do this soon: Stripe's link lasts five minutes.
        </EmptyState>
      ) : (
        <Card>
          <form
            className="flex max-w-lg flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!ready) return;
              setBusy(true);
              setError(null);
              gateApi
                .finishStripeConnect(session, accountId, {
                  code,
                  state,
                  cardholder: {
                    name: company,
                    line1: line1.trim(),
                    city: city.trim(),
                    ...(region.trim() ? { state: region.trim() } : {}),
                    postalCode: postalCode.trim(),
                    country: countryCode,
                  },
                })
                .then(() => navigate(`/gate?account=${encodeURIComponent(accountId)}`))
                .catch((e: unknown) => setError(e))
                .finally(() => setBusy(false));
            }}
          >
            <Input
              label="Company name"
              value={name}
              onChange={setName}
              placeholder="Acme Ltd"
              mono={false}
              error={nameError}
            />
            <Input
              label="Address"
              value={line1}
              onChange={setLine1}
              placeholder="1 Main St"
              mono={false}
            />
            <Input label="City" value={city} onChange={setCity} placeholder="London" mono={false} />
            <Input
              label="State or region (if you have one)"
              value={region}
              onChange={setRegion}
              placeholder="CA"
              mono={false}
            />
            <Input
              label="Postcode"
              value={postalCode}
              onChange={setPostalCode}
              placeholder="EC1A 1BB"
              mono={false}
            />
            <Input
              label="Country code"
              value={country}
              onChange={setCountry}
              placeholder="GB"
              hint="Two letters, such as US or GB."
            />
            <div>
              <Button type="submit" loading={busy} disabled={!ready}>
                Finish connecting
              </Button>
            </div>
            <ErrorText error={error} />
          </form>
        </Card>
      )}
    </Page>
  );
}
