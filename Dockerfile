# Build stage
FROM node:20-alpine AS build
WORKDIR /app

# Declare build args — Vite bakes VITE_* into the bundle at build time
ARG VITE_AGORA_APP_ID
ARG VITE_AGORA_TOKEN
ARG VITE_AGORA_CUSTOMER_ID
ARG VITE_AGORA_CUSTOMER_SECRET
ARG VITE_LLM_API_KEY
ARG VITE_TTS_API_KEY
ARG VITE_TTS_REGION
ARG VITE_STT_API_KEY
ARG VITE_AGENT_SYSTEM_PROMPT

COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine
WORKDIR /app
COPY --from=build /app /app

# Expose port
EXPOSE 5000

# Run the preview server
CMD ["npx", "vite", "preview", "--host", "0.0.0.0", "--port", "5000"]
