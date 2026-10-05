//+------------------------------------------------------------------+
//| AlchemyDeskExporter.mq5 — Alchemy Trading Desk data robot        |
//|                                                                  |
//| READ-ONLY. DEMO ACCOUNTS ONLY. This file contains no trading     |
//| code of any kind: it never places, changes or closes anything.   |
//| If it finds itself on an account that is not a demo account it   |
//| refuses to export and says so.                                   |
//|                                                                  |
//| It writes into  MQL5\Files\alchemy_feed\out\ :                   |
//|   heartbeat.json   every few seconds: who am I, is this a demo,  |
//|                    latest price, is the market open, how much    |
//|                    history the broker holds                      |
//|   bars_m1.csv      the most recent CLOSED one-minute bars,       |
//|                    rewritten whenever a new minute closes        |
//|   history_<id>.csv + history_<id>.done                           |
//|                    a bulk history dump, only when the Desk asks  |
//|                    for one by dropping                           |
//|                    alchemy_feed\in\history_request.txt :         |
//|                      SYMBOL;FROM(yyyy.mm.dd);TO(yyyy.mm.dd);ID   |
//| Files are written to a .tmp name and then renamed, so the Desk   |
//| never reads a half-written file.                                 |
//| All bar times are BROKER SERVER time, exactly as MetaTrader      |
//| shows them; the Desk does the time-zone thinking.                |
//+------------------------------------------------------------------+
#property copyright "Alchemy Trading Desk"
#property version   "1.01"
#property description "Alchemy Trading Desk data robot. Read-only, demo accounts only, no trading code."

input string InpSymbol       = "";    // Symbol to export ("" = this chart's symbol)
input int    InpHeartbeatSec = 5;     // Heartbeat every N seconds
input int    InpRollingBars  = 3000;  // Recent closed M1 bars kept in bars_m1.csv

#define ROBOT_NAME    "AlchemyDeskExporter"
#define ROBOT_VERSION "1.01"
#define PROTOCOL      1
const string DIR_OUT = "alchemy_feed\\out\\";
const string DIR_IN  = "alchemy_feed\\in\\";

string   g_symbol      = "";
bool     g_refused     = false;
datetime g_last_bar0   = 0;       // open time of the forming M1 bar at the last rolling export
datetime g_last_beat   = 0;
long     g_seq         = 0;
string   g_state       = "starting";
string   g_dump_note   = "";

// One copy only. If the robot ends up on two charts (dragged twice, or restored AND started again), the
// second copy stands by instead of fighting the first over the same files. The owner refreshes a small
// terminal-wide marker every second; a marker older than 10 seconds means the owner is gone.
#define LOCK_TIME  "AlchemyDeskExporter.alive"
#define LOCK_OWNER "AlchemyDeskExporter.owner"
bool     g_standby     = false;

//+------------------------------------------------------------------+
int OnInit()
  {
   g_symbol = (StringLen(InpSymbol) > 0) ? InpSymbol : _Symbol;
   SymbolSelect(g_symbol, true);
   CheckDemo();
   EventSetTimer(1);
   if(ClaimFeed())
     {
      Beat();
      if(!g_refused) ExportRolling(true);
     }
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   if(!g_standby && IsOwner()) { GlobalVariableDel(LOCK_TIME); GlobalVariableDel(LOCK_OWNER); }
   Comment("");
  }

double MyMark() { return (double)(ChartID() % 1000000000); }   // chart ids are too big for a double; a fingerprint is enough
bool IsOwner()  { return GlobalVariableCheck(LOCK_OWNER) && GlobalVariableGet(LOCK_OWNER) == MyMark(); }

// true = this copy may export; false = another live copy owns the feed
bool ClaimFeed()
  {
   datetime now = TimeLocal();
   if(GlobalVariableCheck(LOCK_TIME) && GlobalVariableCheck(LOCK_OWNER))
     {
      bool fresh = (now - (datetime)GlobalVariableGet(LOCK_TIME)) < 10;
      if(fresh && GlobalVariableGet(LOCK_OWNER) != MyMark())
        {
         if(!g_standby) Print(ROBOT_NAME, ": another copy is already running on another chart - standing by");
         g_standby = true;
         Comment("Alchemy Trading Desk data robot\nAnother copy is already running on another chart.\nThis one is standing by (you can remove it).");
         return false;
        }
     }
   GlobalVariableSet(LOCK_OWNER, MyMark());
   GlobalVariableSet(LOCK_TIME, (double)now);
   g_standby = false;
   return true;
  }

