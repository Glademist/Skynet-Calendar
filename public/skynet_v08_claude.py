"""SKYNET v0.8 — Night-shift scheduler, Island Genetic Algorithm.
   Author  : Alexandr Škaryd MD
   Redesign: Claude Sonnet 4.6
   Licence : GNU General Public License v3.0

── What is new in v0.8 ────────────────────────────────────────────────────────

PER-WORKER SCORING  (WorkerScore / ScheduleScore)
  Every sequence is evaluated to a ScheduleScore that contains a WorkerScore
  for each doctor.  The global fitness number is gone; selection works on a
  richer object.  This lets us track, store and reason about individual
  fairness rather than a single sum that hides who is suffering.

TWO-LEVEL NON-LINEAR PENALTIES
  Within one penalty type:  each additional violation costs 1.5× the previous.
    1st → 1.0,  2nd → +1.5,  3rd → +2.25,  4th → +3.375 …
  Across active penalty types: multiply the within-type sum by 1.5^(n_types-1).
  A doctor with many *kinds* of violations is always worse than a doctor with
  several violations all of the same kind.

AVAILABILITY HANDICAP  (simulated floor)
  For each doctor, before the GA starts, we simulate their personal best-
  possible schedule: assign them to every day they *can* work and score the
  result.  That score is their floor — the best we could ever achieve even
  in a universe where all other doctors don't exist.  Their adjusted penalty
  is (actual_raw - floor), so a doctor with few available days is not punished
  for a constraint that is structurally impossible to satisfy.

PERSONAL BEST ARCHIVE  (per worker)
  A dict worker_key → best WorkerScore seen across all sequences and all
  cycles.  Updated on every evaluation.  Written to disk at the end.

FAIRNESS-AWARE SELECTION
  Primary  : total adjusted penalty (lower = better)
  Secondary: variance of adjusted penalties across workers (lower = fairer)
  Tertiary : number of workers at their personal best (higher = better)

CONSECUTIVE WEEKEND-WEEKS PENALTY  (new)
  For any two adjacent calendar weeks, if a worker has Fr/Sa/Su shifts in
  *both* weeks, that is penalised.  Detected via a sliding-window scan over
  duties_pv (the sorted list of all premium-day shift indices).

STAGED RIGOROSITY  (three phases)
  Phase 1 — Weekend skeleton only.  Only Fr/Sa/Su constraints active.
            Fast convergence to a good weekend backbone.
  Phase 2 — Full constraints, soft penalties (weights ×0.3).
            Warm-started from Phase 1 best.  Explores full space gently.
  Phase 3 — Full constraints, full penalty weights.
            Warm-started from Phase 2 best.  Refines to final answer.

RESULT ARCHIVE  (JSONL)
  Every time a sequence beats a previous known record — global or per-worker —
  it is appended to results_archive.jsonl.  An AI agent or human can later
  pull these records and search the Pareto frontier across worker dimensions.

All v0.7 features retained:
  fitness cache, novelty archive, tournament selection, uniform week crossover,
  adaptive mutation, island migration, pre-built date_index, __slots__.
"""

from __future__ import annotations
import json
import math
import random
import time
from dataclasses import dataclass, field, asdict
from datetime import timedelta, datetime
from pathlib import Path
from typing import Optional

# ── Configuration ─────────────────────────────────────────────────────────────

START       = (2025, 4, 1)
END         = (2025, 6, 30)

WorkersFilename  = "docold.txt"
OverrideFilename = "overmid.txt"
ArchiveFile      = Path("results_archive.jsonl")
BestPerWorkerFile= Path("best_per_worker.json")

SourceAbeceda = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

# GA
PopulationSize        = 200
ElitePercentage       = 0.10
BASE_MUTATION_RATE    = 5       # percent
TOURNAMENT_K          = 5
STAGNATION_LIMIT      = 15
MUTATION_BOOST_FACTOR = 3
MIGRATION_INTERVAL    = 30
MAX_REGEN_TRIES       = 8
ISLAND_NAMES          = ["africa", "eurasia", "australia", "america", "antarktis"]

# Staged rigorosity
STAGE_CYCLES   = [80, 120, 100]   # cycles per stage  (total = 300)
STAGE_WEIGHTS  = [0.0, 0.3, 1.0]  # penalty weight multiplier per stage
#   Stage 0: weight=0 means only the hard structural penalties (critical + count)
#   Stage 1: 0.3  →  soft full-constraint run seeded from stage 0 best
#   Stage 2: 1.0  →  full penalties, final refinement

# Non-linear penalty shape
WITHIN_RATIO  = 1.5   # cost of each next violation within one type
BREADTH_RATIO = 1.5   # multiplier per additional active penalty type

# Base penalty magnitudes  (scaled by stage weight and non-linear structure)
P_CRITICAL        = 100_000   # consecutive days — always full, never scaled
P_INTERVAL        = 1.0
P_WEEKEND_SPACING = 1.0
P_FRIDAY          = 1.0
P_COUNT_WORKDAY   = 1.0
P_COUNT_WEEKEND   = 1.0
P_COUNT_TOTAL     = 1.0
P_CONSEC_WEEKEND_WEEKS = 2.0   # two Fr/Sa/Su weeks back to back
P_MONTH_TARGET_DEV     = 2.0   # per-doctor per-month deviation from an
                               # availability-weighted target. Replaces the
                               # older within-doctor month_uniformity rules,
                               # which actively penalised availability-driven
                               # asymmetry (1+4+3 worse than 1+2+3 — opposite
                               # of Saša's rule).
P_DESTROYED_WEEKEND    = 5.0   # two premium days within ≤3 days (e.g. Fri+Sun)
                               # — explicitly waived if BOTH days are in the
                               # doctor's desired_duty (they asked for it).

# Convex count-penalty shape (count_workday / count_weekend / count_total / friday).
# Replaces the old linear `abs(actual - target)` violation magnitude.
#   - soft zone (between fair share and wish, or symmetric beyond wish):
#       (gap / span)^2 where gap = actual - wish, span = max(|wish - fair|, MIN_SPAN).
#       Convex curve: marginal cost per missing shift grows the further from wish.
#       Symmetric above and below wish.
#   - unfair zone (actual < min(wish, fair)): doctor is short of their fair share AND
#       short of what they wanted. Adds K_UNFAIR * (threshold - actual)^2 on top.
# Friday uses K_UNFAIR=0 path (pure symmetric — fair == wish for that distribution
# rule, no separate "shortchanged" notion).
MIN_SPAN = 1.0   # floor for the per-doctor span, keeps low-wish doctors from exploding
K_UNFAIR = 5.0   # multiplier on the unfair-below-fair-share term


# ── Data classes ──────────────────────────────────────────────────────────────

