# syntax=docker/dockerfile:1
# The builder as a web app: server, user interface and the tools it calls.
#   docker build -t lotse .
# deploy/compose.yaml runs it together with PostgreSQL.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

FROM base AS build
# better-sqlite3 compiles when no prebuilt binary matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
# The desktop app's Electron binary is not needed to build the web app.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN pnpm install --frozen-lockfile && pnpm build
# The runtime tree: package manifests, build output and the server's production dependencies only.
RUN mkdir /app \
 && cp package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc LICENSE /app/ \
 && for dir in packages/*/; do \
      mkdir -p "/app/$dir" && cp "$dir/package.json" "/app/$dir"; \
      if [ -d "$dir/dist" ]; then cp -r "$dir/dist" "/app/$dir"; fi; \
    done \
 && cp -r packages/core/schema /app/packages/core/ \
 && cd /app \
 && pnpm install --prod --frozen-lockfile --filter "@lotseai/server..." \
 && find /app/packages -name "*.tsbuildinfo" -delete

FROM base
LABEL org.opencontainers.image.title="Lotse" \
      org.opencontainers.image.description="Build apps from a prompt and publish them anywhere" \
      org.opencontainers.image.licenses="Apache-2.0"
# Git for the projects' history, tini to forward signals, the Docker CLI with buildx for image builds.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker/buildx-bin:0.38.1 /buildx /usr/libexec/docker/cli-plugins/docker-buildx
COPY --from=build /app /app
RUN install -d -o node -g node /data
WORKDIR /app
ENV NODE_ENV=production LOTSE_HOST=0.0.0.0 LOTSE_PORT=4780 LOTSE_DATA_DIR=/data
EXPOSE 4780
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.LOTSE_PORT||4780)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["tini", "--"]
CMD ["node", "packages/server/dist/main.js"]
