# node:24-alpine (Node 24.22.3, OpenSSL 3.5.9), pinned by digest so the same Dockerfile always builds on the same base
ARG NODE_IMAGE=node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5

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

# Runtime stage: dist, production dependencies, the verification key and tor only, no pnpm
FROM ${NODE_IMAGE}

# tor runs the onion service (docs/ONION_SERVICE.md). tor and its dependencies are pinned, so a
# rebuild installs the same files or fails once Alpine replaces a version. --no-scripts skips the
# tor user the package adds, since tor runs as node, and with it the build date in /etc/shadow;
# --no-logfile keeps the build time out of /var/log/apk.log
RUN apk add --no-cache --no-scripts --no-logfile \
  tor=0.4.9.17-r0 \
  libcap2=2.78-r0 \
  libevent=2.1.13-r0 \
  libseccomp=2.6.1-r0 \
  xz-libs=5.8.4-r0 \
  zstd-libs=1.5.7-r2

WORKDIR /app

COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Copy the verification key of the production request circuit
COPY --from=builder /app/circuits/build/request_verification_key.json ./circuits/build/

# Run as the image's unprivileged node user, which owns only the SQLite and Merkle tree data
RUN mkdir data && chown node:node data
USER node

EXPOSE 3000

CMD ["node", "dist/src/main.js"]
