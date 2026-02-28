#!/bin/sh
# Hit the housing refresh endpoint on the main app service, then exit.
# Intended to run as a Railway cron service.

APP_URL="${APP_INTERNAL_URL:-http://localhost:3000}"
echo "Refreshing housing cache via ${APP_URL}/api/housing/refresh ..."

RESPONSE=$(curl -s -w "\n%{http_code}" "${APP_URL}/api/housing/refresh")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -1)

echo "HTTP ${HTTP_CODE}: ${BODY}"

if [ "$HTTP_CODE" = "200" ]; then
  echo "Housing refresh succeeded."
  exit 0
else
  echo "Housing refresh failed."
  exit 1
fi
