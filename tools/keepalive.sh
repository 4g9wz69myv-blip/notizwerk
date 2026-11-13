#!/bin/sh
# Tägliche Anfrage an Supabase, damit das kostenlose Projekt nicht pausiert
# (Supabase pausiert Gratis-Projekte nach 7 Tagen ohne Aktivität).
# Liest Projekt-URL und Key aus config.js. Wird von launchd (Mac) und GitHub Actions aufgerufen.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONF="$DIR/config.js"
URL=$(sed -n "s/^[[:space:]]*url:[[:space:]]*'\([^']*\)'.*/\1/p" "$CONF" | head -1)
KEY=$(sed -n "s/^[[:space:]]*key:[[:space:]]*'\([^']*\)'.*/\1/p" "$CONF" | head -1)
TS=$(date '+%Y-%m-%d %H:%M:%S')
if [ -z "$URL" ] || [ -z "$KEY" ]; then echo "$TS übersprungen: config.js ist noch nicht ausgefüllt"; exit 0; fi
for try in 1 2 3; do
  CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 -X POST "${URL%/}/rest/v1/rpc/nw_keepalive" \
    -H "apikey: $KEY" -H "Content-Type: application/json" -d '{}' 2>/dev/null)
  if [ "$CODE" = "200" ]; then echo "$TS ok"; exit 0; fi
  sleep 60
done
echo "$TS FEHLER (HTTP $CODE)"; exit 1