class Worker:
    __slots__ = ("letter", "employment", "min_interval",
                 "limit_workday", "limit_weekend",
                 "fair_wd", "fair_wk",
                 "desired_duty", "undesired_duty",
                 "external_duties",
                 "availability_handicap", "n_days_blocked_fraction")

    def __init__(self):
        self.letter               = ""
        self.employment           = 1.0
        self.min_interval         = 7
        self.limit_workday        = 0
        self.limit_weekend        = 0
        # Per-doctor "fair share" of weekday/weekend shifts — the equal-split
        # baseline (total_*_demand / sum_employment * worker.employment), used by
        # count_penalty as the threshold between the soft and harsh penalty zones.
        # Distinct from limit_* (which is the doctor's *wish*): a doctor whose
        # wish is above fair is in the "wants extras" zone, below fair is in the
        # "wants less than fair share" zone.
        self.fair_wd              = 0.0
        self.fair_wk              = 0.0
        self.desired_duty         = []
        self.undesired_duty       = []
        # Dates this worker has shifts in OTHER groups (when one group is
        # being optimized at a time). These count toward
        #   - spacing/interval/destroyed_weekend/consec_wk_weeks (so a
        #     Mladí Friday next to a Střední Sunday for the same doctor
        #     correctly fires destroyed_weekend), AND
        #   - count_workday/count_weekend/count_total (so a multi-group
        #     doctor's per-quarter limit is the TOTAL across all groups —
        #     externals are pre-spent budget, not free shifts).
        # They still do NOT participate in friday and month_target_dev,
        # which are distribution/fairness rules scoped to the group being
        # scheduled. Empty list when running standalone.
        self.external_duties      = []
        self.availability_handicap= 0.0   # computed pre-run
        self.n_days_blocked_fraction = 0.0


class DayOfLife:
    __slots__ = ("index", "possible_duty", "worker")

    def __init__(self, index: float, possible_duty: Optional[list] = None):
        self.index         = index
        self.possible_duty = possible_duty or []
        self.worker        = None


@dataclass
class WorkerScore:
    key:              str
    raw_penalty:      float          # raw violation penalty (always ≥ 0)
    floor:            float          # simulated best possible (always ≥ 0)
    adjusted:         float          # raw - floor  (what we actually compare)
    at_personal_best: bool = False
    violations:       dict = field(default_factory=dict)  # type → count

    def to_dict(self):
        return asdict(self)


@dataclass
class ScheduleScore:
    """Aggregate score for one sequence."""
    workers_string:   str
    total_adjusted:   float          # sum of adjusted worker penalties
    penalty_variance: float          # variance across workers (fairness proxy)
    workers_at_best:  int
    worker_scores:    dict           # key → WorkerScore

    # Lower total_adjusted is better.
    # Equal totals: lower variance wins.
    # Equal variance: more workers at best wins.
    def __lt__(self, other: ScheduleScore) -> bool:
        if self.total_adjusted != other.total_adjusted:
            return self.total_adjusted < other.total_adjusted
        if self.penalty_variance != other.penalty_variance:
            return self.penalty_variance < other.penalty_variance
        return self.workers_at_best > other.workers_at_best

    def is_better_than(self, other: ScheduleScore) -> bool:
        return self < other

    def to_dict(self):
        return {
            "workers_string":   self.workers_string,
            "total_adjusted":   self.total_adjusted,
            "penalty_variance": self.penalty_variance,
            "workers_at_best":  self.workers_at_best,
            "worker_scores":    {k: v.to_dict() for k, v in self.worker_scores.items()},
        }


class Sequence:
    __slots__ = ("workers", "score")

    def __init__(self, workers: str = "", score: Optional[ScheduleScore] = None):
        self.workers = workers
        self.score   = score   # None until evaluated

    @property
    def fitness(self) -> float:
        """Compatibility shim: lower total_adjusted penalty = higher fitness."""
        if self.score is None:
            return -2_000_000.0
        return -self.score.total_adjusted

    def is_better_than(self, other: Sequence) -> bool:
        if self.score is None:
            return False
        if other.score is None:
            return True
        return self.score.is_better_than(other.score)


class Island:
    __slots__ = ("name", "sequences", "best", "stagnation",
                 "mutation_rate", "max_fitness", "min_fitness")

    def __init__(self, name: str, sequences: list):
        self.name          = name
        self.sequences     = sequences
        self.best          = Sequence()
        self.stagnation    = 0
        self.mutation_rate = BASE_MUTATION_RATE
        self.max_fitness   = -2_000_000.0
        self.min_fitness   = 0.0


# ── Global shared state ───────────────────────────────────────────────────────

fitness_cache    = {}          # workers_string → ScheduleScore
novelty_archive  = set()       # set of all workers_strings ever produced
personal_bests   = {}          # worker_key → WorkerScore (best ever seen)


# ── Non-linear penalty engine ─────────────────────────────────────────────────

def within_type_cost(n: int) -> float:
    """Total cost for n violations of a single type.
    Series: 1, 1.5, 2.25 … (geometric, ratio=WITHIN_RATIO).
    Returns 0 for n=0."""
    if n <= 0:
        return 0.0
    cost  = 1.0
    total = 0.0
    for _ in range(n):
        total += cost
        cost  *= WITHIN_RATIO
    return total


def count_penalty(actual: float, wish: float, fair: float,
                  k_unfair: float = K_UNFAIR) -> float:
    """Convex, zoned penalty for shift-count deviation from a doctor's wish.

    - Returns 0 when actual == wish.
    - Soft part: (gap / span)^2 where gap = actual - wish and span = max(|wish - fair|, MIN_SPAN).
      Symmetric above and below wish.
    - Unfair part: when actual < min(wish, fair) (doctor is short of their fair share AND
      short of what they wanted), add k_unfair * (threshold - actual)^2 on top.
      Pass k_unfair=0 for distributions where wish == fair and the asymmetric harsh
      zone isn't meaningful (friday).
    """
    if actual == wish:
        return 0.0

    span = max(abs(wish - fair), MIN_SPAN)
    gap  = actual - wish
    soft = (gap / span) ** 2

    threshold = min(wish, fair)
    if k_unfair > 0 and actual < threshold:
        unfair_gap = threshold - actual
        return soft + k_unfair * (unfair_gap ** 2)

    return soft


def split_penalty(violation_counts: dict, weight: float = 1.0) -> tuple:
    """Compute (critical_penalty, soft_penalty) separately.

    Critical violations bypass the handicap-floor mechanism entirely so they
    cannot be absorbed by a worker's structural floor (which would happen if
    their synthetic 'work every day' schedule already piled up critical
    violations from gap=1). They also do not participate in the breadth
    multiplier across soft types — they're a hard legal penalty, not a
    fairness signal.

    Soft violations are weighted by stage weight, then aggregated with the
    within-type and breadth-across-types non-linear scaling.
    """
    crit_n   = violation_counts.get("critical", 0)
    critical = within_type_cost(crit_n) * P_CRITICAL  # never scaled

    # count_* and friday now carry float penalty values directly (from count_penalty),
    # not integer violation counts. They bypass within_type_cost (which would treat
    # them as repetition multipliers) — the convex (gap/span)^2 shape already encodes
    # the "many missing shifts hurt more than few" curve.
    FLOAT_COUNT_TYPES = {"count_workday", "count_weekend", "count_total", "friday"}

    type_totals = []
    for type_name, n in violation_counts.items():
        if n <= 0 or type_name == "critical":
            continue
        if type_name in FLOAT_COUNT_TYPES:
            base = float(n)
        else:
            base = within_type_cost(n)
        mag = {
            "interval":         P_INTERVAL,
            "weekend_spacing":  P_WEEKEND_SPACING,
            "friday":           P_FRIDAY,
            "count_workday":    P_COUNT_WORKDAY,
            "count_weekend":    P_COUNT_WEEKEND,
            "count_total":      P_COUNT_TOTAL,
            "consec_wk_weeks":  P_CONSEC_WEEKEND_WEEKS,
            "month_target_dev":         P_MONTH_TARGET_DEV,
            "destroyed_weekend":        P_DESTROYED_WEEKEND,
        }.get(type_name, 1.0)
        type_totals.append(base * mag * weight)

    if not type_totals:
        return critical, 0.0

    raw_sum = sum(type_totals)
    n_types = len(type_totals)
    breadth = BREADTH_RATIO ** (n_types - 1)
    return critical, raw_sum * breadth


