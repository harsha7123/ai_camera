"""Pre-registered pilot acceptance goals and the go/no-go check.

Goals are configurable with a JSON file. The defaults below are proposed
engineering goals for the restaurant pilot, written down before any data is
scored. They are not achieved results.

Every recall goal is paired with a minimum number of positives (`n_min`)
that can actually demonstrate it: with n_min positives and zero misses, the
exact Clopper-Pearson lower bound under the default (two-sided 95%) decision
reaches the goal. `test_default_goals_are_achievable` checks this, so a goal
like "recall >= 0.99 with n >= 100" (unachievable: 100/100 only bounds
recall at 0.964) cannot be pre-registered by mistake.
"""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .stats import clopper_pearson, poisson_rate_interval, rule_of_three_n

# Event types in packages/contracts/API.md (v2).
EVENT_TYPES = (
    "after_hours_intrusion",
    "camera_tamper",
    "restricted_zone_entry",
    "person_down",
    "long_queue",
    "long_wait",
    "unattended_post",
    "pos_no_sale",
    "pos_refund_no_customer",
)

# Stratum keys and values; must match ground_truth.schema.json.
STRATA = {
    "lighting": ("day", "night", "after_hours_dark"),
    "crowding": ("empty", "normal", "rush"),
    "camera_view": ("overhead", "360", "wide"),
}


@dataclass
class Goal:
    code: str
    stage: str
    recall_lower: float | None = None       # goal on the lower confidence bound of recall
    n_min: int = 0                           # pre-registered minimum positives (overall and per required stratum)
    fa_per_camera_hour: float | None = None  # goal on false alerts / review prompts per camera-hour
    latency_p95_s: float | None = None       # goal on p95 of created_at - GT.start
    latency_budget_s: float = 5.0            # matching window after GT.end
    precision_lower: float | None = None     # goal on the lower confidence bound of precision
    precision_n_min: int = 0                 # pre-registered minimum conclusive incidents
    required_strata: dict[str, list[str]] = field(default_factory=dict)  # e.g. {"lighting": ["day", "night"]}
    report_only: bool = False                # research signal: never passes
    deployable: bool = True                  # False: not a product feature at all


DEFAULT_GOALS: dict[str, Goal] = {
    # G1. Alert policy (SHADOW until the owner enables it). Night and lights-off are the hard cases.
    "after_hours_intrusion": Goal(
        "G1", "Pilot alert (shadow first)", recall_lower=0.95, n_min=72, fa_per_camera_hour=0.01,
        latency_p95_s=10.0, latency_budget_s=5.0,
        required_strata={"lighting": ["night", "after_hours_dark"]}),
    # G3. Fires after 30 s of VIDEO_DEGRADED / CAMERA_UNAVAILABLE. A dark room must not look like a black frame.
    "camera_tamper": Goal(
        "G3", "Pilot alert (shadow first)", recall_lower=0.95, n_min=72, fa_per_camera_hour=0.01,
        latency_p95_s=60.0, latency_budget_s=45.0,
        required_strata={"lighting": ["day", "after_hours_dark"]}),
    # D5/G4. Review policy: false review prompts are counted against the FA goal too.
    "restricted_zone_entry": Goal(
        "D5", "Pilot review", recall_lower=0.90, n_min=60, fa_per_camera_hour=0.02,
        latency_p95_s=10.0, latency_budget_s=5.0,
        required_strata={"lighting": ["day", "night"]}),
    # F6. Box-aspect heuristic; stays SHADOW in the pilot.
    "person_down": Goal(
        "F6", "Shadow (heuristic)", recall_lower=0.80, n_min=30, fa_per_camera_hour=0.02,
        latency_p95_s=10.0, latency_budget_s=5.0,
        required_strata={"crowding": ["empty", "normal"], "camera_view": ["overhead", "360"]}),
    # A4. Operations alerts: precision first (managers stop reading noisy alerts).
    "long_queue": Goal(
        "A4", "Pilot alert (operations)", recall_lower=0.70, n_min=30, precision_lower=0.80, precision_n_min=30,
        latency_p95_s=120.0, latency_budget_s=90.0,
        required_strata={"crowding": ["rush"]}),
    "long_wait": Goal(
        "A4", "Pilot review (operations)", recall_lower=0.70, n_min=30, fa_per_camera_hour=0.05,
        precision_lower=0.70, precision_n_min=30, latency_p95_s=600.0, latency_budget_s=600.0,
        required_strata={"crowding": ["normal", "rush"]}),
    # B4. Operations alert: precision first.
    "unattended_post": Goal(
        "B4", "Pilot alert (operations)", recall_lower=0.80, n_min=30, precision_lower=0.80, precision_n_min=30,
        latency_p95_s=240.0, latency_budget_s=240.0,
        required_strata={"crowding": ["normal", "rush"]}),
    # C1. Deterministic from the POS feed: every no_sale must become one review item.
    # 0.99 needs 368 zero-miss positives two-sided (0.025**(1/368) = 0.99003), 300 one-sided.
    "pos_no_sale": Goal(
        "C1", "Pilot review (POS)", recall_lower=0.99, n_min=368, fa_per_camera_hour=0.01,
        latency_p95_s=30.0, latency_budget_s=30.0),
    # C3. POS event plus "nobody in customer_side": the vision half fails in a rush (occlusion).
    "pos_refund_no_customer": Goal(
        "C3", "Shadow -> alert (POS + vision)", recall_lower=0.90, n_min=60, fa_per_camera_hour=0.02,
        latency_p95_s=30.0, latency_budget_s=30.0,
        required_strata={"crowding": ["empty", "normal"]}),
}

