(() => {
  const params = new URLSearchParams(location.search);
  const projectId = params.get("projectId");
  const panel = document.getElementById("social");
  const app = document.getElementById("app");
  const workflow = document.getElementById("workflow");
  const topAction = document.getElementById("nextWorkflowAction");
  const slideNavigation = document.getElementById("slideNavigation");
  if (!projectId || !panel || !app || !workflow) return;

  const state = {
    active: false,
    loading: false,
    overview: null,
    error: "",
    notice: "",
    adminRequired: false,
    selectedAccounts: new Set(),
    contentType: "carousel",
    compose: {
      caption: null,
      facebook: "",
      instagram: "",
      tiktok: "",
      expanded: false
    },
    pollTimer: null
  };

  const escapeHtml = (value = "") => String(value).replace(/[&<>"']/gu, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[character]);

  async function socialJson(url, options = {}) {
    const response = await fetch(url, options);
    let value = {};
    try { value = await response.json(); } catch { /* keep empty */ }
    if (!response.ok) {
      const error = new Error(value.message || `Yêu cầu thất bại (${response.status})`);
      error.code = value.code || "";
      error.status = response.status;
      throw error;
    }
    return value;
  }

  function adminReturnTo() {
    return `/widget?projectId=${encodeURIComponent(projectId)}&social=1`;
  }

  function requiresAdminLogin(error) {
    return error?.code === "SOCIAL_ADMIN_REQUIRED" ||
      (error?.status === 401 && error?.code === "UNAUTHORIZED");
  }

  function formatTime(value) {
    if (!value) return "";
    try { return new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)); }
    catch { return String(value); }
  }

  function statusLabel(value) {
    return ({
      QUEUED: "Đang chờ",
      PROCESSING: "Đang đăng",
      UPLOADING: "Đang tải",
      PUBLISHED: "Đã đăng",
      AWAITING_USER: "Đã gửi draft",
      FAILED: "Thất bại",
      PARTIAL: "Một phần"
    })[value] || value || "Chưa rõ";
  }

  function platformLabel(platform) {
    return ({ facebook: "Facebook", instagram: "Instagram", tiktok: "TikTok" })[platform] || platform;
  }

  function syncSelectedAccounts(accounts) {
    const ids = new Set(accounts.map(account => account.id));
    for (const id of [...state.selectedAccounts]) if (!ids.has(id)) state.selectedAccounts.delete(id);
    if (!state.selectedAccounts.size) accounts.forEach(account => state.selectedAccounts.add(account.id));
  }

  function captureComposeState() {
    const caption = panel.querySelector("#socialCaption");
    if (!caption) return;
    state.compose.caption = caption.value;
    state.compose.facebook = panel.querySelector("#socialCaptionFacebook")?.value || "";
    state.compose.instagram = panel.querySelector("#socialCaptionInstagram")?.value || "";
    state.compose.tiktok = panel.querySelector("#socialCaptionTiktok")?.value || "";
    state.compose.expanded = panel.querySelector(".social-caption-grid details")?.open === true;
  }

  function deliveryActions(delivery) {
    const actions = [];
    if (delivery.remoteUrl) actions.push(`<a href="${escapeHtml(delivery.remoteUrl)}" target="_blank" rel="noopener">Xem bài</a>`);
    if (delivery.status === "FAILED") actions.push(`<button type="button" data-social-retry="${delivery.id}">Thử lại</button>`);
    if (delivery.platform === "tiktok" && delivery.remoteId && delivery.status === "AWAITING_USER") {
      actions.push(`<button type="button" data-social-refresh="${delivery.id}">Kiểm tra</button>`);
    }
    return actions.join("");
  }

  function postHtml(post) {
    return `<article class="social-post">
      <div class="social-post-head">
        <strong>${post.contentType === "video" ? "Video" : "Carousel"} · ${statusLabel(post.status)}</strong>
        <span>${formatTime(post.createdAt)}</span>
      </div>
      <div class="social-deliveries">
        ${(post.deliveries || []).map(delivery => `<div class="social-delivery">
          <span class="social-delivery-platform">${platformLabel(delivery.platform)}</span>
          <span class="social-delivery-status"><i class="social-status-dot ${escapeHtml(delivery.status)}"></i><span>${escapeHtml(statusLabel(delivery.status))}${delivery.status === "AWAITING_USER" && delivery.platform === "tiktok" ? " · hoàn tất trong TikTok" : ""}${delivery.error ? ` · ${escapeHtml(delivery.error)}` : ""}</span></span>
          <span class="social-delivery-actions">${deliveryActions(delivery)}</span>
        </div>`).join("") || '<div class="social-empty">Chưa có delivery.</div>'}
      </div>
    </article>`;
  }

  function accountHtml(account) {
    const managedByEnv = account.metadata?.managedByEnv === true;
    return `<label class="social-account">
      <input type="checkbox" data-social-account="${account.id}" ${state.selectedAccounts.has(account.id) ? "checked" : ""}>
      <span class="social-account-copy">
        <strong>${escapeHtml(account.accountName)}</strong>
        <span>${escapeHtml(platformLabel(account.platform))}${managedByEnv ? " · Facebook nội bộ" : ""}</span>
      </span>
      ${managedByEnv
        ? '<span class="tool" aria-label="Credential do server quản lý">Server</span>'
        : `<button type="button" class="tool" data-social-disconnect="${account.id}">Ngắt</button>`}
    </label>`;
  }

  function render() {
    if (!state.active) return;
    captureComposeState();
    if (state.loading && !state.overview) {
      panel.innerHTML = '<div class="social-shell"><div class="social-card social-empty">Đang tải Social Publisher…</div></div>';
      return;
    }
    if (state.adminRequired && !state.overview) {
      panel.innerHTML = `<div class="social-shell">
        <div class="social-alert">Bước đăng mạng xã hội cần phiên quản trị để bảo vệ tài khoản Facebook, Instagram và TikTok.</div>
        <section class="social-card">
          <h3>Đăng nhập quản trị để tiếp tục</h3>
          <p>Bạn vẫn đang mở đúng dự án. Sau khi xác thực, Lana sẽ quay lại trực tiếp Bước 6 và giữ nguyên quyền truy cập dự án hiện tại.</p>
          <div class="social-submit"><button class="action" type="button" data-social-admin-login>Đăng nhập quản trị</button></div>
        </section>
      </div>`;
      return;
    }
    if (state.error && !state.overview) {
      panel.innerHTML = `<div class="social-shell"><div class="social-alert error">${escapeHtml(state.error)}</div><div class="social-card"><button class="action" type="button" data-social-reload>Thử lại</button></div></div>`;
      return;
    }

    const overview = state.overview || { accounts: [], readiness: {}, posts: [], feature: {} };
    const accounts = overview.accounts || [];
    syncSelectedAccounts(accounts);
    const carouselReady = Boolean(overview.readiness?.carousel?.ready);
    const videoReady = Boolean(overview.readiness?.video?.ready);
    if (state.contentType === "carousel" && !carouselReady && videoReady) state.contentType = "video";
    if (state.contentType === "video" && !videoReady && carouselReady) state.contentType = "carousel";
    const selectedReady = state.contentType === "video" ? videoReady : carouselReady;
    const feature = overview.feature || {};
    const composeCaption = state.compose.caption ?? overview.project?.title ?? "";

    panel.innerHTML = `<div class="social-shell">
      ${state.notice ? `<div class="social-alert">${escapeHtml(state.notice)}</div>` : ""}
      ${state.error ? `<div class="social-alert error">${escapeHtml(state.error)}</div>` : ""}
      <section class="social-hero">
        <div>
          <div class="number">BƯỚC 6 · PUBLISH</div>
          <h2>Đăng mạng xã hội</h2>
          <p>Facebook dùng Page credential nội bộ; Instagram kết nối riêng bằng Instagram Login; TikTok được gửi thành draft để hoàn tất trong ứng dụng.</p>
        </div>
        <div class="social-connect-actions">
          <span class="tool" aria-label="Trạng thái Facebook nội bộ">Facebook nội bộ · ${feature.facebookPageReady ? "Đã cấu hình" : "Chưa cấu hình"}</span>
          <button type="button" class="tool" data-social-connect="instagram" ${feature.instagramOAuthReady ? "" : "disabled"}>+ Instagram</button>
          <button type="button" class="tool" data-social-connect="tiktok" ${feature.tiktokOAuthReady ? "" : "disabled"}>+ TikTok</button>
        </div>
      </section>

      ${!feature.encryptionReady ? '<div class="social-alert error">Social Publisher chưa được cấu hình secrets trên server. Xem <code>docs/social-publishing.md</code>.</div>' : ""}
      ${feature.encryptionReady && !feature.facebookPageReady ? '<div class="social-alert">Facebook nội bộ chưa được cấu hình. Thêm <code>FACEBOOK_PAGE_ID</code> và <code>FACEBOOK_PAGE_ACCESS_TOKEN</code> trên server rồi restart.</div>' : ""}

      <div class="social-grid">
        <section class="social-card">
          <h3>Tài khoản đã kết nối</h3>
          <div class="social-account-list">
            ${accounts.map(accountHtml).join("") || '<div class="social-empty">Chưa có tài khoản publish nào.</div>'}
          </div>
          <div class="social-ready" style="margin-top:12px">
            <span><span>Carousel</span><b class="${carouselReady ? "ready" : "not-ready"}">${carouselReady ? "Sẵn sàng" : escapeHtml(overview.readiness?.carousel?.reason || "Chưa sẵn sàng")}</b></span>
            <span><span>Video MP4</span><b class="${videoReady ? "ready" : "not-ready"}">${videoReady ? "READY" : "Chưa render"}</b></span>
          </div>
        </section>

        <section class="social-card social-compose">
          <h3>Tạo lượt đăng</h3>
          <div class="social-choice">
            <label><input type="radio" name="socialContentType" value="carousel" ${state.contentType === "carousel" ? "checked" : ""} ${carouselReady ? "" : "disabled"}> Carousel</label>
            <label><input type="radio" name="socialContentType" value="video" ${state.contentType === "video" ? "checked" : ""} ${videoReady ? "" : "disabled"}> Video</label>
          </div>
          <div class="social-caption-grid">
            <label class="field">Caption chung<textarea id="socialCaption" maxlength="5000" placeholder="Caption dùng chung cho các kênh…">${escapeHtml(composeCaption)}</textarea></label>
            <details ${state.compose.expanded ? "open" : ""}>
              <summary>Chỉnh caption riêng từng nền tảng</summary>
              <div class="social-platform-captions">
                <label class="field">Facebook<textarea id="socialCaptionFacebook" maxlength="5000" placeholder="Để trống = dùng caption chung">${escapeHtml(state.compose.facebook)}</textarea></label>
                <label class="field">Instagram<textarea id="socialCaptionInstagram" maxlength="2200" placeholder="Để trống = dùng caption chung">${escapeHtml(state.compose.instagram)}</textarea></label>
                <label class="field">TikTok<textarea id="socialCaptionTiktok" maxlength="2200" placeholder="Để trống = dùng caption chung">${escapeHtml(state.compose.tiktok)}</textarea></label>
              </div>
            </details>
          </div>
          <div class="social-submit"><button type="button" class="action" data-social-publish ${accounts.length && selectedReady && feature.encryptionReady ? "" : "disabled"}>Duyệt & đăng ngay</button></div>
        </section>
      </div>

      <section class="social-card">
        <h3>Lịch sử đăng</h3>
        <div class="social-history">${(overview.posts || []).map(postHtml).join("") || '<div class="social-empty">Chưa có lượt đăng nào.</div>'}</div>
      </section>
    </div>`;
  }

  function shouldPoll() {
    return Boolean(state.overview?.posts?.some(post => post.deliveries?.some(delivery => ["QUEUED", "PROCESSING", "UPLOADING"].includes(delivery.status))));
  }

  function schedulePoll() {
    clearTimeout(state.pollTimer);
    if (!state.active || !shouldPoll()) return;
    state.pollTimer = setTimeout(() => loadOverview({ quiet: true }), 2500);
  }

  async function loadOverview({ quiet = false } = {}) {
    if (!quiet) state.loading = true;
    try {
      const overview = await socialJson(`/api/projects/${encodeURIComponent(projectId)}/social/overview`);
      state.overview = overview;
      state.adminRequired = false;
      state.error = "";
      if (!quiet) state.notice = "";
    } catch (error) {
      state.adminRequired = requiresAdminLogin(error);
      state.error = state.adminRequired ? "" : error.message;
      if (state.adminRequired) state.overview = null;
    } finally {
      state.loading = false;
      render();
      schedulePoll();
    }
  }

  function activate() {
    if (state.active) return;
    state.active = true;
    app.dataset.socialActive = "true";
    workflow.querySelector(".social-step")?.setAttribute("aria-current", "step");
    document.querySelectorAll(".workspace-shell > .panel:not(#social)").forEach(item => { item.style.display = "none"; });
    panel.style.display = "block";
    if (slideNavigation) slideNavigation.hidden = true;
    if (topAction) {
      topAction.disabled = false;
      topAction.dataset.socialMode = "refresh";
      topAction.textContent = "Làm mới trạng thái";
    }
    loadOverview();
  }

  function deactivate() {
    if (!state.active) return;
    state.active = false;
    delete app.dataset.socialActive;
    workflow.querySelector(".social-step")?.removeAttribute("aria-current");
    document.querySelectorAll(".workspace-shell > .panel:not(#social)").forEach(item => { item.style.removeProperty("display"); });
    panel.style.removeProperty("display");
    if (slideNavigation) slideNavigation.hidden = false;
    if (topAction) delete topAction.dataset.socialMode;
    clearTimeout(state.pollTimer);
  }

  window.addEventListener("click", event => {
    const socialStep = event.target.closest?.("#workflow .social-step");
    if (socialStep) {
      event.preventDefault();
      event.stopImmediatePropagation();
      activate();
      return;
    }
    if (state.active && event.target.closest?.("#workflow .step")) deactivate();
    if (state.active && event.target.closest?.("#nextWorkflowAction")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      loadOverview();
    }
  }, true);

  panel.addEventListener("change", event => {
    const account = event.target.closest("[data-social-account]");
    if (account) {
      account.checked ? state.selectedAccounts.add(account.dataset.socialAccount) : state.selectedAccounts.delete(account.dataset.socialAccount);
      return;
    }
    const contentType = event.target.closest('input[name="socialContentType"]');
    if (contentType) state.contentType = contentType.value;
  });

  panel.addEventListener("click", async event => {
    try {
      const adminLogin = event.target.closest("[data-social-admin-login]");
      if (adminLogin) {
        location.assign(`/admin-auth.html?returnTo=${encodeURIComponent(adminReturnTo())}`);
        return;
      }

      const reload = event.target.closest("[data-social-reload]");
      if (reload) {
        await loadOverview();
        return;
      }

      const connect = event.target.closest("[data-social-connect]");
      if (connect) {
        connect.disabled = true;
        const result = await socialJson(`/api/projects/${encodeURIComponent(projectId)}/social/oauth/${connect.dataset.socialConnect}/start`);
        location.assign(result.url);
        return;
      }

      const disconnect = event.target.closest("[data-social-disconnect]");
      if (disconnect) {
        disconnect.disabled = true;
        await socialJson(`/api/projects/${encodeURIComponent(projectId)}/social/accounts/${encodeURIComponent(disconnect.dataset.socialDisconnect)}`, { method: "DELETE" });
        state.notice = "Đã ngắt tài khoản.";
        await loadOverview({ quiet: true });
        return;
      }

      const retry = event.target.closest("[data-social-retry]");
      if (retry) {
        retry.disabled = true;
        await socialJson(`/api/projects/${encodeURIComponent(projectId)}/social/deliveries/${encodeURIComponent(retry.dataset.socialRetry)}/retry`, { method: "POST" });
        state.notice = "Đã đưa delivery trở lại hàng chờ.";
        await loadOverview({ quiet: true });
        return;
      }

      const refresh = event.target.closest("[data-social-refresh]");
      if (refresh) {
        refresh.disabled = true;
        await socialJson(`/api/projects/${encodeURIComponent(projectId)}/social/deliveries/${encodeURIComponent(refresh.dataset.socialRefresh)}/refresh`, { method: "POST" });
        await loadOverview({ quiet: true });
        return;
      }

      const publish = event.target.closest("[data-social-publish]");
      if (publish) {
        captureComposeState();
        if (!state.selectedAccounts.size) throw new Error("Hãy chọn ít nhất một tài khoản.");
        publish.disabled = true;
        await socialJson(`/api/projects/${encodeURIComponent(projectId)}/social/posts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contentType: state.contentType,
            caption: state.compose.caption || "",
            captions: {
              facebook: state.compose.facebook,
              instagram: state.compose.instagram,
              tiktok: state.compose.tiktok
            },
            accountIds: [...state.selectedAccounts]
          })
        });
        state.notice = "Đã tạo lượt đăng. Lana đang xử lý từng nền tảng độc lập.";
        state.error = "";
        await loadOverview({ quiet: true });
      }
    } catch (error) {
      if (requiresAdminLogin(error)) {
        state.adminRequired = true;
        state.overview = null;
        state.error = "";
      } else {
        state.error = error.message || "Không thể hoàn tất thao tác Social Publisher.";
      }
      render();
    }
  });

  const socialConnected = params.get("socialConnected");
  const socialError = params.get("socialError");
  if (socialConnected) {
    state.notice = socialConnected === "instagram"
      ? "Đã kết nối Instagram."
      : socialConnected === "tiktok" ? "Đã kết nối TikTok." : "Đã kết nối tài khoản.";
  }
  if (socialError) state.error = socialError;
  if (params.get("social") === "1" || socialConnected || socialError) activate();
})();