def worker_penalty_score(violation_counts: dict, weight: float = 1.0) -> float:
    """Backward-compatible wrapper: returns critical + soft as a single number."""
    crit, soft = split_penalty(violation_counts, weight)
    return crit + soft


# ── Date index helper ─────────────────────────────────────────────────────────

def make_date_index(first_day: datetime, n_days: int) -> list:
    return [(first_day + timedelta(days=i)).strftime("%Y-%m-%d")
            for i in range(n_days)]


# ── I/O ───────────────────────────────────────────────────────────────────────

def load_worker_sources(filename: str):
    with open(filename) as f:
        names = [l.strip() for l in f if l.strip()]

    workers = {}
    for name in names:
        w = Worker()
        with open(name + ".txt") as f:
            w.limit_workday = f.readline().strip()
            w.limit_weekend = f.readline().strip()
            w.employment    = f.readline().strip()
            w.min_interval  = f.readline().strip()
            source          = [l.strip() for l in f]

        desires, desiresnot, i = [], [], 0
        while i < len(source) and source[i] != "NEMUZE":
            desires.append(source[i])
            i += 1
        desiresnot       = source[i + 1:]
        w.desired_duty   = desires
        w.undesired_duty = desiresnot
        workers[name]    = w

    abeceda = SourceAbeceda[:len(workers)]
    for i, key in enumerate(workers):
        workers[key].letter = abeceda[i]

    return workers, abeceda


def calendar_genesis(first_day: datetime, last_day: datetime) -> dict:
    day_type = {1: 1.125, 2: 1.125, 3: 1.125, 4: 1.01,
                5: 1.25,  6: 1.37,  7: 1.3}
    n   = (last_day - first_day).days + 1
    cal = {}
    for i in range(n):
        d          = first_day + timedelta(days=i)
        cal[d.strftime("%Y-%m-%d")] = DayOfLife(day_type[d.isoweekday()])
    with open("svatky.txt") as f:
        for line in f:
            p = line.split()
            if len(p) >= 2 and p[0] in cal:
                cal[p[0]].index = float(p[1])
    return cal


def calendar_availability(cal: dict, workers: dict) -> dict:
    for day, d in cal.items():
        d.possible_duty = [w.letter for w in workers.values()
                           if day not in w.undesired_duty]
    for day, d in cal.items():
        desired = [w.letter for w in workers.values()
                   if day in w.desired_duty]
        if desired:
            d.possible_duty = desired
    try:
        overrides = {}
        with open(OverrideFilename) as f:
            for line in f:
                p = line.split()
                if p:
                    overrides[p[0]] = " ".join(p[1:])
        for day, name in overrides.items():
            if day in cal:
                cal[day].possible_duty = [workers[name].letter]
        print("Override successful.")
    except FileNotFoundError:
        print("No override file found, skipping.")
    for day, d in cal.items():
        if not d.possible_duty:
            print(f"  WARNING: {day} — nobody available.")
    return cal


def timespan_ideal_values(cal: dict, workers: dict):
    minus_wd = minus_wk = 0
    n_wd_flex = n_wk_flex = 0
    total_wd = total_wk  = 0

    for w in workers.values():
        if w.limit_workday != "X":
            w.limit_workday = int(w.limit_workday)
            minus_wd += float(w.limit_workday)
        else:
            n_wd_flex += 1
        if w.limit_weekend != "X":
            w.limit_weekend = int(w.limit_weekend)
            minus_wk += float(w.limit_weekend)
        else:
            n_wk_flex += 1

    for d in cal.values():
        if d.index > 1.29:
            total_wk += 1
        else:
            total_wd += 1

    ideal_wd = (total_wd - minus_wd) / n_wd_flex if n_wd_flex else 0
    ideal_wk = (total_wk - minus_wk) / n_wk_flex if n_wk_flex else 0
    print(f"Ideal workday: {ideal_wd:.2f}   Ideal weekend: {ideal_wk:.2f}")

    # Per-doctor "fair share": total demand split equally across all doctors,
    # weighted by employment. Distinct from ideal_wd/wk (which only splits the
    # *remaining* demand among flexible workers, after hard-set workers take
    # their stated limit). Used by count_penalty.
    total_emp = sum(float(w.employment) for w in workers.values()) or 1.0
    fair_wd_per_fte = total_wd / total_emp
    fair_wk_per_fte = total_wk / total_emp
    for w in workers.values():
        emp = float(w.employment)
        w.fair_wd = fair_wd_per_fte * emp
        w.fair_wk = fair_wk_per_fte * emp
    print(f"Fair share per FTE: wd={fair_wd_per_fte:.2f}  wk={fair_wk_per_fte:.2f}")

    return float(ideal_wd), float(ideal_wk)


def update_workers_ideal(workers: dict, ideal_wd: float, ideal_wk: float):
    for key, w in workers.items():
        if w.limit_workday == "X":
            w.limit_workday = ideal_wd * float(w.employment)
        if w.limit_weekend == "X":
            w.limit_weekend = ideal_wk * float(w.employment)
        print(f"  {key}: wd={w.limit_workday:.2f}  wk={w.limit_weekend:.2f}")
    return workers


def get_ideal_friday(workers: dict, cal: dict) -> float:
    fridays = sum(1 for d in cal.values() if d.index == 1.25)
    return fridays / len(workers)


def get_crossover_breaks(cal: dict, first_day: datetime) -> list:
    breaks = []
    for key in cal:
        d = datetime.strptime(key, "%Y-%m-%d")
        if d.weekday() == 6:
            breaks.append((d - first_day).days)
    return sorted(breaks)


# ── Availability handicap (structural) ──────────────────────────────────────

