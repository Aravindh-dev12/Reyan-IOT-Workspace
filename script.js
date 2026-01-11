const STORAGE_KEY = 'scada_dashboards_v1';
const VIEWS_STORAGE_KEY = 'scada_views_v1';
const PANEL_ID_STORAGE_KEY = 'scada_panel_ids_v1';
const MAX_VERSIONS = 20;

// Global state
let currentDashId = null;
let isEditMode = false;
let hasUnsavedChanges = false;
let currentViewId = null;
let views = [];
let selectedViewForWidgetSelection = null;
const widgetRegistry = new Map();

const grid = GridStack.init({
  column: 12,
  cellHeight: 100,
  margin: 2,
  float: true,
  resizable: { handles: 'se', autoHide: true }
});

function saveData(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
    return true;
  } catch(e) {
    console.error('Save failed:', e);
    return false;
  }
}

function readData(key, defaultValue = []) {
  try {
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : defaultValue;
  } catch(e) {
    console.error('Read failed:', e);
    return defaultValue;
  }
}

function getPanelId(dashboardId) {
  const panelIds = readData(PANEL_ID_STORAGE_KEY, {});
  if (!panelIds[dashboardId]) {
    panelIds[dashboardId] = 'panel_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
    saveData(PANEL_ID_STORAGE_KEY, panelIds);
  }
  return panelIds[dashboardId];
}

function readDashboards() {
  return readData(STORAGE_KEY, []);
}

function writeDashboards(list) {
  saveData(STORAGE_KEY, list);
}

function getDashboardViews(dashboardId) {
  const viewsData = readData(VIEWS_STORAGE_KEY, {});
  return viewsData[dashboardId] || [];
}

function saveDashboardViews(dashboardId, dashboardViews) {
  const viewsData = readData(VIEWS_STORAGE_KEY, {});
  viewsData[dashboardId] = dashboardViews;
  saveData(VIEWS_STORAGE_KEY, viewsData);
}

function markUnsaved() {
  hasUnsavedChanges = true;
  document.getElementById('btn-save').classList.remove('hidden');
}

