#!/usr/bin/env bash
set -euo pipefail

# Repository to push to (override with REPO env var if needed)
: "${REPO:=bossanyit/supergateway}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Build context is the repo root (one level up from scripts/)
CTX_DIR="$(cd "${SCRIPT_DIR}" && pwd)"

VERSION="${1:-}"
if [[ -z "${VERSION}" ]]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 v1.0.0"
  exit 1
fi

# Optional: login via env vars
if [[ -n "${DOCKERHUB_USERNAME:-}" && -n "${DOCKERHUB_PASSWORD:-}" ]]; then
  echo "${DOCKERHUB_PASSWORD}" | docker login -u "${DOCKERHUB_USERNAME}" --password-stdin
elif [[ -n "${DOCKERHUB_USERNAME:-}" && -n "${DOCKERHUB_TOKEN:-}" ]]; then
  echo "${DOCKERHUB_TOKEN}" | docker login -u "${DOCKERHUB_USERNAME}" --password-stdin
fi

# Ensure buildx is available and ready
docker buildx create --name supergateway-builder --use >/dev/null 2>&1 || true
docker buildx inspect --bootstrap >/dev/null

AMD64_TAG="${VERSION}"
ARM64_TAG="${VERSION}_arm64"

echo "Building and pushing linux/amd64 → ${REPO}:${AMD64_TAG}"
docker buildx build \
  --platform linux/amd64 \
  -t "${REPO}:${AMD64_TAG}" \
  -f "${CTX_DIR}/Dockerfile" \
  "${CTX_DIR}" \
  --push

echo "Building and pushing linux/arm64 → ${REPO}:${ARM64_TAG}"
docker buildx build \
  --platform linux/arm64 \
  -t "${REPO}:${ARM64_TAG}" \
  -f "${CTX_DIR}/Dockerfile" \
  "${CTX_DIR}" \
  --push

echo "Done. Pushed:"
echo "  - ${REPO}:${AMD64_TAG} (linux/amd64)"
echo "  - ${REPO}:${ARM64_TAG} (linux/arm64)"


