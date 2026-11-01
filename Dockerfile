# Stage 1: Chuẩn bị backend (dist/) và Web UI (manager/dist/)
# Nếu branch đã có sẵn dist/ và manager/dist/ thì dùng luôn (build chỉ mất ~15s, không tốn RAM trên Northflank Free)
FROM node:22-slim AS builder

WORKDIR /build

COPY package.json package-lock.json* tsconfig.json ./
COPY src ./src
COPY dist ./dist
RUN if [ ! -f dist/http.js ]; then npm install --ignore-scripts && npx tsc -p tsconfig.json; fi

COPY manager/package.json ./manager/package.json
COPY manager/vite.config.js ./manager/vite.config.js
COPY manager/index.html ./manager/index.html
COPY manager/electron ./manager/electron
COPY manager/src ./manager/src
COPY manager/dist ./manager/dist
RUN if [ ! -f manager/dist/index.html ]; then \
      cd manager \
      && node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));delete p.devDependencies.electron;delete p.devDependencies['electron-builder'];delete p.scripts.postbuild;fs.writeFileSync('package.json',JSON.stringify(p,null,2));" \
      && npm install --ignore-scripts \
      && npx vite build; \
    fi

# Stage 2: Runtime siêu nhẹ cho Northflank / Render (< 4 API Workers)
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /build/dist ./dist
COPY --from=builder /build/manager/dist ./manager/dist
COPY scripts ./scripts
COPY manager/electron ./manager/electron
COPY AGENTS.example.md ./AGENTS.example.md

RUN mkdir -p /data/.codexpro/workspaces

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
ENV CODEXPRO_HOME=/data/.codexpro
ENV CODEXPRO_MAX_API_WORKERS=4
ENV NODE_OPTIONS="--max-old-space-size=384"

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "scripts/web-server.mjs"]
