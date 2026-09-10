# Playwright 1.63 matches package-lock.json so Chromium is already in the image.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

COPY package.json package-lock.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci

COPY . .

ENV RELAY_BIND_HOST=0.0.0.0
ENV RELAY_CONSOLE_PORT=3000
ENV RELAY_OPERATOR_PORT=3847
# Full Chromium is more stable than chrome-headless-shell in Docker Desktop on Apple Silicon.
ENV PLAYWRIGHT_CHROMIUM_USE_HEADLESS_SHELL=0

EXPOSE 3000 3847

CMD ["npm", "run", "console"]
