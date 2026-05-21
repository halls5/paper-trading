import FinanceDataReader as fdr
import json
import os

print("Fetching KRX stocks...")
df = fdr.StockListing('KRX')

# Extract necessary columns
# Filter out some garbage if needed, but keeping all is fine
df_clean = df[['Code', 'Name']].rename(columns={'Code': 'symbol', 'Name': 'name'})

# Add .KS or .KQ suffix
# Note: FinanceDataReader doesn't easily distinguish KS/KQ in the 'KRX' dataframe sometimes,
# actually fdr.StockListing('KRX') returns 'Market' column. Let's use it.
if 'Market' in df.columns:
    def add_suffix(row):
        code = row['Code']
        market = str(row.get('Market', ''))
        if 'KOSPI' in market: return code + '.KS'
        elif 'KOSDAQ' in market: return code + '.KQ'
        return code + '.KS' # fallback
    df_clean['symbol'] = df.apply(add_suffix, axis=1)
else:
    df_clean['symbol'] = df_clean['symbol'] + '.KS' # Rough fallback

data = df_clean.to_dict('records')

with open('krx.json', 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False)

print(f"Saved {len(data)} tickers to krx.json")
