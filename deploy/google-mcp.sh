#!/bin/sh
# Cloud Run template for google-multi-mcp.
# Exits 2 before gcloud. Do not run. The command below is reviewed text only.
# Secret google-mcp-jwt-signing-key mounts where docker/entrypoint.sh:19 reads it.
set -eu
echo "deploy/google-mcp.sh refuses to deploy (exit 2)." >&2
exit 2

gcloud run deploy google-multi-mcp \
  --project=myflow-260730 \
  --account=REPLACE_WITH_GCLOUD_ACCOUNT \
  --region=us-central1 \
  --source=. \
  --set-secrets=/mnt/jwt-signing-key/google-mcp-jwt-signing-key=google-mcp-jwt-signing-key:latest
