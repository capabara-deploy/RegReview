import { useState } from "react";
import type { Coverage, CoverageGap, RecordDetail } from "./api";

/**
 * What extraction read from this document, and what it could not.
 *
 * Sits between the run's provenance and the findings, because that is where a
 * reviewer decides how much a short finding list means. A list of three
 * findings on a document whose last four pages were scans is not a three-finding
 * document, and nothing else on the page says so.
 *
 * Styled deliberately unlike a finding — no severity colours, a "not read"
 * label in words — for the same reason the map's record issues are: a coverage
 * gap is a fact about what the tool saw, not a defect in the document.
 */

const UNIT: Record<Coverage["units"]["kind"], [string, string]> = {
  page: ["page", "pages"],
  sheet: ["sheet", "sheets"],
  document: ["document", "documents"],
};

function unitsLine(c: Coverage): string {
  const [one, many] = UNIT[c.units.kind];
  if (c.units.kind === "document") return c.format.toUpperCase();
  return `${c.units.read} of ${c.units.total} ${c.units.total === 1 ? one : many} read · ${c.format.toUpperCase()}`;
}

function GapLine({ gap }: { gap: CoverageGap }) {
  return (
    <li>
      {gap.where && <code className="cov-where">{gap.where}</code>} {gap.detail}
    </li>
  );
}

export function CoverageStrip({ coverage }: { coverage: Coverage | null }) {
  const [showNotes, setShowNotes] = useState(false);

  // Records extracted before coverage existed. Say so rather than show nothing,
  // since nothing is what "fully read" also looks like.
  if (!coverage) {
    return (
      <div className="coverage cov-unknown">
        <div className="cov-head">
          <span className="cov-label">Coverage unknown</span>
          <span className="cov-sub">
            We can't tell how much of this document was read, because its original file is no longer
            available. Replace the file to check.
          </span>
        </div>
      </div>
    );
  }

  const gaps = coverage.gaps.filter((g) => g.level === "gap");
  const notes = coverage.gaps.filter((g) => g.level === "note");
  const label =
    coverage.status === "unreadable"
      ? "Not readable"
      : coverage.status === "partial"
        ? "Partly read"
        : "Read in full";

  return (
    <div className={`coverage cov-${coverage.status}`}>
      <div className="cov-head">
        <span className="cov-label">{label}</span>
        <span className="cov-sub">{unitsLine(coverage)}</span>
        {coverage.status !== "complete" && (
          <span className="cov-sub">
            {coverage.status === "unreadable"
              ? "Almost no text could be extracted — an empty review of this document is not a clean one."
              : "Findings cannot cover what was not read."}
          </span>
        )}
        {notes.length > 0 && (
          <button className="link cov-toggle" onClick={() => setShowNotes((v) => !v)}>
            {showNotes ? "Hide" : "Show"} {notes.length} note{notes.length === 1 ? "" : "s"} on how it was read
          </button>
        )}
      </div>
      {gaps.length > 0 && (
        <ul className="cov-list">
          {gaps.map((g, i) => (
            <GapLine key={`g${i}`} gap={g} />
          ))}
        </ul>
      )}
      {showNotes && (
        <ul className="cov-list cov-notes">
          {notes.map((g, i) => (
            <GapLine key={`n${i}`} gap={g} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Where a finding sits, in the document's own terms: the cell for a
 * spreadsheet ("FMEA!D7"), else nothing — prose formats are located by the
 * highlight itself. Resolved from the block's cell offsets, so it is the cell
 * the quoted text actually came from, not a guess from the row.
 */
export function findingLocation(record: RecordDetail, finding: { blockId: string; charStart: number; charEnd: number }): string | null {
  const block = record.blocks.find((b) => b.blockId === finding.blockId);
  if (!block?.anchor) return null;
  const cells = (block.cells ?? []).filter((c) => finding.charStart < c.charEnd && c.charStart < finding.charEnd);
  if (cells.length === 1) return cells[0]!.ref;
  if (cells.length > 1) {
    const [sheet] = cells[0]!.ref.split("!");
    return `${sheet}!${cells[0]!.ref.split("!")[1]}:${cells[cells.length - 1]!.ref.split("!")[1]}`;
  }
  return block.anchor;
}
