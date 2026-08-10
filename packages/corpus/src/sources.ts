/**
 * Public regulatory sources, with URLs verified 2026-07-29.
 *
 * All of these are US Government works — public domain, no licensing
 * restriction. Nothing copyrighted belongs in this file; see NOTICE.md, and in
 * particular do not add ISO 13485 or ISO 14971 here.
 */

/**
 * FDA "Inspectional Observation" (Turbo EIR) frequency-of-citation files, one
 * per fiscal year.
 *
 * This is the single most valuable public asset for this product: each row maps
 * a CFR paragraph to the canonical sentence FDA writes when citing it, plus how
 * often it was cited that year. It gives us empirical inspection risk for the
 * severity model, and FDA's own phrasing as ground truth for the eval set.
 *
 * Index page (browser only — the CDN 404s automated clients):
 * https://www.fda.gov/inspections-compliance-enforcement-and-criminal-investigations/inspection-references/inspection-observations
 *
 * FY2014 onward are .xlsx. FY2006–FY2013 are legacy OLE2 .xls and are omitted:
 * supporting them means a BIFF parser, and twelve years of recent data is both
 * sufficient for weighting and more representative of how FDA inspects now.
 * The `LEGACY_XLS_YEARS` list records what we're leaving on the table.
 */
export const OBSERVATION_FILES: { fiscalYear: number; url: string }[] = [
  { fiscalYear: 2025, url: "https://www.fda.gov/media/190190/download?attachment" },
  { fiscalYear: 2024, url: "https://www.fda.gov/media/185090/download?attachment" },
  { fiscalYear: 2023, url: "https://www.fda.gov/media/174101/download?attachment" },
  { fiscalYear: 2022, url: "https://www.fda.gov/media/163420/download?attachment" },
  { fiscalYear: 2021, url: "https://www.fda.gov/media/153238/download?attachment" },
  { fiscalYear: 2020, url: "https://www.fda.gov/media/143942/download?attachment" },
  { fiscalYear: 2019, url: "https://www.fda.gov/media/132571/download" },
  { fiscalYear: 2018, url: "https://www.fda.gov/media/123311/download" },
  { fiscalYear: 2017, url: "https://www.fda.gov/media/109749/download" },
  { fiscalYear: 2016, url: "https://www.fda.gov/media/101615/download" },
  { fiscalYear: 2015, url: "https://www.fda.gov/media/95336/download" },
  { fiscalYear: 2014, url: "https://www.fda.gov/media/90525/download" },
];

/** Known-legacy .xls years, kept for the record. Not ingested. */
export const LEGACY_XLS_YEARS = [2013, 2012, 2011, 2010, 2009, 2008, 2007, 2006] as const;

/**
 * The worksheet we want inside each workbook. Each file has one tab per program
 * area (Devices, Drugs, Foods, Biologics, ...) plus a Summary tab.
 */
export const DEVICES_SHEET = "Devices";

/** Column headers, lowercased. Matched case-insensitively because they drift
 *  between years ("Cite ID" in FY2025 vs "Cite Id" in FY2019). */
export const OBSERVATION_COLUMNS = {
  citation: "reference number",
  shortDescription: "short description",
  longDescription: "long description",
  frequency: "frequency",
  programArea: "citation program area",
} as const;

/**
 * eCFR versioner API — full Part 820 as structure-preserving XML, addressable
 * by date. No key, no registration.
 *
 * We fetch two dates deliberately:
 *
 *  - `legacy` (pre-QMSR): §820.30 design controls and §820.100 CAPA still exist
 *    as regulation text here. Needed because historical records were written
 *    against it and because every historical 483 citation refers to it.
 *  - `current` (post-2026-02-02 QMSR): Part 820 is now titled "Quality
 *    Management System Regulation" and most of it is [Reserved] — the
 *    substantive requirements moved into ISO 13485 by incorporation. Fetching
 *    this is how we know which sections went away.
 */
export const CFR_PART_820 = {
  urlFor: (date: string) =>
    `https://www.ecfr.gov/api/versioner/v1/full/${date}/title-21.xml` +
    `?chapter=I&subchapter=H&part=820`,
  /** Last date on which the pre-QMSR text was in force. */
  legacyDate: "2025-06-01",
  /** Fetched as of; QMSR took effect 2026-02-02. */
  currentDate: "2026-07-01",
} as const;

/**
 * Every part of 21 CFR Subchapter H (Medical Devices), as of 2026-08-08 —
 * fetched from the eCFR structure API
 * (https://www.ecfr.gov/api/versioner/v1/structure/2026-07-01/title-21.json)
 * rather than assembled by hand, so nothing is missed or misnumbered. Part 813
 * is `[Reserved]` and is omitted; the rest, from Part 800 (General) through
 * Part 898 (the last device-classification part), are all real regulation
 * text under this subchapter.
 */
export const CFR_SUBCHAPTER_H_PARTS = [
  800, 801, 803, 806, 807, 808, 809, 810, 812, 814, 820, 821, 822, 830, 860,
  861, 862, 864, 866, 868, 870, 872, 874, 876, 878, 880, 882, 884, 886, 888,
  890, 892, 895, 898,
] as const;

/** Same eCFR versioner endpoint as {@link CFR_PART_820}, generalized to any part. */
export function ecfrPartUrl(date: string, part: number): string {
  return (
    `https://www.ecfr.gov/api/versioner/v1/full/${date}/title-21.xml` +
    `?chapter=I&subchapter=H&part=${part}`
  );
}

/**
 * FDA guidance documents. PDF only — there is no XML/JSON body for guidance.
 *
 * The Design Control guidance is served from the HHS Guidance Portal rather
 * than fda.gov: the HHS copy is the same document and is actually fetchable,
 * whereas fda.gov's CDN blocks us.
 */
export const GUIDANCE_DOCS = [
  {
    id: "design-control-1997",
    title: "Design Control Guidance for Medical Device Manufacturers",
    published: "1997-03-11",
    url:
      "https://www.hhs.gov/guidance/sites/default/files/hhs-guidance-documents/FDA/" +
      "Design-Control-Guidance-For-Medical-Device-Manufacturers.pdf",
    // Still the clearest statement of FDA's design-control expectations, and it
    // survives QMSR conceptually even though §820.30 is now [Reserved]. With
    // ISO 13485 off-limits, this is our main public-domain substitute.
    note: "public domain; primary interpretive source for design controls",
  },
] as const;
