import { safeReturnTo } from "/safe-return.js";

const params = new URLSearchParams(location.search);
const returnTo = safeReturnTo(
  params.get("returnTo"),
  location.origin,
  ["/", "/projects"],
  "/projects"
);
const form = document.getElementById("loginForm");
const keyInput = document.getElementById("apiKey");
const submitButton = document.getElementById("submitButton");
const errorBox = document.getElementById("error");

fetch("/auth/admin-session", { credentials: "same-origin" })
  .then(response => { if (response.ok) location.replace(returnTo); })
  .catch(() => {});

form.addEventListener("submit", async event => {
  event.preventDefault();
  errorBox.textContent = "";
  submitButton.disabled = true;
  submitButton.textContent = "Đang đăng nhập…";
  try {
    const response = await fetch("/auth/admin-session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "X-API-Key": keyInput.value }
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || "Không thể đăng nhập.");
    }
    keyInput.value = "";
    location.replace(returnTo);
  } catch (error) {
    errorBox.textContent = error.message;
    submitButton.disabled = false;
    submitButton.textContent = "Đăng nhập";
    keyInput.focus();
    keyInput.select();
  }
});
