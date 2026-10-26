# OpenClaw gateway with the Phound channel plugin.
# linux/amd64 only: the phound SDK ships its uccrobot binary for linux x86_64 alone.
FROM ghcr.io/openclaw/openclaw:2026.10.7

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.13.5 /uv /usr/local/bin/uv

COPY --chown=node:node . /opt/phound-openclaw
USER node
WORKDIR /opt/phound-openclaw
# Plugin deps only: openclaw/plugin-sdk comes from the gateway itself, not a second copy.
RUN npm install --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund
# The bridge's Python environment lives outside the plugin folder: OpenClaw refuses
# plugin files that link out of the package, and a venv's python is such a link.
ENV UV_PROJECT_ENVIRONMENT=/opt/phound-venv UV_PYTHON_DOWNLOADS=never
USER root
RUN mkdir -p /opt/phound-venv && chown node:node /opt/phound-venv
USER node
RUN uv sync --project bridge --frozen --no-dev

WORKDIR /app
ENTRYPOINT ["tini", "-s", "--", "/opt/phound-openclaw/docker/start.sh"]
