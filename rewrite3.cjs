const fs = require('fs');
let code = fs.readFileSync('src/App.jsx', 'utf8');

// Badges
const badgeLogic = `
  const getTier = (balance) => {
    if (balance >= 500000000) return '🐳 고래 (Whale)';
    if (balance >= 200000000) return '⚔️ 프로 (Pro)';
    return '🌱 초보 (Novice)';
  };
`;

code = code.replace(
  "  /* ── Market ── */",
  `${badgeLogic}\n  /* ── Market ── */`
);

code = code.replace(
  /<div style={{ fontSize: '0\.85rem', fontWeight: 600 }}>\{user\.nickname\}<\/div>/,
  `<div style={{ fontSize: '0.85rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem', justifyContent: 'flex-end' }}>
              <span style={{ fontSize: '0.7rem', padding: '2px 6px', background: 'var(--btn-bg)', borderRadius: '4px' }}>
                {getTier(totalAssetKRW)}
              </span>
              {user.nickname}
            </div>`
);

fs.writeFileSync('src/App.jsx', code);
console.log('App.jsx modified with Badges');