function performSave() {
  if (!currentDashId) return;

  const saveData = Array.from(document.querySelectorAll('.grid-stack-item-content'))
    .map(content => {
      const id = content.getAttribute('gs-id');
      const cfg = widgetRegistry.get(id);
      const parent = content.closest('.grid-stack-item');
      const node = parent ? grid.engine.nodes.find(n => n.el === parent) : null;
      
      if (!cfg) return null;
      
      const size = getDefaultSize(cfg.type, cfg);
      return {
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
      };
    })
    .filter(Boolean);

  const list = readDashboards();
  const idx = list.findIndex(d => d.id === currentDashId);
  if (idx === -1) return;

  const snapshot = { data: saveData, timestamp: new Date().toISOString() };
  list[idx].data = JSON.stringify(saveData);
  list[idx].updated_at = snapshot.timestamp;
  
  list[idx].versions = list[idx].versions || [];
  const lastHash = list[idx].versions.length > 0 ? 
    JSON.stringify(list[idx].versions[list[idx].versions.length - 1].data) : null;
  const currHash = JSON.stringify(saveData);
  
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

function refreshList() {
  const container = document.getElementById('dashboard-cards');
  const list = readDashboards();
  
  if (list.length === 0) {
    container.innerHTML = '<div style="grid-column:1/-1;padding:24px;color:var(--muted);text-align:center;">No dashboards. Click "Create New".</div>';
    return;
  }

  container.innerHTML = list.map(d => `
    <div class="card">
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
    </div>
  `).join('');
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
      if (!importData.dashboard || !importData.widgets) throw new Error('Invalid SCADAPro export format');

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
        gridConfig: { columns: 12, cellHeight: 100, margin: 4 }
      },
      widgets: widgetData.map(widget => ({
        id: widget.id,
        type: widget.type,
        title: widget.title,
        icon: widget.icon || '',
        color: widget.color || '#4f46e5',
        position: { x: widget.x || 0, y: widget.y || 0, w: widget.w || getDefaultSize(widget.type, widget).w, h: widget.h || getDefaultSize(widget.type, widget).h },
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
  
  widgetRegistry.forEach((cfg, id) => {
    if (cfg._timer) clearInterval(cfg._timer);
    if (cfg._ro) try { cfg._ro.disconnect(); } catch(e) {}
    if (cfg.instance) try { cfg.instance.dispose(); } catch(e) {}
  });
  widgetRegistry.clear();
  grid.removeAll();
  
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
      if (view) setTimeout(() => applyStrictViewFiltering(view), 100);
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
  container.innerHTML = views.map(view => {
    const iconClass = getIconClass(view.icon) || 'ph ph-house';
    return `
      <button class="sidebar-nav-item ${view.id === currentViewId ? 'active' : ''}" 
              id="view-btn-${view.id}" onclick="activateView('${view.id}')">
        <div class="ic"><i class="${iconClass}"></i></div>
        <span>${escapeHtml(view.name)}</span>
      </button>
    `;
  }).join('');
}

function isWidgetVisibleInView(widgetId, viewId) {
  if (!viewId || viewId.startsWith('view_all_')) return true;
  const cfg = widgetRegistry.get(widgetId);
  return cfg && cfg.viewIds && cfg.viewIds.includes(viewId);
}

function applyStrictViewFiltering(view) {
  if (!view) return;
  
  const widgetItems = Array.from(grid.engine.nodes);
  widgetItems.forEach(node => {
    const content = node.el.querySelector('.grid-stack-item-content');
    if (!content) return;
    
    const widgetId = content.getAttribute('gs-id');
    let shouldShow = isEditMode || view.id.startsWith('view_all_') || isWidgetVisibleInView(widgetId, view.id);
    
    node.el.style.display = shouldShow ? '' : 'none';
    node.el.style.visibility = shouldShow ? 'visible' : 'hidden';
    node.el.style.opacity = shouldShow ? '1' : '0';
    node.el.style.pointerEvents = shouldShow ? 'auto' : 'none';
    
    if (shouldShow) delete node.el.dataset.hiddenByView;
    else node.el.dataset.hiddenByView = 'true';
  });
  
  setTimeout(() => {
    try { grid.engine.updateNodeArray(); grid.engine.commit(); } catch(e) {}
  }, 10);
}

function activateView(viewId) {
  if (!currentDashId) return;
  
  const view = views.find(v => v.id === viewId);
  if (!view) return;
  
  currentViewId = viewId;
  document.querySelectorAll('.sidebar-nav-item').forEach(btn => btn.classList.remove('active'));
  const activeBtn = document.getElementById(`view-btn-${viewId}`);
  if (activeBtn) activeBtn.classList.add('active');
  
  applyStrictViewFiltering(view);
}

function getDefaultSize(type) {
  const sizes = {
    card: { w: 2, h: 2 },
    button: { w: 2, h: 2 },
    toggle: { w: 2, h: 2 },
    slider: { w: 2, h: 2 },
    dropdown: { w: 2, h: 2 },
    input: { w: 3, h: 2 },
    groupCard: { w: 6, h: 3 },
    table: { w: 6, h: 4 },
    terminal: { w: 6, h: 4 },
    iframe: { w: 6, h: 4 },
    image: { w: 6, h: 4 },
    html: { w: 6, h: 4 },
    timeseries: { w: 4, h: 4 },
    gauge: { w: 4, h: 4 },
    progress: { w: 4, h: 4 },
    liquid: { w: 4, h: 4 },
    pie: { w: 4, h: 4 },
    donut: { w: 4, h: 4 },
    radar: { w: 4, h: 4 },
    polar: { w: 4, h: 4 },
    heatmap: { w: 6, h: 4 },
    calendarHeat: { w: 6, h: 4 },
    scatter: { w: 6, h: 4 },
    bubble: { w: 6, h: 4 },
    scatterMatrix: { w: 6, h: 4 },
    scatterRegression: { w: 6, h: 4 },
    scatterClustering: { w: 6, h: 4 },
    funnel: { w: 6, h: 5 },
    map: { w: 6, h: 5 },
    largeArea: { w: 8, h: 5 }
  };
  return sizes[type] || { w: 6, h: 4 };
}

const widgetTemplates = {
  chart: (id) => `<div id="${id}_chart" class="chart"></div>`,
  table: (id) => `<div id="${id}_table" class="table-widget"></div>`,
  card: (id) => `<div id="${id}_card" class="enhanced-card"></div>`,
  groupCard: (id) => `<div id="${id}_card" class="card-widget"><div class="group-cards" id="${id}_group"></div></div>`,
  input: (id, cfg) => `<div id="${id}_comp" class="input-widget"><input id="${id}_input" class="form-input" placeholder="${escapeHtml(cfg.title || 'Enter...')}" style="width:90%"></div>`,
  button: (id, cfg) => `<div id="${id}_comp" class="btn-widget"><button id="${id}_button" class="btn btn-primary">${escapeHtml(cfg.title || 'Button')}</button></div>`,
  toggle: (id, cfg) => `<div id="${id}_comp" class="toggle-widget"><label style="display:inline-flex;align-items:center;gap:8px"><input id="${id}_toggle" type="checkbox"><span>${escapeHtml(cfg.title || 'Toggle')}</span></label></div>`,
  slider: (id) => `<div id="${id}_comp" class="slider-widget" style="padding:20px"><input id="${id}_slider" type="range" min="0" max="100" value="50" style="width:90%"></div>`,
  dropdown: (id) => `<div id="${id}_comp" class="dropdown-widget" style="padding:20px"><select id="${id}_dropdown" class="form-input"><option>Option 1</option><option>Option 2</option></select></div>`,
  terminal: (id) => `<div id="${id}_term" class="terminal-log">System ready...\n</div>`,
  iframe: (id) => `<div id="${id}_iframe" style="width:100%;height:100%;border:none"></div>`,
  image: (id) => `<div id="${id}_image" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#f8fafc"><div class="small">Image Placeholder</div></div>`,
  html: (id) => `<div id="${id}_html" style="width:100%;height:100%;padding:10px;background:#f8fafc"><div class="small">HTML Content Area</div></div>`
};

function makeWidgetElement(cfg) {
  const id = cfg.id || `w_${Date.now()}`;
  const template = widgetTemplates[cfg.type] || widgetTemplates.chart;
  const inner = template(id, cfg);
  const iconHtml = cfg.icon ? `<i class="${getIconClass(cfg.icon)}" style="margin-right:6px;font-size:16px;color:${cfg.color || '#4f46e5'}"></i>` : '';
  
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <div class="grid-stack-item-content ${['card','button','toggle','input','slider','dropdown'].includes(cfg.type) ? 'small' : ''}" 
         gs-id="${id}" data-gs-id="${id}">
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
    'ph-grid-four': 'ph ph-grid-four',
    'ph-trend-up': 'ph ph-trend-up',
    'ph-circles-three': 'ph ph-circles-three',
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

const widgetDefaults = {
  card: { icon: 'ph-activity', color: '#4f46e5', yData: [42] },
  groupCard: { icon: 'ph-cube', color: '#4f46e5', groupCount: 2, groupItems: [{label: 'A', value: 12}, {label: 'B', value: 34}] },
  table: { icon: 'ph-table', color: '#4f46e5', xData: ['Name','Value','Status'], 
          yData: [['Item1','42','Active'],['Item2','67','Warning'],['Item3','23','Inactive']], tableColumns: 3, tableRows: 3,
          tableHeaderColors: { 0: '#4f46e5', 1: '#10b981', 2: '#ef4444' } },
  gauge: { icon: 'ph-gauge', color: '#4f46e5', yData: [65], min: 0, max: 100 },
  progress: { icon: 'ph-progress-bar', color: '#4f46e5', yData: [75], min: 0, max: 100 },
  liquid: { icon: 'ph-drop', color: '#4f46e5', yData: [0.6], min: 0, max: 1 },
  multiGauge: { icon: 'ph-gauges', color: '#4f46e5', yData: [65, 80, 45], min: 0, max: 100 },
  thermometer: { icon: 'ph-thermometer', color: '#4f46e5', yData: [78], min: 0, max: 100 },
  dashboard: { icon: 'ph-speedometer', color: '#4f46e5', yData: [85], min: 0, max: 100 },
  pie: { icon: 'ph-pie-chart', color: '#4f46e5', xData: ['A','B','C','D'], yData: [40,30,20,10] },
  donut: { icon: 'ph-circle-dashed', color: '#4f46e5', xData: ['A','B','C','D'], yData: [40,30,20,10] },
  radar: { icon: 'ph-target', color: '#4f46e5', xData: ['Speed','Power','Durability','Energy','Accuracy'], yData: [80,90,70,85,75] },
  polar: { icon: 'ph-circle', color: '#4f46e5', xData: ['A','B','C','D','E'], yData: [30,40,20,50,35] },
  basicLine: { icon: 'ph-chart-line', color: '#4f46e5', xData: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], yData: [120,200,150,80,70,110,130] },
  smoothLine: { icon: 'ph-chart-line', color: '#4f46e5', xData: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], yData: [120,200,150,80,70,110,130] },
  stepLine: { icon: 'ph-stairs', color: '#4f46e5', xData: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], yData: [120,200,150,80,70,110,130] },
  basicArea: { icon: 'ph-chart-line-up', color: '#4f46e5', xData: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], yData: [120,200,150,80,70,110,130] },
  scatter: { icon: 'ph-scatter-plot', color: '#4f46e5' },
  bubble: { icon: 'ph-circle', color: '#4f46e5' },
  heatmap: { icon: 'ph-fire', color: '#4f46e5' },
  calendarHeat: { icon: 'ph-calendar', color: '#4f46e5' },
  funnel: { icon: 'ph-funnel', color: '#4f46e5', xData: ['Step 1','Step 2','Step 3','Step 4'], yData: [100,70,50,20] },
  map: { icon: 'ph-map-trifold', color: '#4f46e5' },
  input: { icon: 'ph-chat-text', color: '#4f46e5', yData: [''] },
  button: { icon: 'ph-button', color: '#4f46e5' },
  toggle: { icon: 'ph-toggle-left', color: '#4f46e5', yData: [0] },
  slider: { icon: 'ph-sliders', color: '#4f46e5', yData: [50] },
  dropdown: { icon: 'ph-caret-down', color: '#4f46e5' },
  terminal: { icon: 'ph-terminal-window', color: '#4f46e5' },
  iframe: { icon: 'ph-browser', color: '#4f46e5' },
  image: { icon: 'ph-image', color: '#4f46e5' },
  html: { icon: 'ph-code', color: '#4f46e5' }
};

