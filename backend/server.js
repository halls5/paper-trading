const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('./db');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static frontend files in production
app.use(express.static(path.join(__dirname, '../dist')));

// ✅ yahoo-finance2 v3 correct import
const YahooFinance = require('yahoo-finance2').default;
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_key_for_paper_trading';
const fs = require('fs');

// Load KRX stock list
let krxStocks = [];
try {
  const krxData = fs.readFileSync(path.join(__dirname, 'krx.json'), 'utf-8');
  krxStocks = JSON.parse(krxData);
  console.log(`Loaded ${krxStocks.length} KRX stocks for search fallback.`);
} catch (e) {
  console.warn('Failed to load krx.json for search fallback.');
}

// ─── In-Memory Cache ──────────────────────────────────────────────────────────
const cache = new Map(); // key → { data, expiry }

function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) { cache.delete(key); return null; }
  return entry.data;
}
function setCache(key, data, ttlMs) {
  cache.set(key, { data, expiry: Date.now() + ttlMs });
}

// ─── Request Queue (prevent parallel Yahoo Finance calls) ─────────────────────
let _queueRunning = false;
const _queue = [];

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    _queue.push({ fn, resolve, reject });
    if (!_queueRunning) processQueue();
  });
}

async function processQueue() {
  if (_queue.length === 0) { _queueRunning = false; return; }
  _queueRunning = true;
  const { fn, resolve, reject } = _queue.shift();
  try {
    const result = await fn();
    resolve(result);
  } catch (err) {
    reject(err);
  }
  // Small delay between Yahoo Finance requests to respect rate limit
  await new Promise(r => setTimeout(r, 300));
  processQueue();
}

// ─── Auth Endpoints ───────────────────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  const { username, nickname, password } = req.body;
  if (!username || !nickname || !password)
    return res.status(400).json({ error: '모든 항목을 입력해주세요.' });
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    db.run('INSERT INTO users (username, nickname, password) VALUES (?, ?, ?)',
      [username, nickname, hashedPassword],
      function (err) {
        if (err) {
          if (err.message.includes('UNIQUE constraint failed'))
            return res.status(400).json({ error: '이미 사용 중인 아이디입니다.' });
          return res.status(500).json({ error: '데이터베이스 오류' });
        }
        res.status(201).json({ message: '회원가입 성공', userId: this.lastID });
      });
  } catch { res.status(500).json({ error: '서버 오류' }); }
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (err) return res.status(500).json({ error: '데이터베이스 오류' });
    if (!user) return res.status(400).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    const token = jwt.sign({ userId: user.id, username: user.username, nickname: user.nickname }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ message: '로그인 성공', token, user: { id: user.id, username: user.username, nickname: user.nickname, balance: user.balance } });
  });
});

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

app.get('/api/users/me', authenticateToken, (req, res) => {
  db.get('SELECT id, username, nickname, balance FROM users WHERE id = ?', [req.user.userId], (err, row) => {
    if (err) return res.status(500).json({ error: '데이터베이스 오류' });
    res.json(row);
  });
});

// ─── Market Data APIs ─────────────────────────────────────────────────────────

// Korean → English search term translation (Yahoo Finance doesn't support Korean)
const KR_TRANSLATE = {
  '삼성': '005930.KS', '삼성전자': '005930.KS', '하이닉스': '000660.KS', 'sk하이닉스': '000660.KS',
  '네이버': '035420.KS', '카카오': '035720.KS', '셀트리온': '068270.KS',
  '애플': 'apple', '엔비디아': 'nvidia', '테슬라': 'tesla', '마이크로소프트': 'microsoft',
  '아마존': 'amazon', '구글': 'google', '알파벳': 'alphabet', '메타': 'meta',
  '비트코인': 'BTCUSDT', '이더리움': 'ETHUSDT', '도지': 'DOGEUSDT', '리플': 'XRPUSDT',
  '솔라나': 'SOLUSDT', '에이다': 'ADAUSDT', '아발란체': 'AVAXUSDT',
  '매틱': 'POLUSDT', '폴리곤': 'POLUSDT', 'matic': 'POLUSDT', 'MATIC': 'POLUSDT'
};

const KR_NAMES = {
  '005930.KS': '삼성전자',
  '000660.KS': 'SK하이닉스',
  '035420.KS': 'NAVER',
  '035720.KS': '카카오',
  '068270.KS': '셀트리온'
};

