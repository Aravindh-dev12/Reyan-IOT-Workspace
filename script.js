const STORAGE_KEY = 'scada_dashboards_v1';
const VIEWS_STORAGE_KEY = 'scada_views_v1';
const PANEL_ID_STORAGE_KEY = 'scada_panel_ids_v1';
const MAX_VERSIONS = 20;

let currentDashId = null;
let isEditMode = false;
let editBackup = null;
const widgetRegistry = new Map();
let hasUnsavedChanges = false;
let currentViewId = null;
let views = [];
let selectedViewForWidgetSelection = null;

const grid = GridStack.init({
  column: 12,
  cellHeight: 100,
  margin: 2,
  float: true,
  resizable: { handles: 'se', autoHide: true }
});

function getPanelId(dashboardId) {
  try {
    const panelIds = JSON.parse(localStorage.getItem(PANEL_ID_STORAGE_KEY) || '{}');
    if (!panelIds[dashboardId]) {
      panelIds[dashboardId] = 'panel_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
      localStorage.setItem(PANEL_ID_STORAGE_KEY, JSON.stringify(panelIds));
    }
    return panelIds[dashboardId];
  } catch(e) {
    return 'panel_' + dashboardId;
  }
}

function readDashboards() {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return [];
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch(e) {
    return [];
  }
}

function writeDashboards(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch(e) {}
}

function readViews() {
  try {
    const data = localStorage.getItem(VIEWS_STORAGE_KEY);
    if (!data) return {};
    return JSON.parse(data) || {};
  } catch(e) {
    return {};
  }
}

function writeViews(viewsData) {
  try {
    localStorage.setItem(VIEWS_STORAGE_KEY, JSON.stringify(viewsData));
  } catch(e) {}
}

function getDashboardViews(dashboardId) {
  const viewsData = readViews();
  return viewsData[dashboardId] || [];
}

function saveDashboardViews(dashboardId, dashboardViews) {
  const viewsData = readViews();
  viewsData[dashboardId] = dashboardViews;
  writeViews(viewsData);
}

function markUnsaved() {
  hasUnsavedChanges = true;
  document.getElementById('btn-save').classList.remove('hidden');
}

function performSave(isAutosave = false) {
  if (!currentDashId) return;

  const contents = Array.from(document.querySelectorAll('.grid-stack-item-content'));
  const saveData = [];

  contents.forEach(content => {
    const id = content.getAttribute('gs-id') || content.dataset.gsId || content.id;
    const cfg = widgetRegistry.get(id);
    const parent = content.closest('.grid-stack-item');
    let node = null;
    if (parent) {
      node = grid.engine.nodes.find(n => n.el === parent);
    }
    if (cfg) {
      const size = getDefaultSize(cfg.type, cfg);
      saveData.push({
        id: cfg.id,
        type: cfg.type,
        title: cfg.title || cfg.type,
        icon: cfg.icon || '',
        color: cfg.color || '#4f46e5',
        xData: cfg.xData || [],
        yData: cfg.yData || [],
        min: cfg.min,
        max: cfg.max,
        groupCount: cfg.groupCount,
        groupItems: cfg.groupItems || [],
        tableColumns: cfg.tableColumns,
        tableRows: cfg.tableRows,
        tableHeaderColors: cfg.tableHeaderColors || {},
        viewIds: cfg.viewIds || [],  
        x: node ? node.x : 0,
        y: node ? node.y : 0,
        w: node ? node.w : size.w,
        h: node ? node.h : size.h
      });
    }
  });

  const list = readDashboards();
  const idx = list.findIndex(d => d.id === currentDashId);

  if (idx === -1) return;

  const snapshot = {
    data: saveData,
    timestamp: new Date().toISOString()
  };

  list[idx].data = JSON.stringify(saveData);
  list[idx].updated_at = new Date().toISOString();

  list[idx].versions = list[idx].versions || [];
  const last = list[idx].versions[list[idx].versions.length - 1];
  const lastHash = last ? hashJson(last.data) : null;
  const currHash = hashJson(saveData);
  if (currHash !== lastHash) {
    list[idx].versions.push(snapshot);
    if (list[idx].versions.length > MAX_VERSIONS) {
      list[idx].versions = list[idx].versions.slice(-MAX_VERSIONS);
    }
  }

  writeDashboards(list);
  refreshList();
  hasUnsavedChanges = false;
  document.getElementById('btn-save').classList.add('hidden');
  showSavedToast('Saved');
}

function hashJson(obj) {
  try {
    return JSON.stringify(obj);
  } catch(e) {
    return '';
  }
}

function refreshList() {
  const container = document.getElementById('dashboard-cards');
  container.innerHTML = '';
  const list = readDashboards();

  if (list.length === 0) {
    container.innerHTML = '<div style="grid-column:1/-1;padding:24px;color:var(--muted);text-align:center;">No dashboards. Click "Create New".</div>';
    return;
  }

  list.forEach(d => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div>
        <div style="font-weight:700">${escapeHtml(d.name)}</div>
        <div class="meta">Updated: ${d.updated_at ? new Date(d.updated_at).toLocaleString() : '-'}</div>
        <div class="meta">Panel ID: ${getPanelId(d.id)}</div>
      </div>
      <div class="actions">
        <button class="btn btn-primary" onclick="openWorkspace('${d.id}')">Open</button>
        <button class="btn" onclick="exportDashboardFromList('${d.id}')">Export</button>
        <button class="btn btn-ghost" onclick="startEditFromList(event,'${d.id}')">Edit Layout</button>
        <button class="btn" onclick="deleteDashboard(event,'${d.id}')">Delete</button>
      </div>
    `;
    container.appendChild(card);
  });
}

function createNewDashboard() {
  const name = prompt('Dashboard name', 'New Dashboard');
  if (!name) return;
  const id = 'dash_' + Date.now();
  const list = readDashboards();
  list.unshift({
    id,
    name,
    data: JSON.stringify([]),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    versions: []
  });
  writeDashboards(list);
  refreshList();
  openWorkspace(id);
}

function importDashboard() {
  document.getElementById('import-file-input').click();
}

function handleFileImport(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const importData = JSON.parse(e.target.result);
      
      if (!importData.dashboard || !importData.widgets) {
        throw new Error('Invalid SCADAPro export format');
      }

      const dashboardName = importData.dashboard.name || `Imported Dashboard ${new Date().toLocaleDateString()}`;
      const id = 'dash_' + Date.now();
      
      const widgets = importData.widgets.map(w => ({
        id: w.id || `w_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: w.type,
        title: w.title || w.type,
        icon: w.icon || '',
        color: w.color || '#4f46e5',
        xData: w.data?.xData || [],
        yData: w.data?.yData || [],
        min: w.data?.min,
        max: w.data?.max,
        groupCount: w.data?.groupCount,
        groupItems: w.data?.groupItems || [],
        tableColumns: w.data?.tableColumns,
        tableRows: w.data?.tableRows,
        tableHeaderColors: w.data?.tableHeaderColors || {},
        viewIds: w.data?.viewIds || [],
        x: w.position?.x || 0,
        y: w.position?.y || 0,
        w: w.position?.w || getDefaultSize(w.type, {}).w,
        h: w.position?.h || getDefaultSize(w.type, {}).h
      }));

      const list = readDashboards();
      list.unshift({
        id,
        name: dashboardName,
        data: JSON.stringify(widgets),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        versions: [],
        imported_from: importData.exportInfo?.exportedAt || new Date().toISOString()
      });

      writeDashboards(list);
      refreshList();
      event.target.value = '';
      showSavedToast(`Dashboard "${dashboardName}" imported successfully`);
      setTimeout(() => openWorkspace(id), 500);
    } catch (error) {
      alert('Error importing dashboard: ' + error.message);
      event.target.value = '';
    }
  };
  reader.readAsText(file);
}

function deleteDashboard(e, id) {
  e.stopPropagation();
  if (!confirm('Delete dashboard?')) return;
  let list = readDashboards();
  list = list.filter(d => d.id !== id);
  writeDashboards(list);
  refreshList();
  if (currentDashId === id) closeWorkspace();
}

