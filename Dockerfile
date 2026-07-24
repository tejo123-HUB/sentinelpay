# Cloud Run deployment (24 July 2026 Google Cloud integration pass) -- see deployment-guide.md
# Section 4. node:22-slim matches this project's `engines.node >= 22.5.0` requirement (node:sqlite).
FROM node:22-slim

WORKDIR /app

# Installed from the committed lockfile for a reproducible, dev-dependency-free image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Only what's actually needed at runtime: the API (server/), the static dashboard frontend it
# serves (server/index.js's express.static(dashboardDir)), and the committed default ML model.
# ml/*.py (training scripts), ml/.venv, tests/, simulator/, and scripts/ are dev-only and
# deliberately not copied into the image.
COPY server/ ./server/
COPY dashboard/ ./dashboard/
COPY ml/model_export/ ./ml/model_export/

# Writable at runtime for this build's default local-filesystem paths (SQLite DB_PATH, case-
# evidence uploads when GCS_BUCKET_NAME is unset) -- ephemeral on Cloud Run's container
# filesystem, same PROD/DEMO tradeoff as running this locally. A real deployment should point
# DB_PATH/GCS_BUCKET_NAME at persistent storage rather than rely on this (see deployment-guide.md).
RUN mkdir -p /app/data && chown -R node:node /app
USER node

# Cloud Run injects PORT (defaults to 8080) and requires listening on 0.0.0.0 -- server/index.js
# already resolves PORT this way, and defaults HOST to all-interfaces once a real API_KEY is set
# (see server/index.js's USING_DEFAULT_API_KEY check) -- no code change needed for this image.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server/index.js"]
