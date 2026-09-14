FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build && bun scripts/package.ts

FROM oven/bun:1.3.14
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client poppler-utils xdotool imagemagick ca-certificates xvfb xauth x11-utils x11vnc openbox xterm && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist/package /opt/vibe-coders
WORKDIR /workspace
ENV VIBE_CODER_CONFIG_DIR=/data/config VIBE_CODER_DATA_DIR=/data/state
EXPOSE 3100
ENTRYPOINT ["bun", "/opt/vibe-coders/dist/server/cli.js"]
