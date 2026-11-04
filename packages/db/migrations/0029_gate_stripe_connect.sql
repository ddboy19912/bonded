-- A gate account can link Stripe two ways: with its own restricted key (key_ciphertext), or by
-- connecting its Stripe account to Bonded's platform (connected_account), where Bonded calls
-- Stripe with its platform key on that account's behalf and stores no customer key.
ALTER TABLE gate_stripe_links
  ALTER COLUMN key_ciphertext DROP NOT NULL,
  ADD COLUMN connected_account text,
  ADD CONSTRAINT gate_stripe_links_one_way
    CHECK ((key_ciphertext IS NULL) <> (connected_account IS NULL));
