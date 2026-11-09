/**
 * @bondedhq/signer: an x402 signer the agent can't get around.
 *
 * The business runs it on its own server, with the wallet key in its own KMS (or a key file). The
 * agent gets `remoteX402Signer` from `@bondedhq/sdk/x402` and never holds the key: each x402
 * payment comes here, is checked against its payee's budget on Bonded's gate, and is signed only
 * if it fits. Bonded never holds the key.
 */
export {
  X402Signer,
  x402Signer,
  X402SignerRefusal,
  type TypedDataAccount,
  type X402Payment,
  type X402RefusedEvent,
  type X402SignedEvent,
  type X402SignerOptions,
} from "./signer.js";
export {
  serveX402Signer,
  x402SignerHandler,
  type ServeX402SignerOptions,
  type X402SignerHandlerOptions,
} from "./http.js";
export {
  awsKms,
  digestSignerAccount,
  googleKms,
  keyFileAccount,
  parseDerSignature,
  uncompressedKey,
  type AwsKmsClient,
  type DigestSigner,
  type GoogleKmsClient,
} from "./keys.js";
export {
  accountFromConfig,
  gateFromConfig,
  KEY_SOURCES,
  signerConfigFromEnv,
  type SignerConfig,
} from "./config.js";
