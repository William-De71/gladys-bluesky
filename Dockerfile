# -----------------------------------------------------------------------------
# Bluesky integration image (unofficial, not affiliated with Bluesky Social PBC).
#
# A Node.js service (the Gladys side, through the SDK) that talks to the
# official XRPC API of the AT Protocol over HTTPS: the PDS of the account
# (posts, notifications, profile) and, through it, the Bluesky chat service
# (direct messages). Everything is polled: no webhook, no public URL, no port
# exposed, no extra dependency, no native module, no install script.
#
# Gladys sandbox constraints ("the sandbox is the defense"):
#   - rootfs mounted READ-ONLY -> never write outside /data
#   - a single writable volume: /data (the session of the account, the
#     cursors of the notifications and of the messages, the counters of the
#     day; never the app password nor the text of a message)
#   - runs as a non-root user
#   - multi-arch image (linux/amd64 + linux/arm64), see build.yml
# -----------------------------------------------------------------------------

FROM node:24-alpine

# Node.js 24.22.1 is the October 2026 security release (Brotli decoder RCE,
# TLS certificate and DNS checks): never build on an older node:24 image.
RUN node -e "const [a, b, c] = process.versions.node.split('.').map(Number); \
  if (a * 1e6 + b * 1e3 + c < 24022001) throw new Error(process.version + ' predates Node.js 24.22.1');"

# The version label and the manifest label are added by build.yml.
LABEL org.opencontainers.image.title="gladys-bluesky" \
      org.opencontainers.image.description="Bluesky in Gladys Assistant: posts, direct messages and notifications over the AT Protocol (unofficial)" \
      org.opencontainers.image.source="https://github.com/William-De71/gladys-bluesky" \
      org.opencontainers.image.licenses="Apache-2.0"

# dumb-init: handles signals (SIGTERM) correctly for a graceful shutdown.
RUN apk add --no-cache dumb-init

WORKDIR /app

# Install the PROD dependencies first (better build cache). `npm ci` only:
# a lockfile out of sync with package.json must fail the build, not be
# silently re-resolved into an untested dependency tree.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Then the integration code.
COPY index.js ./
COPY src ./src
COPY gladys-assistant-integration.json LICENSE NOTICE ./

# The only writable location allowed at runtime. Docker creates a new volume
# with the owner of the image's /data, so it must belong to `node`, and before
# VOLUME: changes made to /data after it are discarded. Without this, /data is
# root-owned and the integration cannot write to it.
ENV NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# Run as an unprivileged user (already present in the node image).
USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
