# Design FMEA — VP-400 Volumetric Infusion Pump

**Document No.:** FMEA-VP400
**Rev:** 11
**Date:** 2026-01-22
**Scale:** Severity 1–5 (5 = catastrophic), Occurrence 1–5, Detection 1–5
**Acceptability threshold:** Risk index 15

---

## 2. Fluid Delivery Subsystem — Pressure Sensing

| ID | Failure Mode | Effect | S | O | D | RPN |
|----|--------------|--------|---|---|---|-----|
| FM-201 | Spurious occlusion alarm causing infusion interruption | Therapy interrupted; possible haemodynamic instability where infusion is vasoactive | 4 | 3 | 2 | 24 |
| FM-202 | Failure to detect true occlusion | Under-infusion undetected | 5 | 2 | 3 | 30 |
| FM-203 | Cassette seating not detected | Free-flow risk | 5 | 2 | 2 | 20 |

### 2.1 Notes on FM-201

Severity for FM-201 was set at **4 (Serious)** on the basis that an interruption
to a vasoactive infusion can produce a clinically significant haemodynamic
response before staff intervene. The rating was reviewed following the 2025-08
hazard analysis update and was not reduced.

Detection is rated 2 on the basis of audible and visual annunciation.

The affected configuration is software version 3.2.1 and later, across
approximately 41,000 distributed units.

## 3. Risk Acceptability

Any failure mode with a risk index above 15 requires risk control measures and
may not be accepted on the basis of annunciation alone.

FM-201 at index 24 exceeds the threshold and carries an open risk control action
(RC-118, cassette channel geometry revision).
