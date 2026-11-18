FROM mcr.microsoft.com/playwright:v1.56.1-noble
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
COPY package.json package-lock.json /app/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . /app
CMD ["node", "demo.cjs"]
