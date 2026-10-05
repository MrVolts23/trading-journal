#!/bin/zsh
# Alchemy Trading Desk — opens the SEPARATE demo MetaTrader 5 (portable, its own data folder).
# It never touches the live terminal that GoldBridge uses.
export WINEPREFIX="$HOME/Library/Application Support/net.metaquotes.wine.metatrader5"
WINE="/Applications/MetaTrader 5.app/Contents/SharedSupport/wine/bin/wine"
DEMO_DIR="$WINEPREFIX/drive_c/Program Files/MetaTrader 5 Demo"

if [ ! -f "$DEMO_DIR/terminal64.exe" ]; then
  echo "The demo MetaTrader copy is missing: $DEMO_DIR"; read -k1; exit 1
fi
# Refuse if a LIVE login has been saved into the demo copy.
if [ -f "$DEMO_DIR/config/accounts.dat" ] && grep -aq "EightcapGlobal-Live" "$DEMO_DIR/config/accounts.dat" 2>/dev/null; then
  echo "REFUSING: the demo MetaTrader has a LIVE login saved."
  echo "Delete  $DEMO_DIR/config/accounts.dat  and log in to a DEMO account only."; read -k1; exit 1
fi
if pgrep -f "MetaTrader 5 Demo.terminal64.exe" >/dev/null 2>&1; then
  echo "The demo MetaTrader is already open."; sleep 2; exit 0
fi
echo "Opening the Alchemy Trading Desk demo MetaTrader…  (leave this window open; closing it closes MetaTrader)"
# Start from inside the demo folder with the start-up file, so the read-only data robot attaches to gold by itself.
cd "$DEMO_DIR"
if [ -f "$DEMO_DIR/config/alchemy-start.ini" ]; then
  exec "$WINE" terminal64.exe /portable '/config:config\alchemy-start.ini'
fi
exec "$WINE" terminal64.exe /portable
