import { safeReturnTo } from "/safe-return.js";

const params = new URLSearchParams(location.search);
const resourceType = params.get("resourceType") || "";
const resourceId = params.get("resourceId") || "";
const allowedPaths = resourceType === "carousel" ? ["/widget"] : resourceType === "video-analysis" ? ["/video-studio"] : [];
const returnTo = safeReturnTo(params.get("returnTo"), location.origin, allowedPaths, "/");
const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
const accessToken = fragment.get("access_token") || "";
const status = document.getElementById("status");

history.replaceState(null, "", `${location.pathname}${location.search}`);

(async () => {
  try {
    if (!accessToken || !resourceType || !resourceId) throw new Error("Link mở dự án không đầy đủ.");
    const response = await fetch("/auth/resource-session", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "X-Resource-Access-Token": accessToken,
        "X-Resource-Type": resourceType,
        "X-Resource-Id": resourceId
      }
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || "Không thể xác thực link dự án.");
    }
    location.replace(returnTo);
  } catch (error) {
    status.className = "error";
    status.textContent = error.message;
  }
})();
