import re

with open('backend/server.js', 'r', encoding='utf-8') as f:
    content = f.read()

old_pattern = r"// ─── Ranking ──────────────────────────────────────────────────────────────────\napp\.get\('/api/ranking', \(req, res\) => \{.*?res\.json\(users\);\n        \}\);\n    \}\);\n  \}\);\n\}\);"

new_block = """// ─── Ranking ──────────────────────────────────────────────────────────────────
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
});"""

new_content = re.sub(old_pattern, new_block, content, flags=re.DOTALL)

with open('backend/server.js', 'w', encoding='utf-8') as f:
    f.write(new_content)
    
print("Ranking API updated!")
