# node:20-alpine, pinned by digest so the same Dockerfile always builds on the same base
ARG NODE_IMAGE=node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

FROM ${NODE_IMAGE} AS base

WORKDIR /app

# pnpm comes from corepack, at the version and hash pinned in package.json
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

COPY package.json pnpm-lock.yaml ./

FROM base AS builder

RUN pnpm install --frozen-lockfile

COPY . .

# Fetch the pinned circuit artifacts
RUN pnpm circuits:fetch

RUN pnpm build

FROM base AS prod-deps

# pnpm's state files record the install time, which would make the image digest differ per build
RUN pnpm install --prod --frozen-lockfile \
  && rm -f node_modules/.modules.yaml node_modules/.pnpm-workspace-state-v1.json

# Runtime stage: dist, production dependencies and the verification key only, no pnpm
FROM ${NODE_IMAGE}

WORKDIR /app

COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Copy the verification key of the production request circuit
COPY --from=builder /app/circuits/build/api_request_verification_key.json ./circuits/build/

EXPOSE 3000

CMD ["node", "dist/src/main.js"]
