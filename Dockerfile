FROM ccusr/claude-project:2.1.319-playwright1.56.1-20261110
USER root
ENV NODE_PATH=/opt/ccusr/browser-runtime/node_modules PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY . /app
CMD ["node", "demo.cjs"]
