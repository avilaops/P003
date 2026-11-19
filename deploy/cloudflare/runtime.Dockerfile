# Both arguments must be immutable validated ghcr.io/avilaops image digests.
ARG API_IMAGE
ARG WEB_IMAGE
FROM ${WEB_IMAGE} AS web
# The TypeScript API image is the base: it already carries Node, apps/api-ts, its assets and migrations.
FROM ${API_IMAGE}
COPY --from=web --chown=node:node /app/ /app/
COPY --chown=node:node deploy/cloudflare/runtime-supervisor.mjs deploy/cloudflare/runtime-configuration.mjs /app/runtime/
ARG RELEASE_SHA
LABEL org.opencontainers.image.title="ERP Next native Cloudflare runtime" \
      org.opencontainers.image.revision="${RELEASE_SHA}" \
      org.opencontainers.image.source="https://github.com/avilaops/erp-next"
WORKDIR /app
USER node
ENV API_TS_HOST=127.0.0.1 API_TS_PORT=8080 PORT=3000 HOSTNAME=0.0.0.0 NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=45s CMD node -e "Promise.all([fetch('http://127.0.0.1:3000/api/health'),fetch('http://127.0.0.1:3000/entrar')]).then(rs=>process.exit(rs.every(r=>r.ok)?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "/app/runtime/runtime-supervisor.mjs"]
CMD []
