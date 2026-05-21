const fs = require('fs');
let code = fs.readFileSync('src/App.jsx', 'utf8');

// 1. Import PortfolioHistoryChart
code = code.replace(
  "import { MiniChart, ChartModal, PieChart, AssetAllocationBar } from './ChartComponents';",
  "import { MiniChart, ChartModal, PieChart, AssetAllocationBar, PortfolioHistoryChart } from './ChartComponents';"
);

// 2. Add state for portfolioHistory and the fetch function
const stateRegex = /const \[history, setHistory\] = useState\(\[\]\);/;
code = code.replace(
  stateRegex,
  "const [history, setHistory] = useState([]);\n  const [portfolioHistory, setPortfolioHistory] = useState([]);"
);

// 3. Add fetchPortfolioHistory
const fetchHistoryRegex = /const fetchHistory = async \(tk\) => \{[\s\S]*?\};\n/;
code = code.replace(
  fetchHistoryRegex,
  `const fetchHistory = async (tk) => {
    try {
      const res = await fetch('/api/transactions', { headers: { Authorization: \`Bearer \${tk}\` } });
      if (res.ok) setHistory((await res.json()).reverse());
    } catch (_) {}
  };

  const fetchPortfolioHistory = async (tk) => {
    try {
      const res = await fetch('/api/portfolio/history', { headers: { Authorization: \`Bearer \${tk}\` } });
      if (res.ok) setPortfolioHistory(await res.json());
    } catch (_) {}
  };
`
);

// 4. Update handleAuth to fetch portfolio history and save a snapshot
code = code.replace(
  "fetchHistory(data.token);",
  "fetchHistory(data.token);\n      fetchPortfolioHistory(data.token);"
);

// 5. Add a useEffect to log snapshot occasionally (e.g., when they open PORTFOLIO tab)
// We'll insert it right after the portfolioWithValues calculation
const pnlRegex = /const totalPnlPct = totalHoldingKRW > 0 \? \(\(totalPnl \/ totalHoldingKRW\) \* 100\)\.toFixed\(2\) : 0;/;
code = code.replace(
  pnlRegex,
  `const totalPnlPct = totalHoldingKRW > 0 ? ((totalPnl / totalHoldingKRW) * 100).toFixed(2) : 0;

  // Snapshot logging logic
  useEffect(() => {
    if (activeTab === 'PORTFOLIO' && user && totalAssetKRW > 0) {
      fetch('/api/portfolio/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: \`Bearer \${token()}\` },
        body: JSON.stringify({ total_asset_krw: totalAssetKRW })
      }).then(() => fetchPortfolioHistory(token())).catch(console.error);
    }
  }, [activeTab, totalAssetKRW, user]);
`
);

// 6. Add Portfolio tab view
code = code.replace(
  "{activeTab === 'HISTORY' && <HistoryView />}",
  `{activeTab === 'HISTORY' && <HistoryView />}
          {activeTab === 'PORTFOLIO' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem', alignItems: 'center' }}>
                <h3 style={{ margin: 0 }}>📈 포트폴리오 자산 추이</h3>
              </div>
              <div style={{ background: 'var(--row-bg)', padding: '1rem', borderRadius: '12px' }}>
                {portfolioHistory.length < 2 ? (
                  <p style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '2rem' }}>데이터가 충분하지 않습니다 (2회 이상 기록 필요).</p>
                ) : (
                  <PortfolioHistoryChart data={portfolioHistory} />
                )}
              </div>
            </div>
          )}`
);

fs.writeFileSync('src/App.jsx', code);
console.log('App.jsx modified with PortfolioHistoryChart logic');
