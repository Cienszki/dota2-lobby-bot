# bot-worker/Dockerfile
# Builds and runs the Dota 2 lobby bot manager on Railway.app

FROM node:20-slim

# Install build tools needed by native Steam dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json ./

RUN npm ci --omit=dev

# Copy source and tsconfig
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript → dist/
RUN npm install --save-dev typescript \
    && npx tsc \
    && npm uninstall typescript

# Remove dev source to keep image lean
RUN rm -rf src/

# The manager spawns worker child processes using the compiled dist/index.js
ENV NODE_ENV=production

CMD ["node", "dist/manager.js"]
