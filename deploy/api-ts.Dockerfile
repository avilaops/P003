# API principal do ERP: apps/api-ts compilado, sem ferramentas de desenvolvimento.
FROM node:24-bookworm-slim AS build
RUN npm install --global pnpm@11.11.0 --no-audit --no-fund
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api-ts/package.json apps/api-ts/
RUN pnpm install --frozen-lockfile --filter api-ts...
COPY apps/api-ts/ apps/api-ts/
RUN pnpm --filter api-ts build \
 && pnpm --filter api-ts deploy --prod --legacy /out

FROM node:24-bookworm-slim
ENV NODE_ENV=production API_TS_HOST=0.0.0.0 API_TS_PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /out/ ./apps/api-ts/
COPY --chown=node:node migrations/ ./migrations/
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:'+process.env.API_TS_PORT+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api-ts/dist/server.js"]
