const fs = require('fs');
let code = fs.readFileSync('src/App.jsx', 'utf8');

// Replace RGBA
code = code.replace(/rgba\(0,0,0,0\.2\)/g, 'var(--row-bg)');
code = code.replace(/rgba\(0,0,0,0\.25\)/g, 'var(--input-bg)');
code = code.replace(/rgba\(0,0,0,0\.3\)/g, 'var(--row-bg)');
code = code.replace(/rgba\(255,255,255,0\.08\)/g, 'var(--btn-bg)');
code = code.replace(/rgba\(255,255,255,0\.05\)/g, 'var(--btn-bg)');
code = code.replace(/rgba\(255,255,255,0\.1\)/g, 'var(--btn-bg)');

// Add lucide icons imports
code = code.replace("import { MiniChart, ChartModal, PieChart, AssetAllocationBar } from './ChartComponents';", "import { MiniChart, ChartModal, PieChart, AssetAllocationBar } from './ChartComponents';\nimport { Sun, Moon, Coins, TrendingUp, Search, Trophy, ScrollText, Wallet, PieChart as PieChartIcon } from 'lucide-react';");

// Replace Emojis
code = code.replace(/🪙 코인 실시간 시세/g, '<Coins size={18} style={{ marginRight: 6, verticalAlign: "text-bottom" }} /> 코인 실시간 시세');
code = code.replace(/🪙 코인 Top 10/g, '<Coins size={16} style={{ marginRight: 4, verticalAlign: "text-bottom" }} /> 코인 Top 10');

code = code.replace(/📊 주식 Top 10/g, '<TrendingUp size={16} style={{ marginRight: 4, verticalAlign: "text-bottom" }} /> 주식 Top 10');
code = code.replace(/📊 국내외 우량주 \(지연 시세\)/g, '<TrendingUp size={18} style={{ marginRight: 6, verticalAlign: "text-bottom" }} /> 국내외 우량주 (지연 시세)');

code = code.replace(/🔍 검색 결과/g, '<Search size={16} style={{ marginRight: 4, verticalAlign: "text-bottom" }} /> 검색 결과');

code = code.replace(/🏆 랭킹/g, '<Trophy size={16} style={{ marginRight: 4, verticalAlign: "text-bottom" }} /> 랭킹');

code = code.replace(/📜 거래 내역/g, '<ScrollText size={16} style={{ marginRight: 4, verticalAlign: "text-bottom" }} /> 거래 내역');

code = code.replace(/💰 총 잔고/g, '<Wallet size={15} style={{ marginRight: 4, verticalAlign: "text-bottom" }} /> 총 잔고');

code = code.replace(/📊 내 포트폴리오/g, '<PieChartIcon size={18} style={{ marginRight: 6, verticalAlign: "text-bottom" }} /> 내 포트폴리오');

fs.writeFileSync('src/App.jsx', code);
console.log('Replaced RGBA and Emojis in App.jsx');
