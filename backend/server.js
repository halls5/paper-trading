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
  // Only translate EXACT match to a single stock — do NOT add partial words like '하이닉스'
  // because that prevents ETF search (e.g. KODEX SK하이닉스 레버리지)
  '삼성전자': '005930.KS',
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

// Static US stock/ETF list for search fallback (when Yahoo/Finnhub unavailable on cloud)
const US_STATIC = [
  // ETFs
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust' },
  { symbol: 'QQQ', name: 'Invesco QQQ Trust (NASDAQ-100)' },
  { symbol: 'TQQQ', name: 'ProShares UltraPro QQQ (3x Leveraged NASDAQ-100)' },
  { symbol: 'SQQQ', name: 'ProShares UltraPro Short QQQ (-3x NASDAQ-100)' },
  { symbol: 'QLD', name: 'ProShares Ultra QQQ (2x NASDAQ-100)' },
  { symbol: 'QID', name: 'ProShares UltraShort QQQ (-2x NASDAQ-100)' },
  { symbol: 'QQEW', name: 'First Trust NASDAQ-100 Equal Weighted Index Fund' },
  { symbol: 'QQQM', name: 'Invesco NASDAQ-100 ETF' },
  { symbol: 'QQQA', name: 'ProShares NASDAQ-100 Dorsey Wright Momentum ETF' },
  { symbol: 'VOO', name: 'Vanguard S&P 500 ETF' },
  { symbol: 'IVV', name: 'iShares Core S&P 500 ETF' },
  { symbol: 'VTI', name: 'Vanguard Total Stock Market ETF' },
  { symbol: 'SCHD', name: 'Schwab US Dividend Equity ETF' },
  { symbol: 'SOXX', name: 'iShares Semiconductor ETF' },
  { symbol: 'SOXL', name: 'Direxion Daily Semiconductor Bull 3x Shares' },
  { symbol: 'SOXS', name: 'Direxion Daily Semiconductor Bear 3x Shares' },
  { symbol: 'ARKK', name: 'ARK Innovation ETF' },
  { symbol: 'JEPI', name: 'JPMorgan Equity Premium Income ETF' },
  { symbol: 'DIA', name: 'SPDR Dow Jones Industrial Average ETF Trust' },
  { symbol: 'IWM', name: 'iShares Russell 2000 ETF' },
  { symbol: 'TLT', name: 'iShares 20+ Year Treasury Bond ETF' },
  { symbol: 'GLD', name: 'SPDR Gold Shares' },
  { symbol: 'SLV', name: 'iShares Silver Trust' },
  { symbol: 'USO', name: 'United States Oil Fund' },
  { symbol: 'XLK', name: 'Technology Select Sector SPDR Fund' },
  { symbol: 'XLF', name: 'Financial Select Sector SPDR Fund' },
  { symbol: 'XLV', name: 'Health Care Select Sector SPDR Fund' },
  { symbol: 'XLE', name: 'Energy Select Sector SPDR Fund' },
  { symbol: 'VIG', name: 'Vanguard Dividend Appreciation ETF' },
  { symbol: 'VYM', name: 'Vanguard High Dividend Yield ETF' },
  { symbol: 'RSP', name: 'Invesco S&P 500 Equal Weight ETF' },
  { symbol: 'SPXL', name: 'Direxion Daily S&P 500 Bull 3x Shares' },
  { symbol: 'SPXS', name: 'Direxion Daily S&P 500 Bear 3x Shares' },
  { symbol: 'UPRO', name: 'ProShares UltraPro S&P 500 (3x S&P 500)' },
  { symbol: 'SPXU', name: 'ProShares UltraPro Short S&P 500 (-3x S&P 500)' },
  { symbol: 'SSO', name: 'ProShares Ultra S&P 500 (2x S&P 500)' },
  { symbol: 'SDS', name: 'ProShares UltraShort S&P 500 (-2x S&P 500)' },
  { symbol: 'LABU', name: 'Direxion Daily S&P Biotech Bull 3x Shares' },
  { symbol: 'LABD', name: 'Direxion Daily S&P Biotech Bear 3x Shares' },
  { symbol: 'TECL', name: 'Direxion Daily Technology Bull 3x Shares' },
  { symbol: 'TECS', name: 'Direxion Daily Technology Bear 3x Shares' },
  { symbol: 'FNGU', name: 'MicroSectors FANG+ Index 3x Leveraged ETN' },
  { symbol: 'FNGD', name: 'MicroSectors FANG+ Index -3x Inverse Leveraged ETN' },
  { symbol: 'NVDL', name: 'GraniteShares 2x Long NVDA Daily ETF' },
  { symbol: 'NVDD', name: 'GraniteShares 1x Short NVDA Daily ETF' },
  { symbol: 'TSLL', name: 'Direxion Daily TSLA Bull 2x Shares' },
  { symbol: 'TSLS', name: 'Direxion Daily TSLA Bear 1x Shares' },
  { symbol: 'MSTU', name: 'T-Rex 2X Long MSTR Daily Target ETF' },
  { symbol: 'IBIT', name: 'iShares Bitcoin Trust ETF' },
  { symbol: 'FBTC', name: 'Fidelity Wise Origin Bitcoin Fund' },
  { symbol: 'BITB', name: 'Bitwise Bitcoin ETF' },
  // US Stocks
  { symbol: 'AAPL', name: 'Apple Inc.' },
  { symbol: 'NVDA', name: 'NVIDIA Corporation' },
  { symbol: 'MSFT', name: 'Microsoft Corporation' },
  { symbol: 'GOOGL', name: 'Alphabet Inc. (Google)' },
  { symbol: 'AMZN', name: 'Amazon.com Inc.' },
  { symbol: 'META', name: 'Meta Platforms Inc. (Facebook)' },
  { symbol: 'TSLA', name: 'Tesla Inc.' },
  { symbol: 'AVGO', name: 'Broadcom Inc.' },
  { symbol: 'JPM', name: 'JPMorgan Chase & Co.' },
  { symbol: 'V', name: 'Visa Inc.' },
  { symbol: 'WMT', name: 'Walmart Inc.' },
  { symbol: 'UNH', name: 'UnitedHealth Group Inc.' },
  { symbol: 'MA', name: 'Mastercard Inc.' },
  { symbol: 'NFLX', name: 'Netflix Inc.' },
  { symbol: 'AMD', name: 'Advanced Micro Devices Inc.' },
  { symbol: 'CRM', name: 'Salesforce Inc.' },
  { symbol: 'ORCL', name: 'Oracle Corporation' },
  { symbol: 'PLTR', name: 'Palantir Technologies Inc.' },
];

