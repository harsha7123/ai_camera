# Privacy, Security & Compliance

**Date:** 2026-11-20 · **Not legal advice.** State recording, biometric, employee-monitoring and privacy rules differ and change. Every legal statement below is a starting point **to confirm with employment and privacy counsel in each state** (at least PA, WV, NJ and any other deployment state) before go-live. Counsel sign-off is a pilot gate.

---

## 1. Posture in one table

| Topic | Default | Why |
|---|---|---|
| Video location | Stays on the edge appliance; NVR keeps its own recording | Minimise exposure; works offline |
| Audio | **Never recorded or analysed** | Wiretap law: Pennsylvania requires all-party consent (18 Pa.C.S. § 5701 et seq.); WV and NJ are one-party, but a single default avoids criminal exposure |
| Identity | **No face recognition, no biometric templates, no appearance re-ID** | IL BIPA (740 ILCS 14), TX CUBI (Bus. & Com. Code § 503.001), WA (RCW 19.375); ADR-003 |
| Who is "staff" | Inferred from zone/camera (staff_area, staff_only), never from a face | Same |
| Identity for payroll/POS | POS `employee_ref` and (roadmap) time-clock IDs only | Existing business records, not biometrics |
| Excluded areas | **Restrooms, changing rooms, locker areas, break rooms, guest rooms** | Privacy law (e.g. California Labor Code § 435 bars recording in restrooms, locker rooms and changing rooms) and NLRA §7 |
| Decisions | **AI flags, humans decide.** No termination, discipline, police report or pay deduction on an alert alone; a manager reviews the clip first | Playbook constraint; error rates are unvalidated |
| Retention | Routine clips 30–90 days (configurable); incident/litigation clips on legal hold | Playbook |

---

## 2. Threat model (STRIDE, restaurant and employee-monitoring)

| Asset / actor | Threat | Example | Mitigation | Status |
|---|---|---|---|---|
| Clips | **I**nformation disclosure | Manager shares a clip of an employee on social media; ex-employee keeps access | Role-gated 5-min clip tokens; first use audited; sessions end on disable/role change; no download button [design] | Built (tokens, audit, session end) |
| Clips | **T**ampering | Altered clip used in a dispute | sha256 per clip recorded at capture; hash-chained audit; clips cut from original packets | Built |
| Audit log | **R**epudiation | Owner deletes evidence of who viewed a clip | Append-only, hash-chained; `chain_ok`/`broken_at` visible to admin | Built; external anchoring **not yet** |
| Staff accounts | **S**poofing | Password guessing on the staff login | bcrypt; lock after 5 failures/user or 30/IP in 15 min (`429`) | Built; **MFA not yet** |
| Browser session | **S**poofing / CSRF | Cross-site POST disposes incidents | `SameSite=Strict` HttpOnly cookie + `Content-Type: application/json` required (`415`) | Built; **CSP not yet** |
| Internal endpoints | **S**poofing / **T**ampering | Forged observations or POS events | Loopback-only listener + bearer token; NDJSON validated | Built |
| POS connector | **E**levation / scope creep | Connector pulls card data into the appliance | POSEvent has no card fields; connector must drop them (ADR-010) | Contract built; connectors not built |
| Webhook | **I**nformation disclosure | Webhook URL (with secret) leaks into UI/logs | Errors reduced to short classes (`timeout`, `HTTP 500`), never the URL; no media in payload | Built |
| Admin | **E**levation | Admin watches clips | Admin role has no `view_clips` (separation of duties) | Built |
| Cameras | **D**enial of service / disclosure | Camera botnet; guest on Wi-Fi reaches cameras | Camera VLAN; no camera → internet; edge-only RTSP | Site guidance |
| Employees | **Misuse of the system** | Watching union discussions; using alerts to discipline | Policy controls (§6), excluded areas, audit of every view, disposition `coach`/`investigate` rather than punitive labels | Policy + audit |
| Customers | Over-collection | Tracking repeat visitors | No re-ID; traffic stored as aggregates only | Built |

