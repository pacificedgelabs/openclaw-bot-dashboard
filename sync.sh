#!/bin/bash
# Sync dashboard status to Netlify every 20 seconds
DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$DIR/deploy"
SITE_ID="540fcc98-6bfe-429d-8af8-9bbf4edfd8df"

while true; do
  # Get fresh status from local server
  curl -s http://localhost:9999/api/status > "$DEPLOY_DIR/status.json" 2>/dev/null
  
  # Copy index.html
  cp "$DIR/index.html" "$DEPLOY_DIR/"
  
  # Deploy to Netlify (may fail if over limits)
  cd "$DEPLOY_DIR"
  netlify deploy --prod --dir . --site "$SITE_ID" 2>&1 | tail -3
  
  # Also push to GitHub Pages
  cd "$DIR"
  cp "$DEPLOY_DIR/status.json" "$DIR/status.json"
  git add -A && git commit -m "Update status $(date +%H:%M:%S)" --quiet 2>/dev/null && git push --quiet 2>/dev/null
  
  echo "[$(date)] Deployed"
  sleep 20
done