DEFAULT_LATENCY_BUDGET_S = 5.0


def validate_goal(et: str, g: Goal) -> None:
    for key, values in g.required_strata.items():
        if key not in STRATA:
            raise ValueError(f"goal {et}: unknown stratum key {key!r} (known: {', '.join(STRATA)})")
        bad = [v for v in values if v not in STRATA[key]]
        if bad:
            raise ValueError(f"goal {et}: unknown {key} value(s) {bad} (known: {', '.join(STRATA[key])})")
    for name in ("recall_lower", "precision_lower"):
        v = getattr(g, name)
        if v is not None and not 0 < v < 1:
            raise ValueError(f"goal {et}: {name} must be in (0, 1)")


def load_goals(path: str | Path | None) -> dict[str, Goal]:
    goals = {k: Goal(**asdict(v)) for k, v in DEFAULT_GOALS.items()}
    if path:
        raw = json.loads(Path(path).read_text())
        for et, g in raw.get("goals", raw).items():
            base = asdict(goals[et]) if et in goals else asdict(Goal(code=et, stage="custom"))
            base.update(g)
            goals[et] = Goal(**base)
    for et, g in goals.items():
        validate_goal(et, g)
    return goals


def min_n_exact(goal: float, confidence: float, sided: str) -> int:
    """Smallest n for which n/n successes gives a Clopper-Pearson lower bound
    >= goal (lower = alpha' ** (1/n))."""
    a = (1 - confidence) / (2 if sided == "two" else 1)
    return math.ceil(math.log(a) / math.log(goal) - 1e-12)


def misses_allowed(goal: float, n: int, confidence: float, sided: str) -> int | None:
    """Most misses (failures) in n for which the lower bound still reaches
    the goal; None if even 0 misses is not enough."""
    side = "lower" if sided == "one" else "two"
    if n <= 0 or clopper_pearson(n, n, confidence, side).lower < goal:
        return None
    k = 0
    while k + 1 <= n and clopper_pearson(n - k - 1, n, confidence, side).lower >= goal:
        k += 1
    return k


def _required(goal: float, n_min: int, confidence: float, sided: str) -> dict:
    r3 = rule_of_three_n(1 - goal)
    ex = min_n_exact(goal, confidence, sided)
    need = max(n_min, r3, ex)
    return {"n_required": need, "n_min_preregistered": n_min, "n_rule_of_three": r3, "n_exact_zero_miss": ex,
            "misses_allowed_at_n_required": misses_allowed(goal, need, confidence, sided)}


