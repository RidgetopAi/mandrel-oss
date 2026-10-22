# Multi-stage build for Mandrel Command Backend
# Optimized Node.js API server with minimal image size.
#
# BUILD CONTEXT: the mandrel-command/ npm-workspace ROOT (set in docker-compose.yml:
#   context: ./mandrel-command, dockerfile: backend/Dockerfile). This is deliberate:
#   the workspace-root package-lock.json is the SINGLE SOURCE OF TRUTH for every
#   member (backend/frontend/shared), so there is no per-member lockfile to drift.
#   We install WORKSPACE-SCOPED (`npm ci -w mandrel-command-backend`) so each image
#   only gets THIS member's dependency tree resolved deterministically from the root
#   lock — not all workspaces (no frontend/shared bloat).

# Stage 1: Dependencies stage (production-only, for the runtime node_modules)
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Copy the workspace manifests + the ROOT lockfile (single source of truth).
# Member package.json files are required so the workspace graph resolves; .npmrc
# carries workspace-wide npm settings (e.g. legacy-peer-deps for the CRA/TS5 peer).
COPY package.json package-lock.json .npmrc ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
COPY shared/package.json ./shared/

# Production deps for ONLY this workspace member, deterministic from the root lock.
RUN npm ci -w mandrel-command-backend --include-workspace-root=false \
        --omit=dev --ignore-scripts && \
    npm cache clean --force

# Stage 2: Build stage (full deps incl. dev for tsc)
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json .npmrc ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
COPY shared/package.json ./shared/

# All deps (incl. dev) for THIS member only, deterministic from the root lock.
RUN npm ci -w mandrel-command-backend --include-workspace-root=false --ignore-scripts

# Copy this member's source and build it (tsc: backend/src -> backend/dist).
COPY backend/ ./backend/
RUN npm run build -w mandrel-command-backend

# Stage 3: Production runtime
FROM node:22-alpine AS runner

# Install minimal runtime dependencies
RUN apk add --no-cache \
    dumb-init \
    wget \
    && rm -rf /var/cache/apk/*

# Create non-root user for security
RUN addgroup -g 1001 -S aidis && \
    adduser -S aidis -u 1001

WORKDIR /app

# Copy production dependencies. npm workspaces HOIST shared deps to the workspace
# root /app/node_modules, with a few version-pinned packages under the member's own
# /app/backend/node_modules — both are needed for Node's module resolution.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/backend/node_modules ./backend/node_modules
COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/backend/package.json ./backend/package.json

# Copy built application
COPY --from=builder /app/backend/dist ./backend/dist
# The launch preflight. package.json's "start" is
# `node scripts/preflight-dist.cjs && node dist/server.js`, so these two files are
# RUNTIME requirements of this image, not build-time helpers: without them `npm start`
# fails with MODULE_NOT_FOUND and the container never becomes healthy. dist/ carries
# .build-manifest.json from the builder stage; the runner ships no src/ and no
# tsconfig.json, which is the sourceless case the preflight passes on the manifest alone.
COPY --from=builder /app/backend/scripts/preflight-dist.cjs /app/backend/scripts/dist-manifest.cjs ./backend/scripts/
# .env.example is required at runtime: dotenv-safe validates process.env against it
# (its absence throws and triggers process.exit(1) in production).
COPY --from=builder /app/backend/.env.example ./backend/.env.example

# Create necessary directories with proper permissions
RUN mkdir -p /app/logs /app/uploads /app/data && \
    chown -R aidis:aidis /app

# Switch to non-root user
USER aidis

# The backend runs from its member dir; deps resolve via /app/backend/node_modules
# and the hoisted /app/node_modules above it.
WORKDIR /app/backend

# Expose backend port
EXPOSE 5000

# Health check with better error handling
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:5000/health || exit 1

# Environment optimization
ENV NODE_ENV=production \
    PORT=5000 \
    NODE_OPTIONS="--max-old-space-size=512" \
    NPM_CONFIG_LOGLEVEL=warn

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the backend server. package.json "start" runs scripts/preflight-dist.cjs
# first; it verifies dist/.build-manifest.json and, finding no src/ here, reports
# the sourceless case and exits 0 before node dist/server.js runs.
CMD ["npm", "start"]
