# The game is a static site: build it with Node, serve the result with nginx.
#
#   docker build -t dead-reckoning .
#   docker run -d --name dead-reckoning -p 8080:80 dead-reckoning
#
# To serve it under a path instead of at the top of a domain, build with
#   docker build --build-arg BASE=/flight/ -t dead-reckoning .
# (the path must begin and end with a slash) and proxy that path to the container.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html ./
COPY src ./src
COPY public ./public
ARG BASE=/
RUN npx vite build --base="$BASE"

FROM nginx:alpine
ARG BASE=/
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
# Under a path, the files sit in the folder of that name, so the same nginx config serves them.
COPY --from=build /app/dist /tmp/dist
RUN mkdir -p "/usr/share/nginx/html${BASE}" && cp -r /tmp/dist/. "/usr/share/nginx/html${BASE}" && rm -rf /tmp/dist
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