def compute_availability_handicap(
    worker_key: str, worker: Worker,
    cal: dict, date_idx: list,
    workers: dict, ideal_fridays: float,
    stage_weight: float = 1.0
) -> float:
    """Compute the structural soft-penalty floor for one worker.

    Floor = the minimum unavoidable soft penalty given the worker's *availability*.
    Only count-type violations can be structural — if a worker's `target_wd`
    weekday shifts exceed the number of available weekday-style days, that
    shortfall is impossible to recover from. Spacing/interval/consec_wk_weeks
    violations are avoidable with optimal day-picking, so they do NOT
    contribute to the floor.

    Earlier versions of this function used the synthetic "worker on every
    available day" as the floor. That over-penalised everything (a worker
    on 26 consecutive days has 25 critical violations + huge count
    violations) and absorbed real-schedule penalties through the
    `adjusted = max(0, soft - floor)` clamp, causing the GA to short-circuit
    on `total_adjusted=0` while leaving real fairness/feasibility issues
    unresolved.
    """
    # Categorize availability by day type. Matches the bucket logic in
    # _count_violations_for_worker: workday-style includes Fri; weekend
    # excludes Fri.
    avail_workday = 0   # Mon–Thu + Fri (matches duties_p after merge)
    avail_friday  = 0
    avail_weekend = 0
    n_blocked     = 0

    for ds in date_idx:
        if worker.letter not in cal[ds].possible_duty:
            n_blocked += 1
            continue
        idx = cal[ds].index
        if   idx in (1.125, 1.01):
            avail_workday += 1
        elif idx == 1.25:
            avail_workday += 1
            avail_friday  += 1
        elif idx in (1.3, 1.37, 1.6):
            avail_weekend += 1

    avail_total = avail_workday + avail_weekend

    # Resolve targets as floats (count_penalty operates on floats; X-workers'
    # limits resolve to ideal*employment which is non-integer).
    target_wd    = float(worker.limit_workday)
    target_wk    = float(worker.limit_weekend)
    target_total = target_wd + target_wk
    target_fri   = float(ideal_fridays)

    # External duties contribute to count_* in the scorer, so the floor
    # must mirror that: count externals as already-spent budget when
    # checking achievability. Two structural cases produce unavoidable
    # penalty (no placement strategy can avoid them):
    #   (a) ext alone exceeds target — doctor is over-quota before the GA
    #       even starts (rare but possible if a senior group was overfilled).
    #   (b) avail + ext < target — doctor can't reach target even by
    #       grabbing every available day.
    # In both cases the floor = the best-case count_penalty given the
    # achievable range [ext, ext + avail]. The GA's adjusted score subtracts
    # this floor so the doctor isn't punished for state they can't change.
    ext_wd = 0
    ext_wk = 0
    for d in worker.external_duties:
        if d not in cal:
            continue
        cidx = cal[d].index
        if cidx in (1.125, 1.01, 1.25):
            ext_wd += 1
        elif cidx in (1.3, 1.37, 1.6):
            ext_wk += 1
    ext_total = ext_wd + ext_wk

    def _floor_for(min_actual, max_actual, wish, fair, k_unfair=K_UNFAIR):
        """Best-case count_penalty when actual is constrained to [min, max]."""
        if min_actual <= wish <= max_actual:
            return 0.0
        best = min_actual if wish < min_actual else max_actual
        return count_penalty(best, wish, fair, k_unfair=k_unfair)

    floor_violations = {}
    wd_floor = _floor_for(ext_wd, ext_wd + avail_workday,
                          target_wd, worker.fair_wd)
    if wd_floor > 0:
        floor_violations["count_workday"] = wd_floor

    wk_floor = _floor_for(ext_wk, ext_wk + avail_weekend,
                          target_wk, worker.fair_wk)
    if wk_floor > 0:
        floor_violations["count_weekend"] = wk_floor

    fair_total = worker.fair_wd + worker.fair_wk
    tot_floor = _floor_for(ext_total, ext_total + avail_total,
                           target_total, fair_total)
    if tot_floor > 0:
        floor_violations["count_total"] = tot_floor

    # Friday: wish == fair == ideal_fridays, k_unfair=0 (pure symmetric).
    fri_floor = _floor_for(0, avail_friday, target_fri, target_fri,
                           k_unfair=0.0)
    if fri_floor > 0:
        floor_violations["friday"] = fri_floor

    _, floor = split_penalty(floor_violations, weight=stage_weight)

    worker.n_days_blocked_fraction = n_blocked / len(date_idx)
    worker.availability_handicap   = floor

    print(f"  {worker_key}: floor={floor:.3f}  "
          f"blocked={worker.n_days_blocked_fraction:.1%}  "
          f"avail(wd/fri/wk)={avail_workday}/{avail_friday}/{avail_weekend}")
    return floor

    print(f"  {worker_key}: floor={floor:.3f}  "
          f"blocked={worker.n_days_blocked_fraction:.1%}")
    return floor


# ── Core violation counting ───────────────────────────────────────────────────

