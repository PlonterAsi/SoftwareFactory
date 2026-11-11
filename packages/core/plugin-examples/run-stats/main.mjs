// Run stats backend. Runs in its own process: it can read this folder and nothing else.
// It keeps factory-wide totals in its own store and marks every fifth shipped build on the timeline.

sf.on("factory.run.finished", (e) => {
  const outcome = String(e.payload?.outcome ?? "unknown");
  const totals = sf.data.get("totals") ?? { shipped: 0, failed: 0, other: 0 };
  if (outcome === "shipped") totals.shipped++;
  else if (outcome === "failed") totals.failed++;
  else totals.other++;
  totals.lastRun = e.payload?.run ?? null;
  totals.lastAt = e.ts;
  sf.data.set("totals", totals);
  if (outcome === "shipped" && totals.shipped % 5 === 0) {
    sf.emit("milestone", { text: `${totals.shipped} builds shipped since Run stats was turned on` });
  }
});

sf.handle("totals", () => sf.data.get("totals") ?? { shipped: 0, failed: 0, other: 0 });

console.log("Run stats is listening for finished runs");
