# Multi-stage build for AIDIS MCP Server
# Optimized for minimal image size with efficient layer caching

# =============================================================================
# Build reliability (Sprint 3): transient-network self-healing
# =============================================================================
# WHY: every Docker build pulls deps from the network — `npm ci` (the registry),
# `npm rebuild sharp` (sharp's prebuilt libvips, @img/sharp-libvips-linux-x64,
# fetched as an npm optionalDependency), and `npm install -g tsx`. Each was a
# SINGLE-SHOT network call: one transient GitHub/registry timeout aborted the
# WHOLE build, which once killed a fleet deploy at the staging bake (v0.4.0).
#
# FIX (in rough order of the task's preference list):
#   1. RETRY the flaky step — `retry_net.sh` retries a network command 5x with
#      exponential backoff (5s,10s,20s,40s,80s) so a transient blip self-heals.
#      This is the floor and the real single-point-of-failure removal.
#   2. CACHING — the deps layers are already keyed on package*.json ONLY (COPY'd
#      before the install, source COPY'd after), so a clean rebuild reuses the
#      sharp/libvips layer and does not refetch. We preserve that ordering.
#   2b. npm's OWN fetch-retry knobs (NPM_CONFIG_FETCH_*) give a second, in-process
#      retry layer for partial/slow downloads beneath the shell-level retry.
#   3. Vendoring/base-image-libvips — deliberately NOT done: sharp 0.35 already
#      pins libvips as a prebuilt npm package (registry, not a GitHub release),
#      so retry+caching removes the flake without a riskier base-image change.
# The retry helper is COPY'd into each stage that does a network install.
# -----------------------------------------------------------------------------

# NODE BASE PINNED TO A PATCH: a floating `node:22-*` tag resolves to whatever image the
# build host has CACHED, so a build without --pull can stay on an older patch past a Node
# security release (22.23.4). An exact tag forces the pull. Floor asserted by mcp-server/src/tests/nodeBaseImageFloor.contract.test.ts.
# Stage 1: Dependencies stage
# Use Debian-slim (glibc) NOT alpine: the embedding stack (@xenova/transformers ->
# onnxruntime-node) ships a prebuilt glibc native binary that does not run reliably
# on alpine/musl (Ort::Exception at load). glibc base avoids that entirely.
FROM node:22.23.4-slim AS deps
WORKDIR /app

# npm's own transport-level retry/backoff (beneath the shell retry below). Cheap,
# in-process resilience for partial/slow registry downloads.
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_FACTOR=2 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=10000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000

# Shell-level retry wrapper (5x exponential backoff) for network-fetching steps.
COPY scripts/retry_net.sh /usr/local/bin/retry_net
# (.sh is executable in-repo; ensure it is in-image too, then sanity-check it.)
RUN chmod +x /usr/local/bin/retry_net && /usr/local/bin/retry_net true

# Copy package files for dependency resolution
COPY package*.json .npmrc ./
# Install only production dependencies. --ignore-scripts is kept for safety, but
# sharp (transitive via @xenova/transformers) needs its native binary installed,
# which its install script normally fetches. Run that script explicitly afterward.
# Both the `npm ci` and the sharp rebuild (which fetches prebuilt libvips) are
# wrapped in retry_net so a transient network blip self-heals instead of aborting.
RUN retry_net npm ci --only=production --ignore-scripts && \
    retry_net npm rebuild sharp && \
    npm cache clean --force

# Stage 2: Builder stage
# The server runs via tsx (runtime TS), so the "build" here is just dependency
# resolution + TS validation; the artifact the runner needs is the src/ tree.
FROM node:22.23.4-alpine AS builder
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_FACTOR=2 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=10000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000
# apk add hits the network too — retry it (use a small inline loop here since the
# retry helper isn't copied in yet, and apk runs before WORKDIR/COPY).
RUN i=1; until apk add --no-cache libc6-compat; do \
      [ "$i" -ge 5 ] && echo "apk add failed after $i tries" && exit 1; \
      echo "apk add failed (try $i) — retrying in $((i*5))s"; sleep $((i*5)); i=$((i+1)); \
    done
