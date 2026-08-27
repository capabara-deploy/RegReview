# VP-400 Occlusion Alarm Verification Report

**Document No.:** VER-2026-014
**Rev:** 1
**Date:** 2026-01-10
**Author:** K. Sethi, Design Engineering

---

## 1. Purpose

This report documents verification of the occlusion-alarm behavior of the VP-400
following the introduction of safety-controller firmware v4.2. It verifies design
output DO-114 against the occlusion-detection design inputs.

## 2. Test Configuration

Units under test ran safety-controller firmware **v4.2**. A controlled downstream
occlusion was applied and the alarm annunciation was recorded.

## 3. Results

| Test | Requirement | Result |
|---|---|---|
| Occlusion detected and annunciated | Alarm on applied occlusion (DI-101) | Pass — all units annunciated |
| Secondary pressure check active | Independent second check present | Pass |
| Alarm response time | DI-114 (response-time requirement TBD) | Not evaluated — requirement not finalized |

## 4. Conclusion

The occlusion alarm annunciated in all units tested under firmware v4.2. The
alarm-response-time input DI-114 was not evaluated because the requirement value
was not finalized at the time of test.

---

*This verification supports the risk control credited for HAZ-01 in RMF-VP400 and
the effectiveness verification for CAPA-2026-0114.*
