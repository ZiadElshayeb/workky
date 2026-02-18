# ── Stage 1: Build the Vite frontend (NO secrets needed) ─────────────
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install
COPY . .
# The frontend build uses NO VITE_* secrets — everything is server-side
RUN npm run build

# ── Stage 2: Production image (backend + static frontend) ───────────
FROM node:20-alpine
WORKDIR /app

# Copy package files and install production deps only
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy backend server code
COPY server/ ./server/

# Copy built frontend from stage 1
COPY --from=build /app/dist ./dist

# Secrets are injected at RUNTIME via environment variables — never baked in
# See docker-compose.yml (env_file: .env)

EXPOSE 5000
CMD ["node", "server/server.js"]
