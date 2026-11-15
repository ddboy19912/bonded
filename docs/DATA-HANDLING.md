# How Bonded handles your data

This is Bonded's privacy page. It says what Bonded keeps when you test an agent, how long it keeps it, who sees it, and how to have it deleted. Questions: hello@bondedhq.xyz.

## What Bonded keeps, and for how long

| What | What it is | How long |
|---|---|---|
| Test traces | Each tool call your agent made in a test and the answer it got, as streamed live during previews, ratings and connection checks | 30 days, then deleted automatically |
| Reports and scores | The report after a preview or rating, including the parts of a trace that show each finding | Until you ask Bonded to delete them |
| What you give Bonded to run | For "Bonded runs it": the instructions or code file you paste, and the model you pick | While that agent is set up. Changing it replaces the old one |
| Your account | Your email address, and your passkeys' public keys. Bonded never receives a passkey's private key | While you have an account |
| Sign-in codes and passkey challenges | One-time values used to sign you in | Deleted a day after they're made |
| Sessions | What keeps you signed in for 12 hours | Deleted a day after they expire |
| Inbox notifications | The notices on your inbox page | 90 days |
| Payment-gate decisions (test mode) | Each payment check and its decision, in the gate's signed daily log | 365 days: the daily log needs them to prove each decision |

## Who sees it

- **Only you see your previews.** A preview's report is visible only to the account or wallet that started it. Bonded never puts it on the leaderboard or the Index.
- **Official ratings you choose to post are public.** A rating posted on chain can't be removed from the chain. That's your choice: a preview never posts anything.
- **AI model providers see the test's messages.** To run a test, the messages in it go to the model your agent uses (for "Bonded runs it", through Bonded's account with that model's provider). Some results are also judged by a model. Those providers' own terms apply.
- **Nobody else.** Bonded uses your data only to run your tests and improve its testing. It doesn't sell it or share it.

## Your email address

If you sign in with email, Bonded uses your address to send your sign-in codes and the notifications you turn on. Nothing else: no newsletters and no marketing unless you ask for them.

## Services that handle your data

- **Vercel** hosts the website.
- **Railway** runs Bonded's API and its database.
- **Resend** sends Bonded's emails.
- **AI model providers** run and judge the tests, as described above.

The website has no analytics, advertising or tracking cookies. Your browser keeps your sign-in so you stay signed in, and nothing else.

## What Bonded never needs

Tests run on simulated accounts, testnets and payment test modes. Bonded never needs your production credentials, real money or access to real customer accounts.

## Deleting your data

Email hello@bondedhq.xyz from the address you signed in with (or say which wallet is yours), and Bonded deletes your traces, reports, the instructions or code you gave it, and your account within 7 days.

Design partners: your pilot terms say the same, and add that Bonded deletes your reports and anything you gave it to run within 30 days of the pilot ending.

## For people running Bonded

- `EVENTS_RETENTION_DAYS` (default 30) sets how long test traces are kept: the live event stream and connection checks' step logs.
- `GATE_DECISION_RETENTION_DAYS` (default 365) sets how long the payment gate's decisions are kept.
- The clean-up runs every hour on the API's keeper role.
