# VP-400 Design Input Requirements (Product Requirements Specification)

**Document No.:** DIR-0400
**Rev:** H
**Date:** 2025-10-30
**Owner:** K. Sethi, Design Engineering
**Predicate/basis:** 510(k) K192214

---

## 1. Purpose

This specification defines the design input requirements for the VP-400 volumetric
infusion pump. Each requirement is uniquely identified and is traceable to a design
output and to verification per the traceability matrix TM-VP400.

## 2. Delivery Requirements

- **DI-011** — The pump shall deliver at a programmed rate of 0.1 to 999 mL/hr.
- **DI-012** — Delivery accuracy shall be within ±5% over the labeled flow range.

## 3. Occlusion Detection

- **DI-101** — The device shall detect a downstream occlusion and annunciate an
  audible and visual alarm.
- **DI-102** — The occlusion pressure threshold shall be configurable within the
  range qualified in the cleared configuration.
- **DI-114** — The occlusion alarm shall annunciate within a specified maximum
  response time following the onset of a downstream occlusion. **Response-time
  requirement: TBD — to be finalized pending firmware 4.2 characterization.**

## 4. Alarms and Safety

- **DI-201** — The device shall provide independent safety-controller monitoring of
  delivery.
- **DI-202** — The device shall detect air-in-line above the specified volume and
  annunciate an alarm.

## 5. Use and Labeling

- **DI-301** — The device shall be operable by trained clinical staff per the
  Instructions for Use.
- **DI-302** — Labeling shall warn the operator to close the roller clamp before
  removing the cassette.

---

*Requirements marked TBD are open design inputs and shall be resolved and verified
before the design is declared complete.*