// Helper: fetch Naver prices for an array of KRX codes (batches of 10)
async function fetchNaverPrices(codes) {
  const priceMap = {};
  const batchSize = 10;
  for (let i = 0; i < codes.length; i += batchSize) {
    const batch = codes.slice(i, i + batchSize);
    try {
      const url = `https://polling.finance.naver.com/api/realtime?query=SERVICE_ITEM:${batch.join(',')}`;
      const res = await fetch(url);
      const json = await res.json();
      const datas = json.result?.areas?.[0]?.datas || [];
      datas.forEach(d => { priceMap[d.cd] = d; });
    } catch (e) {
      console.error('Naver batch fetch error:', e.message);
    }
  }
  return priceMap;
}

// Search — with 5-min cache
app.get('/api/search', async (req, res) => {
  let { q } = req.query;
  if (!q) return res.status(400).json({ error: '검색어를 입력해주세요.' });

  // Translate Korean to English/symbol (only exact full-word translations)
  const normalized = q.toLowerCase().trim();
  if (KR_TRANSLATE[normalized]) q = KR_TRANSLATE[normalized];

  const cacheKey = `search:${q.toLowerCase().trim()}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  // If translated to a crypto USDT symbol, return a static entry
  if (q.endsWith('USDT')) {
    const result = [{ symbol: q, name: q.replace('USDT', ''), price: null, changePercent: 0, type: 'CRYPTO', currency: 'USD' }];
    setCache(cacheKey, result, 5 * 60 * 1000);
    return res.json(result);
  }

  // If an exact KRX symbol (e.g. 005930.KS), fetch directly
  if (q.endsWith('.KS') || q.endsWith('.KQ')) {
    try {
      const code = q.split('.')[0];
      const priceMap = await fetchNaverPrices([code]);
      const data = priceMap[code];
      if (data) {
        const result = [{
          symbol: q,
          name: KR_NAMES[q] || krxStocks.find(s => s.symbol === q)?.name || q,
          price: data.nv,
          changePercent: data.cr * (data.cv === 0 ? 0 : (data.nv >= data.pcv ? 1 : -1)),
          type: 'STOCK', currency: 'KRW'
        }];
        setCache(cacheKey, result, 5 * 60 * 1000);
        return res.json(result);
      }
    } catch (err) {
      console.error('Naver KS direct search error:', err.message);
    }
  }

  const finalResults = [];
  const addedSymbols = new Set();

  // ── 1. Search KRX stocks + ETFs (partial match, batch Naver requests) ───────
  if (krxStocks.length > 0) {
    try {
      const qLower = q.toLowerCase();
      const matches = krxStocks
        .filter(s => s.name.toLowerCase().includes(qLower) || s.symbol.toLowerCase().includes(qLower))
        .slice(0, 20);

      if (matches.length > 0) {
        const codes = matches.map(s => s.symbol.split('.')[0]);
        const priceMap = await fetchNaverPrices(codes);

        matches.forEach(s => {
          const code = s.symbol.split('.')[0];
          const data = priceMap[code];
          if (data) {
            finalResults.push({
              symbol: s.symbol, name: s.name,
              price: data.nv,
              changePercent: data.cr * (data.cv === 0 ? 0 : (data.nv >= data.pcv ? 1 : -1)),
              type: 'STOCK', currency: 'KRW'
            });
            addedSymbols.add(s.symbol);
          }
        });
      }
    } catch (err) {
      console.error('KRX search error:', err.message);
    }
  }

  // ── 2. Search US_STATIC (always works, no external API needed) ──────────────
  {
    const qUpper = q.toUpperCase();
    const qLower = q.toLowerCase();
    const staticMatches = US_STATIC.filter(s =>
      s.symbol.toUpperCase().includes(qUpper) || s.name.toLowerCase().includes(qLower)
    ).slice(0, 15);

    // Try to get prices for static matches (Finnhub preferred, price:null fallback)
    for (const s of staticMatches) {
      if (addedSymbols.has(s.symbol)) continue;
      let price = null, changePercent = 0;
      if (process.env.FINNHUB_TOKEN) {
        try {
          const resp = await fetch(`https://finnhub.io/api/v1/quote?symbol=${s.symbol}&token=${process.env.FINNHUB_TOKEN}`);
          const q = await resp.json();
          if (q && q.c) { price = q.c; changePercent = q.pc > 0 ? ((q.c - q.pc) / q.pc * 100) : 0; }
        } catch (_) {}
      }
      finalResults.push({ symbol: s.symbol, name: s.name, price, changePercent, type: 'STOCK', currency: 'USD' });
      addedSymbols.add(s.symbol);
    }
  }

  // ── 3. Finnhub search (for symbols not in US_STATIC) ────────────────────────
  if (process.env.FINNHUB_TOKEN && finalResults.filter(r => r.currency === 'USD').length < 3) {
    try {
      const fUrl = `https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${process.env.FINNHUB_TOKEN}`;
      const searchRes = await fetch(fUrl).then(r => r.json());
      const symbols = (searchRes.result || [])
        .filter(r => r.type === 'Common Stock' || r.type === '' || r.type === 'ETP' || r.type === 'ETF')
        .slice(0, 10).map(r => r.symbol);

      const quotes = await Promise.all(symbols.map(async (sym) => {
        if (addedSymbols.has(sym)) return null;
        try {
          const resp = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${process.env.FINNHUB_TOKEN}`);
          const qt = await resp.json();
          if (!qt || !qt.c) return null;
          return {
            symbol: sym,
            name: searchRes.result.find(r => r.symbol === sym)?.description || sym,
            price: qt.c,
            changePercent: qt.pc > 0 ? ((qt.c - qt.pc) / qt.pc * 100) : 0,
            type: 'STOCK', currency: 'USD'
          };
        } catch { return null; }
      }));
      quotes.filter(Boolean).forEach(r => {
        if (!addedSymbols.has(r.symbol)) { finalResults.push(r); addedSymbols.add(r.symbol); }
      });
    } catch (err) {
      console.error('Finnhub search failed:', err.message);
    }
  }

  // ── 4. Yahoo fallback (last resort) ─────────────────────────────────────────
  if (finalResults.length === 0) {
    try {
      const results = await enqueue(async () => {
        const searchResults = await yf.search(q);
        const validQuotes = (searchResults.quotes || [])
          .filter(quote => ['EQUITY', 'CRYPTOCURRENCY', 'ETF'].includes(quote.quoteType))
          .slice(0, 10);
        if (validQuotes.length === 0) return [];
        const symbols = validQuotes.map(v => v.symbol);
        let quotesArray = [];
        try { const r = await yf.quote(symbols); quotesArray = Array.isArray(r) ? r : [r]; } catch (_) {}
        return quotesArray.map(quote => ({
          symbol: quote.quoteType === 'CRYPTOCURRENCY' ? quote.symbol.replace('-USD', 'USDT').replace('MATICUSDT', 'POLUSDT') : quote.symbol,
          name: quote.shortName || quote.longName || quote.symbol,
          price: quote.regularMarketPrice,
          changePercent: quote.regularMarketChangePercent,
          type: quote.quoteType === 'CRYPTOCURRENCY' ? 'CRYPTO' : 'STOCK',
          currency: quote.currency || 'USD'
        })).filter(r => r.price != null);
      });
      results.forEach(r => { if (!addedSymbols.has(r.symbol)) { finalResults.push(r); addedSymbols.add(r.symbol); } });
    } catch (err) {
      console.error('Yahoo fallback search failed:', err.message);
    }
  }

  setCache(cacheKey, finalResults, 5 * 60 * 1000);
  res.json(finalResults);
});

// Top 10 Stocks — with 3-min cache
app.get('/api/stocks/top', async (req, res) => {
  const cacheKey = 'stocks:top10';
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  const FINNHUB_TOKEN = process.env.FINNHUB_TOKEN || '';

  // US stocks via Finnhub (works from any server, no IP block)
    const usSymbols = [
    { symbol: 'AAPL', name: 'Apple' }, { symbol: 'NVDA', name: 'NVIDIA' }, { symbol: 'MSFT', name: 'Microsoft' },
    { symbol: 'GOOGL', name: 'Alphabet' }, { symbol: 'AMZN', name: 'Amazon' }, { symbol: 'META', name: 'Meta' },
    { symbol: 'TSLA', name: 'Tesla' }, { symbol: 'BRK.B', name: 'Berkshire Hathaway' }, { symbol: 'AVGO', name: 'Broadcom' },
    { symbol: 'LLY', name: 'Eli Lilly' }, { symbol: 'TSM', name: 'TSMC' }, { symbol: 'JPM', name: 'JPMorgan Chase' },
    { symbol: 'V', name: 'Visa' }, { symbol: 'WMT', name: 'Walmart' }, { symbol: 'UNH', name: 'UnitedHealth' },
    { symbol: 'MA', name: 'Mastercard' }, { symbol: 'JNJ', name: 'Johnson & Johnson' }, { symbol: 'PG', name: 'Procter & Gamble' },
    { symbol: 'HD', name: 'Home Depot' }, { symbol: 'COST', name: 'Costco' }, { symbol: 'ABBV', name: 'AbbVie' },
    { symbol: 'MRK', name: 'Merck' }, { symbol: 'CRM', name: 'Salesforce' }, { symbol: 'NFLX', name: 'Netflix' },
    { symbol: 'AMD', name: 'AMD' }
  ];

  // Korean stocks — static fallback list with reference prices
  // Yahoo Finance blocks cloud IPs so we serve a placeholder with a note
    const krStocksStatic = [
    { symbol: '005930.KS', name: '삼성전자', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '000660.KS', name: 'SK하이닉스', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '373220.KS', name: 'LG에너지솔루션', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '207940.KS', name: '삼성바이오로직스', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '005380.KS', name: '현대차', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '000270.KS', name: '기아', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '068270.KS', name: '셀트리온', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '005490.KS', name: 'POSCO홀딩스', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '035420.KS', name: 'NAVER', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '105560.KS', name: 'KB금융', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '028260.KS', name: '삼성물산', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '055550.KS', name: '신한지주', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '032830.KS', name: '삼성생명', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '035720.KS', name: '카카오', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '051910.KS', name: 'LG화학', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '012330.KS', name: '현대모비스', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '066570.KS', name: 'LG전자', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '003550.KS', name: 'LG', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '034730.KS', name: 'SK', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '086790.KS', name: '하나금융지주', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '015760.KS', name: '한국전력', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '033780.KS', name: 'KT&G', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '329180.KS', name: 'HD현대중공업', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '010140.KS', name: '삼성중공업', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '138040.KS', name: '메리츠금융지주', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' }
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

// Top 10 ETFs — with 3-min cache
app.get('/api/etfs/top', async (req, res) => {
  const cacheKey = 'etfs:top10';
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  const FINNHUB_TOKEN = process.env.FINNHUB_TOKEN || '';

    const usEtfSymbols = [
    { symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust' }, { symbol: 'QQQ', name: 'Invesco QQQ Trust' },
    { symbol: 'VOO', name: 'Vanguard S&P 500 ETF' }, { symbol: 'IVV', name: 'iShares Core S&P 500 ETF' },
    { symbol: 'VTI', name: 'Vanguard Total Stock Market ETF' }, { symbol: 'SCHD', name: 'Schwab US Dividend Equity ETF' },
    { symbol: 'TQQQ', name: 'ProShares UltraPro QQQ' }, { symbol: 'SOXX', name: 'iShares Semiconductor ETF' },
    { symbol: 'SOXL', name: 'Direxion Daily Semiconductor Bull 3x' }, { symbol: 'ARKK', name: 'ARK Innovation ETF' },
    { symbol: 'JEPI', name: 'JPMorgan Equity Premium Income ETF' }, { symbol: 'VIG', name: 'Vanguard Dividend Appreciation ETF' },
    { symbol: 'VYM', name: 'Vanguard High Dividend Yield ETF' }, { symbol: 'DIA', name: 'SPDR Dow Jones Industrial Average ETF Trust' },
    { symbol: 'IWM', name: 'iShares Russell 2000 ETF' }, { symbol: 'TLT', name: 'iShares 20+ Year Treasury Bond ETF' },
    { symbol: 'GLD', name: 'SPDR Gold Shares' }, { symbol: 'VNQ', name: 'Vanguard Real Estate Index Fund' },
    { symbol: 'VEA', name: 'Vanguard FTSE Developed Markets ETF' }, { symbol: 'VWO', name: 'Vanguard FTSE Emerging Markets ETF' },
    { symbol: 'IEMG', name: 'iShares Core MSCI Emerging Markets ETF' }, { symbol: 'IEFA', name: 'iShares Core MSCI EAFE ETF' },
    { symbol: 'AGG', name: 'iShares Core US Aggregate Bond ETF' }, { symbol: 'BND', name: 'Vanguard Total Bond Market ETF' },
    { symbol: 'LQD', name: 'iShares iBoxx $ Investment Grade Corporate Bond ETF' },
    { symbol: 'XLK', name: 'Technology Select Sector SPDR Fund' }, { symbol: 'XLF', name: 'Financial Select Sector SPDR Fund' },
    { symbol: 'XLV', name: 'Health Care Select Sector SPDR Fund' }, { symbol: 'XLE', name: 'Energy Select Sector SPDR Fund' },
    { symbol: 'XLY', name: 'Consumer Discretionary Select Sector SPDR Fund' }, { symbol: 'XLI', name: 'Industrial Select Sector SPDR Fund' },
    { symbol: 'XLC', name: 'Communication Services Select Sector SPDR Fund' }, { symbol: 'XLP', name: 'Consumer Staples Select Sector SPDR Fund' },
    { symbol: 'XLU', name: 'Utilities Select Sector SPDR Fund' }, { symbol: 'XLB', name: 'Materials Select Sector SPDR Fund' },
    { symbol: 'XLRE', name: 'Real Estate Select Sector SPDR Fund' }, { symbol: 'VUG', name: 'Vanguard Growth Index Fund' },
    { symbol: 'VTV', name: 'Vanguard Value Index Fund' }, { symbol: 'IWF', name: 'iShares Russell 1000 Growth ETF' },
    { symbol: 'IWD', name: 'iShares Russell 1000 Value ETF' }, { symbol: 'QUAL', name: 'iShares MSCI USA Quality Factor ETF' },
    { symbol: 'MTUM', name: 'iShares MSCI USA Momentum Factor ETF' }, { symbol: 'USMV', name: 'iShares MSCI USA Min Vol Factor ETF' },
    { symbol: 'RSP', name: 'Invesco S&P 500 Equal Weight ETF' }, { symbol: 'SDY', name: 'SPDR S&P Dividend ETF' },
    { symbol: 'DGRO', name: 'iShares Core Dividend Growth ETF' }, { symbol: 'NOBL', name: 'ProShares S&P 500 Dividend Aristocrats ETF' },
    { symbol: 'SPYG', name: 'SPDR Portfolio S&P 500 Growth ETF' }, { symbol: 'SPYV', name: 'SPDR Portfolio S&P 500 Value ETF' },
    { symbol: 'XBI', name: 'SPDR S&P Biotech ETF' }
  ];

    const krEtfSymbols = [
    { symbol: '069500.KS', name: 'KODEX 200', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '379800.KS', name: 'KODEX 미국나스닥100TR', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '379810.KS', name: 'KODEX 미국S&P500TR', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '133690.KS', name: 'TIGER 미국나스닥100', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '360750.KS', name: 'TIGER 미국S&P500', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '461580.KS', name: 'TIGER 미국배당+7%프리미엄다우존스', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' },
    { symbol: '458730.KS', name: 'TIGER 미국배당다우존스', price: null, changePercent: 0, type: 'STOCK', currency: 'KRW' }
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

// Helper: convert range string to period1 Date

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
  db.all('SELECT id, nickname, balance FROM users', [], async (err, users) => {
    if (err) return res.status(500).json({ error: '데이터베이스 오류' });
    if (users.length === 0) return res.json([]);

    try {
      db.all('SELECT * FROM portfolios WHERE quantity > 0', [], async (err2, rows) => {
        if (err2) return res.status(500).json({ error: '데이터베이스 오류' });

        const userHoldings = {};
        const krCodes = new Set();

        rows.forEach(r => {
          if (!userHoldings[r.user_id]) userHoldings[r.user_id] = [];
          
          let name = r.asset_symbol;
          const sym = r.asset_symbol;
          if (krxNameMap[sym]) name = krxNameMap[sym];
          else if (KR_NAMES && KR_NAMES[sym]) name = KR_NAMES[sym];
          else if (r.asset_type === 'CRYPTO') name = sym.replace('USDT', '');
          else if (r.asset_name) name = r.asset_name;
          
          const holding = {
            symbol: sym,
            name: name,
            type: r.asset_type,
            quantity: r.quantity,
            avgPrice: r.average_price
          };
          userHoldings[r.user_id].push(holding);

          if (sym.endsWith('.KS') || sym.endsWith('.KQ')) {
            krCodes.add(sym.split('.')[0]);
          }
        });

        let naverDataMap = {};
        if (krCodes.size > 0) {
          try {
            const codes = Array.from(krCodes).join(',');
            const naverUrl = `https://polling.finance.naver.com/api/realtime?query=SERVICE_ITEM:${codes}`;
            const naverRes = await fetch(naverUrl);
            const naverJson = await naverRes.json();
            const naverDatas = naverJson.result.areas[0].datas;
            naverDatas.forEach(d => { naverDataMap[d.cd] = d.nv; });
          } catch (e) {
            console.error('Ranking KR price fetch failed:', e.message);
          }
        }

        users.forEach(user => {
          user.holdings = userHoldings[user.id] || [];
          user.holdings.forEach(h => {
            if (h.symbol.endsWith('.KS') || h.symbol.endsWith('.KQ')) {
              const code = h.symbol.split('.')[0];
              if (naverDataMap[code]) {
                h.current_price = naverDataMap[code];
              }
            }
          });
        });

        res.json(users);
      });
    } catch (err) {
      res.status(500).json({ error: '데이터 처리 오류' });
    }
  });
});

