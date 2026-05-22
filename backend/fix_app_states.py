import re

with open('src/App.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Fix state initialization
if 'const [etfData, setEtfData] = useState([]);' not in content:
    content = content.replace(
        "const [stockData, setStockData] = useState([]);",
        "const [stockData, setStockData] = useState([]);\n  const [etfData, setEtfData] = useState([]);"
    )

# Fix fetchEtfs
if 'const fetchEtfs = async ()' not in content:
    content = content.replace(
        "const fetchStocks = async () => {",
        "const fetchEtfs = async () => {\n    try {\n      const res = await fetch('/api/etfs/top');\n      if (res.ok) setEtfData(await res.json());\n    } catch (e) { console.error('Failed to fetch etfs', e); }\n  };\n\n  const fetchStocks = async () => {"
    )

# Fix missing activeTopTab if any
if "const [activeTopTab, setActiveTopTab] = useState('CRYPTO');" not in content:
    content = content.replace(
        "const [activeTab, setActiveTab] = useState('CRYPTO');",
        "const [activeTab, setActiveTab] = useState('CRYPTO');\n  const [activeTopTab, setActiveTopTab] = useState('CRYPTO');"
    )

with open('src/App.jsx', 'w', encoding='utf-8') as f:
    f.write(content)

print("App.jsx states fixed")
