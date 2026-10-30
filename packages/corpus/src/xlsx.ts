/**
 * The .xlsx reader moved to core when customer spreadsheets became reviewable
 * records (see packages/core/src/extract/xlsxReader.ts). Re-exported so the FDA
 * ingest keeps importing it from here.
 */
export { findHeader, openWorkbook, type Sheet, type Workbook } from "@regreview/core";