// ─── Portfolio & Trading ──────────────────────────────────────────────────────

// Build a symbol→name map from krxStocks for fast lookups
const krxNameMap = {};
krxStocks.forEach(s => { krxNameMap[s.symbol] = s.name; });

// One-shot migration: sync portfolios.asset_name to the canonical krx.json name.
// Fixes legacy rows where asset_name was stored from a mis-labeled static list
// (e.g. 261220.KS saved as "KODEX 반도체 레버리지(하이닉스)" but is actually
// "KODEX WTI원유선물(H)"). Idempotent: only updates rows that differ.
setTimeout(function syncPortfolioNames() {
  db.all('SELECT DISTINCT asset_symbol FROM portfolios', [], (err, rows) => {
    if (err) return console.error('Portfolio name sync: failed to read symbols', err.message);
    const symbols = rows.map(r => r.asset_symbol).filter(s => krxNameMap[s]);
    if (symbols.length === 0) return;
    let updated = 0;
    let pending = symbols.length;
    symbols.forEach(sym => {
      const canonical = krxNameMap[sym];
      db.run(
        'UPDATE portfolios SET asset_name = ? WHERE asset_symbol = ? AND (asset_name IS NULL OR asset_name <> ?)',
        [canonical, sym, canonical],
        function (uerr) {
          if (!uerr && this && this.changes) updated += this.changes;
          if (--pending === 0 && updated > 0) {
            console.log(`✅ Portfolio name sync: updated ${updated} row(s) to krx.json names.`);
          }
        }
      );
    });
  });
}, 2000);

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
    'SELECT * FROM transactions WHERE user_id = ? ORDER BY timestamp DESC',
    [req.user.userId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: '데이터베이스 오류' });
      const enriched = rows.map(row => {
        let name = row.asset_symbol;
        const sym = row.asset_symbol;
        if (krxNameMap[sym]) name = krxNameMap[sym];
        else if (KR_NAMES && KR_NAMES[sym]) name = KR_NAMES[sym];
        else if (row.asset_type === 'CRYPTO') name = sym.replace('USDT', '');
        return { ...row, asset_name: name };
      });
      res.json(enriched);
    }
  );
});

