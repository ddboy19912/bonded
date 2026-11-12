-- Agent URLs no longer have a secret (docs/AGENT-URL-SIGNED-CALLS.md): Bonded signs every call
-- with its own Ed25519 key, for the wallet that saved the URL (created_by), and the agent checks
-- that wallet is its owner. The stored secrets go, and every live URL must be verified again with
-- a handler that checks the new signatures.
ALTER TABLE agent_urls DROP COLUMN secret_ciphertext;
UPDATE agent_urls SET verified_at = NULL WHERE revoked_at IS NULL;
