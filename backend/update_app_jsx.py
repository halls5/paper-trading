import re

with open('src/App.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Update portfolioWithValues to include etfData
content = content.replace(
    "const stock = stockData.find(s => s.symbol === p.asset_symbol);",
    "const stock = stockData.find(s => s.symbol === p.asset_symbol) || etfData.find(s => s.symbol === p.asset_symbol);"
)

# Update computedRanking to include etfData
content = content.replace(
    "const stock = stockData.find(s => s.symbol === h.symbol);",
    "const stock = stockData.find(s => s.symbol === h.symbol) || etfData.find(s => s.symbol === h.symbol);"
)

# Fix init effect to fetch etfs
init_pattern = r"(useEffect\(\(\) => \{\n\s*const token = localStorage\.getItem\('token'\);\n\s*const stored = localStorage\.getItem\('user'\);\n\s*if \(token && stored\) \{\n\s*setUser\(JSON\.parse\(stored\)\);\n\s*fetchPortfolio\(token\);\n\s*fetchStocks\(\);)"
if re.search(init_pattern, content):
    content = re.sub(init_pattern, r"\1\n      fetchEtfs();", content)

# Fix setInterval effect
interval_pattern = r"(const interval = setInterval\(\(\) => \{\n\s*fetchStocks\(\);\n\s*fetchRanking\(\);)"
if re.search(interval_pattern, content):
    content = re.sub(interval_pattern, r"\1\n      fetchEtfs();", content)

# Also fix the initial fetch inside the useEffect
interval_init_pattern = r"(useEffect\(\(\) => \{\n\s*fetchStocks\(\);\n\s*fetchRanking\(\);)"
if re.search(interval_init_pattern, content):
    content = re.sub(interval_init_pattern, r"\1\n    fetchEtfs();", content)

# UI fix: Add ETF tab
ui_pattern = r"(\{\[\['CRYPTO', <><Coins size=\{16\} style=\{\{ marginRight: 4, verticalAlign: \"text-bottom\" \}\} /> 코인 Top 10</>\],\n\s*\['STOCK', <><LineChartIcon size=\{16\} style=\{\{ marginRight: 4, verticalAlign: \"text-bottom\" \}\} /> 주식 Top 10</>\])"
ui_replacement = r"\1,\n              ['ETF', <><LineChartIcon size={16} style={{ marginRight: 4, verticalAlign: \"text-bottom\" }} /> ETF Top 10</>]"
if re.search(ui_pattern, content):
    content = re.sub(ui_pattern, ui_replacement, content)

# Render ETF data when activeTopTab === 'ETF'
render_data_pattern = r"(const renderData = activeTopTab === 'CRYPTO'\n\s*\? Object\.values\(liveData\)\.sort\(\(a, b\) => b\.price \- a\.price\)\n\s*: stockData;)"
render_data_replacement = r"const renderData = activeTopTab === 'CRYPTO'\n                ? Object.values(liveData).sort((a, b) => b.price - a.price)\n                : (activeTopTab === 'ETF' ? etfData : stockData);"
if re.search(render_data_pattern, content):
    content = re.sub(render_data_pattern, render_data_replacement, content)

with open('src/App.jsx', 'w', encoding='utf-8') as f:
    f.write(content)

print("App.jsx UI and logic updated")
