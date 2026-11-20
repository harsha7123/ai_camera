# Cost & Deployment Model

**Date:** 2026-11-20 · Measured inputs come from [BENCHMARK_RESULTS](BENCHMARK_RESULTS.md) (inference speed only, RTX PRO 4500 Blackwell, synthetic inputs). **Everything else is an illustrative engineering estimate [E] or a variable.** No prices were obtained; every vendor in the playbook is quote-based, so prices stay as variables.

---

## 1. Inputs

| Symbol | Meaning | Illustrative value |
|---|---|---|
| N | cameras per site | 6 (QSR) / 12 (full-service) |
| N_hi | `priority` (register/POS overhead) cameras | 2 / 3 |
| f_base, f_hi | analysed fps, normal / priority cameras | 5 / 15 (as built) |
| b | main-stream bitrate, Mbps | 1080p H.264 ≈ 4; sub-stream ≈ 1–2 |
| P | persons per analysed frame needing pose (only if pose is enabled) | 3 |
| t_det | detector GPU ms/frame | **Measured**, YOLOX-M 640²: TensorRT FP16 b8 0.960; ORT CUDA FP32 b8 3.202, b1 3.765 |
| t_pose | pose ms/person crop | **Measured**, RTMPose-m: TRT FP16 b8 0.112; ORT FP32 b8 0.320. **No current rule uses pose** |
| U | GPU utilisation ceiling | 0.6 |
| i_rate | incidents (incl. review, shadow) per camera-day | 3 [H] (measure in shadow) |
| clip_s | clip length, s | 40 [E] (playbook asks 10–20 s for POS exceptions) |
| R_days | clip retention | 30–90 |
| H_op | hours/day the site is staffed | 14 |

## 2. Formulas

- Analysed fps: `F = (N − N_hi)·f_base + N_hi·f_hi`
- GPU time: `G = F × (t_det + P_pose × t_pose)` ms/s, with `P_pose = 0` while no rule uses pose
- GPUs: `ceil(G / (1000 × U))`
- LAN ingest: `B_lan = N × b`
- Ring-buffer RAM: `M = N × ring_s × b / 8` MB
- Clip storage: `S = N × i_rate × R_days × clip_s × b / 8` MB
- Upstream, edge (as built): webhook payloads + (roadmap) metadata ≈ KB/s; **no video**
- Upstream, cloud-processing alternative: `N × b` Mbps sustained; `N × b × 3600 × H_op × 30 / 8 / 1000` GB/month

## 3. Restaurant scenarios

| | Small QSR | Full-service | 3-site group |
|---|---|---|---|
| Cameras | 6: entrance, 360 dining/counter, 2 register overheads, kitchen, back door/safe | 12: entrance, 2× 360 dining, bar 360, 3 register overheads, kitchen, pass, cooler, back door, safe | 6 + 12 + 12 = 30, **one appliance per site** |
| F (analysed fps) | 4×5 + 2×15 = **50** | 9×5 + 3×15 = **90** | 50 / 90 / 90 |
| G, detector only, TRT FP16 | 48 ms/s | 86 ms/s | per site |
| G, detector only, ORT CUDA FP32 (what the worker runs today on GPU) | 160 ms/s (b8) – 188 ms/s (b1) | 288–339 ms/s | per site |
| G with pose (P = 3), TRT FP16 | 65 ms/s | 117 ms/s | per site |
| GPUs (U = 0.6) | 1 | 1 | 3 (one per site) |
| LAN ingest, main stream 4 Mbps | 24 Mbps | 48 Mbps | per site |
| Ring buffer (120 s @ 4 Mbps) | 360 MB | 720 MB | per site |
| Clips, 30 / 90 days (20 MB/clip) | 10.8 / 32 GB | 21.6 / 65 GB | sum ≈ 54 / 162 GB |
| Upstream needed | KB/s (no video) | KB/s | KB/s per site + metadata plane |
| Cloud-processing alternative @ 2 Mbps sub-stream, 14 h/day | 12 Mbps sustained; ≈ 2.3 TB/month | 24 Mbps; ≈ 4.5 TB/month | ≈ 11.3 TB/month |

