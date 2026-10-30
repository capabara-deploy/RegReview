import { useEffect, useRef, useState } from "react";
import { api, type DocumentPreview, type PreviewSheet, type RecordSummary } from "./api";

/**
 * A look at the document itself, beside the list on the run page.
 *
 * For recognising a document before spending money on it — the right FMEA, the
 * current revision, the whole file and not a stub — not for reading findings
 * (that is the findings page, on the extracted text every highlight indexes
 * into). So it shows the original as faithfully as each format allows, in one
 * consistent page view: PDFs drawn page by page, Word, Markdown and text as
 * formatted pages, spreadsheets as a grid.
 */

/** Rendered page width in CSS pixels — the same measure as the HTML page below. */
const PAGE_WIDTH = 780;

const STATUS_LABEL: Record<string, string> = {
  partial: "partly read",
  unreadable: "not readable",
};

/**
 * Page wrapper for converted HTML (Word, Markdown, plain text), rendered in a
 * frame with scripts disabled. Styled to match the PDF pages: a white sheet on
 * the same grey desk.
 */
function pageDocument(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html { background: #e9e9e4; }
    body { box-sizing: border-box; max-width: ${PAGE_WIDTH}px; margin: 16px auto; padding: 56px 64px;
      background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.15);
      font: 14px/1.5 Calibri, "Segoe UI", Arial, sans-serif; color: #1c1c1a; }
    table { border-collapse: collapse; margin: 8px 0; }
    td, th { border: 1px solid #bbb; padding: 4px 6px; vertical-align: top; text-align: left; }
    th { background: #f4f4f0; }
    img { max-width: 100%; height: auto; }
    h1 { font-size: 20px; } h2 { font-size: 17px; } h3 { font-size: 15px; }
    hr { border: 0; border-top: 1px solid #ddd; margin: 18px 0; }
    code { font: 12.5px ui-monospace, Consolas, monospace; background: #f4f4f0; padding: 0 3px; }
    pre.plain { margin: 0; font: inherit; white-space: pre-wrap; word-break: break-word; }
  </style></head><body>${body}</body></html>`;
}

function SheetGrid({ sheet }: { sheet: PreviewSheet }) {
  return (
    <div className="pv-gridwrap">
      <table className="pv-grid">
        <thead>
          <tr>
            <th className="pv-corner" />
            {sheet.columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sheet.rows.map((r) => (
            <tr key={r.rowNumber}>
              <th>{r.rowNumber}</th>
              {sheet.columns.map((c) => {
                const v = r.cells[c];
                return (
                  <td key={c} className={v?.startsWith("=") ? "pv-formula" : undefined}>
                    {v ?? ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {sheet.rows.length === 0 && <p className="muted pv-pad">This sheet is empty.</p>}
      {sheet.truncatedRows > 0 && (
        <p className="muted small pv-pad">
          Showing the first {sheet.rows.length} rows. {sheet.truncatedRows} more are not shown here.
        </p>
      )}
    </div>
  );
}

function Sheets({ sheets }: { sheets: PreviewSheet[] }) {
  const [active, setActive] = useState(0);
  const sheet = sheets[active];
  return (
    <div className="pv-sheets">
      <div className="pv-tabs" role="tablist">
        {sheets.map((s, i) => (
          <button
            key={s.name}
            role="tab"
            aria-selected={i === active}
            className={`pv-tab ${i === active ? "on" : ""} ${s.hidden ? "hidden-sheet" : ""}`}
            title={s.hidden ? "Hidden in the workbook" : undefined}
            onClick={() => setActive(i)}
          >
            {s.name}
            {s.hidden && <span className="pv-tag">hidden</span>}
          </button>
        ))}
      </div>
      {sheet ? <SheetGrid sheet={sheet} /> : <p className="muted pv-pad">This workbook has no readable sheets.</p>}
    </div>
  );
}

/**
 * A PDF drawn page by page with pdf.js, in the same page view as every other
 * format, rather than inside the browser's viewer chrome. pdf.js is imported
 * on first use, so the app doesn't load it until someone opens a PDF.
 */
function PdfPages({ recordId }: { recordId: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<string | null>("Loading…");

  useEffect(() => {
    let cancelled = false;
    let destroy: (() => void) | undefined;
    const host = container.current;
    if (!host) return;
    host.replaceChildren();
    setStatus("Loading…");

    (async () => {
      const [pdfjs, worker, bytes] = await Promise.all([
        import("pdfjs-dist"),
        import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
        api.pdfBytes(recordId),
      ]);
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
      destroy = () => void doc.destroy();
      if (cancelled) return destroy();
      setStatus(null);

      // Drawn one page at a time, in order, so the first page appears at once
      // on a long document instead of after all of them.
      const ratio = window.devicePixelRatio || 1;
      for (let n = 1; n <= doc.numPages && !cancelled; n++) {
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: (PAGE_WIDTH / base.width) * ratio });
        const canvas = document.createElement("canvas");
        canvas.className = "pv-page";
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.setAttribute("aria-label", `Page ${n} of ${doc.numPages}`);
        host.appendChild(canvas);
        await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
      }
    })().catch((e: Error) => !cancelled && setStatus(e.message));

    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [recordId]);

  return (
    <div className="pv-pages">
      {status && <p className="muted pv-pad">{status}</p>}
      <div ref={container} className="pv-pagestack" />
    </div>
  );
}

export function PreviewPanel({ record, onClose }: { record: RecordSummary; onClose: () => void }) {
  // Keyed by the record it was loaded for. Switching documents renders one
  // pass before the effect below clears state, and without the key that pass
  // pairs the new record with the previous preview — a PDF viewer fetching a
  // spreadsheet's bytes, say.
  const [loaded, setLoaded] = useState<{ recordId: string; preview: DocumentPreview } | null>(null);
  const preview = loaded?.recordId === record.recordId ? loaded.preview : null;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    api
      .preview(record.recordId)
      .then((p) => alive && setLoaded({ recordId: record.recordId, preview: p }))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [record.recordId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title = record.docId ?? record.filename;

  return (
    <aside className="preview-panel" aria-label={`Preview of ${title}`}>
      <div className="pv-head">
        <div className="pv-title">
          <strong>{title}</strong>
          <span className="muted small">
            {record.filename}
            {record.revision ? ` · Rev ${record.revision}` : ""}
            {record.format ? ` · ${record.format.toUpperCase()}` : ""}
          </span>
          {record.description && <span className="pv-desc">{record.description.summary}</span>}
        </div>
        {record.coverageStatus && STATUS_LABEL[record.coverageStatus] && (
          <span
            className={`docrow-cov cov-${record.coverageStatus}`}
            title="Some of this document could not be read for review. Its findings page lists what was missed."
          >
            {STATUS_LABEL[record.coverageStatus]}
          </span>
        )}
        <button className="close" onClick={onClose} aria-label="Close preview">
          ×
        </button>
      </div>

      <div className="pv-body">
        {error && <div className="error">{error}</div>}
        {!error && !preview && <p className="muted pv-pad">Loading…</p>}
        {preview?.kind === "pdf" && <PdfPages recordId={record.recordId} />}
        {preview?.kind === "html" && (
          // Sandboxed without allow-scripts: the HTML is converted from a
          // customer's file and is shown, never run — no scripts, no forms,
          // no navigating this page. allow-same-origin is there only because a
          // fully opaque-origin frame was observed not to paint in an embedded
          // Chromium; with scripts disabled it grants the content nothing.
          <iframe
            className="pv-frame"
            sandbox="allow-same-origin"
            srcDoc={pageDocument(preview.html)}
            title={title}
          />
        )}
        {preview?.kind === "sheets" && <Sheets sheets={preview.sheets} />}
      </div>
    </aside>
  );
}
