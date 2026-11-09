# The x402 signer as an image. Build from the repository root:
#   docker build -f packages/signer/Dockerfile -t bonded-signer .
# Settings come from environment variables; see packages/signer/README.md.

FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@bondedhq/signer..." \
 && pnpm --filter "@bondedhq/signer..." build \
 && mkdir /packs \
 && for p in shared sdk signer; do (cd packages/$p && pnpm pack --pack-destination /packs); done

# The runtime installs the packed packages the way npm users get them, plus both KMS clients.
FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8402
WORKDIR /app
COPY --from=build /packs /packs
RUN npm init -y >/dev/null \
 && npm install --omit=dev --no-audit --no-fund /packs/*.tgz \
      @aws-sdk/client-kms@3.1164.0 @google-cloud/kms@6.3.0 \
 && rm -rf /packs ~/.npm
USER node
EXPOSE 8402
HEALTHCHECK --interval=30s --timeout=5s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "node_modules/@bondedhq/signer/dist/cli.js"]
