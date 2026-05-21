const axios = require('axios');
async function test() {
  const naverUrl = 'https://fchart.stock.naver.com/sise.nhn?symbol=005930&timeframe=day&count=10&requestType=0';
  const resp = await axios.get(naverUrl);
  const xml = resp.data;
  const items = xml.match(/<item data="([^"]+)"/g) || [];
  console.log(items.length);
  const data = items[0].match(/data="([^"]+)"/)[1].split('|');
  console.log(data);
}
test();
