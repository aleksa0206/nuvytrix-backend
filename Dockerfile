# Stage 1: install dependencies and compile TypeScript
FROM node:22-alpine AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Stage 2: only what is needed to run the API
FROM node:22-alpine AS production

# nmap for discovery, iputils for ping, libcap for setcap.
RUN apk add --no-cache nmap nmap-scripts iputils libcap \
  # Lets the non-root user send raw packets with nmap (ARP discovery and MAC addresses)
  # without running the whole API as root.
  && setcap cap_net_raw+eip /usr/bin/nmap \
  && apk del libcap

WORKDIR /app
ENV NODE_ENV=production \
  NMAP_PRIVILEGED=true

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-4000}/api/health" || exit 1

# Migrations run on startup (see src/index.ts), so a new image upgrades the schema itself.
CMD ["node", "dist/index.js"]
