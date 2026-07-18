// Partial-Feature Completion Pass: ML & AI's Predictive Fraud Forecasting gap. A real, honestly-
// scoped forecast -- ordinary least-squares linear regression over a recent bucketed time series
// -- not a deep learning model. This project's own ML component (server/ml/mlClient.js) is
// already a small, explainable model by design (architecture.md Section 9); a forecasting feature
// built for a hackathon fraud-ops dashboard should be held to the same "real and explainable, not
// oversold" standard, not a black-box time-series model this project has no infrastructure to
// train or validate. Reused for both the global fraud-trend forecast (GET /analytics/forecast)
// and Predictive Merchant Risk (GET /merchants/:id/risk-forecast) -- same algorithm, different
// input series, per this project's "one generic mechanism, not one bespoke implementation per
// dashboard panel" convention (e.g. GET /analytics/top-risky's single dimension-parameterized
// endpoint).
const MIN_POINTS_FOR_FORECAST = 3; // fewer than this and a linear trend is just noise, not a signal

/**
 * Ordinary least-squares linear regression over `values` (assumed evenly spaced, index = x),
 * projecting `horizon` more points forward. Values are clamped to >= 0 (a count/amount can't
 * meaningfully forecast negative).
 * @param {number[]} values
 * @param {number} horizon - how many future points to project
 * @returns {{ forecast: number[], slope: number, intercept: number, trend: 'rising'|'falling'|'flat' }}
 */
function predictSeries(values, horizon) {
  const n = values.length;
  if (n < MIN_POINTS_FOR_FORECAST || horizon <= 0) {
    return { forecast: [], slope: 0, intercept: n > 0 ? values[n - 1] : 0, trend: 'flat' };
  }

  // Standard OLS closed form: slope = covariance(x,y) / variance(x), over x = 0..n-1.
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((a, b) => a + b, 0) / n;

  let covariance = 0;
  let xVariance = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - xMean;
    covariance += dx * (values[i] - yMean);
    xVariance += dx * dx;
  }
  const slope = xVariance > 0 ? covariance / xVariance : 0;
  const intercept = yMean - slope * xMean;

  const forecast = [];
  for (let step = 1; step <= horizon; step++) {
    const x = n - 1 + step;
    forecast.push(Math.max(0, Math.round((slope * x + intercept) * 100) / 100));
  }

  // A trend under this magnitude (relative to the series' own mean) isn't worth calling a
  // direction -- avoids a "rising"/"falling" label on what's really just noise around a flat mean.
  const relativeSlope = yMean > 0 ? Math.abs(slope) / yMean : Math.abs(slope);
  let trend = 'flat';
  if (relativeSlope > 0.02) trend = slope > 0 ? 'rising' : 'falling';

  return { forecast, slope, intercept, trend };
}

module.exports = { predictSeries, MIN_POINTS_FOR_FORECAST };
