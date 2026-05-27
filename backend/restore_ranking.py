import re

with open('src/App.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

fetch_ranking_code = """  const fetchRanking = async () => {
    try {
      const res = await fetch('/api/ranking');
      if (res.ok) setRanking(await res.json());
    } catch (e) { console.error('Failed to fetch ranking', e); }
  };
"""

# Insert it after fetchEtfs
if 'const fetchRanking =' not in content:
    content = content.replace(
        "  const fetchEtfs = async () => {\n    try {\n      const res = await fetch('/api/etfs/top');\n      if (res.ok) setEtfData(await res.json());\n    } catch (e) { console.error('Failed to fetch etfs', e); }\n  };",
        "  const fetchEtfs = async () => {\n    try {\n      const res = await fetch('/api/etfs/top');\n      if (res.ok) setEtfData(await res.json());\n    } catch (e) { console.error('Failed to fetch etfs', e); }\n  };\n\n" + fetch_ranking_code
    )

with open('src/App.jsx', 'w', encoding='utf-8') as f:
    f.write(content)

print("fetchRanking restored")