// Search — with 5-min cache
app.get('/api/search', async (req, res) => {
  let { q } = req.query;
  if (!q) return res.status(400).json({ error: '검색어를 입력해주세요.' });

  // Translate Korean to English/symbol
  const normalized = q.toLowerCase().trim();
  if (KR_TRANSLATE[normalized]) q = KR_TRANSLATE[normalized];

  const cacheKey = `search:${q.toLowerCase().trim()}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  // If translated to a crypto USDT symbol, return a static entry (price from Binance on frontend)
  if (q.endsWith('USDT')) {
    const result = [{ symbol: q, name: q.replace('USDT', ''), price: null, changePercent: 0, type: 'CRYPTO', currency: 'USD' }];
    setCache(cacheKey, result, 5 * 60 * 1000);
    return res.json(result);
  }

  // If translated to a KS stock symbol (e.g. 005930.KS), use Naver Finance Polling API (bypass Yahoo IP block)
  if (q.endsWith('.KS') || q.endsWith('.KQ')) {
    try {
      const code = q.split('.')[0];
      const naverUrl = `https://polling.finance.naver.com/api/realtime?query=SERVICE_ITEM:${code}`;
      const naverRes = await fetch(naverUrl);
      const naverJson = await naverRes.json();
      const naverData = naverJson.result.areas[0].datas[0];
      if (naverData) {
        const result = [{
          symbol: q,
          name: KR_NAMES[q] || q,
          price: naverData.nv,
          changePercent: naverData.cr * (naverData.cv === 0 ? 0 : (naverData.nv >= naverData.pcv ? 1 : -1)),
          type: 'STOCK',
          currency: 'KRW'
        }];
        setCache(cacheKey, result, 5 * 60 * 1000);
        return res.json(result);
      }
    } catch (err) {
      console.error('Naver KS direct search error:', err.message);
    }
  }

  // Fallback for Korean searches: search the loaded krx.json
  const isKorean = /[가-힣]/.test(q);
  if (isKorean && krxStocks.length > 0) {
    try {
      // Find up to 5 matching stocks
      const matches = krxStocks.filter(s => s.name.includes(q)).slice(0, 5);
      if (matches.length > 0) {
        const codes = matches.map(s => s.symbol.split('.')[0]).join(',');
        const naverUrl = `https://polling.finance.naver.com/api/realtime?query=SERVICE_ITEM:${codes}`;
        const naverRes = await fetch(naverUrl);
        const naverJson = await naverRes.json();
        const naverDatas = naverJson.result.areas[0].datas;

        const results = matches.map(s => {
          const code = s.symbol.split('.')[0];
          const data = naverDatas.find(d => d.cd === code);
          if (data) {
            return {
              symbol: s.symbol,
              name: s.name,
              price: data.nv,
              changePercent: data.cr * (data.cv === 0 ? 0 : (data.nv >= data.pcv ? 1 : -1)),
              type: 'STOCK',
              currency: 'KRW'
            };
          }
          return null;
        }).filter(Boolean);

        if (results.length > 0) {
          setCache(cacheKey, results, 5 * 60 * 1000);
          return res.json(results);
        }
      }
    } catch (err) {
      console.error('KRX JSON search error:', err.message);
    }
  }

  try {
    let finalResults = [];
    if (process.env.FINNHUB_TOKEN) {
      try {
        const fUrl = `https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${process.env.FINNHUB_TOKEN}`;
        const searchRes = await fetch(fUrl).then(r => r.json());
        const symbols = (searchRes.result || []).filter(r => r.type === 'Common Stock' || r.type === '').slice(0, 5).map(r => r.symbol);
        
        const fetchQuote = async (sym) => {
          const resp = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${process.env.FINNHUB_TOKEN}`);
          return await resp.json();
        };
        
        const quotes = await Promise.all(symbols.map(async (s) => {
          try {
            const quote = await fetchQuote(s);
            if (!quote || !quote.c) return null;
            return {
              symbol: s,
              name: searchRes.result.find(r => r.symbol === s)?.description || s,
              price: quote.c,
              changePercent: quote.pc > 0 ? ((quote.c - quote.pc) / quote.pc * 100) : 0,
              type: 'STOCK',
              currency: 'USD'
            };
          } catch { return null; }
        }));
        finalResults = quotes.filter(Boolean);
      } catch (err) {
        console.error('Finnhub search failed:', err.message);
      }
    }

    if (finalResults.length === 0) {
      // Fallback to Yahoo if Finnhub failed or not configured
      try {
        const results = await enqueue(async () => {
          const searchResults = await yf.search(q);
          const validQuotes = (searchResults.quotes || [])
            .filter(quote => ['EQUITY', 'CRYPTOCURRENCY', 'ETF'].includes(quote.quoteType))
            .slice(0, 8);
          if (validQuotes.length === 0) return [];

          const symbols = validQuotes.map(q => q.symbol);
          const quotes = await yf.quote(symbols);
          const quotesArray = Array.isArray(quotes) ? quotes : [quotes];

          return quotesArray.map(quote => ({
            symbol: quote.quoteType === 'CRYPTOCURRENCY' ? quote.symbol.replace('-USD', 'USDT').replace('MATICUSDT', 'POLUSDT') : quote.symbol,
            name: quote.shortName || quote.longName || quote.symbol,
            price: quote.regularMarketPrice,
            changePercent: quote.regularMarketChangePercent,
            type: quote.quoteType === 'CRYPTOCURRENCY' ? 'CRYPTO' : 'STOCK',
            currency: quote.currency || 'USD'
          })).filter(r => r.price != null);
        });
        finalResults = results;
      } catch (err) {
        console.error('Yahoo fallback search failed:', err.message);
      }
    }

    setCache(cacheKey, finalResults, 5 * 60 * 1000); // 5 min
    res.json(finalResults);
  } catch (error) {
    console.error('Search API Error:', error.message);
    res.status(500).json({ error: '검색 실패: ' + error.message });
  }
});

// Top 10 Stocks — with 3-min cache
app.get('/api/stocks/top', async (req, res) => {
  const cacheKey = 'stocks:top10';
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  const FINNHUB_TOKEN = process.env.FINNHUB_TOKEN || '';

  // US stocks via Finnhub (works from any server, no IP block)
  const usSymbols = [
    { symbol: 'AAPL', name: 'Apple' },
    { symbol: 'NVDA', name: 'NVIDIA' },
    { symbol: 'TSLA', name: 'Tesla' },
    { symbol: 'MSFT', name: 'Microsoft' },
    { symbol: 'AMZN', name: 'Amazon' },
  ];

  // Korean stocks — static fallback list with reference prices
  // Yahoo Finance blocks cloud IPs so we serve a placeholder with a note
  const krStocksStatic = [
    { symbol: '005930.KS', name: '삼성전자', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '000660.KS', name: 'SK하이닉스', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '035420.KS', name: 'NAVER', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '035720.KS', name: '카카오', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '068270.KS', name: '셀트리온', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
  ];

  try {
    let usResults = [];
    let krResults = krStocksStatic; // start with static, update below

    // Try to fetch KR stocks via Naver Finance API (Bypass Yahoo IP Blocks)
    try {
      const codes = krStocksStatic.map(s => s.symbol.split('.')[0]).join(',');
      const naverUrl = `https://polling.finance.naver.com/api/realtime?query=SERVICE_ITEM:${codes}`;
      const naverRes = await fetch(naverUrl);
      const naverJson = await naverRes.json();
      const naverDatas = naverJson.result.areas[0].datas;
      
      krResults = krStocksStatic.map(s => {
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
      console.error('Naver KR Stocks fallback failed:', e.message);
    }

    if (FINNHUB_TOKEN) {
      // Use Finnhub API (requires free API key from finnhub.io)
      const fetchQuote = async (sym) => {
        const resp = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_TOKEN}`);
        const data = await resp.json();
        return data;
      };

      const quotes = await Promise.all(usSymbols.map(async (s) => {
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
      // No API key — try Yahoo as fallback (works locally, may fail on cloud)
      try {
        const quotes = await enqueue(async () => {
          const r = await yf.quote(usSymbols.map(s => s.symbol));
          return Array.isArray(r) ? r : [r];
        });
        usResults = quotes.map(q => ({
          symbol: q.symbol,
          name: usSymbols.find(s => s.symbol === q.symbol)?.name || q.shortName || q.symbol,
          price: q.regularMarketPrice,
          changePercent: q.regularMarketChangePercent,
          type: 'STOCK', currency: q.currency || 'USD'
        })).filter(r => r.price != null);
      } catch (e) {
        console.error('Yahoo fallback failed:', e.message);
        // Return static US data if everything fails
        usResults = usSymbols.map(s => ({ ...s, price: null, changePercent: 0, type: 'STOCK', currency: 'USD' }));
      }
    }

    const results = [...usResults, ...krResults];
    setCache(cacheKey, results, 3 * 60 * 1000); // 3 min
    res.json(results);
  } catch (error) {
    console.error('Top Stocks API Error:', error.message);
    // Even on total failure, return static list so UI doesn't break
    res.json([...usSymbols.map(s => ({ ...s, price: null, changePercent: 0, type: 'STOCK', currency: 'USD' })), ...krStocksStatic]);
  }
});


// Helper: convert range string to period1 Date
function rangeToPeriod1(range) {
  const d = new Date();
  switch (range) {
    case '1d':  d.setDate(d.getDate() - 1); break;
    case '5d':  d.setDate(d.getDate() - 5); break;
    case '1mo': d.setMonth(d.getMonth() - 1); break;
    case '3mo': d.setMonth(d.getMonth() - 3); break;
    case '6mo': d.setMonth(d.getMonth() - 6); break;
    case '1y':  d.setFullYear(d.getFullYear() - 1); break;
    case '2y':  d.setFullYear(d.getFullYear() - 2); break;
    case '5y':  d.setFullYear(d.getFullYear() - 5); break;
    default:    d.setMonth(d.getMonth() - 1); break;
  }
  return d;
}

// Chart Data — with 10-min cache, uses queue (stocks only)
app.get('/api/chart/:symbol', async (req, res) => {
  const { symbol } = req.params;
  const { interval = '1d', range = '1mo' } = req.query;

  // Crypto symbols should be fetched directly from Binance on the frontend
  if (symbol.endsWith('USDT') || symbol.match(/^[A-Z]{3,5}(BTC|ETH)$/)) {
    return res.status(400).json({ error: '코인 차트는 Binance API를 직접 사용하세요.' });
  }

  const cacheKey = `chart:${symbol}:${interval}:${range}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const candles = await enqueue(async () => {
      let resultQuotes = [];
      let yfFailed = false;

      // 1. Try Yahoo Finance First (Fails on Render)
      try {
        const period1 = rangeToPeriod1(range);
        const result = await yf.chart(symbol, { period1, period2: new Date(), interval });
        resultQuotes = result.quotes || [];
      } catch (err) {
        console.error('Yahoo Chart failed, using fallback:', err.message);
        yfFailed = true;
      }

      // 2. Fallback for KR Stocks -> Naver fchart
      if (yfFailed && (symbol.endsWith('.KS') || symbol.endsWith('.KQ'))) {
        try {
          const code = symbol.split('.')[0];
          const tf = (interval === '1mo' || interval === '1M') ? 'month' : interval === '1wk' ? 'week' : 'day';
          const count = range === '5y' ? 250 : range === '1y' ? 250 : range === '3mo' ? 60 : range === '1mo' ? 22 : 10;
          const naverUrl = `https://fchart.stock.naver.com/sise.nhn?symbol=${code}&timeframe=${tf}&count=${count}&requestType=0`;
          const resp = await fetch(naverUrl);
          const xml = await resp.text();
          const items = xml.match(/<item data="([^"]+)"/g) || [];
          resultQuotes = items.map(item => {
             const data = item.match(/data="([^"]+)"/)[1].split('|');
             const dateStr = data[0];
             const y = dateStr.substring(0,4), m = dateStr.substring(4,6), d = dateStr.substring(6,8);
             return {
               date: new Date(`${y}-${m}-${d}T09:00:00Z`),
               open: parseFloat(data[1]), high: parseFloat(data[2]),
               low: parseFloat(data[3]), close: parseFloat(data[4]), volume: parseFloat(data[5])
             };
          });
        } catch(e) { console.error('Naver chart fallback failed:', e.message); }
      } 
      // 3. Fallback for US Stocks -> Finnhub
      else if (yfFailed && process.env.FINNHUB_TOKEN) {
        try {
           const resMap = { '15m': '15', '60m': '60', '1d': 'D', '1wk': 'W', '1mo': 'M' };
           const resolution = resMap[interval] || 'D';
           const from = Math.floor(rangeToPeriod1(range).getTime() / 1000);
           const to = Math.floor(Date.now() / 1000);
           const finnUrl = `https://finnhub.io/api/v1/stock/candle?symbol=${symbol}&resolution=${resolution}&from=${from}&to=${to}&token=${process.env.FINNHUB_TOKEN}`;
           const resp = await fetch(finnUrl);
           const json = await resp.json();
           if (json.s === 'ok') {
              resultQuotes = json.t.map((t, i) => ({
                 date: new Date(t * 1000),
                 open: json.o[i], high: json.h[i],
                 low: json.l[i], close: json.c[i], volume: json.v[i]
              }));
           }
        } catch(e) { console.error('Finnhub chart fallback failed:', e.message); }
      }

      return resultQuotes.map(q => ({
        time: Math.floor(new Date(q.date).getTime() / 1000),
        open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume
      })).filter(c => c.open != null && c.close != null && !isNaN(c.time));
    });

    setCache(cacheKey, candles, 10 * 60 * 1000); // 10 min
    res.json(candles);
  } catch (error) {
    console.error('Chart API Error:', error.message);
    res.status(500).json({ error: '차트 데이터 로딩 실패: ' + error.message });
  }
});

// Sparkline for stocks — lightweight endpoint, 30-min cache
// Returns just close prices for mini chart (stocks only — crypto uses Binance directly)
app.get('/api/sparkline/:symbol', async (req, res) => {
  const { symbol } = req.params;

  // Reject crypto symbols — frontend should use Binance API directly
  if (symbol.endsWith('USDT') || symbol.endsWith('BTC') || symbol.endsWith('ETH')) {
    return res.status(400).json({ error: '코인은 Binance API를 사용하세요.' });
  }

  const cacheKey = `sparkline:${symbol}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const prices = await enqueue(async () => {
      let resultQuotes = [];
      let yfFailed = false;
      try {
        const period1 = rangeToPeriod1('1wk');
        const result = await yf.chart(symbol, { period1, period2: new Date(), interval: '15m' });
        resultQuotes = result.quotes || [];
      } catch(err) {
        yfFailed = true;
      }
      
      if (yfFailed && (symbol.endsWith('.KS') || symbol.endsWith('.KQ'))) {
        try {
          const code = symbol.split('.')[0];
          const resp = await fetch(`https://fchart.stock.naver.com/sise.nhn?symbol=${code}&timeframe=day&count=7&requestType=0`);
          const xml = await resp.text();
          const items = xml.match(/<item data="([^"]+)"/g) || [];
          resultQuotes = items.map(item => ({ close: parseFloat(item.match(/data="([^"]+)"/)[1].split('|')[4]) }));
        } catch(e) {}
      } else if (yfFailed && process.env.FINNHUB_TOKEN) {
        try {
           const from = Math.floor(rangeToPeriod1('1wk').getTime() / 1000);
           const to = Math.floor(Date.now() / 1000);
           const resp = await fetch(`https://finnhub.io/api/v1/stock/candle?symbol=${symbol}&resolution=15&from=${from}&to=${to}&token=${process.env.FINNHUB_TOKEN}`);
           const json = await resp.json();
           if (json.s === 'ok') resultQuotes = json.c.map(c => ({ close: c }));
        } catch(e) {}
      }

      return resultQuotes.filter(q => q.close != null).map(q => q.close);
    });

    setCache(cacheKey, prices, 30 * 60 * 1000); // 30 min
    res.json(prices);
  } catch (error) {
    res.status(500).json({ error: 'sparkline 로딩 실패: ' + error.message });
  }
});