function exportDashboardFromList(dashboardId) {
  const list = readDashboards();
  const dash = list.find(d => d.id === dashboardId);
  if (!dash) return alert('Dashboard not found');

  try {
    const widgetData = JSON.parse(dash.data || '[]');
    const exportData = {
      dashboard: {
        id: dash.id,
        name: dash.name,
        created_at: dash.created_at,
        updated_at: dash.updated_at,
        version: '1.0',
        description: `${dash.name} - SCADAPro Dashboard Export`,
        widgetCount: widgetData.length,
        gridConfig: {
          columns: 12,
          cellHeight: 100,
          margin: 4
        }
      },
      widgets: widgetData.map(widget => ({
        id: widget.id,
        type: widget.type,
        title: widget.title,
        icon: widget.icon || '',
        color: widget.color || '#4f46e5',
        position: {
          x: widget.x || 0,
          y: widget.y || 0,
          w: widget.w || getDefaultSize(widget.type, widget).w,
          h: widget.h || getDefaultSize(widget.type, widget).h
        },
        data: {
          xData: widget.xData || [],
          yData: widget.yData || [],
          min: widget.min,
          max: widget.max,
          groupCount: widget.groupCount,
          groupItems: widget.groupItems || [],
          tableColumns: widget.tableColumns,
          tableRows: widget.tableRows,
          tableHeaderColors: widget.tableHeaderColors || {},
          viewIds: widget.viewIds || []
        }
      })),
      exportInfo: {
        exportedAt: new Date().toISOString(),
        exportedBy: 'SCADAPro',
        formatVersion: '1.0',
        software: 'SCADAPro GridStack + ECharts'
      }
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${dash.name.replace(/\s+/g, '_')}_dashboard_export.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showSavedToast('Dashboard exported successfully');
  } catch (error) {
    alert('Error exporting dashboard: ' + error.message);
  }
}

function openWorkspace(id) {
  currentDashId = id;
  document.getElementById('screen-list').classList.add('hidden');
  document.getElementById('screen-workspace').classList.remove('hidden');
  
  const panelId = getPanelId(id);
  document.getElementById('workspace-panel-id').textContent = `Panel ID: ${panelId}`;
  
  // Clean up existing widgets
  widgetRegistry.forEach((cfg, id) => {
    if (cfg._timer) clearInterval(cfg._timer);
    if (cfg._ro) try { cfg._ro.disconnect(); } catch(e) {}
    if (cfg.instance) try { cfg.instance.dispose(); } catch(e) {}
  });
  widgetRegistry.clear();
  grid.removeAll();
  
  // Reset mode
  isEditMode = false;
  document.getElementById('palette').classList.add('hidden');
  document.getElementById('sidebar-nav').classList.remove('hidden');
  document.getElementById('btn-edit').classList.remove('hidden');
  document.getElementById('btn-save').classList.add('hidden');
  document.getElementById('btn-cancel').classList.add('hidden');
  document.getElementById('btn-export').classList.remove('hidden');
  document.getElementById('btn-history').classList.remove('hidden');
  grid.enableMove(false);
  grid.enableResize(false);
  
  const list = readDashboards();
  const dash = list.find(d => d.id === id);
  
  if (!dash) {
    alert('Missing dashboard');
    closeWorkspace();
    return;
  }
  
  document.getElementById('workspace-title').innerText = dash.name;
  let widgets = [];
  
  try {
    widgets = JSON.parse(dash.data || '[]');
  } catch(e) {
    widgets = [];
  }
  
  // Load widgets
  widgets.forEach(w => {
    if (!w || !w.type) return;
    const el = makeWidgetElement(w);
    const size = getDefaultSize(w.type, w);
    const x = (typeof w.x === 'number' && !isNaN(w.x)) ? w.x : 0;
    const y = (typeof w.y === 'number' && !isNaN(w.y)) ? w.y : 0;
    const width = (typeof w.w === 'number' && w.w > 0) ? w.w : size.w;
    const height = (typeof w.h === 'number' && w.h > 0) ? w.h : size.h;
    try {
      grid.addWidget(el, { w: width, h: height, x: x, y: y });
      widgetRegistry.set(w.id, {
        ...w,
        instance: null,
        viewIds: w.viewIds || [],  
        tableHeaderColors: w.tableHeaderColors || {}
      });
    } catch(err) {}
  });
  
  loadViews();
  
  setTimeout(() => {
    widgetRegistry.forEach((cfg, id) => {
      try { initWidget(id); } catch(err) {}
    });
    
    if (views.length > 0 && currentViewId) {
      const view = views.find(v => v.id === currentViewId);
      if (view) {
        setTimeout(() => applyStrictViewFiltering(view), 100);
      }
    }
  }, 300);
}

function closeWorkspace() {
  widgetRegistry.forEach((cfg, id) => {
    if (cfg._timer) clearInterval(cfg._timer);
    if (cfg._ro) try { cfg._ro.disconnect(); } catch(e) {}
    if (cfg.instance) try { cfg.instance.dispose(); } catch(e) {}
  });
  
  currentDashId = null;
  currentViewId = null;
  widgetRegistry.clear();
  grid.removeAll();
  
  document.getElementById('screen-workspace').classList.add('hidden');
  document.getElementById('screen-list').classList.remove('hidden');
  document.getElementById('btn-export').classList.add('hidden');
  document.getElementById('btn-history').classList.add('hidden');
  refreshList();
}

function loadViews() {
  if (!currentDashId) return;
  
  views = getDashboardViews(currentDashId);
  
  if (views.length === 0) {
    views = [{
      id: 'view_all_' + Date.now(),
      name: 'All Widgets',
      icon: 'ph-house',
      widgetIds: [],
      order: 0
    }];
    saveDashboardViews(currentDashId, views);
  }
  
  views.sort((a, b) => a.order - b.order);
  updateSidebarNavigation();
  
  if (views.length > 0) {
    activateView(views[0].id);
  }
}

function updateSidebarNavigation() {
  const container = document.getElementById('sidebar-nav-items');
  container.innerHTML = '';
  
  views.forEach(view => {
    const button = document.createElement('button');
    button.className = 'sidebar-nav-item';
    button.id = `view-btn-${view.id}`;
    if (view.id === currentViewId) {
      button.classList.add('active');
    }
    
    const iconClass = getIconClass(view.icon) || 'ph ph-house';
    button.innerHTML = `
      <div class="ic"><i class="${iconClass}"></i></div>
      <span>${escapeHtml(view.name)}</span>
    `;
    button.onclick = () => activateView(view.id);
    container.appendChild(button);
  });
}

function applyStrictViewFiltering(view) {
  if (!view) return;
  
  const widgetItems = Array.from(grid.engine.nodes);
  
  widgetItems.forEach(node => {
    const content = node.el.querySelector('.grid-stack-item-content');
    if (!content) return;
    
    const widgetId = content.getAttribute('gs-id');
    const cfg = widgetRegistry.get(widgetId);
    if (!cfg) return;
    
    let shouldShow = false;
    
    if (view.id.startsWith('view_all_')) {
      shouldShow = true;
    } else {
      if (cfg.viewIds && cfg.viewIds.includes(view.id)) {
        shouldShow = true;
      }
      else if (view.widgetIds && view.widgetIds.includes(widgetId)) {
        shouldShow = true;
        if (!cfg.viewIds) cfg.viewIds = [];
        if (!cfg.viewIds.includes(view.id)) {
          cfg.viewIds.push(view.id);
        }
      }
    }
    
    if (isEditMode) {
      shouldShow = true;
    }
    
    // Apply visibility with both display and visibility properties
    if (shouldShow) {
      node.el.style.display = '';
      node.el.style.visibility = 'visible';
      node.el.style.opacity = '1';
      node.el.style.pointerEvents = 'auto';
      delete node.el.dataset.hiddenByView;
    } else {
      node.el.style.display = 'none';
      node.el.style.visibility = 'hidden';
      node.el.style.opacity = '0';
      node.el.style.pointerEvents = 'none';
      node.el.dataset.hiddenByView = 'true';
    }
  });
  
  setTimeout(() => {
    try {
      grid.engine.updateNodeArray();
      grid.engine.commit();
    } catch (e) {}
  }, 10);
}

function activateView(viewId) {
  if (!currentDashId) return;
  
  const view = views.find(v => v.id === viewId);
  if (!view) return;
  
  currentViewId = viewId;
  
  document.querySelectorAll('.sidebar-nav-item').forEach(btn => {
    btn.classList.remove('active');
  });
  const activeBtn = document.getElementById(`view-btn-${viewId}`);
  if (activeBtn) {
    activeBtn.classList.add('active');
  }
  
  applyStrictViewFiltering(view);
}

function getDefaultSize(type, cfg) {
  switch(type) {
    case 'card': case 'button': case 'toggle': case 'slider': case 'dropdown': return { w: 2, h: 2 };
    case 'input': return { w: 3, h: 2 };
    case 'groupCard': return { w: 6, h: 3 };
    case 'table': case 'terminal': case 'iframe': case 'image': case 'html': return { w: 6, h: 4 };
    case 'largeArea': return { w: 8, h: 5 };
    case 'timeseries': case 'gauge': case 'progress': case 'liquid': return { w: 4, h: 4 };
    case 'pie': case 'donut': case 'radar': case 'polar': return { w: 4, h: 4 };
    case 'heatmap': case 'calendarHeat': return { w: 6, h: 4 };
    case 'scatter': case 'bubble': case 'scatterMatrix': case 'scatterRegression': case 'scatterClustering': return { w: 6, h: 4 };
    case 'funnel': case 'map': return { w: 6, h: 5 };
    default: return { w: 6, h: 4 };
  }
}

function makeWidgetElement(cfg) {
  const id = cfg.id || `w_${Date.now()}`;
  let inner;
  if (cfg.type === 'table') inner = `<div id="${id}_table" class="table-widget"></div>`;
  else if (cfg.type === 'card') inner = `<div id="${id}_card" class="enhanced-card"></div>`;
  else if (cfg.type === 'groupCard') inner = `<div id="${id}_card" class="card-widget"><div class="group-cards" id="${id}_group"></div></div>`;
  else if (cfg.type === 'input') inner = `<div id="${id}_comp" class="input-widget"><input id="${id}_input" class="form-input" placeholder="${escapeHtml(cfg.title || 'Enter...')}" style="width:90%"></div>`;
  else if (cfg.type === 'button') inner = `<div id="${id}_comp" class="btn-widget"><button id="${id}_button" class="btn btn-primary">${escapeHtml(cfg.title || 'Button')}</button></div>`;
  else if (cfg.type === 'toggle') inner = `<div id="${id}_comp" class="toggle-widget"><label style="display:inline-flex;align-items:center;gap:8px"><input id="${id}_toggle" type="checkbox"><span>${escapeHtml(cfg.title || 'Toggle')}</span></label></div>`;
  else if (cfg.type === 'slider') inner = `<div id="${id}_comp" class="slider-widget" style="padding:20px"><input id="${id}_slider" type="range" min="0" max="100" value="50" style="width:90%"></div>`;
  else if (cfg.type === 'dropdown') inner = `<div id="${id}_comp" class="dropdown-widget" style="padding:20px"><select id="${id}_dropdown" class="form-input"><option>Option 1</option><option>Option 2</option></select></div>`;
  else if (cfg.type === 'terminal') inner = `<div id="${id}_term" class="terminal-log">System ready...\n</div>`;
  else if (cfg.type === 'iframe') inner = `<div id="${id}_iframe" style="width:100%;height:100%;border:none"></div>`;
  else if (cfg.type === 'image') inner = `<div id="${id}_image" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#f8fafc"><div class="small">Image Placeholder</div></div>`;
  else if (cfg.type === 'html') inner = `<div id="${id}_html" style="width:100%;height:100%;padding:10px;background:#f8fafc"><div class="small">HTML Content Area</div></div>`;
  else inner = `<div id="${id}_chart" class="chart"></div>`;

  let iconHtml = '';
  if (cfg.icon) {
    const iconClass = getIconClass(cfg.icon);
    iconHtml = `<i class="${iconClass}" style="margin-right:6px;font-size:16px;color:${cfg.color || '#4f46e5'}"></i>`;
  }
  
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <div class="grid-stack-item-content ${isSmallWidget(cfg.type) ? 'small' : ''}" gs-id="${id}" data-gs-id="${id}">
      <div class="widget-header">
        <div class="widget-title" id="${id}_title" style="display:flex;align-items:center;">
          ${iconHtml}${escapeHtml(cfg.title || cfg.type || 'Widget')}
        </div>
        <div>
          <button class="icon-btn settings" title="Settings" onclick="openModal('${id}')"><i class="ph ph-gear"></i></button>
          <button class="icon-btn delete" title="Delete Widget" onclick="removeWidget('${id}')"><i class="ph ph-trash"></i></button>
        </div>
      </div>
      <div class="widget-body">${inner}</div>
    </div>
  `;
  return wrapper.firstElementChild;
}

function getIconClass(iconName) {
  const iconMap = {
    'ph-house': 'ph ph-house',
    'ph-chart-line': 'ph ph-chart-line',
    'ph-gauge': 'ph ph-gauge',
    'ph-eye': 'ph ph-eye',
    'ph-warning': 'ph ph-warning',
    'ph-activity': 'ph ph-activity',
    'ph-speedometer': 'ph ph-speedometer',
    'ph-bell': 'ph ph-bell',
    'ph-line-chart': 'ph ph-chart-line',
    'ph-bar-chart': 'ph ph-chart-bar',
    'ph-cpu': 'ph ph-cpu',
    'ph-thermometer': 'ph ph-thermometer',
    'ph-check-circle': 'ph ph-check-circle',
    'ph-fire': 'ph ph-fire',
    'ph-drop': 'ph ph-drop',
    'ph-lightning': 'ph ph-lightning',
    'ph-chart-bar-horizontal': 'ph ph-chart-bar-horizontal',
    'ph-scatter-plot': 'ph ph-scatter-plot',
    'ph-circle-dashed': 'ph ph-circle-dashed',
    'ph-radar': 'ph ph-radar',
    'ph-circle-wavy': 'ph ph-circle-wavy',
    'ph-stack': 'ph ph-stack',
    'ph-stack-simple': 'ph ph-stack-simple',
    'ph-arrows-left-right': 'ph ph-arrows-left-right',
    'ph-cloud': 'ph ph-cloud',
    'ph-clock': 'ph ph-clock',
    'ph-stairs': 'ph ph-stairs',
    'ph-chart-line-up': 'ph ph-chart-line-up',
    'ph-database': 'ph ph-database',
    'ph-sort-ascending': 'ph ph-sort-ascending',
    'ph-arrows-out': 'ph ph-arrows-out',
    'ph-circle': 'ph ph-circle',
    'ph-target': 'ph ph-target',
    'ph-chart-pie': 'ph ph-chart-pie',
    'ph-circle-notch': 'ph ph-circle-notch',
    'ph-gauges': 'ph ph-gauges',
    'ph-speedometer': 'ph ph-speedometer',
    'ph-grid-four': 'ph ph-grid-four',
    'ph-trend-up': 'ph ph-trend-up',
    'ph-circles-three': 'ph ph-circles-three',
    'ph-fire': 'ph ph-fire',
    'ph-calendar': 'ph ph-calendar',
    'ph-funnel': 'ph ph-funnel',
    'ph-map-trifold': 'ph ph-map-trifold',
    'ph-cardholder': 'ph ph-cardholder',
    'ph-cards-three': 'ph ph-cards-three',
    'ph-table': 'ph ph-table',
    'ph-textbox': 'ph ph-textbox',
    'ph-square': 'ph ph-square',
    'ph-toggle-left': 'ph ph-toggle-left',
    'ph-sliders': 'ph ph-sliders',
    'ph-caret-down': 'ph ph-caret-down',
    'ph-terminal-window': 'ph ph-terminal-window',
    'ph-browser': 'ph ph-browser',
    'ph-image': 'ph ph-image',
    'ph-code': 'ph ph-code'
  };
  return iconMap[iconName] || 'ph ph-cube';
}

function isSmallWidget(type) {
  return ['card', 'button', 'toggle', 'input', 'slider', 'dropdown'].includes(type);
}

function addWidget(type) {
  const id = `w_${Date.now()}`;
  const title = humanTitle(type);
  const defaultData = defaultDataForType(type);
  const cfg = {
    id,
    type,
    title,
    icon: defaultData.icon || '',
    color: defaultData.color || '#4f46e5',
    viewIds: [],  
    tableHeaderColors: {},
    ...defaultData
  };
  
  const el = makeWidgetElement(cfg);
  const size = getDefaultSize(type, cfg);
  grid.addWidget(el, { w: size.w, h: size.h, x: 0, y: 0 });
  widgetRegistry.set(id, { ...cfg, instance: null });
  
  setTimeout(() => { 
    initWidget(id); 
    if (currentViewId) {
      const view = views.find(v => v.id === currentViewId);
      if (view) {
        applyStrictViewFiltering(view);
      }
    }
  }, 100);
  markUnsaved();
}

function humanTitle(t) {
  const titles = {
    'basicLine': 'Line Chart',
    'smoothLine': 'Smooth Line',
    'stepLine': 'Step Line',
    'basicArea': 'Area Chart',
    'stackedLine': 'Stacked Line',
    'stackedArea': 'Stacked Area',
    'multiAxis': 'Multi Axis',
    'confidenceBand': 'Confidence Band',
    'largeArea': 'Large Area',
    'timeseries': 'Time Series',
    'dynamicLine': 'Dynamic Line',
    'bar': 'Bar Chart',
    'horizontalBar': 'Horizontal Bar',
    'stackedBar': 'Stacked Bar',
    'sortBar': 'Sorted Bar',
    'simpleEncode': 'Dataset Bar',
    'floatingBar': 'Floating Bar',
    'polarBar': 'Polar Bar',
    'radialBar': 'Radial Bar',
    'pie': 'Pie Chart',
    'donut': 'Donut Chart',
    'radar': 'Radar Chart',
    'polar': 'Polar Chart',
    'gauge': 'Gauge',
    'progress': 'Progress Gauge',
    'liquid': 'Liquid Fill',
    'multiGauge': 'Multi Gauge',
    'dashboard': 'Dashboard',
    'thermometer': 'Thermometer',
    'scatter': 'Scatter Plot',
    'bubble': 'Bubble Chart',
    'scatterMatrix': 'Scatter Matrix',
    'scatterRegression': 'Scatter Regression',
    'scatterClustering': 'Scatter Clusters',
    'heatmap': 'Heatmap',
    'calendarHeat': 'Calendar Heat',
    'funnel': 'Funnel Chart',
    'map': 'Map Chart',
    'card': 'Card',
    'groupCard': 'Group Cards',
    'table': 'Table',
    'input': 'Input Field',
    'button': 'Button',
    'toggle': 'Toggle',
    'slider': 'Slider',
    'dropdown': 'Dropdown',
    'terminal': 'Terminal',
    'iframe': 'Webpage',
    'image': 'Image',
    'html': 'HTML'
  };
  return titles[t] || t;
}

function defaultDataForType(type) {
  const commonX = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const commonY = [120, 200, 150, 80, 70, 110, 130];
  
  if (type === 'card') return { xData: [], yData: [42], icon: 'ph-activity', color: '#4f46e5' };
  if (type === 'groupCard') return { xData: [], yData: [12, 34], groupCount: 2, groupItems: [{label: 'A', value: 12}, {label: 'B', value: 34}], icon: 'ph-cube', color: '#4f46e5' };
  if (type === 'table') return {
    xData: ['Name', 'Value', 'Status'],
    yData: [
      ['Item1', '42', 'Active'],
      ['Item2', '67', 'Warning'],
      ['Item3', '23', 'Inactive']
    ],
    tableColumns: 3,
    tableRows: 3,
    tableHeaderColors: { 0: '#4f46e5', 1: '#10b981', 2: '#ef4444' },
    icon: 'ph-table',
    color: '#4f46e5'
  };
  if (type === 'input') return { xData: [], yData: [''], icon: 'ph-chat-text', color: '#4f46e5' };
  if (type === 'button') return { xData: [], yData: [], icon: 'ph-button', color: '#4f46e5' };
  if (type === 'toggle') return { xData: [], yData: [0], icon: 'ph-toggle-left', color: '#4f46e5' };
  if (type === 'slider') return { xData: [], yData: [50], icon: 'ph-sliders', color: '#4f46e5' };
  if (type === 'dropdown') return { xData: [], yData: [], icon: 'ph-caret-down', color: '#4f46e5' };
  if (type === 'terminal') return { xData: [], yData: [], icon: 'ph-terminal-window', color: '#4f46e5' };
  if (type === 'iframe') return { xData: [], yData: [], icon: 'ph-browser', color: '#4f46e5' };
  if (type === 'image') return { xData: [], yData: [], icon: 'ph-image', color: '#4f46e5' };
  if (type === 'html') return { xData: [], yData: [], icon: 'ph-code', color: '#4f46e5' };
  if (type === 'gauge') return { xData: [], yData: [65], min: 0, max: 100, icon: 'ph-gauge', color: '#4f46e5' };
  if (type === 'progress') return { xData: [], yData: [75], min: 0, max: 100, icon: 'ph-progress-bar', color: '#4f46e5' };
  if (type === 'liquid') return { xData: [], yData: [0.6], min: 0, max: 1, icon: 'ph-drop', color: '#4f46e5' };
  if (type === 'multiGauge') return { xData: [], yData: [65, 80, 45], min: 0, max: 100, icon: 'ph-gauges', color: '#4f46e5' };
  if (type === 'thermometer') return { xData: [], yData: [78], min: 0, max: 100, icon: 'ph-thermometer', color: '#4f46e5' };
  if (type === 'dashboard') return { xData: [], yData: [85], min: 0, max: 100, icon: 'ph-speedometer', color: '#4f46e5' };
  if (type === 'pie' || type === 'donut') return { xData: ['A', 'B', 'C', 'D'], yData: [40, 30, 20, 10], icon: 'ph-pie-chart', color: '#4f46e5' };
  if (type === 'radar') return { xData: ['Speed', 'Power', 'Durability', 'Energy', 'Accuracy'], yData: [80, 90, 70, 85, 75], icon: 'ph-radar', color: '#4f46e5' };
  if (type === 'polar') return { xData: ['A', 'B', 'C', 'D', 'E'], yData: [30, 40, 20, 50, 35], icon: 'ph-circle', color: '#4f46e5' };
  if (type === 'scatter' || type === 'bubble') return { xData: [], yData: [], icon: 'ph-scatter-plot', color: '#4f46e5' };
  if (type === 'calendarHeat') return { xData: [], yData: [], icon: 'ph-calendar', color: '#4f46e5' };
  if (type === 'funnel') return { xData: ['Step 1', 'Step 2', 'Step 3', 'Step 4'], yData: [100, 70, 50, 20], icon: 'ph-funnel', color: '#4f46e5' };
  if (type === 'map') return { xData: [], yData: [], icon: 'ph-map-trifold', color: '#4f46e5' };
  if (type === 'stepLine') return { xData: commonX, yData: commonY, icon: 'ph-stairs', color: '#4f46e5' };
  if (type === 'multiAxis') return { xData: commonX, yData: commonY, icon: 'ph-arrows-left-right', color: '#4f46e5' };
  if (type === 'confidenceBand') return { xData: commonX, yData: commonY, icon: 'ph-cloud', color: '#4f46e5' };
  if (type === 'dynamicLine') return { xData: commonX, yData: commonY, icon: 'ph-lightning', color: '#4f46e5' };
  if (type === 'stackedBar') return { xData: commonX, yData: commonY, icon: 'ph-stack', color: '#4f46e5' };
  if (type === 'floatingBar') return { xData: commonX, yData: commonY, icon: 'ph-arrows-out', color: '#4f46e5' };
  if (type === 'polarBar') return { xData: commonX, yData: commonY, icon: 'ph-circle', color: '#4f46e5' };
  if (type === 'radialBar') return { xData: commonX, yData: commonY, icon: 'ph-circle-wavy', color: '#4f46e5' };
  if (type === 'scatterMatrix') return { xData: [], yData: [], icon: 'ph-grid-four', color: '#4f46e5' };
  if (type === 'scatterRegression') return { xData: [], yData: [], icon: 'ph-trend-up', color: '#4f46e5' };
  if (type === 'scatterClustering') return { xData: [], yData: [], icon: 'ph-circles-three', color: '#4f46e5' };
  
  return { xData: commonX, yData: commonY, min: 0, max: 100, icon: 'ph-line-chart', color: '#4f46e5' };
}

function removeWidget(id) {
  const cfg = widgetRegistry.get(id);
  if (cfg) {
    if (cfg._timer) clearInterval(cfg._timer);
    if (cfg._ro) try { cfg._ro.disconnect(); } catch(e) {}
    if (cfg.instance) try { cfg.instance.dispose(); } catch(e) {}
    widgetRegistry.delete(id);
  }

  const content = document.querySelector(`[gs-id="${id}"]`);
  if (!content) return;
  
  const item = content.closest('.grid-stack-item');
  if (item) {
    grid.removeWidget(item);
    item.parentNode.removeChild(item);
  }
  
  markUnsaved();
  
  // Remove widget from all views
  if (currentDashId) {
    views.forEach(view => {
      if (view.widgetIds) {
        view.widgetIds = view.widgetIds.filter(widgetId => widgetId !== id);
      }
    });
    saveDashboardViews(currentDashId, views);
  }
}

function initWidget(id) {
  const cfg = widgetRegistry.get(id);
  if (!cfg) return;

  const chartEl = document.getElementById(`${id}_chart`);
  const tableEl = document.getElementById(`${id}_table`);
  const cardEl = document.getElementById(`${id}_card`);
  const compEl = document.getElementById(`${id}_comp`);
  const termEl = document.getElementById(`${id}_term`);
  const iframeEl = document.getElementById(`${id}_iframe`);
  const imageEl = document.getElementById(`${id}_image`);
  const htmlEl = document.getElementById(`${id}_html`);

  const titleEl = document.getElementById(`${id}_title`);
  if (titleEl) {
    let iconHtml = '';
    if (cfg.icon) {
      const iconClass = getIconClass(cfg.icon);
      iconHtml = `<i class="${iconClass}" style="margin-right:6px;font-size:16px;color:${cfg.color || '#4f46e5'}"></i>`;
    }
    titleEl.innerHTML = iconHtml + escapeHtml(cfg.title || cfg.type || 'Widget');
  }

  if (tableEl) {
    tableEl.innerHTML = '';
    const tbl = document.createElement('table');
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    
    const headers = cfg.xData || Array.from({length: cfg.tableColumns || 3}, (_, i) => `Col${i+1}`);
    
    headers.forEach((h, colIndex) => {
      const th = document.createElement('th');
      th.textContent = h;
      const headerColor = cfg.tableHeaderColors && cfg.tableHeaderColors[colIndex];
      if (headerColor) {
        th.style.backgroundColor = headerColor;
        th.style.color = '#ffffff';
        th.style.fontWeight = '600';
      }
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    tbl.appendChild(thead);
    
    const tbody = document.createElement('tbody');
    const tableData = cfg.yData || [];
    
    if (Array.isArray(tableData[0]) && Array.isArray(tableData[0])) {
      tableData.forEach(rowData => {
        const tr = document.createElement('tr');
        rowData.forEach(cellValue => {
          const td = document.createElement('td');
          td.textContent = cellValue !== undefined ? cellValue : '';
          tr.appendChild(td);
        });
        if (rowData.length < headers.length) {
          for (let i = rowData.length; i < headers.length; i++) {
            const td = document.createElement('td');
            td.textContent = '';
            tr.appendChild(td);
          }
        }
        tbody.appendChild(tr);
      });
    } else {
      const columnCount = headers.length;
      const values = tableData;
      const rowCount = Math.ceil(values.length / columnCount);
      
      for (let row = 0; row < rowCount; row++) {
        const tr = document.createElement('tr');
        for (let col = 0; col < columnCount; col++) {
          const td = document.createElement('td');
          const index = row * columnCount + col;
          td.textContent = values[index] !== undefined ? values[index] : '';
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
    }
    tbl.appendChild(tbody);
    tableEl.appendChild(tbl);
    return;
  }

  if (cardEl) {
    if (cfg.type === 'groupCard') {
      const groupEl = document.getElementById(`${id}_group`);
      groupEl.innerHTML = '';
      const items = cfg.groupItems || (cfg.yData||[]).map((v,i) => ({label: cfg.xData[i]||`Item${i+1}`, value: v}));
      const count = cfg.groupCount || items.length || 2;
      for (let i = 0; i < count; i++) {
        const it = items[i] || {label: `Item ${i+1}`, value: (cfg.yData && cfg.yData[i]) || 0};
        const item = document.createElement('div');
        item.className = 'group-card-item';
        item.innerHTML = `<div style="font-size:12px;color:var(--muted)">${escapeHtml(it.label)}</div><div style="font-weight:700;font-size:20px;margin-top:6px;color:${cfg.color || '#4f46e5'}">${escapeHtml(String(it.value))}</div>`;
        groupEl.appendChild(item);
      }
      return;
    } else {
      cardEl.innerHTML = '';
      const inner = document.createElement('div');
      inner.className = 'enhanced-card';
      
      if (cfg.icon) {
        const icon = document.createElement('div');
        icon.className = 'enhanced-card-icon';
        const iconClass = getIconClass(cfg.icon);
        icon.innerHTML = `<i class="${iconClass}"></i>`;
        inner.appendChild(icon);
      }
      
      const title = document.createElement('div');
      title.className = 'enhanced-card-title';
      title.textContent = cfg.title || 'Card';
      inner.appendChild(title);
      
      const val = document.createElement('div');
      val.className = 'enhanced-card-value';
      val.textContent = (cfg.yData && cfg.yData[0] !== undefined) ? cfg.yData[0] : '-';
      val.style.color = cfg.color || '#4f46e5';
      inner.appendChild(val);
      
      const unit = document.createElement('div');
      unit.className = 'enhanced-card-unit';
      unit.textContent = 'Units';
      inner.appendChild(unit);
      
      cardEl.appendChild(inner);
      return;
    }
  }

  if (compEl) {
    if (cfg.type === 'input') {
      const input = document.getElementById(`${id}_input`);
      if (input) {
        input.value = cfg.yData && cfg.yData[0] !== undefined ? cfg.yData[0] : '';
        input.placeholder = cfg.title || 'Enter...';
        input.oninput = () => { cfg.yData = [input.value]; markUnsaved(); };
      }
      return;
    }
    if (cfg.type === 'button') {
      const btn = document.getElementById(`${id}_button`);
      if (btn) {
        btn.textContent = cfg.title || 'Button';
        btn.style.backgroundColor = cfg.color || '#4f46e5';
        btn.onclick = () => alert(`Button "${cfg.title}" clicked`);
      }
      return;
    }
    if (cfg.type === 'toggle') {
      const toggle = document.getElementById(`${id}_toggle`);
      if (toggle) {
        toggle.checked = !!(cfg.yData && cfg.yData[0]);
        toggle.onchange = () => { cfg.yData = [toggle.checked ? 1 : 0]; markUnsaved(); };
      }
      return;
    }
    if (cfg.type === 'slider') {
      const slider = document.getElementById(`${id}_slider`);
      if (slider) {
        slider.value = cfg.yData && cfg.yData[0] !== undefined ? cfg.yData[0] : 50;
        slider.oninput = () => { cfg.yData = [parseInt(slider.value)]; markUnsaved(); };
      }
      return;
    }
    if (cfg.type === 'dropdown') {
      const dropdown = document.getElementById(`${id}_dropdown`);
      if (dropdown) {
        dropdown.onchange = () => { cfg.yData = [dropdown.value]; markUnsaved(); };
      }
      return;
    }
  }

  if (termEl) {
    termEl.innerHTML = 'System Ready...\n';
    return;
  }

  if (iframeEl) {
    iframeEl.src = 'about:blank';
    iframeEl.srcdoc = '<html><body style="margin:0;padding:20px;font-family:Arial"><h3>Embedded Content</h3><p>Webpage content would appear here.</p></body></html>';
    return;
  }

  if (imageEl) {
    imageEl.innerHTML = '<div style="text-align:center"><div style="font-size:14px;margin-bottom:8px">Image Display</div><div style="width:100px;height:100px;background:linear-gradient(135deg,#4f46e5,#7c3aed);margin:0 auto;border-radius:8px;"></div></div>';
    return;
  }

  if (htmlEl) {
    htmlEl.innerHTML = '<div style="font-size:14px;margin-bottom:8px">Custom HTML Content</div><div style="background:#e2e8f0;padding:12px;border-radius:6px;font-family:monospace;font-size:12px">&lt;div&gt;Your HTML here&lt;/div&gt;</div>';
    return;
  }

  if (chartEl) {
    let chart = cfg.instance || null;
    if (!chart) {
      chart = echarts.init(chartEl);
      cfg.instance = chart;
    }

    const rect = chartEl.getBoundingClientRect();
    const option = buildOptionAdvanced(cfg, rect.width || 600, rect.height || 300);
    try { chart.setOption(option, true); } catch(e) {}

    if (cfg.type === 'timeseries' && !cfg._timer) {
      cfg._ts = cfg._ts || { x: [], y: [] };
      if (cfg._ts.x.length === 0) {
        const now = Date.now();
        for (let i = 0; i < 10; i++) {
          cfg._ts.x.push(new Date(now - (9-i)*1000).toISOString().slice(11,19));
          cfg._ts.y.push(Math.round(20 + Math.random()*60));
        }
      }
      
      cfg._timer = setInterval(() => {
        if (!cfg.instance) return;
        const now = new Date().toISOString().slice(11,19);
        cfg._ts.x.push(now);
        cfg._ts.y.push(Math.round(20 + Math.random()*60));
        if (cfg._ts.x.length > 50) cfg._ts.x.shift();
        if (cfg._ts.y.length > 50) cfg._ts.y.shift();
        try { cfg.instance.setOption({ xAxis: { data: cfg._ts.x }, series: [{ data: cfg._ts.y }] }); } catch(e) {}
      }, 1200);
    }

    if (cfg._ro) {
      try { cfg._ro.disconnect(); } catch(e) {}
    }
    
    const ro = new ResizeObserver(() => {
      if (cfg.instance) {
        try { cfg.instance.resize(); } catch(e) {}
      }
    });
    ro.observe(chartEl);
    cfg._ro = ro;
  }
}

function buildOptionAdvanced(cfg, width = 800, height = 400) {
  if (cfg.customOption) return cfg.customOption;
  const compact = width < 240 || height < 140;
  const x = cfg.xData || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const y = cfg.yData || [120, 200, 150, 80, 70, 110, 130];
  const axisCompact = compact ? { axisLabel: { show: false }, axisTick: { show: false }, splitLine: { show: false } } : {};
  const color = cfg.color || '#4f46e5';
  const colors = [color, lightenColor(color, 20), lightenColor(color, 40), lightenColor(color, 60)];

  switch (cfg.type) {
    case 'basicLine':
      return { tooltip: { trigger: 'axis' }, xAxis: Object.assign({ type: 'category', data: x }, axisCompact), yAxis: Object.assign({ type: 'value' }, axisCompact), series: [{ type: 'line', data: y, itemStyle: { color: color } }] };
    case 'smoothLine':
      return { tooltip: { trigger: 'axis' }, xAxis: Object.assign({ type: 'category', data: x }, axisCompact), yAxis: Object.assign({ type: 'value' }, axisCompact), series: [{ type: 'line', smooth: true, data: y, itemStyle: { color: color } }] };
    case 'stepLine':
      return { tooltip: { trigger: 'axis' }, xAxis: Object.assign({ type: 'category', data: x }, axisCompact), yAxis: Object.assign({ type: 'value' }, axisCompact), series: [{ type: 'line', step: 'middle', data: y, itemStyle: { color: color } }] };
    case 'basicArea':
      return { tooltip: { trigger: 'axis' }, xAxis: Object.assign({ type: 'category', boundaryGap: false, data: x }, axisCompact), yAxis: Object.assign({ type: 'value' }, axisCompact), series: [{ type: 'line', areaStyle: { color: color }, data: y, itemStyle: { color: color } }] };
    case 'stackedLine':
      return { tooltip: { trigger: 'axis' }, legend: compact ? undefined : {}, xAxis: Object.assign({ type: 'category', data: x }, axisCompact), yAxis: Object.assign({ type: 'value' }, axisCompact), series: [
          { name: 'A', type: 'line', stack: 's', data: y, itemStyle: { color: color } },
          { name: 'B', type: 'line', stack: 's', data: y.map(v => Math.round(v*0.8)), itemStyle: { color: lightenColor(color, 20) } }
        ] };
    case 'stackedArea':
      return { tooltip: { trigger: 'axis' }, legend: compact ? undefined : {}, xAxis: Object.assign({ type: 'category', boundaryGap: false, data: x }, axisCompact), yAxis: Object.assign({ type: 'value' }, axisCompact), series: [
          { name: 'A', type: 'line', stack: 's', areaStyle: { color: color }, data: y, itemStyle: { color: color } },
          { name: 'B', type: 'line', stack: 's', areaStyle: { color: lightenColor(color, 30) }, data: y.map(v => Math.round(v*0.6)), itemStyle: { color: lightenColor(color, 30) } }
        ] };
    case 'multiAxis':
      return { tooltip: { trigger: 'axis' }, legend: {}, xAxis: { type: 'category', data: x }, yAxis: [{ type: 'value' }, { type: 'value' }], series: [
          { name: 'Series A', type: 'line', yAxisIndex: 0, data: y, itemStyle: { color: color } },
          { name: 'Series B', type: 'line', yAxisIndex: 1, data: y.map(v => Math.round(v*2)), itemStyle: { color: lightenColor(color, 40) } }
        ] };
    case 'confidenceBand':
      const upper = y.map(v => v+20);
      const lower = y.map(v => v-20);
      return { tooltip: { trigger: 'axis' }, xAxis: { type: 'category', data: x }, yAxis: { type: 'value' }, series: [
          { name: 'Upper', type: 'line', data: upper, lineStyle: { opacity: 0 }, itemStyle: { color: color } },
          { name: 'Lower', type: 'line', data: lower, lineStyle: { opacity: 0 }, itemStyle: { color: color } },
          { name: 'Confidence', type: 'line', data: y, itemStyle: { color: color }, areaStyle: { color: color, opacity: 0.3 } }
        ] };
    case 'dynamicLine':
      return { tooltip: { trigger: 'axis' }, xAxis: { type: 'category', data: x }, yAxis: { type: 'value' }, series: [{ type: 'line', data: y, lineStyle: { type: 'dashed' }, itemStyle: { color: color } }] };
    case 'bar':
      return { tooltip: { trigger: 'axis' }, xAxis: { type: 'category', data: x }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: y, itemStyle: { color: color } }] };
    case 'horizontalBar':
      return { tooltip: { trigger: 'axis' }, xAxis: { type: 'value' }, yAxis: { type: 'category', data: x }, series: [{ type: 'bar', data: y, itemStyle: { color: color } }] };
    case 'stackedBar':
      return { tooltip: { trigger: 'axis' }, legend: {}, xAxis: { type: 'category', data: x }, yAxis: { type: 'value' }, series: [
          { name: 'A', type: 'bar', stack: 's', data: y, itemStyle: { color: color } },
          { name: 'B', type: 'bar', stack: 's', data: y.map(v => Math.round(v*0.6)), itemStyle: { color: lightenColor(color, 30) } }
        ] };
    case 'sortBar': {
      const data = (x.map((lab, i) => ({ name: lab, value: y[i] || 0 }))).sort((a, b) => b.value - a.value);
      return { tooltip: { trigger: 'item' }, xAxis: { type: 'category', data: data.map(d => d.name) }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: data.map(d => d.value), itemStyle: { color: color } }] };
    }
    case 'simpleEncode':
      return {
        dataset: { source: [ ['product', '2015', '2016', '2017'], ['Matcha Latte', 43.3, 85.8, 93.7], ['Milk Tea', 83.1, 73.4, 55.1] ] },
        xAxis: { type: 'category' }, yAxis: {}, series: [
          { type: 'bar', encode: { x: 'product', y: '2015' }, itemStyle: { color: color } },
          { type: 'bar', encode: { x: 'product', y: '2016' }, itemStyle: { color: lightenColor(color, 20) } },
          { type: 'bar', encode: { x: 'product', y: '2017' }, itemStyle: { color: lightenColor(color, 40) } }
        ]
      };
    case 'floatingBar':
      const floatingData = y.map((v, i) => [Math.round(v*0.8), Math.round(v*1.2)]);
      return { tooltip: { trigger: 'axis' }, xAxis: { type: 'category', data: x }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: floatingData, itemStyle: { color: color } }] };
    case 'polarBar':
      return { polar: { radius: [20, '80%'] }, angleAxis: { type: 'category', data: x }, radiusAxis: {}, series: [{ type: 'bar', coordinateSystem: 'polar', data: y, itemStyle: { color: color } }] };
    case 'radialBar':
      return { angleAxis: { type: 'category', data: x }, radiusAxis: {}, polar: {}, series: [{ type: 'bar', data: y, coordinateSystem: 'polar', itemStyle: { color: color } }] };
    case 'largeArea': {
      const N = 300;
      const xs = [];
      const ys = [];
      for (let i = 0; i < N; i++) {
        xs.push('p' + i);
        ys.push(Math.round(200 + Math.sin(i/20)*80 + Math.random()*120));
      }
      return { tooltip: { trigger: 'axis' }, xAxis: { type: 'category', data: xs }, yAxis: { type: 'value' }, series: [{ type: 'line', data: ys, areaStyle: { color: color }, itemStyle: { color: color } }] };
    }
    case 'timeseries': {
      const now = Date.now();
      const data = cfg._ts && cfg._ts.y ? cfg._ts.y.slice() : (new Array(10)).fill(0).map(() => Math.round(20 + Math.random()*60));
      const labels = cfg._ts && cfg._ts.x ? cfg._ts.x.slice() : (new Array(data.length)).fill(0).map((_, i) => new Date(now - (data.length-i-1)*1000).toISOString().slice(11,19));
      cfg._ts = { x: labels, y: data };
      return { tooltip: { trigger: 'axis' }, xAxis: Object.assign({ type: 'category', data: labels }, axisCompact), yAxis: Object.assign({ type: 'value' }, axisCompact), series: [{ type: 'line', data: data, itemStyle: { color: color } }] };
    }
    case 'pie':
      return { tooltip: { trigger: 'item' }, series: [{ type: 'pie', radius: '50%', data: x.map((name, i) => ({ name, value: y[i] })), itemStyle: { color: function(params) { return colors[params.dataIndex % colors.length]; } } }] };
    case 'donut':
      return { tooltip: { trigger: 'item' }, series: [{ type: 'pie', radius: ['40%', '70%'], data: x.map((name, i) => ({ name, value: y[i] })), itemStyle: { color: function(params) { return colors[params.dataIndex % colors.length]; } } }] };
    case 'radar':
      return { tooltip: { trigger: 'item' }, radar: { indicator: x.map(name => ({ name, max: 100 })) }, series: [{ type: 'radar', data: [{ value: y, name: 'Data' }], itemStyle: { color: color } }] };
    case 'polar':
      return { polar: { radius: [0, '80%'] }, angleAxis: { type: 'category', data: x, startAngle: 75 }, radiusAxis: {}, series: [{ type: 'bar', data: y, coordinateSystem: 'polar', itemStyle: { color: color } }] };
    case 'gauge':
      return { series: [{ type: 'gauge', min: cfg.min || 0, max: cfg.max || 100, detail: { formatter: '{value}' }, axisLine: { lineStyle: { color: [[1, color]] } }, data: [{ value: cfg.yData && cfg.yData[0] ? cfg.yData[0] : 0, name: cfg.title || 'Val' }] }] };
    case 'progress':
      return { series: [{ type: 'gauge', min: cfg.min || 0, max: cfg.max || 100, progress: { show: true, width: 18 }, axisLine: { lineStyle: { width: 18 } }, detail: { formatter: '{value}%' }, data: [{ value: cfg.yData && cfg.yData[0] ? cfg.yData[0] : 0, name: cfg.title || 'Progress' }] }] };
    case 'liquid':
      return { series: [{ type: 'liquidFill', data: [cfg.yData && cfg.yData[0] ? cfg.yData[0] : 0.5], outline: { show: false }, backgroundStyle: { color: '#f0f0f0' }, itemStyle: { color: color }, label: { formatter: '{c}', fontSize: 24 } }] };
    case 'multiGauge':
      return { series: [
          { type: 'gauge', center: ['20%', '50%'], min: 0, max: 100, detail: { formatter: '{value}' }, data: [{ value: cfg.yData && cfg.yData[0] ? cfg.yData[0] : 65 }] },
          { type: 'gauge', center: ['50%', '50%'], min: 0, max: 100, detail: { formatter: '{value}' }, data: [{ value: cfg.yData && cfg.yData[1] ? cfg.yData[1] : 80 }] },
          { type: 'gauge', center: ['80%', '50%'], min: 0, max: 100, detail: { formatter: '{value}' }, data: [{ value: cfg.yData && cfg.yData[2] ? cfg.yData[2] : 45 }] }
        ] };
    case 'dashboard':
      return { series: [{ type: 'gauge', min: cfg.min || 0, max: cfg.max || 100, splitNumber: 10, axisLine: { lineStyle: { width: 10 } }, pointer: { width: 5 }, detail: { formatter: '{value}%' }, data: [{ value: cfg.yData && cfg.yData[0] ? cfg.yData[0] : 85 }] }] };
    case 'thermometer':
      return { series: [{ type: 'gauge', min: cfg.min || 0, max: cfg.max || 100, splitNumber: 5, axisLine: { lineStyle: { color: [[0.2, '#91c7ae'], [0.8, '#63869e'], [1, '#c23531']] } }, detail: { formatter: '{value}°' }, data: [{ value: cfg.yData && cfg.yData[0] ? cfg.yData[0] : 78 }] }] };
    case 'scatter':
      const scatterData = [];
      for (let i = 0; i < 20; i++) scatterData.push([Math.random()*100, Math.random()*100]);
      return { tooltip: { trigger: 'item' }, xAxis: { type: 'value' }, yAxis: { type: 'value' }, series: [{ type: 'scatter', data: scatterData, symbolSize: 10, itemStyle: { color: color } }] };
    case 'bubble':
      const bubbleData = [];
      for (let i = 0; i < 15; i++) bubbleData.push([Math.random()*100, Math.random()*100, Math.random()*30]);
      return { tooltip: { trigger: 'item' }, xAxis: { type: 'value' }, yAxis: { type: 'value' }, series: [{ type: 'scatter', data: bubbleData, symbolSize: function(val) { return val[2]; }, itemStyle: { color: color } }] };
    case 'scatterMatrix':
      return { tooltip: { trigger: 'item' }, xAxis: { type: 'value' }, yAxis: { type: 'value' }, series: [{ type: 'scatter', data: [[10, 20], [30, 40], [50, 60], [70, 80]], itemStyle: { color: color } }] };
    case 'scatterRegression':
      const regData = [];
      for (let i = 0; i < 20; i++) regData.push([i*5, i*4 + Math.random()*10]);
      return { tooltip: { trigger: 'item' }, xAxis: { type: 'value' }, yAxis: { type: 'value' }, series: [{ type: 'scatter', data: regData, itemStyle: { color: color } }] };
    case 'scatterClustering':
      const clusterData = [];
      for (let i = 0; i < 30; i++) clusterData.push([Math.random()*50, Math.random()*50]);
      return { tooltip: { trigger: 'item' }, xAxis: { type: 'value' }, yAxis: { type: 'value' }, series: [{ type: 'scatter', data: clusterData, itemStyle: { color: color } }] };
    case 'heatmap': {
      const data = [];
      for (let i = 0; i < 7; i++) {
        for (let j = 0; j < 24; j++) {
          data.push([j, i, Math.round(Math.random()*100)]);
        }
      }
      return { tooltip: { position: 'top' }, grid: { height: '50%', top: '10%' }, xAxis: { type: 'category', data: Array.from({ length: 24 }, (_, i) => i + ':00') }, yAxis: { type: 'category', data: x }, visualMap: { min: 0, max: 100, calculable: true, orient: 'horizontal', left: 'center', bottom: '15%' }, series: [{ type: 'heatmap', data: data, emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.5)' } } }] };
    }
    case 'calendarHeat': {
      const now = new Date();
      const startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      const calData = [];
      for (let i = 0; i < 30; i++) {
        const date = new Date(startDate);
        date.setDate(date.getDate() + i);
        calData.push([date.toISOString().split('T')[0], Math.round(Math.random()*100)]);
      }
      return { tooltip: { position: 'top' }, visualMap: { min: 0, max: 100, calculable: true, orient: 'horizontal', left: 'center' }, calendar: { range: [startDate.toISOString().split('T')[0], new Date(startDate.getFullYear(), startDate.getMonth()+1, 0).toISOString().split('T')[0]] }, series: [{ type: 'heatmap', coordinateSystem: 'calendar', data: calData }] };
    }
    case 'funnel':
      return { tooltip: { trigger: 'item' }, series: [{ type: 'funnel', data: x.map((name, i) => ({ name, value: y[i] })), itemStyle: { color: color } }] };
    case 'map':
      return { visualMap: { min: 0, max: 100 }, series: [{ type: 'map', map: 'world', data: [{ name: 'China', value: 100 }, { name: 'USA', value: 80 }, { name: 'India', value: 70 }, { name: 'Brazil', value: 60 }, { name: 'Russia', value: 50 }] }] };
    default:
      return { xAxis: { type: 'category', data: x }, yAxis: { type: 'value' }, series: [{ type: 'line', data: y, itemStyle: { color: color } }] };
  }
}

function lightenColor(color, percent) {
  const num = parseInt(color.slice(1), 16);
  const amt = Math.round(2.55 * percent);
  const R = (num >> 16) + amt;
  const G = (num >> 8 & 0x00FF) + amt;
  const B = (num & 0x0000FF) + amt;
  return '#' + (0x1000000 + (R<255?R<1?0:R:255)*0x10000 + (G<255?G<1?0:G:255)*0x100 + (B<255?B<1?0:B:255)).toString(16).slice(1);
}

let modalActiveId = null;

function openModal(id) {
  modalActiveId = id;
  const cfg = widgetRegistry.get(id) || {};
  document.getElementById('settings-modal').classList.remove('hidden');
  document.getElementById('modal-title').innerText = 'Settings — ' + (cfg.title || cfg.type);
  document.getElementById('inp-title').value = cfg.title || '';
  document.getElementById('inp-type').value = cfg.type || '';
  document.getElementById('inp-icon').value = cfg.icon || '';
  const color = cfg.color || '#4f46e5';
  document.getElementById('inp-color').value = color;
  document.getElementById('inp-color-text').value = color;
  
  const dp = document.getElementById('data-points');
  dp.innerHTML = '';

  const gaugeTypes = ['gauge', 'progress', 'liquid', 'multiGauge', 'dashboard', 'thermometer'];
  document.getElementById('gauge-minmax').classList.toggle('hidden', !gaugeTypes.includes(cfg.type));
  document.getElementById('group-settings').classList.toggle('hidden', cfg.type !== 'groupCard');
  document.getElementById('table-form-section').classList.toggle('hidden', cfg.type !== 'table');
  document.getElementById('data-points-section').classList.toggle('hidden', cfg.type === 'table');

  if (cfg.type === 'table') {
    document.getElementById('table-header-colors-section').classList.remove('hidden');
    updateTableHeaderColors();
  } else {
    document.getElementById('table-header-colors-section').classList.add('hidden');
  }

  const isChartType = !['card', 'groupCard', 'table', 'input', 'button', 'toggle', 'slider', 'dropdown', 'terminal', 'iframe', 'image', 'html'].includes(cfg.type);
  document.getElementById('echarts-form-section').classList.toggle('hidden', !isChartType);
  
  document.getElementById('widget-visibility-section').classList.remove('hidden');
  updateVisibilityOptions(cfg);

  if (isChartType) {
    const formContent = document.getElementById('echarts-form-content');
    formContent.innerHTML = generateEChartsForm(cfg);
  }

  if (cfg.type === 'groupCard') {
    document.getElementById('group-count').value = cfg.groupCount || (cfg.groupItems ? cfg.groupItems.length : 2);
    document.getElementById('group-items').value = (cfg.groupItems || []).map(it => `${it.label}:${it.value}`).join("\n");
  }

  if (cfg.type === 'table') {
    document.getElementById('table-columns-count').value = cfg.tableColumns || 3;
    document.getElementById('table-rows-count').value = cfg.tableRows || 3;
    setTimeout(() => { updateTableForm(); }, 50);
  } else {
    const n = Math.max((cfg.xData||[]).length, (cfg.yData||[]).length, 1);
    for (let i = 0; i < n; i++) {
      const lab = (cfg.xData && cfg.xData[i]) || '';
      const val = (cfg.yData && cfg.yData[i] !== undefined) ? cfg.yData[i] : '';
      const row = document.createElement('div');
      row.className = 'point-row';
      const inL = document.createElement('input');
      inL.value = lab;
      inL.placeholder = 'label';
      const inV = document.createElement('input');
      inV.value = val;
      inV.placeholder = 'value';
      const del = document.createElement('button');
      del.className = 'btn btn-ghost';
      del.textContent = 'Remove';
      del.onclick = () => row.remove();
      row.appendChild(inL);
      row.appendChild(inV);
      row.appendChild(del);
      dp.appendChild(row);
    }
  }

  document.getElementById('inp-min').value = cfg.min ?? '';
  document.getElementById('inp-max').value = cfg.max ?? '';
}

function updateTableHeaderColors() {
  const colorsContainer = document.getElementById('table-header-colors');
  colorsContainer.innerHTML = '';
  
  const cfg = widgetRegistry.get(modalActiveId);
  if (!cfg || cfg.type !== 'table') return;
  
  const colCount = cfg.tableColumns || 3;
  const headerColors = cfg.tableHeaderColors || {};
  
  for (let i = 0; i < colCount; i++) {
    const colorOption = document.createElement('div');
    colorOption.className = 'header-color-option';
    
    const currentColor = headerColors[i] || getDefaultHeaderColor(i);
    
    colorOption.innerHTML = `
      <div class="color-preview" style="background-color: ${currentColor}"></div>
      <span>Header ${i+1}</span>
      <input type="color" value="${currentColor}" 
             onchange="updateHeaderColor(${i}, this.value)" 
             style="width:24px;height:24px;padding:0;border:none;background:transparent">
    `;
    
    colorsContainer.appendChild(colorOption);
  }
}

function getDefaultHeaderColor(index) {
  const defaultColors = ['#4f46e5', '#10b981', '#ef4444', '#f59e0b', '#8b5cf6'];
  return defaultColors[index % defaultColors.length];
}

function updateHeaderColor(headerIndex, color) {
  const cfg = widgetRegistry.get(modalActiveId);
  if (!cfg) return;
  
  if (!cfg.tableHeaderColors) {
    cfg.tableHeaderColors = {};
  }
  
  cfg.tableHeaderColors[headerIndex] = color;
  markUnsaved();
}

function updateVisibilityOptions(cfg) {
  const visibilityOptions = document.getElementById('visibility-options');
  visibilityOptions.innerHTML = '';
  
  if (views.length === 0) {
    visibilityOptions.innerHTML = '<div style="text-align:center;padding:10px;color:#6b7280">No views created yet</div>';
    return;
  }
  
  views.forEach(view => {
    const isChecked = cfg.viewIds && cfg.viewIds.includes(view.id);
    const iconClass = getIconClass(view.icon) || 'ph ph-eye';
    
    const option = document.createElement('div');
    option.className = 'visibility-option';
    option.innerHTML = `
      <input type="checkbox" id="visibility-${view.id}" ${isChecked ? 'checked' : ''}>
      <div class="visibility-option-icon"><i class="${iconClass}"></i></div>
      <span class="visibility-option-label">${escapeHtml(view.name)}</span>
    `;
    
    visibilityOptions.appendChild(option);
  });
}

function generateEChartsForm(cfg) {
  const formId = modalActiveId;
  let html = '';
  
  switch(cfg.type) {
    case 'basicLine':
    case 'smoothLine':
    case 'stepLine':
    case 'basicArea':
    case 'stackedLine':
    case 'stackedArea':
    case 'multiAxis':
    case 'confidenceBand':
    case 'largeArea':
    case 'dynamicLine':
    case 'timeseries':
      html = `
        <div class="echarts-form-row">
          <label class="echarts-form-label">Chart Type</label>
          <select class="echarts-form-select" id="${formId}_chartType">
            <option value="line">Line Chart</option>
            <option value="bar">Bar Chart</option>
            <option value="area">Area Chart</option>
            <option value="scatter">Scatter Plot</option>
          </select>
        </div>
        <div class="echarts-form-row">
          <label class="echarts-form-label">Line Style</label>
          <select class="echarts-form-select" id="${formId}_lineStyle">
            <option value="solid">Solid</option>
            <option value="dashed">Dashed</option>
            <option value="dotted">Dotted</option>
            <option value="none">None</option>
          </select>
        </div>
        <div class="echarts-form-row">
          <label class="echarts-form-label">Smooth Line</label>
          <input type="checkbox" class="echarts-form-checkbox" id="${formId}_smooth" ${cfg.type === 'smoothLine' ? 'checked' : ''}>
        </div>
        <div class="echarts-form-row">
          <label class="echarts-form-label">Show Grid</label>
          <input type="checkbox" class="echarts-form-checkbox" id="${formId}_showGrid" checked>
        </div>
        <div class="echarts-form-row">
          <label class="echarts-form-label">Show Legend</label>
          <input type="checkbox" class="echarts-form-checkbox" id="${formId}_showLegend" ${cfg.type !== 'basicLine' ? 'checked' : ''}>
        </div>
        <div class="echarts-form-row">
          <label class="echarts-form-label">Animation</label>
          <input type="checkbox" class="echarts-form-checkbox" id="${formId}_animation" checked>
        </div>
      `;
      break;
      
    case 'bar':
    case 'horizontalBar':
    case 'stackedBar':
    case 'sortBar':
    case 'floatingBar':
    case 'polarBar':
    case 'radialBar':
    case 'simpleEncode':
      html = `
        <div class="echarts-form-row">
          <label class="echarts-form-label">Bar Width</label>
          <input type="range" class="echarts-form-input" id="${formId}_barWidth" min="10" max="80" value="40">
        </div>
        <div class="echarts-form-row">
          <label class="echarts-form-label">Bar Gap</label>
          <input type="range" class="echarts-form-input" id="${formId}_barGap" min="0" max="100" value="30">
        </div>
        <div class="echarts-form-row">
          <label class="echarts-form-label">Stack Bars</label>
          <input type="checkbox" class="echarts-form-checkbox" id="${formId}_stackBars" ${cfg.type === 'stackedBar' ? 'checked' : ''}>
        </div>
        <div class="echarts-form-row">
          <label class="echarts-form-label">Show Value Labels</label>
          <input type="checkbox" class="echarts-form-checkbox" id="${formId}_showLabels" checked>
        </div>
        <div class="echarts-form-row">
          <label class="echarts-form-label">Horizontal Bars</label>
          <input type="checkbox" class="echarts-form-checkbox" id="${formId}_horizontal" ${cfg.type === 'horizontalBar' ? 'checked' : ''}>
        </div>
      `;
      break;
      
    case 'pie':
    case 'donut':
      html = `
        <div class="echarts-form-row">
          <label class="echarts-form-label">Chart Type</label>
          <select class="echarts-form-select" id="${formId}_pieType">
            <option value="pie" ${cfg.type === 'pie' ? 'selected' : ''}>Pie Chart</option>
            <option value="donut" ${cfg.type === 'donut' ? 'selected' : ''}>Donut Chart</option>
          </select>
        </div>
        <div class="echarts-form-row">
          <label class="echarts-form-label">Radius Range</label>
          <div style="display:flex;gap:8px">
            <input type="range" class="echarts-form-input" id="${formId}_innerRadius" min="0" max="80" value="${cfg.type === 'donut' ? '40' : '0'}">
            <input type="range" class="echarts-form-input" id="${formId}_outerRadius" min="30" max="100" value="70">
          </div>
        </div>
        <div class="echarts-form-row">
          <label class="echarts-form-label">Show Labels</label>
          <input type="checkbox" class="echarts-form-checkbox" id="${formId}_showLabels" checked>
        </div>
        <div class="echarts-form-row">
          <label class="echarts-form-label">Show Percent</label>
          <input type="checkbox" class="echarts-form-checkbox" id="${formId}_showPercent" checked>
        </div>
      `;
      break;
      
    case 'gauge':
    case 'progress':
    case 'liquid':
    case 'multiGauge':
    case 'dashboard':
    case 'thermometer':
      html = `
        <div class="echarts-form-row">
          <label class="echarts-form-label">Gauge Type</label>
          <select class="echarts-form-select" id="${formId}_gaugeType">
            <option value="standard">Standard</option>
            <option value="progress" ${cfg.type === 'progress' ? 'selected' : ''}>Progress</option>
            <option value="dashboard" ${cfg.type === 'dashboard' ? 'selected' : ''}>Dashboard</option>
            <option value="thermometer" ${cfg.type === 'thermometer' ? 'selected' : ''}>Thermometer</option>
          </select>
        </div>
        <div class="echarts-form-row">
          <label class="echarts-form-label">Show Value</label>
          <input type="checkbox" class="echarts-form-checkbox" id="${formId}_showValue" checked>
        </div>
      `;
      break;
      
    default:
      html = `
        <div class="echarts-form-row">
          <label class="echarts-form-label">Chart Style</label>
          <select class="echarts-form-select" id="${formId}_chartStyle">
            <option value="default">Default</option>
            <option value="minimal">Minimal</option>
            <option value="detailed">Detailed</option>
          </select>
        </div>
      `;
  }
  
  return html;
}

function updateTableForm() {
  if (!modalActiveId) return;
  const cfg = widgetRegistry.get(modalActiveId);
  if (!cfg || cfg.type !== 'table') return;
  
  const colCount = parseInt(document.getElementById('table-columns-count').value) || 3;
  const rowCount = parseInt(document.getElementById('table-rows-count').value) || 3;
  
  document.getElementById('table-dimensions').textContent = `${colCount} columns × ${rowCount} rows`;
  
  const headersDiv = document.getElementById('table-headers');
  headersDiv.innerHTML = '';
  
  for (let col = 0; col < colCount; col++) {
    const headerDiv = document.createElement('div');
    headerDiv.style.flex = '1';
    headerDiv.innerHTML = `
      <div class="form-label small" style="text-align:center">Col ${col+1}</div>
      <input type="text" class="form-input" id="table-header-${col}" 
             placeholder="Header ${col+1}" value="${cfg.xData && cfg.xData[col] ? escapeHtml(cfg.xData[col]) : `Column ${col+1}`}"
             style="text-align:center;font-weight:600">
    `;
    headersDiv.appendChild(headerDiv);
  }
  
  const rowNumbersDiv = document.getElementById('table-row-numbers');
  rowNumbersDiv.innerHTML = '';
  
  for (let row = 0; row < rowCount; row++) {
    const rowDiv = document.createElement('div');
    rowDiv.style.height = '40px';
    rowDiv.style.display = 'flex';
    rowDiv.style.alignItems = 'center';
    rowDiv.style.justifyContent = 'center';
    rowDiv.style.borderBottom = '1px solid #e2e8f0';
    rowDiv.style.fontSize = '12px';
    rowDiv.style.color = '#64748b';
    rowDiv.style.fontWeight = '600';
    rowDiv.style.backgroundColor = row % 2 === 0 ? '#f8fafc' : '#ffffff';
    rowDiv.textContent = `Row ${row+1}`;
    rowNumbersDiv.appendChild(rowDiv);
  }
  
  const dataGrid = document.getElementById('table-data-table');
  dataGrid.innerHTML = '';
  
  let tableData = [];
  if (cfg.yData && Array.isArray(cfg.yData[0]) && Array.isArray(cfg.yData[0])) {
    tableData = cfg.yData;
  } else if (cfg.yData && cfg.yData.length > 0) {
    const oldCols = cfg.tableColumns || 3;
    for (let r = 0; r < Math.ceil(cfg.yData.length / oldCols); r++) {
      const row = [];
      for (let c = 0; c < oldCols; c++) {
        const idx = r * oldCols + c;
        row.push(cfg.yData[idx] || '');
      }
      tableData.push(row);
    }
  }
  
  while (tableData.length < rowCount) {
    tableData.push(Array(colCount).fill(''));
  }
  tableData = tableData.map(row => {
    while (row.length < colCount) row.push('');
    return row.slice(0, colCount);
  });
  
  const table = document.createElement('table');
  table.style.width = '100%';
  table.style.borderCollapse = 'collapse';
  table.style.tableLayout = 'fixed';
  
  for (let row = 0; row < rowCount; row++) {
    const tr = document.createElement('tr');
    tr.style.backgroundColor = row % 2 === 0 ? '#f8fafc' : '#ffffff';
    
    for (let col = 0; col < colCount; col++) {
      const td = document.createElement('td');
      td.style.padding = '0';
      td.style.border = '1px solid #e2e8f0';
      td.style.position = 'relative';
      
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'form-input';
      input.style.width = '100%';
      input.style.height = '40px';
      input.style.boxSizing = 'border-box';
      input.style.border = 'none';
      input.style.borderRadius = '0';
      input.style.padding = '8px';
      input.id = `table-cell-${row}-${col}`;
      input.dataset.row = row;
      input.dataset.col = col;
      input.value = tableData[row] && tableData[row][col] !== undefined ? tableData[row][col] : '';
      
      input.addEventListener('click', function(e) {
        if (e.shiftKey) {
          document.querySelectorAll('.table-cell-selected').forEach(el => el.classList.remove('table-cell-selected'));
          this.classList.add('table-cell-selected');
        } else {
          this.classList.toggle('table-cell-selected');
        }
      });
      
      input.addEventListener('focus', function() {
        this.style.backgroundColor = '#f0f9ff';
        this.style.border = '2px solid var(--accent)';
      });
      
      input.addEventListener('blur', function() {
        this.style.backgroundColor = '';
        this.style.border = 'none';
      });
      
      input.addEventListener('keydown', function(e) {
        const currentRow = parseInt(this.dataset.row);
        const currentCol = parseInt(this.dataset.col);
        let nextInput = null;
        
        switch(e.key) {
          case 'ArrowUp':
            if (currentRow > 0) nextInput = document.getElementById(`table-cell-${currentRow-1}-${currentCol}`);
            break;
          case 'ArrowDown':
            if (currentRow < rowCount - 1) nextInput = document.getElementById(`table-cell-${currentRow+1}-${currentCol}`);
            break;
          case 'ArrowLeft':
            if (currentCol > 0) nextInput = document.getElementById(`table-cell-${currentRow}-${currentCol-1}`);
            break;
          case 'ArrowRight':
            if (currentCol < colCount - 1) nextInput = document.getElementById(`table-cell-${currentRow}-${currentCol+1}`);
            break;
          case 'Tab':
            e.preventDefault();
            if (e.shiftKey) {
              if (currentCol > 0) {
                nextInput = document.getElementById(`table-cell-${currentRow}-${currentCol-1}`);
              } else if (currentRow > 0) {
                nextInput = document.getElementById(`table-cell-${currentRow-1}-${colCount-1}`);
              }
            } else {
              if (currentCol < colCount - 1) {
                nextInput = document.getElementById(`table-cell-${currentRow}-${currentCol+1}`);
              } else if (currentRow < rowCount - 1) {
                nextInput = document.getElementById(`table-cell-${currentRow+1}-0`);
              }
            }
            break;
          case 'Enter':
            e.preventDefault();
            if (currentRow < rowCount - 1) nextInput = document.getElementById(`table-cell-${currentRow+1}-${currentCol}`);
            break;
        }
        
        if (nextInput) {
          nextInput.focus();
          nextInput.select();
        }
      });
      
      td.appendChild(input);
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  
  dataGrid.appendChild(table);
}

function addTableColumn() {
  const colCount = parseInt(document.getElementById('table-columns-count').value) || 3;
  document.getElementById('table-columns-count').value = colCount + 1;
  updateTableForm();
  updateTableHeaderColors();
}

function removeTableColumn() {
  const colCount = parseInt(document.getElementById('table-columns-count').value) || 3;
  if (colCount > 1) {
    document.getElementById('table-columns-count').value = colCount - 1;
    updateTableForm();
    updateTableHeaderColors();
  }
}

function addTableRow() {
  const rowCount = parseInt(document.getElementById('table-rows-count').value) || 3;
  document.getElementById('table-rows-count').value = rowCount + 1;
  updateTableForm();
}

function removeTableRow() {
  const rowCount = parseInt(document.getElementById('table-rows-count').value) || 3;
  if (rowCount > 1) {
    document.getElementById('table-rows-count').value = rowCount - 1;
    updateTableForm();
  }
}

function fillSelectedCells() {
  const value = document.getElementById('quick-cell-value').value;
  const selectedCells = document.querySelectorAll('.table-cell-selected');
  selectedCells.forEach(cell => { cell.value = value; });
  if (selectedCells.length > 0) showSavedToast(`Filled ${selectedCells.length} cells`);
}

function clearTable() {
  if (confirm('Clear all table data?')) {
    const inputs = document.querySelectorAll('#table-data-table input');
    inputs.forEach(input => { input.value = ''; });
    showSavedToast('Table cleared');
  }
}

function addTableColumnBulk() {
  const colCount = parseInt(document.getElementById('table-columns-count').value) || 3;
  document.getElementById('table-columns-count').value = colCount + 5;
  updateTableForm();
  updateTableHeaderColors();
}

function addTableRowBulk() {
  const rowCount = parseInt(document.getElementById('table-rows-count').value) || 3;
  document.getElementById('table-rows-count').value = rowCount + 10;
  updateTableForm();
}

function exportTableCSV() {
  const colCount = parseInt(document.getElementById('table-columns-count').value) || 3;
  const rowCount = parseInt(document.getElementById('table-rows-count').value) || 3;
  
  const headers = [];
  for (let col = 0; col < colCount; col++) {
    const headerInput = document.getElementById(`table-header-${col}`);
    headers.push(`"${(headerInput ? headerInput.value : `Column ${col+1}`).replace(/"/g, '""')}"`);
  }
  
  const csvRows = [headers.join(',')];
  for (let row = 0; row < rowCount; row++) {
    const rowData = [];
    for (let col = 0; col < colCount; col++) {
      const cellInput = document.getElementById(`table-cell-${row}-${col}`);
      rowData.push(`"${(cellInput ? cellInput.value : '').replace(/"/g, '""')}"`);
    }
    csvRows.push(rowData.join(','));
  }
  
  const csvContent = csvRows.join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'table_export.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importTableFromCSV() {
  const csvText = document.getElementById('table-csv-input').value.trim();
  if (!csvText) return;
  
  const rows = csvText.split('\n').map(row => row.trim()).filter(row => row);
  if (rows.length === 0) return;
  
  const data = rows.map(row => {
    if (row.includes(',')) {
      return row.split(',').map(cell => cell.trim().replace(/^"|"$/g, ''));
    }
    return [row];
  });
  
  const headers = data[0] || [];
  const tableData = data.slice(1);
  
  document.getElementById('table-columns-count').value = headers.length;
  document.getElementById('table-rows-count').value = tableData.length;
  
  const cfg = widgetRegistry.get(modalActiveId);
  if (cfg) {
    cfg.xData = headers;
    cfg.yData = tableData;
    cfg.tableColumns = headers.length;
    cfg.tableRows = tableData.length;
    updateTableForm();
    updateTableHeaderColors();
    showSavedToast(`Imported ${headers.length} columns × ${tableData.length} rows`);
  }
}

