# Corrective and Preventive Action Record

**Record No.:** CAPA-2026-0114
**Rev:** 3
**Title:** Occlusion alarm failure to annunciate — Model VP-400 volumetric infusion pump
**Originator:** J. Mercer, Field Quality
**Date Opened:** 2025-09-30
**Date Closed:** 2025-12-15
**Owner:** Systems Engineering

---

## 1. Problem Statement

Two field complaints in Q3 2025 reported that a VP-400 pump did not annunciate an
occlusion alarm when a downstream occlusion was present, resulting in delayed
detection of interrupted therapy. Both events involved units running safety
firmware version 4.1.

## 2. Containment

Affected accounts were advised to verify downstream patency during routine checks.
No units were removed from service.

## 3. Investigation

Forty units were subjected to a bench reproduction protocol in which a controlled
downstream occlusion was applied. The occlusion alarm **failed to annunciate in 6
of the 40 units** tested. The failures were associated with a marginal
signal-to-threshold margin in the pressure-sensing path at the low end of the
occlusion pressure range.

The investigation concluded that the annunciation reliability was inadequate under
the firmware 4.1 detection logic.

## 4. Risk Assessment

The failure mode "failure to detect true occlusion" corresponds to FMEA-VP400
FM-202. Failure to detect a true occlusion can result in undetected under-infusion
and is rated at high severity in the risk file.

## 5. Corrective Action

Safety firmware version 4.2 was specified, adding a secondary independent pressure
check to improve occlusion-detection reliability. The firmware change is tracked
separately under the change-control process.

## 6. Effectiveness Verification

The firmware 4.2 secondary pressure check was verified on the bench under the same
reproduction protocol, with the occlusion alarm annunciating in all units tested.
Verification is recorded in VER-2026-014.

## 7. Closure

Actions complete and verified. The corrective action is considered effective.

Approved for closure: 2025-12-15, S. Okafor, Quality Manager.

---

*The results of this CAPA bear on the occurrence and detection estimates for
occlusion-related failure modes in the risk management file and the design FMEA.*