// ─── Ranking ──────────────────────────────────────────────────────────────────
app.get('/api/ranking', (req, res) => {
  db.all('SELECT id, nickname, balance FROM users', [], (err, users) => {
    if (err) return res.status(500).json({ error: '데이터베이스 오류' });
    if (users.length === 0) return res.json([]);

    let pending = users.length;
    users.forEach((user) => {
      user.holdings = [];
      db.all('SELECT asset_symbol, asset_type, quantity, average_price FROM portfolios WHERE user_id = ? AND quantity > 0',
        [user.id], (err2, rows) => {
          if (!err2 && rows) {
            user.holdings = rows.map(r => {
              let name = r.asset_symbol;
              const sym = r.asset_symbol;
              if (krxNameMap[sym]) name = krxNameMap[sym];
              else if (KR_NAMES && KR_NAMES[sym]) name = KR_NAMES[sym];
              else if (r.asset_type === 'CRYPTO') name = sym.replace('USDT', '');
              
              return {
                symbol: r.asset_symbol,
                name: name,
                type: r.asset_type,
                quantity: r.quantity,
                avgPrice: r.average_price
              };
            });
          }
          pending--;
          if (pending === 0) res.json(users);
        });
    });
  });
});

// ─── Portfolio & Trading ──────────────────────────────────────────────────────

