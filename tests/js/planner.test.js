// node tests/js/planner.test.js
const assert = require("assert");
const { plan } = require("../../static/planner.js");

const current = { "IBCF.MU": 50.47, "ASML.AS": 151.15, TSM: 47.66, "BTC-EUR": 49.6, "ETH-EUR": 165.23, "REP.MC": 34.94,
  "SAN.MC": 23.96, "BBVA.MC": 20.87, TSLA: 20.49, AMZN: 13.15 };
const targets = { "IBCF.MU": 28, "EXUS.L": 12, MSFT: 11, "ASML.AS": 10.5, TSM: 10.5, "IS3N.DE": 10, NVDA: 8, "BTC-EUR": 3.5,
  "ETH-EUR": 1.5, "REP.MC": 1, "SAN.MC": 1, "BBVA.MC": 1, TSLA: 1, AMZN: 1 };
const sum = (a) => a.reduce((s, x) => s + x, 0);

for (const perMonth of [1, 2, 3]) {
  const p = plan({ current, targets, goal: 5000, monthly: 300, perMonth, start: new Date(2026, 9, 1) });
  const invested = sum(Object.values(current));
  assert.ok(Math.abs(sum(p.months.map((m) => m.amount)) - (5000 - invested)) < 1e-6, "invests exactly what's needed");
  assert.ok(p.months.every((m) => m.orders.length <= perMonth), "orders per month respected");
  assert.ok(p.months.slice(0, -1).every((m) => Math.abs(m.amount - 300) < 1e-6), "full budget every month but the last");
  assert.ok(Math.abs(p.months.at(-1).invested - 5000) < 1e-6, "ends at the goal");
  assert.deepStrictEqual(p.overweight.sort(), ["ETH-EUR", "REP.MC", "SAN.MC", "BBVA.MC", "TSLA", "AMZN"].filter((k) => current[k] > targets[k] / 100 * 5000).sort());
  // rounding: every bucket within half an order of its water-filled level
  const slot = 300 / perMonth;
  for (const r of p.final) {
    if (!(r.target > 0)) continue;
    const ideal = Math.max(current[r.bucket] || 0, r.target / 100 * p.F);
    assert.ok(Math.abs(r.amount - ideal) <= slot / 2 + slot + 1e-6, `${r.bucket} close to ideal`);
  }
  console.log(`perMonth=${perMonth}: ${p.months.length} months, ${p.orders} orders (vs ${p.naive_orders} naive), final max drift ${p.final_drift.toFixed(2)} pp`);
  if (perMonth === 1) console.log(p.months.slice(0, 6).map((m) => `${m.date.toISOString().slice(0, 7)} ${m.orders.map((o) => `${o.bucket} ${o.amount.toFixed(0)}`).join(", ")} → drift ${m.drift.toFixed(1)}pp`).join("\n"));
}
// goal already reached
assert.ok(plan({ current, targets, goal: 100, monthly: 300 }).reached);
// no targets
assert.strictEqual(plan({ current, targets: {}, goal: 1000, monthly: 100 }).error, "no-targets");
// next order only: works for very long horizons and matches month 1 of the full plan
const { nextOrders } = require("../../static/planner.js");
const n = nextOrders({ current, targets, goal: 100000, monthly: 105, perMonth: 1 });
assert.strictEqual(n.orders.length, 1);
assert.ok(Math.abs(n.orders[0].amount - 105) < 1e-9 && n.months_to_goal === Math.ceil((100000 - sum(Object.values(current))) / 105));
const full = plan({ current, targets, goal: 5000, monthly: 300, perMonth: 2 });
assert.deepStrictEqual(nextOrders({ current, targets, goal: 5000, monthly: 300, perMonth: 2 }).orders, full.months[0].orders);
// very long horizon: sequenced up to the limit, totals still known
const long = plan({ current, targets, goal: 1e6, monthly: 105, perMonth: 1, limitMonths: 120 });
assert.ok(long.truncated && long.months.length === 120 && long.months_needed > 9000);
// projection: no contributions → plain compounding; with contributions → invested grows linearly
const { project } = require("../../static/planner.js");
const flat = project({ months: Array.from({ length: 24 }, () => ({ amount: 0 })), startValue: 1000, startInvested: 1000, annual: 0.06 });
assert.ok(Math.abs(flat.at(-1).value - 1000 * 1.06 ** 2) < 1e-6);
const pr = project({ months: Array.from({ length: 12 }, () => ({ amount: 100 })), startValue: 0, startInvested: 0, annual: 0.05, band: 0.02 });
assert.ok(Math.abs(pr.at(-1).invested - 1200) < 1e-9 && pr.at(-1).low < pr.at(-1).value && pr.at(-1).value < pr.at(-1).high);
console.log("planner ok");