function addWidget(type) {
  const id = `w_${Date.now()}`;
  const title = humanTitle(type);
  const defaultCfg = widgetDefaults[type] || { icon: 'ph-line-chart', color: '#4f46e5', xData: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], yData: [120,200,150,80,70,110,130] };
  
  const cfg = {
    id,
    type,
    title,
    viewIds: [],
    tableHeaderColors: {},
    ...defaultCfg
  };
  
  const el = makeWidgetElement(cfg);
  const size = getDefaultSize(type);
  grid.addWidget(el, { w: size.w, h: size.h, x: 0, y: 0 });
  widgetRegistry.set(id, { ...cfg, instance: null });
  
  setTimeout(() => { 
    initWidget(id); 
    if (currentViewId) applyStrictViewFiltering(views.find(v => v.id === currentViewId));
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
    item.remove();
  }
  
  markUnsaved();
  
  // Remove widget from all views
  if (currentDashId) {
    views.forEach(view => {
      if (view.widgetIds) view.widgetIds = view.widgetIds.filter(widgetId => widgetId !== id);
    });
    saveDashboardViews(currentDashId, views);
  }
}

function initWidget(id) {
  const cfg = widgetRegistry.get(id);
  if (!cfg) return;

  const titleEl = document.getElementById(`${id}_title`);
  if (titleEl) {
    const iconHtml = cfg.icon ? `<i class="${getIconClass(cfg.icon)}" style="margin-right:6px;font-size:16px;color:${cfg.color || '#4f46e5'}"></i>` : '';
    titleEl.innerHTML = iconHtml + escapeHtml(cfg.title || cfg.type || 'Widget');
  }

  const chartEl = document.getElementById(`${id}_chart`);
  const tableEl = document.getElementById(`${id}_table`);
  const cardEl = document.getElementById(`${id}_card`);
  const compEl = document.getElementById(`${id}_comp`);
  const termEl = document.getElementById(`${id}_term`);
  const iframeEl = document.getElementById(`${id}_iframe`);
  const imageEl = document.getElementById(`${id}_image`);
  const htmlEl = document.getElementById(`${id}_html`);

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
      cardEl.innerHTML = `
        <div class="enhanced-card">
          ${cfg.icon ? `<div class="enhanced-card-icon"><i class="${getIconClass(cfg.icon)}"></i></div>` : ''}
          <div class="enhanced-card-title">${cfg.title || 'Card'}</div>
          <div class="enhanced-card-value" style="color:${cfg.color || '#4f46e5'}">${(cfg.yData && cfg.yData[0] !== undefined) ? cfg.yData[0] : '-'}</div>
          <div class="enhanced-card-unit">Units</div>
        </div>
      `;
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
    } else if (cfg.type === 'button') {
      const btn = document.getElementById(`${id}_button`);
      if (btn) {
        btn.textContent = cfg.title || 'Button';
        btn.style.backgroundColor = cfg.color || '#4f46e5';
        btn.onclick = () => alert(`Button "${cfg.title}" clicked`);
      }
    } else if (cfg.type === 'toggle') {
      const toggle = document.getElementById(`${id}_toggle`);
      if (toggle) {
        toggle.checked = !!(cfg.yData && cfg.yData[0]);
        toggle.onchange = () => { cfg.yData = [toggle.checked ? 1 : 0]; markUnsaved(); };
      }
    } else if (cfg.type === 'slider') {
      const slider = document.getElementById(`${id}_slider`);
      if (slider) {
        slider.value = cfg.yData && cfg.yData[0] !== undefined ? cfg.yData[0] : 50;
        slider.oninput = () => { cfg.yData = [parseInt(slider.value)]; markUnsaved(); };
      }
    } else if (cfg.type === 'dropdown') {
      const dropdown = document.getElementById(`${id}_dropdown`);
      if (dropdown) dropdown.onchange = () => { cfg.yData = [dropdown.value]; markUnsaved(); };
    }
    return;
  }

  if (termEl) termEl.innerHTML = 'System Ready...\n';
  if (iframeEl) iframeEl.srcdoc = '<html><body style="margin:0;padding:20px;font-family:Arial"><h3>Embedded Content</h3><p>Webpage content would appear here.</p></body></html>';
  if (imageEl) imageEl.innerHTML = '<div style="text-align:center"><div style="font-size:14px;margin-bottom:8px">Image Display</div><div style="width:100px;height:100px;background:linear-gradient(135deg,#4f46e5,#7c3aed);margin:0 auto;border-radius:8px;"></div></div>';
  if (htmlEl) htmlEl.innerHTML = '<div style="font-size:14px;margin-bottom:8px">Custom HTML Content</div><div style="background:#e2e8f0;padding:12px;border-radius:6px;font-family:monospace;font-size:12px">&lt;div&gt;Your HTML here&lt;/div&gt;</div>';

  if (chartEl) {
    let chart = cfg.instance || echarts.init(chartEl);
    cfg.instance = chart;
    
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

    if (cfg._ro) try { cfg._ro.disconnect(); } catch(e) {}
    const ro = new ResizeObserver(() => cfg.instance && cfg.instance.resize());
    ro.observe(chartEl);
    cfg._ro = ro;
  }
}

