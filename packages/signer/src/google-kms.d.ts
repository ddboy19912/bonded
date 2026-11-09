// @google-cloud/kms is an optional peer dependency, loaded only when a Google KMS key is used.
// This keeps the build from needing it; `GoogleKmsClient` in keys.ts is the part the signer calls.
declare module "@google-cloud/kms" {
  export class KeyManagementServiceClient {
    constructor(options?: Record<string, unknown>);
  }
}
