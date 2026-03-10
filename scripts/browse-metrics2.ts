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
// Backend paths
await browse("Backends|Discovered backend call - MYSQL-AppDynamics-LOCALHOST-1.0");
await browse("Backends|Discovered backend call - NEWSCHEMA-MYSQL-LOCALHOST-5.6");
await browse("Backends|Discovered backend call - Kivity-Ultra-7:10010");
await browse("Backends|Discovered backend call - Kivity-Ultra-7:10011");
// JVM memory
await browse("Application Infrastructure Performance|FrontEnd|JVM|Memory");
// JVM threads
await browse("Application Infrastructure Performance|FrontEnd|JVM|Threads");
// Hardware CPU
await browse("Application Infrastructure Performance|FrontEnd|Hardware Resources|CPU");
// Check if JVM CPU % exists
await browse("Application Infrastructure Performance|FrontEnd|JVM");
