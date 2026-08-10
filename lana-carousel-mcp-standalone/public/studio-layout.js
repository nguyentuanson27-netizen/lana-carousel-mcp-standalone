(() => {
  const app = document.getElementById('app');
  const sidebar = document.getElementById('studioSidebar');
  const brand = sidebar?.querySelector('.sidebar-brand');
  const workflow = document.getElementById('workflow');
  if (!app || !sidebar || !brand || !workflow) return;

  const storageKey = 'lana-content-studio-sidebar-collapsed';
  const brandKitStorageKey = 'lana-content-studio-brand-kit-collapsed';
  const desktopQuery = window.matchMedia('(min-width: 851px)');
  let preferredCollapsed = localStorage.getItem(storageKey) === '1';
  let brandKitCollapsed = localStorage.getItem(brandKitStorageKey) !== '0';

  const toggle = document.createElement('button');
  toggle.id = 'desktopSidebarToggle';
  toggle.className = 'icon-button sidebar-desktop-toggle';
  toggle.type = 'button';
  brand.insertBefore(toggle, document.getElementById('sidebarClose') || null);

  function syncToggle() {
    const collapsed = desktopQuery.matches && preferredCollapsed;
    app.classList.toggle('sidebar-collapsed', collapsed);
    toggle.textContent = collapsed ? '›' : '‹';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Mở rộng thanh bên' : 'Thu gọn thanh bên');
    toggle.title = collapsed ? 'Mở rộng thanh bên' : 'Thu gọn thanh bên';
  }

  toggle.addEventListener('click', () => {
    preferredCollapsed = !preferredCollapsed;
    localStorage.setItem(storageKey, preferredCollapsed ? '1' : '0');
    syncToggle();
  });

  function syncBrandKitSummary(kit) {
    const font = kit.querySelector('#brandFont')?.value || 'Font thương hiệu';
    const color = kit.querySelector('#brandColor')?.value || '#FFFFFF';
    const summary = kit.querySelector('.brand-kit-summary-text');
    const swatch = kit.querySelector('.brand-kit-swatch');
    if (summary && summary.textContent !== font) summary.textContent = font;
    if (swatch && swatch.style.backgroundColor !== color) swatch.style.backgroundColor = color;
  }

  function enhanceBrandKit() {
    const kit = document.querySelector('.workspace-header > .brand-kit, #edit > .brand-kit');
    if (!kit) return;

    if (kit.dataset.layoutEnhanced !== 'true') {
      kit.dataset.layoutEnhanced = 'true';
      const kitToggle = document.createElement('button');
      kitToggle.type = 'button';
      kitToggle.className = 'brand-kit-toggle';
      kitToggle.innerHTML = '<span class="brand-kit-label">Brand Kit</span><span class="brand-kit-summary"><span class="brand-kit-summary-text"></span><span class="brand-kit-swatch" aria-hidden="true"></span></span><span class="brand-kit-chevron" aria-hidden="true">⌄</span>';
      kit.insertBefore(kitToggle, kit.firstChild);
      kitToggle.addEventListener('click', () => {
        brandKitCollapsed = !brandKitCollapsed;
        localStorage.setItem(brandKitStorageKey, brandKitCollapsed ? '1' : '0');
        syncBrandKitState(kit);
      });
      kit.addEventListener('change', () => syncBrandKitSummary(kit));
    }

    syncBrandKitState(kit);
    syncBrandKitSummary(kit);
  }

  function syncBrandKitState(kit) {
    const kitToggle = kit.querySelector('.brand-kit-toggle');
    kit.classList.toggle('is-collapsed', brandKitCollapsed);
    if (!kitToggle) return;
    kitToggle.setAttribute('aria-expanded', String(!brandKitCollapsed));
    kitToggle.setAttribute('aria-label', brandKitCollapsed ? 'Mở Brand Kit' : 'Thu gọn Brand Kit');
    kitToggle.title = brandKitCollapsed ? 'Mở Brand Kit' : 'Thu gọn Brand Kit';
  }

  function promoteProofActions() {
    document.querySelectorAll('#edit [data-editor]').forEach(editor => {
      const toolbar = editor.querySelector('.direct-toolbar');
      const proofBar = editor.querySelector('.proof-bar');
      const button = editor.querySelector('.show-proof');
      const status = editor.querySelector('.proof-status');
      if (!toolbar || !button) return;

      let group = toolbar.querySelector('.direct-proof');
      if (!group) {
        group = document.createElement('div');
        group.className = 'direct-proof';
        toolbar.appendChild(group);
      }
      if (button.parentElement !== group) group.appendChild(button);
      if (status && status.parentElement !== group) group.appendChild(status);
      if (proofBar && proofBar.childElementCount === 0) proofBar.remove();
    });
  }

  function enhanceEditChrome() {
    enhanceBrandKit();
    promoteProofActions();
  }

  function syncActiveView() {
    const view = workflow.querySelector('.step.active')?.dataset.view || 'content';
    [...app.classList]
      .filter(name => name.startsWith('studio-view-'))
      .forEach(name => app.classList.remove(name));
    app.classList.add(`studio-view-${view}`);
    if (view === 'edit') queueMicrotask(enhanceEditChrome);
  }

  const workflowObserver = new MutationObserver(syncActiveView);
  workflowObserver.observe(workflow, {
    subtree: true,
    attributes: true,
    attributeFilter: ['class']
  });

  const editObserver = new MutationObserver(() => {
    if (app.classList.contains('studio-view-edit')) queueMicrotask(enhanceEditChrome);
  });
  editObserver.observe(app, { subtree: true, childList: true });

  desktopQuery.addEventListener?.('change', syncToggle);
  syncToggle();
  syncActiveView();
  enhanceEditChrome();
})();
