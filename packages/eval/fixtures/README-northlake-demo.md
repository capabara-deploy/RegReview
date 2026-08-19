# Northlake / VP-400 Demo Corpus

A coherent, cross-referencing set of 23 synthetic medical-device quality records
for a fictional company, **Northlake Medical Systems**, and its **VP-400**
volumetric infusion pump. Built for customer demos and as labeled eval fixtures.

**All content is hand-authored.** Nothing is copied from ISO, OpenRegulatory
(CC BY-NC-SA), or any vendor template. The FDA Form 483 is synthetic and
reproduces no real observation. See `NOTICE.md` and
`docs/roadmap/demo-corpus-facts.md` (the canonical fact ledger).

## Upload order and record type

Upload in this order so cross-references resolve. Set the record type shown
(the SOPs are loaded via `npm run sop --applies-to <type>`, not as records).

**Cleared baseline & procedures (load first)**
- `k192214-510k-summary.md` — the cleared baseline (type: unknown)
- `qsp-0021-risk-management.md` — SOP, applies-to: risk_analysis
- `qsp-0015-change-control.md` — SOP, applies-to: change_package
- `qsp-0008-complaint-handling.md` — SOP, applies-to: complaint
- `qsp-0025-production-controls.md` — SOP (Good Manufacturing Practice / 21 CFR 820 Subpart G), applies-to: change_package
- `sop-qsp-0012-capa.md` — SOP, applies-to: capa *(existing)*

**Design History File**
- `dir-0400-design-inputs.md` (design_input)
- `dos-0400-design-outputs.md` (design_output)
- `dr-vp400-07-design-review.md` (design_review)
- `ver-2026-014-occlusion-verification.md` (verification)
- `val-vp400-03-human-factors.md` (validation)
- `tm-vp400-traceability.md` (traceability_matrix)
- `ifu-vp400-instructions.md` (unknown)

**Risk management**
- `rmp-vp400-risk-plan.md` (risk_analysis)
- `rmf-vp400-risk-management.md` (risk_analysis) *(existing)*
- `fmea-vp400-infusion.md` (risk_analysis) *(existing)*
- `ra-sp200-syringe.md` (risk_analysis) — sibling device

**Post-market & change**
- `comp-2026-0207-vasoactive.md` (complaint)
- `capa-001-infusion-pump-alarm.md` — CAPA-2026-0142 (capa) *(existing)*
- `capa-2026-0114-occlusion-annunciation.md` (capa)
- `dco-2026-0031-chamfer.md` (change_package)
- `dco-2025-0077-transducer.md` (change_package)
- `ca-2026-011-firmware-ltf.md` (change_package)
- `fda-483-2026.md` (unknown)

## Planted-defect map (what to show a customer)

Each is deliberate. IDs match `docs/roadmap/demo-corpus-blueprint.md`.

| PD | Kind | Spans | The defect |
|---|---|---|---|
| 01 | consistency | CAPA-0142, FMEA | occlusion-alarm severity 3 vs 4 |
| 02 | consistency | CAPA-0142 vs RMP/RMF/FMEA | acceptability threshold 20 vs 15 |
| 03 | consistency | CAPA-0142, FMEA | affected units 35k vs 41k |
| 04 | consistency | CAPA/FMEA vs RMF/VER | app sw v3.2.1 vs safety fw v4.2 conflated |
| 05 | plausibility | CAPA-0142, K192214 | software "ruled out" by assertion |
| 06 | conformance | CAPA-0142, DCO-0031 | change to new production only, no field disposition |
| 07 | completeness | CAPA-0142 | effectiveness verified by action done, not failure-rate change |
| 08 | completeness | CAPA-0142, IFU | closed with an open IFU action |
| 09 | compliance | COMP-0207, CAPA-0142 | no reportability determination on a harm event |
| 11 | completeness | RMF | risk review (03-18) postdates release (03-02) |
| 12 | plausibility | RMF | HAZ-03 residual 20 > threshold, still "acceptable", no benefit-risk |
| 13 | completeness | FMEA, TM | RC-118 control unrealized in the traceability matrix |
| 14 | compliance | CAPA-0114, FMEA, RMF, 483 | stale risk file — 6/40 finding not fed back |
| 15 | compliance | CA-011, K192214 | letter-to-file compares to internal rev, not cleared K-number (cumulative) |
| 16 | compliance | DCO-0077, RA-SP200 | shared-board change not propagated to sibling device |
| 17 | plausibility | RMF | information-for-safety used before design/protective controls |
| 18 | consistency | COMP-0207, CAPA-0142 | determined cause disagrees (device path vs operator error) |
| 19 | completeness | DR-07, DIR, VER | design declared complete over open input DI-114 |

## Cumulative-risk narrative (Ben Cass's ask)

`ca-2026-011-firmware-ltf.md` plus the two DCOs and the 510(k) baseline tell the
"individually benign, collectively significant" story: six letter-to-file changes
since the 2019 clearance, five touching occlusion detection, the last (firmware
v4.2) adding a *risk control* yet filed as non-significant, and the whole ledger
compared against the wrong baseline (internal v4.1, not the cleared K192214). See
the fact ledger for the full six-change sequence.
