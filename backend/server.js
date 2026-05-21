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
  '삼성': 'samsung', '삼성전자': '005930.KS', '하이닉스': '000660.KS', 'sk하이닉스': '000660.KS',
  '네이버': '035420.KS', '카카오': '035720.KS', '셀트리온': '068270.KS',
  '애플': 'apple', '엔비디아': 'nvidia', '테슬라': 'tesla', '마이크로소프트': 'microsoft',
  '아마존': 'amazon', '구글': 'google', '알파벳': 'alphabet', '메타': 'meta',
  '비트코인': 'BTCUSDT', '이더리움': 'ETHUSDT', '도지': 'DOGEUSDT', '리플': 'XRPUSDT',
  '솔라나': 'SOLUSDT', '에이다': 'ADAUSDT', '아발란체': 'AVAXUSDT',
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

  // If translated to a KS stock symbol (e.g. 005930.KS), quote directly
  if (q.endsWith('.KS') || q.endsWith('.KQ')) {
    try {
      const quote = await enqueue(async () => {
        const quotes = await yf.quote([q]);
        return Array.isArray(quotes) ? quotes[0] : quotes;
      });
      if (quote?.regularMarketPrice) {
        const result = [{
          symbol: quote.symbol,
          name: quote.shortName || quote.longName || quote.symbol,
          price: quote.regularMarketPrice,
          changePercent: quote.regularMarketChangePercent,
          type: 'STOCK',
          currency: quote.currency || 'KRW'
        }];
        setCache(cacheKey, result, 5 * 60 * 1000);
        return res.json(result);
      }
    } catch (err) {
      console.error('KS direct search error:', err.message);
    }
  }

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
        symbol: quote.symbol,
        name: quote.shortName || quote.longName || quote.symbol,
        price: quote.regularMarketPrice,
        changePercent: quote.regularMarketChangePercent,
        type: quote.quoteType === 'CRYPTOCURRENCY' ? 'CRYPTO' : 'STOCK',
        currency: quote.currency || 'USD'
      })).filter(r => r.price != null);
    });

    setCache(cacheKey, results, 5 * 60 * 1000); // 5 min
    res.json(results);
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

  try {
    const results = await enqueue(async () => {
      const topSymbols = ['AAPL', 'NVDA', 'TSLA', 'MSFT', 'AMZN',
        '005930.KS', '000660.KS', '035420.KS', '035720.KS', '068270.KS'];
      const quotes = await yf.quote(topSymbols);
      const quotesArray = Array.isArray(quotes) ? quotes : [quotes];
      return quotesArray.map(quote => ({
        symbol: quote.symbol,
        name: quote.shortName || quote.longName || quote.symbol,
        price: quote.regularMarketPrice,
        changePercent: quote.regularMarketChangePercent,
        type: 'STOCK',
        currency: quote.currency || 'USD'
      })).filter(r => r.price != null);
    });

    setCache(cacheKey, results, 3 * 60 * 1000); // 3 min
    res.json(results);
  } catch (error) {
    console.error('Top Stocks API Error:', error.message);
    res.status(500).json({ error: '주식 데이터 로딩 실패: ' + error.message });
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
      const period1 = rangeToPeriod1(range);
      const period2 = new Date();
      const result = await yf.chart(symbol, { period1, period2, interval });
      const quotes = result.quotes || [];
      return quotes.map(q => ({
        time: Math.floor(new Date(q.date).getTime() / 1000),
        open: q.open,
        high: q.high,
        low: q.low,
        close: q.close,
        volume: q.volume
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
      const period1 = rangeToPeriod1('1mo');
      const result = await yf.chart(symbol, { period1, period2: new Date(), interval: '1d' });
      return (result.quotes || [])
        .filter(q => q.close != null)
        .map(q => q.close);
    });

    setCache(cacheKey, prices, 30 * 60 * 1000); // 30 min
    res.json(prices);
  } catch (error) {
    res.status(500).json({ error: 'sparkline 로딩 실패: ' + error.message });
  }
});

// ─── Ranking ──────────────────────────────────────────────────────────────────
app.get('/api/ranking', (req, res) => {
  const query = `
    SELECT 
      u.id, 
      u.nickname, 
      u.balance,
      COALESCE(
        (SELECT SUM(
          CASE 
            WHEN p.asset_symbol LIKE '%.KS' OR p.asset_symbol LIKE '%.KQ' THEN p.quantity * p.average_price
            ELSE p.quantity * p.average_price * 1380
          END
        ) FROM portfolios p WHERE p.user_id = u.id AND p.quantity > 0), 0
      ) AS holding_value
    FROM users u
    ORDER BY (u.balance + holding_value) DESC
    LIMIT 50
  `;

  db.all(query, [], (err, users) => {
    if (err) return res.status(500).json({ error: '데이터베이스 오류' });

    const INITIAL = 100_000_000;
    // For each user, also fetch their portfolio breakdown
    let pending = users.length;
    if (pending === 0) return res.json([]);

    const results = users.map((user, i) => {
      const totalAsset = user.balance + user.holding_value;
      return {
        rank: i + 1,
        nickname: user.nickname,
        balance: user.balance,
        totalAsset: totalAsset,
        profitLoss: totalAsset - INITIAL,
        returnRate: ((totalAsset - INITIAL) / INITIAL * 100).toFixed(2),
        holdings: []
      };
    });

    users.forEach((user, i) => {
      db.all('SELECT asset_symbol, asset_type, quantity, average_price FROM portfolios WHERE user_id = ? AND quantity > 0',
        [user.id], (err2, rows) => {
          if (!err2 && rows) {
            results[i].holdings = rows.map(r => ({
              symbol: r.asset_symbol,
              type: r.asset_type,
              quantity: r.quantity,
              avgPrice: r.average_price
            }));
          }
          pending--;
          if (pending === 0) res.json(results);
        });
    });
  });
});

