FROM mcr.microsoft.com/playwright:v1.45.0-jammy

WORKDIR /app

# Chromium is already installed in the base image at /ms-playwright
# Setting this tells playwright where to find it — no download needed
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV SCREENSHOTS_DIR=/data/screenshots
ENV PORT=3001

# Install ALL deps (need devDeps for tsc build step)
COPY package*.json ./
RUN npm ci

# Build TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Copy migration SQL into dist so it's co-located with compiled code
RUN mkdir -p dist/db/migrations && cp src/db/migrations/001_init.sql dist/db/migrations/001_init.sql

# Remove dev dependencies after build
RUN npm prune --omit=dev

# Create screenshot storage directory
RUN mkdir -p /data/screenshots

EXPOSE 3001
CMD ["node", "dist/index.js"]
