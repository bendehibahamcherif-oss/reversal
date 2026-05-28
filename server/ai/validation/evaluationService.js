import { safeNumber } from '../mlCore.js';

function ratio(a, b) { return b ? a / b : 0; }

class EvaluationService {
  evaluate(yTrue = [], yPred = [], regimes = []) {
    const warnings = [];
    if (yTrue.length !== yPred.length || !yTrue.length) return { ok: false, warnings: ['Insufficient or mismatched evaluation vectors.'] };
    const labels = [...new Set([...yTrue, ...yPred])];
    const matrix = {};
    for (const t of labels) { matrix[t] = {}; for (const p of labels) matrix[t][p] = 0; }
    let correct = 0;
    for (let i = 0; i < yTrue.length; i++) { matrix[yTrue[i]][yPred[i]] += 1; if (yTrue[i] === yPred[i]) correct += 1; }
    const positive = labels[0];
    const tp = safeNumber(matrix[positive]?.[positive], 0);
    const fp = labels.filter((l) => l !== positive).reduce((acc, l) => acc + safeNumber(matrix[l]?.[positive], 0), 0);
    const fn = labels.filter((l) => l !== positive).reduce((acc, l) => acc + safeNumber(matrix[positive]?.[l], 0), 0);
    const precision = ratio(tp, tp + fp); const recall = ratio(tp, tp + fn); const f1 = ratio(2 * precision * recall, precision + recall);
    const regimeSegments = {};
    regimes.forEach((r, i) => { const key = r || 'unknown'; if (!regimeSegments[key]) regimeSegments[key] = { total: 0, correct: 0 }; regimeSegments[key].total += 1; if (yTrue[i] === yPred[i]) regimeSegments[key].correct += 1; });
    Object.keys(regimeSegments).forEach((k) => { regimeSegments[k].accuracy = ratio(regimeSegments[k].correct, regimeSegments[k].total); });
    if (yTrue.length < 30) warnings.push('Evaluation sample size is small; metrics may be noisy.');
    return { ok: true, metrics: { accuracy: ratio(correct, yTrue.length), precision, recall, f1, confusionMatrix: matrix, support: yTrue.length }, regimeSegments, warnings, summary: this.formatSummary({ accuracy: ratio(correct, yTrue.length), precision, recall, f1 }) };
  }
  formatSummary(metrics = {}) { return `acc=${(100 * safeNumber(metrics.accuracy)).toFixed(2)}% | precision=${safeNumber(metrics.precision).toFixed(4)} | recall=${safeNumber(metrics.recall).toFixed(4)} | f1=${safeNumber(metrics.f1).toFixed(4)}`; }
}

export const evaluationService = new EvaluationService();
