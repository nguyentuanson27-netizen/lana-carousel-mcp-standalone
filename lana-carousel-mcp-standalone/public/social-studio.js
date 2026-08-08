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
    if (!response.ok) throw new Error(value.message || `Yêu cầu thất bại (${response.status})`);
    return value;
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
      PARTIAL: "Một phần",
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

  function render() {
    if (!state.active) return;
    captureComposeState();
    if (state.loading && !state.overview) {
      panel.innerHTML = '<div class="social-shell"><div class="social-card social-empty">Đang tải Social Publisher…</div></div>';
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
          <p>Đăng độc lập từng kênh. Facebook/Instagram publish trực tiếp; TikTok được gửi thành draft để hoàn tất trong ứng dụng TikTok.</p>
        </div>
        <div class="social-connect-actions">
          <button type="button" class="tool" data-social-connect="meta" ${feature.metaOAuthReady ? "" : "disabled"}>+ Facebook / Instagram</button>
          <button type="button" class="tool" data-social-connect="tiktok" ${feature.tiktokOAuthReady ? "" : "disabled"}>+ TikTok</button>
        </div>
      </section>

      ${!feature.encryptionReady ? '<div class="social-alert error">Social Publisher chưa được cấu hình secrets trên server. Xem <code>docs/social-publishing.md</code>.</div>' : ""}

      <div class="social-grid">
        <section class="social-card">
          <h3>Tài khoản đã kết nối</h3>
          <div class="social-account-list">
            ${accounts.map(account => `<label class="social-account">
              <input type="checkbox" data-social-account="${account.id}" ${state.selectedAccounts.has(account.id) ? "checked" : ""}>
              <span class="social-account-copy"><strong>${escapeHtml(account.accountName)}</strong><span>${escapeHtml(platformLabel(account.platform))}</span></span>
              <button type="button" class="tool" data-social-disconnect="${account.id}">Ngắt</button>
            </label>`).join("") || '<div class="social-empty">Chưa kết nối tài khoản nào.</div>'}
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
      state.error = "";
      if (!quiet) state.notice = "";
    } catch (error) {
      state.error = error.message;
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
    workflow.querySelector('.social-step')?.setAttribute("aria-current", "step");
    document.querySelectorAll('.workspace-shell > .panel:not(#social)').forEach(item => { item.style.display = "none"; });
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
    workflow.querySelector('.social-step')?.removeAttribute("aria-current");
    document.querySelectorAll('.workspace-shell > .panel:not(#social)').forEach(item => { item.style.removeProperty("display"); });
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
      const reload = event.target.closest("[data-social-reload]");
      if (reload) return loadOverview();

      const connect = event.target.closest("[data-social-connect]");
      if (connect) {
        connect.disabled = true;
        const result = await socialJson(`/api/projects/${encodeURIComponent(projectId)}/social/oauth/${connect.dataset.socialConnect}/start`);
        location.assign(result.url);
        return;
      }

      const disconnect = event.target.closest("[data-social-disconnect]");
      if (disconnect) {
        event.preventDefault();
        if (!confirm("Ngắt kết nối tài khoản mạng xã hội này? Các bài đã đăng và lịch sử vẫn được giữ.")) return;
        await socialJson(`/api/projects/${encodeURIComponent(projectId)}/social/accounts/${disconnect.dataset.socialDisconnect}`, { method: "DELETE" });
        state.selectedAccounts.delete(disconnect.dataset.socialDisconnect);
        state.notice = "Đã ngắt kết nối tài khoản.";
        await loadOverview({ quiet: true });
        return;
      }

      const retry = event.target.closest("[data-social-retry]");
      if (retry) {
        retry.disabled = true;
        await socialJson(`/api/projects/${encodeURIComponent(projectId)}/social/deliveries/${retry.dataset.socialRetry}/retry`, { method: "POST" });
        state.notice = "Đã đưa delivery vào hàng đợi retry.";
        await loadOverview({ quiet: true });
        return;
      }

      const refresh = event.target.closest("[data-social-refresh]");
      if (refresh) {
        refresh.disabled = true;
        await socialJson(`/api/projects/${encodeURIComponent(projectId)}/social/deliveries/${refresh.dataset.socialRefresh}/refresh`, { method: "POST" });
        await loadOverview({ quiet: true });
        return;
      }

      const publish = event.target.closest("[data-social-publish]");
      if (publish) {
        const accountIds = [...panel.querySelectorAll("[data-social-account]:checked")].map(input => input.dataset.socialAccount);
        if (!accountIds.length) throw new Error("Hãy chọn ít nhất một tài khoản mạng xã hội.");
        publish.disabled = true;
        publish.textContent = "Đang đóng băng media…";
        const caption = panel.querySelector("#socialCaption")?.value.trim() || "";
        const captions = {
          facebook: panel.querySelector("#socialCaptionFacebook")?.value.trim() || "",
          instagram: panel.querySelector("#socialCaptionInstagram")?.value.trim() || "",
          tiktok: panel.querySelector("#socialCaptionTiktok")?.value.trim() || ""
        };
        await socialJson(`/api/projects/${encodeURIComponent(projectId)}/social/posts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contentType: state.contentType, caption, captions, accountIds })
        });
        state.notice = "Đã tạo lượt đăng với media snapshot cố định. Mỗi nền tảng sẽ được xử lý độc lập.";
        await loadOverview({ quiet: true });
      }
    } catch (error) {
      state.error = error.message;
      render();
    }
  });

  const callbackError = params.get("socialError");
  const callbackConnected = params.get("socialConnected");
  if (callbackError) state.error = callbackError;
  if (callbackConnected) state.notice = `Đã kết nối ${callbackConnected === "meta" ? "Facebook / Instagram" : "TikTok"}.`;

  if (params.get("social") === "1") {
    const waitForApp = () => {
      if (!app.classList.contains("hidden")) activate();
      else setTimeout(waitForApp, 80);
    };
    waitForApp();
  }
})();
