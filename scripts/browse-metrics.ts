/**
 * Browse metric paths for JVM, Hardware, Backend metrics on Java-App1.
 * Run: npx tsx scripts/browse-metrics.ts
 */
import { appdGet } from "../src/services/api-client.js";

const APP_ID = 50606;

async function browse(path: string): Promise<void> {
  try {
    const data = await appdGet<any[]>(
      `/controller/rest/applications/${APP_ID}/metrics`,
      { "metric-path": path },
    );
    console.log(`\n[${path}]`);
    if (Array.isArray(data)) {
      data.forEach((m: any) => console.log(`  ${m.type === "folder" ? "📁" : "📊"} ${m.name}`));
    } else {
      console.log("  (no children or not a folder)");
    }
  } catch (err: any) {
    console.log(`  ERROR: ${err.message}`);
  }
}

// JVM memory
await browse("Application Infrastructure Performance|FrontEnd|JVM");
await browse("Application Infrastructure Performance|FrontEnd|JVM|Memory:Heap");
await browse("Application Infrastructure Performance|FrontEnd|JVM|CPU");
await browse("Application Infrastructure Performance|FrontEnd|JVM|Garbage Collection");
await browse("Application Infrastructure Performance|FrontEnd|Hardware Resources");
await browse("Application Infrastructure Performance|FrontEnd|Hardware Resources|Memory");
await browse("Backends");
await browse("Backends|MYSQL-AppDynamics-LOCALHOST-1.0");
await browse("Backends|NEWSCHEMA-MYSQL-LOCALHOST-5.6");
await browse("Backends|Kivity-Ultra-7:10010");
