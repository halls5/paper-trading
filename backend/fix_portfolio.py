import re

with open('server.js', encoding='utf-8') as f:
    content = f.read()

old_block = '''app.get('/api/portfolio', authenticateToken, (req, res) => {
  db.all('SELECT * FROM portfolios WHERE user_id = ? AND quantity > 0', [req.user.userId], (err, rows) => {
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
    res.json(enriched);
  });
});'''

new_block = '''app.get('/api/portfolio', authenticateToken, async (req, res) => {
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
});'''

# Find and replace by searching for the pattern without the Korean error string
# Use regex that matches the block regardless of encoding issues in the error string
pattern = r"app\.get\('/api/portfolio', authenticateToken, \(req, res\) => \{.*?res\.json\(enriched\);\n  \}\);\n\}\);"
flags = re.DOTALL

if re.search(pattern, content, flags):
    new_content = re.sub(pattern, new_block, content, flags=flags)
    with open('server.js', 'w', encoding='utf-8') as f:
        f.write(new_content)
    print("SUCCESS: portfolio endpoint updated")
else:
    print("PATTERN NOT FOUND, trying direct line replacement...")
    # Find the lines by index
    lines = content.split('\n')
    start = None
    end = None
    for i, line in enumerate(lines):
        if "app.get('/api/portfolio', authenticateToken" in line and start is None:
            start = i
        if start is not None and line.strip() == '});' and i > start + 5:
            end = i
            break
    if start is not None and end is not None:
        print(f"Found block lines {start+1}-{end+1}")
        new_lines = lines[:start] + new_block.split('\n') + lines[end+1:]
        with open('server.js', 'w', encoding='utf-8') as f:
            f.write('\n'.join(new_lines))
        print("SUCCESS via line replacement")
    else:
        print(f"Could not find block. start={start}, end={end}")
