const TIMEFRAME_MAP = {
  '1m': { interval: '1m', range: '1d' },
  '5m': { interval: '5m', range: '5d' },
  '15m': { interval: '15m', range: '5d' },
  '30m': { interval: '30m', range: '1mo' },
  '1h': { interval: '60m', range: '1mo' },
  '4h': { interval: '1h', range: '3mo' },
  '1d': { interval: '1d', range: '1y' },
};

const DEFAULT_TIMEFRAME = TIMEFRAME_MAP['1m'];

function getYahooChartUrl(symbol, { interval, range }) {
  const encoded = encodeURIComponent(String(symbol || '').toUpperCase());
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=${interval}&range=${range}`;
}

async function fetchYahooChart(symbol, timeframe) {
  try {
  const mapping = TIMEFRAME_MAP[String(timeframe || '1m')] || DEFAULT_TIMEFRAME;
  const response = await fetch(getYahooChartUrl(symbol, mapping), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; reversal-proxy/1.0)'
    }
  });
  if (!response.ok) return null;
  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  if (!result) return null;
  const quote = result?.indicators?.quote?.[0];
  const timestamps = result?.timestamp || [];
  if (!quote || !timestamps.length) return null;
  return { quote, timestamps };
  } catch {
    return null;
  }
}

function getLatestValidIndex(quote, timestamps) {
  for (let i = timestamps.length - 1; i >= 0; i -= 1) {
    const close = quote?.close?.[i];
    if (Number.isFinite(close)) return i;
  }
  return -1;
}

export const yahooProvider = {
  id:'yahoo',
  name:'Yahoo Finance',
  type:'fallback_delayed_unofficial',
  requiresCredentials:false,
  supportsTicks:true,
  supportsCandles:true,
  supportsOrderBook:false,
  status(){ return { status:'fallback_delayed', connected:false, warnings:['Yahoo is fallback/delayed/unofficial-style data and not institutional live feed.'] }; },
  validateCredentials(){ return { valid:true, warnings:[] }; },
  start(){ return { status:'fallback_delayed', connected:false}; },
  stop(){ return {status:'stopped',connected:false}; },
  async getLatestTick(symbol){
    const chart = await fetchYahooChart(symbol, '1m');
    if (!chart) return null;
    const idx = getLatestValidIndex(chart.quote, chart.timestamps);
    if (idx < 0) return null;
    const price = Number(chart.quote.close[idx]);
    const bid = Number.isFinite(chart.quote.low?.[idx]) ? Number(chart.quote.low[idx]) : price;
    const ask = Number.isFinite(chart.quote.high?.[idx]) ? Number(chart.quote.high[idx]) : price;
    return {
      symbol: String(symbol || '').toUpperCase(),
      price,
      bid,
      ask,
      volume: Number(chart.quote.volume?.[idx]) || 0,
      source: 'yahoo',
      timestamp: new Date(chart.timestamps[idx] * 1000).toISOString(),
      sequence: Date.now() % 1_000_000,
    };
  },
  async getLatestCandle(symbol, timeframe='1m'){
    const chart = await fetchYahooChart(symbol, timeframe);
    if (!chart) return null;
    const idx = getLatestValidIndex(chart.quote, chart.timestamps);
    if (idx < 0) return null;
    return {
      symbol: String(symbol || '').toUpperCase(),
      timeframe,
      open: Number(chart.quote.open[idx] ?? chart.quote.close[idx]),
      high: Number(chart.quote.high[idx] ?? chart.quote.close[idx]),
      low: Number(chart.quote.low[idx] ?? chart.quote.close[idx]),
      close: Number(chart.quote.close[idx]),
      volume: Number(chart.quote.volume?.[idx]) || 0,
      source: 'yahoo',
      timestamp: new Date(chart.timestamps[idx] * 1000).toISOString(),
    };
  },
  getLatestOrderBook(){ return null; }
};
