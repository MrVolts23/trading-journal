#!/bin/bash
# Gold Metal Alchemist — install launchd schedules for the loops.
# DELIBERATELY MANUAL: run this yourself when you're ready for the loops to fire on schedule.
# Until then, test any loop by hand:  node loops/run.js alchemy-capture
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TEMPLATE="$REPO/loops/launchd/com.gma.loop.plist.template"
DEST="$HOME/Library/LaunchAgents"
NODE_BIN="$(command -v node)"
mkdir -p "$REPO/loops/logs" "$DEST"

# loop-name  hour  minute  [weekday 0=Sun..6=Sat]   (local time; assumes Mac on Pacific)
SCHEDULES=(
  "alchemy-capture 16 05"   # just after key hour closes (4:05pm)
  "journal-drafter 14 20"   # after session close
  "recon 22 30"
  "bake 1 00"               # mechanical experiment baker — pure local math, zero tokens
  "cake-planner 1 30"       # overnight planner (Claude): reads bake results, plans next queue
  "weekly-digest 8 00 0"    # Sundays only
)

for entry in "${SCHEDULES[@]}"; do
  read -r LOOP HOUR MINUTE WEEKDAY <<< "$entry"
  PLIST="$DEST/com.gma.$LOOP.plist"
  if [ -n "${WEEKDAY:-}" ]; then
    WD_LINE="    <key>Weekday</key><integer>$WEEKDAY</integer>"
  else
    WD_LINE=""
  fi
  # 'bake' runs the mechanical experiment runner directly (no Claude, no tokens)
  RUNNER="{{REPO}}/loops/run.js"
  [ "$LOOP" = "bake" ] && RUNNER="{{REPO}}/loops/sweep/bake.js"
  sed -e "s|{{REPO}}/loops/run.js|$RUNNER|g" \
      -e "s|{{LOOP}}|$LOOP|g" \
      -e "s|{{REPO}}|$REPO|g" \
      -e "s|{{HOUR}}|$((10#$HOUR))|g" \
      -e "s|{{MINUTE}}|$((10#$MINUTE))|g" \
      -e "s|{{WEEKDAY_LINE}}|$WD_LINE|g" \
      -e "s|/usr/local/bin/node|$NODE_BIN|g" \
      "$TEMPLATE" > "$PLIST"
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "Loaded com.gma.$LOOP ($HOUR:$MINUTE${WEEKDAY:+ weekday=$WEEKDAY})"
done

echo
echo "All loops scheduled. Kill switch: touch ~/Projects/goldbridge/HALT"
echo "Uninstall: launchctl unload ~/Library/LaunchAgents/com.gma.*.plist && rm ~/Library/LaunchAgents/com.gma.*.plist"
