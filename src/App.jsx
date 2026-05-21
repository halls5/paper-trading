import React, { useState, useEffect, useRef, memo } from 'react';
import './index.css';
import { MiniChart, ChartModal, PieChart, AssetAllocationBar, PortfolioHistoryChart } from './ChartComponents';
import { Sun, Moon, Coins, TrendingUp, Search, Trophy, ScrollText, Wallet, PieChart as PieChartIcon } from 'lucide-react';

const TOP_10_CRYPTO = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','DOTUSDT','POLUSDT'];
const USD_TO_KRW = 1380;

const fmtPrice = (price, currency) =>
  currency === 'KRW'
    ? `₩${price.toLocaleString('ko-KR', { maximumFractionDigits: 0 })}`
    : `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;

const fmtBalance = (n) => `₩${(n || 0).toLocaleString('ko-KR', { maximumFractionDigits: 0 })}`;
const toKRW = (price, currency) => currency === 'KRW' ? price : price * USD_TO_KRW;

// Detect KRW currency from symbol suffix
const guessCurrency = (symbol, fallback = 'USD') => {
  if (symbol?.endsWith('.KS') || symbol?.endsWith('.KQ')) return 'KRW';
  return fallback;
};

// --- AssetRow: defined OUTSIDE App so it never remounts on liveData ticks ---
// React.memo ensures it only re-renders when its own props change, not when the
// parent App re-renders due to Binance WebSocket updates every second.
const AssetRow = memo(function AssetRow({ data, liveData, setChartAsset, setTradingAsset, setTradeType, setQty, setTradeErr }) {
  // For crypto search results (price: null from server), fill in live Binance price
  const liveEntry = data.type === 'CRYPTO' ? liveData[data.symbol] : null;
  const displayData = (liveEntry && !data.price)
    ? { ...data, price: liveEntry.price, changePercent: liveEntry.changePercent }
    : data;
  const isPos = (displayData.changePercent || 0) >= 0;

  const openBuy = () => { setTradingAsset(displayData); setTradeType('BUY'); setQty(''); setTradeErr(''); };
  const openSell = () => { setTradingAsset(displayData); setTradeType('SELL'); setQty(''); setTradeErr(''); };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', padding: '0.7rem 1rem', background: 'var(--row-bg)', borderRadius: '10px', marginBottom: '0.4rem' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: '0.95rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayData.name}</div>
        <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>{displayData.symbol}</div>
      </div>

      {/* Mini sparkline */}
      <div style={{ cursor: 'pointer', flexShrink: 0 }} onClick={() => setChartAsset(displayData)}>
        <MiniChart symbol={displayData.symbol} type={displayData.type} currency={displayData.currency} />
      </div>

      <div style={{ textAlign: 'right', flexShrink: 0, minWidth: '100px' }}>
        <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>
          {displayData.price
            ? fmtPrice(displayData.price, displayData.currency)
            : <span style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>가격 로딩중...</span>}
        </div>
        <div style={{ color: isPos ? 'var(--success-color)' : 'var(--danger-color)', fontSize: '0.8rem' }}>
          {isPos ? '+' : ''}{(displayData.changePercent || 0).toFixed(2)}%
        </div>
      </div>

      <div style={{ display: 'flex', gap: '0.3rem', flexShrink: 0 }}>
        <button className="btn" style={{ padding: '5px 8px', background: 'rgba(59,130,246,0.15)', color: '#60a5fa', fontSize: '0.78rem' }} onClick={() => setChartAsset(displayData)}>차트</button>
        <button className="btn btn-success" style={{ padding: '5px 10px', fontSize: '0.78rem' }}
          onClick={openBuy}
          disabled={!displayData.price}>매수</button>
        <button className="btn btn-danger" style={{ padding: '5px 10px', fontSize: '0.78rem' }}
          onClick={openSell}
          disabled={!displayData.price}>매도</button>
      </div>
    </div>
  );
});

function SearchError({ msg }) {
  return (
    <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--danger-color)' }}>
      ⚠️ {msg}<br />
      <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.5rem', display: 'block' }}>
        Yahoo Finance API 우회 호출을 실패했거나, 잘못된 티커(종목코드)일 수 있습니다.
      </span>
    </div>
  );
}

export default function App() {
  /* ── Auth ── */
  const [isLoginView, setIsLoginView] = useState(true);
  const [form, setForm] = useState({ username: '', nickname: '', password: '' });
  const [user, setUser] = useState(null);
  const [authError, setAuthError] = useState('');

  /* ── Theme ── */
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'dark');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);


  // 티어 기준: 초기 1억 기준
  // 🌱 초보: 1억 미만 (손실 중)
  // ✨ 성장: 1억 ~ 1.5억
  // 💎 고수: 1.5억 ~ 3억
  // 🐳 고래: 3억 이상
  const getTierIcon = (balance) => {
    if (balance >= 300000000) return '🐳';
    if (balance >= 150000000) return '💎';
    if (balance >= 100000000) return '✨';
    return '🌱';
  };

  /* ── Market ── */
  const [liveData, setLiveData] = useState({});
  const [stockData, setStockData] = useState([]);
  const [activeTab, setActiveTab] = useState('CRYPTO');

  /* ── Search ── */
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState('');

  /* ── Portfolio ── */
  const [portfolio, setPortfolio] = useState([]);

  /* ── Ranking ── */
  const [ranking, setRanking] = useState([]);
  const [history, setHistory] = useState([]);
  const [portfolioHistory, setPortfolioHistory] = useState([]);

  /* ── Trade modal ── */
  const [tradingAsset, setTradingAsset] = useState(null);
  const [qty, setQty] = useState('');
  const [tradeType, setTradeType] = useState('BUY');
  const [tradeErr, setTradeErr] = useState('');

  /* ── Chart modal ── */
  const [chartAsset, setChartAsset] = useState(null);

  /* ── Init ── */
  useEffect(() => {
    const token = localStorage.getItem('token');
    const stored = localStorage.getItem('user');
    if (token && stored) {
      setUser(JSON.parse(stored));
      fetchPortfolio(token);
      fetchStocks();
      fetchRanking();
      fetchHistory(token);
      fetch('/api/users/me', { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.ok ? r.json() : null)
        .then(u => { if (u) { setUser(u); localStorage.setItem('user', JSON.stringify(u)); } })
        .catch(() => {});
    }
  }, []);

  /* ── Binance WebSocket ── */
  useEffect(() => {
    if (!user) return;
    const streams = TOP_10_CRYPTO.map(s => `${s.toLowerCase()}@ticker`).join('/');
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${streams}`);
    ws.onmessage = (e) => {
      const d = JSON.parse(e.data);
      setLiveData(prev => ({
        ...prev,
        [d.s]: { symbol: d.s, name: d.s.replace('USDT', ''), price: parseFloat(d.c), changePercent: parseFloat(d.P), type: 'CRYPTO', currency: 'USD' }
      }));
    };
    return () => ws.close();
  }, [user]);

  const token = () => localStorage.getItem('token');

  const fetchPortfolio = async (tok) => {
    try {
      const res = await fetch('/api/portfolio', { headers: { Authorization: `Bearer ${tok}` } });
      if (res.ok) setPortfolio(await res.json());
    } catch (_) {}
  };

  const fetchHistory = async (tk) => {
    try {
      const res = await fetch('/api/transactions', { headers: { Authorization: `Bearer ${tk}` } });
      if (res.ok) setHistory((await res.json()).reverse());
    } catch (_) {}
  };

  const fetchPortfolioHistory = async (tk) => {
    try {
      const res = await fetch('/api/portfolio/history', { headers: { Authorization: `Bearer ${tk}` } });
      if (res.ok) setPortfolioHistory(await res.json());
    } catch (_) {}
  };

  // 1시간단위로 자산 스냅샷 저장
  const saveBalanceSnapshot = async (tk, totalKRW) => {
    const lastSavedKey = 'lastBalanceSnapshot';
    const lastSaved = parseInt(localStorage.getItem(lastSavedKey) || '0', 10);
    const now = Date.now();
    // 1시간(3600측)  미만이면 저장 안함
    if (now - lastSaved < 60 * 60 * 1000) return;
    try {
      const res = await fetch('/api/portfolio/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
        body: JSON.stringify({ total_asset_krw: totalKRW })
      });
      if (res.ok) {
        localStorage.setItem(lastSavedKey, String(now));
        await fetchPortfolioHistory(tk);
      }
    } catch (_) {}
  };

  const fetchStocks = async () => {
    try {
      const res = await fetch('/api/stocks/top');
      if (res.ok) setStockData(await res.json());
    } catch (e) { console.error(e); }
  };

  const fetchRanking = async () => {
    try {
      const res = await fetch('/api/ranking');
      if (res.ok) setRanking(await res.json());
    } catch (e) { console.error(e); }
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;
    setIsSearching(true);
    setSearchError('');
    setActiveTab('SEARCH');
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (!res.ok) {
        setSearchError(data.error || '검색 실패');
        setSearchResults([]);
      } else {
        setSearchResults(data);
        if (data.length === 0) setSearchError('결과가 없습니다.');
      }
    } catch {
      setSearchError('네트워크 오류');
      setSearchResults([]);
    }
    setIsSearching(false);
  };

  const handleAuth = async (e) => {
    e.preventDefault();
    setAuthError('');
    const ep = isLoginView ? '/api/auth/login' : '/api/auth/register';
    const res = await fetch(ep, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form)
    });
    const data = await res.json();
    if (!res.ok) return setAuthError(data.error);
    if (isLoginView) {
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      setUser(data.user);
      fetchPortfolio(data.token);
      fetchStocks();
      fetchRanking();
      fetchHistory(data.token);
      fetchPortfolioHistory(data.token);
    } else {
      alert('회원가입 완료! 1억원이 지급되었습니다. 로그인해주세요.');
      setIsLoginView(true);
    }
  };

  const handleTrade = async (e) => {
    e.preventDefault();
    setTradeErr('');
    const q = parseFloat(qty);
    if (!q || q <= 0) return setTradeErr('수량을 입력해주세요.');
    if (!tradingAsset?.price) return setTradeErr('가격 정보가 없습니다.');
    const tk = token();
    try {
      const res = await fetch('/api/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
        body: JSON.stringify({ asset_symbol: tradingAsset.symbol, asset_type: tradingAsset.type, type: tradeType, quantity: q, price: tradingAsset.price }),
      });
      const data = await res.json();
      if (!res.ok) return setTradeErr(data.error);
      const uRes = await fetch('/api/users/me', { headers: { Authorization: `Bearer ${tk}` } });
      if (uRes.ok) {
        const u = await uRes.json();
        setUser(u); localStorage.setItem('user', JSON.stringify(u));
        await fetchPortfolio(tk);
        fetchHistory(tk);
      } else {
        localStorage.clear(); setUser(null);
      }
      fetchRanking();
      setTradingAsset(null); setQty(''); setTradeErr('');
      alert(data.message);
    } catch { setTradeErr('네트워크 오류'); }
  };

  const handleLogout = () => {
    localStorage.clear();
    setUser(null); setLiveData({}); setStockData([]); setPortfolio([]); setRanking([]); setSearchResults([]); setHistory([]);
  };

  const portfolioWithValues = portfolio.filter(p => p.quantity > 0).map(p => {
    const live = liveData[p.asset_symbol];
    const stock = stockData.find(s => s.symbol === p.asset_symbol);
    const currentPrice = live?.price ?? stock?.price ?? p.average_price;
    const currency = live?.currency ?? stock?.currency ?? guessCurrency(p.asset_symbol, p.asset_type === 'CRYPTO' ? 'USD' : 'KRW');
    const valueKRW = p.quantity * toKRW(currentPrice, currency);
    const costKRW = p.quantity * toKRW(p.average_price, currency);
    const pnlKRW = valueKRW - costKRW;
    const pnlPct = costKRW > 0 ? pnlKRW / costKRW * 100 : 0;
    return { ...p, currentPrice, currency, valueKRW, costKRW, pnlKRW, pnlPct };
  });

  // 총 손익 = 현재 총 자산 - 초기 시드 1억 (수수료는 이미 거래 시 차감되어 balance에 반영됨)
  // pnlPct 계산도 순수 시드 기준
  const totalHoldingKRW = portfolioWithValues.reduce((s, p) => s + p.valueKRW, 0);
  const totalAssetKRW = (user?.balance || 0) + totalHoldingKRW;
  const INITIAL_SEED = 100_000_000;
  const totalPnl = totalAssetKRW - INITIAL_SEED;
  const totalPnlPct = (totalPnl / INITIAL_SEED * 100).toFixed(2);

  // 포트폴리오 탭 진입 시 자동 스냅샷 (1시간 주기)
  useEffect(() => {
    if (activeTab === 'PORTFOLIO' && user && totalAssetKRW > 0) {
      saveBalanceSnapshot(token(), totalAssetKRW);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const pieData = [
    ...(user?.balance > 0 ? [{ label: '현금', value: user.balance, color: '#6b7280' }] : []),
    ...portfolioWithValues.map((p, i) => ({
      label: p.asset_symbol,
      value: p.valueKRW,
      color: ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316','#84cc16','#ec4899'][i % 9]
    }))
  ];

  const RankingView = () => {
    const myNickname = user?.nickname;
    const INITIAL = 100_000_000;
    
    // Calculate live total asset for each user
    const computedRanking = ranking.map(r => {
      let holdingsValueEst = 0;
      const computedHoldings = (r.holdings || []).map(h => {
        const live = liveData[h.symbol];
        const stock = stockData.find(s => s.symbol === h.symbol);
        const currentPrice = live?.price ?? stock?.price ?? h.avgPrice;
        const currency = live?.currency ?? stock?.currency ?? guessCurrency(h.symbol, h.type === 'CRYPTO' ? 'USD' : 'KRW');
        const priceKRW = currency === 'KRW' ? currentPrice : currentPrice * USD_TO_KRW;
        
        holdingsValueEst += h.quantity * priceKRW;
        return { ...h, currentPrice, priceKRW };
      });
      
      const totalEst = r.balance + holdingsValueEst;
      return {
        ...r,
        holdings: computedHoldings,
        totalAsset: totalEst,
        profitLoss: totalEst - INITIAL,
        returnRate: ((totalEst - INITIAL) / INITIAL * 100).toFixed(2)
      };
    }).sort((a, b) => b.totalAsset - a.totalAsset)
      .map((r, i) => ({ ...r, rank: i + 1 }));

    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.2rem' }}>
          <h3 style={{ margin: 0 }}>🏆 수익률 랭킹</h3>
          <button className="btn" style={{ background: 'var(--btn-bg)', color: 'white', fontSize: '0.8rem', padding: '6px 14px' }} onClick={fetchRanking}>새로고침</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '36px 1fr 120px 100px 80px', gap: '0.5rem', padding: '0.4rem 0.8rem', color: 'var(--text-secondary)', fontSize: '0.75rem', borderBottom: '1px solid var(--border-color)', marginBottom: '0.5rem' }}>
          <span>순위</span><span>닉네임 / 포트폴리오</span><span style={{ textAlign: 'right' }}>총 자산</span><span style={{ textAlign: 'right' }}>손익</span><span style={{ textAlign: 'right' }}>수익률</span>
        </div>

        {computedRanking.length === 0 ? (
          <p style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '2rem' }}>랭킹 데이터가 없습니다.</p>
        ) : computedRanking.map(r => {
          const isMe = r.nickname === myNickname;
          const isPos = r.profitLoss >= 0;
          const medal = r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : `${r.rank}`;
          
          return (
            <div key={r.nickname} style={{
              display: 'grid', gridTemplateColumns: '36px 1fr 120px 100px 80px', gap: '0.5rem', padding: '0.7rem 0.8rem',
              background: isMe ? 'rgba(59,130,246,0.12)' : 'rgba(0,0,0,0.12)',
              borderRadius: '8px', marginBottom: '0.4rem',
              border: isMe ? '1px solid rgba(59,130,246,0.35)' : '1px solid transparent',
            }}>
              <span style={{ fontSize: r.rank <= 3 ? '1.1rem' : '0.85rem', display: 'flex', alignItems: 'flex-start', paddingTop: 2 }}>{medal}</span>
              <div>
                <div style={{ fontWeight: isMe ? 700 : 400, display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: 4 }}>
                  {r.nickname}
                  {isMe && <span style={{ fontSize: '0.65rem', background: 'var(--accent-color)', padding: '1px 5px', borderRadius: '3px' }}>나</span>}
                </div>
                {(r.holdings?.length > 0 || r.balance > 0) && (
                  <AssetAllocationBar holdings={r.holdings} balance={r.balance} totalKRW={r.totalAsset} usdKrw={USD_TO_KRW} />
                )}
                {(r.holdings?.length > 0 || r.balance > 0) && (() => {
                  const items = [...(r.balance > 0 ? ['현금'] : []), ...(r.holdings || []).map(h => h.symbol)];
                  return (
                    <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', marginTop: 3 }}>
                      {items.slice(0, 4).join(' · ')}{items.length > 4 ? ` +${items.length - 4}` : ''}
                    </div>
                  );
                })()}
              </div>
              <span style={{ textAlign: 'right', fontWeight: 600, fontSize: '0.85rem', display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>{fmtBalance(r.totalAsset)}</span>
              <span style={{ textAlign: 'right', color: isPos ? 'var(--success-color)' : 'var(--danger-color)', fontSize: '0.82rem', display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
                {isPos ? '+' : ''}{fmtBalance(r.profitLoss)}
              </span>
              <span style={{ textAlign: 'right', color: isPos ? 'var(--success-color)' : 'var(--danger-color)', fontWeight: 700, fontSize: '0.85rem', display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
                {isPos ? '+' : ''}{r.returnRate}%
              </span>
            </div>
          );
        })}
      </div>
    );
  };

  const HistoryView = () => {
    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.2rem' }}>
          <h3 style={{ margin: 0 }}><ScrollText size={16} style={{ marginRight: 4, verticalAlign: "text-bottom" }} /> 거래 내역</h3>
          <button className="btn" style={{ background: 'var(--btn-bg)', color: 'white', fontSize: '0.8rem', padding: '6px 14px' }} onClick={() => fetchHistory(token())}>새로고침</button>
        </div>
        
        {history.length === 0 ? (
          <p style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '2rem' }}>거래 내역이 없습니다.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {history.map(h => (
              <div key={h.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.8rem', background: 'var(--row-bg)', borderRadius: '8px' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <span style={{ color: h.type === 'BUY' ? 'var(--danger-color)' : 'var(--success-color)', fontSize: '0.8rem', padding: '2px 6px', background: 'var(--btn-bg)', borderRadius: '4px' }}>
                      {h.type === 'BUY' ? '매수' : '매도'}
                    </span>
                    {h.asset_symbol}
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '0.3rem' }}>
                    {new Date(h.timestamp).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>
                    {h.quantity.toLocaleString(undefined, { maximumFractionDigits: 6 })}개
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    총액: {fmtBalance(h.total_amount)}
                  </div>
                  {(h.fee > 0) && (
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>수수료: {fmtBalance(h.fee)}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderTradeModal = () => {
    if (!tradingAsset) return null;
    const q = parseFloat(qty) || 0;
    const total = q * tradingAsset.price;
    const curr = tradingAsset.currency;
    const maxAffordable = curr === 'KRW'
      ? Math.floor(user.balance / tradingAsset.price)
      : Math.floor((user.balance / USD_TO_KRW) / tradingAsset.price * 10000) / 10000;
    const holding = portfolio.find(p => p.asset_symbol === tradingAsset.symbol);

    return (
      <div onClick={e => e.target === e.currentTarget && setTradingAsset(null)}
           style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
        <div className="glass-panel" style={{ width: '100%', maxWidth: '420px', position: 'relative' }}>
          <button onClick={() => setTradingAsset(null)} style={{ position: 'absolute', top: 15, right: 15, background: 'none', border: 'none', color: 'white', fontSize: '1.5rem', cursor: 'pointer', lineHeight: 1 }}>×</button>
          <h2 style={{ marginBottom: '0.25rem' }}>{tradingAsset.name}</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '1.5rem' }}>{tradingAsset.symbol}</p>

          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.2rem' }}>
            <button className={`btn ${tradeType === 'BUY' ? 'btn-success' : ''}`} style={{ flex: 1, padding: '10px', background: tradeType !== 'BUY' ? 'var(--btn-bg)' : '', color: 'white' }} onClick={() => setTradeType('BUY')}>매수</button>
            <button className={`btn ${tradeType === 'SELL' ? 'btn-danger' : ''}`} style={{ flex: 1, padding: '10px', background: tradeType !== 'SELL' ? 'var(--btn-bg)' : '', color: 'white' }} onClick={() => setTradeType('SELL')}>매도</button>
          </div>

          <div style={{ background: 'var(--row-bg)', borderRadius: '8px', padding: '0.8rem', marginBottom: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
              <span style={{ color: 'var(--text-secondary)' }}>현재가</span>
              <strong>{fmtPrice(tradingAsset.price, curr)}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.83rem' }}>
              <span style={{ color: 'var(--text-secondary)' }}>{tradeType === 'BUY' ? '매수 가능' : '보유 수량'}</span>
              <span style={{ color: 'var(--text-secondary)' }}>
                {tradeType === 'BUY'
                  ? `${fmtBalance(user.balance)} (최대 ${maxAffordable.toLocaleString()}주)`
                  : `${holding ? holding.quantity.toLocaleString(undefined, { maximumFractionDigits: 6 }) : 0}주`}
              </span>
            </div>
          </div>

          <form onSubmit={handleTrade} style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem', alignItems: 'center' }}>
                <label style={{ color: 'var(--text-secondary)', fontSize: '0.88rem' }}>수량</label>
                <div style={{ display: 'flex', gap: '0.3rem' }}>
                  {tradeType === 'BUY' && [0.1, 0.25, 0.5, 1.0].map(ratio => (
                    <button key={ratio} type="button" className="btn"
                      style={{ padding: '2px 7px', fontSize: '0.72rem', background: 'var(--btn-bg)', color: 'var(--text-secondary)' }}
                      onClick={() => {
                        const max = curr === 'KRW'
                          ? Math.floor(user.balance * ratio / tradingAsset.price)
                          : Math.floor((user.balance / USD_TO_KRW) * ratio / tradingAsset.price * 10000) / 10000;
                        setQty(String(max));
                      }}>
                      {ratio === 1.0 ? '최대' : `${ratio * 100}%`}
                    </button>
                  ))}
                  {tradeType === 'SELL' && holding && (
                    <button type="button" className="btn"
                      style={{ padding: '2px 7px', fontSize: '0.72rem', background: 'var(--btn-bg)', color: 'var(--text-secondary)' }}
                      onClick={() => setQty(String(holding.quantity))}>전량</button>
                  )}
                </div>
              </div>
              <input type="number" step="any" min="0" value={qty} onChange={e => setQty(e.target.value)} required
                placeholder={tradingAsset.type === 'CRYPTO' ? '예: 0.001' : '예: 1'}
                style={{ width: '100%', padding: '11px', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'var(--row-bg)', color: 'white', fontSize: '1rem', boxSizing: 'border-box' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)', fontSize: '0.88rem', background: 'var(--row-bg)', padding: '0.7rem', borderRadius: '8px' }}>
              <span>총 주문금액</span>
              <strong style={{ color: 'white' }}>
                {curr === 'KRW' ? fmtBalance(total) : `$${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                {curr !== 'KRW' && <span style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', marginLeft: '0.4rem' }}>(≈ {fmtBalance(total * USD_TO_KRW)})</span>}
              </strong>
            </div>
            {tradeErr && <p style={{ color: 'var(--danger-color)', fontSize: '0.88rem', textAlign: 'center', margin: 0 }}>{tradeErr}</p>}
            <button type="submit" className={`btn ${tradeType === 'BUY' ? 'btn-success' : 'btn-danger'}`} style={{ padding: '12px', fontSize: '1rem' }}>
              {tradeType === 'BUY' ? '매수하기' : '매도하기'}
            </button>
          </form>
        </div>
      </div>
    );
  };

  if (!user) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', padding: '20px' }}>
        <div className="glass-panel" style={{ width: '100%', maxWidth: '400px' }}>
          <h2 style={{ textAlign: 'center', marginBottom: '0.5rem' }}><span className="text-gradient">Paper Trading</span></h2>
          <p style={{ textAlign: 'center', color: 'var(--text-secondary)', marginBottom: '2rem', fontSize: '0.9rem' }}>가상 1억원으로 주식·코인 모의투자</p>
          <form onSubmit={handleAuth} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {['username', ...(isLoginView ? [] : ['nickname']), 'password'].map(field => (
              <div key={field}>
                <label style={{ display: 'block', marginBottom: '0.4rem', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                  {field === 'username' ? '아이디' : field === 'nickname' ? '닉네임' : '비밀번호'}
                </label>
                <input type={field === 'password' ? 'password' : 'text'} value={form[field]}
                  onChange={e => setForm(p => ({ ...p, [field]: e.target.value }))} required
                  style={{ width: '100%', padding: '12px', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'var(--row-bg)', color: 'white', fontSize: '1rem', boxSizing: 'border-box' }} />
              </div>
            ))}
            {authError && <p style={{ color: 'var(--danger-color)', textAlign: 'center', fontSize: '0.9rem' }}>{authError}</p>}
            <button type="submit" className="btn btn-primary" style={{ padding: '12px', marginTop: '0.5rem' }}>
              {isLoginView ? '로그인' : '회원가입 (1억원 받기)'}
            </button>
          </form>
          <p style={{ textAlign: 'center', marginTop: '1.5rem', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            {isLoginView ? '계정이 없으신가요?' : '이미 계정이 있으신가요?'}
            <button onClick={() => { setIsLoginView(v => !v); setAuthError(''); }}
              style={{ background: 'none', border: 'none', color: 'var(--accent-color)', cursor: 'pointer', marginLeft: '0.5rem', fontWeight: 600 }}>
              {isLoginView ? '회원가입' : '로그인'}
            </button>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', padding: '1.2rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.2rem' }}>
      <header className="glass-header" style={{ width: '100%', maxWidth: '1360px', padding: '0.9rem 1.4rem', borderRadius: '14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}><span className="text-gradient">Paper Trading</span></h2>

        <form onSubmit={handleSearch} style={{ display: 'flex', gap: '0.5rem', flex: '1', maxWidth: 460 }}>
          <input type="text" placeholder="종목 검색 (삼성전자, Apple, Bitcoin...)" value={query}
            onChange={e => setQuery(e.target.value)}
            style={{ flex: 1, padding: '8px 14px', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'var(--input-bg)', color: 'white', fontSize: '0.88rem' }} />
          <button type="submit" className="btn btn-primary" style={{ padding: '8px 16px', fontSize: '0.88rem' }}>검색</button>
        </form>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem' }}>
          <button className="btn" style={{ background: 'var(--btn-bg)', color: 'var(--text-primary)', padding: '6px' }}
                  onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          
          <div style={{ textAlign: 'right', marginLeft: '0.5rem' }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem', justifyContent: 'flex-end' }}>
              <span title={`티어: ${totalAssetKRW >= 300000000 ? '고래' : totalAssetKRW >= 150000000 ? '고수' : totalAssetKRW >= 100000000 ? '성장' : '초보'}`}
                style={{ fontSize: '1rem', cursor: 'default' }}>
                {getTierIcon(totalAssetKRW)}
              </span>
              {user.nickname}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', marginTop: '0.1rem' }}>
              <span style={{ color: totalPnl >= 0 ? 'var(--success-color)' : 'var(--danger-color)', fontWeight: 600 }}>
                {totalPnl >= 0 ? '+' : ''}{totalPnlPct}%
              </span>
              {ranking.find(r => r.nickname === user.nickname) && (
                <span style={{ color: 'var(--text-secondary)', background: 'var(--btn-bg)', padding: '1px 5px', borderRadius: '4px', fontSize: '0.7rem' }}>
                  {ranking.find(r => r.nickname === user.nickname).rank}위
                </span>
              )}
            </div>
          </div>
          <button className="btn" style={{ background: 'var(--btn-bg)', color: 'white', padding: '7px 13px', fontSize: '0.83rem' }} onClick={() => { setActiveTab('RANKING'); fetchRanking(); }}><Trophy size={16} style={{ marginRight: 4, verticalAlign: "text-bottom" }} /> 랭킹</button>
          <button className="btn btn-danger" style={{ padding: '7px 13px', fontSize: '0.83rem' }} onClick={handleLogout}>로그아웃</button>
        </div>
      </header>

      <div style={{ display: 'flex', gap: '1.2rem', width: '100%', maxWidth: '1360px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: '1.2rem', maxWidth: 360 }}>
          <div className="glass-panel" style={{ padding: '1.2rem' }}>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', marginBottom: '0.3rem' }}><Wallet size={15} style={{ marginRight: 4, verticalAlign: "text-bottom" }} /> 총 잔고</p>
            <h1 className="text-gradient" style={{ fontSize: '1.8rem', margin: 0, letterSpacing: '-0.03em' }}>{fmtBalance(totalAssetKRW)}</h1>
            <div style={{ marginTop: '0.8rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>현금 잔고</span>
                <span>{fmtBalance(user.balance)}</span>
              </div>
              {totalHoldingKRW > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>보유 자산</span>
                  <span>≈ {fmtBalance(totalHoldingKRW)}</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', borderTop: '1px solid var(--border-color)', paddingTop: '0.4rem', marginTop: '0.1rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>총 손익</span>
                <span style={{ color: totalPnl >= 0 ? 'var(--success-color)' : 'var(--danger-color)', fontWeight: 600 }}>
                  {totalPnl >= 0 ? '+' : ''}{fmtBalance(totalPnl)}
                  <span style={{ fontSize: '0.72rem', marginLeft: '0.3rem' }}>({totalPnl >= 0 ? '+' : ''}{totalPnlPct}%)</span>
                </span>
              </div>
            </div>
          </div>

          <div className="glass-panel" style={{ padding: '1.2rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0 }}><PieChartIcon size={18} style={{ marginRight: 6, verticalAlign: "text-bottom" }} /> 내 포트폴리오</h3>
              <button className="btn" style={{ background: 'var(--btn-bg)', color: 'white', fontSize: '0.8rem', padding: '5px 12px' }} onClick={() => fetchPortfolio(token())}>새로고침</button>
            </div>
            {portfolioWithValues.length === 0 ? (
              <p style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '2rem 0' }}>보유 자산이 없습니다.</p>
            ) : (
              <>
                <PieChart data={pieData} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginTop: '1rem' }}>
                  {portfolioWithValues.sort((a, b) => b.valueKRW - a.valueKRW).map(p => (
                    <div key={p.asset_symbol} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.6rem 0.8rem', background: 'var(--row-bg)', borderRadius: '8px' }}>
                      <div style={{ cursor: 'pointer' }} onClick={() => setChartAsset(p)}>
                        <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{p.asset_symbol}</div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{p.quantity.toLocaleString(undefined, { maximumFractionDigits: 6 })}개 · 평균 {fmtPrice(p.average_price, p.currency)}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{fmtPrice(p.currentPrice, p.currency)}</div>
                        <div style={{ color: p.pnlPct >= 0 ? 'var(--success-color)' : 'var(--danger-color)', fontSize: '0.75rem', fontWeight: 600 }}>
                          {p.pnlPct >= 0 ? '+' : ''}{p.pnlPct.toFixed(2)}%
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="glass-panel" style={{ flex: '2 1 580px', padding: '1.4rem' }}>
          <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '1.2rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.9rem', flexWrap: 'wrap' }}>
            {[['CRYPTO', <><Coins size={16} style={{ marginRight: 4, verticalAlign: "text-bottom" }} /> 코인 Top 10</>],
              ['STOCK', <><TrendingUp size={16} style={{ marginRight: 4, verticalAlign: "text-bottom" }} /> 주식 Top 10</>],
              ['SEARCH', <><Search size={16} style={{ marginRight: 4, verticalAlign: "text-bottom" }} /> 검색 결과</>],
              ['RANKING', <><Trophy size={16} style={{ marginRight: 4, verticalAlign: "text-bottom" }} /> 랭킹</>],
              ['HISTORY', <><ScrollText size={16} style={{ marginRight: 4, verticalAlign: "text-bottom" }} /> 거래 내역</>],
              ['PORTFOLIO', <><PieChartIcon size={16} style={{ marginRight: 4, verticalAlign: "text-bottom" }} /> 포트폴리오 차트</>]]
              .map(([key, label]) => (
              <button key={key} onClick={() => { setActiveTab(key); if (key === 'RANKING') fetchRanking(); if (key === 'HISTORY') fetchHistory(token()); }}
                className={`btn ${activeTab === key ? 'btn-primary' : ''}`}
                style={{ padding: '6px 14px', fontSize: '0.82rem', background: activeTab !== key ? 'var(--btn-bg)' : '', color: activeTab !== key ? 'var(--text-primary)' : 'white' }}>
                {label}
              </button>
            ))}
          </div>

          {activeTab === 'CRYPTO' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem', alignItems: 'center' }}>
                <h3 style={{ margin: 0 }}><Coins size={18} style={{ marginRight: 6, verticalAlign: "text-bottom" }} /> 코인 실시간 시세</h3>
                <span style={{ fontSize: '0.75rem', color: 'var(--success-color)' }}>● 실시간 연동중</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {TOP_10_CRYPTO.map(sym => {
                  const d = liveData[sym] || { symbol: sym, name: sym.replace('USDT',''), price: null, changePercent: null, type: 'CRYPTO', currency: 'USD' };
                  return <AssetRow key={sym} data={d} liveData={liveData} setChartAsset={setChartAsset} setTradingAsset={setTradingAsset} setTradeType={setTradeType} setQty={setQty} setTradeErr={setTradeErr} />;
                })}
              </div>
            </div>
          )}

          {activeTab === 'STOCK' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem', alignItems: 'center' }}>
                <h3 style={{ margin: 0 }}><TrendingUp size={18} style={{ marginRight: 6, verticalAlign: "text-bottom" }} /> 국내외 우량주 (지연 시세)</h3>
                <button className="btn" style={{ background: 'var(--btn-bg)', color: 'white', fontSize: '0.75rem', padding: '4px 10px' }} onClick={fetchStocks}>새로고침</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {stockData.map(s => <AssetRow key={s.symbol} data={s} liveData={liveData} setChartAsset={setChartAsset} setTradingAsset={setTradingAsset} setTradeType={setTradeType} setQty={setQty} setTradeErr={setTradeErr} />)}
              </div>
            </div>
          )}

          {activeTab === 'SEARCH' && (
            <div>
              {isSearching ? <p style={{ textAlign: 'center', padding: '2rem' }}>검색 중...</p> : searchError ? <SearchError msg={searchError} /> : searchResults.length === 0 ? <p style={{ textAlign: 'center', padding: '2rem' }}>검색 결과가 없습니다.</p> : (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {searchResults.map(s => <AssetRow key={s.symbol} data={s} liveData={liveData} setChartAsset={setChartAsset} setTradingAsset={setTradingAsset} setTradeType={setTradeType} setQty={setQty} setTradeErr={setTradeErr} />)}
                </div>
              )}
            </div>
          )}

          {activeTab === 'RANKING' && <RankingView />}
          {activeTab === 'HISTORY' && <HistoryView />}
          {activeTab === 'PORTFOLIO' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem', alignItems: 'center' }}>
                <h3 style={{ margin: 0 }}><TrendingUp size={18} style={{ marginRight: 6, verticalAlign: "text-bottom" }} /> 나의 자산 추이</h3>
                <button className="btn" style={{ background: 'var(--btn-bg)', color: 'var(--text-primary)', fontSize: '0.78rem', padding: '4px 10px' }}
                  onClick={() => saveBalanceSnapshot(token(), totalAssetKRW)}>고지점 추가</button>
              </div>
              <div style={{ background: 'var(--row-bg)', padding: '1rem', borderRadius: '12px' }}>
                {portfolioHistory.length < 1 ? (
                  <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '3rem 1rem' }}>
                    <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>📈</div>
                    <div>아직 기록이 없습니다.</div>
                    <div style={{ fontSize: '0.8rem', marginTop: '0.4rem' }}>'고지점 추가' 버튼을 누르거나, 탭을 열 때마다 1시간 주기로 자동 기록됩니다.</div>
                  </div>
                ) : portfolioHistory.length < 2 ? (
                  <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '2rem' }}>
                    <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>⏳</div>
                    <div>기록 1개. 선 그래프는 기록이 2개 이상이어야 그려집니다.</div>
                    <div style={{ fontSize: '0.8rem', marginTop: '0.4rem' }}>'고지점 추가'를 다시 눠르거나, 1시간 후 다시 탭을 열어보세요.</div>
                  </div>
                ) : (
                  <PortfolioHistoryChart data={portfolioHistory} />
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      {renderTradeModal()}
      {chartAsset && <ChartModal asset={chartAsset} onClose={() => setChartAsset(null)} />}
    </div>
  );
}