---

## 3. Roles and permissions (from API.md)

| Permission | staff | manager | owner | admin |
|---|---|---|---|---|
| view_status (overview, incidents list/detail, events) | ✓ | ✓ | ✓ | ✓ |
| acknowledge | ✓ | ✓ | ✓ | ✓ |
| view_clips | | ✓ | ✓ | |
| disposition | | ✓ | ✓ | |
| view_analytics (traffic, peak hours) | | ✓ | ✓ | |
| view_access_log | | ✓ | ✓ | |
| view_shadow | | | ✓ | ✓ |
| legal_hold | | | ✓ | ✓ |
| admin (cameras, users, audit) | | | | ✓ |

Notes: staff never see clips of their colleagues. The owner should restrict `manager` accounts to people with a review duty and train them on §6.

---

## 4. Data classes

| Class | Examples | Handling |
|---|---|---|
| **Restricted** | Clips, live video, frames | Edge only; AES-256-GCM per clip; token access; every first view audited |
| **Confidential (personal)** | Incidents tied to time/place, access-log rows, POS `employee_ref`, user accounts | Edge DB; role-gated; retention per §5 |
| **Internal** | Traffic aggregates, health, model/rule versions | May leave site as metadata (roadmap plane) |
| **Never collected** | Audio, face/body embeddings, biometric templates, card numbers (PAN), PINs, emotion or "intoxication" inferences, per-employee productivity scores | Contract and code have no fields for them |

---

## 5. Retention and legal hold

| Data | Default | Range | Mechanism |
|---|---|---|---|
| Incident clips | 30 days (`ZEOATAP_RETENTION_DAYS`) | **30–90 days** per site policy | Deletion at `retention_deadline`; media then returns `410` |
| Legal hold | Until released | — | Owner/admin `POST /incidents/{id}/hold`; audited. Use for **incidents, claims, litigation and open matters** |
| Incident metadata, POS events, access log | Proposed 1 year / match clip / 90 days | Per counsel | Configurable [design] |
| Traffic aggregates | Proposed 2 years | — | No personal data |
| Audit log | Proposed 3 years | Per counsel | Append-only |
| Continuous recording | Not ours | — | The NVR's own policy |

**Litigation hold duty:** once a claim is reasonably anticipated (slip-and-fall, wage claim, chargeback), the relevant clips and metadata must be held. Routine deletion of held items is blocked; counsel decides scope.

---

## 6. Employee monitoring obligations

| Obligation | What to do | Product support |
|---|---|---|
| **Posted notice** | Signs at entrances and in staff areas: video (no audio) monitoring with AI analysis | Camera authorization record (who, when, scope) required to add a camera |
| **Written employee acknowledgment** | Signed camera/AI-monitoring policy in the handbook | — (owner process) |
| **New York** | Civil Rights Law § 52-c requires written notice (and acknowledgment) when employers monitor employees' telephone, email or internet use. Whether it reaches video analytics is a question for counsel; **give written notice anyway**. CT (Gen. Stat. § 31-48d) and DE (19 Del. C. § 705) have similar electronic-monitoring notice laws | — |
| **NLRA § 7** | Do not use cameras to watch, record or report on employees discussing pay or working conditions, or union activity — protected even in non-union workplaces. Exclude break rooms. Do not change camera coverage in response to organizing. NLRB guidance on electronic monitoring has shifted between administrations; confirm the current position | No audio; no break-room cameras; no "gathering" detection; every clip view audited |
| **Wage and hour** | If video shows work off the clock, that time is generally owed (FLSA "suffer or permit to work"; state law may be stricter). B1/B2 reports (roadmap) are **payroll-accuracy tools**, not only discipline tools | Roadmap report will list minutes both ways |
| **Biometrics** | No face recognition, no voiceprints, no hand/face geometry; buddy-punch detection (roadmap) matches *a person at the clock* to the punch, not a face | ADR-003; worker sends `role: "person"` only |
| **Human review** | No adverse action on an alert alone; manager reviews the clip; expect false positives in the first 30–60 days | Dispositions `ok · coach · investigate · false_detection · escalated_external · inconclusive`; UI reminder on every incident |
| **Harassment (roadmap F4)** | Confidential route to owner only; never cover restrooms | — |