function importTableFromDataPoints() {
  const dp = document.getElementById('data-points');
  const rows = [...dp.querySelectorAll('.point-row')];
  if (rows.length === 0) return;
  
  const labels = [];
  const values = [];
  rows.forEach(r => {
    const inputs = r.querySelectorAll('input');
    labels.push(inputs[0].value.trim() || '');
    values.push(inputs[1].value.trim() || '');
  });
  
  const headers = ['Items', 'Values'];
  const tableData = labels.map((label, i) => [label, values[i] || '']);
  
  document.getElementById('table-columns-count').value = headers.length;
  document.getElementById('table-rows-count').value = tableData.length;
  
  const cfg = widgetRegistry.get(modalActiveId);
  if (cfg) {
    cfg.xData = headers;
    cfg.yData = tableData;
    cfg.tableColumns = headers.length;
    cfg.tableRows = tableData.length;
    updateTableForm();
    updateTableHeaderColors();
    showSavedToast('Converted data points to table');
  }
}

function closeModal() {
  document.getElementById('settings-modal').classList.add('hidden');
  modalActiveId = null;
}

function resetColor() {
  document.getElementById('inp-color').value = '#4f46e5';
  document.getElementById('inp-color-text').value = '#4f46e5';
}

function addPointFromInputs() {
  const lab = document.getElementById('new-label').value.trim();
  const val = document.getElementById('new-value').value.trim();
  if (!lab && !val) return;
  const dp = document.getElementById('data-points');
  const row = document.createElement('div');
  row.className = 'point-row';
  const inL = document.createElement('input');
  inL.value = lab;
  inL.placeholder = 'label';
  const inV = document.createElement('input');
  inV.value = val;
  inV.placeholder = 'value';
  const del = document.createElement('button');
  del.className = 'btn btn-ghost';
  del.textContent = 'Remove';
  del.onclick = () => row.remove();
  row.appendChild(inL);
  row.appendChild(inV);
  row.appendChild(del);
  dp.appendChild(row);
  document.getElementById('new-label').value = '';
  document.getElementById('new-value').value = '';
}

