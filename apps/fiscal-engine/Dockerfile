FROM node:24-alpine
WORKDIR /app
RUN apk add --no-cache openssl
COPY apps/fiscal-engine/package.json apps/fiscal-engine/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY apps/fiscal-engine/src ./src
COPY apps/fiscal-engine/scripts ./scripts
COPY deploy/fiscal/icp-brasil-roots.pem deploy/fiscal/icp-brasil-intermediates.pem ./trust/
ENV DANFE_TRUST_DIR=/app/trust
ENV FISCAL_ENGINE_BIND=0.0.0.0 FISCAL_ENGINE_PORT=8091
USER node
EXPOSE 8091
CMD ["npm", "start"]
