# Must match .nvmrc and engines.node — scripts/check-node-pin.ts fails the gate
# if they drift.
ARG NODE_VERSION=22

# The skin compiled into this image, as a named build context:
# `docker build --build-context skin=<dir> .`, or compose's `additional_contexts`.
# A named context replaces the stage of the same name, so this stage is only the
# default a bare `docker build .` gets. A context rather than a path inside this
# one, because in a checkout that pins core as a submodule the skin sits outside
# core's tree, where no COPY from the main context can reach.
FROM scratch AS skin
COPY skin/default/ /

FROM node:${NODE_VERSION}-slim AS build
RUN corepack enable && corepack prepare pnpm@10.6.3 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY svelte.config.js vite.config.ts tsconfig.json tailwind.config.js postcss.config.js ./
COPY src/ src/
COPY static/ static/
# One fixed path inside the image whatever the host called the skin, read by
# the build and by the one-shot containers that run scripts/ on this stage. The
# four entries a skin consists of, by name: a skin context can be the root of a
# whole repository, and its deploy files, runbook and history stay out.
ENV SKIN_DIR=skin
COPY --from=skin /skin.yaml /theme.css skin/
COPY --from=skin /copy/ skin/copy/
COPY --from=skin /static/ skin/static/
RUN pnpm run build

FROM node:${NODE_VERSION}-slim AS prod_deps
RUN corepack enable && corepack prepare pnpm@10.6.3 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod

FROM node:${NODE_VERSION}-slim
# Baked rather than passed at run time: the point is to prove which commit built
# this image, and a value the container reads at startup could say anything.
# `unknown` when nobody supplied one, which is every local build.
ARG LOREM_BUILD_SHA=unknown
ENV LOREM_BUILD_SHA=${LOREM_BUILD_SHA}
# The core release this image was built from, beside the commit: in a checkout
# that pins core, LOREM_BUILD_SHA names the site's commit and this names core's
# tag. Empty when the build supplied none.
ARG CORE_TAG=
ENV CORE_TAG=${CORE_TAG}
# The server reads the skin's fields from this directory and refuses to start
# if it differs from the one compiled in.
ENV SKIN_DIR=skin
RUN apt-get update && apt-get install -y --no-install-recommends tini curl \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=prod_deps /app/node_modules/ node_modules/
COPY --from=build /app/build/ build/
COPY --from=build /app/skin/ skin/
COPY package.json ./
USER node
EXPOSE 5880
ENV PORT=5880 HOST=0.0.0.0
HEALTHCHECK --interval=30s --timeout=5s --retries=5 \
	CMD curl -fsS "http://localhost:${PORT:-5880}/healthz" || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "build/index.js"]
