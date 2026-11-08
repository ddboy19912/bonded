-- Bonded no longer holds a key that can move a customer's money (apps/api/GATE.md). The card
-- route (Bonded issued cards with the customer's Stripe key, migration 0025) and the payout route
-- (payouts through a sealed Stripe key, migration 0028) are removed, and with them every key,
-- endpoint secret and record they stored. Card hooks (0031) replace the card route.
-- The decisions they made stay in the log, and the payments in gate_payments (sources 'card' and
-- 'payout'), so their receipts still verify and the limits still count them.
DROP TABLE gate_card_transactions;
DROP TABLE gate_card_authorizations;
DROP TABLE gate_card_intents;
DROP TABLE gate_stripe_events;
DROP TABLE gate_stripe_links;
DROP TABLE gate_payouts;
DROP TABLE gate_payout_links;
