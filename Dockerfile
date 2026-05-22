FROM mcr.microsoft.com/playwright:v1.45.0-jammy

WORKDIR /app

# Install dependencies (include devDeps for tsc build, then prune)
COPY package*.json ./
RUN npm ci

# Build TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Browsers are pre-installed in the Playwright base image
RUN npx playwright install chromium

# Screenshot storage — Railway mounts a persistent volume at /data
RUN mkdir -p /data/screenshots
ENV SCREENSHOTS_DIR=/data/screenshots
ENV PORT=3001

# Non-root user for security
RUN groupadd -r scraper && useradd -r -g scraper scraper \
    && chown -R scraper:scraper /app /data
USER scraper

EXPOSE 3001
CMD ["node", "dist/index.js"]