def _count_violations_for_worker(
    key: str, cw: Worker,
    workers_str: str, cal: dict, date_idx: list,
    ideal_fridays: float
) -> dict:
    """Return {violation_type: count} for one worker in one sequence."""

    letter  = cw.letter
    n       = len(workers_str)
    min_int = int(cw.min_interval) + 1
    lwd     = cw.limit_workday
    lwk     = cw.limit_weekend

    duties_p       = []
    duties_friday  = []
    duties_weekend = []

    for i in range(n):
        if workers_str[i] != letter:
            continue
        idx = cal[date_idx[i]].index
        if   idx == 1.125: duties_p.append(i)
        elif idx == 1.01:  duties_p.append(i)
        elif idx == 1.25:  duties_friday.append(i)
        elif idx in (1.3, 1.37, 1.6): duties_weekend.append(i)

    duties_pv = sorted(set(duties_friday + duties_weekend))
    duties_p  = sorted(set(duties_p      + duties_friday))
    duties    = sorted(set(duties_p      + duties_pv))

    # ── Cross-group extension ─────────────────────────────────────────────────
    # external_duties = dates this worker has shifts in OTHER groups (when
    # one group is being scheduled at a time). They participate in:
    #   - spacing/interval/destroyed_weekend/consec_wk_weeks  (via duties_*_ext)
    #   - count_workday/count_weekend/count_total             (via ext_workday/
    #     ext_weekend below) — externals are pre-spent budget against the
    #     doctor's quarterly limit, so a doctor in {střední, mladí} with
    #     5 střední shifts already booked sees their mladí placements capped
    #     at (limit - 5) rather than getting a fresh full quota.
    # They still do NOT participate in friday or month_target_dev (those are
    # distribution rules scoped to the current group).
    ext_pv_extra  = []
    ext_all_extra = []
    ext_workday   = 0
    ext_weekend   = 0
    if cw.external_duties:
        date_to_idx = {ds: ix for ix, ds in enumerate(date_idx)}
        for d in cw.external_duties:
            ix = date_to_idx.get(d)
            if ix is None:
                continue
            cidx = cal[d].index
            if cidx == 1.25 or cidx in (1.3, 1.37, 1.6):
                ext_pv_extra.append(ix)
            ext_all_extra.append(ix)
            if cidx in (1.125, 1.01, 1.25):
                ext_workday += 1
            elif cidx in (1.3, 1.37, 1.6):
                ext_weekend += 1

    duties_pv_ext = sorted(set(duties_pv + ext_pv_extra)) if ext_pv_extra else duties_pv
    duties_ext    = sorted(set(duties    + ext_all_extra)) if ext_all_extra else duties

    violations = {}

    # ── Convex zoned count penalties ──────────────────────────────────────────
    # See count_penalty() docstring + MIN_SPAN/K_UNFAIR constants. Each of these
    # carries a float magnitude (not an integer violation count); split_penalty
    # routes count_* and friday through the FLOAT_COUNT_TYPES branch.
    #
    # Externals count toward the totals so a multi-group doctor's per-quarter
    # limit is total-across-groups, not per-group.

    # ── Weekend count ──────────────────────────────────────────────────────────
    n_wk = len(duties_weekend) + ext_weekend
    wk_pen = count_penalty(n_wk, float(lwk), cw.fair_wk)
    if wk_pen > 0:
        violations["count_weekend"] = wk_pen

    # ── Workday count ──────────────────────────────────────────────────────────
    n_wd = len(duties_p) + ext_workday
    wd_pen = count_penalty(n_wd, float(lwd), cw.fair_wd)
    if wd_pen > 0:
        violations["count_workday"] = wd_pen

    # ── Total count ───────────────────────────────────────────────────────────
    n_total    = len(duties) + ext_workday + ext_weekend
    wish_total = float(lwd) + float(lwk)
    fair_total = cw.fair_wd + cw.fair_wk
    tot_pen = count_penalty(n_total, wish_total, fair_total)
    if tot_pen > 0:
        violations["count_total"] = tot_pen

    # ── Friday distribution ───────────────────────────────────────────────────
    # No per-doctor wish exists for fridays — everyone targets the equal share
    # `ideal_fridays`. Pass wish == fair so the unfair harsh zone never fires
    # (k_unfair=0 path): just a symmetric (actual - ideal)^2 / MIN_SPAN^2 curve.
    n_fri = len(duties_friday)
    fri_pen = count_penalty(n_fri, float(ideal_fridays), float(ideal_fridays),
                            k_unfair=0.0)
    if fri_pen > 0:
        violations["friday"] = fri_pen

    # ── Weekend spacing (no two premium days within 10 days) ─────────────────
    # Uses duties_pv_ext = same-group premium days + cross-group external premium
    # days, so a Mladí weekend bump-against a Střední Friday for the same doctor
    # fires the spacing penalty.
    spacing_v = 0
    for xx in range(1, len(duties_pv_ext)):
        if duties_pv_ext[xx] - duties_pv_ext[xx - 1] < 10:
            spacing_v += 1
    if spacing_v:
        violations["weekend_spacing"] = spacing_v

    # ── Destroyed weekend (two premium days within ≤3 days) ──────────────────
    # Catches Fri+Sun in the same week (gap=2) and similar back-to-back premium
    # patterns, including across groups. Saša's rule: "almost never allow Fri+Sun
    # unless the doctor asked for it AND has tight constraints elsewhere." We
    # waive the penalty when both days are in the doctor's desired_duty — soft
    # penalty alone lets the GA still place them there if no alternative scores
    # better.
    desired_set = set(cw.desired_duty)
    destroyed_v = 0
    for xx in range(1, len(duties_pv_ext)):
        gap = duties_pv_ext[xx] - duties_pv_ext[xx - 1]
        if gap <= 3:
            d_a = date_idx[duties_pv_ext[xx - 1]]
            d_b = date_idx[duties_pv_ext[xx]]
            if d_a in desired_set and d_b in desired_set:
                continue   # doctor explicitly asked for both — allow
            destroyed_v += 1
    if destroyed_v:
        violations["destroyed_weekend"] = destroyed_v

    # ── Consecutive weekend-weeks penalty ─────────────────────────────────────
    # ISO-week-numbered union over same-group + cross-group premium days, so
    # a Mladí weekend in week N and a Střední weekend in week N+1 (same doctor)
    # correctly counts as consecutive weekend-weeks.
    premium_weeks = set()
    for i in duties_pv_ext:
        ds = date_idx[i]
        d  = datetime.strptime(ds, "%Y-%m-%d")
        premium_weeks.add(d.isocalendar()[1])   # ISO week number

    consec_wk_v = 0
    sorted_wks  = sorted(premium_weeks)
    for xx in range(1, len(sorted_wks)):
        if sorted_wks[xx] - sorted_wks[xx - 1] == 1:
            consec_wk_v += 1
    if consec_wk_v:
        violations["consec_wk_weeks"] = consec_wk_v

    # ── Min-interval violations ───────────────────────────────────────────────
    # Shortfall-scaled: each "missing day of rest" between shifts counts as one
    # violation. With min_int=8 (Saša's setting=7 + 1 fence-post), gap=7 →
    # 1 violation, gap=5 → 3, gap=2 (Mon→Wed) → 6. The geometric within_type_cost
    # then makes very short gaps and *multiple* short pairs compound steeply.
    # gap==1 is still escalated to critical (legal/safety constraint, P=100k).
    # Uses duties_ext = same-group + cross-group duties so a Mladí Mon/Wed pair
    # adjacent to a Střední Sat for the same doctor correctly fires interval.
    interval_v  = 0
    critical_v  = 0
    counter     = 0
    for xx in range(1, len(duties_ext)):
        gap = duties_ext[xx] - duties_ext[xx - 1]
        if gap < min_int:
            counter += 1
            if gap == 1:
                critical_v += 1
            else:
                interval_v += (min_int - gap)
    if critical_v:
        violations["critical"]  = critical_v
    if interval_v:
        violations["interval"]  = interval_v

    # ── Per-month target deviation ────────────────────────────────────────────
    # Each doctor has a per-month TOTAL target proportional to their availability
    # in that month vs their total quarter availability. Penalize sum of
    # |actual - target| across months, with ±1 per-month tolerance.
    #
    # Replaces the older within-doctor month_uniformity / month_weekend_uniformity
    # penalties, which actively worked against availability-driven asymmetry
    # (1+4+3 was worse than 1+2+3 — the opposite of Saša's rule).
    #
    # Saša's rule: "level each month against peers, ignore prior months when
    # leveling. 1+4+3 with forced-low Jan is fine; 1+2+3 compensating down is not."
    # An availability-weighted target naturally encodes this:
    #   doctor on holiday in Jan (avail=1, 30, 30) with total target 9
    #     → targets ≈ (0.15, 4.43, 4.43)
    #   actual 1+4+3 → deviation (0.85, 0.43, 1.43) − 1.0 tolerance ≈ 0.43 → 0
    #   actual 1+2+3 → deviation (0.85, 2.43, 1.43) − 1.0 tolerance ≈ 1.86 → 2 vio
    if duties:
        all_months = sorted({date_idx[i][:7] for i in range(len(date_idx))})
        if len(all_months) > 1:
            # This worker's per-month availability (days where the calendar
            # still allows them to be placed — narrowed by undesired_duty,
            # other workers' desired_duty exclusivity, and overrides).
            avail_per_month = {m: 0 for m in all_months}
            for i in range(n):
                if letter in cal[date_idx[i]].possible_duty:
                    avail_per_month[date_idx[i][:7]] += 1
            total_avail = sum(avail_per_month.values())

            if total_avail > 0:
                # Resolve the worker's quarter total target. By the time we
                # reach the scorer, both 'X' workers (resolved via update_workers_ideal)
                # and numeric workers have integer-ish limits. Mirrors the
                # int(worker.limit_*) usage in compute_availability_handicap.
                try:
                    total_target = int(lwd) + int(lwk)
                except (TypeError, ValueError):
                    total_target = 0

                if total_target > 0:
                    actual_per_month = {m: 0 for m in all_months}
                    for i in duties:
                        actual_per_month[date_idx[i][:7]] += 1

                    total_dev = 0.0
                    for m in all_months:
                        target_m = total_target * (avail_per_month[m] / total_avail)
                        diff = abs(actual_per_month[m] - target_m)
                        if diff > 1.0:
                            total_dev += diff - 1.0   # ±1 per-month tolerance

                    if total_dev > 0.0:
                        violations["month_target_dev"] = int(round(total_dev))

    return violations