void OnTimer()
  {
   if(!ClaimFeed()) return;
   CheckDemo();
   datetime now = TimeLocal();
   if(now - g_last_beat >= MathMax(1, InpHeartbeatSec)) Beat();
   if(g_refused) return;
   ExportRolling(false);
   CheckHistoryRequest();
  }

//+------------------------------------------------------------------+
//| The demo-only rule                                               |
//+------------------------------------------------------------------+
void CheckDemo()
  {
   bool demo = (AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_DEMO);
   bool was = g_refused;
   g_refused = !demo;
   if(g_refused)
     {
      g_state = "refused_not_demo";
      Comment("Alchemy Trading Desk data robot\nREFUSING TO RUN: this is not a demo account.\nMove me to the demo MetaTrader.");
     }
   else if(was || g_state == "starting" || g_state == "refused_not_demo")
      g_state = "exporting";
  }

string TradeModeName()
  {
   long m = AccountInfoInteger(ACCOUNT_TRADE_MODE);
   if(m == ACCOUNT_TRADE_MODE_DEMO)    return "demo";
   if(m == ACCOUNT_TRADE_MODE_CONTEST) return "contest";
   if(m == ACCOUNT_TRADE_MODE_REAL)    return "real";
   return "unknown";
  }

//+------------------------------------------------------------------+
//| helpers                                                          |
//+------------------------------------------------------------------+
string Esc(string s)
  {
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   StringReplace(s, "\r", " ");
   StringReplace(s, "\n", " ");
   return s;
  }
string Ts(datetime t) { return TimeToString(t, TIME_DATE|TIME_SECONDS); }
string Q(string s)    { return "\"" + Esc(s) + "\""; }

// write text to DIR_OUT + name through a .tmp file, then rename over the final name
bool WriteAtomic(const string name, const string text)
  {
   string tmp = DIR_OUT + name + ".tmp";
   string fin = DIR_OUT + name;
   int h = FileOpen(tmp, FILE_WRITE|FILE_TXT|FILE_ANSI);
   if(h == INVALID_HANDLE) { Print(ROBOT_NAME, ": cannot open ", tmp, " err=", GetLastError()); return false; }
   FileWriteString(h, text);
   FileClose(h);
   if(FileMove(tmp, 0, fin, FILE_REWRITE)) return true;
   // rename refused (rare): fall back to writing the final name directly
   h = FileOpen(fin, FILE_WRITE|FILE_TXT|FILE_ANSI);
   if(h == INVALID_HANDLE) return false;
   FileWriteString(h, text);
   FileClose(h);
   FileDelete(tmp);
   return true;
  }

bool MarketOpenNow()
  {
   datetime now = TimeTradeServer();
   MqlDateTime dt; TimeToStruct(now, dt);
   uint secs = (uint)(dt.hour * 3600 + dt.min * 60 + dt.sec);
   datetime from, to;
   for(uint i = 0; i < 16; i++)
     {
      if(!SymbolInfoSessionTrade(g_symbol, (ENUM_DAY_OF_WEEK)dt.day_of_week, i, from, to)) break;
      if(secs >= (uint)from && secs < (uint)to) return true;
     }
   return false;
  }

