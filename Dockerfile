# syntax=docker/dockerfile:1
# Learnix API / worker / migrate image (one image, role chosen at runtime).
#   api / worker : default CMD (node dist/src/main.js)
#   migrate task : override command -> node dist/src/database/migrate-cli.js run
# Build: docker build -t learnix-api .
# 24.22.1: Node.js October 2026 security release (CVE-2026-111497 Brotli, TLS/DNS fixes).
ARG NODE_VERSION=24.22.1
# Pinned by digest so every build uses the same base; Dependabot (docker ecosystem) proposes updates.
ARG NODE_DIGEST=sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

FROM node:${NODE_VERSION}-slim@${NODE_DIGEST} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:${NODE_VERSION}-slim@${NODE_DIGEST} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:${NODE_VERSION}-slim@${NODE_DIGEST} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

# Amazon RDS certificate bundle (trust anchor for RDS TLS; see DATABASE_SSL_CA_FILE). Fetched at
# build time only when RDS_CA_BUNDLE_URL is given (the AWS-published global bundle, e.g.
# https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem), so no download is baked
# into the default build. Then set DATABASE_SSL_CA_FILE=/app/certs/rds-ca-bundle.pem in the task.
ARG RDS_CA_BUNDLE_URL=
RUN if [ -n "$RDS_CA_BUNDLE_URL" ]; then \
      mkdir -p /app/certs && \
      node -e "fetch(process.argv[1]).then(r=>{if(!r.ok)throw new Error(r.status);return r.text()}).then(t=>{if(!t.includes('BEGIN CERTIFICATE'))throw new Error('not a PEM bundle');require('fs').writeFileSync('/app/certs/rds-ca-bundle.pem',t)})" "$RDS_CA_BUNDLE_URL"; \
    fi
# Debian security updates on top of the pinned base, and no package manager in the runtime: api, worker and
# migrate start `node` directly (task definitions, docker-entrypoint.sh), never npm/npx/corepack. The base
# image's perl-base and bundled npm (brace-expansion, undici) carried fixable HIGH/CRITICAL CVEs that failed
# the release scan before upstream rebuilt node:24-slim.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node --chmod=755 scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# A Windows checkout with core.autocrlf can carry CRLF into the build context; a CR in the shebang makes
# the container fail with "exec docker-entrypoint.sh: no such file or directory".
RUN sed -i 's/$//' /usr/local/bin/docker-entrypoint.sh
USER node
# The only writable path with a read-only root filesystem (ECS readonlyRootFilesystem): scratch files
# such as code exports before upload. Fargate gives a task volume mounted here the image's mode (1777).
VOLUME ["/tmp"]
EXPOSE 3000
# Run under ECS with initProcessEnabled=true so signals reach node and zombies are reaped.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/src/main.js"]