# ── Sequence scoring ──────────────────────────────────────────────────────────

def score_sequence(
    seq: Sequence,
    workers: dict, cal: dict, date_idx: list,
    ideal_fridays: float, stage_weight: float,
    update_personal_bests: bool = True
) -> ScheduleScore:
    """Full scoring: build WorkerScore for each doctor, aggregate."""

    worker_scores = {}
    for key, cw in workers.items():
        vcounts = _count_violations_for_worker(
            key, cw, seq.workers, cal, date_idx, ideal_fridays)

        critical, soft = split_penalty(vcounts, weight=stage_weight)
        floor    = cw.availability_handicap     # soft-only floor
        adjusted = max(0.0, soft - floor) + critical
        raw      = critical + soft               # for diagnostic display

        ws = WorkerScore(
            key=key, raw_penalty=raw, floor=floor,
            adjusted=adjusted, violations=vcounts)
        worker_scores[key] = ws

    # Personal best tracking
    if update_personal_bests:
        for key, ws in worker_scores.items():
            if key not in personal_bests or ws.adjusted < personal_bests[key].adjusted:
                personal_bests[key] = ws
                ws.at_personal_best  = True

    # Mark at_personal_best on current scores
    for key, ws in worker_scores.items():
        if key in personal_bests and ws.adjusted <= personal_bests[key].adjusted:
            ws.at_personal_best = True

    adjusteds = [ws.adjusted for ws in worker_scores.values()]
    total_adj = sum(adjusteds)
    variance  = (sum((a - total_adj / len(adjusteds)) ** 2 for a in adjusteds)
                 / len(adjusteds)) if adjusteds else 0.0
    at_best   = sum(1 for ws in worker_scores.values() if ws.at_personal_best)

    return ScheduleScore(
        workers_string   = seq.workers,
        total_adjusted   = total_adj,
        penalty_variance = variance,
        workers_at_best  = at_best,
        worker_scores    = worker_scores,
    )


# ── Evaluate with cache ───────────────────────────────────────────────────────

def evaluate(
    seq: Sequence,
    workers: dict, cal: dict, date_idx: list,
    ideal_fridays: float, stage_weight: float
):
    """Score a sequence, using cache to skip recomputation of identical strings."""
    cache_key = (seq.workers, stage_weight)
    if cache_key in fitness_cache:
        # Still update personal bests even on a cache hit
        cached = fitness_cache[cache_key]
        for key, ws in cached.worker_scores.items():
            if key not in personal_bests or ws.adjusted < personal_bests[key].adjusted:
                personal_bests[key] = ws
        seq.score = cached
    else:
        seq.score = score_sequence(
            seq, workers, cal, date_idx, ideal_fridays, stage_weight)
        fitness_cache[cache_key] = seq.score


def evaluate_population(
    island: Island, workers: dict, cal: dict, date_idx: list,
    ideal_fridays: float, stage_weight: float
):
    max_f = -2_000_000.0
    min_f =  2_000_000.0
    for seq in island.sequences:
        evaluate(seq, workers, cal, date_idx, ideal_fridays, stage_weight)
        f = seq.fitness
        if f > max_f: max_f = f
        if f < min_f: min_f = f
    island.max_fitness = max_f
    island.min_fitness = min_f


# ── Archive ───────────────────────────────────────────────────────────────────

_best_global_score: Optional[ScheduleScore] = None


def maybe_archive(seq: Sequence, cycle: int, island_name: str, stage: int):
    """Write to archive if this sequence sets a new global or per-worker record."""
    global _best_global_score
    if seq.score is None:
        return

    new_global = (_best_global_score is None or
                  seq.score.is_better_than(_best_global_score))
    new_worker = any(
        ws.at_personal_best for ws in seq.score.worker_scores.values())

    if new_global or new_worker:
        record = {
            "timestamp":   datetime.utcnow().isoformat(),
            "cycle":       cycle,
            "stage":       stage,
            "island":      island_name,
            "new_global":  new_global,
            **seq.score.to_dict(),
        }
        with ArchiveFile.open("a") as f:
            f.write(json.dumps(record) + "\n")

    if new_global:
        _best_global_score = seq.score


def save_best_per_worker():
    """Write the personal best for each worker to a readable JSON file."""
    out = {}
    for key, ws in personal_bests.items():
        out[key] = {
            "adjusted_penalty": ws.adjusted,
            "raw_penalty":      ws.raw_penalty,
            "floor":            ws.floor,
            "violations":       ws.violations,
        }
    with BestPerWorkerFile.open("w") as f:
        json.dump(out, f, indent=2)
    print(f"\nPer-worker bests saved to {BestPerWorkerFile}")


# ── Sequence generation ───────────────────────────────────────────────────────

def random_sequence(cal: dict, date_idx: list) -> Sequence:
    s = "".join(random.choice(cal[ds].possible_duty) for ds in date_idx)
    novelty_archive.add(s)
    return Sequence(s)


def initial_population(size: int, cal: dict, date_idx: list) -> list:
    return [random_sequence(cal, date_idx) for _ in range(size)]


# ── Selection ─────────────────────────────────────────────────────────────────

def tournament_select(sequences: list, k: int = TOURNAMENT_K) -> Sequence:
    contestants = random.sample(sequences, min(k, len(sequences)))
    # Best = lowest total_adjusted penalty → highest .fitness
    return max(contestants, key=lambda s: s.fitness)


# ── Crossover ─────────────────────────────────────────────────────────────────

def uniform_week_crossover(pA: str, pB: str, breaks: list):
    """Per-week coin flip → 2^N_weeks distinct combination patterns per pair."""
    segments = []
    prev = 0
    for br in breaks:
        segments.append(slice(prev, br))
        prev = br
    segments.append(slice(prev, len(pA)))

    cA, cB = [], []
    for sl in segments:
        if random.random() < 0.5:
            cA.append(pA[sl]); cB.append(pB[sl])
        else:
            cA.append(pB[sl]); cB.append(pA[sl])
    return "".join(cA), "".join(cB)


# ── Mutation ──────────────────────────────────────────────────────────────────

def mutate_string(s: str, rate: float, cal: dict, date_idx: list) -> str:
    chars = list(s)
    for i, ds in enumerate(date_idx):
        if random.randint(0, 100) < rate:
            chars[i] = random.choice(cal[ds].possible_duty)
    return "".join(chars)


def make_novel(s: str, rate: float, cal: dict, date_idx: list) -> str:
    candidate = s
    for attempt in range(MAX_REGEN_TRIES):
        if candidate not in novelty_archive:
            break
        boosted   = min(rate * (1.5 ** (attempt + 1)), 70)
        candidate = mutate_string(candidate, boosted, cal, date_idx)
    novelty_archive.add(candidate)
    return candidate


# ── Breeding ──────────────────────────────────────────────────────────────────