// Execute Trade (BUY/SELL) — uses unified db.beginTransaction()
app.post('/api/trade', authenticateToken, async (req, res) => {
  const { asset_symbol, asset_type, type, quantity, price, asset_name } = req.body;
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
        // asset_name이 기존에 없었다면 이번 매수 시점에서 채워줌
        await tx.run('UPDATE portfolios SET quantity = ?, average_price = ?, asset_name = COALESCE(asset_name, ?) WHERE id = ?', [newQty, newAvg, asset_name || null, portfolio.id]);
      } else {
        await tx.run('INSERT INTO portfolios (user_id, asset_symbol, asset_type, quantity, average_price, asset_name) VALUES (?, ?, ?, ?, ?, ?)',
          [userId, asset_symbol, asset_type, quantity, price, asset_name || null]);
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
// ─── Admin / Debugging ──────────────────────────────────────────────────────────
app.post('/api/admin/reset', async (req, res) => {
  const { nickname } = req.body;
  if (!nickname) return res.status(400).json({ error: '닉네임을 입력하세요.' });

  try {
    db.get('SELECT id FROM users WHERE nickname = ?', [nickname], async (err, user) => {
      if (err) return res.status(500).json({ error: '데이터베이스 오류' });
      if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });

      const userId = user.id;
      let tx;
      try {
        tx = await db.beginTransaction();
        await tx.run('UPDATE users SET balance = 100000000 WHERE id = ?', [userId]);
        await tx.run('DELETE FROM portfolios WHERE user_id = ?', [userId]);
        await tx.run('DELETE FROM transactions WHERE user_id = ?', [userId]);
        await tx.run('DELETE FROM balance_history WHERE user_id = ?', [userId]);
        await tx.commit();
        res.json({ message: `${nickname}님의 계정이 1억 원으로 초기화되었습니다.` });
      } catch (txErr) {
        if (tx) { try { await tx.rollback(); } catch (_) {} }
        res.status(500).json({ error: '초기화 실패: ' + txErr.message });
      }
    });
  } catch (err) {
    res.status(500).json({ error: '서버 오류' });
  }
});

app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