//+------------------------------------------------------------------+
//| heartbeat.json                                                   |
//+------------------------------------------------------------------+
void Beat()
  {
   g_last_beat = TimeLocal();
   g_seq++;
   datetime server = TimeTradeServer();
   datetime gmt    = TimeGMT();
   bool connected  = (bool)TerminalInfoInteger(TERMINAL_CONNECTED);

   string j = "{";
   j += "\"protocol\":" + IntegerToString(PROTOCOL) + ",";
   j += "\"robot\":" + Q(ROBOT_NAME) + ",\"robot_version\":" + Q(ROBOT_VERSION) + ",";
   j += "\"seq\":" + IntegerToString(g_seq) + ",";
   j += "\"state\":" + Q(g_state) + ",";
   j += "\"note\":" + Q(g_dump_note) + ",";
   j += "\"server_time\":" + Q(Ts(server)) + ",";
   j += "\"server_epoch\":" + IntegerToString((long)server) + ",";
   j += "\"gmt_epoch\":" + IntegerToString((long)gmt) + ",";
   j += "\"server_gmt_offset_s\":" + IntegerToString((long)server - (long)gmt) + ",";
   j += "\"connected\":" + (connected ? "true" : "false") + ",";
   j += "\"login\":" + Q(IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN))) + ",";
   j += "\"server\":" + Q(AccountInfoString(ACCOUNT_SERVER)) + ",";
   j += "\"company\":" + Q(AccountInfoString(ACCOUNT_COMPANY)) + ",";
   j += "\"trade_mode\":" + Q(TradeModeName()) + ",";
   j += "\"is_demo\":" + (g_refused ? "false" : "true") + ",";
   j += "\"terminal_build\":" + IntegerToString(TerminalInfoInteger(TERMINAL_BUILD)) + ",";
   j += "\"terminal_data_path\":" + Q(TerminalInfoString(TERMINAL_DATA_PATH)) + ",";
   j += "\"max_bars\":" + IntegerToString(TerminalInfoInteger(TERMINAL_MAXBARS));

   if(!g_refused)
     {
      MqlTick tick;
      bool haveTick = SymbolInfoTick(g_symbol, tick);
      int digits = (int)SymbolInfoInteger(g_symbol, SYMBOL_DIGITS);
      datetime firstTerminal = (datetime)SeriesInfoInteger(g_symbol, PERIOD_M1, SERIES_FIRSTDATE);
      datetime firstServer   = (datetime)SeriesInfoInteger(g_symbol, PERIOD_M1, SERIES_SERVER_FIRSTDATE);
      datetime lastClosed    = iTime(g_symbol, PERIOD_M1, 1);
      j += ",\"symbol\":" + Q(g_symbol);
      j += ",\"digits\":" + IntegerToString(digits);
      j += ",\"market_open\":" + (MarketOpenNow() ? "true" : "false");
      if(haveTick)
        {
         j += ",\"bid\":" + DoubleToString(tick.bid, digits);
         j += ",\"ask\":" + DoubleToString(tick.ask, digits);
         j += ",\"tick_time\":" + Q(Ts(tick.time));
         j += ",\"tick_epoch\":" + IntegerToString((long)tick.time);
        }
      j += ",\"spread_points\":" + IntegerToString(SymbolInfoInteger(g_symbol, SYMBOL_SPREAD));
      j += ",\"m1_bars_in_terminal\":" + IntegerToString(Bars(g_symbol, PERIOD_M1));
      j += ",\"m1_first_in_terminal\":" + Q(firstTerminal > 0 ? Ts(firstTerminal) : "");
      j += ",\"m1_first_on_server\":" + Q(firstServer > 0 ? Ts(firstServer) : "");
      j += ",\"m1_last_closed\":" + Q(lastClosed > 0 ? Ts(lastClosed) : "");
     }
   j += "}";
   WriteAtomic("heartbeat.json", j);

   if(!g_refused)
      Comment("Alchemy Trading Desk data robot (read-only)\n",
              g_symbol, "  ·  demo ", IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)), "  ·  ", g_state,
              (StringLen(g_dump_note) > 0 ? "\n" + g_dump_note : ""),
              "\nlast heartbeat ", Ts(server), " (server time)");
  }

//+------------------------------------------------------------------+
//| bars_m1.csv — the most recent CLOSED one-minute bars             |
//+------------------------------------------------------------------+
void ExportRolling(const bool force)
  {
   datetime bar0 = iTime(g_symbol, PERIOD_M1, 0);
   if(bar0 == 0) return;                         // history not ready yet
   if(!force && bar0 == g_last_bar0) return;     // no new minute since the last export

   MqlRates rates[];
   int want = MathMax(10, InpRollingBars);
   int n = CopyRates(g_symbol, PERIOD_M1, 1, want, rates);   // start at 1 = skip the forming bar
   if(n <= 0) return;

   int digits = (int)SymbolInfoInteger(g_symbol, SYMBOL_DIGITS);
   string text = "time,open,high,low,close,tick_volume,spread\n";
   for(int i = 0; i < n; i++)
      text += TimeToString(rates[i].time, TIME_DATE|TIME_MINUTES) + "," +
              DoubleToString(rates[i].open, digits) + "," + DoubleToString(rates[i].high, digits) + "," +
              DoubleToString(rates[i].low, digits) + "," + DoubleToString(rates[i].close, digits) + "," +
              IntegerToString(rates[i].tick_volume) + "," + IntegerToString(rates[i].spread) + "\n";
   if(WriteAtomic("bars_m1.csv", text)) g_last_bar0 = bar0;
  }

