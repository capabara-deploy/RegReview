# Third-party content and licensing

Read this before adding anything to the rule corpus.

## ISO 13485:2016 and ISO 14971 — do not ingest

Both are copyrighted ISO deliverables, sold per seat. Single-user PDFs are
typically DRM-locked. **We may not embed, quote at length, ship, redistribute,
or fine-tune on their text.**

What we may do: reference clause numbers and clause titles, and store our own
original prose describing what each clause expects.

This is a sharp edge rather than a footnote. As of 2026-02-02 the QMSR amended
21 CFR Part 820 so that §820.30 (design controls) and §820.100 (CAPA) are
`[Reserved]`, and those requirements now arrive by **incorporation by reference**
to ISO 13485:2016 (design and development is clause 7.3; CAPA is 8.5.2/8.5.3).
So the legally operative requirements for our first product area live in a
document we cannot redistribute, even though a US regulation mandates them.

Two consequences:

1. Every `rules` row with `source = 'iso_clause'` must have an `expectation`
   written by us, in our own words. If you find yourself copying a sentence out
   of the standard, stop.
2. Each customer must hold their own ISO 13485 license. Product copy should say
   so plainly rather than implying we supply the standard.

FDA's §820.7 provides reading-room access at FDA and identifies where to buy the
standard; neither grants us redistribution rights. **Get legal review on the
incorporation-by-reference angle before shipping to a paying customer.**

## Public-domain sources we do ingest

US Government works, no licensing restriction:

- **21 CFR Part 820** — eCFR versioner API, date-addressable, so we hold both
  the legacy QSR (which still governs historical records and every historical
  483 citation) and the current QMSR.
- **FDA Inspectional Observation data** ("Turbo EIR" frequency-of-citation
  spreadsheets, FY2008 onward) — citation, the canonical deficiency sentence FDA
  writes, and how often it was cited.
- **Design Control Guidance for Medical Device Manufacturers** (FDA, 1997).
  Still the best plain-English statement of FDA's design-control expectations,
  and it survives QMSR conceptually even though §820.30 is now reserved.
- **FDA guidance documents** generally, including the 2025 AI-Enabled Device
  Software Functions guidance.
- **Federal Register** rule text and preambles, including the QMSR final rule —
  the preamble is the agency's own reasoning on the 820 ↔ 13485 mapping.

## Sources deliberately not used

- **OpenRegulatory QMS templates** (`github.com/openregulatory/templates`) are
  **CC BY-NC-SA 4.0**. The NonCommercial term bars shipping them inside a
  commercial product and ShareAlike would viralize derivatives. Fine to read for
  orientation; do not copy into `packages/eval/fixtures` or anywhere else in the
  tree. Our fixtures are hand-authored.
- **Commercial 483/warning-letter aggregators** (fdazilla and similar) — their
  compilations are not redistributable.

## Customer content

Uploaded SOPs and records are the customer's confidential property. They live
under `data/` (gitignored), never enter version control, and only extracted text
is sent to the model API. Do not add fixtures derived from real customer
documents, even redacted ones, without a written agreement.
