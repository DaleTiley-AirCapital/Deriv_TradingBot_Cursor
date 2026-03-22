# ── Stage 1: Build the React frontend ─────────────────────────────────────────
FROM node:24-slim AS frontend
RUN npm install -g pnpm
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json tsconfig.json ./
COPY lib/                        ./lib/
COPY artifacts/deriv-quant/      ./artifacts/deriv-quant/

RUN pnpm install --frozen-lockfile

# BASE_PATH=/ so the app is served at the root.
# PORT is required by the vite config validator (not used at build time).
ENV BASE_PATH=/
ENV PORT=3000
ENV NODE_ENV=production

RUN pnpm --filter @workspace/deriv-quant run build

# ── Stage 2: Build the API server bundle ──────────────────────────────────────
FROM node:24-slim AS api-build
RUN npm install -g pnpm
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json tsconfig.json ./
COPY lib/                        ./lib/
COPY artifacts/api-server/       ./artifacts/api-server/

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/api-server run build

# ── Stage 3: Run the API server ──────────────────────────────────────────────
FROM node:24-slim AS app
RUN apt-get update && apt-get install -y curl --no-install-recommends && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json tsconfig.json ./
COPY lib/                        ./lib/
COPY artifacts/api-server/       ./artifacts/api-server/
COPY scripts/                    ./scripts/

# Copy the built frontend
COPY --from=frontend /app/artifacts/deriv-quant/dist ./artifacts/deriv-quant/dist

# Copy the compiled API server bundle
COPY --from=api-build /app/artifacts/api-server/dist ./artifacts/api-server/dist

ENV NODE_ENV=production
ENV SERVE_FRONTEND=true

RUN pnpm install --frozen-lockfile --prod

CMD ["node", "./artifacts/api-server/dist/index.cjs"]
