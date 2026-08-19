import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractRecord } from "../extract/index.js";
import { migrateCustomer } from "../db/migrate.js";
import { saveRecord } from "../store.js";
import { loadGraph } from "../graphStore.js";
import type { RecordType } from "../types.js";

/**
 * Ingest the Northlake demo corpus and print the cross-document graph.
 *
 * Saves every fixture as a record (idempotent), then assembles and prints the
 * deterministic reference graph: node count, edges by kind, and any dangling
 * references (documents cited but not held). Populates the customer DB so the
 * reference map has the full corpus to draw.
 *
 *   npm run graph:demo
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "eval", "fixtures");

// record type per fixture, mirroring README-northlake-demo.md.
const TYPES: Record<string, string> = {
  "dir-0400-design-inputs": "design_input",
  "dos-0400-design-outputs": "design_output",
  "dr-vp400-07-design-review": "design_review",
  "ver-2026-014-occlusion-verification": "verification",
  "val-vp400-03-human-factors": "validation",
  "tm-vp400-traceability": "traceability_matrix",
  "rmp-vp400-risk-plan": "risk_analysis",
  "rmf-vp400-risk-management": "risk_analysis",
  "fmea-vp400-infusion": "risk_analysis",
  "ra-sp200-syringe": "risk_analysis",
  "comp-2026-0207-vasoactive": "complaint",
  "capa-001-infusion-pump-alarm": "capa",
  "capa-2026-0114-occlusion-annunciation": "capa",
  "dco-2026-0031-chamfer": "change_package",
  "dco-2025-0077-transducer": "change_package",
  "ca-2026-011-firmware-ltf": "change_package",
};

async function main(): Promise<void> {
  await migrateCustomer();

  const docs = readdirSync(FIXTURES).filter(
    (f) => f.endsWith(".md") && !f.startsWith("README"),
  );
  let saved = 0;
  for (const f of docs) {
    const base = f.replace(/\.md$/, "");
    const recordType = (TYPES[base] ?? "unknown") as RecordType;
    const extraction = await extractRecord({ path: join(FIXTURES, f), recordType });
    await saveRecord(extraction.record, extraction.blocks);
    saved++;
  }
  console.log(`Ingested ${saved} demo documents.\n`);

  const graph = await loadGraph();

  console.log(`Cross-document graph`);
  console.log(`Nodes: ${graph.nodes.length}   Edges: ${graph.edges.length}\n`);

  const byKind = new Map<string, number>();
  for (const e of graph.edges) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
  console.log("Edges by kind:");
  for (const [kind, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${kind}`);
  }

  const idByRecord = new Map(graph.nodes.map((n) => [n.recordId, n.docId ?? n.filename]));
  console.log("\nResolved edges:");
  for (const e of graph.edges.filter((x) => x.dstRecordId)) {
    console.log(`  ${(idByRecord.get(e.srcRecordId) ?? "?").padEnd(16)} --${e.kind}--> ${e.dstRef}`);
  }

  if (graph.danglingRefs.length > 0) {
    console.log(`\nDangling references (cited but not held): ${graph.danglingRefs.length}`);
    for (const d of graph.danglingRefs.slice(0, 12)) {
      console.log(`  ${(idByRecord.get(d.srcRecordId) ?? "?").padEnd(16)} -> ${d.dstRef}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