// ─── Portfolio & Trading ──────────────────────────────────────────────────────

app.get('/api/portfolio', authenticateToken, (req, res) => {
  db.all('SELECT * FROM portfolios WHERE user_id = ? AND quantity > 0', [req.user.userId], (err, rows) => {
    if (err) return res.status(500).json({ error: '데이터베이스 오류' });
    res.json(rows);
  });
});

// Transaction history for portfolio chart
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

// Execute Trade (BUY/SELL) — promise-based to fix callback race condition
app.post('/api/trade', authenticateToken, (req, res) => {
  const { asset_symbol, asset_type, type, quantity, price } = req.body;
  const userId = req.user.userId;

  // 한국 주식(.KS, .KQ)이 아니면 거래 금액은 USD 기준이므로 KRW로 환산해서 잔고에서 차감
  const isKRW = asset_symbol.endsWith('.KS') || asset_symbol.endsWith('.KQ');
  const USD_TO_KRW = 1380;
  const totalAmountAssetCurrency = quantity * price;
  const totalAmountKRW = isKRW ? totalAmountAssetCurrency : totalAmountAssetCurrency * USD_TO_KRW;

  // 수수료 계산 (코인: 0.05%, 국내주식: 0.015%, 해외주식: 0.1%)
  const feeRate = asset_type === 'CRYPTO' ? 0.0005 : (isKRW ? 0.00015 : 0.001);
  const feeKRW = totalAmountKRW * feeRate;

  if (!['BUY', 'SELL'].includes(type))
    return res.status(400).json({ error: '잘못된 거래 유형입니다.' });
  if (!asset_symbol || !asset_type || !quantity || !price)
    return res.status(400).json({ error: '필수 파라미터가 누락되었습니다.' });

  const dbGet = (sql, params) => new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
  const dbRun = (sql, params) => new Promise((resolve, reject) =>
    db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));

  (async () => {
    await dbRun('BEGIN TRANSACTION', []);
    try {
      const user = await dbGet('SELECT balance FROM users WHERE id = ?', [userId]);
      if (!user) throw new Error('사용자를 찾을 수 없습니다.');

      if (type === 'BUY') {
        const amountToDeduct = totalAmountKRW + feeKRW;
        if (user.balance < amountToDeduct) {
          await dbRun('ROLLBACK', []);
          return res.status(400).json({ error: `잔액 부족 (수수료 포함 필요: ₩${amountToDeduct.toLocaleString('ko-KR', { maximumFractionDigits: 0 })})` });
        }
        await dbRun('UPDATE users SET balance = balance - ? WHERE id = ?', [amountToDeduct, userId]);
        const portfolio = await dbGet('SELECT * FROM portfolios WHERE user_id = ? AND asset_symbol = ?', [userId, asset_symbol]);
        if (portfolio) {
          const newQty = portfolio.quantity + quantity;
          const newAvg = ((portfolio.quantity * portfolio.average_price) + totalAmountAssetCurrency) / newQty;
          await dbRun('UPDATE portfolios SET quantity = ?, average_price = ? WHERE id = ?', [newQty, newAvg, portfolio.id]);
        } else {
          await dbRun('INSERT INTO portfolios (user_id, asset_symbol, asset_type, quantity, average_price) VALUES (?, ?, ?, ?, ?)',
            [userId, asset_symbol, asset_type, quantity, price]);
        }
      } else {
        const amountToAdd = totalAmountKRW - feeKRW;
        const portfolio = await dbGet('SELECT * FROM portfolios WHERE user_id = ? AND asset_symbol = ?', [userId, asset_symbol]);
        if (!portfolio || portfolio.quantity < quantity) {
          await dbRun('ROLLBACK', []);
          return res.status(400).json({ error: `보유 수량 부족 (보유: ${portfolio ? portfolio.quantity.toFixed(6) : 0}개)` });
        }
        await dbRun('UPDATE users SET balance = balance + ? WHERE id = ?', [amountToAdd, userId]);
        await dbRun('UPDATE portfolios SET quantity = ? WHERE id = ?', [portfolio.quantity - quantity, portfolio.id]);
      }

      await dbRun('INSERT INTO transactions (user_id, asset_symbol, asset_type, type, quantity, price, total_amount, fee) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [userId, asset_symbol, asset_type, type, quantity, price, totalAmountKRW, feeKRW]);
      await dbRun('COMMIT', []);

      res.json({
        message: `${asset_symbol} ${type === 'BUY' ? '매수' : '매도'} 체결! (수수료: ₩${feeKRW.toLocaleString('ko-KR', { maximumFractionDigits: 0 })})`,
        totalAmount: totalAmountKRW, type, fee: feeKRW
      });
    } catch (err) {
      try { await dbRun('ROLLBACK', []); } catch (_) { }
      res.status(500).json({ error: '거래 처리 실패: ' + err.message });
    }
  })();
});

app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
