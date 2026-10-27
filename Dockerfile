# The Node host needs only Node 22.13 or newer: no npm install, no runtime dependencies
# (wrangler in package.json is only for the Cloudflare host).
#   docker build -t school-games-telemetry server/
#   docker run -d --name sg-telemetry --restart unless-stopped -p 127.0.0.1:8787:8787 \
#     -v sg-telemetry:/data -e ALLOWED_ORIGINS=https://name.github.io -e TRUST_PROXY=1 \
#     -e ADMIN_TOKEN="$(cat admin-token)" school-games-telemetry
# Put a TLS reverse proxy in front of it (server/README.md, "Self-hosting on Node").
FROM node:22-alpine
WORKDIR /app
COPY *.mjs ./
COPY dashboard/ ./dashboard/
ENV NODE_ENV=production PORT=8787 DB_PATH=/data/telemetry.db
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "main.mjs"]