function buildOptionAdvanced(cfg, width = 800, height = 400) {
  const compact = width < 240 || height < 140;
  const x = cfg.xData || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const y = cfg.yData || [120, 200, 150, 80, 70, 110, 130];
  const axisCompact = compact ? { axisLabel: { show: false }, axisTick: { show: false }, splitLine: { show: false } } : {};
  const color = cfg.color || '#4f46e5';
  const colors = [color, lightenColor(color, 20), lightenColor(color, 40), lightenColor(color, 60)];

  const options = {
    basicLine: { tooltip: { trigger: 'axis' }, xAxis: Object.assign({ type: 'category', data: x }, axisCompact), yAxis: Object.assign({ type: 'value' }, axisCompact), series: [{ type: 'line', data: y, itemStyle: { color: color } }] },
    smoothLine: { tooltip: { trigger: 'axis' }, xAxis: Object.assign({ type: 'category', data: x }, axisCompact), yAxis: Object.assign({ type: 'value' }, axisCompact), series: [{ type: 'line', smooth: true, data: y, itemStyle: { color: color } }] },
    stepLine: { tooltip: { trigger: 'axis' }, xAxis: Object.assign({ type: 'category', data: x }, axisCompact), yAxis: Object.assign({ type: 'value' }, axisCompact), series: [{ type: 'line', step: 'middle', data: y, itemStyle: { color: color } }] },
    basicArea: { tooltip: { trigger: 'axis' }, xAxis: Object.assign({ type: 'category', boundaryGap: false, data: x }, axisCompact), yAxis: Object.assign({ type: 'value' }, axisCompact), series: [{ type: 'line', areaStyle: { color: color }, data: y, itemStyle: { color: color } }] },
    stackedLine: { tooltip: { trigger: 'axis' }, legend: compact ? undefined : {}, xAxis: Object.assign({ type: 'category', data: x }, axisCompact), yAxis: Object.assign({ type: 'value' }, axisCompact), series: [
        { name: 'A', type: 'line', stack: 's', data: y, itemStyle: { color: color } },
        { name: 'B', type: 'line', stack: 's', data: y.map(v => Math.round(v*0.8)), itemStyle: { color: lightenColor(color, 20) } }
      ] },
    stackedArea: { tooltip: { trigger: 'axis' }, legend: compact ? undefined : {}, xAxis: Object.assign({ type: 'category', boundaryGap: false, data: x }, axisCompact), yAxis: Object.assign({ type: 'value' }, axisCompact), series: [
        { name: 'A', type: 'line', stack: 's', areaStyle: { color: color }, data: y, itemStyle: { color: color } },
        { name: 'B', type: 'line', stack: 's', areaStyle: { color: lightenColor(color, 30) }, data: y.map(v => Math.round(v*0.6)), itemStyle: { color: lightenColor(color, 30) } }
      ] },
    bar: { tooltip: { trigger: 'axis' }, xAxis: { type: 'category', data: x }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: y, itemStyle: { color: color } }] },
    pie: { tooltip: { trigger: 'item' }, series: [{ type: 'pie', radius: '50%', data: x.map((name, i) => ({ name, value: y[i] })), itemStyle: { color: function(params) { return colors[params.dataIndex % colors.length]; } } }] },
    donut: { tooltip: { trigger: 'item' }, series: [{ type: 'pie', radius: ['40%', '70%'], data: x.map((name, i) => ({ name, value: y[i] })), itemStyle: { color: function(params) { return colors[params.dataIndex % colors.length]; } } }] },
    gauge: { series: [{ type: 'gauge', min: cfg.min || 0, max: cfg.max || 100, detail: { formatter: '{value}' }, axisLine: { lineStyle: { color: [[1, color]] } }, data: [{ value: cfg.yData && cfg.yData[0] ? cfg.yData[0] : 0, name: cfg.title || 'Val' }] }] },
    progress: { series: [{ type: 'gauge', min: cfg.min || 0, max: cfg.max || 100, progress: { show: true, width: 18 }, axisLine: { lineStyle: { width: 18 } }, detail: { formatter: '{value}%' }, data: [{ value: cfg.yData && cfg.yData[0] ? cfg.yData[0] : 0, name: cfg.title || 'Progress' }] }] },
    liquid: { series: [{ type: 'liquidFill', data: [cfg.yData && cfg.yData[0] ? cfg.yData[0] : 0.5], outline: { show: false }, backgroundStyle: { color: '#f0f0f0' }, itemStyle: { color: color }, label: { formatter: '{c}', fontSize: 24 } }] },
    scatter: { tooltip: { trigger: 'item' }, xAxis: { type: 'value' }, yAxis: { type: 'value' }, series: [{ type: 'scatter', data: Array.from({length:20}, () => [Math.random()*100, Math.random()*100]), symbolSize: 10, itemStyle: { color: color } }] }
  };

  return options[cfg.type] || options.basicLine;
}

