#!/usr/bin/env bash
#
# Lints the Helm chart and renders it in the configurations that take different
# template branches. `helm lint` alone reports a failed `fail` call as INFO and
# still exits 0, so rendering is what actually catches a broken template.
set -euo pipefail

CHART="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/helm/harness"

# Required, so every invocation below has to supply it.
API_KEY=(--set server.secretEnv.MODEL_API_KEY=placeholder)

helm lint "$CHART" "${API_KEY[@]}"

render() {
  local description="$1"
  shift
  echo "rendering: $description"
  helm template lint-release "$CHART" "${API_KEY[@]}" "$@" >/dev/null
}

render "defaults"
render "ingress enabled" --set ingress.enabled=true
render "server only" --set frontend.enabled=false
render "external postgres and redis" \
  --set postgres.enabled=false --set postgres.external.host=postgres.example.com \
  --set redis.enabled=false --set redis.external.url=redis://redis.example.com:6379
render "user-managed secret and registry" \
  --set server.existingSecret=harness-secrets --set registry.existingConfigMap=harness-registry
render "postgres without persistence" --set postgres.persistence.enabled=false

# Each of these is a boot requirement the server validates, so the chart must
# refuse to render rather than ship a pod that crashes.
refuse() {
  local description="$1"
  shift
  if helm template lint-release "$CHART" "$@" >/dev/null 2>&1; then
    echo "expected rendering to fail: $description" >&2
    exit 1
  fi
  echo "correctly refused: $description"
}

refuse "missing MODEL_API_KEY"
refuse "external postgres without a host" "${API_KEY[@]}" --set postgres.enabled=false
refuse "external redis without a url" "${API_KEY[@]}" --set redis.enabled=false
