# ── Stage 1: Build the Vite frontend ────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

# ── Stage 2: Production image (backend + static frontend) ────────────
FROM node:20-alpine
WORKDIR /app

# Copy package files and install production deps only
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy backend server code
COPY server/ ./server/

# Copy built frontend from stage 1
COPY --from=build /app/dist ./dist

# Ensure persistent data directories exist (volume mounted at runtime)
RUN mkdir -p data tools

# Secrets are injected at runtime via docker-compose env_file
# CUSTOM_LLM_URL is overridden by docker-compose to point to the internal Python service

EXPOSE 5000
# Use plain node — env vars are provided by Docker, not --env-file
CMD ["node", "server/server.js"]