def required_n(g: Goal, confidence: float, sided: str) -> dict:
    if g.recall_lower is None:
        return {"n_required": None}
    return _required(g.recall_lower, g.n_min, confidence, sided)


def required_hours(fa_goal: float, confidence: float, sided: str) -> float:
    """Camera-hours needed to bound FA/camera-hour <= goal with 0 observed."""
    iv = poisson_rate_interval(0, 1.0, confidence, "upper" if sided != "two" else "two")
    return iv.upper / fa_goal


def _check(name: str, status: str, detail: str, **kw) -> dict:
    return {"check": name, "status": status, "detail": detail, **kw}


def _proportion_check(name: str, k: int, n: int, goal: float, n_min: int, confidence: float, sided: str,
                      what: str) -> dict:
    side = "lower" if sided == "one" else "two"
    req = _required(goal, n_min, confidence, sided)
    lo = clopper_pearson(k, n, confidence, side).lower
    hi = clopper_pearson(k, n, confidence, "two").upper
    if n and hi < goal:
        return _check(name, "FAIL", f"{name} {k}/{n}: even the upper bound {hi:.4f} is below the goal {goal}",
                      lower_bound=lo, **req)
    if n < req["n_required"]:
        return _check(name, "INSUFFICIENT_DATA",
                      f"n={n} {what} < {req['n_required']} required to claim {name} >= {goal} "
                      f"(pre-registered {req['n_min_preregistered']}, rule of three {req['n_rule_of_three']}, "
                      f"exact zero-miss {req['n_exact_zero_miss']})", lower_bound=lo, **req)
    return _check(name, "PASS" if lo >= goal else "FAIL",
                  f"{name} {k}/{n}, {sided}-sided {confidence:.0%} lower bound {lo:.4f} vs goal {goal}",
                  lower_bound=lo, **req)