def breed_population(island: Island, cal: dict, date_idx: list, breaks: list):
    size        = PopulationSize
    elite_count = max(1, int(size * ElitePercentage))
    rate        = island.mutation_rate
    seqs        = island.sequences

    new_seqs = [Sequence(island.best.workers)] * elite_count

    while len(new_seqs) < size:
        pA = tournament_select(seqs).workers
        pB = tournament_select(seqs).workers
        cA, cB = uniform_week_crossover(pA, pB, breaks)
        cA = mutate_string(cA, rate, cal, date_idx)
        cB = mutate_string(cB, rate, cal, date_idx)
        cA = make_novel(cA, rate, cal, date_idx)
        cB = make_novel(cB, rate, cal, date_idx)
        new_seqs.append(Sequence(cA))
        if len(new_seqs) < size:
            new_seqs.append(Sequence(cB))

    island.sequences = new_seqs


# ── Island management ─────────────────────────────────────────────────────────

def update_island_best(island: Island):
    local_best = max(island.sequences, key=lambda s: s.fitness)
    if local_best.is_better_than(island.best):
        island.best       = local_best
        island.stagnation = 0
        island.mutation_rate = BASE_MUTATION_RATE
    else:
        island.stagnation += 1
        if island.stagnation >= STAGNATION_LIMIT:
            island.mutation_rate = min(
                BASE_MUTATION_RATE * MUTATION_BOOST_FACTOR, 60)


def migrate_between_islands(islands: list):
    """Circular migration: best of island[i] → worst slot of island[i+1]."""
    n     = len(islands)
    bests = [isl.best for isl in islands]
    for i in range(n):
        donor  = bests[i]
        target = islands[(i + 1) % n]
        worst_idx = min(range(len(target.sequences)),
                        key=lambda j: target.sequences[j].fitness)
        target.sequences[worst_idx] = Sequence(donor.workers, donor.score)
        novelty_archive.add(donor.workers)


def seed_islands_from(seed_seq: Sequence, cal: dict, date_idx: list) -> list:
    """Create fresh island population warm-started from seed_seq.

    The seed is the elite; the rest are mutations of it at increasing distance
    so the island starts with diversity around the seed rather than random noise.

    NOTE: we do NOT set `isl.best = seed_seq` here. seed_seq carries a score
    computed at the *previous* stage's weight, which is incomparable with
    scores at the current stage's weight. Setting it as island.best caused the
    early-exit branch (`if global_best.fitness == 0: break`) to fire on every
    stage after the first, because stage 0 produces total_adjusted=0 (weight=0
    zeroes all soft penalties) and that stale 0 looks "better" than any real
    stage 2/3 score. Leaving island.best at its default Sequence() lets the
    initial evaluation + update_island_best pick the freshly-scored elite from
    the population (seqs[0]) as the new best.
    """
    islands = []
    for name in ISLAND_NAMES:
        seqs = [Sequence(seed_seq.workers)]   # elite seed (will be re-scored)
        for j in range(1, PopulationSize):
            # Mutation rate scales up to 40% for far-out exploration
            rate = BASE_MUTATION_RATE + (j / PopulationSize) * 35
            s    = mutate_string(seed_seq.workers, rate, cal, date_idx)
            s    = make_novel(s, rate, cal, date_idx)
            seqs.append(Sequence(s))
        islands.append(Island(name, seqs))
    return islands


# ── Output ────────────────────────────────────────────────────────────────────

def print_schedule(workers: dict, cal: dict, date_idx: list, best: Sequence):
    letter_to_name = {w.letter: k for k, w in workers.items()}
    print("\n── Final Schedule ──")
    print("           ", end="")
    for key in workers:
        print(f"{key[:4]:5}", end="")
    print()
    for ds in date_idx:
        assigned = cal[ds].worker
        print(f"{ds} ", end="")
        for key, w in workers.items():
            if key == assigned:
                ok = w.letter in cal[ds].possible_duty
                print(" X! " if not ok else " X  ", end="")
            else:
                print("    ", end="")
        print()


def print_score_summary(score: ScheduleScore):
    print(f"\n── Score Summary ──")
    print(f"  Total adjusted penalty : {score.total_adjusted:.3f}")
    print(f"  Penalty variance       : {score.penalty_variance:.3f}")
    print(f"  Workers at personal best: {score.workers_at_best}/{len(score.worker_scores)}")
    print()
    for key, ws in sorted(score.worker_scores.items()):
        star = "★" if ws.at_personal_best else " "
        print(f"  {star} {key:15s}  "
              f"raw={ws.raw_penalty:7.3f}  floor={ws.floor:7.3f}  "
              f"adj={ws.adjusted:7.3f}  "
              f"violations={ws.violations}")


def save_results(cal: dict, date_idx: list):
    with open("results.txt", "w") as f:
        for ds in date_idx:
            name = cal[ds].worker or "????"
            f.write(name[:4] + "\n")


# ── Stage runner ──────────────────────────────────────────────────────────────

def run_stage(
    stage_idx:    int,
    cycles:       int,
    weight:       float,
    seed_seq:     Optional[Sequence],
    workers:      dict,
    cal:          dict,
    date_idx:     list,
    ideal_fridays:float,
    crossover_breaks: list,
) -> Sequence:
    """Run one stage of the GA.  Returns the best Sequence found."""

    print(f"\n{'═'*60}")
    print(f" Stage {stage_idx + 1}  |  cycles={cycles}  "
          f"penalty_weight={weight:.1f}")
    print(f"{'═'*60}")

    # Recompute handicaps at each stage weight so floors are comparable
    print("Computing availability floors...")
    for key, w in workers.items():
        compute_availability_handicap(
            key, w, cal, date_idx, workers, ideal_fridays, weight)

    # Initialise or warm-start islands
    if seed_seq is None:
        islands = []
        for name in ISLAND_NAMES:
            seqs = initial_population(PopulationSize, cal, date_idx)
            islands.append(Island(name, seqs))
            print(f"  Island {name} initialised (random).")
    else:
        islands = seed_islands_from(seed_seq, cal, date_idx)
        print(f"  All islands warm-started from seed "
              f"(fitness={seed_seq.fitness:.3f}).")

    # Initial evaluation
    for isl in islands:
        evaluate_population(isl, workers, cal, date_idx, ideal_fridays, weight)
        update_island_best(isl)

    global_best = max(islands, key=lambda isl: isl.best.fitness).best
    flow        = []

    for cycle in range(cycles):
        if global_best.fitness == 0:
            break

        for isl in islands:
            breed_population(isl, cal, date_idx, crossover_breaks)
            evaluate_population(isl, workers, cal, date_idx, ideal_fridays, weight)
            update_island_best(isl)
            maybe_archive(isl.best, cycle, isl.name, stage_idx)

        cycle_best = max(islands, key=lambda isl: isl.best.fitness).best
        if cycle_best.is_better_than(global_best):
            global_best = cycle_best

        if (cycle + 1) % MIGRATION_INTERVAL == 0:
            migrate_between_islands(islands)

        flow.append(global_best.fitness)

        stag = " ".join(f"{isl.name[:2]}:{isl.stagnation}" for isl in islands)
        print(f"  {(cycle+1)/cycles*100:5.1f}%  "
              f"best={global_best.fitness:>12.4f}  "
              f"cache={len(fitness_cache):>6}  "
              f"archive={len(novelty_archive):>6}  "
              f"stag=[{stag}]",
              end="\r")

    print(f"\n  Stage {stage_idx + 1} complete.  "
          f"Best fitness: {global_best.fitness:.4f}")
    return global_best


