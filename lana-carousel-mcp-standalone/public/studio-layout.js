(() => {
  const app = document.getElementById('app');
  const sidebar = document.getElementById('studioSidebar');
  const brand = sidebar?.querySelector('.sidebar-brand');
  const workflow = document.getElementById('workflow');
  if (!app || !sidebar || !brand || !workflow) return;

  const storageKey = 'lana-content-studio-sidebar-collapsed';
  const desktopQuery = window.matchMedia('(min-width: 851px)');
  let preferredCollapsed = localStorage.getItem(storageKey) === '1';

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

  function syncActiveView() {
    const view = workflow.querySelector('.step.active')?.dataset.view || 'content';
    [...app.classList]
      .filter(name => name.startsWith('studio-view-'))
      .forEach(name => app.classList.remove(name));
    app.classList.add(`studio-view-${view}`);
  }

  const workflowObserver = new MutationObserver(syncActiveView);
  workflowObserver.observe(workflow, {
    subtree: true,
    attributes: true,
    attributeFilter: ['class']
  });

  desktopQuery.addEventListener?.('change', syncToggle);
  syncToggle();
  syncActiveView();
})();
