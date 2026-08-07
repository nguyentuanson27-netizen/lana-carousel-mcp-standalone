(() => {
  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const state = { selectedByView: new Map(), filter: 'all', search: '', enhancing: false, railCollapsed: false };
  let observer;

  const viewMeta = {
    content: {
      step: 'Bước 1 · Carousel', title: 'Duyệt nội dung',
      description: 'Kiểm tra và hoàn thiện tiêu đề, nội dung trước khi chọn ảnh.',
      action: 'Tiếp tục sang Duyệt ảnh'
    },
    images: {
      step: 'Bước 2 · Carousel', title: 'Duyệt ảnh',
      description: 'Chọn một ảnh chính hoặc nhiều ảnh để tạo bố cục ghép lưới.',
      action: 'Tiếp tục sửa thiết kế'
    },
    edit: {
      step: 'Bước 3 · Carousel', title: 'Sửa thiết kế',
      description: 'Điều chỉnh chữ, bố cục, crop ảnh và Brand Kit cho từng slide.',
      action: 'Tiếp tục Render & tải'
    },
    download: {
      step: 'Bước 4 · Carousel', title: 'Render & tải',
      description: 'Xuất toàn bộ slide đã duyệt thành bộ ảnh sẵn sàng đăng.',
      action: 'Mở Video Builder'
    },
    video: {
      step: 'Bước 5 · Carousel', title: 'Video Builder',
      description: 'Sắp xếp timeline, thêm chuyển động, phụ đề, giọng đọc và nhạc nền.',
      action: 'Lưu cấu hình video'
    }
  };

  function activeView() {
    return q('#workflow .step.active')?.dataset.view || 'content';
  }

  function contentIsApproved() {
    return q('#workflow .step[data-view="content"]')?.classList.contains('done') === true;
  }

  function getCards(view) {
    const panel = q(`#${view}`);
    if (!panel) return [];
    if (view === 'content') {
      const approved = contentIsApproved();
      return qa('[data-content]', panel).map(card => ({
        id: card.dataset.content,
        card,
        title: q('[data-f="headline"]', card)?.value || 'Slide nội dung',
        subtitle: q('[data-f="body"]', card)?.value || 'Chưa có nội dung',
        status: approved ? 'done' : 'pending'
      }));
    }
    if (view === 'images') return qa('.card', panel).filter(card => q('[data-slide]', card)).map(card => {
      const trigger = q('[data-slide]', card);
      const statusDone = q('.status.done', card);
      return {
        id: trigger.dataset.slide,
        card,
        title: q('h2', card)?.textContent || 'Slide ảnh',
        subtitle: `${qa('.candidate', card).length}/10 ảnh ứng viên`,
        status: statusDone ? 'done' : 'pending',
        image: q('.candidate img', card)?.src || ''
      };
    });
    if (view === 'edit') return qa('[data-editor]', panel).map(card => ({
      id: card.dataset.editor,
      card,
      title: q('h2', card)?.textContent || 'Slide thiết kế',
      subtitle: q('.status', card)?.textContent || 'Thiết kế',
      status: card.dataset.designSaved === 'true' ? 'done' : 'pending',
      image: q('.canvas-bg img', card)?.src || ''
    }));
    return [];
  }

  function currentItem(view, items) {
    if (!items.length) return null;
    let id = state.selectedByView.get(view);
    if (!items.some(item => item.id === id)) id = items[0].id;
    state.selectedByView.set(view, id);
    return items.find(item => item.id === id) || items[0];
  }

  function statusLabel(status, view) {
    if (status === 'done') return view === 'images' ? 'Đã duyệt ảnh' : view === 'content' ? 'Đã duyệt nội dung' : view === 'edit' ? 'Đã lưu thiết kế' : 'Hoàn tất';
    if (view === 'content') return 'Cần kiểm tra';
    if (view === 'images') return 'Chờ duyệt ảnh';
    if (view === 'edit') return 'Chưa lưu thiết kế';
    return 'Đang xử lý';
  }

  function filterItems(items) {
  const term = state.search.toLocaleLowerCase('vi');
  return items.filter(item => {
    const matchesSearch = !term || `${item.title} ${item.subtitle}`.toLocaleLowerCase('vi').includes(term);
    const matchesFilter = state.filter === 'all' || (state.filter === 'done' ? item.status === 'done' : item.status !== 'done');
    return matchesSearch && matchesFilter;
  });
}

  function applySlideNavigationState() {
    const button = q('#slideNavCollapse');
    ['#slideSearch', '#slideFilters', '#slideRail'].forEach(selector => {
      const element = q(selector);
      if (element) element.hidden = state.railCollapsed;
    });
    if (button) {
      button.textContent = state.railCollapsed ? '+' : '−';
      button.setAttribute('aria-expanded', String(!state.railCollapsed));
      button.setAttribute('aria-label', state.railCollapsed ? 'Mở danh sách slide' : 'Thu gọn danh sách slide');
      button.title = state.railCollapsed ? 'Mở danh sách slide' : 'Thu gọn danh sách slide';
    }
  }

  function refreshRail(view, items) {
    const rail = q('#slideRail');
    const navigation = q('#slideNavigation');
    if (!rail || !navigation) return null;
    const hasSlides = items.length > 0 && !['download', 'video'].includes(view);
    navigation.hidden = !hasSlides;
    if (!hasSlides) return null;
    applySlideNavigationState();

    const filtered = filterItems(items);
    const current = currentItem(view, filtered);

    q('#slideProgress').textContent = `${items.filter(item => item.status === 'done').length}/${items.length} hoàn tất`;
    rail.innerHTML = filtered.map((item, index) => `
      <button class="slide-rail-button ${item.id === current?.id ? 'active' : ''}" type="button" data-slide-target="${item.id}" role="listitem">
        <span class="slide-thumb">${item.image ? `<img src="${item.image}" alt="">` : `${String(index + 1).padStart(2, '0')}<br>9:16`}</span>
        <span class="slide-copy">
          <strong>Slide ${String(index + 1).padStart(2, '0')} · ${escapeHtml(item.title)}</strong>
          <span>${escapeHtml(item.subtitle)}</span>
          <span class="slide-badge ${item.status}">${statusLabel(item.status, view)}</span>
        </span>
      </button>`).join('') || '<p class="muted" style="padding:10px">Không tìm thấy slide phù hợp.</p>';

    items.forEach(item => item.card.classList.toggle('is-active', Boolean(current) && item.id === current.id));
    q(`#${view}`)?.classList.toggle('focus-mode', true);
    return current;
  }

  function escapeHtml(value = '') {
    return String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]));
  }

  function markProjectActionCards() {
    qa('#content > .card:not([data-content])').forEach(card => card.classList.add('project-action'));
  }

  function enhanceContentCard(item) {
    if (!item?.card || item.card.dataset.stitchEnhanced) return;
    item.card.dataset.stitchEnhanced = 'true';
    const number = q('.number', item.card);
    if (number) {
      const header = document.createElement('div');
      header.className = 'card-head';
      const done = item.status === 'done';
      header.innerHTML = `<div><span class="number">${escapeHtml(number.textContent)}</span><h2>${escapeHtml(item.title)}</h2></div><span class="status${done ? ' done' : ''}">${done ? 'Đã duyệt' : 'Chưa duyệt'}</span>`;
      number.replaceWith(header);
    }
  }

  function configureWorkflowAction(view) {
    const action = q('#nextWorkflowAction');
    if (!action) return;
    const steps = qa('#workflow .step');
    const current = q('#workflow .step.active');
    const index = steps.indexOf(current);
    const next = index >= 0 ? steps[index + 1] : null;
    action.disabled = false;
    action.dataset.mode = 'navigate';
    action.removeAttribute('title');

    if (view === 'video') {
      action.textContent = viewMeta.video.action;
      action.dataset.mode = 'save-video';
      return;
    }
    if (next && !next.disabled) {
      action.textContent = viewMeta[view].action;
      return;
    }
    if (view === 'content') {
      action.textContent = 'Duyệt toàn bộ nội dung';
      action.dataset.mode = 'approve-content';
      action.title = 'Lưu các thay đổi, duyệt nội dung và mở bước Duyệt ảnh';
      return;
    }
    if (view === 'images') {
      action.textContent = 'Duyệt đủ ảnh để tiếp tục';
      action.dataset.mode = 'locked-images';
      action.disabled = true;
      action.title = 'Mỗi slide cần có ảnh đã duyệt trước khi mở bước Sửa thiết kế';
      return;
    }
    action.disabled = true;
    action.textContent = 'Chưa thể tiếp tục';
  }

  function syncBrandKitPlacement(view) {
    const header = q('.workspace-header');
    if (!header) return;
    const headerKit = q('.workspace-header > .brand-kit');
    if (view === 'edit') {
      const liveKit = q('#edit .brand-kit');
      if (liveKit) {
        if (headerKit && headerKit !== liveKit) headerKit.remove();
        liveKit.classList.add('brand-kit-in-header');
        if (liveKit.parentElement !== header) header.insertBefore(liveKit, q('#workspaceStats') || null);
      }
    } else if (headerKit) {
      headerKit.remove();
    }
  }

  function updateHeader(view, items) {
    const meta = viewMeta[view];
    q('#workspaceEyebrow').textContent = meta.step;
    q('#workspaceTitle').textContent = meta.title;
    q('#workspaceDescription').textContent = meta.description;
    configureWorkflowAction(view);
    syncBrandKitPlacement(view);
    const done = items.filter(item => item.status === 'done').length;
    q('#workspaceStats').innerHTML = items.length
      ? `<span>${items.length} slide</span><span>${done} hoàn tất</span><span>${items.length - done} cần xử lý</span>`
      : view === 'video' ? '<span>Remotion</span><span>Timeline đa cảnh</span>' : '<span>Sẵn sàng render</span>';
    const projectName = q('#meta')?.textContent?.split(' · ')[0] || 'Dự án Carousel';
    q('#sidebarProjectName').textContent = projectName;
  }

  function buildInspector(view, item, items) {
    const root = q('#inspectorContent');
    if (!root) return;
    if (view === 'video') {
      root.innerHTML = `
        <section class="inspector-section"><span class="inspector-label">Video Builder</span><h3>Quy trình xuất video</h3><p>Chọn slide, thiết lập chuyển động, phụ đề, TTS và nhạc trước khi render MP4.</p></section>
        <section class="inspector-section"><span class="inspector-label">Gợi ý</span><div class="inspector-list"><div>✓ Dùng 9:16 cho TikTok/Reels</div><div>✓ Căn thời lượng theo TTS</div><div>✓ Kiểm tra âm lượng nhạc nền</div><div>✓ Preview trước khi render</div></div></section>`;
      return;
    }
    if (view === 'download') {
      root.innerHTML = `
        <section class="inspector-section"><span class="inspector-label">Render</span><h3>Bộ ảnh Carousel</h3><p>Hệ thống sẽ render tất cả slide đã có ảnh duyệt và thiết kế đã lưu.</p><div class="inspector-status done">Sẵn sàng kiểm tra</div></section>
        <section class="inspector-section"><span class="inspector-label">Đầu ra</span><div class="inspector-list"><div>✓ Ảnh theo thứ tự slide</div><div>✓ Đóng gói thành ZIP</div><div>✓ Theo dõi tiến trình trực tiếp</div></div></section>`;
      return;
    }
    if (!item) { root.innerHTML = ''; return; }
    const headline = view === 'content' ? q('[data-f="headline"]', item.card)?.value : item.title;
    const body = view === 'content' ? q('[data-f="body"]', item.card)?.value : item.subtitle;
    const image = item.image || q('.candidate img', item.card)?.src || q('.canvas-bg img', item.card)?.src || '';
    root.innerHTML = `
      <section class="inspector-section">
        <span class="inspector-label">Trạng thái slide</span>
        <h3>${escapeHtml(headline || item.title)}</h3>
        <p>${view === 'content' ? 'Kiểm tra nội dung trước khi duyệt toàn bộ dự án.' : view === 'images' ? 'Chọn một ảnh hoặc từ hai ảnh để ghép lưới.' : 'Điều chỉnh và lưu thiết kế của slide hiện tại.'}</p>
        <div class="inspector-status ${item.status === 'done' ? 'done' : ''}">${statusLabel(item.status, view)}</div>
      </section>
      <section class="inspector-section">
        <span class="inspector-label">Tiến độ</span>
        <div class="inspector-list"><div>✓ ${items.length} slide trong dự án</div><div>✓ ${items.filter(x => x.status === 'done').length} slide hoàn tất bước này</div><div>• ${items.filter(x => x.status !== 'done').length} slide còn lại</div></div>
      </section>
      <section class="inspector-section">
        <span class="inspector-label">Xem trước</span>
        <div class="mini-preview">
          ${image ? `<img src="${image}" alt="Ảnh xem trước">` : ''}
          <div class="mini-preview-copy"><strong>${escapeHtml(headline || item.title)}</strong><span>${escapeHtml(body || '')}</span></div>
        </div>
      </section>`;
  }

  function bindLiveContentPreview(item) {
    if (!item || activeView() !== 'content') return;
    qa('input,textarea', item.card).forEach(input => {
      if (input.dataset.previewBound) return;
      input.dataset.previewBound = 'true';
      input.addEventListener('input', () => {
        q('#saveState').classList.add('dirty');
        q('#saveState').innerHTML = '<i></i> Có thay đổi chưa lưu';
        item.title = q('[data-f="headline"]', item.card)?.value || 'Chưa có tiêu đề';
        item.subtitle = q('[data-f="body"]', item.card)?.value || 'Chưa có nội dung';
        buildInspector('content', item, getCards('content'));
      });
    });
  }

  function setSaveState(kind, label) {
    const element = q('#saveState');
    if (!element) return;
    element.classList.remove('dirty', 'error');
    if (kind === 'dirty' || kind === 'error') element.classList.add(kind);
    element.innerHTML = `<i></i> ${label}`;
  }

  function installMutationStatusTracking() {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, options = {}) => {
      const url = typeof input === 'string' ? input : input?.url || '';
      const method = String(options.method || (typeof input !== 'string' ? input?.method : '') || 'GET').toUpperCase();
      const tracked = url.includes('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(method);
      if (!tracked) return originalFetch(input, options);

      setSaveState('processing', 'Đang xử lý…');
      try {
        const response = await originalFetch(input, options);
        if (response.ok) setSaveState('success', 'Đã cập nhật');
        else setSaveState('error', 'Cập nhật thất bại');
        return response;
      } catch (error) {
        setSaveState('error', 'Cập nhật thất bại');
        throw error;
      }
    };
  }

  function enhance() {
    if (state.enhancing || q('#app')?.classList.contains('hidden')) return;
    state.enhancing = true;
    observer?.disconnect();
    try {
      const view = activeView();
      markProjectActionCards();
      const items = getCards(view);
      if (view === 'content') items.forEach(enhanceContentCard);
      const selected = refreshRail(view, items);
      updateHeader(view, items);
      buildInspector(view, selected, items);
      bindLiveContentPreview(selected);
    } finally {
      state.enhancing = false;
      observer?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'disabled', 'data-design-saved'] });
    }
  }

  q('#slideRail')?.addEventListener('click', event => {
    const button = event.target.closest('[data-slide-target]');
    if (!button) return;
    const view = activeView();
    state.selectedByView.set(view, button.dataset.slideTarget);
    enhance();
    if (innerWidth <= 850) closeSidebar();
  });

  // Lăn chuột để chuyển slide (cuộn vô tận) trong bước Duyệt ảnh
  const workspaceShell = q('.workspace-shell');
  let wheelLockAt = 0;
  function stepSlide(view, direction) {
    const items = filterItems(getCards(view));
    if (items.length < 2) return false;
    const currentId = state.selectedByView.get(view);
    let index = items.findIndex(item => item.id === currentId);
    if (index < 0) index = 0;
    const nextIndex = (index + direction + items.length) % items.length;
    state.selectedByView.set(view, items[nextIndex].id);
    enhance();
    if (workspaceShell) workspaceShell.scrollTop = 0;
    return true;
  }
  workspaceShell?.addEventListener('wheel', event => {
    if (activeView() !== 'images' || Math.abs(event.deltaY) < 6) return;
    const direction = event.deltaY > 0 ? 1 : -1;
    const atTop = workspaceShell.scrollTop <= 0;
    const atBottom = workspaceShell.scrollTop + workspaceShell.clientHeight >= workspaceShell.scrollHeight - 1;
    if ((direction > 0 && !atBottom) || (direction < 0 && !atTop)) return; // cho cuộn hết nội dung trước
    const now = Date.now();
    if (now - wheelLockAt < 320) { event.preventDefault(); return; }
    if (stepSlide('images', direction)) { wheelLockAt = now; event.preventDefault(); }
  }, { passive: false });

  q('#slideSearch')?.addEventListener('input', event => { state.search = event.target.value; enhance(); });
  q('#slideFilters')?.addEventListener('click', event => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    state.filter = button.dataset.filter;
    qa('#slideFilters button').forEach(x => x.classList.toggle('active', x === button));
    enhance();
  });
  q('#slideNavCollapse')?.addEventListener('click', () => {
    state.railCollapsed = !state.railCollapsed;
    applySlideNavigationState();
  });

  function openSidebar() { q('#studioSidebar')?.classList.add('open'); q('#mobileBackdrop').hidden = false; }
  function closeSidebar() { q('#studioSidebar')?.classList.remove('open'); q('#mobileBackdrop').hidden = true; }
  q('#mobileSidebarToggle')?.addEventListener('click', openSidebar);
  q('#sidebarClose')?.addEventListener('click', closeSidebar);
  q('#mobileBackdrop')?.addEventListener('click', closeSidebar);

  q('#nextWorkflowAction')?.addEventListener('click', () => {
    const action = q('#nextWorkflowAction');
    if (!action || action.disabled) return;
    if (action.dataset.mode === 'approve-content') {
      q('#approveContent')?.click();
      return;
    }
    if (action.dataset.mode === 'save-video') {
      q('#saveVideo')?.click();
      return;
    }
    const steps = qa('#workflow .step');
    const current = q('#workflow .step.active');
    const index = steps.indexOf(current);
    const target = index >= 0 ? steps[index + 1] : null;
    if (target && !target.disabled) target.click();
  });

  q('#workflow')?.addEventListener('click', () => requestAnimationFrame(enhance));

  installMutationStatusTracking();
  applySlideNavigationState();
  observer = new MutationObserver(() => requestAnimationFrame(enhance));
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'disabled', 'data-design-saved'] });
  window.addEventListener('load', () => setTimeout(enhance, 80));
})();
