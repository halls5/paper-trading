import re

with open('src/App.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Restore setInterval
interval_code = """
  // 주기적 갱신
  useEffect(() => {
    fetchStocks();
    fetchEtfs();
    fetchRanking();
    const interval = setInterval(() => {
      fetchStocks();
      fetchEtfs();
      fetchRanking();
      if (token()) fetchPortfolio(token());
    }, 10000); // 10초마다 Top 10 업데이트
    return () => clearInterval(interval);
  }, []);
"""
if "const interval = setInterval" not in content:
    # Insert right before const handleSearch
    content = content.replace("  const handleSearch = async (e) => {", interval_code + "\n  const handleSearch = async (e) => {")

# Fix UI: Add ETF tab
ui_pattern = r"(\{\[\['CRYPTO', <><Coins size=\{16\} style=\{\{ marginRight: 4, verticalAlign: \"text-bottom\" \}\} /> 코인 Top 10</>\],\n\s*\['STOCK', <><TrendingUp size=\{16\} style=\{\{ marginRight: 4, verticalAlign: \"text-bottom\" \}\} /> 주식 Top 10</>\])"
ui_replacement = r"\1,\n              ['ETF', <><TrendingUp size={16} style={{ marginRight: 4, verticalAlign: \"text-bottom\" }} /> ETF Top 10</>]"
if "['ETF'," not in content:
    content = re.sub(ui_pattern, ui_replacement, content)

# Add ETF rendering block
etf_render_block = """
          {activeTab === 'ETF' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem', alignItems: 'center' }}>
                <h3 style={{ margin: 0 }}><TrendingUp size={18} style={{ marginRight: 6, verticalAlign: "text-bottom" }} /> 국내외 주요 ETF</h3>
                <button className="btn" style={{ background: 'var(--btn-bg)', color: 'white', fontSize: '0.75rem', padding: '4px 10px' }} onClick={fetchEtfs}>새로고침</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {etfData.map(s => <AssetRow key={s.symbol} data={s} liveData={liveData} setChartAsset={setChartAsset} setTradingAsset={setTradingAsset} setTradeType={setTradeType} setQty={setQty} setTradeErr={setTradeErr} />)}
              </div>
            </div>
          )}
"""
if "activeTab === 'ETF'" not in content:
    # Insert after STOCK render block
    stock_render_end = r"(</>\s*\}\)\s*</div>\s*</div>\s*\)\})"
    stock_render_end_str = """              </div>
            </div>
          )}"""
    
    parts = content.split(stock_render_end_str)
    if len(parts) >= 2:
        # parts[0] has CRYPTO, parts[1] has STOCK, so we want to insert after parts[1] which is the end of STOCK
        # Actually it's better to just use replace on the whole chunk
        stock_chunk = """              </div>
            </div>
          )}

          {activeTab === 'SEARCH'"""
        new_stock_chunk = """              </div>
            </div>
          )}""" + etf_render_block + """
          {activeTab === 'SEARCH'"""
        content = content.replace(stock_chunk, new_stock_chunk)

with open('src/App.jsx', 'w', encoding='utf-8') as f:
    f.write(content)

print("App.jsx UI and interval restored")
