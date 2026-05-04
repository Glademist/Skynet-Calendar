// optimizerWorker.js — Pyodide host for the SKYNET GA.
//
// Commands:
//   { cmd: 'smoke' }
//       Load Pyodide + module, run trivial sanity tests.
//   { cmd: 'phase1_test' }
//       Run skynet.optimize() against an 8-doctor / 28-day synthetic dataset
//       in quick mode. Validates the library refactor end-to-end.
//   { cmd: 'run_real', payload: { workers, holidays, overrides, start, end, quick } }
//       Run skynet.optimize() against real data assembled by the React panel
//       from Firestore. `workers` is a {name: spec} dict where each spec has
//       limit_workday/weekend (string), employment (number), min_interval (int),
//       desired_duty / undesired_duty (date-string arrays). Returns
//       {assignments, score, elapsed_sec} same as the synthetic test.

importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js');

const log = (msg) => self.postMessage({ type: 'log', msg });
const ok  = (data) => self.postMessage({ type: 'ok', data });
const err = (msg) => self.postMessage({ type: 'error', msg });

// Cache the Pyodide instance + imported module across commands so a second
// click within the same Worker doesn't re-download Pyodide. The React side
// terminates the Worker on every run today, so this only matters within a
// single command — but the structure makes it easy to remove terminate() later.
let _pyodide = null;
let _moduleLoaded = false;