def evaluate_goal(et: str, m: dict, g: Goal | None, confidence: float, sided: str,
                  stratum_ratio: float = 0.8, stratum_min_n: int = 5) -> dict:
    """Return {verdict, checks[]} for one event type. Verdicts: PASS, FAIL,
    INSUFFICIENT_DATA, INVALID_SOURCE, REPORT_ONLY, NOT_DEPLOYABLE, NO_GOAL."""
    if g is None:
        return {"verdict": "NO_GOAL", "checks": [], "goal": None}
    gd = asdict(g)
    if not g.deployable:
        return {"verdict": "NOT_DEPLOYABLE", "goal": gd,
                "checks": [_check("deployable", "FAIL", f"{g.code} is not a product feature")]}
    if g.report_only:
        return {"verdict": "REPORT_ONLY", "goal": gd,
                "checks": [_check("report_only", "INFO", f"{g.code} is research only: metrics are reported, never passed")]}
    checks = []
    side = "lower" if sided == "one" else "two"
    n, tp = m["n_gt"], m["detected"]
    if g.recall_lower is not None:
        checks.append(_proportion_check("recall", tp, n, g.recall_lower, g.n_min, confidence, sided, "positives"))
        req = required_n(g, confidence, sided)
        # Each required stratum needs the same n and bound as the overall goal.
        for key, values in g.required_strata.items():
            for v in values:
                s = m["strata"].get(key, {}).get(v, {"n_gt": 0, "detected": 0})
                slo = clopper_pearson(s["detected"], s["n_gt"], confidence, side).lower
                if s["n_gt"] < req["n_required"]:
                    st = "INSUFFICIENT_DATA"
                else:
                    st = "PASS" if slo >= g.recall_lower else "FAIL"
                checks.append(_check(f"stratum {key}={v}", st,
                                     f"{s['detected']}/{s['n_gt']}, lower bound {slo:.4f}; needs n >= {req['n_required']} "
                                     f"and bound >= {g.recall_lower}", lower_bound=slo, n_required=req["n_required"]))
    if g.precision_lower is not None:
        checks.append(_proportion_check("precision", m["true_positive_incidents"], m["incidents"],
                                        g.precision_lower, g.precision_n_min, confidence, sided,
                                        "conclusive incidents"))
    overall = m["recall"]
    if overall is not None:
        low = []
        for key, vals in m["strata"].items():
            for v, s in vals.items():
                if s["n_gt"] >= stratum_min_n and s["recall"] is not None and s["recall"] < stratum_ratio * overall:
                    low.append(f"{key}={v} ({s['recall']:.3f})")
        checks.append(_check("strata >= 80% of overall recall", "FAIL" if low else "PASS",
                             ("below %.0f%% of overall recall %.3f: %s; needs a documented mitigation"
                              % (stratum_ratio * 100, overall, ", ".join(low))) if low else
                             f"every stratum with n >= {stratum_min_n} is >= {stratum_ratio:.0%} of overall recall {overall:.3f}"))
    if g.fa_per_camera_hour is not None:
        hrs = m["camera_hours_operational"]
        need = required_hours(g.fa_per_camera_hour, confidence, sided)
        k = m["false_alerts"]
        up = poisson_rate_interval(k, hrs, confidence, "upper" if sided == "one" else "two") if hrs > 0 else None
        ub = up.upper if up else math.inf
        lb = poisson_rate_interval(k, hrs, confidence, "two").lower if hrs > 0 else 0.0
        if lb > g.fa_per_camera_hour:
            checks.append(_check("false alerts / camera-hour", "FAIL",
                                 f"{k} false alerts in {hrs:.2f} h: even the lower bound {lb:.5f} exceeds the goal "
                                 f"{g.fa_per_camera_hour}", upper_bound=ub, hours_required=need))
        elif hrs < need:
            checks.append(_check("false alerts / camera-hour", "INSUFFICIENT_DATA",
                                 f"{hrs:.2f} operational camera-hours < {need:.1f} needed to bound the rate below "
                                 f"{g.fa_per_camera_hour} (observed {k})", upper_bound=ub, hours_required=need))
        else:
            checks.append(_check("false alerts / camera-hour", "PASS" if ub <= g.fa_per_camera_hour else "FAIL",
                                 f"{k} false alerts in {hrs:.1f} h, upper bound {ub:.5f} vs goal {g.fa_per_camera_hour}",
                                 upper_bound=ub, hours_required=need))
    if g.latency_p95_s is not None:
        p95 = m["latency"]["p95_s"]
        if p95 is None:
            checks.append(_check("latency p95", "INSUFFICIENT_DATA", "no matched events"))
        else:
            checks.append(_check("latency p95", "PASS" if p95 <= g.latency_p95_s else "FAIL",
                                 f"p95 {p95:.2f} s (n={m['latency']['n']}) vs goal {g.latency_p95_s} s"))
    if m["mock_incidents"]:
        checks.append(_check("real detector", "INVALID_SOURCE",
                             f"{m['mock_incidents']} incidents come from a MOCK detector; MOCK output is never real detection"))
    statuses = {c["status"] for c in checks}
    for v in ("INVALID_SOURCE", "FAIL", "INSUFFICIENT_DATA"):
        if v in statuses:
            return {"verdict": v, "checks": checks, "goal": gd}
    return {"verdict": "PASS" if checks else "NO_GOAL", "checks": checks, "goal": gd}


MANUAL_CHECKS = [
    "Event definitions approved by the owner / operations lead for this site",
    "Shadow period (30-60 days) completed with the required camera-hours before alerting_enabled is set",
    "Failure-injection suite passes (camera unplugged, covered, frozen; POS feed down)",
    "Monitoring-unavailable states verified to display correctly (only FULLY_OPERATIONAL is green)",
    "Rollback tested on the target hardware",
    "Privacy/legal review: posted notice, written employee acknowledgment, audio off, no biometrics, no cameras in restrooms or changing areas",
    "Managers briefed: an alert is a review prompt, never a finding; no discipline from an alert alone",
    "Release manifest signed with validated_for_alerting=true referencing this report",
]