function lightenColor(color, percent) {
  const num = parseInt(color.slice(1), 16);
  const amt = Math.round(2.55 * percent);
  const R = (num >> 16) + amt;
  const G = (num >> 8 & 0x00FF) + amt;
  const B = (num & 0x0000FF) + amt;
  return '#' + (0x1000000 + (R<255?R<1?0:R:255)*0x10000 + (G<255?G<1?0:G:255)*0x100 + (B<255?B<1?0:B:255)).toString(16).slice(1);
}

// Modal functions
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
  
  document.getElementById('widget-visibility-section').classList.remove('hidden');
  updateVisibilityOptions(cfg);
  
  // Show/hide sections based on widget type
  const gaugeTypes = ['gauge', 'progress', 'liquid', 'multiGauge', 'dashboard', 'thermometer'];
  const tableTypes = ['table'];
  const groupTypes = ['groupCard'];
  const chartTypes = !['card', 'groupCard', 'table', 'input', 'button', 'toggle', 'slider', 'dropdown', 'terminal', 'iframe', 'image', 'html'].includes(cfg.type);
  
  document.getElementById('gauge-minmax').classList.toggle('hidden', !gaugeTypes.includes(cfg.type));
  document.getElementById('group-settings').classList.toggle('hidden', !groupTypes.includes(cfg.type));
  document.getElementById('table-form-section').classList.toggle('hidden', !tableTypes.includes(cfg.type));
  document.getElementById('data-points-section').classList.toggle('hidden', tableTypes.includes(cfg.type));
  document.getElementById('echarts-form-section').classList.toggle('hidden', !chartTypes);
  
  const dp = document.getElementById('data-points');
  dp.innerHTML = '';
  
  if (cfg.type !== 'table') {
    const n = Math.max((cfg.xData||[]).length, (cfg.yData||[]).length, 1);
    for (let i = 0; i < n; i++) {
      const lab = (cfg.xData && cfg.xData[i]) || '';
      const val = (cfg.yData && cfg.yData[i] !== undefined) ? cfg.yData[i] : '';
      dp.innerHTML += `
        <div class="point-row">
          <input value="${escapeHtml(lab)}" placeholder="label">
          <input value="${escapeHtml(String(val))}" placeholder="value">
          <button class="btn btn-ghost" onclick="this.parentElement.remove()">Remove</button>
        </div>
      `;
    }
  }
  
  if (cfg.type === 'groupCard') {
    document.getElementById('group-count').value = cfg.groupCount || (cfg.groupItems ? cfg.groupItems.length : 2);
    document.getElementById('group-items').value = (cfg.groupItems || []).map(it => `${it.label}:${it.value}`).join("\n");
  }
  
  if (cfg.type === 'table') {
    document.getElementById('table-columns-count').value = cfg.tableColumns || 3;
    document.getElementById('table-rows-count').value = cfg.tableRows || 3;
    document.getElementById('table-header-colors-section').classList.remove('hidden');
    setTimeout(() => { 
      updateTableForm(); 
      updateTableHeaderColors();
    }, 50);
  } else {
    document.getElementById('table-header-colors-section').classList.add('hidden');
  }
  
  document.getElementById('inp-min').value = cfg.min ?? '';
  document.getElementById('inp-max').value = cfg.max ?? '';
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
    
    visibilityOptions.innerHTML += `
      <div class="visibility-option">
        <input type="checkbox" id="visibility-${view.id}" ${isChecked ? 'checked' : ''}>
        <div class="visibility-option-icon"><i class="${iconClass}"></i></div>
        <span class="visibility-option-label">${escapeHtml(view.name)}</span>
      </div>
    `;
  });
}

