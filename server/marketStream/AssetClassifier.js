import { supportsAssetClass } from './CapabilityModel.js';

const CRYPTO_RE = /^(BTC|ETH|SOL|ADA|DOT|XRP|DOGE|AVAX|MATIC|LINK)[-/]?/i;
const CRYPTO_PAIR_RE = /^[A-Z0-9]{2,8}-(USD|USDT|USDC|BTC|ETH)$/i;
const FOREX_RE = /=X$/i;
const FOREX_6_RE = /^[A-Z]{6}$/;
const INDEX_RE = /^\^/;
const FUTURES_RE = /=F$/i;

export class AssetClassifier {
  classify(symbol) {
    const s = String(symbol || '').toUpperCase().trim();
    if (!s) return 'equity';
    if (INDEX_RE.test(s)) return 'index';
    if (FUTURES_RE.test(s)) return 'futures';
    if (FOREX_RE.test(s)) return 'forex';
    if (FOREX_6_RE.test(s) && !s.includes('-')) return 'forex';
    if (CRYPTO_RE.test(s) || CRYPTO_PAIR_RE.test(s)) return 'crypto';
    return 'equity';
  }

  compatibleProviders(symbol, providerIds = []) {
    const assetClass = this.classify(symbol);
    return providerIds.filter((p) => supportsAssetClass(p, assetClass));
  }
}

export const assetClassifier = new AssetClassifier();
