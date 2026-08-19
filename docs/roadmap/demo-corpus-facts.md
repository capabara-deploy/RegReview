# Demo Corpus — Canonical Fact Ledger (Northlake / VP-400)

The single source of truth every demo document is authored against. Where a
document **deviates** from a canonical value, that deviation is a *planted
defect* (PD-xx) and is listed as such — it must be reproduced exactly, because
the deterministic consistency pass only fires when the surrounding values agree
and the planted one disagrees.

Nothing here is copied from ISO, OpenRegulatory, or any vendor template. All
hand-authored. See NOTICE.md.

## Company, device, people

- **Northlake Medical Systems, Inc.** (fictional). Makes the **V-Series** infusion platform.
- **VP-400** — large-volume volumetric infusion pump. Class II, product code **FRN**. Cleared under **510(k) K192214** in 2019 — the "original device" baseline for change comparison.
- **SP-200** — sibling syringe pump on the same platform. Shares the **PCA-4400** pump-control board, the pressure-sensing / occlusion-detection signal chain, the alarm module, and the Li-ion battery.
- Application software: **3.x line**, cleared at **v3.1.4**, field-current **v3.2.1**.
- Safety-controller firmware (independent): **4.x line**, **v4.1 → v4.2**.
- Distributed base: **~41,000** units (canonical, per FMEA). *CAPA-2026-0142 says ~35,000 — that disagreement is PD-03.*

People (author/approver names, kept consistent across documents):
- **J. Mercer** — Field Quality
- **T. Alvarez** — Quality Manager (CAPA-0142 approver)
- **L. Marchetti** — Systems Engineering
- **S. Okafor** — Quality Manager (RMF approver)
- **R. Duval** — Regulatory Affairs
- **K. Sethi** — Design Engineering
- **P. Nowak** — Medical Safety Officer

## Canonical shared values (most documents agree on these)

| Fact | Canonical value | Documents that deviate (planted defect) |
|---|---|---|
| Risk acceptability threshold | **15** (RMP, RMF, FMEA) | CAPA-2026-0142 uses **20** → PD-02 |
| FM-201 occlusion-alarm severity | **4 (Serious)** (FMEA) | CAPA-2026-0142 uses **3 (Minor)** → PD-01 |
| Affected/distributed units | **~41,000** (FMEA) | CAPA-2026-0142 says **~35,000** → PD-03 |
| What changed the alarm behavior | app software **v3.2.1** (CAPA, FMEA) | RMF/VER attribute it to safety firmware **v4.2** → PD-04 (identity conflation) |
| Occlusion-alarm cause | signal-chain / firmware (complaint points here) | CAPA-2026-0142 concludes **operator seating error** → PD-05, PD-18 |
| Severity/occurrence/detection scale | **1–5** (5 = catastrophic) | — |

## Key dated events (one timeline all documents obey)

- **2019** — VP-400 cleared, K192214, app software v3.1.4.
- **2021** — app sw v3.1.4 → v3.2.1, occlusion pressure-threshold "tuned." Letter-to-file (LTF).
- **2022** — Li-ion cell supplier change, "equivalent capacity." LTF.
- **2023** — cassette elastomer durometer change (DCO-2023-0044). LTF.
- **2024** — cassette-channel chamfer added = **RC-118 = DCO-2026-0031** (CAPA-0142 corrective action), new production only.
- **2025** — pressure transducer substitution on shared PCA-4400 = **DCO-2025-0077**, obsolescence-driven.
- **2025-12-15** — **CAPA-2026-0114** closed (occlusion alarm failed to annunciate, **6 of 40** bench reproductions).
- **2026-01-22** — **FMEA-VP400 Rev 11**.
- **2026-02-11** — CAPA-2026-0142 opened; risk review meeting confirming threshold 15.
- **2026-03-02** — VP-400 commercial release (of the firmware-4.2 configuration).
- **2026-03-18** — **RMF-VP400 Rev 4** review date (postdates release → PD-11).
- **2026-03-20** — chamfer tooling change implemented (new production only → PD-06).
- **2026-04-03** — CAPA-2026-0142 closed (with open IFU action + effectiveness window not elapsed → PD-07, PD-08).
- **2026** — safety firmware v4.1 → v4.2, adds secondary pressure check = the HAZ-01 control. Filed as LTF via **CA-2026-011** (→ PD-15).