# ── Library entry-point (file-free) ───────────────────────────────────────────
#
# The CLI block below (`if __name__ == "__main__":`) is preserved bit-for-bit
# so existing workflows keep working. The functions here are pure-data
# alternatives that let the GA be called from another Python process (or from
# Pyodide in a browser) without any file I/O.

def build_calendar(first_day: datetime, last_day: datetime,
                   holidays: Optional[dict] = None) -> dict:
    """File-free version of calendar_genesis.

    holidays: {date_str: float}  — overrides the default day_type weight for
                                   that date (e.g. national holiday → 1.6).
    """
    holidays = holidays or {}
    day_type = {1: 1.125, 2: 1.125, 3: 1.125, 4: 1.01,
                5: 1.25,  6: 1.37,  7: 1.3}
    n   = (last_day - first_day).days + 1
    cal = {}
    for i in range(n):
        d  = first_day + timedelta(days=i)
        ds = d.strftime("%Y-%m-%d")
        cal[ds] = DayOfLife(day_type[d.isoweekday()])
        if ds in holidays:
            cal[ds].index = float(holidays[ds])
    return cal


def apply_availability(cal: dict, workers: dict,
                       overrides: Optional[dict] = None) -> dict:
    """File-free version of calendar_availability.

    overrides: {date_str: worker_name} — pins that day to that worker
                                         (the optimizer-side 'lock' primitive).
    """
    overrides = overrides or {}
    for day, d in cal.items():
        d.possible_duty = [w.letter for w in workers.values()
                           if day not in w.undesired_duty]
    for day, d in cal.items():
        desired = [w.letter for w in workers.values()
                   if day in w.desired_duty]
        if desired:
            d.possible_duty = desired
    for day, name in overrides.items():
        if day in cal and name in workers:
            cal[day].possible_duty = [workers[name].letter]
    return cal


def optimize(
    workers:        dict,
    start:          tuple,                    # (year, month, day)
    end:            tuple,                    # (year, month, day)
    holidays:       Optional[dict] = None,    # {date_str: float}
    overrides:      Optional[dict] = None,    # {date_str: worker_name} = locks
    stage_cycles:   Optional[list] = None,    # default: STAGE_CYCLES
    stage_weights:  Optional[list] = None,    # default: STAGE_WEIGHTS
) -> dict:
    """Library entry-point. Runs the 3-stage island GA on in-memory dicts.

    Workers should be the same shape as load_worker_sources returns:
        {name: Worker} where each Worker has limit_workday, limit_weekend,
        employment, min_interval, desired_duty, undesired_duty set.
        Letters are assigned automatically here.

    Returns:
        {
            "assignments":  {date_str: worker_name, ...},
            "score":        {"total_adjusted": float,
                             "variance":       float,
                             "workers_at_best": int},
            "elapsed_sec":  float,
        }
    """
    t0 = time.time()

    # Reset module-level state so consecutive calls don't leak.
    global _best_global_score
    fitness_cache.clear()
    novelty_archive.clear()
    personal_bests.clear()
    _best_global_score = None

    # Assign letters to workers.
    abeceda = SourceAbeceda[:len(workers)]
    for i, key in enumerate(workers):
        workers[key].letter = abeceda[i]

    first_day = datetime(*start)
    last_day  = datetime(*end)

    cal = build_calendar(first_day, last_day, holidays)
    cal = apply_availability(cal, workers, overrides)

    ideal_fridays      = get_ideal_friday(workers, cal)
    ideal_wd, ideal_wk = timespan_ideal_values(cal, workers)
    workers            = update_workers_ideal(workers, ideal_wd, ideal_wk)
    crossover_breaks   = get_crossover_breaks(cal, first_day)
    n_days             = len(cal)
    date_idx           = make_date_index(first_day, n_days)

    cycles_  = stage_cycles  if stage_cycles  is not None else STAGE_CYCLES
    weights_ = stage_weights if stage_weights is not None else STAGE_WEIGHTS

    best_seq = None
    for stage_idx, (cycles, weight) in enumerate(zip(cycles_, weights_)):
        best_seq = run_stage(
            stage_idx, cycles, weight, best_seq,
            workers, cal, date_idx, ideal_fridays, crossover_breaks)

    letter_to_name = {w.letter: key for key, w in workers.items()}
    assignments = {ds: letter_to_name.get(best_seq.workers[i], None)
                   for i, ds in enumerate(date_idx)}

    score_summary = {
        "total_adjusted":  best_seq.score.total_adjusted    if best_seq.score else 0.0,
        "variance":        best_seq.score.penalty_variance  if best_seq.score else 0.0,
        "workers_at_best": best_seq.score.workers_at_best   if best_seq.score else 0,
    }

    return {
        "assignments": assignments,
        "score":       score_summary,
        "elapsed_sec": time.time() - t0,
    }


# ── Main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    t0 = time.time()
    ArchiveFile.unlink(missing_ok=True)   # fresh archive each run

    # ── Setup ─────────────────────────────────────────────────────────────────
    workers, abeceda = load_worker_sources(WorkersFilename)
    first_day        = datetime(*START)
    last_day         = datetime(*END)
    cal              = calendar_genesis(first_day, last_day)
    cal              = calendar_availability(cal, workers)

    ideal_fridays        = get_ideal_friday(workers, cal)
    ideal_wd, ideal_wk   = timespan_ideal_values(cal, workers)
    workers              = update_workers_ideal(workers, ideal_wd, ideal_wk)
    crossover_breaks     = get_crossover_breaks(cal, first_day)
    n_days               = len(cal)
    date_idx             = make_date_index(first_day, n_days)

    print(f"\nCalendar : {n_days} days")
    print(f"Workers  : {len(workers)}")
    print(f"Breaks   : {len(crossover_breaks)} week boundaries")
    print(f"Stages   : {list(zip(STAGE_CYCLES, STAGE_WEIGHTS))}")

    # ── Three-stage evolution ─────────────────────────────────────────────────
    best_seq = None
    for stage_idx, (cycles, weight) in enumerate(zip(STAGE_CYCLES, STAGE_WEIGHTS)):
        best_seq = run_stage(
            stage_idx, cycles, weight, best_seq,
            workers, cal, date_idx, ideal_fridays, crossover_breaks)

    # ── Finalise calendar ─────────────────────────────────────────────────────
    letter_to_name = {w.letter: key for key, w in workers.items()}
    for i, ds in enumerate(date_idx):
        cal[ds].worker = letter_to_name.get(best_seq.workers[i], "????")

    # ── Output ────────────────────────────────────────────────────────────────
    print_schedule(workers, cal, date_idx, best_seq)
    if best_seq.score:
        print_score_summary(best_seq.score)

    save_results(cal, date_idx)
    save_best_per_worker()

    print(f"\nArchive  : {ArchiveFile}  "
          f"({ArchiveFile.stat().st_size // 1024} KB)")
    print(f"Elapsed  : {time.time() - t0:.1f}s")
    print(f"Cache    : {len(fitness_cache)} entries")
    print(f"Archive  : {len(novelty_archive)} unique sequences evaluated")