function resetModal() {
  if (modalActiveId) openModal(modalActiveId);
}

function saveModal() {
  if (!modalActiveId) return closeModal();
  const cfg = widgetRegistry.get(modalActiveId);
  if (!cfg) return closeModal();

  cfg.title = document.getElementById('inp-title').value || cfg.type || 'Widget';
  cfg.icon = document.getElementById('inp-icon').value || '';
  cfg.color = document.getElementById('inp-color').value || '#4f46e5';

  const selectedViewIds = [];
  views.forEach(view => {
    const checkbox = document.getElementById(`visibility-${view.id}`);
    if (checkbox && checkbox.checked) {
      selectedViewIds.push(view.id);
    }
  });

  cfg.viewIds = selectedViewIds;
  
  views.forEach(view => {
    if (selectedViewIds.includes(view.id)) {
      if (!view.widgetIds) view.widgetIds = [];
      if (!view.widgetIds.includes(cfg.id)) {
        view.widgetIds.push(cfg.id);
      }
    } else {
      if (view.widgetIds) {
        view.widgetIds = view.widgetIds.filter(id => id !== cfg.id);
      }
    }
  });

  saveDashboardViews(currentDashId, views);

  if (cfg.type === 'table') {
    const colCount = parseInt(document.getElementById('table-columns-count').value) || 3;
    const rowCount = parseInt(document.getElementById('table-rows-count').value) || 3;
    
    const headers = [];
    for (let col = 0; col < colCount; col++) {
      const headerInput = document.getElementById(`table-header-${col}`);
      headers.push(headerInput ? headerInput.value.trim() || `Column ${col+1}` : `Column ${col+1}`);
    }
    
    const tableData = [];
    for (let row = 0; row < rowCount; row++) {
      const rowData = [];
      for (let col = 0; col < colCount; col++) {
        const cellInput = document.getElementById(`table-cell-${row}-${col}`);
        rowData.push(cellInput ? cellInput.value.trim() : '');
      }
      tableData.push(rowData);
    }
    
    cfg.xData = headers;
    cfg.yData = tableData;
    cfg.tableColumns = colCount;
    cfg.tableRows = rowCount;
  } else {
    const dp = document.getElementById('data-points');
    const rows = [...dp.querySelectorAll('.point-row')];
    const xData = [], yData = [];
    rows.forEach(r => {
      const inputs = r.querySelectorAll('input');
      const lab = inputs[0].value.trim();
      const valRaw = inputs[1].value.trim();
      const v = (valRaw === '') ? 0 : (isNaN(Number(valRaw)) ? valRaw : Number(valRaw));
      xData.push(lab || '');
      yData.push(v);
    });
    
    if (xData.length > 0) cfg.xData = xData;
    if (yData.length > 0) cfg.yData = yData;

    // Handle group card specific data
    if (cfg.type === 'groupCard') {
      const count = parseInt(document.getElementById('group-count').value) || 2;
      cfg.groupCount = count;
      const lines = (document.getElementById('group-items').value || '').split('\n').map(s => s.trim()).filter(Boolean);
      cfg.groupItems = lines.map(l => {
        const [label, val] = l.split(':').map(x => x.trim());
        return { label: label || 'Item', value: isNaN(Number(val)) ? val || 0 : Number(val) };
      }).slice(0, count);
    }

    const minV = Number(document.getElementById('inp-min').value);
    const maxV = Number(document.getElementById('inp-max').value);
    if (!isNaN(minV)) cfg.min = minV;
    if (!isNaN(maxV)) cfg.max = maxV;
  }

  widgetRegistry.set(cfg.id, cfg);

  setTimeout(() => initWidget(cfg.id), 50);
  
  // Mark as unsaved
  markUnsaved();
  
  document.getElementById('btn-save').classList.toggle('hidden', !isEditMode);
  
  closeModal();
  
  if (currentViewId) {
    const view = views.find(v => v.id === currentViewId);
    if (view) {
      setTimeout(() => applyStrictViewFiltering(view), 50);
    }
  }
}