## RC / hazard identifiers (stable across documents)

- **FM-201** — spurious occlusion alarm causing infusion interruption (FMEA). S4/O3/D2, index 24.
- **FM-202** — failure to detect true occlusion. S5/O2/D3, index 30.
- **FM-203** — cassette seating not detected (free-flow). S5/O2/D2, index 20.
- **RC-118** — cassette-channel geometry revision (the chamfer) = DCO-2026-0031. Listed as FM-201's control; **unrealized in the traceability matrix** → PD-13.
- **HAZ-01** — over-infusion via occlusion-sensor drift. Control = firmware v4.2 secondary pressure check.
- **HAZ-02** — free-flow on cassette removal. Control = IFU §4.3 warning (information-for-safety only → PD-17).
- **HAZ-03** — keypad transposition tenfold overdose. Residual **20**, above threshold, still called acceptable → PD-12; soft-limit control only → PD-17.
- **HAZ-04** — air-in-line not detected.
- **HAZ-05** — battery depletion during transport.

## The six cumulative changes (CA-2026-011 ledger, Ben's demo)

All since K192214, all LTF'd, five of six touch occlusion detection:

1. 2021 — sw v3.1.4→v3.2.1, occlusion threshold tuned (software flowchart Q2).
2. 2022 — Li-ion cell supplier change.
3. 2023 — cassette elastomer durometer (DCO-2023-0044).
4. 2024 — cassette-channel chamfer (DCO-2026-0031), **new production only, no field disposition** (PD-06).
5. 2025 — pressure transducer substitution on shared PCA-4400 (DCO-2025-0077), **not propagated to SP-200** (PD-16).
6. 2026 — safety firmware v4.1→v4.2, **adds a risk control** yet filed non-significant (software flowchart Q3b).

**GP7 error (PD-15):** CA-2026-011's Appendix-B table compares v4.2 against the last *internal* revision (v4.1 / DOS Rev F), not the *cleared* baseline **K192214**. And no aggregate assessment of the five subsystem-touching changes exists (GP6). The tool flags the comparator mismatch and the missing aggregate — it never issues a submit / don't-submit verdict (that is statutorily the manufacturer's).

## Document IDs and record types (23)

| Doc ID | recordType (upload) | Note |
|---|---|---|
| K192214 | (unknown) | 510(k) summary, cleared baseline |
| DIR-0400 | design_input | product requirements; DI-114 occlusion response time left TBD → PD-19 |
| DOS-0400 | design_output | DMR index; Rev G |
| DR-VP400-07 | design_review | phase-gate minutes; declares complete over open DI-114 → PD-19 |
| VER-2026-014 | verification | occlusion alarm verification |
| VAL-VP400-03 | validation | summative human-factors |
| TM-VP400 | traceability_matrix | no row realizing RC-118 → PD-13 |
| RMP-VP400 | risk_analysis | risk mgmt plan, threshold 15 |
| RMF-VP400 | risk_analysis | **exists** (Rev 4) |
| FMEA-VP400 | risk_analysis | **exists** (Rev 11) |
| IFU-VP400 | (unknown) | instructions for use, Rev 7 |
| COMP-2026-0207 | complaint | vasoactive event, no reportability determination → PD-09 |
| CAPA-2026-0142 | capa | **exists** (Rev 2) |
| CAPA-2026-0114 | capa | occlusion failure-to-annunciate |
| DCO-2026-0031 | change_package | cassette chamfer ECO |
| DCO-2025-0077 | change_package | transducer substitution ECO |
| CA-2026-011 | change_package | letter-to-file / cumulative memo |
| FDA-483-2026 | (unknown) | Form 483 observations |
| RA-SP200 | risk_analysis | sibling device risk, stale transducer |
| QSP-0012 | (unknown) | **exists** — CAPA procedure |
| QSP-0008 | (unknown) | complaint handling / MDR |
| QSP-0021 | (unknown) | risk management framework |
| QSP-0015 | (unknown) | engineering change control |
