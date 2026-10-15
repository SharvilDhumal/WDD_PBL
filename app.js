(function () {
  "use strict";

  /* ============================================================
     Config & constants
  ============================================================ */
  var STORAGE_KEY = "ledgerline-v3";
  var SCHEMA_VERSION = 4;
  var MAX_AMOUNT = 1e9;          // ₹100 crore cap
  var MAX_DESC_LEN = 60;
  var MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  var CATS = {
    Food: { c: "#e8743b", i: "🍜" },
    Transport: { c: "#2f9bd6", i: "🚌" },
    Bills: { c: "#7a5cd6", i: "🧾" },
    Shopping: { c: "#d6459b", i: "🛍️" },
    Health: { c: "#1fa67a", i: "💊" },
    Fun: { c: "#e5b429", i: "🎬" },
    Salary: { c: "#15803d", i: "💼" },
    Other: { c: "#8791a5", i: "📦" }
  };
  var EXPENSE_CATS = ["Food", "Transport", "Bills", "Shopping", "Health", "Fun", "Other"];
  var INCOME_CATS = ["Salary", "Other"];

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var fmt = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
  var fmtDec = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function iso(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function todayISO() { return iso(new Date()); }
  function monthOf(dateStr) { return dateStr.slice(0, 7); }

  /* ============================================================
     State
  ============================================================ */
  var today = new Date();
  var thisMonth = iso(today).slice(0, 7);

  var state = {
    version: SCHEMA_VERSION,
    tx: [],
    budget: 0,
    catBudgets: {},
    lastIdSeq: 0
  };

  var ui = {
    type: "expense",
    cat: "Food",
    sortKey: "date",
    sortDir: -1,
    filterCat: "",
    filterType: "",
    lastId: null,
    hover: -1,
    anim: 1,
    segs: [],
    keys: [],
    by: {},
    total: 0,
    raf: null,
    trendRaf: null,
    trendYear: today.getFullYear(),
    editId: null,
    chartCanvas: null,
    trendCanvas: null
  };

  /* ============================================================
     Persistence with schema validation
  ============================================================ */
  function isValidTxRecord(t) {
    if (!t || typeof t !== "object") return false;
    if (typeof t.id !== "number" || !isFinite(t.id)) return false;
    if (t.type !== "income" && t.type !== "expense") return false;
    if (typeof t.desc !== "string" || !t.desc.trim()) return false;
    if (typeof t.amount !== "number" || !isFinite(t.amount) || t.amount <= 0 || t.amount > MAX_AMOUNT) return false;
    if (typeof t.cat !== "string" || !CATS[t.cat]) return false;
    if (typeof t.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(t.date)) return false;
    var dt = new Date(t.date + "T00:00:00");
    if (isNaN(dt.getTime())) return false;
    if (iso(dt) !== t.date) return false;
    var allowed = t.type === "income" ? INCOME_CATS : EXPENSE_CATS;
    if (allowed.indexOf(t.cat) < 0) return false;
    return true;
  }

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { /* storage blocked */ }
    if (!raw) return;
    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) {
      showToast("Saved data was corrupt and could not be read. Starting fresh (nothing was deleted from this device until you save).");
      return;
    }
    if (!parsed || typeof parsed !== "object") return;

    var tx = Array.isArray(parsed.tx) ? parsed.tx : [];
    var valid = [];
    var dropped = 0;
    var seenIds = Object.create(null);
    for (var i = 0; i < tx.length; i++) {
      var t = tx[i];
      if (!isValidTxRecord(t)) { dropped++; continue; }
      // de-duplicate IDs
      if (seenIds[t.id]) { t.id = nextId(); }
      seenIds[t.id] = true;
      valid.push({ id: t.id, type: t.type, desc: t.desc.trim(), amount: t.amount, cat: t.cat, date: t.date });
    }
    state.tx = valid;
    state.budget = (typeof parsed.budget === "number" && isFinite(parsed.budget) && parsed.budget >= 0)
      ? parsed.budget : 0;
    state.catBudgets = {};
    if (parsed.catBudgets && typeof parsed.catBudgets === "object") {
      Object.keys(parsed.catBudgets).forEach(function (k) {
        if (EXPENSE_CATS.indexOf(k) >= 0) {
          var v = parsed.catBudgets[k];
          if (typeof v === "number" && isFinite(v) && v >= 0) state.catBudgets[k] = v;
        }
      });
    }
    // rebuild id sequence
    var maxId = 0;
    state.tx.forEach(function (t) { if (t.id > maxId) maxId = t.id; });
    state.lastIdSeq = Math.max(state.lastIdSeq, maxId);
    if (dropped > 0) {
      showToast(dropped + " stored transaction" + (dropped === 1 ? "" : "s") + " were invalid and skipped.");
    }
  }

  function save() {
    try {
      state.version = SCHEMA_VERSION;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      showToast("Could not save to this browser's storage. Your most recent change may be lost when you reload.");
      return false;
    }
  }

  function nextId() {
    state.lastIdSeq += 1;
    return Date.now() * 1000 + (state.lastIdSeq % 1000);
  }

  /* ============================================================
     Toasts
  ============================================================ */
  function showToast(msg, actionLabel, fn) {
    var host = $("toasts");
    var t = document.createElement("div");
    t.className = "toast";
    var span = document.createElement("span");
    span.textContent = msg;
    t.appendChild(span);
    function dismiss() {
      if (!t.parentNode) return;
      t.classList.add("out");
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 250);
    }
    if (actionLabel) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = actionLabel;
      b.addEventListener("click", function () { try { fn(); } finally { dismiss(); } });
      t.appendChild(b);
    }
    host.appendChild(t);
    setTimeout(dismiss, 6000);
  }

  /* ============================================================
     Animated numbers
  ============================================================ */
  function countUp(el, to) {
    if (!el) return;
    var from = parseFloat(el.dataset.v || "0");
    if (!isFinite(from)) from = 0;
    el.dataset.v = to;
    if (reduceMotion || from === to) { el.textContent = fmt.format(to); return; }
    var start = null, dur = 550;
    function step(ts) {
      if (!start) start = ts;
      var p = Math.min(1, (ts - start) / dur);
      var e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt.format(Math.round(from + (to - from) * e));
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  /* ============================================================
     Data helpers
  ============================================================ */
  function txsForMonth(monthStr) {
    return state.tx.filter(function (t) { return monthOf(t.date) === monthStr; });
  }
  function sumByType(list, type) {
    return list.reduce(function (s, t) { return t.type === type ? s + t.amount : s; }, 0);
  }
  function monthIncome(monthStr) {
    return sumByType(txsForMonth(monthStr), "income");
  }
  function monthExpenses(monthStr, excludeId) {
    return state.tx.reduce(function (s, t) {
      if (t.type !== "expense") return s;
      if (monthOf(t.date) !== monthStr) return s;
      if (excludeId != null && t.id === excludeId) return s;
      return s + t.amount;
    }, 0);
  }
  function availableBalance(monthStr, excludeId) {
    return monthIncome(monthStr) - monthExpenses(monthStr, excludeId);
  }
  function categoryTotals(list) {
    var by = Object.create(null);
    list.forEach(function (t) {
      if (t.type !== "expense") return;
      by[t.cat] = (by[t.cat] || 0) + t.amount;
    });
    return by;
  }

  /* ============================================================
     Budget helpers
  ============================================================ */
  function budgetStatus(spent, budget) {
    if (!(budget > 0)) return { state: "unset", pct: 0, remaining: 0, excess: 0 };
    var pct = spent / budget * 100;
    var remaining = budget - spent;
    return {
      state: spent >= budget ? "over" : pct >= 90 ? "critical" : pct >= 75 ? "warn" : "ok",
      pct: pct,
      remaining: remaining,
      excess: remaining < 0 ? -remaining : 0
    };
  }

  /* ============================================================
     Render: budget + stats
  ============================================================ */
  function renderStats() {
    var month = $("month").value || thisMonth;
    var mt = txsForMonth(month);
    var inc = sumByType(mt, "income");
    var exp = sumByType(mt, "expense");
    var net = inc - exp;

    countUp($("sInc"), inc);
    countUp($("sExp"), exp);
    countUp($("sNet"), net);
    $("sNet").className = net >= 0 ? "inc" : "exp";

    var rate = $("sRate");
    if (inc > 0) {
      rate.textContent = "Savings rate " + Math.round(net / inc * 100) + "%";
    } else if (exp > 0) {
      rate.textContent = "No income recorded this month";
      rate.className = "muted exp";
    } else {
      rate.textContent = "No activity this month";
      rate.className = "muted";
    }

    var budget = state.budget;
    var status = budgetStatus(exp, budget);

    var fill = $("fill");
    var visualPct = status.state === "unset" ? 0 : Math.min(100, status.pct);
    fill.style.width = visualPct + "%";
    fill.className = "fill" + (status.state === "over" ? " bad" : status.state === "warn" || status.state === "critical" ? " warn" : "");
    $("bar").setAttribute("aria-valuenow", Math.round(status.pct));

    if (status.state === "unset") {
      $("left").textContent = "—";
      $("leftlbl").textContent = "Set a monthly budget to start tracking";
      $("budgetMeta").textContent = "";
      $("sBudgetLeft").textContent = "—";
      $("sBudgetLeft").className = "muted";
    } else if (status.state === "over") {
      $("left").textContent = fmt.format(status.excess);
      $("leftlbl").textContent = "over budget · " + Math.round(status.pct) + "% used";
      $("budgetMeta").textContent = "Spent " + fmt.format(exp) + " of " + fmt.format(budget) +
        " · exceeded by " + fmt.format(status.excess);
      $("sBudgetLeft").textContent = "−" + fmt.format(status.excess);
      $("sBudgetLeft").className = "exp";
    } else {
      $("left").textContent = fmt.format(status.remaining);
      $("leftlbl").textContent = "left to spend · " + Math.round(status.pct) + "% used";
      var metaExtra = "";
      if (status.state === "critical") metaExtra = " · critical";
      else if (status.state === "warn") metaExtra = " · warning";
      $("budgetMeta").textContent = "Spent " + fmt.format(exp) + " of " + fmt.format(budget) + metaExtra;
      $("sBudgetLeft").textContent = fmt.format(status.remaining);
      $("sBudgetLeft").className = status.state === "warn" || status.state === "critical" ? "exp" : "inc";
    }

    $("viewingLabel").textContent = "Viewing " + monthLabel(month);
    return { inc: inc, exp: exp, net: net, mt: mt, budget: budget, status: status };
  }

  function monthLabel(m) {
    if (!m || !/^\d{4}-\d{2}$/.test(m)) return "—";
    var y = m.slice(0, 4), mm = parseInt(m.slice(5, 7), 10) - 1;
    return MONTH_NAMES[mm] + " " + y;
  }

  /* ============================================================
     Doughnut chart
  ============================================================ */
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function drawChart() {
    var mt = txsForMonth($("month").value || thisMonth);
    var by = categoryTotals(mt);
    ui.keys = Object.keys(by).sort(function (a, b) { return by[b] - by[a]; });
    ui.by = by;
    ui.total = sumByType(mt, "expense");
    ui.hover = -1;

    cancelAnimationFrame(ui.raf);
    if (reduceMotion) { ui.anim = 1; paint(); return; }

    ui.anim = 0;
    var t0 = null, dur = 650;
    function frame(ts) {
      if (!t0) t0 = ts;
      var p = Math.min(1, (ts - t0) / dur);
      ui.anim = 1 - Math.pow(1 - p, 3);
      paint();
      if (p < 1) ui.raf = requestAnimationFrame(frame);
    }
    ui.raf = requestAnimationFrame(frame);
    renderLegend();
  }

  function paint() {
    var canvas = $("chart");
    if (!canvas) return;
    var dpr = window.devicePixelRatio || 1;
    var S = 200;
    if (canvas.width !== S * dpr) {
      canvas.width = S * dpr;
      canvas.height = S * dpr;
    }
    var x = canvas.getContext("2d");
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, S, S);

    var cx = S / 2, cy = S / 2, R = 92, r = 60;
    var segs = [];
    var keys = ui.keys, total = ui.total;

    if (!total) {
      x.beginPath();
      x.arc(cx, cy, R, 0, Math.PI * 2);
      x.arc(cx, cy, r, 0, Math.PI * 2, true);
      x.fillStyle = cssVar("--line-soft") || "#1a253a";
      x.fill("evenodd");
    } else {
      var a = -Math.PI / 2;
      var gap = keys.length > 1 ? 0.03 : 0;
      keys.forEach(function (k, i) {
        var sweep = ui.by[k] / total * Math.PI * 2 * ui.anim;
        var start = a, end = a + sweep;
        var rr = R + (ui.hover === i ? 6 : 0);
        if (sweep > 0.0001) {
          x.beginPath();
          x.arc(cx, cy, rr, start + gap, end - gap);
          x.arc(cx, cy, r, end - gap, start + gap, true);
          x.closePath();
          x.fillStyle = CATS[k] ? CATS[k].c : "#8791a5";
          x.globalAlpha = (ui.hover !== -1 && ui.hover !== i) ? 0.35 : 1;
          x.fill();
          x.globalAlpha = 1;
        }
        segs.push({ start: start, end: end });
        a = end;
      });
    }
    ui.segs = segs;

    x.textAlign = "center";
    if (ui.hover >= 0 && keys[ui.hover]) {
      var hk = keys[ui.hover];
      x.fillStyle = CATS[hk].c;
      x.font = "700 20px " + cssVar("--font");
      x.fillText(fmt.format(ui.by[hk]), cx, cy + 2);
      x.fillStyle = cssVar("--ink");
      x.font = "600 13px " + cssVar("--font");
      x.fillText(hk + " · " + Math.round(ui.by[hk] / total * 100) + "%", cx, cy + 22);
    } else {
      x.fillStyle = cssVar("--ink");
      x.font = "700 18px " + cssVar("--font");
      x.fillText(fmt.format(total), cx, cy + 2);
      x.fillStyle = cssVar("--muted");
      x.font = "12px " + cssVar("--font");
      x.fillText(total ? "spent this month" : "no spending yet", cx, cy + 20);
    }
  }

  function segAt(e) {
    var canvas = $("chart");
    var rect = canvas.getBoundingClientRect();
    var x = e.clientX - rect.left - rect.width / 2;
    var y = e.clientY - rect.top - rect.height / 2;
    var d = Math.sqrt(x * x + y * y) * (200 / rect.width);
    if (d < 60 || d > 98) return -1;
    var ang = Math.atan2(y, x);
    if (ang < -Math.PI / 2) ang += Math.PI * 2;
    for (var i = 0; i < ui.segs.length; i++) {
      var s = ui.segs[i];
      if (ang >= s.start && ang <= s.end) return i;
    }
    return -1;
  }

  function renderLegend() {
    var legend = $("legend");
    var keys = ui.keys;
    if (!keys.length) {
      legend.innerHTML = '<li class="static">Add an expense to see your spending breakdown.</li>';
      return;
    }
    legend.innerHTML = keys.map(function (k) {
      var on = ui.filterCat === k;
      var pct = ui.total > 0 ? Math.round(ui.by[k] / ui.total * 100) : 0;
      return '<li role="button" tabindex="0" data-k="' + esc(k) + '" aria-pressed="' + on + '" class="' + (on ? "on" : "") + '">' +
        '<i style="background:' + (CATS[k] ? CATS[k].c : "#8791a5") + '"></i>' +
        (CATS[k] ? CATS[k].i : "") + " " + esc(k) +
        '<em>' + pct + '%</em></li>';
    }).join("");
  }

  function setFilter(cat) {
    ui.filterCat = cat;
    $("fcat").value = cat;
    renderTable();
    renderLegend();
  }

  /* ============================================================
     Monthly trend chart
     - Y-axis scale is based on the highest monthly INCOME
       in the selected year (per requirement).
     - Each bar plots that month's total EXPENSES.
     - If expenses exceed income scale, the scale extends
       so bars are never clipped.
  ============================================================ */
  function incomeByMonthForYear(year) {
    var out = [];
    for (var m = 0; m < 12; m++) out.push(0);
    state.tx.forEach(function (t) {
      if (t.type !== "income") return;
      if (t.date.slice(0, 4) !== String(year)) return;
      var mi = parseInt(t.date.slice(5, 7), 10) - 1;
      if (mi >= 0 && mi < 12) out[mi] += t.amount;
    });
    return out;
  }

  function expensesByMonthForYear(year) {
    var out = [];
    for (var m = 0; m < 12; m++) out.push(0);
    state.tx.forEach(function (t) {
      if (t.type !== "expense") return;
      if (t.date.slice(0, 4) !== String(year)) return;
      var mi = parseInt(t.date.slice(5, 7), 10) - 1;
      if (mi >= 0 && mi < 12) out[mi] += t.amount;
    });
    return out;
  }

  function renderTrend() {
    var canvas = $("trend");
    if (!canvas) return;
    var year = ui.trendYear;
    var expenses = expensesByMonthForYear(year);
    var incomes = incomeByMonthForYear(year);

    var wrap = canvas.parentNode;
    var w = wrap.clientWidth || 600;
    var h = wrap.clientHeight || 260;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    var x = canvas.getContext("2d");
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, w, h);

    var padL = 52, padR = 16, padT = 18, padB = 34;
    var plotW = w - padL - padR;
    var plotH = h - padT - padB;

    var maxIncome = Math.max.apply(null, incomes);
    var maxExpense = Math.max.apply(null, expenses);

    // Scale is based on the highest monthly income.
    // If expenses exceed that scale, extend so bars are not clipped.
    var baseline = maxIncome > 0 ? maxIncome : maxExpense;
    if (maxExpense > baseline) baseline = maxExpense;
    var yMax = baseline > 0 ? niceCeil(baseline) : 1000;

    // grid lines
    x.strokeStyle = cssVar("--line-soft") || "#1a253a";
    x.lineWidth = 1;
    x.font = "11px " + cssVar("--font");
    x.fillStyle = cssVar("--muted") || "#8a97ad";
    x.textAlign = "right";
    x.textBaseline = "middle";
    var steps = 4;
    for (var i = 0; i <= steps; i++) {
      var yy = padT + (plotH / steps) * i;
      x.beginPath();
      x.moveTo(padL, yy);
      x.lineTo(padL + plotW, yy);
      x.stroke();
      var val = yMax - (yMax / steps) * i;
      x.fillText(shortMoney(val), padL - 8, yy);
    }

    // income reference line (highest monthly income, if any)
    if (maxIncome > 0) {
      var incomeY = padT + plotH - (maxIncome / yMax) * plotH;
      x.save();
      x.strokeStyle = "rgba(52, 211, 153, 0.55)";
      x.setLineDash([5, 4]);
      x.lineWidth = 1;
      x.beginPath();
      x.moveTo(padL, incomeY);
      x.lineTo(padL + plotW, incomeY);
      x.stroke();
      x.restore();
    }

    // bars
    var slot = plotW / 12;
    var barW = slot * 0.55;
    var accent = cssVar("--accent") || "#6d8dff";
    var accent2 = "#8aa4ff";
    var maxIdx = expenses.indexOf(maxExpense);
    var overIdx = -1;
    // find any month where expenses > income
    for (var oi = 0; oi < 12; oi++) {
      if (expenses[oi] > 0 && expenses[oi] > incomes[oi]) { overIdx = oi; break; }
    }

    for (var m = 0; m < 12; m++) {
      var v = expenses[m];
      var bh = yMax > 0 ? (v / yMax) * plotH : 0;
      var bx = padL + slot * m + (slot - barW) / 2;
      var by = padT + plotH - bh;
      var grad = x.createLinearGradient(0, by, 0, padT + plotH);
      var overspent = v > 0 && v > incomes[m];
      if (overspent) {
        grad.addColorStop(0, "#f87171");
        grad.addColorStop(1, "rgba(248, 113, 113, 0.35)");
      } else if (m === maxIdx && maxExpense > 0) {
        grad.addColorStop(0, accent2);
        grad.addColorStop(1, accent);
      } else {
        grad.addColorStop(0, accent);
        grad.addColorStop(1, "rgba(109,141,255,.35)");
      }
      x.fillStyle = v > 0 ? grad : (cssVar("--line-soft") || "#1a253a");
      roundRect(x, bx, by, barW, Math.max(bh, v > 0 ? 3 : 2), 4);
      x.fill();
    }

    // x labels
    x.fillStyle = cssVar("--muted") || "#8a97ad";
    x.font = "11px " + cssVar("--font");
    x.textAlign = "center";
    x.textBaseline = "top";
    for (var m2 = 0; m2 < 12; m2++) {
      var cx = padL + slot * m2 + slot / 2;
      x.fillText(MONTH_NAMES[m2], cx, padT + plotH + 8);
    }

    // supporting stats
    var stats = computeTrendStats(expenses, incomes);
    var host = $("trendStats");
    host.innerHTML = [
      statBox("Highest expense month", stats.highest ? MONTH_NAMES[stats.highest.i] + " · " + fmt.format(stats.highest.v) : "—"),
      statBox("Highest income month", stats.highestIncome ? MONTH_NAMES[stats.highestIncome.i] + " · " + fmt.format(stats.highestIncome.v) : "—"),
      statBox("Average expense / month", fmt.format(stats.avg)),
      statBox("Scale basis (Y-axis)", maxIncome > 0 ? "Highest income " + fmt.format(maxIncome) : "No income recorded")
    ].join("");

    // empty state overlay
    if (maxExpense === 0) {
      x.fillStyle = cssVar("--muted") || "#8a97ad";
      x.font = "13px " + cssVar("--font");
      x.textAlign = "center";
      x.textBaseline = "middle";
      x.fillText("No expenses recorded in " + year, padL + plotW / 2, padT + plotH / 2);
    }
  }

  function statBox(label, value) {
    return "<div><span>" + esc(label) + "</span><b>" + esc(value) + "</b></div>";
  }

  function computeTrendStats(expenses, incomes) {
    var sum = 0, count = 0, highest = null, lowest = null, highestIncome = null;
    for (var i = 0; i < 12; i++) {
      var v = expenses[i];
      if (v > 0) {
        count++;
        sum += v;
        if (!highest || v > highest.v) highest = { i: i, v: v };
        if (!lowest || v < lowest.v) lowest = { i: i, v: v };
      }
      var inc = incomes[i];
      if (inc > 0 && (!highestIncome || inc > highestIncome.v)) {
        highestIncome = { i: i, v: inc };
      }
    }
    var avg = count > 0 ? sum / count : 0;
    return { highest: highest, lowest: lowest, avg: avg, highestIncome: highestIncome };
  }

  function niceCeil(n) {
    if (n <= 0) return 1000;
    var mag = Math.pow(10, Math.floor(Math.log10(n)));
    var norm = n / mag;
    var step;
    if (norm <= 1) step = 1;
    else if (norm <= 2) step = 2;
    else if (norm <= 5) step = 5;
    else step = 10;
    return step * mag;
  }

  function shortMoney(v) {
    if (v >= 1e7) return "₹" + (v / 1e7).toFixed(1) + "Cr";
    if (v >= 1e5) return "₹" + (v / 1e5).toFixed(1) + "L";
    if (v >= 1e3) return "₹" + Math.round(v / 1e3) + "k";
    return "₹" + Math.round(v);
  }

  function roundRect(ctx, x, y, w, h, r) {
    if (h < 2 * r) r = h / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ============================================================
     Category budgets
  ============================================================ */
  function renderCategoryBudgets() {
    var host = $("catBudgets");
    var monthList = txsForMonth($("month").value || thisMonth);
    var spentByCat = categoryTotals(monthList);

    host.innerHTML = EXPENSE_CATS.map(function (cat) {
      var target = state.catBudgets[cat] || 0;
      var spent = spentByCat[cat] || 0;
      var pct = target > 0 ? Math.min(100, spent / target * 100) : 0;
      var status = budgetStatus(spent, target);
      var cls = status.state === "over" ? "bad" : status.state === "warn" || status.state === "critical" ? "warn" : "";
      var badge = "";
      if (target > 0) {
        if (status.state === "over") badge = '<span class="catbudget-badge bad">Over</span>';
        else if (status.state === "critical") badge = '<span class="catbudget-badge warn">Critical</span>';
        else if (status.state === "warn") badge = '<span class="catbudget-badge warn">Warning</span>';
      }
      var remainingTxt = target > 0
        ? (status.state === "over" ? "Over by " + fmt.format(status.excess) : fmt.format(status.remaining) + " left")
        : "No target set";
      return (
        '<div class="catbudget ' + cls + '" data-cat="' + cat + '">' +
        '<div class="catbudget-head">' +
        '<i style="background:' + CATS[cat].c + '"></i>' +
        '<b>' + CATS[cat].i + " " + cat + '</b>' +
        badge +
        '<input type="number" min="0" step="1" placeholder="Target" data-catbudget="' + cat + '" value="' + (target > 0 ? target : "") + '" aria-label="' + cat + ' monthly budget">' +
        '</div>' +
        '<div class="catbudget-row"><span>Spent</span><b>' + fmt.format(spent) + '</b></div>' +
        '<div class="catbudget-row"><span>' + (target > 0 ? "Remaining" : "Target") + '</span><b>' + remainingTxt + '</b></div>' +
        '<div class="catbudget-row"><span>Used</span><b>' + (target > 0 ? Math.round(status.pct) + "%" : "—") + '</b></div>' +
        '<div class="catbudget-bar"><i style="width:' + pct + '%"></i></div>' +
        '</div>'
      );
    }).join("");
  }

  /* ============================================================
     Transactions table
  ============================================================ */
  function renderTable() {
    var q = $("q").value.trim().toLowerCase();
    var list = txsForMonth($("month").value || thisMonth).filter(function (t) {
      if (ui.filterCat && t.cat !== ui.filterCat) return false;
      if (ui.filterType && t.type !== ui.filterType) return false;
      if (q && t.desc.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });

    var k = ui.sortKey, d = ui.sortDir;
    function val(t) {
      if (k === "amount") return t.amount;
      if (k === "desc") return t.desc.toLowerCase();
      if (k === "cat") return t.cat;
      return t.date;
    }
    list.sort(function (a, b) {
      var va = val(a), vb = val(b);
      var cmp = va > vb ? 1 : va < vb ? -1 : 0;
      return (cmp * d) || (b.id - a.id);
    });

    $("rows").innerHTML = list.map(function (t) {
      var isIncome = t.type === "income";
      var dd = t.date.slice(8) + "/" + t.date.slice(5, 7);
      var catMeta = CATS[t.cat] || CATS.Other;
      return '<tr' + (t.id === ui.lastId ? ' class="enter"' : '') + ' data-id="' + t.id + '">' +
        '<td>' + dd + '</td>' +
        '<td>' + esc(t.desc) + '</td>' +
        '<td><span class="chip"><i style="background:' + catMeta.c + '"></i>' + catMeta.i + " " + esc(t.cat) + '</span></td>' +
        '<td class="amt ' + (isIncome ? "inc" : "exp") + '">' + (isIncome ? "+" : "−") + fmtDec.format(t.amount) + '</td>' +
        '<td><div class="row-actions">' +
        '<button class="icon-btn edit" type="button" data-id="' + t.id + '" aria-label="Edit ' + esc(t.desc) + '">Edit</button>' +
        '<button class="icon-btn del" type="button" data-id="' + t.id + '" aria-label="Delete ' + esc(t.desc) + '">×</button>' +
        '</div></td>' +
        '</tr>';
    }).join("");

    var hasAny = state.tx.length > 0;
    var emptyEl = $("empty");
    emptyEl.hidden = list.length > 0;
    emptyEl.textContent = !hasAny
      ? "No transactions yet. Add your first one above."
      : "No transactions match the current filters.";
    ui.lastId = null;

    document.querySelectorAll("th[aria-sort]").forEach(function (th) {
      var b = th.querySelector("button");
      th.setAttribute("aria-sort", b.dataset.sort === k ? (d === 1 ? "ascending" : "descending") : "none");
    });
  }

  /* ============================================================
     Form
  ============================================================ */
  function renderCatChips() {
    var list = ui.type === "income" ? INCOME_CATS : EXPENSE_CATS;
    if (list.indexOf(ui.cat) < 0) ui.cat = list[0];
    $("catchips").innerHTML = list.map(function (k) {
      return '<button type="button" aria-pressed="' + (ui.cat === k) + '" style="--c:' + CATS[k].c + '" data-c="' + k + '">' +
        CATS[k].i + " " + k + '</button>';
    }).join("");
  }

  function updatePreview() {
    var a = parseFloat($("amount").value);
    if (!(a > 0) || !isFinite(a)) { $("preview").textContent = ""; return; }
    if (ui.type === "income") {
      $("preview").textContent = "Adds " + fmtDec.format(a) + " to this month's income";
    } else {
      var month = monthOf($("date").value || todayISO());
      var inc = monthIncome(month);
      var exp = monthExpenses(month, ui.editId);
      var bal = inc - exp;
      var projected = bal - a;
      $("preview").textContent = "Deducts " + fmtDec.format(a) + " · projected balance " + fmtDec.format(projected);
      $("preview").className = projected < 0 ? "preview full exp" : "preview full muted";
    }
  }

  function setFieldError(id, message) {
    var field = $(id);
    var err = $("err-" + id);
    if (!field || !err) return;
    if (message) {
      field.setAttribute("aria-invalid", "true");
      err.textContent = message;
    } else {
      field.removeAttribute("aria-invalid");
      err.textContent = "";
    }
  }

  function clearAllErrors() {
    setFieldError("desc", "");
    setFieldError("amount", "");
    setFieldError("date", "");
  }

  function validateForm() {
    var errors = {};
    var desc = $("desc").value.trim();
    var amtRaw = $("amount").value.trim();
    var amt = parseFloat(amtRaw);
    var date = $("date").value;

    if (!desc) errors.desc = "Description is required.";
    else if (desc.length > MAX_DESC_LEN) errors.desc = "Description must be " + MAX_DESC_LEN + " characters or fewer.";

    if (!amtRaw) errors.amount = "Amount is required.";
    else if (!/^\d+(\.\d{1,2})?$/.test(amtRaw.replace(/\s/g, ""))) errors.amount = "Enter a valid amount (max two decimal places).";
    else if (!isFinite(amt) || amt <= 0) errors.amount = "Amount must be greater than 0.";
    else if (amt > MAX_AMOUNT) errors.amount = "Amount exceeds the maximum allowed (" + fmt.format(MAX_AMOUNT) + ").";

    if (!date) errors.date = "Date is required.";
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.date = "Enter a valid date.";
    else {
      var dt = new Date(date + "T00:00:00");
      if (isNaN(dt.getTime()) || iso(dt) !== date) errors.date = "That date does not exist.";
    }

    var allowed = ui.type === "income" ? INCOME_CATS : EXPENSE_CATS;
    if (allowed.indexOf(ui.cat) < 0) errors.desc = errors.desc || "Choose a valid category.";

    return { ok: Object.keys(errors).length === 0, errors: errors, values: { desc: desc, amount: amt, date: date } };
  }

  function fillForm(tx) {
    ui.editId = tx.id;
    ui.type = tx.type;
    ui.cat = tx.cat;
    $("desc").value = tx.desc;
    $("amount").value = tx.amount;
    $("date").value = tx.date;
    document.querySelectorAll(".seg button").forEach(function (x) {
      x.setAttribute("aria-checked", String(x.dataset.type === ui.type));
    });
    renderCatChips();
    updatePreview();
    $("submitBtn").textContent = "Save changes";
    $("cancelEdit").classList.remove("hidden");
    clearAllErrors();
    window.scrollTo({ top: $("form").offsetTop - 40, behavior: reduceMotion ? "auto" : "smooth" });
    $("desc").focus();
  }

  function resetForm() {
    ui.editId = null;
    $("desc").value = "";
    $("amount").value = "";
    $("date").value = todayISO();
    $("submitBtn").textContent = "Add transaction";
    $("cancelEdit").classList.add("hidden");
    clearAllErrors();
    updatePreview();
  }

  /* ============================================================
     Save flow with income + budget pre-checks
     Income validation runs first; if it passes (or is overridden),
     the budget check runs.
  ============================================================ */
  var pendingSave = null;

  function attemptSave(data) {
    if (ui.type === "expense") {
      var month = monthOf(data.date);
      var inc = monthIncome(month);
      var existingExp = monthExpenses(month, ui.editId);
      var projectedExp = existingExp + data.amount;
      var available = inc - existingExp;       // funds before this expense
      var projectedBal = inc - projectedExp;   // funds after this expense

      // Case A: no income recorded for that month
      if (inc <= 0) {
        var noIncBody =
          "No income has been recorded for " + monthLabel(month) + ". " +
          "Recording this expense of " + fmtDec.format(data.amount) + " will create a negative balance of " +
          fmtDec.format(projectedBal) + ".\n\n" +
          "If you have opening funds or savings not tracked here, you can continue anyway. " +
          "Otherwise, record your income first so the balance reflects reality.";
        showModal("No income recorded for " + monthLabel(month), noIncBody, "Continue anyway", "Cancel and edit",
          function () { checkBudgetThen(data); },
          function () { /* keep form values */ });
        return;
      }

      // Case B: expense exceeds available balance
      if (projectedBal < 0) {
        var excess = -projectedBal;
        var body =
          "This expense exceeds your available funds for " + monthLabel(month) + ".\n\n" +
          "Available balance: " + fmtDec.format(available) + "\n" +
          "Proposed expense: " + fmtDec.format(data.amount) + "\n" +
          "Projected total expenses: " + fmtDec.format(projectedExp) + "\n" +
          "Projected balance: " + fmtDec.format(projectedBal) + "\n" +
          "Exceeds available funds by: " + fmtDec.format(excess);
        showModal("Expense exceeds available funds", body, "Continue anyway", "Cancel and edit",
          function () { checkBudgetThen(data); },
          function () { /* keep form values */ });
        return;
      }
    }
    // income transactions bypass the income-based check
    checkBudgetThen(data);
  }

  function checkBudgetThen(data) {
    if (ui.type === "expense" && state.budget > 0) {
      var month = monthOf(data.date);
      var existing = 0;
      state.tx.forEach(function (t) {
        if (t.type !== "expense") return;
        if (monthOf(t.date) !== month) return;
        if (ui.editId && t.id === ui.editId) return;
        existing += t.amount;
      });
      var projected = existing + data.amount;
      if (projected > state.budget) {
        var excess = projected - state.budget;
        var body = "Budget exceeded. This transaction will bring your monthly spending to " +
          fmt.format(projected) + ", which is " + fmt.format(excess) + " above your " +
          fmt.format(state.budget) + " budget.";
        showModal("Budget warning", body, "Save anyway", "Cancel and edit",
          function () { finalizeSave(data); },
          function () { /* keep form values */ });
        return;
      }
    }
    finalizeSave(data);
  }

  function finalizeSave(data) {
    var month = monthOf(data.date);
    if (ui.editId != null) {
      var idx = state.tx.findIndex(function (t) { return t.id === ui.editId; });
      if (idx < 0) {
        showToast("That transaction no longer exists.");
        resetForm();
        return;
      }
      var updated = {
        id: state.tx[idx].id,
        type: ui.type,
        desc: data.desc,
        amount: data.amount,
        cat: ui.cat,
        date: data.date
      };
      state.tx[idx] = updated;
      ui.lastId = updated.id;
      if (!save()) { /* toast already shown */ }
      resetForm();
      refreshAll();
      showToast("Transaction updated.");
    } else {
      var rec = {
        id: nextId(),
        type: ui.type,
        desc: data.desc,
        amount: data.amount,
        cat: ui.cat,
        date: data.date
      };
      state.tx.push(rec);
      ui.lastId = rec.id;
      if (!save()) { /* toast already shown */ }
      // navigate to that month
      if (monthOf(rec.date) !== $("month").value) $("month").value = monthOf(rec.date);
      resetForm();
      refreshAll();
      var msg = (rec.type === "income" ? "Income" : "Expense") + " added: " + fmtDec.format(rec.amount);
      var bal = availableBalance(monthOf(rec.date));
      if (bal < 0) {
        msg += " · balance now " + fmtDec.format(bal);
        showToast(msg);
        // also surface a persistent-ish visual warning
        var rate = $("sRate");
        if (rate) {
          rate.textContent = "⚠ Overspent by " + fmtDec.format(-bal) + " this month";
          rate.className = "muted exp";
        }
      } else {
        showToast(msg);
      }
    }
    $("desc").focus();
  }

  /**
   * Generic modal used for both income and budget warnings.
   * confirmLabel/cancelLabel let us reuse the same markup.
   */
  function showModal(title, message, confirmLabel, cancelLabel, onConfirm, onCancel) {
    var backdrop = $("modal");
    $("modalTitle").textContent = title;
    $("modalBody").textContent = message;
    var confirmBtn = $("modalConfirm");
    var cancelBtn = $("modalCancel");
    confirmBtn.textContent = confirmLabel || "Continue";
    cancelBtn.textContent = cancelLabel || "Cancel and edit";
    // mark modal body as alert for a11y
    $("modalBody").setAttribute("role", "alert");
    backdrop.hidden = false;
    function cleanup() {
      confirmBtn.removeEventListener("click", handleConfirm);
      cancelBtn.removeEventListener("click", handleCancel);
      backdrop.removeEventListener("click", handleBackdrop);
      document.removeEventListener("keydown", handleKey);
      backdrop.hidden = true;
    }
    function handleConfirm() { cleanup(); onConfirm && onConfirm(); }
    function handleCancel() { cleanup(); onCancel && onCancel(); }
    function handleBackdrop(e) { if (e.target === backdrop) handleCancel(); }
    function handleKey(e) { if (e.key === "Escape") { e.preventDefault(); handleCancel(); } }
    confirmBtn.addEventListener("click", handleConfirm);
    cancelBtn.addEventListener("click", handleCancel);
    backdrop.addEventListener("click", handleBackdrop);
    document.addEventListener("keydown", handleKey);
    setTimeout(function () { cancelBtn.focus(); }, 30);
  }

  // Backwards-compatible alias (old calls)
  function showBudgetModal(message, onConfirm, onCancel) {
    showModal("Budget warning", message, "Save anyway", "Cancel and edit", onConfirm, onCancel);
  }

  /* ============================================================
     CSV export
  ============================================================ */
  function csvCell(v) {
    var s = String(v == null ? "" : v);
    // Neutralise formula injection
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""').replace(/\r?\n/g, " ") + '"';
  }

  function exportCSV() {
    if (!state.tx.length) { showToast("Nothing to export yet. Add a transaction first."); return; }
    var rows = [["ID", "Date", "Description", "Type", "Category", "Amount"]];
    // include only currently filtered month + filters
    var month = $("month").value || thisMonth;
    var list = txsForMonth(month);
    if (!list.length) { showToast("No transactions in the selected month."); return; }
    list.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id; });
    list.forEach(function (t) {
      rows.push([t.id, t.date, t.desc, t.type, t.cat, t.amount]);
    });
    var csv = rows.map(function (r) { return r.map(csvCell).join(","); }).join("\r\n");
    var blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "ledgerline-" + month + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    showToast("Exported " + list.length + " transactions for " + monthLabel(month));
  }
   
