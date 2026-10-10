"""Default boards created on first run. Everything here is editable from the UI."""

WORLD_INDICES = [
    # (symbol, label, group)
    ("^GSPC", "S&P 500", "Americas"),
    ("^NDX", "Nasdaq 100", "Americas"),
    ("^DJI", "Dow Jones", "Americas"),
    ("^RUT", "Russell 2000", "Americas"),
    ("^GSPTSE", "TSX", "Americas"),
    ("^BVSP", "Bovespa", "Americas"),
    ("^MXX", "IPC Mexico", "Americas"),
    ("^STOXX50E", "Euro Stoxx 50", "Europe"),
    ("^STOXX", "Stoxx 600", "Europe"),
    ("^GDAXI", "DAX", "Europe"),
    ("^FCHI", "CAC 40", "Europe"),
    ("^FTSE", "FTSE 100", "Europe"),
    ("^IBEX", "IBEX 35", "Europe"),
    ("FTSEMIB.MI", "FTSE MIB", "Europe"),
    ("^AEX", "AEX", "Europe"),
    ("^SSMI", "SMI", "Europe"),
    ("PSI20.LS", "PSI", "Europe"),
    ("^N225", "Nikkei 225", "Asia-Pacific"),
    ("^HSI", "Hang Seng", "Asia-Pacific"),
    ("000001.SS", "Shanghai Comp.", "Asia-Pacific"),
    ("^KS11", "KOSPI", "Asia-Pacific"),
    ("^TWII", "TAIEX", "Asia-Pacific"),
    ("^NSEI", "Nifty 50", "Asia-Pacific"),
    ("^AXJO", "ASX 200", "Asia-Pacific"),
]

INDEX_FUNDS_ETFS = [
    ("VWCE.DE", "Vanguard FTSE All-World", "UCITS ETFs"),
    ("IWDA.AS", "iShares Core MSCI World", "UCITS ETFs"),
    ("EUNL.DE", "iShares Core MSCI World (Xetra)", "UCITS ETFs"),
    ("SXR8.DE", "iShares Core S&P 500", "UCITS ETFs"),
    ("CSPX.L", "iShares Core S&P 500 (USD)", "UCITS ETFs"),
    ("VUSA.AS", "Vanguard S&P 500", "UCITS ETFs"),
    ("IS3N.DE", "iShares Core MSCI EM IMI", "UCITS ETFs"),
    ("XDWD.DE", "Xtrackers MSCI World", "UCITS ETFs"),
    ("MEUD.PA", "Amundi Stoxx Europe 600", "UCITS ETFs"),
    ("EQQQ.DE", "Invesco Nasdaq-100", "UCITS ETFs"),
    ("SPY", "SPDR S&P 500", "US ETFs"),
    ("VOO", "Vanguard S&P 500", "US ETFs"),
    ("QQQ", "Invesco QQQ", "US ETFs"),
    ("VTI", "Vanguard Total Market", "US ETFs"),
    ("VT", "Vanguard Total World", "US ETFs"),
    ("VXUS", "Vanguard Total Intl", "US ETFs"),
    ("VNQ", "Vanguard Real Estate", "US ETFs"),
    ("BND", "Vanguard Total Bond", "Bonds & gold"),
    ("AGG", "iShares Core US Agg", "Bonds & gold"),
    ("TLT", "iShares 20+Y Treasury", "Bonds & gold"),
    ("GLD", "SPDR Gold", "Bonds & gold"),
]

US_MEGACAPS = [
    "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "AVGO", "TSLA", "BRK-B", "JPM",
    "LLY", "V", "WMT", "ORCL", "MA", "XOM", "NFLX", "COST", "JNJ", "HD", "PG", "ABBV",
    "BAC", "UNH", "KO", "CVX", "PLTR", "AMD", "CSCO", "CRM", "MRK", "IBM", "WFC", "PM",
    "GE", "MCD", "ABT", "TMO", "LIN", "DIS", "INTU", "PEP", "T", "VZ", "ADBE", "QCOM",
    "TXN", "CAT", "GS", "MS", "AXP", "ISRG", "NOW", "UBER", "MU", "AMAT", "NEE", "BA",
]

EUROPE_LEADERS = [
    "ASML.AS", "SAP.DE", "MC.PA", "SIE.DE", "TTE.PA", "ALV.DE", "SAN.PA", "OR.PA",
    "SU.PA", "AIR.PA", "RMS.PA", "DTE.DE", "IBE.MC", "SAN.MC", "ITX.MC", "BBVA.MC",
    "ENEL.MI", "ISP.MI", "UCG.MI", "NOVO-B.CO", "NESN.SW", "ROG.SW", "NOVN.SW",
    "AZN.L", "SHEL.L", "HSBA.L", "ULVR.L", "RHM.DE", "BNP.PA", "INGA.AS",
]

