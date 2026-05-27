import re

with open('src/App.jsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Fix computedRanking dependency array
content = content.replace(
    "}, [ranking, liveData, stockData]);",
    "}, [ranking, liveData, stockData, etfData]);"
)

with open('src/App.jsx', 'w', encoding='utf-8') as f:
    f.write(content)

print("computedRanking dependency array fixed")
