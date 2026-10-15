(function () {
  "use strict";

  /* ============================================================
     Config & constants
  ============================================================ */
  var STORAGE_KEY = "ledgerline-v3";
  var THEME_KEY = "ledgerline-theme";
  var DRAFT_KEY = "ledgerline-draft";
  var SCHEMA_VERSION = 5;
  var MAX_AMOUNT = 1e9;
  var MAX_DESC_LEN = 60;
  var MAX_IMPORT_BYTES = 5 * 1024 * 1024; // 5 MB
  var MAX_IMPORT_RECORDS = 50000;
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
  function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }
  function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

  /** Parse a YYYY-MM-DD string as a LOCAL date. Returns null if invalid. */
  function parseDateOnly(str) {
    if (typeof str !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
    var y = parseInt(str.slice(0, 4), 10);
    var m = parseInt(str.slice(5, 7), 10);
    var d = parseInt(str.slice(8, 10), 10);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    var dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    dt.setHours(0, 0, 0, 0);
    return dt;
  }

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
    recurring: [],
    sts: { nextIncomeDate: "", nextIncomeAmount: 0, savingsGoal: 0 },
    lastIdSeq: 0
  };

  var ui = {
    type: "expense",
    cat: "Food",
    sortKey: "date",
    sortDir: -1,
    filterCat: "",
    filterType: "",
    filterMin: null,
    filterMax: null,
    lastId: null,
    hover: -1,
    anim: 1,
    segs: [],
    keys: [],
    by: {},
    total: 0,
    raf: null,
    trendYear: today.getFullYear(),
    editId: null,
    pendingDeleteId: null,
    lastBotAnswer: ""
  };

  /* ============================================================
     Persistence with schema validation
  ============================================================ */
  function isValidTxRecord(t) {
    if (!t || typeof t !== "object") return false;
    if (typeof t.id !== "number" || !isFinite(t.id) || t.id <= 0) return false;
    if (t.type !== "income" && t.type !== "expense") return false;
    if (typeof t.desc !== "string" || !t.desc.trim()) return false;
    if (t.desc.length > MAX_DESC_LEN * 4) return false;
    if (typeof t.amount !== "number" || !isFinite(t.amount) || t.amount <= 0 || t.amount > MAX_AMOUNT) return false;
    if (typeof t.cat !== "string" || !Object.prototype.hasOwnProperty.call(CATS, t.cat)) return false;
    if (typeof t.date !== "string") return false;
    var dt = parseDateOnly(t.date);
    if (!dt) return false;
    var allowed = t.type === "income" ? INCOME_CATS : EXPENSE_CATS;
    if (allowed.indexOf(t.cat) < 0) return false;
    return true;
  }

  function isValidRecurring(r) {
    if (!r || typeof r !== "object") return false;
    if (typeof r.id !== "number" || !isFinite(r.id) || r.id <= 0) return false;
    if (r.type !== "income" && r.type !== "expense") return false;
    if (typeof r.desc !== "string" || !r.desc.trim()) return false;
    if (typeof r.amount !== "number" || !isFinite(r.amount) || r.amount <= 0 || r.amount > MAX_AMOUNT) return false;
    if (typeof r.cat !== "string" || !Object.prototype.hasOwnProperty.call(CATS, r.cat)) return false;
    if (["weekly", "monthly", "yearly"].indexOf(r.freq) < 0) return false;
    if (!parseDateOnly(r.next)) return false;
    var allowed = r.type === "income" ? INCOME_CATS : EXPENSE_CATS;
    if (allowed.indexOf(r.cat) < 0) return false;
    return true;
  }

  function normalizeTx(t) {
    return {
      id: t.id,
      type: t.type,
      desc: t.desc.trim().slice(0, MAX_DESC_LEN),
      amount: round2(t.amount),
      cat: t.cat,
      date: t.date
    };
  }
  function normalizeRec(r) {
    return {
      id: r.id,
      type: r.type,
      desc: r.desc.trim().slice(0, MAX_DESC_LEN),
      amount: round2(r.amount),
      cat: r.cat,
      freq: r.freq,
      next: r.next
    };
  }

  function storageAvailable() {
    try {
      var k = "__ll_test__";
      localStorage.setItem(k, "1");
      localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  }

  function load() {
    var raw = null;
    if (!storageAvailable()) {
      showToast("Browser storage is unavailable. Changes will not be saved.");
      return;
    }
    try { raw = localStorage.getItem(STORAGE_KEY); }
    catch (e) { showToast("Could not read saved data from this browser."); return; }
    if (!raw) return;

    var parsed = null;
    try { parsed = JSON.parse(raw); }
    catch (e) {
      showToast("Saved data was corrupt and could not be read.");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;

    // Version check: reject future versions, accept known ones.
    var v = parsed.version;
    if (typeof v === "number" && v > SCHEMA_VERSION) {
      showToast("Saved data was created by a newer version. Not loading it.");
      return;
    }

    var maxId = 0;
    var tx = Array.isArray(parsed.tx) ? parsed.tx : [];
    var valid = [];
    var dropped = 0;
    var seen = Object.create(null);
    for (var i = 0; i < tx.length; i++) {
      var t = tx[i];
      if (!isValidTxRecord(t)) { dropped++; continue; }
      if (seen[t.id]) { dropped++; continue; }
      seen[t.id] = true;
      if (t.id > maxId) maxId = t.id;
      valid.push(normalizeTx(t));
    }
    state.tx = valid;

    var recurring = Array.isArray(parsed.recurring) ? parsed.recurring : [];
    var recValid = [];
    var recSeen = Object.create(null);
    for (var j = 0; j < recurring.length; j++) {
      var r = recurring[j];
      if (!isValidRecurring(r)) { dropped++; continue; }
      if (recSeen[r.id] || seen[r.id]) { dropped++; continue; }
      recSeen[r.id] = true;
      if (r.id > maxId) maxId = r.id;
      recValid.push(normalizeRec(r));
    }
    state.recurring = recValid;

    state.budget = (typeof parsed.budget === "number" && isFinite(parsed.budget) && parsed.budget >= 0)
      ? round2(parsed.budget) : 0;

    state.catBudgets = {};
    if (parsed.catBudgets && typeof parsed.catBudgets === "object" && !Array.isArray(parsed.catBudgets)) {
      Object.keys(parsed.catBudgets).forEach(function (k) {
        if (EXPENSE_CATS.indexOf(k) >= 0) {
          var val = parsed.catBudgets[k];
          if (typeof val === "number" && isFinite(val) && val >= 0) {
            state.catBudgets[k] = round2(val);
          }
        }
      });
    }

    if (parsed.sts && typeof parsed.sts === "object") {
      var nid = typeof parsed.sts.nextIncomeDate === "string" ? parsed.sts.nextIncomeDate : "";
      if (!parseDateOnly(nid)) nid = "";
      state.sts = {
        nextIncomeDate: nid,
        nextIncomeAmount: (typeof parsed.sts.nextIncomeAmount === "number" && isFinite(parsed.sts.nextIncomeAmount) && parsed.sts.nextIncomeAmount >= 0)
          ? round2(parsed.sts.nextIncomeAmount) : 0,
        savingsGoal: (typeof parsed.sts.savingsGoal === "number" && isFinite(parsed.sts.savingsGoal) && parsed.sts.savingsGoal >= 0)
          ? round2(parsed.sts.savingsGoal) : 0
      };
    }

    state.lastIdSeq = maxId;

    if (dropped > 0) {
      showToast(dropped + " stored record" + (dropped === 1 ? "" : "s") + " were invalid and skipped.");
    }
  }

  function save() {
    if (!storageAvailable()) {
      showToast("Browser storage is unavailable — changes were not saved.");
      return false;
    }
    try {
      state.version = SCHEMA_VERSION;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      var msg = (e && e.name === "QuotaExceededError")
        ? "Storage is full. Export a backup and clear old data."
        : "Could not save to this browser's storage.";
      showToast(msg);
      return false;
    }
  }

  function nextId() {
    state.lastIdSeq += 1;
    return state.lastIdSeq;
  }

  /* ============================================================
     Toasts
  ============================================================ */
  function showToast(msg, actionLabel, fn) {
    var host = $("toasts");
    if (!host) return;
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
    if (actionLabel && typeof fn === "function") {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = actionLabel;
      b.addEventListener("click", function () {
        try { fn(); } catch (e) { /* noop */ } finally { dismiss(); }
      });
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
      if (p < 1 && el.isConnected) requestAnimationFrame(step);
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
    return round2(list.reduce(function (s, t) { return t.type === type ? s + t.amount : s; }, 0));
  }
  function monthIncome(monthStr) { return sumByType(txsForMonth(monthStr), "income"); }
  function monthExpenses(monthStr, excludeId) {
    return round2(state.tx.reduce(function (s, t) {
      if (t.type !== "expense") return s;
      if (monthOf(t.date) !== monthStr) return s;
      if (excludeId != null && t.id === excludeId) return s;
      return s + t.amount;
    }, 0));
  }
  function availableBalance(monthStr, excludeId) {
    return round2(monthIncome(monthStr) - monthExpenses(monthStr, excludeId));
  }
  function categoryTotals(list) {
    var by = Object.create(null);
    list.forEach(function (t) {
      if (t.type !== "expense") return;
      by[t.cat] = round2((by[t.cat] || 0) + t.amount);
    });
    return by;
  }

  /* ============================================================
     Budget helpers
  ============================================================ */
  function budgetStatus(spent, budget) {
    if (!(budget > 0)) return { state: "unset", pct: 0, remaining: 0, excess: 0 };
    var pct = spent / budget * 100;
    var remaining = round2(budget - spent);
    return {
      state: spent >= budget ? "over" : pct >= 90 ? "critical" : pct >= 75 ? "warn" : "ok",
      pct: pct,
      remaining: remaining,
      excess: remaining < 0 ? -remaining : 0
    };
  }

  function monthLabel(m) {
    if (!m || !/^\d{4}-\d{2}$/.test(m)) return "—";
    var y = m.slice(0, 4), mm = parseInt(m.slice(5, 7), 10) - 1;
    if (mm < 0 || mm > 11) return "—";
    return MONTH_NAMES[mm] + " " + y;
  }

  /* ============================================================
     Safe-to-Spend
  ============================================================ */
  function computeSafeToSpend() {
    var monthEl = $("month");
    var month = (monthEl && monthEl.value) || thisMonth;
    var inc = monthIncome(month);
    var exp = monthExpenses(month);
    var balance = round2(inc - exp);

    var nextDate = state.sts.nextIncomeDate;
    var expectedIncome = state.sts.nextIncomeAmount || 0;
    var savingsGoal = state.sts.savingsGoal || 0;

    var todayD = new Date(); todayD.setHours(0, 0, 0, 0);
    var endDate = null;
    var daysRemaining = null;
    if (nextDate) {
      var nd = parseDateOnly(nextDate);
      if (nd && nd >= todayD) {
        endDate = nd;
        daysRemaining = Math.max(1, Math.round((nd - todayD) / 86400000) + 1);
      }
    }
    if (!endDate) {
      var now = new Date();
      var eom = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      eom.setHours(0, 0, 0, 0);
      daysRemaining = Math.max(1, Math.round((eom - todayD) / 86400000) + 1);
      endDate = eom;
    }

    var upcomingRecurring = 0;
    var upcomingList = [];
    state.recurring.forEach(function (r) {
      if (r.type !== "expense") return;
      var occ = nextOccurrence(r, todayD);
      if (occ && occ <= endDate) {
        upcomingRecurring = round2(upcomingRecurring + r.amount);
        upcomingList.push({ desc: r.desc, amount: r.amount, date: iso(occ) });
      }
    });

    var remainingBudget = 0;
    if (state.budget > 0 && month === thisMonth) {
      remainingBudget = Math.max(0, round2(state.budget - exp));
    }

    var usable = round2(balance + expectedIncome - upcomingRecurring - savingsGoal);
    var daily = daysRemaining > 0 ? round2(usable / daysRemaining) : usable;

    return {
      balance: balance,
      usable: usable,
      daily: daily,
      daysRemaining: daysRemaining,
      upcomingRecurring: upcomingRecurring,
      upcomingList: upcomingList,
      expectedIncome: expectedIncome,
      savingsGoal: savingsGoal,
      nextDate: endDate ? iso(endDate) : "",
      remainingBudget: remainingBudget
    };
  }

  /**
   * Compute the next occurrence of a recurring item on or after fromDate.
   * Uses anchor-day preservation so that Jan 31 → Feb 28 → Mar 31 rather
   * than drifting to the 28th permanently.
   */
  function nextOccurrence(rec, fromDate) {
    var anchor = parseDateOnly(rec.next);
    if (!anchor) return null;
    var iter = 0;
    var d = new Date(anchor.getTime());
    var anchorDay = anchor.getDate();
    while (d < fromDate) {
      if (iter++ > 2000) return null;
      if (rec.freq === "weekly") {
        d.setDate(d.getDate() + 7);
      } else if (rec.freq === "monthly") {
        var y = d.getFullYear();
        var m = d.getMonth() + 1;
        if (m > 11) { m = 0; y++; }
        var dim = daysInMonth(y, m + 1);
        d = new Date(y, m, Math.min(anchorDay, dim));
      } else if (rec.freq === "yearly") {
        var yy = d.getFullYear() + 1;
        var mm = d.getMonth();
        var dd = Math.min(anchorDay, daysInMonth(yy, mm + 1));
        d = new Date(yy, mm, dd);
      } else {
        return null;
      }
    }
    return d;
  }

  function renderSTS() {
    var s = computeSafeToSpend();
    var amountEl = $("stsAmount");
    var subEl = $("stsSub");
    var detailsEl = $("stsDetails");

    if (s.usable === 0 && s.balance === 0 && s.expectedIncome === 0 && state.tx.length === 0) {
      amountEl.textContent = "—";
      amountEl.className = "";
      subEl.textContent = "Add income or set expected income to calculate";
      detailsEl.innerHTML = "";
      return;
    }

    amountEl.textContent = fmt.format(s.daily);
    amountEl.className = s.daily < 0 ? "exp" : "inc";
    subEl.textContent = "per day for " + s.daysRemaining + " day" + (s.daysRemaining === 1 ? "" : "s") +
      (s.nextDate ? " · until " + s.nextDate : "");

    var rows = [];
    rows.push(detailRow("Current balance", fmt.format(s.balance), s.balance < 0));
    rows.push(detailRow("Expected income", "+" + fmt.format(s.expectedIncome), false));
    if (s.upcomingRecurring > 0) {
      rows.push(detailRow("Upcoming recurring", "−" + fmt.format(s.upcomingRecurring), true));
    }
    if (s.savingsGoal > 0) {
      rows.push(detailRow("Savings goal", "−" + fmt.format(s.savingsGoal), true));
    }
    rows.push(detailRow("Total safe to spend", fmt.format(s.usable), s.usable < 0));

    if (s.upcomingList.length) {
      rows.push('<div class="sts-upcoming"><strong>Upcoming:</strong> ' +
        s.upcomingList.map(function (u) {
          return esc(u.desc) + " (" + fmt.format(u.amount) + " on " + u.date + ")";
        }).join(", ") +
        '</div>');
    }
    rows.push('<p class="sts-disclaimer muted">Estimate only. Based on your recorded data — not financial advice.</p>');

    detailsEl.innerHTML = rows.join("");
  }

  function detailRow(label, value, negative) {
    return '<div class="sts-row"><span>' + esc(label) + '</span><b class="' + (negative ? "exp" : "") + '">' + esc(value) + '</b></div>';
  }

  /* ============================================================
     Render: budget + stats
  ============================================================ */
  function renderStats() {
    var month = $("month").value || thisMonth;
    var mt = txsForMonth(month);
    var inc = sumByType(mt, "income");
    var exp = sumByType(mt, "expense");
    var net = round2(inc - exp);

    countUp($("sInc"), inc);
    countUp($("sExp"), exp);
    countUp($("sNet"), net);
    $("sNet").className = net >= 0 ? "inc" : "exp";

    var rate = $("sRate");
    if (inc > 0) {
      rate.textContent = "Savings rate " + Math.round(net / inc * 100) + "%";
      rate.className = "muted";
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
    fill.className = "fill" + (status.state === "over" ? " bad" : (status.state === "warn" || status.state === "critical") ? " warn" : "");
    $("bar").setAttribute("aria-valuenow", String(Math.min(100, Math.max(0, Math.round(status.pct)))));

    if (status.state === "unset") {
      $("left").textContent = "—";
      $("leftlbl").textContent = "Set a monthly budget to start tracking";
      $("budgetMeta").textContent = "";
      $("sBudgetLeft").textContent = "—";
      $("sBudgetLeft").className = "muted";
    } else if (status.state === "over") {
      $("left").textContent = fmt.format(status.excess);
      $("leftlbl").textContent = "over budget · " + Math.round(status.pct) + "% used";
      $("budgetMeta").textContent = "Spent " + fmt.format(exp) + " of " + fmt.format(budget) + " · exceeded by " + fmt.format(status.excess);
      $("sBudgetLeft").textContent = "−" + fmt.format(status.excess);
      $("sBudgetLeft").className = "exp";
    } else {
      $("left").textContent = fmt.format(status.remaining);
      $("leftlbl").textContent = "left to spend · " + Math.round(status.pct) + "% used";
      var metaExtra = status.state === "critical" ? " · critical" : status.state === "warn" ? " · warning" : "";
      $("budgetMeta").textContent = "Spent " + fmt.format(exp) + " of " + fmt.format(budget) + metaExtra;
      $("sBudgetLeft").textContent = fmt.format(status.remaining);
      $("sBudgetLeft").className = (status.state === "warn" || status.state === "critical") ? "exp" : "inc";
    }

    $("viewingLabel").textContent = "Viewing " + monthLabel(month);
    return { inc: inc, exp: exp, net: net, mt: mt, budget: budget, status: status };
  }

  /* ============================================================
     Charts
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

    if (ui.raf) cancelAnimationFrame(ui.raf);
    if (reduceMotion) { ui.anim = 1; paint(); renderLegend(); return; }

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
    if (!x) return;
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
    if (!canvas) return -1;
    var rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return -1;
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

  function incomeByMonthForYear(year) {
    var out = []; for (var m = 0; m < 12; m++) out.push(0);
    state.tx.forEach(function (t) {
      if (t.type !== "income") return;
      if (t.date.slice(0, 4) !== String(year)) return;
      var mi = parseInt(t.date.slice(5, 7), 10) - 1;
      if (mi >= 0 && mi < 12) out[mi] = round2(out[mi] + t.amount);
    });
    return out;
  }
  function expensesByMonthForYear(year) {
    var out = []; for (var m = 0; m < 12; m++) out.push(0);
    state.tx.forEach(function (t) {
      if (t.type !== "expense") return;
      if (t.date.slice(0, 4) !== String(year)) return;
      var mi = parseInt(t.date.slice(5, 7), 10) - 1;
      if (mi >= 0 && mi < 12) out[mi] = round2(out[mi] + t.amount);
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
    if (w <= 0 || h <= 0) return;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    var x = canvas.getContext("2d");
    if (!x) return;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, w, h);

    var padL = 52, padR = 16, padT = 18, padB = 34;
    var plotW = w - padL - padR;
    var plotH = h - padT - padB;

    var maxIncome = Math.max.apply(null, incomes);
    var maxExpense = Math.max.apply(null, expenses);
    var baseline = maxIncome > 0 ? maxIncome : maxExpense;
    if (maxExpense > baseline) baseline = maxExpense;
    var yMax = baseline > 0 ? niceCeil(baseline) : 1000;

    x.strokeStyle = cssVar("--line-soft") || "#1a253a";
    x.lineWidth = 1;
    x.font = "11px " + cssVar("--font");
    x.fillStyle = cssVar("--muted") || "#8a97ad";
    x.textAlign = "right";
    x.textBaseline = "middle";
    var steps = 4;
    for (var i = 0; i <= steps; i++) {
      var yy = padT + (plotH / steps) * i;
      x.beginPath(); x.moveTo(padL, yy); x.lineTo(padL + plotW, yy); x.stroke();
      var val = yMax - (yMax / steps) * i;
      x.fillText(shortMoney(val), padL - 8, yy);
    }

    if (maxIncome > 0) {
      var incomeY = padT + plotH - (maxIncome / yMax) * plotH;
      x.save();
      x.strokeStyle = "rgba(52, 211, 153, 0.55)";
      x.setLineDash([5, 4]);
      x.beginPath(); x.moveTo(padL, incomeY); x.lineTo(padL + plotW, incomeY); x.stroke();
      x.restore();
    }

    var slot = plotW / 12;
    var barW = slot * 0.55;
    var accent2 = "#8aa4ff";

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
      } else {
        grad.addColorStop(0, accent2);
        grad.addColorStop(1, "rgba(109,141,255,.35)");
      }
      x.fillStyle = v > 0 ? grad : (cssVar("--line-soft") || "#1a253a");
      roundRect(x, bx, by, barW, Math.max(bh, v > 0 ? 3 : 2), 4);
      x.fill();
    }

    x.fillStyle = cssVar("--muted") || "#8a97ad";
    x.font = "11px " + cssVar("--font");
    x.textAlign = "center";
    x.textBaseline = "top";
    for (var m2 = 0; m2 < 12; m2++) {
      var cx = padL + slot * m2 + slot / 2;
      x.fillText(MONTH_NAMES[m2], cx, padT + plotH + 8);
    }

    var stats = computeTrendStats(expenses, incomes);
    var host = $("trendStats");
    host.innerHTML = [
      statBox("Highest expense month", stats.highest ? MONTH_NAMES[stats.highest.i] + " · " + fmt.format(stats.highest.v) : "—"),
      statBox("Highest income month", stats.highestIncome ? MONTH_NAMES[stats.highestIncome.i] + " · " + fmt.format(stats.highestIncome.v) : "—"),
      statBox("Average expense / month", fmt.format(stats.avg)),
      statBox("Scale basis (Y-axis)", maxIncome > 0 ? "Highest income " + fmt.format(maxIncome) : "No income recorded")
    ].join("");

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
    var sum = 0, count = 0, highest = null, highestIncome = null;
    for (var i = 0; i < 12; i++) {
      var v = expenses[i];
      if (v > 0) { count++; sum += v; if (!highest || v > highest.v) highest = { i: i, v: v }; }
      var inc = incomes[i];
      if (inc > 0 && (!highestIncome || inc > highestIncome.v)) highestIncome = { i: i, v: inc };
    }
    return { highest: highest, avg: count > 0 ? sum / count : 0, highestIncome: highestIncome };
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
      var cls = status.state === "over" ? "bad" : (status.state === "warn" || status.state === "critical") ? "warn" : "";
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
        '<div class="catbudget ' + cls + '" data-cat="' + esc(cat) + '">' +
        '<div class="catbudget-head">' +
        '<i style="background:' + CATS[cat].c + '"></i>' +
        '<b>' + CATS[cat].i + " " + esc(cat) + '</b>' +
        badge +
        '<input type="number" min="0" step="1" placeholder="Target" data-catbudget="' + esc(cat) + '" value="' + (target > 0 ? target : "") + '" aria-label="' + esc(cat) + ' monthly budget">' +
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
    var minV = ui.filterMin;
    var maxV = ui.filterMax;
    var list = txsForMonth($("month").value || thisMonth).filter(function (t) {
      if (ui.filterCat && t.cat !== ui.filterCat) return false;
      if (ui.filterType && t.type !== ui.filterType) return false;
      if (q && t.desc.toLowerCase().indexOf(q) < 0) return false;
      if (minV != null && t.amount < minV) return false;
      if (maxV != null && t.amount > maxV) return false;
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

    var totalAmt = round2(list.reduce(function (s, t) {
      return s + (t.type === "income" ? t.amount : -t.amount);
    }, 0));
    var summary = $("txSummary");
    summary.textContent = list.length + " transaction" + (list.length === 1 ? "" : "s") +
      " · net " + fmtDec.format(totalAmt);

    document.querySelectorAll("th[aria-sort]").forEach(function (th) {
      var b = th.querySelector("button[data-sort]");
      if (!b) return;
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
      return '<button type="button" aria-pressed="' + (ui.cat === k) + '" style="--c:' + CATS[k].c + '" data-c="' + esc(k) + '">' +
        CATS[k].i + " " + esc(k) + '</button>';
    }).join("");
  }

  function updatePreview() {
    var a = parseFloat($("amount").value);
    if (!(a > 0) || !isFinite(a)) { $("preview").textContent = ""; $("preview").className = "preview full"; return; }
    if (ui.type === "income") {
      $("preview").textContent = "Adds " + fmtDec.format(a) + " to this month's income";
      $("preview").className = "preview full muted";
    } else {
      var month = monthOf($("date").value || todayISO());
      var inc = monthIncome(month);
      var exp = monthExpenses(month, ui.editId);
      var bal = round2(inc - exp);
      var projected = round2(bal - a);
      $("preview").textContent = "Deducts " + fmtDec.format(a) + " · projected balance " + fmtDec.format(projected);
      $("preview").className = "preview full " + (projected < 0 ? "exp" : "muted");
    }
  }

  function setFieldError(id, message) {
    var field = $(id);
    var err = $("err-" + id);
    if (!field || !err) return;
    if (message) { field.setAttribute("aria-invalid", "true"); err.textContent = message; }
    else { field.removeAttribute("aria-invalid"); err.textContent = ""; }
  }
  function clearAllErrors() {
    setFieldError("desc", ""); setFieldError("amount", ""); setFieldError("date", "");
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
    else if (!parseDateOnly(date)) errors.date = "Enter a valid date.";

    var allowed = ui.type === "income" ? INCOME_CATS : EXPENSE_CATS;
    if (allowed.indexOf(ui.cat) < 0) errors.desc = errors.desc || "Choose a valid category.";

    return { ok: Object.keys(errors).length === 0, errors: errors, values: { desc: desc, amount: round2(amt), date: date } };
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
    $("form").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    $("desc").focus();
    saveDraft();
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
    clearDraft();
  }

  /* ---- Draft persistence ---- */
  function saveDraft() {
    try {
      var d = {
        type: ui.type,
        cat: ui.cat,
        desc: $("desc").value,
        amount: $("amount").value,
        date: $("date").value
      };
      localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    } catch (e) { /* ignore */ }
  }
  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ }
  }
  function loadDraft() {
    try {
      var raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      var d = JSON.parse(raw);
      if (!d || typeof d !== "object") return;
      if (d.type === "income" || d.type === "expense") ui.type = d.type;
      if (typeof d.cat === "string" && CATS[d.cat]) ui.cat = d.cat;
      if (typeof d.desc === "string") $("desc").value = d.desc;
      if (typeof d.amount === "string") $("amount").value = d.amount;
      if (typeof d.date === "string" && parseDateOnly(d.date)) $("date").value = d.date;
      document.querySelectorAll(".seg button").forEach(function (x) {
        x.setAttribute("aria-checked", String(x.dataset.type === ui.type));
      });
      renderCatChips();
    } catch (e) { /* ignore */ }
  }

  /* ============================================================
     Save flow
  ============================================================ */
  function attemptSave(data) {
    if (ui.type === "expense") {
      var month = monthOf(data.date);
      var inc = monthIncome(month);
      var existingExp = monthExpenses(month, ui.editId);
      var projectedExp = round2(existingExp + data.amount);
      var available = round2(inc - existingExp);
      var projectedBal = round2(inc - projectedExp);

      if (inc <= 0) {
        var noIncBody =
          "No income has been recorded for " + monthLabel(month) + ". " +
          "Recording this expense of " + fmtDec.format(data.amount) + " will create a negative balance of " +
          fmtDec.format(projectedBal) + ".\n\n" +
          "If you have opening funds or savings not tracked here, you can continue anyway.";
        showModal("No income recorded for " + monthLabel(month), noIncBody, "Continue anyway", "Cancel and edit",
          function () { checkBudgetThen(data); });
        return;
      }

      if (projectedBal < 0) {
        var excess = -projectedBal;
        var body =
          "This expense exceeds your available funds for " + monthLabel(month) + ".\n\n" +
          "Available balance: " + fmtDec.format(available) + "\n" +
          "Proposed expense: " + fmtDec.format(data.amount) + "\n" +
          "Projected balance: " + fmtDec.format(projectedBal) + "\n" +
          "Exceeds available funds by: " + fmtDec.format(excess);
        showModal("Expense exceeds available funds", body, "Continue anyway", "Cancel and edit",
          function () { checkBudgetThen(data); });
        return;
      }
    }
    checkBudgetThen(data);
  }

  function checkBudgetThen(data) {
    if (ui.type === "expense" && state.budget > 0) {
      var month = monthOf(data.date);
      var existing = monthExpenses(month, ui.editId);
      var projected = round2(existing + data.amount);
      if (projected > state.budget) {
        var excess = round2(projected - state.budget);
        var body = "Budget exceeded. This transaction will bring your monthly spending to " +
          fmt.format(projected) + ", which is " + fmt.format(excess) + " above your " +
          fmt.format(state.budget) + " budget.";
        showModal("Budget warning", body, "Save anyway", "Cancel and edit",
          function () { finalizeSave(data); });
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
      var prev = state.tx[idx];
      var updated = {
        id: prev.id, type: ui.type, desc: data.desc,
        amount: data.amount, cat: ui.cat, date: data.date
      };
      state.tx[idx] = updated;
      ui.lastId = updated.id;
      if (!save()) {
        state.tx[idx] = prev;
        showToast("Update failed: storage is unavailable.");
        refreshAll();
        return;
      }
      resetForm();
      refreshAll();
      showToast("Transaction updated.");
    } else {
      var rec = {
        id: nextId(), type: ui.type, desc: data.desc,
        amount: data.amount, cat: ui.cat, date: data.date
      };
      state.tx.push(rec);
      ui.lastId = rec.id;
      if (!save()) {
        state.tx.pop();
        showToast("Save failed: storage is unavailable.");
        refreshAll();
        return;
      }
      if (monthOf(rec.date) !== $("month").value) $("month").value = monthOf(rec.date);
      resetForm();
      refreshAll();
      var msg = (rec.type === "income" ? "Income" : "Expense") + " added: " + fmtDec.format(rec.amount);
      var bal = availableBalance(monthOf(rec.date));
      if (bal < 0) {
        msg += " · balance now " + fmtDec.format(bal);
        showToast(msg);
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

  /* ============================================================
     Modal (with focus trap)
  ============================================================ */
  var _modalReturnFocus = null;
  function showModal(title, message, confirmLabel, cancelLabel, onConfirm, onCancel) {
    var backdrop = $("modal");
    _modalReturnFocus = document.activeElement;
    $("modalTitle").textContent = title;
    $("modalBody").textContent = message;
    var confirmBtn = $("modalConfirm");
    var cancelBtn = $("modalCancel");
    confirmBtn.textContent = confirmLabel || "Continue";
    cancelBtn.textContent = cancelLabel || "Cancel and edit";
    backdrop.hidden = false;

    function focusables() {
      return Array.prototype.slice.call(backdrop.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"))
        .filter(function (el) { return !el.disabled && el.offsetParent !== null; });
    }
    function cleanup() {
      confirmBtn.removeEventListener("click", handleConfirm);
      cancelBtn.removeEventListener("click", handleCancel);
      backdrop.removeEventListener("click", handleBackdrop);
      document.removeEventListener("keydown", handleKey);
      backdrop.hidden = true;
      if (_modalReturnFocus && typeof _modalReturnFocus.focus === "function") {
        try { _modalReturnFocus.focus(); } catch (e) { /* ignore */ }
      }
      _modalReturnFocus = null;
    }
    function handleConfirm() { cleanup(); onConfirm && onConfirm(); }
    function handleCancel() { cleanup(); onCancel && onCancel(); }
    function handleBackdrop(e) { if (e.target === backdrop) handleCancel(); }
    function handleKey(e) {
      if (e.key === "Escape") { e.preventDefault(); handleCancel(); return; }
      if (e.key === "Tab") {
        var f = focusables();
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    confirmBtn.addEventListener("click", handleConfirm);
    cancelBtn.addEventListener("click", handleCancel);
    backdrop.addEventListener("click", handleBackdrop);
    document.addEventListener("keydown", handleKey);
    setTimeout(function () { cancelBtn.focus(); }, 30);
  }

  /* ============================================================
     CSV export
  ============================================================ */
  function csvCell(v) {
    var s = String(v == null ? "" : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""').replace(/\r?\n/g, " ") + '"';
  }

  function exportCSV() {
    if (!state.tx.length) { showToast("Nothing to export yet. Add a transaction first."); return; }
    var month = $("month").value || thisMonth;
    var list = txsForMonth(month);
    if (!list.length) { showToast("No transactions in the selected month."); return; }
    var rows = [["ID", "Date", "Description", "Type", "Category", "Amount"]];
    list.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id; });
    list.forEach(function (t) { rows.push([t.id, t.date, t.desc, t.type, t.cat, round2(t.amount).toFixed(2)]); });
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

  /* ============================================================
     JSON backup / restore
  ============================================================ */
  function exportJSON() {
    var payload = {
      app: "ledgerline",
      version: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      data: state
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "ledgerline-backup-" + todayISO() + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    showToast("Backup downloaded.");
  }

  function importJSONFile(file) {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      showToast("Backup file is too large (max " + (MAX_IMPORT_BYTES / 1024 / 1024) + " MB).");
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try { parsed = JSON.parse(String(reader.result)); }
      catch (e) { showToast("That file is not valid JSON."); return; }
      if (!parsed || parsed.app !== "ledgerline" || !parsed.data || typeof parsed.data !== "object") {
        showToast("That file is not a Ledgerline backup.");
        return;
      }
      if (typeof parsed.version === "number" && parsed.version > SCHEMA_VERSION) {
        showToast("This backup was created by a newer version of Ledgerline and cannot be restored.");
        return;
      }
      var d = parsed.data;
      if (!Array.isArray(d.tx)) { showToast("Backup is missing transaction data."); return; }
      if (d.tx.length > MAX_IMPORT_RECORDS) {
        showToast("Backup contains too many records (max " + MAX_IMPORT_RECORDS + ").");
        return;
      }

      // Build a candidate state WITHOUT mutating live state.
      var candidate = {
        version: SCHEMA_VERSION,
        tx: [],
        budget: 0,
        catBudgets: {},
        recurring: [],
        sts: { nextIncomeDate: "", nextIncomeAmount: 0, savingsGoal: 0 },
        lastIdSeq: 0
      };
      var maxId = 0;
      var seen = Object.create(null);
      var invalidTx = 0;
      d.tx.forEach(function (t) {
        if (!isValidTxRecord(t)) { invalidTx++; return; }
        if (seen[t.id]) { invalidTx++; return; }
        seen[t.id] = true;
        if (t.id > maxId) maxId = t.id;
        candidate.tx.push(normalizeTx(t));
      });
      var invalidRec = 0;
      var recSeen = Object.create(null);
      if (Array.isArray(d.recurring)) {
        d.recurring.forEach(function (r) {
          if (!isValidRecurring(r)) { invalidRec++; return; }
          if (seen[r.id] || recSeen[r.id]) { invalidRec++; return; }
          recSeen[r.id] = true;
          if (r.id > maxId) maxId = r.id;
          candidate.recurring.push(normalizeRec(r));
        });
      }
      candidate.budget = (typeof d.budget === "number" && isFinite(d.budget) && d.budget >= 0) ? round2(d.budget) : 0;
      if (d.catBudgets && typeof d.catBudgets === "object" && !Array.isArray(d.catBudgets)) {
        Object.keys(d.catBudgets).forEach(function (k) {
          if (EXPENSE_CATS.indexOf(k) < 0) return;
          var val = d.catBudgets[k];
          if (typeof val === "number" && isFinite(val) && val >= 0) candidate.catBudgets[k] = round2(val);
        });
      }
      if (d.sts && typeof d.sts === "object") {
        var nid = typeof d.sts.nextIncomeDate === "string" && parseDateOnly(d.sts.nextIncomeDate) ? d.sts.nextIncomeDate : "";
        candidate.sts = {
          nextIncomeDate: nid,
          nextIncomeAmount: (typeof d.sts.nextIncomeAmount === "number" && isFinite(d.sts.nextIncomeAmount) && d.sts.nextIncomeAmount >= 0) ? round2(d.sts.nextIncomeAmount) : 0,
          savingsGoal: (typeof d.sts.savingsGoal === "number" && isFinite(d.sts.savingsGoal) && d.sts.savingsGoal >= 0) ? round2(d.sts.savingsGoal) : 0
        };
      }
      candidate.lastIdSeq = maxId;

      var msg = "Restore will REPLACE all current data with:\n\n" +
        "• " + candidate.tx.length + " transactions" +
        (invalidTx ? " (" + invalidTx + " invalid will be skipped)" : "") +
        "\n• " + candidate.recurring.length + " recurring items" +
        (invalidRec ? " (" + invalidRec + " invalid will be skipped)" : "") +
        "\n• Budget: " + fmt.format(candidate.budget) +
        "\n\nThis cannot be undone. Continue?";

      showModal("Restore backup", msg, "Restore and replace", "Cancel",
        function () {
          var snapshot = JSON.parse(JSON.stringify(state));
          state.tx = candidate.tx;
          state.recurring = candidate.recurring;
          state.budget = candidate.budget;
          state.catBudgets = candidate.catBudgets;
          state.sts = candidate.sts;
          state.lastIdSeq = candidate.lastIdSeq;

          if (!save()) {
            // Roll back.
            state.tx = snapshot.tx;
            state.recurring = snapshot.recurring;
            state.budget = snapshot.budget;
            state.catBudgets = snapshot.catBudgets;
            state.sts = snapshot.sts;
            state.lastIdSeq = snapshot.lastIdSeq;
            refreshAll();
            showToast("Restore failed: storage is unavailable. Your previous data was kept.");
            return;
          }
          $("budget").value = state.budget > 0 ? state.budget : "";
          syncSTSInputs();
          initMonthAndYearOptions();
          refreshAll();
          showToast("Backup restored successfully.");
        }
      );
    };
    reader.onerror = function () { showToast("Could not read that file."); };
    reader.readAsText(file);
  }

  /* ============================================================
     Insights
  ============================================================ */
  function renderInsights() {
    var host = $("insightsList");
    if (!host) return;

    var month = $("month").value || thisMonth;
    var current = txsForMonth(month);

    var date = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1);
    date.setMonth(date.getMonth() - 1);
    var previousMonth = iso(date).slice(0, 7);
    var previous = txsForMonth(previousMonth);

    var spent = sumByType(current, "expense");
    var previousSpent = sumByType(previous, "expense");
    var income = sumByType(current, "income");
    var cards = [];

    if (state.budget > 0) {
      var pct = Math.round(spent / state.budget * 100);
      if (pct >= 100) cards.push({ icon: "🚨", title: "Budget exceeded", message: "You have used " + pct + "% of your monthly budget.", tone: "warning" });
      else if (pct >= 75) cards.push({ icon: "⚠️", title: "Budget warning", message: "You have used " + pct + "% of your monthly budget.", tone: "warning" });
      else cards.push({ icon: "✅", title: "Budget status", message: "You have used " + pct + "% of your monthly budget.", tone: "good" });
    } else {
      cards.push({ icon: "🎯", title: "Set a monthly budget", message: "Choose a budget to start tracking your spending limit.", tone: "info" });
    }

    var nowY = today.getFullYear(), nowM = today.getMonth() + 1;
    var isCurrent = month === thisMonth;
    var isPartial = isCurrent && today.getDate() < daysInMonth(nowY, nowM);

    if (previous.length > 0 && previousSpent > 0) {
      var change = Math.round(((spent - previousSpent) / previousSpent) * 100);
      var caveat = isPartial ? " (month in progress — " + today.getDate() + "/" + daysInMonth(nowY, nowM) + " days)" : "";
      if (change > 0) cards.push({ icon: "📈", title: "Spending increased", message: "Your expenses are " + change + "% higher than last month" + caveat + ".", tone: "warning" });
      else if (change < 0) cards.push({ icon: "📉", title: "Spending decreased", message: "Your expenses are " + Math.abs(change) + "% lower than last month" + caveat + ".", tone: "good" });
      else cards.push({ icon: "📊", title: "Spending unchanged", message: "Your total expenses match last month" + caveat + ".", tone: "info" });
    } else if (previous.length > 0 && spent > 0) {
      cards.push({ icon: "📊", title: "New spending activity", message: "You recorded expenses this month, but none last month.", tone: "info" });
    }

    if (income > 0) {
      var net = round2(income - spent);
      var rate = Math.round((net / income) * 100);
      cards.push({
        icon: net >= 0 ? "💰" : "💡",
        title: net >= 0 ? "Savings progress" : "Spending exceeds income",
        message: net >= 0 ? "Your savings rate is " + rate + "% this month." : "Your expenses are higher than your recorded income.",
        tone: net >= 0 ? "good" : "warning"
      });
    }

    var sts = computeSafeToSpend();
    if (sts.daily > 0 && sts.daysRemaining > 0) {
      cards.push({
        icon: "💸",
        title: "Safe to spend",
        message: "About " + fmt.format(sts.daily) + "/day for the next " + sts.daysRemaining + " day" + (sts.daysRemaining === 1 ? "" : "s") + ".",
        tone: "info"
      });
    } else if (sts.daily < 0) {
      cards.push({
        icon: "🚧",
        title: "Over-committed",
        message: "Your upcoming obligations exceed your available funds by " + fmt.format(-sts.usable) + ".",
        tone: "warning"
      });
    }

    if (sts.upcomingList.length) {
      var next = sts.upcomingList[0];
      cards.push({
        icon: "🔁",
        title: "Upcoming payment",
        message: next.desc + " (" + fmt.format(next.amount) + ") due " + next.date + ".",
        tone: "info"
      });
    }

    if (cards.length === 0) {
      cards.push({ icon: "📝", title: "Start tracking", message: "Add transactions to unlock your financial insights.", tone: "info" });
    }

    host.innerHTML = cards.map(function (card) {
      return '<article class="insight-card ' + card.tone + '">' +
        '<span class="insight-icon" aria-hidden="true">' + card.icon + '</span>' +
        '<h3>' + esc(card.title) + '</h3>' +
        '<p>' + esc(card.message) + '</p>' +
        '</article>';
    }).join("");
  }

  /* ============================================================
     Recurring
  ============================================================ */
  function renderRecurring() {
    var host = $("recurringGrid");
    if (!state.recurring.length) {
      host.innerHTML = '<p class="empty" style="grid-column:1/-1">No recurring items yet. Add rent, subscriptions, or regular income.</p>';
      return;
    }
    var todayD = new Date(); todayD.setHours(0, 0, 0, 0);
    var sorted = state.recurring.slice().sort(function (a, b) {
      var da = nextOccurrence(a, todayD), db = nextOccurrence(b, todayD);
      if (!da) return 1; if (!db) return -1;
      return da - db;
    });
    host.innerHTML = sorted.map(function (r) {
      var occ = nextOccurrence(r, todayD);
      var daysTo = occ ? Math.round((occ - todayD) / 86400000) : null;
      var catMeta = CATS[r.cat] || CATS.Other;
      var soon = daysTo != null && daysTo >= 0 && daysTo <= 7;
      var overdue = daysTo != null && daysTo < 0;
      var cls = overdue ? "overdue" : soon ? "soon" : "";
      return '<div class="recurring-card ' + cls + '">' +
        '<div class="recurring-top">' +
        '<span class="chip"><i style="background:' + catMeta.c + '"></i>' + catMeta.i + ' ' + esc(r.cat) + '</span>' +
        '<span class="recurring-freq">' + esc(r.freq) + '</span>' +
        '</div>' +
        '<h3>' + esc(r.desc) + '</h3>' +
        '<div class="recurring-amount ' + (r.type === "income" ? "inc" : "exp") + '">' +
        (r.type === "income" ? "+" : "−") + fmtDec.format(r.amount) + '</div>' +
        (occ ? '<div class="recurring-next">Next: ' + iso(occ) + (daysTo != null ? ' · in ' + daysTo + ' day' + (daysTo === 1 ? "" : "s") : '') + '</div>' : '') +
        '<div class="recurring-actions">' +
        '<button class="btn" type="button" data-recedit="' + r.id + '">Edit</button>' +
        '<button class="btn" type="button" data-recdel="' + r.id + '">Delete</button>' +
        '</div>' +
        '</div>';
    }).join("");
  }

  function syncRecurringCatOptions() {
    var type = $("recType").value;
    var cats = type === "income" ? INCOME_CATS : EXPENSE_CATS;
    $("recCat").innerHTML = cats.map(function (c) { return "<option>" + esc(c) + "</option>"; }).join("");
  }

  var _editingRecId = null;
  function startEditRecurring(id) {
    var r = state.recurring.find(function (x) { return x.id === id; });
    if (!r) return;
    _editingRecId = id;
    $("recDesc").value = r.desc;
    $("recAmount").value = r.amount;
    $("recType").value = r.type;
    syncRecurringCatOptions();
    $("recCat").value = r.cat;
    $("recFreq").value = r.freq;
    $("recNext").value = r.next;
    $("recurringForm").hidden = false;
    $("recSave").textContent = "Update";
    $("recDesc").focus();
  }

  function saveRecurring() {
    var desc = $("recDesc").value.trim();
    var amount = parseFloat($("recAmount").value);
    var type = $("recType").value;
    var cat = $("recCat").value;
    var freq = $("recFreq").value;
    var next = $("recNext").value;

    if (!desc) { showToast("Recurring description is required."); return; }
    if (desc.length > MAX_DESC_LEN) { showToast("Description must be " + MAX_DESC_LEN + " characters or fewer."); return; }
    if (!(amount > 0) || !isFinite(amount) || amount > MAX_AMOUNT) { showToast("Amount must be between 0 and " + fmt.format(MAX_AMOUNT) + "."); return; }
    if (!parseDateOnly(next)) { showToast("Choose a valid next date."); return; }
    var allowed = type === "income" ? INCOME_CATS : EXPENSE_CATS;
    if (allowed.indexOf(cat) < 0) { showToast("Choose a valid category."); return; }

    if (_editingRecId != null) {
      var idx = state.recurring.findIndex(function (r) { return r.id === _editingRecId; });
      if (idx < 0) { showToast("That recurring item no longer exists."); resetRecurringForm(); return; }
      state.recurring[idx] = { id: _editingRecId, type: type, desc: desc, amount: round2(amount), cat: cat, freq: freq, next: next };
      if (!save()) { showToast("Update failed: storage is unavailable."); return; }
      showToast("Recurring item updated.");
    } else {
      state.recurring.push({ id: nextId(), type: type, desc: desc, amount: round2(amount), cat: cat, freq: freq, next: next });
      if (!save()) { showToast("Save failed: storage is unavailable."); state.recurring.pop(); return; }
      showToast("Recurring item added.");
    }
    resetRecurringForm();
    renderRecurring();
    renderSTS();
    renderInsights();
  }

  function resetRecurringForm() {
    _editingRecId = null;
    $("recurringForm").hidden = true;
    $("recDesc").value = ""; $("recAmount").value = ""; $("recNext").value = todayISO();
    $("recSave").textContent = "Save";
  }

  /* ============================================================
     STS settings
  ============================================================ */
  function syncSTSInputs() {
    $("stsNextIncomeDate").value = state.sts.nextIncomeDate || "";
    $("stsNextIncome").value = state.sts.nextIncomeAmount > 0 ? state.sts.nextIncomeAmount : "";
    $("stsSavingsGoal").value = state.sts.savingsGoal > 0 ? state.sts.savingsGoal : "";
  }

  function saveSTSSettings() {
    var date = $("stsNextIncomeDate").value;
    var amtRaw = $("stsNextIncome").value;
    var goalRaw = $("stsSavingsGoal").value;
    var amt = amtRaw === "" ? 0 : parseFloat(amtRaw);
    var goal = goalRaw === "" ? 0 : parseFloat(goalRaw);

    if (date && !parseDateOnly(date)) { showToast("Next income date is invalid."); return; }
    if (amtRaw !== "" && (!isFinite(amt) || amt < 0)) { showToast("Expected income must be a non-negative number."); return; }
    if (goalRaw !== "" && (!isFinite(goal) || goal < 0)) { showToast("Savings goal must be a non-negative number."); return; }

    state.sts.nextIncomeDate = date || "";
    state.sts.nextIncomeAmount = round2(amt);
    state.sts.savingsGoal = round2(goal);
    if (!save()) return;
    $("stsConfig").hidden = true;
    $("stsSettings").setAttribute("aria-expanded", "false");
    renderSTS();
    renderInsights();
    showToast("Safe-to-Spend updated.");
  }

  /* ============================================================
     Refresh orchestration
  ============================================================ */
  function refreshAll() {
    renderStats();
    renderSTS();
    renderInsights();
    drawChart();
    renderTrend();
    renderCategoryBudgets();
    renderRecurring();
    renderTable();
  }

  /* ============================================================
     Theme
  ============================================================ */
  function applyTheme(theme) {
    if (theme !== "dark" && theme !== "light") theme = "dark";
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* ignore */ }
    var btn = $("themeToggle");
    if (btn) {
      btn.textContent = theme === "dark" ? "🌙" : "☀️";
      btn.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
      btn.setAttribute("aria-pressed", String(theme === "light"));
    }
  }
  function loadTheme() {
    var saved = "dark";
    try {
      var v = localStorage.getItem(THEME_KEY);
      if (v === "dark" || v === "light") saved = v;
      else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) saved = "light";
    } catch (e) { /* ignore */ }
    applyTheme(saved);
  }
  function toggleTheme() {
    var cur = document.documentElement.getAttribute("data-theme");
    applyTheme(cur === "dark" ? "light" : "dark");
    paint();
    renderTrend();
  }

  /* ============================================================
     Wire-up
  ============================================================ */
  function initMonthAndYearOptions() {
    var prevYear = $("year").value;
    var years = new Set();
    state.tx.forEach(function (t) { years.add(parseInt(t.date.slice(0, 4), 10)); });
    years.add(today.getFullYear());
    var sorted = Array.from(years).sort(function (a, b) { return b - a; });
    var yearSel = $("year");
    yearSel.innerHTML = sorted.map(function (y) { return "<option>" + y + "</option>"; }).join("");
    if (sorted.indexOf(ui.trendYear) < 0) {
      ui.trendYear = prevYear ? parseInt(prevYear, 10) : sorted[0];
      if (sorted.indexOf(ui.trendYear) < 0) ui.trendYear = sorted[0];
    }
    yearSel.value = String(ui.trendYear);
  }

  function bindEvents() {
    document.querySelectorAll(".seg button").forEach(function (b) {
      b.addEventListener("click", function () {
        ui.type = b.dataset.type;
        document.querySelectorAll(".seg button").forEach(function (x) {
          x.setAttribute("aria-checked", String(x === b));
        });
        renderCatChips();
        updatePreview();
        saveDraft();
      });
    });

    $("catchips").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-c]");
      if (!b) return;
      ui.cat = b.dataset.c;
      renderCatChips();
      saveDraft();
    });

    $("desc").addEventListener("input", saveDraft);
    $("amount").addEventListener("input", function () { updatePreview(); saveDraft(); });
    $("date").addEventListener("input", function () { updatePreview(); saveDraft(); });

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

    $("budget").addEventListener("input", function () {
      var v = parseFloat(this.value);
      var newVal = isFinite(v) && v >= 0 ? round2(v) : 0;
      var prev = state.budget;
      state.budget = newVal;
      if (!save()) { state.budget = prev; this.value = prev > 0 ? prev : ""; return; }
      renderStats();
      renderInsights();
      renderCategoryBudgets();
    });

    $("catBudgets").addEventListener("input", function (e) {
      var input = e.target.closest("input[data-catbudget]");
      if (!input) return;
      var cat = input.dataset.catbudget;
      if (EXPENSE_CATS.indexOf(cat) < 0) return;
      var v = parseFloat(input.value);
      var prev = state.catBudgets[cat];
      if (isFinite(v) && v > 0) state.catBudgets[cat] = round2(v);
      else delete state.catBudgets[cat];
      if (!save()) {
        if (prev != null) state.catBudgets[cat] = prev; else delete state.catBudgets[cat];
        return;
      }
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

    $("month").addEventListener("input", function () { refreshAll(); });
    $("fcat").addEventListener("change", function () { setFilter(this.value); });
    $("ftype").addEventListener("change", function () { ui.filterType = this.value; renderTable(); });
    $("q").addEventListener("input", renderTable);
    $("fmin").addEventListener("input", function () {
      var v = parseFloat(this.value);
      ui.filterMin = isFinite(v) && v >= 0 ? v : null;
      renderTable();
    });
    $("fmax").addEventListener("input", function () {
      var v = parseFloat(this.value);
      ui.filterMax = isFinite(v) && v >= 0 ? v : null;
      renderTable();
    });
    $("resetFilters").addEventListener("click", function () {
      $("q").value = "";
      $("ftype").value = "";
      $("fmin").value = "";
      $("fmax").value = "";
      ui.filterType = "";
      ui.filterMin = null;
      ui.filterMax = null;
      setFilter("");
      renderTable();
    });

    $("year").addEventListener("change", function () {
      ui.trendYear = parseInt(this.value, 10);
      renderTrend();
    });

    document.querySelectorAll("th button[data-sort]").forEach(function (b) {
      b.addEventListener("click", function () {
        var k = b.dataset.sort;
        if (ui.sortKey === k) ui.sortDir *= -1;
        else { ui.sortKey = k; ui.sortDir = (k === "amount" || k === "date") ? -1 : 1; }
        renderTable();
      });
    });

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

    $("csv").addEventListener("click", exportCSV);
    $("backup").addEventListener("click", exportJSON);
    $("restore").addEventListener("click", function () { $("restoreFile").click(); });
    $("restoreFile").addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) importJSONFile(f);
      e.target.value = "";
    });

    $("themeToggle").addEventListener("click", toggleTheme);

    $("clearData").addEventListener("click", function () {
      if (!state.tx.length && !state.budget && !Object.keys(state.catBudgets).length && !state.recurring.length) {
        showToast("Nothing to clear.");
        return;
      }
      showModal(
        "Clear all data?",
        "This will permanently delete " + state.tx.length + " transaction" +
        (state.tx.length === 1 ? "" : "s") + ", " + state.recurring.length + " recurring item" +
        (state.recurring.length === 1 ? "" : "s") + ", and reset your budgets. This cannot be undone.",
        "Delete everything", "Cancel",
        function () {
          var snapshot = JSON.parse(JSON.stringify(state));
          state.tx = [];
          state.budget = 0;
          state.catBudgets = {};
          state.recurring = [];
          state.sts = { nextIncomeDate: "", nextIncomeAmount: 0, savingsGoal: 0 };
          state.lastIdSeq = 0;
          if (!save()) {
            state = snapshot;
            showToast("Clear failed: storage is unavailable.");
            refreshAll();
            return;
          }
          $("budget").value = "";
          syncSTSInputs();
          refreshAll();
          showToast("All data cleared.");
        }
      );
    });

    $("stsSettings").addEventListener("click", function () {
      var hidden = $("stsConfig").hidden;
      $("stsConfig").hidden = !hidden;
      this.setAttribute("aria-expanded", String(hidden));
      if (hidden) $("stsNextIncomeDate").focus();
    });
    $("stsSave").addEventListener("click", saveSTSSettings);

    $("addRecurring").addEventListener("click", function () {
      $("recurringForm").hidden = !$("recurringForm").hidden;
      if (!$("recurringForm").hidden) {
        resetRecurringForm();
        $("recurringForm").hidden = false;
        $("recNext").value = todayISO();
        syncRecurringCatOptions();
        $("recDesc").focus();
      }
    });
    $("recType").addEventListener("change", syncRecurringCatOptions);
    $("recSave").addEventListener("click", saveRecurring);
    $("recCancel").addEventListener("click", resetRecurringForm);
    $("recurringGrid").addEventListener("click", function (e) {
      var editBtn = e.target.closest("[data-recedit]");
      if (editBtn) { startEditRecurring(Number(editBtn.dataset.recedit)); return; }
      var b = e.target.closest("[data-recdel]");
      if (!b) return;
      var id = Number(b.dataset.recdel);
      var idx = state.recurring.findIndex(function (r) { return r.id === id; });
      if (idx < 0) return;
      var removed = state.recurring[idx];
      var snapshot = state.recurring.slice();
      state.recurring.splice(idx, 1);
      if (!save()) {
        state.recurring = snapshot;
        showToast("Delete failed: storage is unavailable.");
        return;
      }
      renderRecurring();
      renderSTS();
      renderInsights();
      showToast("Removed “" + removed.desc + "”", "Undo", function () {
        if (!state.recurring.some(function (r) { return r.id === removed.id; })) {
          state.recurring.push(removed);
          save();
          renderRecurring();
          renderSTS();
          renderInsights();
        }
      });
    });

    var resizeTimer;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { paint(); renderTrend(); }, 120);
    });

    document.addEventListener("keydown", function (e) {
      if (!e) return;
      var backdrop = $("modal");
      if (!backdrop.hidden) return;
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
    var snapshot = state.tx.slice();
    if (row) row.classList.add("leaving");
    setTimeout(function () {
      var currentIdx = state.tx.findIndex(function (t) { return t.id === id; });
      if (currentIdx < 0) return;
      state.tx.splice(currentIdx, 1);
      if (!save()) {
        state.tx = snapshot;
        refreshAll();
        showToast("Delete failed: storage is unavailable.");
        return;
      }
      refreshAll();
      showToast("Deleted “" + removed.desc + "”", "Undo", function () {
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
    { k: ["trend", "monthly", "chart"], a: "The Monthly expense trends chart shows all 12 months of the selected year. The Y-axis scale is based on the highest monthly income for that year. Use the Year selector to switch." },
    { k: ["csv", "export", "download"], a: "Export CSV downloads the currently-selected month's transactions." },
    { k: ["backup", "json", "restore", "import"], a: "Use Backup JSON to download a full snapshot of your data. Restore lets you replace your current data from a backup file. Restore cannot be undone." },
    { k: ["safe", "spend", "sts", "planner"], a: "Safe to Spend estimates how much you can spend per day until your next income. Click Settings on the Safe to Spend panel to configure your next income date, amount, and savings goal." },
    { k: ["recurring", "subscription", "rent", "repeat", "monthly"], a: "Add recurring items (rent, subscriptions, regular income) in the Recurring & upcoming panel. These are reminders — they are not auto-charged. They are included in your Safe to Spend calculation." },
    { k: ["theme", "dark", "light", "mode"], a: "Use the 🌙/☀️ button in the header to switch between dark and light themes. Your choice is remembered." },
    { k: ["save", "data", "persist", "lost", "storage"], a: "Your data is saved in this browser's localStorage. Clearing site data or switching browsers will remove it. Use Backup JSON to keep a portable copy." },
    { k: ["overspend", "balance", "negative", "exceed", "available"], a: "When you add an expense that exceeds the income recorded for that month, Ledgerline warns you before saving." },
    { k: ["hi", "hello", "hey", "help"], a: "Hi! Ask about budgets, Safe to Spend, recurring items, backups, adding or editing transactions, the trend chart, sorting, export, or overspending." }
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
      item.k.forEach(function (kw) { if (words.indexOf(kw) > -1) s += kw.length; });
      if (s > score) { score = s; best = item; }
    });
    return best ? best.a
      : "I'm not sure about that. Try asking about budgets, Safe to Spend, recurring items, backups, adding transactions, or exporting.";
  }
  function botAsk(q) {
    q = q.trim();
    if (!q) return;
    if (q === ui.lastBotAnswer) return;
    ui.lastBotAnswer = q;
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
    ["How do I set a budget?", "What is Safe to Spend?", "Add a recurring bill", "How do backups work?"].forEach(function (t) {
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
    loadTheme();
    load();

    $("date").value = todayISO();
    $("month").value = thisMonth;
    $("budget").value = state.budget > 0 ? state.budget : "";

    $("fcat").innerHTML = "<option value=''>All categories</option>" +
      Object.keys(CATS).map(function (n) { return "<option>" + esc(n) + "</option>"; }).join("");

    syncSTSInputs();
    syncRecurringCatOptions();
    $("recNext").value = todayISO();

    initMonthAndYearOptions();
    renderCatChips();
    loadDraft();
    updatePreview();
    bindEvents();
    initBot();

    refreshAll();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();