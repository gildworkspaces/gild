FROM node:22-alpine
RUN apk add --no-cache git openssh-client ca-certificates
WORKDIR /app
COPY dist/server.mjs ./server.mjs
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