function updateTableHeaderColors() {
  const colorsContainer = document.getElementById('table-header-colors');
  const cfg = widgetRegistry.get(modalActiveId);
  if (!cfg || cfg.type !== 'table') return;
  
  const colCount = cfg.tableColumns || 3;
  const headerColors = cfg.tableHeaderColors || {};
  const defaultColors = ['#4f46e5', '#10b981', '#ef4444', '#f59e0b', '#8b5cf6'];
  
  colorsContainer.innerHTML = Array.from({length: colCount}, (_, i) => {
    const currentColor = headerColors[i] || defaultColors[i % defaultColors.length];
    return `
      <div class="header-color-option">
        <div class="color-preview" style="background-color: ${currentColor}"></div>
        <span>Header ${i+1}</span>
        <input type="color" value="${currentColor}" 
               onchange="updateHeaderColor(${i}, this.value)" 
               style="width:24px;height:24px;padding:0;border:none;background:transparent">
      </div>
    `;
  }).join('');
}

function updateHeaderColor(headerIndex, color) {
  const cfg = widgetRegistry.get(modalActiveId);
  if (!cfg) return;
  
  if (!cfg.tableHeaderColors) cfg.tableHeaderColors = {};
  cfg.tableHeaderColors[headerIndex] = color;
  markUnsaved();
}

