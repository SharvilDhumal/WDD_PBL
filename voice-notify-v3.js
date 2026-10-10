(function () {
  "use strict";

  var STORAGE_KEY = "ledgerline-v3";
  var ALERTS_KEY = "ledgerline-alerts";
  var LANG_KEY = "ledgerline-voice-lang";

  function $(id) { return document.getElementById(id); }
  function iso(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function loadState() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") || { tx: [], budget: 0 }; }
    catch (e) { return { tx: [], budget: 0 }; }
  }

  /* ---------- Pure logic ---------- */

  var CATEGORY_WORDS = {
    Food: ["food", "lunch", "dinner", "breakfast", "groceries", "grocery", "coffee", "restaurant", "snack", "pizza"],
    Transport: ["uber", "taxi", "cab", "bus", "metro", "train", "fuel", "petrol", "auto", "ola"],
    Bills: ["rent", "bill", "bills", "electricity", "water", "internet", "phone", "recharge"],
    Shopping: ["shopping", "clothes", "shoes", "amazon", "flipkart"],
    Health: ["doctor", "medicine", "medicines", "pharmacy", "gym", "hospital"],
    Fun: ["movie", "movies", "game", "games", "concert", "party", "netflix"],
    Salary: ["salary"]
  };
  var EXPENSE_CATS = ["Food", "Transport", "Bills", "Shopping", "Health", "Fun", "Other"];
  var INCOME_CATS = ["Salary", "Other"];

  function parseSpeech(text, today) {
    today = today || new Date();
    var t = String(text || "").toLowerCase();
    var result = { type: "expense", amount: "", cat: "Other", desc: "", date: iso(today) };

    var num = t.match(/(\d+(?:\.\d+)?)/);
    if (num) result.amount = num[1];

    if (/\b(salary|income|received|got paid|earned|credited)\b/.test(t)) result.type = "income";

    if (/\byesterday\b/.test(t)) {
      var y = new Date(today);
      y.setDate(y.getDate() - 1);
      result.date = iso(y);
    }

    var cats = Object.keys(CATEGORY_WORDS);
    for (var i = 0; i < cats.length; i++) {
      var words = CATEGORY_WORDS[cats[i]];
      var hit = words.some(function (w) { return new RegExp("\\b" + w + "\\b").test(t); });
      if (hit) { result.cat = cats[i]; break; }
    }

    var desc = t
      .replace(/(\d+(?:\.\d+)?)/g, " ")
      .replace(/\b(rupees?|rs|inr|spent|paid|on|for|yesterday|today|i|got|received|earned|credited)\b/g, " ")
      .replace(/₹/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    result.desc = desc ? desc.charAt(0).toUpperCase() + desc.slice(1) : "Voice entry";
    return result;
  }

  function budgetLevel(spent, budget) {
    if (!(budget > 0)) return null;
    var pct = spent / budget * 100;
    return pct >= 100 ? "over" : pct >= 75 ? "warn" : null;
  }

  /* ---------- Test suite: run LedgerlineVoice.runTests() in the Console ---------- */

  var TESTS = [
    { input: "Spent 450 rupees on lunch yesterday", want: { type: "expense", amount: "450", cat: "Food", desc: "Lunch", dayOffset: -1 } },
    { input: "Got salary 62000", want: { type: "income", amount: "62000", cat: "Salary", desc: "Salary", dayOffset: 0 } },
    { input: "Uber to office 180", want: { type: "expense", amount: "180", cat: "Transport", desc: "Uber to office", dayOffset: 0 } },
    { input: "Paid rent 18000", want: { type: "expense", amount: "18000", cat: "Bills", desc: "Rent", dayOffset: 0 } },
    { input: "Coffee 120.50", want: { type: "expense", amount: "120.50", cat: "Food", desc: "Coffee", dayOffset: 0 } },
    { input: "bought shoes 2500", want: { type: "expense", amount: "2500", cat: "Shopping", desc: "Bought shoes", dayOffset: 0 } },
    { input: "something with no number", want: { type: "expense", amount: "", cat: "Other", dayOffset: 0 } }
  ];

  function runTests() {
    var fixed = new Date(2026, 9, 11);
    var rows = TESTS.map(function (tc) {
      var got = parseSpeech(tc.input, fixed);
      var problems = [];
      ["type", "amount", "cat", "desc"].forEach(function (k) {
        if (tc.want[k] !== undefined && String(got[k]) !== String(tc.want[k])) {
          problems.push(k + " was '" + got[k] + "', expected '" + tc.want[k] + "'");
        }
      });
      var d = new Date(fixed);
      d.setDate(d.getDate() + tc.want.dayOffset);
      if (got.date !== iso(d)) problems.push("date was " + got.date + ", expected " + iso(d));
      return { input: tc.input, result: problems.length ? "FAIL" : "PASS", problems: problems.join("; ") };
    });

    [[budgetLevel(500, 1000), null], [budgetLevel(750, 1000), "warn"], [budgetLevel(1000, 1000), "over"], [budgetLevel(500, 0), null]]
      .forEach(function (c, i) {
        rows.push({ input: "budgetLevel check " + (i + 1), result: c[0] === c[1] ? "PASS" : "FAIL", problems: c[0] === c[1] ? "" : "got " + c[0] + ", expected " + c[1] });
      });

    console.table(rows);
    var passed = rows.filter(function (r) { return r.result === "PASS"; }).length;
    console.log(passed + " of " + rows.length + " checks passed");
    return rows;
  }

  window.LedgerlineVoice = { parseSpeech: parseSpeech, budgetLevel: budgetLevel, runTests: runTests };

  /* ---------- Fill the form ---------- */

  function fillForm(data) {
    var typeBtn = document.querySelector('.seg button[data-type="' + data.type + '"]');
    if (typeBtn) typeBtn.click();

    var list = data.type === "income" ? INCOME_CATS : EXPENSE_CATS;
    var cat = list.indexOf(data.cat) > -1 ? data.cat : "Other";
    var chip = document.querySelector('#catchips button[data-c="' + cat + '"]');
    if (chip) chip.click();

    $("desc").value = data.desc;
    $("amount").value = data.amount;
    $("amount").dispatchEvent(new Event("input"));
    $("date").value = data.date;
  }

  function speak(text, lang) {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    window.speechSynthesis.speak(u);
  }

  /* ---------- 1. Voice entry ---------- */

  var mic = $("mic");
  var statusEl = $("vstatus");
  var langSel = $("vlang");
  var speakBox = $("vspeak");
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  function setStatus(msg) {
    console.log("[voice] " + msg);
    if (statusEl) statusEl.textContent = msg;
  }
  function setMicState(listening) {
    if (!mic) return;
    mic.setAttribute("aria-pressed", String(listening));
    mic.textContent = listening ? "Listening… (click to stop)" : "🎤 Speak a transaction";
  }

  if (langSel) {
    langSel.value = localStorage.getItem(LANG_KEY) || "en-IN";
  }

  if (mic && !SR) {
    mic.disabled = true;
    mic.textContent = "🎤 Voice not supported";
    setStatus("Voice input works in Chrome and Edge.");
  } else if (mic && SR) {
    var rec = new SR();
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.lang = langSel ? langSel.value : "en-IN";

    var gotResult = false;
    var hadError = false;

    if (langSel) {
      langSel.addEventListener("change", function () {
        rec.lang = langSel.value;
        try { localStorage.setItem(LANG_KEY, langSel.value); } catch (e) {}
      });
    }

    rec.onstart = function () {
      setMicState(true);
      setStatus("Microphone on. Speak now: “Spent 450 rupees on lunch”.");
    };
    rec.onaudiostart = function () { console.log("[voice] audio capture started"); };
    rec.onspeechstart = function () { setStatus("Hearing you…"); };
    rec.onspeechend = function () { setStatus("Got it, working out the words…"); };
    rec.onnomatch = function () {
      hadError = true;
      setStatus("I heard sound but couldn't make out words. Try again, a bit slower.");
    };

    rec.onresult = function (e) {
      gotResult = true;
      var heard = e.results[0][0].transcript;
      console.log("[voice] heard:", heard, "confidence:", e.results[0][0].confidence);
      var data = parseSpeech(heard);
      fillForm(data);
      setStatus("Heard: “" + heard + "”. Check the fields, then press Add transaction.");
      if (speakBox && speakBox.checked) {
        var kind = data.type === "income" ? "Income" : "Expense";
        speak(kind + " of " + data.amount + " rupees for " + data.desc + ", category " + data.cat + ".", rec.lang);
      }
    };

    rec.onerror = function (e) {
      hadError = true;
      console.warn("[voice] error:", e.error);
      var msg = e.error === "no-speech" ? "No speech detected. Click the mic, then speak within a few seconds."
              : e.error === "audio-capture" ? "No microphone found. Check the input device in your system settings."
              : e.error === "not-allowed" ? "Microphone access is blocked. Click the lock icon in the address bar and set Microphone to Allow."
              : e.error === "network" ? "Speech service unreachable. Check your internet connection."
              : "Couldn't listen (" + e.error + "). Try again.";
      setStatus(msg);
    };

    rec.onend = function () {
      setMicState(false);
      if (!gotResult && !hadError) {
        setStatus("Stopped without hearing a phrase. Click the mic and speak after it turns red.");
      }
      gotResult = false;
      hadError = false;
    };

    mic.addEventListener("click", function () {
      if (mic.getAttribute("aria-pressed") === "true") {
        rec.stop();
        return;
      }
      setStatus("Starting microphone… allow access if asked.");
      try {
        rec.start();
      } catch (e) {
        setStatus("Microphone is already starting. Wait a second and try again.");
      }
    });
  }

  /* ---------- 2. Budget alerts ---------- */

  var notifyBtn = $("notify");

  function notify(title, body, tag) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    try {
      new Notification(title, { body: body, tag: tag });
    } catch (e) {
      console.warn("Notification failed:", e);
    }
  }

  function updateNotifyButton() {
    if (!notifyBtn) return;
    if (!("Notification" in window)) {
      notifyBtn.disabled = true;
      notifyBtn.textContent = "Alerts not supported";
      return;
    }
    if (Notification.permission === "granted") notifyBtn.textContent = "Alerts on";
    else if (Notification.permission === "denied") notifyBtn.textContent = "Alerts blocked";
    else notifyBtn.textContent = "Enable alerts";
  }

  function checkBudget() {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    var s = loadState();
    var month = iso(new Date()).slice(0, 7);
    var spent = s.tx
      .filter(function (t) { return t.type === "expense" && t.date.slice(0, 7) === month; })
      .reduce(function (sum, t) { return sum + t.amount; }, 0);

    var level = budgetLevel(spent, s.budget);
    if (!level) return;

    var sent = {};
    try { sent = JSON.parse(localStorage.getItem(ALERTS_KEY) || "{}"); } catch (e) {}
    var key = month + "-" + level;
    if (sent[key]) return;

    var pct = Math.round(spent / s.budget * 100);
    if (level === "over") {
      notify("Over budget", "You've spent ₹" + Math.round(spent) + " this month, over your budget of ₹" + s.budget + ".", key);
    } else {
      notify("Budget almost reached", "You've used " + pct + "% of your ₹" + s.budget + " budget.", key);
    }

    sent[key] = true;
    try { localStorage.setItem(ALERTS_KEY, JSON.stringify(sent)); } catch (e) {}
  }

  if (notifyBtn) {
    notifyBtn.addEventListener("click", function () {
      if (!("Notification" in window)) return;
      if (Notification.permission === "default") {
        Notification.requestPermission().then(function (p) {
          updateNotifyButton();
          if (p === "granted") {
            notify("Ledgerline alerts on", "We'll tell you at 75% and 100% of your budget.", "ledgerline-on");
            checkBudget();
          }
        });
      } else if (Notification.permission === "granted") {
        notify("Ledgerline", "Alerts are already on.", "ledgerline-test");
      } else {
        alert("Notifications are blocked. Allow them in your browser's site settings.");
      }
    });
  }

  var form = $("form");
  if (form) form.addEventListener("submit", function () { setTimeout(checkBudget, 0); });
  setInterval(checkBudget, 60000);

  updateNotifyButton();
  checkBudget();
})();