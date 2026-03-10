import { appdGet } from "../src/services/api-client.js";
const APP_ID = 50606;
// Check all remaining BTs for activity
const btsToCheck = [
  { id: 10442398, name: "/product/outdoor/BackPack",      tier: "FrontEnd" },
  { id: 10442399, name: "/product/indoor/{sequence}",     tier: "FrontEnd" },
  { id: 10442400, name: "/product/indoor/BillardTable",   tier: "FrontEnd" },
  { id: 10442403, name: "/product/furniture/SwivelChair", tier: "FrontEnd" },
  { id: 10442383, name: "/http/to3d",   tier: "OrderProcessing" },
  { id: 10442384, name: "/http/to2nd",  tier: "Inventory" },
];
for (const bt of btsToCheck) {
  const path = `Business Transaction Performance|Business Transactions|${bt.tier}|${bt.name}|Average Response Time (ms)`;
  const data = await appdGet<any[]>(`/controller/rest/applications/${APP_ID}/metric-data`, {
    "metric-path": path, "time-range-type": "BEFORE_NOW", "duration-in-mins": 60, rollup: true,
  });
  const val = Array.isArray(data) && data[0]?.metricValues?.[0];
  console.log(`${bt.name}: ${val && val.count > 0 ? `✓ value=${val.value}` : "✗ NO DATA"}`);
}
