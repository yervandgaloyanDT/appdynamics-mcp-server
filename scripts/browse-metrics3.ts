import { appdGet } from "../src/services/api-client.js";
const APP_ID = 50606;
async function browse(path: string): Promise<void> {
  try {
    const data = await appdGet<any[]>(`/controller/rest/applications/${APP_ID}/metrics`, { "metric-path": path });
    console.log(`\n[${path}]`);
    if (Array.isArray(data)) data.forEach((m: any) => console.log(`  ${m.type === "folder" ? "📁" : "📊"} ${m.name}`));
    else console.log("  (empty/not folder)");
  } catch (err: any) { console.log(`  ERROR: ${err.message}`); }
}
await browse("Application Infrastructure Performance|FrontEnd|JVM|Memory|Heap");
await browse("Application Infrastructure Performance|FrontEnd|JVM|Memory|Non-Heap");
