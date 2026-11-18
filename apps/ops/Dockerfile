# The hosted ops dashboard (Railway service "ops"). Built from apps/ops on its own: it needs only
# viem, so it stays small and doesn't rebuild when the rest of the repo changes.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs checks.mjs alerts.mjs index.html ./
ENV NODE_ENV=production
USER node
CMD ["node", "server.mjs"]
