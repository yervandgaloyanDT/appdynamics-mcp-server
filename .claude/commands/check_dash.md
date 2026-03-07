create a dashboard  using the rest api for app: $ARGUMENTS

Dashboard should include:
# Dashboard Layout — 47 Widgets across 7 Sections

| Section | Widgets | What It Shows |
|---|---|---|
| Application Overview | 10 | Time-series + metric tiles for Avg Response, Calls/Min, Errors/Min, Stall Count, Slow/Very Slow Calls |
| Health Status | 1 | Live Health Rule violation list across all tiers |
| BT Response Times | 9 | All critical BTs: |
| BT Throughput & Errors | 8 | Calls/Min, Errors/Min, 95th Percentile, Stall Count per key BT |
| JVM Health (FrontEnd) | 8 | Heap Used %, Heap MB, GC Time, Thread Count, CPU %, Major/Minor GC Collections, GC Freed Objects |
| Hardware Infrastructure | 4 | Host CPU Busy %, CPU Idle %, Memory Used %, Memory Used MB |
| Backend Dependencies | 6 | MySQL (both schemas), HTTP backends :10010/:10011 — Response Time, Calls/Min, Errors/Min |

After is was created you must check that it work by going through each widget and see it has data in it. 