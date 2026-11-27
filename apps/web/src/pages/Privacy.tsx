import type { ReactNode } from "react";
import { CONTACT_EMAIL } from "../lib/routes";
import { usePageTitle } from "../lib/page-title";
import "./landing.css";

/** What Bonded keeps, for how long. Kept in step with the clean-up in apps/api/src/main.ts. */
const KEPT: { what: string; detail: string; how: string }[] = [
  {
    what: "Test traces",
    detail:
      "Each tool call your agent made in a test and the answer it got, during previews, ratings and connection checks.",
    how: "30 days, then deleted automatically",
  },
  {
    what: "Reports and scores",
    detail:
      "The report after a preview or rating, including the parts of a trace that show each finding.",
    how: "Until you remove the preview, or ask us to delete them",
  },
  {
    what: "What you give us to run",
    detail:
      "For “Bonded runs it”: the instructions or code file you paste, and the model you pick.",
    how: "While that agent is set up. Changing it replaces the old one",
  },
  {
    what: "Your account",
    detail:
      "Your email address, and your passkeys' public keys. We never receive a passkey's private key.",
    how: "While you have an account",
  },
  {
    what: "Sign-in codes and sessions",
    detail: "The one-time codes that sign you in, and what keeps you signed in for 12 hours.",
    how: "Deleted a day after they're used or expire",
  },
  {
    what: "Inbox notifications",
    detail: "The notices on your inbox page.",
    how: "90 days",
  },
  {
    what: "Payment-gate decisions",
    detail: "Each test-mode payment check and its decision, in the gate's signed daily log.",
    how: "365 days, so the daily log can prove each decision",
  },
];

const mail = (
  <a className="l-priv-mail" href={`mailto:${CONTACT_EMAIL}`}>
    {CONTACT_EMAIL}
  </a>
);

/** One topic: its heading on the left, the text beside it, a thin rule above. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="l-priv-sec">
      <h2>{title}</h2>
      <div className="l-priv-body">{children}</div>
    </section>
  );
}

/**
 * The privacy page, on the public site, in the landing page's look: the title large, then each
 * topic as a row with its heading beside the text. Retention periods match docs/DATA-HANDLING.md.
 */
export function Privacy() {
  usePageTitle("Privacy · Bonded");
  return (
    <article className="landing l-priv">
      <header className="l-head">
        <p className="l-lab">Last updated 16 Nov 2026</p>
        <div>
          <h1 className="l-h2">Privacy</h1>
          <p className="l-lede">
            What Bonded keeps when you test an agent, how long we keep it, who sees it, and how to
            have it deleted. Questions: {mail}.
          </p>
        </div>
      </header>

      <Section title="What we keep, and for how long">
        <dl className="l-priv-kept">
          {KEPT.map((k) => (
            <div key={k.what}>
              <div>
                <dt>{k.what}</dt>
                <dd>{k.detail}</dd>
              </div>
              <dd className="l-priv-how">{k.how}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section title="Who sees it">
        <ul>
          <li>
            <strong>Only you see your previews.</strong> A preview's report is visible only to the
            account or wallet that started it, unless you make a link to share it. A shared link
            shows the report and nothing about you, and stops working when you turn it off. We never
            put a preview on the leaderboard or the Index.
          </li>
          <li>
            <strong>Official ratings you choose to post are public.</strong> A rating posted on
            chain can't be removed from the chain. A preview never posts anything.
          </li>
          <li>
            <strong>AI model providers see the test's messages.</strong> To run a test, its messages
            go to the model your agent uses, and some results are judged by a model. Those
            providers' own terms apply.
          </li>
          <li>
            <strong>Nobody else.</strong> We use your data only to run your tests and improve our
            testing. We don't sell it or share it.
          </li>
        </ul>
      </Section>

      <Section title="Your email address">
        <p>
          If you sign in with email, we use your address to send your sign-in codes and the
          notifications you turn on. Nothing else: no newsletters and no marketing unless you ask
          for them.
        </p>
      </Section>

      <Section title="Services that handle your data">
        <ul>
          <li>Vercel hosts the website.</li>
          <li>Railway runs our API and its database.</li>
          <li>Resend sends our emails.</li>
          <li>AI model providers run and judge the tests.</li>
        </ul>
        <p>
          The website has no analytics, advertising or tracking cookies. Your browser keeps your
          sign-in so you stay signed in, and nothing else.
        </p>
      </Section>

      <Section title="What we never need">
        <p>
          Tests run on simulated accounts, testnets and payment test modes. We never need your
          production credentials, real money or access to real customer accounts.
        </p>
      </Section>

      <Section title="Deleting your data">
        <p>
          To delete one preview yourself, press Remove next to it under “Your previews” on the Test
          your agent page. Its report, test traces, share link and anything you gave us to run are
          deleted at once.
        </p>
        <p>
          Email {mail} from the address you signed in with (or say which wallet is yours), and we
          delete your traces, reports, the instructions or code you gave us, and your account within
          7 days.
        </p>
        <p>
          Design partners: your pilot terms say the same, and add that we delete your reports and
          anything you gave us to run within 30 days of the pilot ending.
        </p>
      </Section>
    </article>
  );
}