WORKDIR /app

# Shell-level retry wrapper for the network install below.
COPY scripts/retry_net.sh /usr/local/bin/retry_net
RUN chmod +x /usr/local/bin/retry_net && /usr/local/bin/retry_net true

# Copy package files
COPY package*.json .npmrc ./
# Install all dependencies for validation/type checking (retried for resilience).
RUN retry_net npm ci --ignore-scripts

# Copy source code
COPY . .

# Compile src/ to plain JavaScript (dist/) so operator tools run under `node` alone in the image
# (scripts/belief-cost.sh -> node dist/cli/beliefCostMain.js). A compile error FAILS
# the build here — unlike the old "no in-image tsc" note below, this one gates something real.
RUN npx tsc -p tsconfig.build.json

# NOTE: no in-image `tsc --noEmit` here. The previous `RUN npx tsc --noEmit || echo`
# swallowed all TS errors (the `|| echo` always exits 0) AND .dockerignore excludes
# tsconfig.json, so tsc ran without config — it gated nothing and was misleading.
# The real type-check gate is the CI gate Stage 2 (mcp-server `npm run type-check`), run
# before any image build; we don't ship tsconfig into the image just to re-gate it.

# Stage 3: Production runtime (Debian-slim/glibc so onnxruntime-node runs natively)
FROM node:22.23.4-slim AS runner
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_FACTOR=2 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=10000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000

# Shell-level retry wrapper for the network-fetching steps in this stage.
COPY scripts/retry_net.sh /usr/local/bin/retry_net
RUN chmod +x /usr/local/bin/retry_net && /usr/local/bin/retry_net true

# Install minimal system dependencies. apt-get update + install both hit the
# network — retry the whole sequence so a transient mirror blip self-heals.
RUN retry_net sh -c 'apt-get update && \
    apt-get install -y --no-install-recommends \
    dumb-init \
    wget \
    curl \
    ca-certificates' && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user for security
RUN groupadd -g 1001 aidis && \
    useradd -r -u 1001 -g aidis aidis

WORKDIR /app

# Copy production dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package*.json ./

# -----------------------------------------------------------------------------
# Bake the local embedding model INTO the image.
# WHY: HF migrated the model file to its "Xet" backend, which returns 403 to the
# @xenova/transformers@2 client — so the previous RUNTIME download (on first embed)
# now fails and, because context_store embeds BEFORE the DB insert, silently loses
# the write. Baking the model means the process never touches the HF network.
# The model is vendored in-repo at mcp-server/vendor/models/... and copied into the
# @xenova default cache dir (node_modules/@xenova/transformers/.cache), which is the
# exact path localModel.ts loads from offline (allowRemoteModels=false).
# Placed AFTER the `COPY --from=deps ... ./node_modules` above so it is NOT clobbered.
ARG EMBEDDING_MODEL_MD5=704fb8674c8a2e729e0f6b71905d66f8
COPY --chown=aidis:aidis vendor/models/Xenova/all-MiniLM-L6-v2/ \
     /app/node_modules/@xenova/transformers/.cache/Xenova/all-MiniLM-L6-v2/
# BUILD GATE (fail-closed): abort the build if the baked model is absent or its
# checksum drifts. A claim isn't a check — this proves the weld held at build time.
RUN set -eu; \
    MODEL=/app/node_modules/@xenova/transformers/.cache/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx; \
    test -f "$MODEL" || { echo "FATAL build gate: baked embedding model missing at $MODEL"; exit 1; }; \
    echo "${EMBEDDING_MODEL_MD5}  $MODEL" | md5sum -c - \
      || { echo "FATAL build gate: embedding model md5 mismatch (expected ${EMBEDDING_MODEL_MD5})"; exit 1; }; \
    echo "BUILD GATE OK: embedding model baked + md5 verified (${EMBEDDING_MODEL_MD5})"

