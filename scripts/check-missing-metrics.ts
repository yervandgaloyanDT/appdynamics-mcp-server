import { appdGet } from "../src/services/api-client.js";
const APP_ID = 50606;

async function check(label: string, path: string): Promise<void> {
  const data = await appdGet<any[]>(`/controller/rest/applications/${APP_ID}/metric-data`, {
    "metric-path": path,
    "time-range-type": "BEFORE_NOW",
    "duration-in-mins": 1440, // 24 hours
    rollup: true,
  });
  const val = Array.isArray(data) && data[0]?.metricValues?.[0];
  console.log(`${label}: ${val ? `count=${val.count} value=${val.value}` : "NO DATA (24h)"}`);
}

// Hardware memory
await check("Hardware Memory Used MB", "Application Infrastructure Performance|FrontEnd|Hardware Resources|Memory|Used (MB)");

// BTs not active in 60min — check 24h
await check("BT /product/outdoor (24h)",  "Business Transaction Performance|Business Transactions|FrontEnd|/product/outdoor|Average Response Time (ms)");
await check("BT /product/furniture (24h)","Business Transaction Performance|Business Transactions|FrontEnd|/product/furniture|Average Response Time (ms)");
await check("BT /product/indoor (24h)",   "Business Transaction Performance|Business Transactions|FrontEnd|/product/indoor|Average Response Time (ms)");
await check("BT /product/indoor/DartBoards (24h)", "Business Transaction Performance|Business Transactions|FrontEnd|/product/indoor/DartBoards|Average Response Time (ms)");

// Errors (should be 0 - app is healthy)
await check("OAP Errors/Min (24h)", "Overall Application Performance|Errors per Minute");
await check("BT /quoterequest Errors (24h)", "Business Transaction Performance|Business Transactions|FrontEnd|/quoterequest|Errors per Minute");
