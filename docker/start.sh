#!/bin/sh
# Link the plugin, apply the Phound settings once, then run the gateway.
set -e
STATE="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
mkdir -p "$STATE"
oc() { node /app/openclaw.mjs "$@"; }
# The plugin goes in first: channels.phound is only valid once its channel is known.
oc plugins install --link /opt/phound-openclaw --force --accept-capabilities >/dev/null
if [ ! -f "$STATE/.phound-settings-applied" ]; then
  oc config set --batch-json "$(cat /opt/phound-openclaw/docker/settings.json)"
  touch "$STATE/.phound-settings-applied"
fi
exec node /app/openclaw.mjs gateway run --allow-unconfigured "$@"