function enterEditMode() {
  if (isEditMode) return;
  isEditMode = true;
  
  // Show all widgets in edit mode
  const widgetItems = Array.from(grid.engine.nodes);
  widgetItems.forEach(node => {
    node.el.style.display = '';
    node.el.style.visibility = 'visible';
    node.el.style.opacity = '1';
    node.el.style.pointerEvents = 'auto';
  });
  
  document.getElementById('palette').classList.remove('hidden');
  document.getElementById('sidebar-nav').classList.add('hidden');
  document.getElementById('btn-edit').classList.add('hidden');
  document.getElementById('btn-save').classList.remove('hidden');
  document.getElementById('btn-cancel').classList.remove('hidden');
  grid.enableMove(true);
  grid.enableResize(true);
  editBackup = snapshotCurrentDashboard();
}

function cancelEdit() {
  if (!editBackup) {
    exitEditMode();
    return;
  }
  
  widgetRegistry.forEach((cfg, id) => {
    if (cfg._timer) clearInterval(cfg._timer);
    if (cfg._ro) try { cfg._ro.disconnect(); } catch(e) {}
    if (cfg.instance) try { cfg.instance.dispose(); } catch(e) {}
  });
  
  grid.removeAll();
  widgetRegistry.clear();
  
  const items = editBackup.data || [];
  items.forEach(w => {
    const el = makeWidgetElement(w);
    const size = getDefaultSize(w.type, w);
    grid.addWidget(el, { w: w.w || size.w, h: w.h || size.h, x: w.x || 0, y: w.y || 0 });
    widgetRegistry.set(w.id, { 
      ...w, 
      instance: null, 
      viewIds: w.viewIds || [],
      tableHeaderColors: w.tableHeaderColors || {}
    });
  });
  
  // Reinitialize widgets
  setTimeout(() => { 
    widgetRegistry.forEach((cfg, id) => initWidget(id)); 
    
    // Apply view filtering
    if (currentViewId) {
      const view = views.find(v => v.id === currentViewId);
      if (view) {
        setTimeout(() => applyStrictViewFiltering(view), 100);
      }
    }
  }, 100);
  
  exitEditMode();
  editBackup = null;
  performSave(false);
}