Worked check (full-service, ORT FP32 b1): 90 × 3.765 = 339 ms/s < 600 → 1 GPU. **CPU-only is not viable** for 90 fps (the worker measured ≈ 2 fps on a 4-vCPU CPU).

**Capacity is an upper bound.** BENCHMARK_RESULTS gives ≈ 46 cameras/GPU (YOLOX-M 640 + RTMPose-m, TensorRT FP16, 10 fps average). The worker does **not** yet use TensorRT FP16 or cross-camera batching, and the figures exclude decode, tracking and CPU. A restaurant's 6–16 cameras fit comfortably on one mid-range GPU by these numbers; the binding limit must come from an end-to-end soak on the chosen edge SKU (OQ-H4).

## 4. Cost formulas (variables only)

- Edge per site per month: `C_edge = HW_capex / amort_months + power_W × 24 × 30 / 1000 × kWh_price + support`
- Metadata plane per site per month (roadmap): `C_cp = infra / sites + messages × unit_price` (push/SMS)
- Cloud-processing alternative: `C_cloud = GPU_hours × price + egress_GB × price + storage`
- Install: `C_install = site_survey + zone_setup_hours × rate + network (VLAN) work + POS connector setup`

## 5. ROI framing (playbook "prove ROI" metrics)

`Monthly benefit = Δcash_variance + Δshrink% × sales + Δfood_cost% × food_sales + payroll_hours_corrected × wage + chargebacks_won × avg_chargeback + incidents_resolved_by_clip × avg_claim_cost_avoided + review_hours_saved × manager_wage`

All terms are measured before/after the pilot at the same site. **Payroll corrections run both ways** (unpaid off-the-clock time found on video is a cost, and it is owed). Compare against `C_edge + C_cp + C_install / amort_months`.

## 6. Efficiency levers

| Lever | Effect | Guard |
|---|---|---|
| TensorRT FP16 + batching (not yet in worker) | 2–5× less GPU time (benchmark) | Re-measure on target GPU |
| Sub-stream inference | Less decode/infer | Register cameras need detail → keep main stream or ROI for priority cams |
| 5 fps on non-priority cameras | Linear saving | Queue/post/after-hours rules tolerate it |
| Event-triggered clips | Storage proportional to incidents | Clip only from cameras on the incident |

## 7. Positioning vs. SaaS vendors (as described in the owner's playbook only)

| Vendor (playbook description) | Best fit per playbook | Our difference |
|---|---|---|
| Solink | Restaurants, stores, multi-site POS-linked loss prevention; camera-agnostic; strongest for C/E | Same POS-linked idea; we run on a local box, video stays on site; fewer POS integrations today (none built) |
| Spot AI | Multi-site ops on existing cameras; plain-language search; AI agents | Plain-language search is roadmap (H4) |
| Coram AI | Weapon and slip-and-fall alerts; natural-language alerts and search | Our fall rule is a heuristic; weapon is roadmap |
| Verkada / Rhombus | Fresh install, own cameras with on-camera AI; Rhombus integrates POS partners (e.g. Glimpse) | We reuse existing cameras |
| Glimpse | Bar/restaurant pour and food theft; existing cameras + POS | Pour/plate counting is roadmap (D2/D4) |

Vendor capabilities are per the playbook (vendor materials as of Oct 2026); **verify in demos**. The playbook's must-ask list applies to us too: POS/time-clock integration, existing cameras, per-camera monthly cost and term, where video is stored and who at the vendor can see it, audio on/off per camera, plain-English custom alerts.

## 8. Hardware (provisional)

x86 small-form-factor box, one NVIDIA GPU, 32 GB RAM, 1 TB NVMe, UPS, wired to the camera VLAN and staff LAN. Pin the kernel or use a DKMS-managed driver (benchmark failure #1). Final SKU after the edge-SKU benchmark re-run and soak (OQ-H4).
