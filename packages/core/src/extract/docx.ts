import { strFromU8, unzipSync } from "fflate";
import type { CoverageGap } from "../types.js";

/**
 * What a .docx holds beyond the body text mammoth reads.
 *
 * mammoth's raw-text extraction is the right reader for the body (see
 * extract/index.ts), but it silently skips everything else a Word file can
 * carry — and in quality records "everything else" is where things hide: the
 * document number and revision in the page header, a photo of the failed part,
 * an embedded Excel risk table, reviewer comments, unaccepted tracked changes.
 *
 * Page headers and footers are cheap to read and often hold the record's own
 * id, so their text is returned for the caller to include. The rest is reported
 * as coverage gaps rather than read.
 */
export interface DocxInspection {
  /** Distinct header/footer paragraphs, in part order. */
  headerFooterText: string[];
  gaps: CoverageGap[];
}

function paragraphs(xml: string): string[] {
  return [...xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)]
    .map((p) =>
      [...p[0].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
        .map((t) => t[1] ?? "")
        .join("")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&")
        .trim(),
    )
    .filter((t) => t !== "");
}

export function inspectDocx(bytes: Uint8Array): DocxInspection {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    // mammoth will produce the real error for a damaged file.
    return { headerFooterText: [], gaps: [] };
  }
  const names = Object.keys(files);
  const text = (name: string): string => strFromU8(files[name]!);
  const gaps: CoverageGap[] = [];

  const headerFooterText: string[] = [];
  for (const name of names.filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n)).sort()) {
    for (const p of paragraphs(text(name))) {
      if (!headerFooterText.includes(p)) headerFooterText.push(p);
    }
  }

  const images = names.filter((n) => n.startsWith("word/media/")).length;
  if (images > 0) {
    gaps.push({
      kind: "images",
      level: "gap",
      where: null,
      detail:
        `${images} image(s) not read — photos, diagrams, scanned signatures or pictures of tables. ` +
        "Any text or evidence inside them is not part of the review.",
    });
  }

  const embedded = names.filter((n) => n.startsWith("word/embeddings/")).length;
  if (embedded > 0) {
    gaps.push({
      kind: "embedded_objects",
      level: "gap",
      where: null,
      detail: `${embedded} embedded object(s) not read (for example an Excel table pasted as an object). Upload the original separately.`,
    });
  }

  if (names.some((n) => n.startsWith("word/charts/"))) {
    gaps.push({ kind: "charts", level: "gap", where: null, detail: "Charts were not read." });
  }

  if (files["word/comments.xml"]) {
    const n = (text("word/comments.xml").match(/<w:comment\b/g) ?? []).length;
    if (n > 0) {
      gaps.push({ kind: "comments", level: "gap", where: null, detail: `${n} reviewer comment(s) were not read.` });
    }
  }

  if (files["word/document.xml"]) {
    const body = text("word/document.xml");
    const insertions = (body.match(/<w:ins\b/g) ?? []).length;
    const deletions = (body.match(/<w:del\b/g) ?? []).length;
    if (insertions + deletions > 0) {
      gaps.push({
        kind: "tracked_changes",
        level: "gap",
        where: null,
        detail:
          `Has ${insertions + deletions} unaccepted tracked change(s); it was read as if all of them were accepted. ` +
          "A document with pending changes is not the approved version.",
      });
    }
  }

  if (headerFooterText.length > 0) {
    gaps.push({
      kind: "headers_footers",
      level: "note",
      where: null,
      detail: "Page header and footer text was read and placed at the top of the document.",
    });
  }

  return { headerFooterText, gaps };
}
