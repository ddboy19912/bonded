# The payment gate's payout proxy for Phala dstack. Build from the repository root:
#   docker build --platform linux/amd64 -f services/payout-proxy/Dockerfile --build-arg CODE_HASH=0x<64 hex> -t bonded-payout-proxy .
# Push it, then pin the compose file to the pushed image's digest (services/payout-proxy/README.md):
# the digest is part of the compose hash the hardware measures, so the CODE_HASH baked in below is
# covered by it.
FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter "@bonded/payout-proxy..." \
 && pnpm --filter "@bonded/payout-proxy..." run build \
 && pnpm --filter @bonded/payout-proxy deploy --legacy --prod /out

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /out .
ARG CODE_HASH
RUN test -n "$CODE_HASH" || (echo "pass --build-arg CODE_HASH=0x<64 hex digits>" >&2; exit 1)
RUN mkdir -p /data && chown node:node /data
ENV CODE_HASH=$CODE_HASH NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
