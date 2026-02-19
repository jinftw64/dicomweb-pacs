# Build stage - install dependencies with native module compilation support
FROM node:20-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    cmake \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Production stage
FROM node:20-slim

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY src/ ./src/
COPY public/ ./public/
COPY config/default.js ./config/default.js
COPY bin/ ./bin/
COPY package.json ./

RUN mkdir -p /app/data /app/logs /app/import \
    && groupadd -r appuser && useradd -r -g appuser -d /app appuser \
    && chown -R appuser:appuser /app

USER appuser

EXPOSE 5001 8888

CMD ["node", "src/app.js"]
