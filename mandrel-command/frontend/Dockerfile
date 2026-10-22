# Multi-stage build for Mandrel Command Frontend
# Optimized React application with nginx - size and performance optimized.
#
# BUILD CONTEXT: the mandrel-command/ npm-workspace ROOT (set in docker-compose.yml:
#   context: ./mandrel-command, dockerfile: frontend/Dockerfile). The workspace-root
#   package-lock.json is the SINGLE SOURCE OF TRUTH; we install WORKSPACE-SCOPED
#   (`npm ci -w mandrel-command-frontend`) so this image only gets the frontend's
#   dependency tree resolved deterministically from the root lock — no backend/shared
#   bloat. The frontend ships as a static nginx bundle, so node_modules is build-only.

# Stage 1: Dependencies stage
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Copy the workspace manifests + the ROOT lockfile (single source of truth).
# .npmrc carries legacy-peer-deps=true. The reason originally written here — CRA's
# react-scripts@5 pinning an optional typescript@^3||^4 peer — no longer applies:
# react-scripts is gone from frontend/package.json (measured 2026-07-30) and the build
# is Vite. The flag is left in place because it is the workspace-root .npmrc shared by
# every member and nothing here has established which remaining peer needs it; that is
# a separate, measurable question. Do not re-justify it with the CRA story.
COPY package.json package-lock.json .npmrc ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
COPY shared/package.json ./shared/

# Install deps for ONLY the frontend workspace member, deterministic from root lock.
RUN npm ci -w mandrel-command-frontend --include-workspace-root=false \
        --ignore-scripts && \
    npm cache clean --force

# Stage 2: Build stage
FROM node:22-alpine AS builder
WORKDIR /app

# Reuse the resolved deps (hoisted to /app/node_modules + member-local under
# /app/frontend/node_modules) and re-copy manifests so the workspace graph is intact.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/frontend/node_modules ./frontend/node_modules
COPY package.json package-lock.json .npmrc ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
COPY shared/package.json ./shared/

# Copy this member's source and build it. The build is VITE, not CRA
# (frontend/package.json build = `tsc --noEmit && vite build`); react-scripts is in
# neither dependencies nor devDependencies. Output dir is still `build`, set
# explicitly at frontend/vite.config.ts:61, which is what the runtime stage copies.
COPY frontend/ ./frontend/

# Build React application with optimizations
ENV GENERATE_SOURCEMAP=false
ENV INLINE_RUNTIME_CHUNK=false
# Raise V8's old-space cap so the CRA/webpack build does not OOM at the default
# ~2GB (same class as the on-host CI/prod build fix — scripts/lib/build-config.sh).
# Scoped to THIS builder stage; the nginx runtime stage below is a separate FROM.
# Build-arg overridable (configs-not-hardcoded): --build-arg FRONTEND_BUILD_HEAP_MB=8192
ARG FRONTEND_BUILD_HEAP_MB=4096
ENV NODE_OPTIONS="--max-old-space-size=${FRONTEND_BUILD_HEAP_MB}"
RUN npm run build -w mandrel-command-frontend

# Remove dev artifacts and trim the static bundle (build-only deps are discarded
# anyway because the production stage copies ONLY frontend/build).
RUN find frontend/build -name "*.map" -delete && \
    find frontend/build -name "*.txt" ! -name "robots.txt" -delete

# Stage 3: Nginx production runtime
FROM nginx:1.25-alpine AS production

# Install minimal runtime dependencies
RUN apk add --no-cache \
    wget \
    && rm -rf /var/cache/apk/*

# Copy built React app to nginx html directory
COPY --from=builder /app/frontend/build /usr/share/nginx/html

# Install the nginx site config from a real file (listen 3000, SPA fallback, gzip)
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Create non-root user and adjust permissions
RUN addgroup -g 1001 -S aidis && \
    adduser -S aidis -u 1001 && \
    chown -R aidis:aidis /usr/share/nginx/html && \
    chown -R aidis:aidis /var/cache/nginx && \
    chown -R aidis:aidis /var/log/nginx && \
    chown -R aidis:aidis /etc/nginx/conf.d && \
    touch /var/run/nginx.pid && \
    chown -R aidis:aidis /var/run/nginx.pid

# Switch to non-root user
USER aidis

# Expose frontend port
EXPOSE 3000

# Optimized health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000 || exit 1

# Start nginx in the foreground. (Do NOT set worker_processes here: the base
# nginx.conf already defines it, and a duplicate via -g is a fatal config error.)
CMD ["nginx", "-g", "daemon off;"]
