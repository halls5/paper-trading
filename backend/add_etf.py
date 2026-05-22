import re

with open('backend/server.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Define the new endpoint code
new_endpoint = """// Top 10 ETFs — with 3-min cache
app.get('/api/etfs/top', async (req, res) => {
  const cacheKey = 'etfs:top10';
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  const FINNHUB_TOKEN = process.env.FINNHUB_TOKEN || '';

  const usEtfSymbols = [
    { symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust' },
    { symbol: 'QQQ', name: 'Invesco QQQ Trust' },
    { symbol: 'SCHD', name: 'Schwab US Dividend Equity ETF' },
    { symbol: 'TQQQ', name: 'ProShares UltraPro QQQ' },
    { symbol: 'SOXL', name: 'Direxion Daily Semiconductor Bull 3x' }
  ];

  const krEtfSymbols = [
    { symbol: '133690.KS', name: 'TIGER 미국나스닥100', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '069500.KS', name: 'KODEX 200', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '360750.KS', name: 'TIGER 미국S&P500', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '122630.KS', name: 'KODEX 레버리지', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '114800.KS', name: 'KODEX 인버스', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' }
  ];

  try {
    let usResults = [];
    let krResults = krEtfSymbols;

    try {
      const codes = krEtfSymbols.map(s => s.symbol.split('.')[0]).join(',');
      const naverUrl = `https://polling.finance.naver.com/api/realtime?query=SERVICE_ITEM:${codes}`;
      const naverRes = await fetch(naverUrl);
      const naverJson = await naverRes.json();
      const naverDatas = naverJson.result.areas[0].datas;
      
      krResults = krEtfSymbols.map(s => {
        const code = s.symbol.split('.')[0];
        const data = naverDatas.find(d => d.cd === code);
        if (data) {
          return {
            ...s,
            price: data.nv,
            changePercent: data.cr * (data.cv === 0 ? 0 : (data.nv >= data.pcv ? 1 : -1))
          };
        }
        return s;
      });
    } catch (e) {
      console.error('Naver KR ETFs fallback failed:', e.message);
    }

    if (FINNHUB_TOKEN) {
      const fetchQuote = async (sym) => {
        const resp = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_TOKEN}`);
        return await resp.json();
      };
      const quotes = await Promise.all(usEtfSymbols.map(async (s) => {
        try {
          const q = await fetchQuote(s.symbol);
          if (!q || !q.c) return null;
          return {
            symbol: s.symbol, name: s.name,
            price: q.c,
            changePercent: q.pc > 0 ? ((q.c - q.pc) / q.pc * 100) : 0,
            type: 'STOCK', currency: 'USD'
          };
        } catch { return null; }
      }));
      usResults = quotes.filter(Boolean);
    } else {
      try {
        const quotes = await enqueue(async () => {
          const r = await yf.quote(usEtfSymbols.map(s => s.symbol));
          return Array.isArray(r) ? r : [r];
        });
        usResults = quotes.map(q => ({
          symbol: q.symbol,
          name: usEtfSymbols.find(s => s.symbol === q.symbol)?.name || q.shortName || q.symbol,
          price: q.regularMarketPrice,
          changePercent: q.regularMarketChangePercent,
          type: 'STOCK', currency: q.currency || 'USD'
        })).filter(r => r.price != null);
      } catch (e) {
        console.error('Yahoo ETF fallback failed:', e.message);
        usResults = usEtfSymbols.map(s => ({ ...s, price: null, changePercent: 0, type: 'STOCK', currency: 'USD' }));
      }
    }

    const results = [...usResults, ...krResults];
    setCache(cacheKey, results, 3 * 60 * 1000); // 3 min
    res.json(results);
  } catch (error) {
    console.error('Top ETFs API Error:', error.message);
    res.json([...usEtfSymbols.map(s => ({ ...s, price: null, changePercent: 0, type: 'STOCK', currency: 'USD' })), ...krEtfSymbols]);
  }
});

// Helper: convert range string to period1 Date"""

# Insert right after the end of /api/stocks/top
pattern = r"(\s*res\.json\(\[\.\.\.usSymbols\.map\(s => \(\{ \.\.\.s, price: null, changePercent: 0, type: 'STOCK', currency: 'USD' \}\)\), \.\.\.krStocksStatic\]\);\s*\n\s*\}\n\}\);\n)"
match = re.search(pattern, content)

if match:
    new_content = content[:match.end()] + "\n" + new_endpoint + content[match.end():]
    with open('backend/server.js', 'w', encoding='utf-8') as f:
        f.write(new_content)
    print("Injected /api/etfs/top successfully.")
else:
    print("Could not find insertion point!")
