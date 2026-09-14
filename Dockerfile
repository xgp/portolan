# Portolan production image (SPEC.md §55).
#
# Contains the Node runtime, Portolan, the Deno runtime the run_api_code sandbox
# requires, and SQLite (via node:sqlite, which is built into Node — no native module
# compilation, so there is no build toolchain in either stage).
#
# No secrets are baked in: credentials are supplied as environment variables at run time
# and referenced by name from the mounted configuration.

# ---- build -----------------------------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN pnpm build

# Reinstall production dependencies only.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# ---- deno ------------------------------------------------------------------
FROM denoland/deno:bin-2.9.6 AS deno

# ---- runtime ---------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

# `tini` gives the container a real init so SIGTERM reaches Portolan and the sandbox
# subprocesses are reaped rather than left as zombies.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deno /deno /usr/local/bin/deno

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json README.md LICENSE ./

# /data holds the SQLite database and the configuration file.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

ENV NODE_ENV=production \
    PORTOLAN_CONFIG=/data/config.yaml \
    PATH="/usr/local/bin:${PATH}"

USER node

EXPOSE 8765

ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/dist/cli/index.js"]
CMD ["serve"]
