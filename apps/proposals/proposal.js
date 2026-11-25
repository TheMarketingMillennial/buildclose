(function () {
  "use strict";
  var f = document.getElementById("firms");
  var c = document.getElementById("cases");
  var r = document.getElementById("rate");
  var p = document.getElementById("plat");
  if (!f || !c || !r || !p) return;

  var oF = document.getElementById("oFirms");
  var oC = document.getElementById("oCases");
  var oR = document.getElementById("oRate");
  var oP = document.getElementById("oPlat");
  var rArr = document.getElementById("rArr");
  var rMrr = document.getElementById("rMrr");
  var rPer = document.getElementById("rPer");
  var rCases = document.getElementById("rCases");
  var rOpex = document.getElementById("rOpex");
  var rNet = document.getElementById("rNet");

  function money(n) {
    return "$" + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function calc() {
    var firms = parseInt(f.value, 10) || 0;
    var perFirm = parseInt(c.value, 10) || 0;
    var rate = parseInt(r.value, 10) || 0;
    var plat = parseInt(p.value, 10) || 0;

    var active = firms * perFirm;
    var mrr = firms * plat + active * rate;
    var arr = mrr * 12;
    var per = firms ? mrr / firms : 0;
    var stripe = mrr * 0.029 + firms * 0.30;
    var infra = 120 + firms * 8 + active * 0.18;
    var opex = stripe + infra;
    var net = mrr - opex;

    oF.textContent = firms;
    oC.textContent = perFirm;
    oR.textContent = money(rate);
    oP.textContent = money(plat);
    rMrr.textContent = money(mrr);
    rArr.textContent = money(arr);
    rPer.textContent = money(per);
    rCases.textContent = active.toLocaleString("en-US");
    rOpex.textContent = money(opex);
    rNet.textContent = (net < 0 ? "\u2212" : "") + money(Math.abs(net));
  }

  [f, c, r, p].forEach(function (el) {
    el.addEventListener("input", calc);
    el.addEventListener("change", calc);
  });
  calc();
})();

/**
 * Proposal actions.
 *
 * Native acceptance is deliberately NOT reimplemented here. The single acceptance
 * implementation lives inside the assistant frame, because that is where the
 * prospect's session token and the document hash they were shown already are.
 * A second copy on this page would mean two code paths able to record an
 * acceptance, and only one of them would perform the hash check.
 */
(function () {
  "use strict";

  var accept = document.getElementById("bc-accept");
  var pay = document.getElementById("bc-pay");
  var actions = document.getElementById("bc-actions");

  if (pay) {
    var href = (pay.getAttribute("href") || "").trim();
    // The payment URL is injected at build time. Hide the control rather than
    // ship a dead link when it has not been configured.
    var unset = !href || href === "#" || href.indexOf("__BC_") === 0;
    pay.hidden = unset;
  }

  if (!accept) return;

  accept.addEventListener("click", function () {
    if (window.BuildClose && window.BuildClose.openAcceptance) {
      window.BuildClose.openAcceptance();
      return;
    }
    // The widget is blocked, still loading, or blocked by an extension. Say so
    // instead of appearing to do nothing.
    if (actions) actions.scrollIntoView({ behavior: "smooth", block: "center" });
    var label = accept.textContent;
    accept.textContent = "Loading assistant\u2026";
    setTimeout(function () { accept.textContent = label; }, 2500);
  });
})();
