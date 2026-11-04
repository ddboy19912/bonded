import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Button } from "@/components/shadcn/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/shadcn/empty";
import { Submit, TextField, useAction } from "../components/gate/common";
import { SignedIn } from "../components/gate/owner";
import { Card, ErrorText, Page } from "../components/ui";
import { gateApi } from "../lib/gate";

const BACK = { to: "/gate", label: "Payment gate" };

/** Stripe's rules for a company cardholder's name. */
const COMPANY = /^[A-Za-z0-9/\-&:().' ]{1,24}$/;
const twoWords = (name: string) => name.trim().split(/\s+/).length >= 2;

const WORDS = {
  wallet: "Use the wallet that owns this gate account.",
  signIn: "Sign in to finish",
  signInHint: "One signature, no gas. Do this soon: Stripe's link lasts five minutes.",
};

/** The company its cards are issued to. Sending this spends Stripe's code. */
function Company({
  session,
  accountId,
  code,
  state,
}: {
  session: string;
  accountId: string;
  code: string;
  state: string;
}) {
  const navigate = useNavigate();
  const action = useAction();
  const [name, setName] = useState("");
  const [line1, setLine1] = useState("");
  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [country, setCountry] = useState("");
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
  return (
    <Card>
      <form
        className="flex max-w-lg flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready) return;
          void action.run(async () => {
            await gateApi.finishStripeConnect(session, accountId, {
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
            });
            await navigate(`/gate/${encodeURIComponent(accountId)}?tab=cards`);
          });
        }}
      >
        <TextField
          label="Company name"
          value={name}
          onChange={setName}
          placeholder="Acme Ltd"
          mono={false}
          error={nameError}
        />
        <TextField
          label="Address"
          value={line1}
          onChange={setLine1}
          placeholder="1 Main St"
          mono={false}
        />
        <TextField label="City" value={city} onChange={setCity} placeholder="London" mono={false} />
        <TextField
          label="State or region (if you have one)"
          value={region}
          onChange={setRegion}
          placeholder="CA"
          mono={false}
        />
        <TextField
          label="Postcode"
          value={postalCode}
          onChange={setPostalCode}
          placeholder="EC1A 1BB"
          mono={false}
        />
        <TextField
          label="Country code"
          value={country}
          onChange={setCountry}
          placeholder="GB"
          hint="Two letters, such as US or GB."
        />
        <ErrorText error={action.error} />
        <div>
          <Submit busy={action.busy} disabled={!ready}>
            Finish connecting
          </Submit>
        </div>
      </form>
    </Card>
  );
}

/**
 * Where Stripe sends the owner back after they approve Bonded (/gate/stripe-return). The company's
 * name and address make the cardholder its cards are issued to. Stripe's code lasts five minutes
 * and works once, so it's spent only when this form is sent (apps/api/GATE.md, "The card route").
 */
export function GateStripeReturn() {
  const [params] = useSearchParams();
  const code = params.get("code");
  const state = params.get("state") ?? "";
  // The account comes back inside the state; the API checks the state is genuine.
  const accountId = state.split(".")[0] ?? "";
  if (!code || !accountId)
    return (
      <Page title="Connect Stripe" back={BACK}>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Stripe wasn't connected</EmptyTitle>
            <EmptyDescription>
              Nothing changed. You can connect again from the gate page.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild variant="outline">
              <Link to="/gate">Back to the payment gate</Link>
            </Button>
          </EmptyContent>
        </Empty>
      </Page>
    );
  return (
    <SignedIn
      words={WORDS}
      page={(body) => (
        <Page title="One last step" eyebrow="Connect Stripe" back={BACK}>
          {body}
        </Page>
      )}
    >
      {(session) => (
        <Page
          title="One last step"
          eyebrow="Connect Stripe"
          back={BACK}
          intro="Stripe is connected. Your agent's cards are issued in your company's name, so add it here."
        >
          <Company session={session} accountId={accountId} code={code} state={state} />
        </Page>
      )}
    </SignedIn>
  );
}