function renderInsights() {
  var host = $("insightsList");
  if (!host) return;

  var month = $("month").value || thisMonth;
  var current = txsForMonth(month);

  var date = new Date(
    Number(month.slice(0, 4)),
    Number(month.slice(5, 7)) - 1,
    1
  );
  date.setMonth(date.getMonth() - 1);

  var previousMonth = iso(date).slice(0, 7);
  var previous = txsForMonth(previousMonth);

  var spent = sumByType(current, "expense");
  var previousSpent = sumByType(previous, "expense");
  var income = sumByType(current, "income");
  var cards = [];

  // 1. Monthly budget insight
  if (state.budget > 0) {
    var pct = Math.round(spent / state.budget * 100);

    if (pct >= 100) {
      cards.push({
        icon: "🚨",
        title: "Budget exceeded",
        message: "You have used " + pct +
          "% of your monthly budget.",
        tone: "warning"
      });
    } else if (pct >= 75) {
      cards.push({
        icon: "⚠️",
        title: "Budget warning",
        message: "You have used " + pct +
          "% of your monthly budget.",
        tone: "warning"
      });
    } else {
      cards.push({
        icon: "✅",
        title: "Budget status",
        message: "You have used " + pct +
          "% of your monthly budget.",
        tone: "good"
      });
    }
  } else {
    cards.push({
      icon: "🎯",
      title: "Set a monthly budget",
      message: "Choose a budget to start tracking your spending limit.",
      tone: "info"
    });
  }

  // 2. Compare spending with the previous month
  if (previous.length > 0) {
    if (previousSpent > 0) {
      var change = Math.round(
        ((spent - previousSpent) / previousSpent) * 100
      );

      if (change > 0) {
        cards.push({
          icon: "📈",
          title: "Spending increased",
          message: "Your expenses are " + change +
            "% higher than last month.",
          tone: "warning"
        });
      } else if (change < 0) {
        cards.push({
          icon: "📉",
          title: "Spending decreased",
          message: "Your expenses are " + Math.abs(change) +
            "% lower than last month.",
          tone: "good"
        });
      } else {
        cards.push({
          icon: "📊",
          title: "Spending unchanged",
          message: "Your total expenses match last month.",
          tone: "info"
        });
      }
    } else if (spent > 0) {
      cards.push({
        icon: "📊",
        title: "New spending activity",
        message: "You recorded expenses this month, but none last month.",
        tone: "info"
      });
    }
  }

  // 3. Savings insight
  if (income > 0) {
    var net = income - spent;
    var rate = Math.round((net / income) * 100);

    cards.push({
      icon: net >= 0 ? "💰" : "💡",
      title: net >= 0 ? "Savings progress" : "Spending exceeds income",
      message: net >= 0
        ? "Your savings rate is " + rate + "% this month."
        : "Your expenses are higher than your recorded income.",
      tone: net >= 0 ? "good" : "warning"
    });
  }

  if (cards.length === 0) {
    cards.push({
      icon: "📝",
      title: "Start tracking",
      message: "Add transactions to unlock your financial insights.",
      tone: "info"
    });
  }

  host.innerHTML = cards.map(function (card) {
    return '<article class="insight-card ' + card.tone + '">' +
      '<span class="insight-icon" aria-hidden="true">' +
      card.icon + '</span>' +
      '<h3>' + card.title + '</h3>' +
      '<p>' + card.message + '</p>' +
      '</article>';
  }).join("");
}

  /* ============================================================
     Refresh orchestration
  ============================================================ */
  function refreshAll() {
    renderStats();
    renderInsights();
    drawChart();
    renderTrend();
    renderCategoryBudgets();
    renderTable();
  }

  /* ============================================================
     Wire-up
  ============================================================ */
  function initMonthAndYearOptions() {
    var months = new Set();
    state.tx.forEach(function (t) { months.add(monthOf(t.date)); });
    months.add(thisMonth);
    var current = $("month").value || thisMonth;
    // keep month input type=month, it accepts any
    $("month").value = current;

    var years = new Set();
    state.tx.forEach(function (t) { years.add(parseInt(t.date.slice(0, 4), 10)); });
    years.add(today.getFullYear());
    var sorted = Array.from(years).sort(function (a, b) { return b - a; });
    var yearSel = $("year");
    yearSel.innerHTML = sorted.map(function (y) { return "<option>" + y + "</option>"; }).join("");
    yearSel.value = String(ui.trendYear);
  }

  function bindEvents() {
    // Type toggle
    document.querySelectorAll(".seg button").forEach(function (b) {
      b.addEventListener("click", function () {
        ui.type = b.dataset.type;
        document.querySelectorAll(".seg button").forEach(function (x) {
          x.setAttribute("aria-checked", String(x === b));
        });
        renderCatChips();
        updatePreview();
      });
    });

    // Category chips
    $("catchips").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-c]");
      if (!b) return;
      ui.cat = b.dataset.c;
      renderCatChips();
    });

    $("amount").addEventListener("input", updatePreview);
    $("date").addEventListener("input", updatePreview);

    // Form submit
    $("form").addEventListener("submit", function (e) {
      e.preventDefault();
      clearAllErrors();
      var res = validateForm();
      if (!res.ok) {
        Object.keys(res.errors).forEach(function (k) { setFieldError(k, res.errors[k]); });
        var first = ["desc", "amount", "date"].find(function (k) { return res.errors[k]; });
        if (first) $(first).focus();
        var f = $("form");
        f.classList.remove("shake");
        void f.offsetWidth;
        f.classList.add("shake");
        return;
      }
      attemptSave(res.values);
    });

    $("cancelEdit").addEventListener("click", function () { resetForm(); });

    // Budget
    $("budget").addEventListener("input", function () {
      var v = parseFloat(this.value);
      state.budget = isFinite(v) && v >= 0 ? v : 0;
      save();
      renderStats();
      renderCategoryBudgets();
    });

    // Category budgets
    $("catBudgets").addEventListener("input", function (e) {
      var input = e.target.closest("input[data-catbudget]");
      if (!input) return;
      var cat = input.dataset.catbudget;
      var v = parseFloat(input.value);
      if (isFinite(v) && v > 0) state.catBudgets[cat] = v;
      else delete state.catBudgets[cat];
      save();
      // Update only the numeric rows without re-rendering the input (preserve focus)
      var card = input.closest(".catbudget");
      if (!card) return;
      var monthList = txsForMonth($("month").value || thisMonth);
      var spent = categoryTotals(monthList)[cat] || 0;
      var target = state.catBudgets[cat] || 0;
      var status = budgetStatus(spent, target);
      card.classList.remove("warn", "bad");
      if (status.state === "over") card.classList.add("bad");
      else if (status.state === "warn" || status.state === "critical") card.classList.add("warn");
      var rows = card.querySelectorAll(".catbudget-row b");
      if (rows[0]) rows[0].textContent = fmt.format(spent);
      if (rows[1]) rows[1].textContent = target > 0
        ? (status.state === "over" ? "Over by " + fmt.format(status.excess) : fmt.format(status.remaining) + " left")
        : "No target set";
      if (rows[2]) rows[2].textContent = target > 0 ? Math.round(status.pct) + "%" : "—";
      var bar = card.querySelector(".catbudget-bar > i");
      if (bar) bar.style.width = (target > 0 ? Math.min(100, status.pct) : 0) + "%";
    });

    // Filters
    $("month").addEventListener("input", function () { refreshAll(); });
    $("fcat").addEventListener("change", function () { setFilter(this.value); });
    $("ftype").addEventListener("change", function () {
      ui.filterType = this.value;
      renderTable();
    });
    $("q").addEventListener("input", renderTable);
    $("resetFilters").addEventListener("click", function () {
      $("q").value = "";
      $("ftype").value = "";
      ui.filterType = "";
      setFilter("");
      renderTable();
    });

    // Year selector
    $("year").addEventListener("change", function () {
      ui.trendYear = parseInt(this.value, 10);
      renderTrend();
    });

    // Sort
    document.querySelectorAll("th button[data-sort]").forEach(function (b) {
      b.addEventListener("click", function () {
        var k = b.dataset.sort;
        if (ui.sortKey === k) {
          ui.sortDir *= -1;
        } else {
          ui.sortKey = k;
          ui.sortDir = (k === "amount" || k === "date") ? -1 : 1;
        }
        renderTable();
      });
    });

    // Table actions
    $("rows").addEventListener("click", function (e) {
      var editBtn = e.target.closest(".edit");
      var delBtn = e.target.closest(".del");
      if (editBtn) {
        var id = Number(editBtn.dataset.id);
        var tx = state.tx.find(function (t) { return t.id === id; });
        if (tx) fillForm(tx);
      } else if (delBtn) {
        handleDelete(Number(delBtn.dataset.id), delBtn.closest("tr"));
      }
    });

    // Doughnut interactions
    var canvas = $("chart");
    canvas.addEventListener("mousemove", function (e) {
      var i = segAt(e);
      canvas.style.cursor = i >= 0 ? "pointer" : "default";
      if (i !== ui.hover) { ui.hover = i; ui.anim = 1; paint(); }
    });
    canvas.addEventListener("mouseleave", function () { ui.hover = -1; ui.anim = 1; paint(); });
    canvas.addEventListener("click", function (e) {
      var i = segAt(e);
      if (i >= 0) setFilter(ui.keys[i] === ui.filterCat ? "" : ui.keys[i]);
    });

    $("legend").addEventListener("click", function (e) {
      var li = e.target.closest("li[data-k]");
      if (!li) return;
      var k = li.dataset.k;
      setFilter(k === ui.filterCat ? "" : k);
    });
    $("legend").addEventListener("keydown", function (e) {
      var li = e.target.closest("li[data-k]");
      if (li && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        var k = li.dataset.k;
        setFilter(k === ui.filterCat ? "" : k);
      }
    });

    // CSV
    $("csv").addEventListener("click", exportCSV);

    // Clear all data
    $("clearData").addEventListener("click", function () {
      if (!state.tx.length && !state.budget && !Object.keys(state.catBudgets).length) {
        showToast("Nothing to clear.");
        return;
      }
      showBudgetModal(
        "This will permanently delete " + state.tx.length + " transaction" +
        (state.tx.length === 1 ? "" : "s") + " and reset your budgets. This cannot be undone.",
        function () {
          state.tx = [];
          state.budget = 0;
          state.catBudgets = {};
          state.lastIdSeq = 0;
          save();
          $("budget").value = "";
          refreshAll();
          showToast("All data cleared.");
        },
        function () { /* cancel */ }
      );
    });

    // Resize
    var resizeTimer;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        paint();
        renderTrend();
      }, 120);
    });

    // Keyboard shortcuts
    document.addEventListener("keydown", function (e) {
      if (!e) return;
      var backdrop = $("modal");
      if (!backdrop.hidden) return; // modal handles its own Esc
      if (e.key === "Escape" && !$("bot").hidden) { toggleBot(false); $("fab").focus(); return; }
      var tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") { e.preventDefault(); $("q").focus(); }
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
        $("desc").focus();
      }
    });
  }

  function handleDelete(id, row) {
    var idx = state.tx.findIndex(function (t) { return t.id === id; });
    if (idx < 0) return;
    var removed = state.tx[idx];
    var snapshot = state.tx.slice(); // capture state for undo safety
    if (row) row.classList.add("leaving");
    setTimeout(function () {
      state.tx.splice(idx, 1);
      if (!save()) {
        // storage failed: restore and abort
        state.tx = snapshot;
        refreshAll();
        showToast("Delete failed: storage is unavailable.");
        return;
      }
      refreshAll();
      showToast("Deleted “" + removed.desc + "”", "Undo", function () {
        // Restore only if not already present (idempotent undo)
        if (!state.tx.some(function (t) { return t.id === removed.id; })) {
          state.tx.push(removed);
          ui.lastId = removed.id;
          save();
          refreshAll();
        }
      });
    }, reduceMotion ? 0 : 200);
  }

  /* ============================================================
     Help assistant
  ============================================================ */
  var KB = [
    { k: ["budget", "limit", "set", "spend"], a: "Open the budget box at the top. The bar is green under 75%, amber at 75%, and red at 100%. Exceeding your budget raises a warning before an expense is saved." },
    { k: ["category", "target", "catbudget"], a: "Use the Category budgets panel to set a monthly target for each expense category. Set a value and it saves automatically." },
    { k: ["add", "transaction", "expense", "income", "record", "new"], a: "Pick Expense or Income, fill description, amount, date, and a category, then press Add transaction. Shortcut: press N." },
    { k: ["edit", "change", "update", "modify"], a: "Click Edit next to a transaction to load it into the form. Change any field and press Save changes." },
    { k: ["delete", "remove", "undo"], a: "Click × at the end of a row, then use Undo within a few seconds in the toast to restore it." },
    { k: ["filter", "category", "chart", "pie", "doughnut", "slice"], a: "Click a slice or legend item to filter the table to that category. Press Reset filters to clear." },
    { k: ["search", "find"], a: "Type in the search box or press / to focus it. Search matches descriptions in the selected month." },
    { k: ["sort", "order"], a: "Click a column header to sort; click again to reverse." },
    { k: ["month", "date", "previous", "last", "year"], a: "Use the month picker above the table to view any month. Historical transactions are stored with their actual date." },
    { k: ["trend", "monthly", "chart"], a: "The Monthly expense trends chart shows all 12 months of the selected year. The Y-axis scale is based on the highest monthly income for that year, so you can compare spending with income. Use the Year selector to switch." },
    { k: ["csv", "export", "download"], a: "Export CSV downloads the currently-selected month's transactions, including description, type, category, and amount." },
    { k: ["save", "data", "persist", "lost", "storage"], a: "Your data is saved in this browser's localStorage. Clearing site data or switching browsers will remove it." },
    { k: ["overspend", "balance", "negative", "exceed", "available"], a: "When you add an expense that exceeds the income recorded for that month, Ledgerline warns you before saving. You can cancel and edit, or continue anyway. The dashboard will show a negative balance in red." },
    { k: ["hi", "hello", "hey", "help"], a: "Hi! Ask about budgets, category budgets, adding or editing transactions, the trend chart, sorting, export, overspending, or saving your data." }
  ];

  function botLog(text, who) {
    var d = document.createElement("div");
    d.className = "msg " + (who === "user" ? "user-m" : "bot-m");
    d.textContent = text;
    $("log").appendChild(d);
    $("log").scrollTop = $("log").scrollHeight;
  }
  function botAnswer(q) {
    var words = q.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
    var best = null, score = 0;
    KB.forEach(function (item) {
      var s = 0;
      item.k.forEach(function (kw) { if (words.indexOf(kw) > -1) s++; });
      if (s > score) { score = s; best = item; }
    });
    return best ? best.a
      : "I'm not sure about that. Try asking about budgets, adding transactions, the trend chart, sorting, exporting, overspending, or saving your data.";
  }
  function botAsk(q) {
    q = q.trim();
    if (!q) return;
    botLog(q, "user");
    var ind = document.createElement("div");
    ind.className = "msg bot-m typing";
    ind.innerHTML = "<span></span><span></span><span></span>";
    $("log").appendChild(ind);
    $("log").scrollTop = $("log").scrollHeight;
    setTimeout(function () {
      if (ind.parentNode) ind.parentNode.removeChild(ind);
      botLog(botAnswer(q), "bot");
    }, reduceMotion ? 0 : 500);
  }
  function toggleBot(open) {
    $("bot").hidden = !open;
    $("fab").setAttribute("aria-expanded", String(open));
    if (open) $("botin").focus();
  }
  function initBot() {
    $("fab").addEventListener("click", function () { toggleBot($("bot").hidden); });
    $("botclose").addEventListener("click", function () { toggleBot(false); $("fab").focus(); });
    $("botform").addEventListener("submit", function (e) {
      e.preventDefault();
      botAsk($("botin").value);
      $("botin").value = "";
    });
    ["How do I set a budget?", "Add a transaction", "Edit or delete", "Why was I warned about overspending?"].forEach(function (t) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = t;
      b.addEventListener("click", function () { botAsk(t); });
      $("quick").appendChild(b);
    });
    botLog("Hi, I'm the Ledgerline helper. Ask me how anything works, or tap a suggestion below.", "bot");
  }

  /* ============================================================
     Bootstrap
  ============================================================ */
  function init() {
    load();

    $("date").value = todayISO();
    $("month").value = thisMonth;
    $("budget").value = state.budget > 0 ? state.budget : "";

    $("fcat").innerHTML = "<option value=''>All categories</option>" +
      Object.keys(CATS).map(function (n) { return "<option>" + esc(n) + "</option>"; }).join("");

    initMonthAndYearOptions();
    renderCatChips();
    updatePreview();
    bindEvents();
    initBot();

    // Initial render
    renderStats();
    drawChart();
    renderLegend();
    renderTrend();
    renderCategoryBudgets();
    renderTable();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();