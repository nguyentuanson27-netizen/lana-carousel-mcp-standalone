import { safeReturnTo } from "/safe-return.js";

const params = new URLSearchParams(location.search);
const returnTo = safeReturnTo(
  params.get("returnTo"),
  location.origin,
  ["/", "/projects", "/widget"],
  "/projects"
);
const loginButton = document.getElementById("googleLoginButton");
const errorBox = document.getElementById("error");

const authError = params.get("authError");
if (authError) errorBox.textContent = authError;

fetch("/auth/admin-session", { credentials: "same-origin" })
  .then(response => { if (response.ok) location.replace(returnTo); })
  .catch(() => {});

loginButton.addEventListener("click", () => {
  loginButton.disabled = true;
  loginButton.textContent = "Đang chuyển sang Google…";
  location.assign(`/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`);
});
