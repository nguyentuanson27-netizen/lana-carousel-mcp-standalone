(() => {
  const projectId = new URLSearchParams(location.search).get("projectId") || "";
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
  const accessToken = fragment.get("access_token") || "";
  const status = document.getElementById("status");

  history.replaceState(null, "", `${location.pathname}${location.search}`);

  async function openProject() {
    if (!projectId || !accessToken) throw new Error("Link mở dự án không hợp lệ hoặc đã bị mất token.");
    const response = await fetch("/auth/project-session", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "X-Project-Access-Token": accessToken,
        "X-Project-Id": projectId
      }
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || "Không thể xác thực link mở dự án.");
    }
    location.replace(`/widget?projectId=${encodeURIComponent(projectId)}`);
  }

  openProject().catch(error => {
    status.textContent = error.message;
    status.classList.add("error");
  });
})();