---

## 7. Payments (PCI DSS) and consumer privacy

| Topic | Requirement | Design |
|---|---|---|
| **PCI DSS** | Overhead register cameras must not capture full card numbers or PIN entry; restrict and log access to footage of payment areas | Position/mask the overhead camera so card faces and PIN pads are not legible; verify on the install snapshot. POS endpoint accepts **no card data** (ADR-010), keeping the appliance out of the cardholder-data flow. Confirm scope with the acquirer/QSA |
| **CCPA/CPRA** (California employees and customers, if the business meets the thresholds) | Notice at collection listing categories (video, POS-linked incident data), purposes and retention; honour access/deletion requests subject to exceptions (e.g. legal holds) | Retention table above; export of an incident record (roadmap) |
| Other state privacy laws | Similar notice/rights in several states | Per counsel |
| Customer notice | Entrance signage: video monitoring with AI analysis, no audio, no face recognition | — |

---

## 8. Security controls

| Control | Status |
|---|---|
| Passwords hashed with bcrypt | **Implemented** |
| Session: HttpOnly `zeoatap_session`, SameSite=Strict, Secure flag (unless dev flag), 15 min sliding idle timeout; all sessions end on disable, role or password change | **Implemented** |
| Login throttling: 5 failures/user or 30/IP in 15 min → 15 min lock (`429`, `Retry-After`); lock audited once | **Implemented** |
| CSRF: JSON content type required on staff POSTs (`415`) + SameSite=Strict | **Implemented** |
| Clip encryption AES-256-GCM at rest; plaintext spool deleted after import | **Implemented** |
| Clip tokens valid 5 min; first request per token audited; media refused (`503`) if the audit write fails | **Implemented** |
| Hash-chained audit log with verification (`chain_ok`, `broken_at`) | **Implemented** |
| Role separation: admin ≠ clip viewer; SHADOW only for owner/admin | **Implemented** |
| Webhook error redaction (short class only, never the URL) | **Implemented** |
| Internal listener on loopback with bearer token | **Implemented** |
| **MFA** for owner/admin/manager | **Not yet** |
| **Content-Security-Policy** and other security headers | **Not yet** |
| **External anchoring of audit hashes** (off-box) | **Not yet** — a local attacker with DB access could rewrite the whole chain |
| **TLS termination guidance** (core serves HTTP; put a TLS reverse proxy or TLS listener in front) | **Not yet** documented/tested |
| Disk encryption (LUKS/TPM), RTSP credential secret store, signed updates, SBOM, pen test | **Not yet** |

---

## 9. Legal checklist for counsel (per state)

| Area | Question |
|---|---|
| Recording consent | Confirm video-only is outside wiretap scope; confirm no audio-capable cameras have audio enabled |
| Employee notice | Required notice/acknowledgment content (NY, CT, DE, others); handbook language |
| Biometrics | Confirm anonymous person detection and box tracking are not "biometric identifiers"; whether pose keypoints (if used) are (BIPA/CUBI/WA) |
| NLRA | Camera coverage review for break areas and gathering spots; policy on use of footage |
| Wage and hour | How to handle off-the-clock time evidenced by video |
| Restroom/locker statutes | Confirm all excluded areas per state law |
| PCI | Camera positioning and footage access for payment areas |
| Privacy laws | CCPA/CPRA and other state notices; data-subject requests vs. legal holds |
| Evidence | Chain of custody for clips used in claims, insurance and court |
| Union/CBA | Bargaining obligations over monitoring where a union exists |
