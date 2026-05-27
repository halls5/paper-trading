import re

with open('src/App.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Replace {h.asset_symbol} with {h.asset_name || h.asset_symbol} inside HistoryView
# Be careful to target the exact line in HistoryView
old_history_row = """                    <span style={{ color: h.type === 'BUY' ? 'var(--danger-color)' : 'var(--success-color)', fontSize: '0.8rem', padding: '2px 6px', background: 'var(--btn-bg)', borderRadius: '4px' }}>
                      {h.type === 'BUY' ? '매수' : '매도'}
                    </span>
                    {h.asset_symbol}
                  </div>"""

new_history_row = """                    <span style={{ color: h.type === 'BUY' ? 'var(--danger-color)' : 'var(--success-color)', fontSize: '0.8rem', padding: '2px 6px', background: 'var(--btn-bg)', borderRadius: '4px' }}>
                      {h.type === 'BUY' ? '매수' : '매도'}
                    </span>
                    {h.asset_name || h.asset_symbol}
                  </div>"""

if '{h.asset_symbol}' in old_history_row and old_history_row in content:
    content = content.replace(old_history_row, new_history_row)

with open('src/App.jsx', 'w', encoding='utf-8') as f:
    f.write(content)

print("App.jsx updated")
