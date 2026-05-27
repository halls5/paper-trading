import re

with open('backend/server.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Fix KRX search to be case-insensitive and allow english keywords
old_krx_search = """  // Fallback for Korean searches: search the loaded krx.json
  const isKorean = /[가-힣]/.test(q);
  if (isKorean && krxStocks.length > 0) {
    try {
      // Find up to 5 matching stocks
      const matches = krxStocks.filter(s => s.name.includes(q)).slice(0, 5);
      if (matches.length > 0) {"""

new_krx_search = """  // Search KRX stocks (case-insensitive)
  if (krxStocks.length > 0) {
    try {
      const qLower = q.toLowerCase();
      // Find up to 5 matching stocks
      const matches = krxStocks.filter(s => s.name.toLowerCase().includes(qLower) || s.symbol.includes(qLower)).slice(0, 5);
      if (matches.length > 0) {"""

if old_krx_search in content:
    content = content.replace(old_krx_search, new_krx_search)

# 2. Fix Finnhub ETF filtering
old_finnhub = "const symbols = (searchRes.result || []).filter(r => r.type === 'Common Stock' || r.type === '').slice(0, 5).map(r => r.symbol);"
new_finnhub = "const symbols = (searchRes.result || []).filter(r => r.type === 'Common Stock' || r.type === '' || r.type === 'ETP' || r.type === 'ETF').slice(0, 5).map(r => r.symbol);"

if old_finnhub in content:
    content = content.replace(old_finnhub, new_finnhub)

# 3. Wait, if KRX matches > 0, it returns early and NEVER searches Finnhub/Yahoo!
# If the user searches "TIGER", it's NOT in KRX (only stocks, no ETFs in KRX json).
# So "TIGER" goes to Finnhub, which returns nothing, then to Yahoo.
# Yahoo WILL find TIGER ETFs and return them!

with open('backend/server.js', 'w', encoding='utf-8') as f:
    f.write(content)

print("Search logic updated")