function exitEditMode() {
  isEditMode = false;
  
  document.getElementById('palette').classList.add('hidden');
  document.getElementById('sidebar-nav').classList.remove('hidden');
  document.getElementById('btn-edit').classList.remove('hidden');
  document.getElementById('btn-save').classList.add('hidden');
  document.getElementById('btn-cancel').classList.add('hidden');
  grid.enableMove(false);
  grid.enableResize(false);
  
  if (currentViewId) {
    const view = views.find(v => v.id === currentViewId);
    if (view) {
      setTimeout(() => applyStrictViewFiltering(view), 50);
    }
  }
}

function snapshotCurrentDashboard() {
  if (!currentDashId) return null;
  const data = [];
  grid.engine.nodes.forEach(node => {
    const content = node.el.querySelector('.grid-stack-item-content');
    if (!content) return;
    const id = content.getAttribute('gs-id');
    const cfg = widgetRegistry.get(id);
    if (cfg) {
      const widgetData = {
        id: cfg.id,
        type: cfg.type,
        title: cfg.title,
        icon: cfg.icon,
        color: cfg.color,
        xData: cfg.xData || [],
        yData: cfg.yData || [],
        min: cfg.min,
        max: cfg.max,
        groupCount: cfg.groupCount,
        groupItems: cfg.groupItems,
        tableColumns: cfg.tableColumns,
        tableRows: cfg.tableRows,
        tableHeaderColors: cfg.tableHeaderColors || {},
        viewIds: cfg.viewIds || [],  
        x: node.x,
        y: node.y,
        w: node.w,
        h: node.h
      };
      data.push(widgetData);
    }
  });
  return { id: currentDashId, name: document.getElementById('workspace-title').innerText, data };
}