function updateTableForm() {
  if (!modalActiveId) return;
  const cfg = widgetRegistry.get(modalActiveId);
  if (!cfg || cfg.type !== 'table') return;
  
  const colCount = parseInt(document.getElementById('table-columns-count').value) || 3;
  const rowCount = parseInt(document.getElementById('table-rows-count').value) || 3;
  
  document.getElementById('table-dimensions').textContent = `${colCount} columns × ${rowCount} rows`;
  
  const headersDiv = document.getElementById('table-headers');
  headersDiv.innerHTML = Array.from({length: colCount}, (_, col) => `
    <div style="flex:1">
      <div class="form-label small" style="text-align:center">Col ${col+1}</div>
      <input type="text" class="form-input" id="table-header-${col}" 
             placeholder="Header ${col+1}" value="${cfg.xData && cfg.xData[col] ? escapeHtml(cfg.xData[col]) : `Column ${col+1}`}"
             style="text-align:center;font-weight:600">
    </div>
  `).join('');
  
  const rowNumbersDiv = document.getElementById('table-row-numbers');
  rowNumbersDiv.innerHTML = Array.from({length: rowCount}, (_, row) => `
    <div style="height:40px;display:flex;align-items:center;justify-content:center;border-bottom:1px solid #e2e8f0;font-size:12px;color:#64748b;font-weight:600;background-color:${row % 2 === 0 ? '#f8fafc' : '#ffffff'}">
      Row ${row+1}
    </div>
  `).join('');
  
  // Table data
  const dataGrid = document.getElementById('table-data-table');
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
  
  while (tableData.length < rowCount) tableData.push(Array(colCount).fill(''));
  tableData = tableData.map(row => row.slice(0, colCount));
  
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
          case 'ArrowUp': if (currentRow > 0) nextInput = document.getElementById(`table-cell-${currentRow-1}-${currentCol}`); break;
          case 'ArrowDown': if (currentRow < rowCount - 1) nextInput = document.getElementById(`table-cell-${currentRow+1}-${currentCol}`); break;
          case 'ArrowLeft': if (currentCol > 0) nextInput = document.getElementById(`table-cell-${currentRow}-${currentCol-1}`); break;
          case 'ArrowRight': if (currentCol < colCount - 1) nextInput = document.getElementById(`table-cell-${currentRow}-${currentCol+1}`); break;
          case 'Tab':
            e.preventDefault();
            if (e.shiftKey) {
              if (currentCol > 0) nextInput = document.getElementById(`table-cell-${currentRow}-${currentCol-1}`);
              else if (currentRow > 0) nextInput = document.getElementById(`table-cell-${currentRow-1}-${colCount-1}`);
            } else {
              if (currentCol < colCount - 1) nextInput = document.getElementById(`table-cell-${currentRow}-${currentCol+1}`);
              else if (currentRow < rowCount - 1) nextInput = document.getElementById(`table-cell-${currentRow+1}-0`);
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
  
  dataGrid.innerHTML = '';
  dataGrid.appendChild(table);
}

function closeModal() {
  document.getElementById('settings-modal').classList.add('hidden');
  modalActiveId = null;
}

function resetColor() {
  document.getElementById('inp-color').value = '#4f46e5';
  document.getElementById('inp-color-text').value = '#4f46e5';
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
  
  // Update views with widget assignments
  views.forEach(view => {
    if (selectedViewIds.includes(view.id)) {
      if (!view.widgetIds) view.widgetIds = [];
      if (!view.widgetIds.includes(cfg.id)) view.widgetIds.push(cfg.id);
    } else {
      if (view.widgetIds) view.widgetIds = view.widgetIds.filter(id => id !== cfg.id);
    }
  });

  saveDashboardViews(currentDashId, views);

  if (cfg.type === 'table') {
    const colCount = parseInt(document.getElementById('table-columns-count').value) || 3;
    const rowCount = parseInt(document.getElementById('table-rows-count').value) || 3;
    
    const headers = Array.from({length: colCount}, (_, col) => {
      const headerInput = document.getElementById(`table-header-${col}`);
      return headerInput ? headerInput.value.trim() || `Column ${col+1}` : `Column ${col+1}`;
    });
    
    const tableData = Array.from({length: rowCount}, (_, row) => 
      Array.from({length: colCount}, (_, col) => {
        const cellInput = document.getElementById(`table-cell-${row}-${col}`);
        return cellInput ? cellInput.value.trim() : '';
      })
    );
    
    cfg.xData = headers;
    cfg.yData = tableData;
    cfg.tableColumns = colCount;
    cfg.tableRows = rowCount;
  } else {
    // Handle regular data points
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
  markUnsaved();
  closeModal();
  
  if (currentViewId) {
    const view = views.find(v => v.id === currentViewId);
    if (view) setTimeout(() => applyStrictViewFiltering(view), 50);
  }
}

function enterEditMode() {
  if (isEditMode) return;
  isEditMode = true;
  
  // Show all widgets in edit mode
  grid.engine.nodes.forEach(node => {
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
}

function cancelEdit() {
  exitEditMode();
  if (currentViewId) {
    const view = views.find(v => v.id === currentViewId);
    if (view) setTimeout(() => applyStrictViewFiltering(view), 50);
  }
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
}

function saveCurrentDashboard() {
  performSave();
  exitEditMode();
  showSavedToast('Saved Successfully');
}

function startEditFromList(e, id) {
  e.stopPropagation();
  openWorkspace(id);
  setTimeout(() => enterEditMode(), 200);
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
  const versions = dash.versions ? dash.versions.slice().reverse() : [];
  
  if (versions.length === 0) {
    container.innerHTML = '<div class="small">No history snapshots available.</div>';
  } else {
    container.innerHTML = versions.map((v, i) => `
      <div class="history-item">
        <div>
          <div style="font-weight:600">${new Date(v.timestamp).toLocaleString()}</div>
          <div class="small">Snapshot</div>
        </div>
        <div>
          <button class="btn btn-primary" onclick="restoreSnapshot(${JSON.stringify(v).replace(/"/g, '&quot;')})">Restore</button>
        </div>
      </div>
    `).join('');
  }
  
  document.getElementById('history-modal').classList.remove('hidden');
}

function closeHistoryModal() {
  document.getElementById('history-modal').classList.add('hidden');
}

function restoreSnapshot(snapshot) {
  if (!snapshot || !snapshot.data) return;
  
  if (!confirm('Restore this snapshot? This will replace current layout.')) return;
  
  widgetRegistry.forEach((cfg, id) => {
    if (cfg._timer) clearInterval(cfg._timer);
    if (cfg._ro) try { cfg._ro.disconnect(); } catch(e) {}
    if (cfg.instance) try { cfg.instance.dispose(); } catch(e) {}
  });
  
  grid.removeAll();
  widgetRegistry.clear();
  
  snapshot.data.forEach(w => {
    const el = makeWidgetElement(w);
    const size = getDefaultSize(w.type);
    grid.addWidget(el, { w: w.w || size.w, h: w.h || size.h, x: w.x || 0, y: w.y || 0 });
    widgetRegistry.set(w.id, { 
      ...w, 
      instance: null, 
      viewIds: w.viewIds || [],
      tableHeaderColors: w.tableHeaderColors || {}
    });
  });
  
  setTimeout(() => { 
    widgetRegistry.forEach((cfg, id) => initWidget(id)); 
    if (currentViewId) {
      const view = views.find(v => v.id === currentViewId);
      if (view) setTimeout(() => applyStrictViewFiltering(view), 150);
    }
  }, 120);
  
  performSave();
  closeHistoryModal();
}

// View management
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
  viewsList.innerHTML = views.map(view => {
    let widgetCountText = 'All widgets';
    if (view.widgetIds && view.widgetIds.length > 0) {
      widgetCountText = `${view.widgetIds.length} widget${view.widgetIds.length === 1 ? '' : 's'}`;
    }
    
    const iconClass = getIconClass(view.icon) || 'ph ph-house';
    return `
      <div class="view-item ${view.id === currentViewId ? 'active' : ''}" onclick="selectViewForWidgetSelection('${view.id}')">
        <div class="view-item-icon"><i class="${iconClass}"></i></div>
        <div class="view-item-details">
          <div class="view-item-name">${escapeHtml(view.name)}</div>
          <div class="view-item-stats">${widgetCountText}</div>
        </div>
        <div class="view-item-actions">
          <button class="btn btn-ghost" onclick="editView('${view.id}')" style="padding:4px 8px;font-size:12px">Edit</button>
          <button class="btn" onclick="deleteView('${view.id}')" style="padding:4px 8px;font-size:12px">Delete</button>
        </div>
      </div>
    `;
  }).join('');
  
  if (views.length > 0 && !selectedViewForWidgetSelection) {
    selectedViewForWidgetSelection = views[0];
  }
  
  updateViewsListSelection();
  document.getElementById('manage-views-modal').classList.remove('hidden');
}

function selectViewForWidgetSelection(viewId) {
  selectedViewForWidgetSelection = views.find(v => v.id === viewId);
  updateViewsListSelection();
}

function updateViewsListSelection() {
  document.querySelectorAll('.view-item').forEach(item => {
    item.classList.remove('active');
  });
  
  if (selectedViewForWidgetSelection) {
    const selectedItem = document.querySelector(`.view-item[onclick*="${selectedViewForWidgetSelection.id}"]`);
    if (selectedItem) selectedItem.classList.add('active');
  }
}

function closeManageViewsModal() {
  document.getElementById('manage-views-modal').classList.add('hidden');
  selectedViewForWidgetSelection = null;
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
  
  if (!confirm(`Are you sure you want to delete the view "${view.name}"?`)) return;
  
  views = views.filter(v => v.id !== viewId);
  views.forEach((v, index) => { v.order = index; });
  
  widgetRegistry.forEach(cfg => {
    if (cfg.viewIds && cfg.viewIds.includes(viewId)) {
      cfg.viewIds = cfg.viewIds.filter(id => id !== viewId);
    }
  });
  
  saveDashboardViews(currentDashId, views);
  
  if (currentViewId === viewId) {
    activateView(views.length > 0 ? views[0].id : null);
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
  
  const widgetItems = Array.from(grid.engine.nodes);
  if (widgetItems.length === 0) {
    widgetsList.innerHTML = '<div style="text-align:center;padding:20px;color:#6b7280">No widgets found</div>';
  } else {
    widgetsList.innerHTML = widgetItems.map(node => {
      const content = node.el.querySelector('.grid-stack-item-content');
      if (!content) return '';
      
      const widgetId = content.getAttribute('gs-id');
      const cfg = widgetRegistry.get(widgetId);
      if (!cfg) return '';
      
      const isSelected = cfg.viewIds && cfg.viewIds.includes(view.id);
      const iconClass = getIconClass(cfg.icon) || 'ph ph-cube';
      return `
        <div class="widget-item">
          <input type="checkbox" id="select-widget-${widgetId}" ${isSelected ? 'checked' : ''}>
          <div class="widget-item-icon"><i class="${iconClass}"></i></div>
          <div class="widget-item-details">
            <div class="widget-item-name">${escapeHtml(cfg.title || cfg.type)}</div>
            <div class="widget-item-type">${cfg.type}</div>
          </div>
        </div>
      `;
    }).join('');
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
  
  checkboxes.forEach(checkbox => {
    const widgetId = checkbox.id.replace('select-widget-', '');
    const cfg = widgetRegistry.get(widgetId);
    if (!cfg) return;
    
    if (checkbox.checked) {
      if (!cfg.viewIds) cfg.viewIds = [];
      if (!cfg.viewIds.includes(view.id)) cfg.viewIds.push(view.id);
      if (!view.widgetIds) view.widgetIds = [];
      if (!view.widgetIds.includes(widgetId)) view.widgetIds.push(widgetId);
    } else {
      if (cfg.viewIds) cfg.viewIds = cfg.viewIds.filter(id => id !== view.id);
      if (view.widgetIds) view.widgetIds = view.widgetIds.filter(id => id !== widgetId);
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

// Utility functions
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

// Initialize
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
