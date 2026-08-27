# VP-400 Design & Risk Traceability Matrix

**Document No.:** TM-VP400
**Rev:** 9
**Date:** 2026-01-15
**Owner:** K. Sethi, Design Engineering

---

## 1. Purpose

This matrix traces each design input to its design output and verification, and
each hazard to its risk control and the verification of that control. Source
documents: DIR-0400, DOS-0400, VER-2026-014, VAL-VP400-03, FMEA-VP400, RMF-VP400.

## 2. Design Input → Output → Verification

| Design Input | Design Output | Verification |
|---|---|---|
| DI-011 delivery rate | DO-011 app sw v3.2.1 | Delivery-accuracy test (passed) |
| DI-101 occlusion alarm | DO-101 occlusion logic | VER-2026-014 (pass) |
| DI-102 threshold configurable | DO-101 occlusion logic | VER-2026-014 (pass) |
| DI-114 alarm response time | DO-114 firmware v4.2 | *(no verification — requirement TBD)* |
| DI-202 air-in-line | DO-201 board | Air-in-line test (passed) |
| DI-302 roller-clamp warning | DO-301 IFU §4.3 | VAL-VP400-03 |

## 3. Hazard → Risk Control → Verification

| Hazard (RMF/FMEA) | Risk Control | Verification |
|---|---|---|
| HAZ-01 occlusion-sensor drift | Firmware v4.2 secondary check | VER-2026-014 (pass) |
| HAZ-02 free-flow on cassette removal | IFU §4.3 warning | VAL-VP400-03 |
| HAZ-03 keypad transposition | Pharmacy soft limits | Configuration confirmed |
| FM-202 failure to detect occlusion | Firmware v4.2 | VER-2026-014 |

---

*This matrix reflects the traceable design and risk controls of record. Controls
introduced through corrective action are added on the next scheduled revision.*
