# House Cloud Run entry (dist/http.js via docker/entrypoint.sh).
# Bakissation's distroless MCP_TRANSPORT=http image is not used here: it would
# boot HttpTransportHost instead of house src/http.ts.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
EXPOSE 8080
USER node
CMD ["/app/entrypoint.sh"]