function saveCurrentDashboard() {
  performSave(false);
  exitEditMode();
  showSavedToast('Saved Successfully');
}

function startEditFromList(e, id) {
  e.stopPropagation();
  openWorkspace(id);
  setTimeout(() => enterEditMode(), 200);
}

function escapeHtml(s) {
  if (!s) return '';
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

let toastTimer = null;
function showSavedToast(text = 'Saved') {
  const t = document.getElementById('toast');
  t.textContent = text + ' ✔';
  t.style.display = 'block';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.display = 'none'; }, 1400);
}

function exportCurrentDashboard() {
  if (!currentDashId) return alert('No dashboard open');
  const list = readDashboards();
  const dash = list.find(d => d.id === currentDashId);
  if (!dash) return alert('Missing dashboard');
  exportDashboardFromList(currentDashId);
}

function openHistoryModal() {
  if (!currentDashId) return;
  const list = readDashboards();
  const dash = list.find(d => d.id === currentDashId);
  if (!dash) return alert('Missing dashboard');
  const container = document.getElementById('history-list');
  container.innerHTML = '';
  const versions = dash.versions ? dash.versions.slice().reverse() : [];
  if (versions.length === 0) {
    container.innerHTML = '<div class="small">No history snapshots available.</div>';
  } else {
    versions.forEach((v, i) => {
      const div = document.createElement('div');
      div.className = 'history-item';
      const left = document.createElement('div');
      left.innerHTML = `<div style="font-weight:600">${new Date(v.timestamp).toLocaleString()}</div><div class="small">Snapshot</div>`;
      const right = document.createElement('div');
      const btnRestore = document.createElement('button');
      btnRestore.className = 'btn btn-primary';
      btnRestore.textContent = 'Restore';
      btnRestore.onclick = () => {
        if (!confirm('Restore this snapshot? This will replace current layout.')) return;
        restoreSnapshot(v);
        closeHistoryModal();
      };
      right.appendChild(btnRestore);
      div.appendChild(left);
      div.appendChild(right);
      container.appendChild(div);
    });
  }
  document.getElementById('history-modal').classList.remove('hidden');
}

