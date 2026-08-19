# Change Assessment Memo (Letter-to-File) — VP-400 Safety Firmware v4.2

**Document No.:** CA-2026-011
**Rev:** 1
**Date:** 2026-02-24
**Prepared by:** K. Sethi, Design Engineering
**Reviewed by:** R. Duval, Regulatory Affairs
**Governing procedure:** QSP-0015 Engineering Change Control and Change Assessment

---

## 1. Purpose

This memo documents the assessment of a change to the VP-400 safety-controller
firmware, from version 4.1 to version 4.2, and records the determination of
whether a new 510(k) is required. Firmware v4.2 adds a secondary downstream
pressure check and revises the occlusion-alarm annunciation logic. This memo is
retained as a letter-to-file.

## 2. Description of Change

Safety firmware v4.2 introduces a second, independent pressure comparison in the
occlusion-detection path and adjusts the alarm annunciation sequence. The change
is credited in the risk management file (RMF-VP400) as the risk control for
HAZ-01 (over-infusion due to occlusion-sensor drift).

## 3. Comparison to Prior Configuration (Appendix B)

The change was compared against the immediately preceding released configuration,
safety firmware **v4.1** (design output DOS-0400 Rev F), as follows:

| Attribute | v4.1 (prior) | v4.2 (proposed) | Change? |
|---|---|---|---|
| Occlusion pressure check | single | secondary check added | Yes |
| Alarm annunciation logic | baseline | revised sequence | Yes |
| Indications for use | unchanged | unchanged | No |
| Delivery mechanism | unchanged | unchanged | No |
| Occlusion pressure threshold | as configured | as configured | No |

## 4. Change-Type Evaluation

The change is a modification to software that does not alter the indications for
use, the delivery mechanism, or the fundamental technology. Applying the software
change decision logic, the change was judged not to significantly affect safety or
effectiveness. No new 510(k) is considered necessary for this change on its own.

## 5. Related Changes

The following prior changes to the VP-400 are noted for reference: DCO-2025-0077
(pressure transducer substitution) and DCO-2026-0031 (cassette-channel geometry
revision). These were each separately documented and dispositioned. See also
CAPA-2026-0142.

## 6. Determination

No new 510(k) required for the firmware v4.2 change. Retained as letter-to-file.

Approved: 2026-02-24, R. Duval, Regulatory Affairs.

---

*Prior letters-to-file affecting the VP-400 occlusion-sensing signal chain since
the 2019 clearance are held individually in the design file. This assessment
addresses the firmware v4.2 change.*
