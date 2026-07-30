/**
 * Timing harness for the xlsx reader. Not part of the product — a diagnostic
 * for when parsing is slower than it has any right to be.
 *
 * Kept because it earned its place: it is how we found that FDA's FY2014
 * workbook expands to ~60 MB per worksheet across nine worksheets (Excel pads
 * every sheet to its 1,048,576-row limit), which made an eager whole-workbook
 * parse look like a hang.
 *
 *   npx tsx src/cli/timeParse.ts <path-to-xlsx> [sheetName]
 */
import { readFileSync } from "node:fs";
import { openWorkbook } from "../xlsx.js";

const [path, sheetName = "Devices"] = process.argv.slice(2);
if (!path) {
  console.error("usage: tsx src/cli/timeParse.ts <file.xlsx> [sheetName]");
  process.exit(2);
}

const buf = readFileSync(path);
console.log(`${path}  (${(buf.length / 1024).toFixed(0)} KiB compressed)`);

let t = performance.now();
const workbook = openWorkbook(buf);
console.log(`  openWorkbook: ${(performance.now() - t).toFixed(0)} ms`);
console.log(`  sheets: ${workbook.sheetNames.join(", ")}`);

t = performance.now();
const sheet = workbook.getSheet(sheetName);
console.log(
  `  getSheet(${JSON.stringify(sheetName)}): ${(performance.now() - t).toFixed(0)} ms -> ` +
    `${sheet ? `${sheet.rows.length} non-empty rows` : "NOT FOUND"}`,
);