function closeHistoryModal() {
  document.getElementById('history-modal').classList.add('hidden');
}

function restoreSnapshot(snapshot) {
  if (!snapshot || !snapshot.data) return;
  
  widgetRegistry.forEach((cfg, id) => {
    if (cfg._timer) clearInterval(cfg._timer);
    if (cfg._ro) try { cfg._ro.disconnect(); } catch(e) {}
    if (cfg.instance) try { cfg.instance.dispose(); } catch(e) {}
  });
  
  grid.removeAll();
  widgetRegistry.clear();
  
  const items = snapshot.data;
  items.forEach(w => {
    const el = makeWidgetElement(w);
    const size = getDefaultSize(w.type, w);
    grid.addWidget(el, { w: w.w || size.w, h: w.h || size.h, x: w.x || 0, y: w.y || 0 });
    widgetRegistry.set(w.id, { 
      ...w, 
      instance: null, 
      viewIds: w.viewIds || [],
      tableHeaderColors: w.tableHeaderColors || {}
    });
  });
  
  // Reinitialize widgets
  setTimeout(() => { 
    widgetRegistry.forEach((cfg, id) => initWidget(id)); 
    
    // Apply view filtering
    if (currentViewId) {
      const view = views.find(v => v.id === currentViewId);
      if (view) {
        setTimeout(() => applyStrictViewFiltering(view), 150);
      }
    }
  }, 120);
  
  performSave(false);
}

function openCreateViewModal() {
  document.getElementById('create-view-modal').classList.remove('hidden');
}

function closeCreateViewModal() {
  document.getElementById('create-view-modal').classList.add('hidden');
}

function createView() {
  const name = document.getElementById('view-name').value.trim();
  const icon = document.getElementById('view-icon').value;
  if (!name) {
    alert('Please enter a name for the view');
    return;
  }
  
  const newView = {
    id: 'view_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
    name: name,
    icon: icon,
    widgetIds: [],
    order: views.length
  };
  
  views.push(newView);
  saveDashboardViews(currentDashId, views);
  updateSidebarNavigation();
  closeCreateViewModal();
  activateView(newView.id);
  showSavedToast(`View "${name}" created`);
}

function openManageViewsModal() {
  const viewsList = document.getElementById('views-list');
  viewsList.innerHTML = '';
  
  views.forEach(view => {
    let widgetCountText = 'All widgets';
    if (view.widgetIds && view.widgetIds.length > 0) {
      widgetCountText = `${view.widgetIds.length} widget${view.widgetIds.length === 1 ? '' : 's'}`;
    }
    
    const viewItem = document.createElement('div');
    viewItem.className = 'view-item';
    if (view.id === currentViewId) {
      viewItem.classList.add('active');
    }
    
    const iconClass = getIconClass(view.icon) || 'ph ph-house';
    viewItem.innerHTML = `
      <div class="view-item-icon"><i class="${iconClass}"></i></div>
      <div class="view-item-details">
        <div class="view-item-name">${escapeHtml(view.name)}</div>
        <div class="view-item-stats">${widgetCountText}</div>
      </div>
      <div class="view-item-actions">
        <button class="btn btn-ghost" onclick="editView('${view.id}')" style="padding:4px 8px;font-size:12px">Edit</button>
        <button class="btn" onclick="deleteView('${view.id}')" style="padding:4px 8px;font-size:12px">Delete</button>
      </div>
    `;
    
    viewItem.onclick = (e) => {
      if (!e.target.closest('.view-item-actions')) {
        selectedViewForWidgetSelection = view;
        updateViewsListSelection();
      }
    };
    
    viewsList.appendChild(viewItem);
  });
  
  if (views.length > 0 && !selectedViewForWidgetSelection) {
    selectedViewForWidgetSelection = views[0];
  }
  
  updateViewsListSelection();
  document.getElementById('manage-views-modal').classList.remove('hidden');
}

function closeManageViewsModal() {
  document.getElementById('manage-views-modal').classList.add('hidden');
  selectedViewForWidgetSelection = null;
}

function updateViewsListSelection() {
  document.querySelectorAll('.view-item').forEach(item => {
    item.classList.remove('active');
  });
  
  if (selectedViewForWidgetSelection) {
    const selectedItem = document.querySelector(`.view-item[onclick*="${selectedViewForWidgetSelection.id}"]`);
    if (selectedItem) {
      selectedItem.classList.add('active');
    }
  }
}

function editView(viewId) {
  const view = views.find(v => v.id === viewId);
  if (!view) return;
  
  const newName = prompt('Enter new name for view:', view.name);
  if (!newName || newName.trim() === '') return;
  
  view.name = newName.trim();
  saveDashboardViews(currentDashId, views);
  updateSidebarNavigation();
  openManageViewsModal();
  showSavedToast(`View renamed to "${newName}"`);
}

function deleteView(viewId) {
  if (views.length <= 1) {
    alert('Cannot delete the last view. Dashboards must have at least one view.');
    return;
  }
  
  const view = views.find(v => v.id === viewId);
  if (!view) return;
  
  if (!confirm(`Are you sure you want to delete the view "${view.name}"?`)) {
    return;
  }
  
  views = views.filter(v => v.id !== viewId);
  
  views.forEach((v, index) => { v.order = index; });
  
  widgetRegistry.forEach((cfg, widgetId) => {
    if (cfg.viewIds && cfg.viewIds.includes(viewId)) {
      cfg.viewIds = cfg.viewIds.filter(id => id !== viewId);
    }
  });
  
  saveDashboardViews(currentDashId, views);
  
  if (currentViewId === viewId) {
    if (views.length > 0) {
      activateView(views[0].id);
    } else {
      currentViewId = null;
    }
  }
  
  updateSidebarNavigation();
  openManageViewsModal();
  showSavedToast(`View "${view.name}" deleted`);
}

function openWidgetSelectionForView() {
  if (!selectedViewForWidgetSelection) {
    alert('Please select a view first');
    return;
  }
  
  const view = selectedViewForWidgetSelection;
  document.getElementById('widget-selection-title').textContent = `Select Widgets for "${view.name}"`;
  const widgetsList = document.getElementById('widgets-list');
  widgetsList.innerHTML = '';
  
  const widgetItems = Array.from(grid.engine.nodes);
  if (widgetItems.length === 0) {
    widgetsList.innerHTML = '<div style="text-align:center;padding:20px;color:#6b7280">No widgets found</div>';
  } else {
    widgetItems.forEach(node => {
      const content = node.el.querySelector('.grid-stack-item-content');
      if (!content) return;
      
      const widgetId = content.getAttribute('gs-id');
      const cfg = widgetRegistry.get(widgetId);
      if (!cfg) return;
      
      const isSelected = cfg.viewIds && cfg.viewIds.includes(view.id);
      const widgetItem = document.createElement('div');
      widgetItem.className = 'widget-item';
      const iconClass = getIconClass(cfg.icon) || 'ph ph-cube';
      widgetItem.innerHTML = `
        <input type="checkbox" id="select-widget-${widgetId}" ${isSelected ? 'checked' : ''}>
        <div class="widget-item-icon"><i class="${iconClass}"></i></div>
        <div class="widget-item-details">
          <div class="widget-item-name">${escapeHtml(cfg.title || cfg.type)}</div>
          <div class="widget-item-type">${cfg.type}</div>
        </div>
      `;
      widgetsList.appendChild(widgetItem);
    });
  }
  
  document.getElementById('widget-selection-modal').classList.remove('hidden');
}

function closeWidgetSelectionModal() {
  document.getElementById('widget-selection-modal').classList.add('hidden');
}

function saveWidgetSelection() {
  if (!selectedViewForWidgetSelection) return;
  
  const view = selectedViewForWidgetSelection;
  const checkboxes = document.querySelectorAll('#widgets-list input[type="checkbox"]');
  
  // Update each widget's viewIds
  checkboxes.forEach(checkbox => {
    const widgetId = checkbox.id.replace('select-widget-', '');
    const cfg = widgetRegistry.get(widgetId);
    if (!cfg) return;
    
    if (checkbox.checked) {
      if (!cfg.viewIds) cfg.viewIds = [];
      if (!cfg.viewIds.includes(view.id)) {
        cfg.viewIds.push(view.id);
      }
      if (!view.widgetIds) view.widgetIds = [];
      if (!view.widgetIds.includes(widgetId)) {
        view.widgetIds.push(widgetId);
      }
    } else {
      if (cfg.viewIds) {
        cfg.viewIds = cfg.viewIds.filter(id => id !== view.id);
      }
      if (view.widgetIds) {
        view.widgetIds = view.widgetIds.filter(id => id !== widgetId);
      }
    }
  });
  
  saveDashboardViews(currentDashId, views);
  
  if (currentViewId === view.id) {
    applyStrictViewFiltering(view);
  }
  
  closeWidgetSelectionModal();
  openManageViewsModal();
  showSavedToast(`Widget selection saved for "${view.name}"`);
}

window.addEventListener('DOMContentLoaded', () => {
  refreshList();
  
  document.getElementById('inp-color').addEventListener('input', function() {
    document.getElementById('inp-color-text').value = this.value;
  });
  
  document.getElementById('inp-color-text').addEventListener('input', function() {
    if (this.value.match(/^#[0-9A-F]{6}$/i)) {
      document.getElementById('inp-color').value = this.value;
    }
  });
});