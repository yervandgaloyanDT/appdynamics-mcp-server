/**
 * Discovery script: fetch java-app1 structure — app ID, BTs, tiers, backends.
 * Run: npx tsx scripts/discover-java-app1.ts
 */

import { appdGet } from "../src/services/api-client.js";

const apps = await appdGet<any[]>("/controller/rest/applications");
const app = apps.find((a: any) => a.name.toLowerCase() === "java-app1");
if (!app) {
  console.log("Available apps:", apps.map((a: any) => a.name).join(", "));
  throw new Error("java-app1 not found");
}
console.log(`\nAPP: id=${app.id} name=${app.name}`);

const [tiers, bts, backends] = await Promise.all([
  appdGet<any[]>(`/controller/rest/applications/${app.id}/tiers`),
  appdGet<any[]>(`/controller/rest/applications/${app.id}/business-transactions`),
  appdGet<any[]>(`/controller/rest/applications/${app.id}/backends`),
]);

console.log(`\nTIERS (${tiers.length}):`);
tiers.forEach((t: any) => console.log(`  id=${t.id} name=${t.name}`));

console.log(`\nBUSINESS TRANSACTIONS (${bts.length}):`);
bts.slice(0, 15).forEach((bt: any) => console.log(`  id=${bt.id} name=${bt.name} tier=${bt.tierName}`));
if (bts.length > 15) console.log(`  ... and ${bts.length - 15} more`);

console.log(`\nBACKENDS (${backends.length}):`);
backends.forEach((b: any) => console.log(`  id=${b.id} name=${b.name} type=${b.exitPointType}`));