// Build a symbol→name map from krxStocks for fast lookups
const krxNameMap = {};
krxStocks.forEach(s => { krxNameMap[s.symbol] = s.name; });

app.get('/api/portfolio', authenticateToken, async (req, res) => {
  db.all('SELECT * FROM portfolios WHERE user_id = ? AND quantity > 0', [req.user.userId], async (err, rows) => {
    if (err) return res.status(500).json({ error: '데이터베이스 오류' });

    // Enrich each row with asset_name
    const enriched = rows.map(row => {
      let name = row.asset_name || row.asset_symbol;
      const sym = row.asset_symbol;
      if (krxNameMap[sym]) {
        name = krxNameMap[sym];
      } else if (KR_NAMES[sym]) {
        name = KR_NAMES[sym];
      } else if (row.asset_type === 'CRYPTO') {
        name = sym.replace('USDT', '');
      }
      return { ...row, asset_name: name };
    });

    // Fetch current prices for KR stocks (.KS/.KQ) via Naver realtime API
    const krRows = enriched.filter(r => r.asset_symbol.endsWith('.KS') || r.asset_symbol.endsWith('.KQ'));
    if (krRows.length > 0) {
      try {
        const codes = krRows.map(r => r.asset_symbol.split('.')[0]).join(',');
        const naverUrl = `https://polling.finance.naver.com/api/realtime?query=SERVICE_ITEM:${codes}`;
        const naverRes = await fetch(naverUrl);
        const naverJson = await naverRes.json();
        const naverDatas = naverJson.result.areas[0].datas;
        naverDatas.forEach(d => {
          const row = enriched.find(r => r.asset_symbol.startsWith(d.cd + '.'));
          if (row) {
            row.current_price = d.nv;
            row.change_percent = d.cr * (d.cv === 0 ? 0 : (d.nv >= d.pcv ? 1 : -1));
          }
        });
      } catch (e) {
        console.error('Portfolio KR price fetch failed:', e.message);
      }
    }

    res.json(enriched);
  });
});

