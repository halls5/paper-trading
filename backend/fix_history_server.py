import re

with open('backend/server.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Fix /api/transactions
old_transactions = """// Transaction history for portfolio list
app.get('/api/transactions', authenticateToken, (req, res) => {
  db.all(
    'SELECT * FROM transactions WHERE user_id = ? ORDER BY timestamp ASC',
    [req.user.userId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: '데이터베이스 오류' });
      res.json(rows);
    }
  );
});"""

new_transactions = """// Transaction history for portfolio list
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
});"""

if 'ORDER BY timestamp ASC' in content:
    content = content.replace(old_transactions, new_transactions)

with open('backend/server.js', 'w', encoding='utf-8') as f:
    f.write(content)

print("server.js updated")