//+------------------------------------------------------------------+
//| bulk history on request                                          |
//+------------------------------------------------------------------+
void CheckHistoryRequest()
  {
   string req = DIR_IN + "history_request.txt";
   if(!FileIsExist(req)) return;
   int h = FileOpen(req, FILE_READ|FILE_TXT|FILE_ANSI);
   if(h == INVALID_HANDLE) return;
   string line = FileReadString(h);
   FileClose(h);
   FileDelete(req);

   string parts[];
   if(StringSplit(line, ';', parts) < 4) { Print(ROBOT_NAME, ": bad history request: ", line); return; }
   string   sym = parts[0];
   datetime t0  = StringToTime(parts[1]);
   datetime t1  = StringToTime(parts[2]) + 86399;   // include the whole TO day
   string   id  = parts[3];
   StringReplace(id, "\r", ""); StringReplace(id, "\n", ""); StringReplace(id, " ", "");
   if(StringLen(sym) == 0 || StringLen(id) == 0 || t1 <= t0) { Print(ROBOT_NAME, ": bad history request: ", line); return; }
   SymbolSelect(sym, true);

   string outName = "history_" + id + ".csv";
   string tmp = DIR_OUT + outName + ".tmp";
   int out = FileOpen(tmp, FILE_WRITE|FILE_TXT|FILE_ANSI);
   if(out == INVALID_HANDLE) { Print(ROBOT_NAME, ": cannot open ", tmp); return; }
   FileWriteString(out, "time,open,high,low,close,tick_volume,spread\n");

   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   MqlRates rates[];
   datetime cursor = t0, lastWritten = 0, firstWritten = 0;
   long written = 0;
   int emptyChunks = 0;
   string prevState = g_state;
   g_state = "dumping_history";

   while(cursor < t1 && !IsStopped())
     {
      datetime chunkEnd = (cursor + 30 * 86400 < t1) ? cursor + 30 * 86400 : t1;
      int n = -1;
      for(int attempt = 0; attempt < 20 && n < 0 && !IsStopped(); attempt++)
        {
         ResetLastError();
         n = CopyRates(sym, PERIOD_M1, cursor, chunkEnd, rates);
         if(n < 0) Sleep(500);                      // the terminal is still fetching this stretch from the broker
        }
      if(n > 0)
        {
         string buf = "";
         for(int i = 0; i < n; i++)
           {
            if(rates[i].time <= lastWritten) continue;   // chunk edges overlap by one bar
            buf += TimeToString(rates[i].time, TIME_DATE|TIME_MINUTES) + "," +
                   DoubleToString(rates[i].open, digits) + "," + DoubleToString(rates[i].high, digits) + "," +
                   DoubleToString(rates[i].low, digits) + "," + DoubleToString(rates[i].close, digits) + "," +
                   IntegerToString(rates[i].tick_volume) + "," + IntegerToString(rates[i].spread) + "\n";
            if(firstWritten == 0) firstWritten = rates[i].time;
            lastWritten = rates[i].time;
            written++;
            if(StringLen(buf) > 120000) { FileWriteString(out, buf); buf = ""; }
           }
         if(StringLen(buf) > 0) FileWriteString(out, buf);
        }
      else emptyChunks++;
      cursor = chunkEnd;
      g_dump_note = "history " + id + ": " + IntegerToString(written) + " bars so far, up to " + TimeToString(cursor, TIME_DATE);
      Beat();                                         // keep the Desk informed during a long dump
     }
   FileClose(out);
   FileMove(tmp, 0, DIR_OUT + outName, FILE_REWRITE);

   string done = "{";
   done += "\"id\":" + Q(id) + ",\"symbol\":" + Q(sym) + ",";
   done += "\"bars\":" + IntegerToString(written) + ",";
   done += "\"first\":" + Q(firstWritten > 0 ? Ts(firstWritten) : "") + ",";
   done += "\"last\":" + Q(lastWritten > 0 ? Ts(lastWritten) : "") + ",";
   done += "\"requested_from\":" + Q(Ts(t0)) + ",\"requested_to\":" + Q(Ts(t1)) + ",";
   done += "\"empty_chunks\":" + IntegerToString(emptyChunks) + ",";
   done += "\"file\":" + Q(outName) + ",";
   done += "\"finished_server_time\":" + Q(Ts(TimeTradeServer()));
   done += "}";
   WriteAtomic("history_" + id + ".done", done);

   Print(ROBOT_NAME, ": history ", id, " complete — ", written, " bars");
   g_state = prevState;
   g_dump_note = "";
   Beat();
  }
//+------------------------------------------------------------------+