// Transaction history for portfolio chart
app.get('/api/portfolio/history', authenticateToken, (req, res) => {
  db.all(
    'SELECT total_asset_krw as value, timestamp as time FROM balance_history WHERE user_id = ? ORDER BY timestamp ASC',
    [req.user.userId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: '데이터베이스 오류' });
      res.json(rows.map(r => ({
        time: Math.floor(new Date(r.time).getTime() / 1000),
        value: r.value
      })));
    }
  );
});

app.post('/api/portfolio/history', authenticateToken, (req, res) => {
  const { total_asset_krw } = req.body;
  if (total_asset_krw == null) return res.status(400).json({ error: 'Missing total_asset_krw' });
  db.run('INSERT INTO balance_history (user_id, total_asset_krw) VALUES (?, ?)', [req.user.userId, total_asset_krw], (err) => {
    if (err) return res.status(500).json({ error: '데이터베이스 오류' });
    res.json({ success: true });
  });
});

// Transaction history for portfolio list
app.get('/api/transactions', authenticateToken, (req, res) => {
  db.all(
    'SELECT * FROM transactions WHERE user_id = ? ORDER BY timestamp ASC',
    [req.user.userId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: '데이터베이스 오류' });
      res.json(rows);
    }
  );
});

// Execute Trade (BUY/SELL) — uses unified db.beginTransaction()
app.post('/api/trade', authenticateToken, async (req, res) => {
  const { asset_symbol, asset_type, type, quantity, price } = req.body;
  const userId = req.user.userId;

  const isKRW = asset_symbol.endsWith('.KS') || asset_symbol.endsWith('.KQ');
  const USD_TO_KRW = 1380;
  const totalAmountAssetCurrency = quantity * price;
  const totalAmountKRW = isKRW ? totalAmountAssetCurrency : totalAmountAssetCurrency * USD_TO_KRW;

  /**
   * 실제 수수료 구조 (2025년 기준)
   * - 국내주식 매수: 위탁수수료 0.015%
   * - 국내주식 매도: 위탁수수료 0.015% + 증권거래세 0.20% = 0.215%
   * - 해외주식:     위탁수수료 0.25% (매수/매도 동일)
   * - 코인:         Binance 기준 0.1% (매수/매도 동일)
   */
  let feeRate;
  if (asset_type === 'CRYPTO') {
    feeRate = 0.001; // 0.1%
  } else if (isKRW) {
    feeRate = type === 'BUY' ? 0.00015 : 0.00215; // 매수 0.015%, 매도 0.215%
  } else {
    feeRate = 0.0025; // 해외주식 0.25%
  }
  const feeKRW = Math.round(totalAmountKRW * feeRate);

  if (!['BUY', 'SELL'].includes(type))
    return res.status(400).json({ error: '잘못된 거래 유형입니다.' });
  if (!asset_symbol || !asset_type || !quantity || !price)
    return res.status(400).json({ error: '필수 파라미터가 누락되었습니다.' });

  let tx;
  try {
    tx = await db.beginTransaction();

    const user = await tx.get('SELECT balance FROM users WHERE id = ?', [userId]);
    if (!user) throw new Error('사용자를 찾을 수 없습니다.');

    if (type === 'BUY') {
      const amountToDeduct = totalAmountKRW + feeKRW;
      if (user.balance < amountToDeduct) {
        await tx.rollback();
        return res.status(400).json({ error: `잔액 부족 (수수료 포함 필요: ₩${amountToDeduct.toLocaleString('ko-KR', { maximumFractionDigits: 0 })})` });
      }
      await tx.run('UPDATE users SET balance = balance - ? WHERE id = ?', [amountToDeduct, userId]);
      const portfolio = await tx.get('SELECT * FROM portfolios WHERE user_id = ? AND asset_symbol = ?', [userId, asset_symbol]);
      if (portfolio) {
        const newQty = portfolio.quantity + quantity;
        const newAvg = ((portfolio.quantity * portfolio.average_price) + totalAmountAssetCurrency) / newQty;
        await tx.run('UPDATE portfolios SET quantity = ?, average_price = ? WHERE id = ?', [newQty, newAvg, portfolio.id]);
      } else {
        await tx.run('INSERT INTO portfolios (user_id, asset_symbol, asset_type, quantity, average_price) VALUES (?, ?, ?, ?, ?)',
          [userId, asset_symbol, asset_type, quantity, price]);
      }
    } else {
      const amountToAdd = totalAmountKRW - feeKRW;
      const portfolio = await tx.get('SELECT * FROM portfolios WHERE user_id = ? AND asset_symbol = ?', [userId, asset_symbol]);
      if (!portfolio || portfolio.quantity < quantity) {
        await tx.rollback();
        return res.status(400).json({ error: `보유 수량 부족 (보유: ${portfolio ? portfolio.quantity.toFixed(6) : 0}개)` });
      }
      await tx.run('UPDATE users SET balance = balance + ? WHERE id = ?', [amountToAdd, userId]);
      await tx.run('UPDATE portfolios SET quantity = ? WHERE id = ?', [portfolio.quantity - quantity, portfolio.id]);
    }

    await tx.run(
      'INSERT INTO transactions (user_id, asset_symbol, asset_type, type, quantity, price, total_amount, fee) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, asset_symbol, asset_type, type, quantity, price, totalAmountKRW, feeKRW]
    );
    await tx.commit();

    // 수수료 내역 메시지 구성
    const feeTypeLabel = asset_type === 'CRYPTO'
      ? '코인 거래수수료 0.1%'
      : isKRW
        ? (type === 'BUY' ? '위탁수수료 0.015%' : '위탁수수료 0.015% + 증권거래세 0.20%')
        : '해외주식 수수료 0.25%';

    res.json({
      message: `${asset_symbol} ${type === 'BUY' ? '매수' : '매도'} 체결!\n수수료: ₩${feeKRW.toLocaleString('ko-KR')} (${feeTypeLabel})`,
      totalAmount: totalAmountKRW, type, fee: feeKRW
    });
  } catch (err) {
    if (tx) { try { await tx.rollback(); } catch (_) {} }
    res.status(500).json({ error: '거래 처리 실패: ' + err.message });
  }
});

app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
