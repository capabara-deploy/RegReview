# Corrective and Preventive Action Record

**Record No.:** CAPA-2026-0142
**Rev:** 2
**Title:** Increase in "Occlusion Detected" alarms — Model VP-400 volumetric infusion pump
**Originator:** J. Mercer, Field Quality
**Date Opened:** 2026-02-11
**Date Closed:** 2026-04-03
**Owner:** Manufacturing Engineering

---

## 1. Problem Statement

Between 2025-11 and 2026-01, Field Service logged a rise in complaints reporting
spurious "Occlusion Detected" alarms on the VP-400 infusion pump. Complaint volume
increased from a trailing average of 4 per month to 19 in January 2026. In 3 of the
reported events, infusion was interrupted for a period exceeding 10 minutes before
clinical staff intervened. One event involved a patient receiving a vasoactive
infusion; the site reported a transient drop in blood pressure requiring
intervention by the care team. No permanent injury was reported by the site.

Affected population: VP-400 units in the field, software version 3.2.1 and later.
Approximately 35,000 units are installed.

## 2. Containment

On 2026-02-14 a Field Advisory Notice was issued to all affected accounts
instructing staff to verify tubing seating before restarting an interrupted
infusion. No units were removed from service.

## 3. Investigation

The pressure transducer signal chain was reviewed. Bench testing of 12 returned
units reproduced the spurious alarm in 2 units when the upstream tubing was
seated at a slight angle in the cassette channel.

The investigation team concluded that the cause was **operator error in seating
the administration set**, since the alarm could be reproduced when the tubing was
deliberately misseated.

Software was ruled out. The alarm threshold logic in v3.2.1 was not changed from
v3.1.4, and therefore was not considered further.

## 4. Risk Assessment

The failure mode "spurious occlusion alarm causing infusion interruption" was
assessed against the product risk file. Severity was rated **3 (Minor)** on the
basis that the alarm is annunciated audibly and visually and that clinical staff
are trained to respond to alarms.

Occurrence was rated 2. Detection was rated 2. Resulting risk index 12, which is
below the acceptability threshold of 20 defined in the risk management plan.

## 5. Corrective Action

A revised Instructions for Use insert was drafted emphasizing correct seating of
the administration set. The insert was released with the next scheduled labeling
update.

Additionally, the cassette channel guide was modified to include a chamfer
intended to reduce the likelihood of angled seating. The tooling change was
implemented on 2026-03-20.

## 6. Effectiveness Verification

Training on the revised IFU was delivered to 100% of field service personnel by
2026-03-27. Completion records are on file with Training.

The chamfer modification was confirmed present on 5 units sampled from the
production line on 2026-03-30. All 5 units passed final acceptance testing.

On the basis of the above, the corrective action is considered effective.

## 7. Closure

All actions complete. Complaint trend will continue to be monitored through the
routine complaint review process.

Approved for closure: 2026-04-03, T. Alvarez, Quality Manager.

---

*Note: See test data for details of the bench evaluation. Results of the risk
review were captured in the 2026-02-19 project meeting minutes.*
