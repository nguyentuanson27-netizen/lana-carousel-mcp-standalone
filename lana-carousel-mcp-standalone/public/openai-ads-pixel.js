(function () {
  "use strict";

  var SDK_URL = "https://bzrcdn.openai.com/sdk/oaiq.min.js";
  var initializedPixelId = null;

  function ensureQueue() {
    if (window.oaiq) return window.oaiq;
    var q = function () { q.q.push(arguments); };
    q.q = [];
    window.oaiq = q;

    var script = document.createElement("script");
    script.async = true;
    script.src = SDK_URL;
    var firstScript = document.getElementsByTagName("script")[0];
    firstScript.parentNode.insertBefore(script, firstScript);
    return q;
  }

  function readCookie(name) {
    var prefix = name + "=";
    var parts = String(document.cookie || "").split(";");
    for (var i = 0; i < parts.length; i += 1) {
      var value = parts[i].trim();
      if (value.indexOf(prefix) === 0) return decodeURIComponent(value.slice(prefix.length));
    }
    return null;
  }

  function makeEventId(prefix) {
    var safePrefix = String(prefix || "event").replace(/[^A-Za-z0-9_.-]/g, "_");
    var suffix = window.crypto && typeof window.crypto.randomUUID === "function"
      ? window.crypto.randomUUID()
      : String(Date.now()) + "_" + Math.random().toString(16).slice(2);
    return safePrefix + "_" + suffix;
  }

  function init(options) {
    options = options || {};
    var pixelId = String(options.pixelId || "").trim();
    if (!pixelId) throw new Error("pixelId is required");

    var q = ensureQueue();
    if (options.consent === false) q("consent", false);
    q("init", { pixelId: pixelId, debug: Boolean(options.debug) });
    if (options.consent === true) q("consent", true);
    initializedPixelId = pixelId;
    return pixelId;
  }

  function setConsent(granted) {
    ensureQueue()("consent", Boolean(granted));
  }

  function measure(eventName, data, options) {
    options = options || {};
    if (!initializedPixelId) throw new Error("LanaOpenAIAds.init(...) must be called first");

    var eventId = String(options.eventId || makeEventId(eventName));
    var sdkOptions = { event_id: eventId };
    if (options.customEventName) sdkOptions.custom_event_name = String(options.customEventName);
    if (options.optOut === true) sdkOptions.opt_out = true;

    ensureQueue()("measure", eventName, data, sdkOptions);
    return eventId;
  }

  function getAttribution() {
    return {
      oppref: readCookie("__oppref"),
      obref: readCookie("__obref"),
      sourceUrl: window.location.href,
      userAgent: window.navigator.userAgent
    };
  }

  window.LanaOpenAIAds = Object.freeze({
    init: init,
    setConsent: setConsent,
    measure: measure,
    getAttribution: getAttribution,
    makeEventId: makeEventId
  });
})();
