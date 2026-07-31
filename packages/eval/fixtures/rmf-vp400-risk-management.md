# Risk Management File — VP-400 Volumetric Infusion Pump

**Document No.:** RMF-VP400
**Rev:** 4
**Date:** 2026-03-18
**Prepared by:** L. Marchetti, Systems Engineering
**Approved by:** S. Okafor, Quality Manager
**Applicable standard:** ISO 14971:2019

---

## 1. Scope and Intended Use

The VP-400 is a volumetric infusion pump intended for the controlled delivery of
intravenous fluids and medications to adult and pediatric patients in hospital
settings. It is operated by trained clinical staff.

Use outside the labeled indications, including home use and use by untrained
operators, is outside the scope of this analysis and is addressed by labeling.

## 2. Risk Management Plan Reference

Risk management activities were conducted per RMP-VP400 Rev 2. The plan defines
a 5x5 severity/probability matrix. Risks scoring 15 or above are unacceptable
and require control; risks scoring below 15 are acceptable.

The acceptability threshold of 15 was confirmed during the risk review meeting
of 2026-02-11, following review of the estimated risk scores.

## 3. Hazard Analysis

### HAZ-01 — Over-infusion due to occlusion sensor drift

Sequence: sensor calibration drifts over service life → downstream occlusion is
not detected → pressure builds → occlusion clears suddenly → bolus delivered to
patient.

| | Severity | Probability | Score |
|---|---|---|---|
| Initial | 5 (Critical) | 3 (Occasional) | 15 |
| Residual | 3 (Moderate) | 2 (Remote) | 6 |

**Control:** Firmware release 4.2 adds a secondary pressure check and an audible
occlusion alarm.

Severity was reduced to 3 because the alarm allows clinical staff to intervene
before the full bolus is delivered.

### HAZ-02 — Under-infusion due to free-flow on cassette removal

Sequence: operator removes the cassette without closing the roller clamp →
gravity free-flow or interruption of therapy.

| | Severity | Probability | Score |
|---|---|---|---|
| Initial | 4 (Major) | 4 (Probable) | 16 |
| Residual | 4 (Major) | 2 (Remote) | 8 |

**Control:** A warning has been added to the Instructions for Use, Section 4.3,
instructing the operator to close the roller clamp before removing the cassette.
Operator training materials have been updated to reinforce this step.

### HAZ-03 — Incorrect dose entry (keypad transposition)

Sequence: operator enters 100 mL/hr instead of 10.0 mL/hr → tenfold overdose.

| | Severity | Probability | Score |
|---|---|---|---|
| Initial | 5 (Critical) | 4 (Probable) | 20 |
| Residual | 5 (Critical) | 4 (Probable) | 20 |

**Control:** Dose-limit soft alerts are configurable by the hospital pharmacy at
deployment. No further control is practicable within the current hardware
platform.

### HAZ-04 — Air-in-line not detected

Sequence: air bubble passes the ultrasonic detector below threshold volume →
cumulative air delivered to patient.

| | Severity | Probability | Score |
|---|---|---|---|
| Initial | 4 (Major) | 2 (Remote) | 8 |
| Residual | 4 (Major) | 2 (Remote) | 8 |

Probability is Remote based on the detector specification.

### HAZ-05 — Battery depletion during transport

Sequence: pump operated on battery during patient transport → battery depletes →
infusion stops without adequate warning.

| | Severity | Probability | Score |
|---|---|---|---|
| Initial | 3 (Moderate) | 3 (Occasional) | 9 |

## 4. Risk Control Verification

Firmware 4.2 occlusion alarm: verified per VER-2026-014, test passed.
IFU Section 4.3 warning: verified present in IFU Rev 7.
Dose-limit soft alerts: configuration option confirmed present in the pharmacy
setup utility.

## 5. Residual Risk

All individual residual risks listed in Section 3 fall below the acceptability
threshold defined in the risk management plan, with the exception of HAZ-03,
which remains at 20.

## 6. Risk Management Review

The risk management file was reviewed and found complete. Overall residual risk
is acceptable. Approved for commercial release.

Review date: 2026-03-18
Commercial release date: 2026-03-02

## 7. Production and Post-Production Information

Post-market data is collected through the complaint handling system per
QSP-0008. As of this revision, 31 complaints have been received relating to
occlusion alarm behavior on units running firmware 4.1 or earlier.

CAPA-2026-0114 was opened to address occlusion alarm failures and determined
that the alarm did not annunciate in 6 of 40 bench reproductions.

---

*Supporting analyses are maintained in the design file. The FMEA for the VP-400
is maintained separately by the systems engineering group.*
