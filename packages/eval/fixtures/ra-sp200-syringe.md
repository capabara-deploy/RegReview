# Risk Analysis — SP-200 Syringe Pump (Shared Subsystems)

**Document No.:** RA-SP200
**Rev:** 1
**Date:** 2024-11-20
**Prepared by:** L. Marchetti, Systems Engineering
**Approved by:** S. Okafor, Quality Manager
**Applicable standard:** ISO 14971:2019

---

## 1. Scope

The SP-200 is a syringe infusion pump built on the Northlake V-Series platform. It
shares the PCA-4400 pump-control board, the pressure-sensing and occlusion-detection
signal chain, the alarm module, and the Li-ion battery subsystem with the VP-400
volumetric infusion pump. This analysis covers hazards arising from the shared
subsystems as implemented in the SP-200.

## 2. Acceptability Criteria

Risk acceptability is evaluated against the platform risk management plan. Risks
scoring 15 or above require control.

## 3. Pressure-Sensing / Occlusion Detection

Downstream occlusion is detected by the pressure transducer on the PCA-4400 board.
The occlusion-detection performance characterized for this analysis is that of the
originally qualified pressure transducer.

| Hazard | Severity | Probability | Score | Control |
|---|---|---|---|---|
| SP-HAZ-01 — Failure to detect occlusion | 5 | 2 | 10 | Independent pressure monitoring on safety controller |
| SP-HAZ-02 — Spurious occlusion alarm | 4 | 2 | 8 | Alarm annunciation; operator response |

## 4. Shared-Component Note

Changes to shared V-Series subsystems — the PCA-4400 board, the pressure transducer,
the alarm module, or the battery — are assessed for their effect on the SP-200 under
the change-control procedure. The pressure transducer characterized in this analysis
is the originally qualified part.

## 5. Residual Risk

All shared-subsystem residual risks in Section 3 fall below the acceptability
threshold. Overall residual risk for the shared subsystems is acceptable.

---

*This analysis reflects the SP-200 configuration as of 2024-11. Component changes
after this date are tracked through engineering change control.*