IBEX35 = [
    "ACS.MC", "ACX.MC", "AENA.MC", "AMS.MC", "ANA.MC", "ANE.MC", "BBVA.MC", "BKT.MC",
    "CABK.MC", "CLNX.MC", "COL.MC", "ELE.MC", "ENG.MC", "FDR.MC", "FER.MC", "GRF.MC",
    "IAG.MC", "IBE.MC", "IDR.MC", "ITX.MC", "LOG.MC", "MAP.MC", "MRL.MC", "MTS.MC",
    "NTGY.MC", "PUIG.MC", "RED.MC", "REP.MC", "ROVI.MC", "SAB.MC", "SAN.MC", "SCYR.MC",
    "SLR.MC", "TEF.MC", "UNI.MC",
]

MACRO = [
    ("GC=F", "Gold", "Commodities"),
    ("SI=F", "Silver", "Commodities"),
    ("CL=F", "WTI crude", "Commodities"),
    ("BZ=F", "Brent", "Commodities"),
    ("NG=F", "Natural gas", "Commodities"),
    ("HG=F", "Copper", "Commodities"),
    ("ZW=F", "Wheat", "Commodities"),
    ("EURUSD=X", "EUR/USD", "FX"),
    ("USDJPY=X", "USD/JPY", "FX"),
    ("GBPUSD=X", "GBP/USD", "FX"),
    ("DX-Y.NYB", "Dollar index", "FX"),
    ("^TNX", "US 10Y yield", "Rates & vol"),
    ("^IRX", "US 13W yield", "Rates & vol"),
    ("^VIX", "VIX", "Rates & vol"),
]

CRYPTO = ["BTC-USD", "ETH-USD", "SOL-USD", "BNB-USD", "XRP-USD", "ADA-USD", "DOGE-USD",
          "AVAX-USD", "LINK-USD", "DOT-USD", "TRX-USD", "LTC-USD"]


def _items(rows):
    out = []
    for r in rows:
        if isinstance(r, str):
            out.append({"symbol": r, "label": None, "group_name": None})
        else:
            sym, label, group = r
            out.append({"symbol": sym, "label": label, "group_name": group})
    return out


DEFAULT_BOARDS = [
    {"name": "World indices", "config": {"size_mode": "equal", "group_mode": "custom"},
     "items": _items(WORLD_INDICES)},
    {"name": "Index funds & ETFs", "config": {"size_mode": "cap_sqrt", "group_mode": "custom"},
     "items": _items(INDEX_FUNDS_ETFS)},
    {"name": "US mega caps", "config": {"size_mode": "cap", "group_mode": "sector"},
     "items": _items(US_MEGACAPS)},
    {"name": "Europe leaders", "config": {"size_mode": "cap", "group_mode": "sector"},
     "items": _items(EUROPE_LEADERS)},
    {"name": "IBEX 35", "config": {"size_mode": "cap", "group_mode": "sector"},
     "items": _items(IBEX35)},
    {"name": "Macro", "config": {"size_mode": "equal", "group_mode": "custom"},
     "items": _items(MACRO)},
    {"name": "Crypto", "config": {"size_mode": "cap", "group_mode": "none"},
     "items": _items(CRYPTO)},
]

DEMO_POSITIONS = [
    # symbol, qty, avg_cost, currency, account, group
    ("VWCE.DE", 120, 98.40, "EUR", "Broker A", "Core"),
    ("IWDA.AS", 85, 79.10, "EUR", "Broker A", "Core"),
    ("IS3N.DE", 150, 29.80, "EUR", "Broker A", "Core"),
    ("NVDA", 40, 92.00, "USD", "Broker B", "Satellite"),
    ("MSFT", 12, 380.00, "USD", "Broker B", "Satellite"),
    ("ASML.AS", 6, 640.00, "EUR", "Broker B", "Satellite"),
    ("SAN.MC", 900, 4.10, "EUR", "Broker B", "Satellite"),
    ("BTC-USD", 0.15, 52000, "USD", "Exchange", "Crypto"),
    ("ETH-USD", 1.8, 2600, "USD", "Exchange", "Crypto"),
]

DEFAULT_SETTINGS = {
    "base_currency": "EUR",
    "color_scheme": "classic",   # classic (red/green) | cvd (red/blue)
    "color_range": "auto",       # auto | 1 | 2 | 3 | 5 | 10 | 20
    "period": "1D",
    "refresh_seconds": 60,
    "tile_label": "symbol",      # symbol | name
    "benchmark": "IWDA.AS",      # shadow-portfolio benchmark (iShares Core MSCI World, EUR)
    "alloc": {"dim": "group_name", "targets": {}},
    "account_fees": {},          # {account: {"fixed": 1.0, "pct": 0.0, "min": null}}
    "fund_profiles": {},
    "fund_ter": {},              # {fund symbol: TER in %} when Yahoo doesn't publish it         # {fund symbol: exposure profile key} overrides for look-through
    "tax_prior_losses": {},      # {year: loss amount in EUR} from before you used the app
    "tax_brackets": [[6000, 0.19], [50000, 0.21], [200000, 0.23], [300000, 0.27], [None, 0.30]],
}