# Install tsx globally for runtime compilation (retried for network resilience).
RUN retry_net npm install -g tsx@latest && \
    npm cache clean --force

# Copy source code for tsx runtime compilation
COPY --from=builder /app/src ./src
# Compiled JavaScript of src/ (runnable with node alone, e.g. dist/cli/beliefCostMain.js).
COPY --from=builder /app/dist ./dist
# Copy migration runner + SQL files so the container self-provisions its schema,
# and .env.example which dotenv-safe validates required env vars against.
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/database ./database
# The vendored SCOWL English word list (SEARCH P2a, migration 091). services/englishWords.ts
# reads it at runtime and THROWS if it is missing, deliberately — the alternative is an empty
# word set, which silently reports every word in the language as "not English". It is a repo
# file rather than an apt package precisely so the answer cannot depend on what happens to be
# installed on a box; this line is what makes that true inside the image too.
COPY --from=builder /app/vendor/wordlists ./vendor/wordlists
COPY --from=builder /app/.env.example ./.env.example
# Container entrypoint: run idempotent migrations, then start the server.
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh

# Create necessary directories and set permissions
RUN mkdir -p /app/logs /app/data /app/temp && \
    chmod +x /app/docker-entrypoint.sh && \
    chown -R aidis:aidis /app

# Switch to non-root user
USER aidis

# Expose port (HTTP bridge)
EXPOSE 8080

# Enhanced health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health 2>/dev/null || \
        curl -f http://localhost:8080/health 2>/dev/null || \
        node -e "console.log('MCP Server health check')" || exit 1

# Environment optimization
ENV NODE_ENV=production \
    AIDIS_LOG_LEVEL=info \
    AIDIS_SKIP_DATABASE=false \
    NODE_OPTIONS="--max-old-space-size=256" \
    NPM_CONFIG_LOGLEVEL=warn \
    # Defense-in-depth for the singleton-lock-survives-restart outage (2026-06-27,
    # an earlier decision): keep the lock on tmpfs (/dev/shm), NOT on the container's
    # ephemeral writable layer (default cwd /app/aidis.pid). /dev/shm is a fresh tmpfs
    # on every container start, so a `docker restart`/host reboot ALWAYS starts
    # lock-free — no stale pid file to reclaim in the first place. The start-time
    # disambiguation in processLock.ts is the in-code class-fix; this is belt-and-
    # braces for the fleet image. Path is fully env-driven (AIDIS_LOCK_FILE), so prod
    # systemd (real disk) is unaffected — it never builds this image.
    AIDIS_LOCK_FILE=/dev/shm/aidis.pid

# -----------------------------------------------------------------------------
# RELEASE REVISION -> the process
# The reported product version is `<semver>+<revision>` (see src/version.ts). The
# revision MUST come from the same compose variable that stamps
# org.opencontainers.image.revision, so the image label and the version a client
# sees cannot disagree. docker-compose.build.yml passes MANDREL_IMAGE_REVISION as
# BOTH a build arg (here) and the label — one variable, two consumers.
# The label is image metadata and is not readable from inside the container, so
# this ARG->ENV is the only way the running process can know its own ref.
#
# DELIBERATELY THE LAST LAYER-AFFECTING INSTRUCTION IN THIS STAGE: the value
# changes on every release ref, so anything below it would be rebuilt every roll.
# An absent/blank value is NOT an error here — src/version.ts reports `+unknown`,
# which is the honest reading for a non-fleet build. The fail-closed requirement
# lives where it belongs, on the compose variable that labels the image.
ARG MANDREL_IMAGE_REVISION=""
ENV MANDREL_IMAGE_REVISION=${MANDREL_IMAGE_REVISION}

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Run idempotent migrations, then exec the server (see docker-entrypoint.sh)
CMD ["./docker-entrypoint.sh"]
