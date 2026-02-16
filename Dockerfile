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

# Production stage — serve with nginx
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