async function ensurePyodide() {
  if (_pyodide) return _pyodide;
  log('Loading Pyodide runtime…');
  const t0 = performance.now();
  _pyodide = await loadPyodide();
  log(`Pyodide ${_pyodide.version} ready (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
  return _pyodide;
}

async function ensureModule() {
  const py = await ensurePyodide();
  if (_moduleLoaded) return py;
  log('Fetching /skynet_v08_claude.py …');
  const res = await fetch('/skynet_v08_claude.py');
  if (!res.ok) throw new Error(`Fetch failed (${res.status}). Is the file in /public?`);
  const source = await res.text();
  log(`  ${source.length} chars`);
  py.FS.writeFile('skynet.py', source);
  py.runPython(`
import sys
if '' not in sys.path:
    sys.path.insert(0, '')
import skynet
`);
  log('Module imported (no __main__ executed).');
  _moduleLoaded = true;
  return py;
}

self.onmessage = async (e) => {
  const { cmd } = e.data || {};
  try {
    if (cmd === 'smoke') {
      const py = await ensureModule();

      log('Test 1: skynet.make_date_index(2026-01-01, 5)');
      const dates = py.runPython(`
from datetime import datetime
skynet.make_date_index(datetime(2026, 1, 1), 5)
`).toJs();
      log(`  → ${JSON.stringify(dates)}`);

      log('Test 2: skynet.within_type_cost(3) — 1 + 1.5 + 2.25');
      const cost = py.runPython('skynet.within_type_cost(3)');
      log(`  → ${cost.toFixed(4)}  (expected 4.7500)`);

      log('Test 3: instantiate skynet.Worker');
      const wInfo = py.runPython(`
w = skynet.Worker()
w.letter = "A"; w.employment = 1.0; w.min_interval = 7
f"Worker(letter={w.letter}, employment={w.employment}, interval={w.min_interval})"
`);
      log(`  → ${wInfo}`);

      log('Test 4: instantiate skynet.DayOfLife');
      const dInfo = py.runPython(`
d = skynet.DayOfLife(1.25)
d.possible_duty = ["A", "B"]
f"DayOfLife(index={d.index}, possible={d.possible_duty})"
`);
      log(`  → ${dInfo}`);

      log('Test 5: confirm skynet.optimize is callable');
      const isCallable = py.runPython('callable(skynet.optimize)');
      log(`  → ${isCallable}`);

      log('\nAll smoke tests passed.');
      ok({ dates, cost, wInfo, dInfo, optimizeCallable: isCallable });
      return;
    }

    if (cmd === 'phase1_test') {
      const py = await ensureModule();

      log('Building synthetic input: 8 doctors × 28 days (Jan 2026, mladí-sized group)…');
      log('  Flexible limits ("X") → ideals computed dynamically from calendar.');
      log('  Each doctor has 2–4 vacation days; min_interval=7.');
      log('  Stage cycles: [20, 30, 20]  (quick — full would be [80, 120, 100])');
      log('  Pyodide stdout from the GA goes to the browser console (F12).\n');

      const t0 = performance.now();
      const proxy = py.runPython(`
# 8 doctors over 28 days with 'X' limits (flexible) — matches real production
# patterns (mladí has 8 doctors). Each doctor has a small vacation block.
# Average per doctor: ~2 weekdays + ~1.5 weekend duties = 3-4 shifts in 28 days,
# which respects min_interval=7 comfortably.
workers_spec = [
    # name, lim_wd, lim_wk, interval, undesired (vacation/blocked)
    ('A', 'X', 'X', 7, ['2026-01-05','2026-01-06']),
    ('B', 'X', 'X', 7, ['2026-01-12','2026-01-13','2026-01-14']),
    ('C', 'X', 'X', 7, ['2026-01-19','2026-01-20']),
    ('D', 'X', 'X', 7, ['2026-01-26','2026-01-27']),
    ('E', 'X', 'X', 7, ['2026-01-08','2026-01-09']),
    ('F', 'X', 'X', 7, ['2026-01-15','2026-01-16','2026-01-17']),
    ('G', 'X', 'X', 7, ['2026-01-22','2026-01-23']),
    ('H', 'X', 'X', 7, ['2026-01-01','2026-01-02','2026-01-03']),
]
workers = {}
for name, lim_wd, lim_wk, interval, undesired in workers_spec:
    w = skynet.Worker()
    w.limit_workday  = lim_wd
    w.limit_weekend  = lim_wk
    w.employment     = 1.0
    w.min_interval   = interval
    w.desired_duty   = []
    w.undesired_duty = undesired
    workers[name] = w

skynet.optimize(
    workers,
    start=(2026, 1, 1),
    end=(2026, 1, 28),
    stage_cycles=[20, 30, 20],
)
`);
      const result = proxy.toJs({ dict_converter: Object.fromEntries });
      proxy.destroy();
      const wallSec = (performance.now() - t0) / 1000;

      log(`Optimization complete in ${result.elapsed_sec.toFixed(2)}s (wall ${wallSec.toFixed(2)}s)`);
      log(`Total adjusted penalty : ${result.score.total_adjusted.toFixed(3)}`);
      log(`Penalty variance       : ${result.score.variance.toFixed(3)}`);
      log(`Workers at personal best: ${result.score.workers_at_best}/4`);

      const dates = Object.keys(result.assignments).sort();
      const filled = dates.filter(d => result.assignments[d]);
      const distinctWorkers = new Set(filled.map(d => result.assignments[d]));

      log(`\nAssignments:`);
      log(`  cells filled    : ${filled.length}/${dates.length}`);
      log(`  distinct workers: ${distinctWorkers.size}  (${[...distinctWorkers].sort().join(', ')})`);

      // Per-day consecutive check (consecutive same-worker = hard violation).
      let consecutiveViolations = 0;
      for (let i = 1; i < dates.length; i++) {
        const a = result.assignments[dates[i - 1]];
        const b = result.assignments[dates[i]];
        if (a && b && a === b) consecutiveViolations++;
      }
      log(`  consecutive-day clashes: ${consecutiveViolations}  (expected 0 in a feasible solution)`);

      log('\nFirst 14 days:');
      for (let i = 0; i < Math.min(14, dates.length); i++) {
        const d = dates[i];
        log(`  ${d}  →  ${result.assignments[d] || '(unfilled)'}`);
      }

      ok({
        elapsed_sec: result.elapsed_sec,
        wall_sec: wallSec,
        score: result.score,
        cells_filled: filled.length,
        cells_total: dates.length,
        distinct_workers: distinctWorkers.size,
        consecutive_violations: consecutiveViolations,
        assignments: result.assignments,
      });
      return;
    }

    if (cmd === 'run_real') {
      const py = await ensureModule();
      const payload = e.data.payload || {};
      const { workers, holidays, overrides, start, end, quick } = payload;

      const nWorkers = Object.keys(workers || {}).length;
      const nHolidays = Object.keys(holidays || {}).length;
      const nOverrides = Object.keys(overrides || {}).length;

      log(`Real-data run: ${nWorkers} workers, ${nHolidays} holidays, ${nOverrides} locks`);
      log(`Quarter span: ${start.join('-')} → ${end.join('-')}`);
      log(`Mode: ${quick ? 'quick [40,60,50]' : 'full [80,120,100]'}`);
      log('Pyodide stdout from the GA goes to the browser console (F12).\n');

      // Hand the payload to Python via globals. Pyodide auto-converts plain
      // JS objects/arrays/primitives; .to_py() recursively turns the resulting
      // JsProxy into native Python dicts/lists.
      py.globals.set('js_workers',   workers);
      py.globals.set('js_holidays',  holidays);
      py.globals.set('js_overrides', overrides);
      py.globals.set('js_start',     start);
      py.globals.set('js_end',       end);
      py.globals.set('js_quick',     !!quick);

      const t0 = performance.now();
      const proxy = py.runPython(`
data_workers   = js_workers.to_py()
data_holidays  = js_holidays.to_py()
data_overrides = js_overrides.to_py()
start_t        = tuple(js_start.to_py())
end_t          = tuple(js_end.to_py())

workers = {}
for name, w_data in data_workers.items():
    w = skynet.Worker()
    w.limit_workday   = w_data.get('limit_workday', 'X')
    w.limit_weekend   = w_data.get('limit_weekend', 'X')
    w.employment      = float(w_data.get('employment', 1.0))
    w.min_interval    = int(w_data.get('min_interval', 7))
    w.desired_duty    = list(w_data.get('desired_duty', []))
    w.undesired_duty  = list(w_data.get('undesired_duty', []))
    # Cross-group external duties: dates this worker has shifts in OTHER
    # groups. Counted by spacing/interval/destroyed_weekend rules but not
    # by per-group count_* / month_target_dev. Empty for stand-alone runs.
    w.external_duties = list(w_data.get('external_duties', []))
    workers[name] = w

stage_cycles = [40, 60, 50] if js_quick else None  # None → defaults [80,120,100]

skynet.optimize(
    workers,
    start=start_t,
    end=end_t,
    holidays=data_holidays,
    overrides=data_overrides,
    stage_cycles=stage_cycles,
)
`);
      const result = proxy.toJs({ dict_converter: Object.fromEntries });
      proxy.destroy();
      const wallSec = (performance.now() - t0) / 1000;

      log(`\nOptimization complete in ${result.elapsed_sec.toFixed(2)}s (wall ${wallSec.toFixed(2)}s)`);
      log(`Total adjusted penalty : ${result.score.total_adjusted.toFixed(3)}`);
      log(`Penalty variance       : ${result.score.variance.toFixed(3)}`);
      log(`Workers at personal best: ${result.score.workers_at_best}/${nWorkers}`);

      const dates = Object.keys(result.assignments).sort();
      const filled = dates.filter(d => result.assignments[d]);
      const distinct = new Set(filled.map(d => result.assignments[d]));

      log(`\nAssignments:`);
      log(`  cells filled    : ${filled.length}/${dates.length}`);
      log(`  distinct workers: ${distinct.size}/${nWorkers}`);

      // Per-worker shift counts for fairness inspection
      const counts = {};
      for (const d of filled) {
        const w = result.assignments[d];
        counts[w] = (counts[w] || 0) + 1;
      }
      const sortedNames = Object.keys(workers).sort();
      log('\nPer-worker shift counts:');
      for (const n of sortedNames) {
        log(`  ${n.padEnd(20, ' ').slice(0, 20)} ${counts[n] || 0}`);
      }

      ok({
        elapsed_sec: result.elapsed_sec,
        wall_sec: wallSec,
        score: result.score,
        cells_filled: filled.length,
        cells_total: dates.length,
        distinct_workers: distinct.size,
        n_workers: nWorkers,
        per_worker_counts: counts,
        assignments: result.assignments,
      });
      return;
    }

    err(`Unknown command: ${cmd}`);
  } catch (e) {
    err(`${e.message}\n${e.stack || ''}`);
  }
};
