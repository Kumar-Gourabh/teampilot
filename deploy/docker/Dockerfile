# Build from the repo root:  docker build -f deploy/docker/Dockerfile -t teampilot .
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY bin ./bin
COPY src ./src
COPY templates ./templates
COPY deploy ./deploy
ENV TEAMPILOT_HOME=/data \
    NODE_OPTIONS=--dns-result-order=ipv4first
VOLUME ["/data"]
USER node
ENTRYPOINT ["node", "/app/bin/teampilot.js"]
CMD ["help"]
