'use strict';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const views = {
  overview: ['grid','Array overview','A live view of your storage infrastructure.'],
  storage: ['disk','Physical storage','Disk inventory, enclosure bays, and disk folder capacity.'],
  health: ['health','System health','Controllers, environmental sensors, power supplies, and cache batteries.'],
  volumes: ['volume','Volumes','Discovered volumes and their current operational state.'],
  connectivity: ['network','Connectivity','Managed servers, primary paths, and storage center port balance.'],
  alerts: ['alert','Alerts','Reported alert entries, including their activity and acknowledgment state.'],
  performance: ['chart','Performance','Management-interface traffic and storage trends collected by this monitor.'],
  explorer: ['code','MIB explorer','Inspect every collected object alongside its MIB definition and numeric OID.']
};
const navNames = {overview:'Overview',storage:'Storage',health:'Health',volumes:'Volumes',connectivity:'Connectivity',alerts:'Alerts',performance:'Performance',explorer:'MIB explorer'};
let snapshot, schema, fieldMap = new Map(), objects = [], currentView = 'overview', query = '', alertMode = 'active', healthFilter = 'all', explorerPage = 0, fetchError = '', busy = false, rawStamp = '';
const val = (row, key) => row?.values?.[key]?.value;
const label = (row, key) => row?.values?.[key]?.label || String(val(row,key) ?? '');
const rows = table => snapshot?.tables?.[table] || [];
const scalar = key => snapshot?.scalars?.[key]?.value;
const num = value => Number(value) || 0;
const integer = value => new Intl.NumberFormat().format(num(value));
const decimal = (value, digits = 1) => new Intl.NumberFormat(undefined,{maximumFractionDigits:digits}).format(num(value));
const capacity = gib => `${decimal(num(gib)/1024,2)} TiB`;
const diskCapacity = gb => num(gb) >= 1000 ? `${decimal(num(gb)/1000,2)} TB` : `${decimal(gb)} GB`;
const bytes = (n, suffix = '/s') => {
  if (n == null) return '—';
  const units = ['B','KiB','MiB','GiB']; let i = 0;
  while (n >= 1024 && i < units.length-1) { n /= 1024; i++; }
  return `${decimal(n,1)} ${units[i]}${suffix}`;
};
const isDate = value => value && !String(value).startsWith('0001');
const timeAgo = value => {
  if (!isDate(value)) return 'never';
  const seconds = Math.max(0,Math.floor((Date.now()-new Date(value).getTime())/1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds/60)}m ago`;
  return `${Math.floor(seconds/3600)}h ago`;
};
const uptime = ticks => {
  const sec = Math.floor(num(ticks)/100), days = Math.floor(sec/86400), hours = Math.floor(sec%86400/3600), minutes = Math.floor(sec%3600/60);
  return `${days ? `${days}d ` : ''}${hours}h ${minutes}m`;
};
const level = text => {
  text = String(text).toLowerCase();
  if (['up','ok','okay','normal','complete','healthy','balanced','true'].includes(text)) return 'ok';
  if (['degraded','noncritical','partial','expirationpending'].includes(text)) return 'warning';
  if (['down','critical','nonrecoverable','emergency','expired','unavailable','unhealthy','lowerlayerdown','false'].includes(text)) return 'critical';
  return 'unknown';
};
const badge = (text, severity = level(text)) => `<span class="badge ${esc(severity)}"><span class="status-dot"></span>${esc(text || 'Unknown')}</span>`;
const displayValue = value => {
  if (!value || value.value == null || String(value.value).trim() === '') return '<span class="muted">—</span>';
  return `${esc(value.label || value.value)}${value.unit ? ` <span class="muted">${esc(value.unit)}</span>` : ''}`;
};
const matches = row => !query || JSON.stringify(row).toLowerCase().includes(query.toLowerCase());
const panel = (title, subtitle, body, link = '') => `<section class="panel"><div class="panel-header"><div><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>${link}</div>${body}</section>`;
const viewLink = (view, text) => `<a href="#${view}" class="panel-link">${esc(text)} ${icon('arrow')}</a>`;
const stat = (title, value, foot, glyph, cls = '') => `<div class="stat-card"><div class="stat-label">${esc(title)}${icon(glyph)}</div><div class="stat-value ${cls}">${value}</div><div class="stat-foot">${foot}</div></div>`;
const empty = (title, text, glyph = 'search') => `<div class="empty-state">${icon(glyph)}<h2>${esc(title)}</h2><p>${esc(text)}</p></div>`;
const detailsButton = (table, row, text, glyph = '') => `<button class="row-button" data-table="${esc(table)}" data-index="${esc(row.index)}">${glyph ? icon(glyph) : ''}${esc(text)}</button>`;
const humanField = name => name.replace(/^productID/,'').replace(/^sc(?:Ctlr|Encl|DiskFolderSU|DiskFolder|DiskConfig|Disk|Volume|Server|Cache|Alert|Sc|UPS|ObjCnt)/,'').replace(/([a-z])([A-Z])/g,'$1 $2');

function tablePanel(title, subtitle, table, columns, data = rows(table), options = {}) {
  const filtered = data.filter(matches);
  if (!filtered.length) return panel(title,subtitle,`<div class="panel-body"><p class="inline-info">${esc(data.length ? 'No entries match your search.' : options.empty || 'This table has no entries reported by the agent.')}</p></div>`);
  const limit = options.limit || filtered.length, shown = filtered.slice(options.offset || 0,(options.offset || 0)+limit);
  return panel(title,subtitle,`<div class="table-wrap"><table class="data-table"><thead><tr>${columns.map(c=>`<th scope="col">${esc(c[0])}</th>`).join('')}<th scope="col">Details</th></tr></thead><tbody>${shown.map(row=>`<tr>${columns.map(c=>`<td>${typeof c[1] === 'function' ? c[1](row) : displayValue(row.values[c[1]])}</td>`).join('')}<td>${detailsButton(table,row,'Inspect','code')}</td></tr>`).join('')}</tbody></table></div><div class="table-footer"><span>${integer(filtered.length)} ${esc(options.noun || 'entries')}${query ? ' match your search' : ' reported'}${shown.length < filtered.length ? ` · showing ${shown.length}` : ''}</span><span>Click Inspect for all MIB fields</span></div>`);
}

function controllerCards() {
  return rows('scCtlrTable').map(r=>`<div class="controller"><div class="controller-top"><div class="controller-name">${icon('array')}${esc(label(r,'scCtlrName'))}${label(r,'scCtlrLeader') === 'true' ? '<span class="tag">Leader</span>' : ''}</div>${badge(label(r,'scCtlrStatus'))}</div><div class="controller-meta"><span>${esc(label(r,'scCtlrModel'))}</span><span class="mono">${esc(label(r,'scCtlrIpAddr'))}</span><span>Tag ${esc(label(r,'scCtlrServiceTag'))}</span></div></div>`).join('') || '<p class="inline-info">No controllers reported.</p>';
}

function capacityPanel() {
  const s = snapshot.summary, percent = s.totalGiB > 0 ? s.usedGiB/s.totalGiB*100 : 0;
  const circumference = 2*Math.PI*55;
  const ring = `<svg class="donut" viewBox="0 0 140 140" role="img" aria-label="${decimal(percent)} percent of total disk space used"><circle class="donut-bg" cx="70" cy="70" r="55"/><circle class="donut-value" cx="70" cy="70" r="55" transform="rotate(-90 70 70)" stroke-dasharray="${circumference* Math.min(100,percent)/100} ${circumference}"/><text class="donut-number" x="70" y="69">${decimal(percent)}%</text><text class="donut-label" x="70" y="86">DISK SPACE USED</text></svg>`;
  const values = [['Used by volumes',s.usedGiB,''],['Allocated for volumes',s.allocatedGiB,'blue'],['Unallocated',s.freeGiB,'gray'],['Available spares',s.spareGiB,'amber']].map(([name,value,color])=>`<div class="capacity-row"><span class="legend-name"><span class="swatch ${color}"></span>${name}</span><strong>${capacity(value)}</strong></div>`).join('');
  return panel('Storage capacity',`${capacity(s.totalGiB)} total disk space`, `<div class="panel-body"><div class="capacity">${ring}<div class="capacity-values">${values}</div></div><p class="capacity-note">Values reported by the storage center. Used space is part of allocated space; spares are reported separately.</p></div>`,viewLink('storage','View storage'));
}

function diskMaps(compact = false) {
  const allDisks = rows('scDiskTable');
  const encl = rows('scEnclTable');
  const groups = encl.length ? encl : [...new Set(allDisks.map(r=>val(r,'scDiskEnclosure')))].map(n=>({index:String(n),values:{scEnclNbr:{value:n},scEnclName:{value:`Enclosure ${n}`}}}));
  return groups.map(e=>{
    const disks = allDisks.filter(r=>num(val(r,'scDiskEnclosure'))===num(val(e,'scEnclNbr'))).filter(matches).sort((a,b)=>label(a,'scDiskNamePosition').localeCompare(label(b,'scDiskNamePosition'),undefined,{numeric:true}));
    if (!disks.length && query) return '';
    return `<div class="enclosure"><div class="enclosure-header"><div><h3>${esc(label(e,'scEnclName'))} <span class="muted">· ${esc(label(e,'scEnclModel'))}</span></h3><p>${disks.length} disks · ${diskCapacity(disks.reduce((a,r)=>a+num(val(r,'scDiskSize')),0))} raw</p></div>${badge(label(e,'scEnclStatus'))}</div><div class="disk-grid">${disks.map(d=>{
      const position = label(d,'scDiskNamePosition'), state = label(d,'scDiskHealthy') === 'false' ? 'critical' : level(label(d,'scDiskStatus'));
      return `<button class="disk ${state}" data-table="scDiskTable" data-index="${esc(d.index)}" aria-label="Disk ${esc(position)}, ${esc(label(d,'scDiskStatus'))}, ${esc(diskCapacity(val(d,'scDiskSize')))}" title="${esc(position)} · ${esc(diskCapacity(val(d,'scDiskSize')))} · ${esc(label(d,'scDiskStatus'))}">${esc(position.split('-').slice(1).join('-') || position)}</button>`;
    }).join('')}</div></div>`;
  }).join('') || '<p class="inline-info">No disks match this view.</p>';
}

function overview() {
  const s = snapshot.summary;
  const healthTitle = {ok:'Healthy',warning:'Degraded',critical:'Critical',unknown:'Unknown'}[s.status] || 'Unknown';
  const stats = `<div class="stats-grid">${stat('Array health',esc(healthTitle),`Dell rollup: ${esc(s.globalStatus || 'unknown')}`,'health',s.status)}${stat('Physical disks',`${integer(s.disks)}<small>disks</small>`,`${badge(s.healthyDisks === s.disks ? 'All healthy' : `${s.disks-s.healthyDisks} need attention`,s.healthyDisks===s.disks?'ok':'critical')}`,'disk')}${stat('Volumes',integer(s.volumes),`${integer(s.servers)} managed server entries`,'volume')}${stat('Active alerts',integer(s.activeAlerts),`${integer(rows('scAlertTable').length)} total controller alert entries`,'alert',s.activeAlerts?'warning':'ok')}</div>`;
  const sensors = [...rows('scCtlrTempTable'),...rows('scEnclTempTable')].length;
  const fans = [...rows('scCtlrFanTable'),...rows('scEnclFanTable')].length;
  const powers = [...rows('scCtlrPowerTable'),...rows('scEnclPowerTable')].length;
  const health = panel('Environmental health','Current readings across controllers and enclosures',`<div class="panel-body"><div class="health-grid"><div class="health-item">${icon('temp')}<strong>${s.maxTempC == null ? '—' : `${decimal(s.maxTempC)}°C`}</strong><span>Peak · ${sensors} sensors</span></div><div class="health-item">${icon('health')}<strong>${fans}</strong><span>Fan sensors</span></div><div class="health-item">${icon('array')}<strong>${powers}</strong><span>Power supplies</span></div></div></div>`,viewLink('health','View health'));
  const issues = s.issues.length ? s.issues.slice(0,5).map(i=>`<div class="issue-row"><div>${esc(i.name)}<span class="subtext">${esc(i.message)}</span></div>${badge(i.severity,i.severity)}</div>`).join('') : `<div class="empty-alert"><span>${icon('check')}</span><div><h3>No component faults reported</h3><p>The current MIB component states are healthy.</p></div></div>`;
  const alerts = panel('Attention & alerts',`${s.activeAlerts} active alert entries · ${s.issues.length} component and alert issues`, `<div class="panel-body">${issues}</div>`,viewLink('alerts','View alerts'));
  return stats + `<div class="overview-grid"><div>${capacityPanel()}${panel('Disk enclosures',`${s.enclosures} enclosures · ${s.disks} discovered disks`,`<div class="panel-body">${diskMaps(true)}<div class="disk-legend"><span><span class="status-dot"></span>Healthy</span><span><span class="status-dot warning"></span>Degraded</span><span><span class="status-dot critical"></span>Fault</span><span>Click a bay to inspect its disk</span></div></div>`,viewLink('storage','Disk inventory'))}</div><div>${panel('Controllers','Dual-controller storage center',`<div class="panel-body">${controllerCards()}</div>`,viewLink('health','View details'))}${health}${alerts}${panel('Array identity','Information reported by the SNMP agent',`<div class="panel-body"><div class="capacity-row"><span class="muted">Software</span><span class="mono">${esc(scalar('productIDVersion'))}</span></div><div class="capacity-row"><span class="muted">Service tag</span><span class="mono">${esc(scalar('productIDSerialNumber'))}</span></div><div class="capacity-row"><span class="muted">Management address</span><span class="mono">${esc(snapshot.target)}</span></div><div class="capacity-row"><span class="muted">SNMP agent uptime</span><span>${uptime(scalar('sysUpTime'))}</span></div></div>`)}</div></div>`;
}

function storage() {
  const s = snapshot.summary;
  const configurations = new Map(rows('scDiskConfigTable').map(r=>[String(val(r,'scDiskConfigNbr')),r]));
  const folders = rows('scDiskFolderSUTable').map(r=>({...r,values:{...r.values,...rows('scDiskFolderTable').find(f=>String(val(f,'scDiskFolderNbr')) === String(val(r,'scDiskFolderSUNbr')))?.values}}));
  return `<div class="stats-grid">${stat('Total disk space',`${decimal(s.totalGiB/1024,2)}<small>TiB</small>`,'Binary units · storage usage table','volume')}${stat('Unallocated space',`${decimal(s.freeGiB/1024,2)}<small>TiB</small>`,'Reported free capacity','disk')}${stat('Available spares',`${decimal(s.spareGiB/1024,2)}<small>TiB</small>`,'Reserved spare disk space','health')}${stat('Disk health',`${s.healthyDisks}<small>/ ${s.disks}</small>`,'Disks with Up and Healthy states','disk',s.healthyDisks===s.disks?'ok':'critical')}</div>` +
    tablePanel('Disk folders','Reported space values use GiB (1,073,741,824 bytes).','scDiskFolderSUTable',[
      ['Folder',r=>esc(label(r,'scDiskFolderName') || r.index)],['Status',r=>badge(label(r,'scDiskFolderStatus'))],['Total',r=>capacity(val(r,'scDiskFolderSUTotalSpace2'))],['Used',r=>capacity(val(r,'scDiskFolderSUUsedSpace2'))],['Allocated',r=>capacity(val(r,'scDiskFolderSUAllocSpace'))],['Unallocated',r=>capacity(val(r,'scDiskFolderSUFreeSpace'))],['Spares',r=>capacity(val(r,'scDiskFolderSUSpareSpace'))],['Alert threshold','scDiskFolderAlrtThr']
    ],folders) + panel('Enclosure bays','Each bay corresponds to a disk returned by SNMP.',`<div class="panel-body">${diskMaps()}</div>`) +
    tablePanel('Disk inventory','Raw disk capacity is reported in GB. Inspect a disk for its complete configuration.','scDiskTable',[
      ['Disk',r=>detailsButton('scDiskTable',r,label(r,'scDiskNamePosition'),'disk')],['Status',r=>badge(label(r,'scDiskStatus'))],['Healthy',r=>badge(label(r,'scDiskHealthy')==='true'?'Healthy':label(r,'scDiskHealthy')==='false'?'Unhealthy':'Unknown')],['Raw capacity',r=>diskCapacity(val(r,'scDiskSize'))],['Bus','scDiskIoPortType'],['Model',r=>esc(label(configurations.get(String(val(r,'scDiskNbr'))),'scDiskConfigModel'))],['Serial',r=>`<span class="mono">${esc(label(configurations.get(String(val(r,'scDiskNbr'))),'scDiskConfigSerial'))}</span>`],['Status message','scDiskStatusMsg']
    ]);
}

function genericHealth(table) {
  const def = schema.tables.find(t=>t.name===table), prefix = table.replace(/Table$/,'');
  const data = rows(table).filter(r=>healthFilter!=='issues' || Object.entries(r.values).some(([key,v])=>(key.endsWith('Status') || key==='scCacheBatStat') && ['warning','critical'].includes(level(v.label))));
  const columns = [['Location',r=>{
    const indexes = def.indexes || [];
    if (indexes[0]==='scCtlrIndex') return `Controller ${esc(r.index.split('.')[0])} · ${esc(r.index.split('.').slice(1).join('.'))}`;
    if (indexes[0]==='scEnclIndex') return `Enclosure ${esc(r.index.split('.')[0])} · ${esc(r.index.split('.').slice(1).join('.'))}`;
    return esc(r.index);
  }]];
  for (const suffix of ['Name','Location','Position']) if (schema.fields.some(f=>f.name===prefix+suffix)) columns.push(['Name / position',prefix+suffix]);
  if (schema.fields.some(f=>f.name===prefix+'Status')) columns.push(['Status',r=>badge(label(r,prefix+'Status'))]);
  for (const [suffix,title] of [['CurrentC','Temperature'],['CurrentRpm','Speed'],['CurrentS','Speed'],['CurrentV','Voltage'],['NormMinC','Normal min'],['NormMaxC','Normal max'],['NormMinRpm','Normal min'],['NormMaxRpm','Normal max'],['NormMinV','Normal min'],['NormMaxV','Normal max'],['BatStat','Battery state'],['BatExpr','Battery expiry'],['BatLife','Battery life'],['StatusDescr','Description']]) {
    if (schema.fields.some(f=>f.name===prefix+suffix)) columns.push([title,suffix==='BatStat' ? r=>badge(label(r,prefix+suffix)) : prefix+suffix]);
  }
  return tablePanel(def.label,'Inspect an entry for thresholds and all reported fields.',table,columns,data);
}

function health() {
  const s = snapshot.summary;
  const healthTables = schema.tables.filter(t=>t.group==='health' && !['scCtlrTable','scEnclTable','scScTable'].includes(t.name));
  return `<div class="stats-grid">${stat('Controller entries',integer(s.controllers),'Controller number and leader state','array')}${stat('Enclosures',integer(s.enclosures),'Chassis and expansion enclosures','disk')}${stat('Highest temperature',s.maxTempC == null ? '—' : `${decimal(s.maxTempC)}<small>°C</small>`,'Peak reported current sensor reading','temp')}${stat('Health issues',integer(s.issues.length),'Current component faults and active alerts','alert',s.issues.length?'warning':'ok')}</div>` +
    tablePanel('Controllers','Leader, management addresses, models, and service tags.','scCtlrTable',[['Controller','scCtlrName'],['Status',r=>badge(label(r,'scCtlrStatus'))],['Role',r=>label(r,'scCtlrLeader')==='true'?'<span class="tag">Leader</span>':'Peer'],['Model','scCtlrModel'],['Management IP','scCtlrIpAddr'],['Service tag','scCtlrServiceTag']]) +
    tablePanel('Enclosures','Storage chassis inventory.','scEnclTable',[['Enclosure','scEnclName'],['Status',r=>badge(label(r,'scEnclStatus'))],['Model','scEnclModel'],['Type','scEnclType'],['Service tag','scEnclServiceTag'],['Description','scEnclStatusDescr']]) +
    '<p class="inline-info">Battery expiry dates are displayed as reported. Health follows the current battery status supplied by the array.</p>' + healthTables.map(t=>genericHealth(t.name)).join('');
}

function volumes() {
  const count = rows('scObjCntTable')[0];
  return `<div class="stats-grid">${stat('Discovered volumes',integer(rows('scVolumeTable').length),'Entries returned by the volume table','volume')}${stat('Reported volume count',integer(val(count,'scObjCntVolumes')),'Storage center object-count summary','volume')}${stat('Replays',integer(val(count,'scObjCntReplays')),'Reported point-in-time replay count','clock')}${stat('Devices in use',integer(val(count,'scObjCntDevsInUse')),'Storage center device summary','array')}</div><p class="inline-info">The table inventory and object-count summary may differ. This MIB supplies volume names and health; per-volume capacity, IOPS, and latency are not exposed.</p>` +
    tablePanel('Volume inventory','All volume instances discovered by the agent.','scVolumeTable',[['Volume',r=>detailsButton('scVolumeTable',r,label(r,'scVolumeName'),'volume')],['Status',r=>badge(label(r,'scVolumeStatus'))],['SNMP number','scVolumeNbr'],['API index','scVolumeApiIndex']]);
}

function connectivity() {
  const sc = rows('scScTable')[0], servers = rows('scServerTable');
  return `<div class="stats-grid">${stat('Managed server entries',integer(servers.length),'Servers in the SNMP inventory','network')}${stat('Primary paths',integer(servers.reduce((n,r)=>n+num(val(r,'scServerPathCount')),0)),'Sum of reported primary paths','network')}${stat('Port balance',label(sc,'scScPortsBal')==='true'?'Balanced':label(sc,'scScPortsBal')==='false'?'Unbalanced':'Unknown','Storage center front-end ports','health',label(sc,'scScPortsBal')==='true'?'ok':'warning')}${stat('Connectivity issues',integer(servers.filter(r=>label(r,'scServerCnctvy') && label(r,'scServerCnctvy')!=='up').length),'Down or partially connected server entries','alert')}</div>` +
    tablePanel('Managed servers','Current connectivity and primary-path count.','scServerTable',[['Server',r=>detailsButton('scServerTable',r,label(r,'scServerName'),'network')],['Status',r=>badge(label(r,'scServerStatus'))],['Connectivity',r=>badge(label(r,'scServerCnctvy'))],['Primary paths','scServerPathCount'],['API index','scServerApiIndex']]) +
    tablePanel('Storage center','Management and port-balance information.','scScTable',[['Name','scScName'],['Status',r=>badge(label(r,'scScStatus'))],['Ports balanced',r=>badge(label(r,'scScPortsBal')==='true'?'Balanced':'Unbalanced',label(r,'scScPortsBal')==='true'?'ok':'warning')],['Management IP','scScMgmtIP'],['Serial','scScSerial'],['Location','scScLocation']]);
}

function alerts() {
  const all = rows('scAlertTable'), active = all.filter(r=>label(r,'scAlertActive')==='true'), data = alertMode==='active'?active:all;
  let intro = '';
  if (alertMode==='active' && !active.length) intro = `<div class="panel"><div class="panel-body"><div class="empty-alert"><span>${icon('check')}</span><div><h3>No active alerts reported</h3><p>Switch to All entries to inspect the ${all.length} current and historical controller alert entries.</p></div></div></div></div>`;
  return `<div class="stats-grid">${stat('Active entries',integer(active.length),'Alert-active flag is true','alert',active.length?'warning':'ok')}${stat('Unacknowledged active',integer(active.filter(r=>label(r,'scAlertAcknowledged')==='false').length),'Acknowledgment state reported by the array','alert')}${stat('All alert entries',integer(all.length),'Compound indexes preserve controller source','code')}${stat('Worst alert reference',esc(scalar('scLastWorstAlert') ?? '—'),'Dell global-status alert number','alert')}</div><p class="inline-info">Alerts are indexed by controller and alert number. Entries are preserved per controller; a shared condition can appear more than once. Activity and acknowledgment are read-only.</p>` + intro +
    tablePanel(alertMode==='active'?'Active alerts':'All alert entries','Severity codes are decoded with the Dell MIB, independently of hardware status codes.','scAlertTable',[
      ['Source',r=>`<span class="mono">Controller ${esc(r.index.split('.')[0])} / ${esc(r.index.split('.').slice(1).join('.'))}</span>`],['Severity',r=>badge(label(r,'scAlertStatus'))],['Category','scAlertCategory'],['Message','scAlertMessage'],['Created','scAlertCreateTime'],['Active',r=>badge(label(r,'scAlertActive')==='true'?'Active':'Cleared',label(r,'scAlertActive')==='true'?'warning':'unknown')],['Acknowledged',r=>esc(label(r,'scAlertAcknowledged')==='true'?'Yes':'No')]
    ],data,{empty:alertMode==='active'?'No active alert entries.':'No alert entries reported.'});
}

function chart(history, keys, unit) {
  if (history.length < 2) return '<div class="chart-placeholder">Collecting trend history…<br>Charts begin after two successful samples.</div>';
  const width=650,height=190,left=58,right=16,top=15,bottom=30,plotW=width-left-right,plotH=height-top-bottom;
  const times=history.map(p=>new Date(p.time).getTime()), first=times[0], last=times[times.length-1];
  const values=history.flatMap(p=>keys.map(k=>p[k]).filter(v=>v!=null));
  if (!values.length) return '<div class="chart-placeholder">No measured values yet.<br>Traffic requires two fresh counter samples.</div>';
  const high=Math.max(...values,1)*1.12;
  const x=i=>left+(times[i]-first)/Math.max(last-first,1)*plotW;
  const y=v=>top+plotH-num(v)/high*plotH;
  const tick=v=>unit==='bytes'?bytes(v,''):unit==='temp'?`${decimal(v,0)}°C`:`${decimal(v/1024,1)} TiB`;
  let svg=`<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(unit==='bytes'?'Management-interface traffic':unit==='temp'?'Maximum temperature':'Used capacity')} trend">`;
  for (let i=0;i<4;i++) { const v=high*i/3,py=y(v); svg+=`<line class="chart-grid" x1="${left}" x2="${width-right}" y1="${py}" y2="${py}"/><text class="chart-text" x="${left-8}" y="${py+3}" text-anchor="end">${esc(tick(v))}</text>`; }
  for (let k=0;k<keys.length;k++) {
    let path='',pen=false;
    history.forEach((p,i)=>{const gap=i>0 && times[i]-times[i-1] > snapshot.pollIntervalSeconds*3000+1000;if(p[keys[k]]==null){pen=false;return;}path+=`${pen&&!gap?'L':'M'}${x(i).toFixed(2)} ${y(p[keys[k]]).toFixed(2)} `;pen=true;});
    svg+=`<path class="chart-line ${k?'blue':''}" d="${path}"/>`;
  }
  const dateLabel=t=>new Date(t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  svg+=`<text class="chart-text" x="${left}" y="${height-6}">${esc(dateLabel(first))}</text><text class="chart-text" x="${width-right}" y="${height-6}" text-anchor="end">${esc(dateLabel(last))}</text></svg>`;
  return svg;
}

function performance() {
  const history=snapshot.history,last=history[history.length-1] || {};
  const span=history.length>1?`${decimal((new Date(last.time)-new Date(history[0].time))/60000,0)} minutes of history`:'Waiting for more samples';
  const traffic=panel('Management network traffic','Combined non-loopback interfaces · bytes per second',`<div class="panel-body"><div class="metric-pair"><div><span>RECEIVE</span><strong>${bytes(last.rxBytesPerSec)}</strong></div><div><span>TRANSMIT</span><strong>${bytes(last.txBytesPerSec)}</strong></div></div><div class="chart-legend"><span><span class="swatch"></span>Receive</span><span><span class="swatch blue"></span>Transmit</span></div>${chart(history,['rxBytesPerSec','txBytesPerSec'],'bytes')}<p class="chart-note">Rates use elapsed time between successful interface walks. Counter resets, agent restarts, and stale samples create gaps.</p></div>`);
  return `<div class="banner">${icon('chart')}This SNMP agent does not expose SAN IOPS, volume throughput, or latency. Network charts below measure the agent’s management interfaces.</div><div class="two-column"><div>${traffic}</div><div>${panel('Used storage trend',span,`<div class="panel-body">${chart(history,['usedGiB'],'capacity')}<p class="chart-note">Used space reported by disk folders. History is kept in memory and resets when the monitor restarts.</p></div>`)}</div></div>`+
    panel('Peak temperature trend',`${span} · highest current sensor reading`,`<div class="panel-body">${chart(history,['maxTempC'],'temp')}</div>`)+
    tablePanel('Agent network interfaces','Traffic counters may be 32-bit or 64-bit depending on agent support.','ifTable',[
      ['Interface',r=>esc(snapshot.interfaces.find(i=>i.index===r.index)?.name || label(r,'ifDescr'))],['Link',r=>badge(label(r,'ifOperStatus'))],['Speed',r=>`${decimal(num(val(r,'ifSpeed'))/1e6)} Mbit/s`],['Receive',r=>bytes(snapshot.interfaces.find(i=>i.index===r.index)?.rxBytesPerSec)],['Transmit',r=>bytes(snapshot.interfaces.find(i=>i.index===r.index)?.txBytesPerSec)],['Errors',r=>integer(snapshot.interfaces.find(i=>i.index===r.index)?.errors)],['Discards',r=>integer(snapshot.interfaces.find(i=>i.index===r.index)?.discards)]
    ]);
}

function explorer() {
  const data=objects.filter(o=>!query || `${o.name} ${o.oid} ${o.index} ${o.table} ${o.value} ${o.label || ''} ${fieldMap.get(o.name)?.description || ''}`.toLowerCase().includes(query.toLowerCase()));
  const pageSize=100,pages=Math.max(1,Math.ceil(data.length/pageSize));explorerPage=Math.min(explorerPage,pages-1);
  const body=`<div class="table-wrap"><table class="data-table"><thead><tr><th scope="col">Object / numeric OID</th><th scope="col">Instance</th><th scope="col">Value</th><th scope="col">Type</th><th scope="col">Details</th></tr></thead><tbody>${data.slice(explorerPage*pageSize,(explorerPage+1)*pageSize).map(o=>`<tr><td><span class="mono">${esc(o.name)}</span><span class="subtext mono">${esc(o.oid)}</span></td><td class="mono">${esc(o.index)}</td><td>${displayValue(o)}</td><td class="muted">${esc(o.type)}</td><td><button class="row-button" data-oid="${esc(o.oid)}">Inspect ${icon('code')}</button></td></tr>`).join('')}</tbody></table></div><div class="table-footer"><span>${integer(data.length)} matching objects · ${schema.fields.length} known definitions</span><div class="pagination"><button class="button" data-page="prev" ${explorerPage===0?'disabled':''}>Previous</button><span>${explorerPage+1} / ${pages}</span><button class="button" data-page="next" ${explorerPage===pages-1?'disabled':''}>Next</button></div></div>`;
  return panel('Collection sources','A failed source retains its previous complete sample. An empty optional subtree is unsupported.',`<div class="panel-body"><div class="source-list">${snapshot.sources.map(s=>`<div class="source-card"><div class="source-top"><strong>${esc(s.name)}</strong>${badge(s.error?'Failed':s.count?'Collected':'Not exposed',s.error?'warning':s.count?'ok':'unknown')}</div><div class="mono">${esc(s.root)}</div><p>${s.count} objects · ${s.durationMs}ms · updated ${timeAgo(s.updatedAt)}${s.error?`<br>${esc(s.error)}`:''}</p></div>`).join('')}</div></div>`)+
    '<p class="inline-info">Definitions are compiled from the supplied Dell MIB. Read-write objects are displayed for inspection; this application issues only GETBULK requests and has no write operations.</p>'+
    panel('Collected objects','Search names, values, OIDs, and MIB descriptions.',objects.length?body:`<div class="panel-body"><p class="inline-info">Loading collected objects…</p></div>`);
}

function renderNav() {
  const counts={storage:snapshot?.summary.disks,volumes:snapshot?.summary.volumes,alerts:snapshot?.summary.activeAlerts};
  $('nav').innerHTML=Object.entries(views).map(([id,[glyph]])=>`<a class="nav-link ${id===currentView?'active':''}" href="#${id}" ${id===currentView?'aria-current="page"':''}>${icon(glyph)}${navNames[id]}${counts[id]!=null?`<span class="nav-count">${counts[id]}</span>`:''}</a>`).join('');
}

function renderStatus() {
  if (!snapshot) return;
  const stale=isDate(snapshot.lastSuccess) && Date.now()-new Date(snapshot.lastSuccess).getTime() > (snapshot.pollIntervalSeconds*2+30)*1000;
  const failed=fetchError || snapshot.state==='error' || stale;
  $('live-status').className=`live-indicator ${failed?'error':snapshot.state==='ok'?'ok':''}`;
  $('live-status').innerHTML=`<span class="status-dot"></span>${failed?'Connection issue':snapshot.state==='ok'?'Live · '+snapshot.pollIntervalSeconds+'s polling':'Discovering'}`;
  $('updated').textContent=isDate(snapshot.lastSuccess)?`Updated ${timeAgo(snapshot.lastSuccess)}`:'Waiting for first sample';
  $('connection-banner').innerHTML=failed?`<div class="banner error">${icon('alert')}<strong>${fetchError?'Dashboard connection lost':snapshot.state==='error'?'SNMP collection failed':'The latest sample is stale'}.</strong> ${esc(fetchError || snapshot.error || 'No recent poll has completed.')} ${isDate(snapshot.lastSuccess)?`Showing the last complete Dell sample from ${esc(new Date(snapshot.lastSuccess).toLocaleString())}.`:'Waiting for the first successful SNMP walk.'}</div>`:snapshot.state==='starting'?'<div class="banner"><span class="loading-dot"></span>The first SNMP walk is running. Discovery can take up to the configured poll timeout.</div>':'';
  const optionalFailures=snapshot.sources.slice(1).filter(s=>s.error);
  if(!failed && optionalFailures.length) $('connection-banner').innerHTML+=`<div class="banner">${icon('alert')}Some optional sources failed: ${esc(optionalFailures.map(s=>s.name).join(', '))}. Check the MIB explorer for collection details.</div>`;
  $('footer-info').textContent=`${integer(snapshot.objectCount)} collected objects · Last success ${timeAgo(snapshot.lastSuccess)}`;
}

function render() {
  renderNav();
  const [,title,description]=views[currentView];
  $('page-title').textContent=title;$('page-description').textContent=description;
  $('page-eyebrow').textContent=currentView==='explorer'?'SNMP DISCOVERY':'STORAGE CENTER';
  $('view-tools').hidden=currentView==='overview';
  $('view-filters').innerHTML=currentView==='alerts'?`<label class="filter-group">Show <select id="alert-mode" aria-label="Alert activity filter"><option value="active" ${alertMode==='active'?'selected':''}>Active entries</option><option value="all" ${alertMode==='all'?'selected':''}>All entries</option></select></label>`:currentView==='health'?`<label class="filter-group">Sensors <select id="health-filter" aria-label="Sensor health filter"><option value="all" ${healthFilter==='all'?'selected':''}>All states</option><option value="issues" ${healthFilter==='issues'?'selected':''}>Faults only</option></select></label>`:'';
  if (!snapshot) return;
  renderStatus();
  const name=label(rows('scScTable')[0],'scScName') || scalar('sysName') || 'Compellent';
  $('side-name').textContent=name;$('breadcrumb-name').textContent=name;$('side-target').textContent=snapshot.target;
  if (!isDate(snapshot.lastSuccess)) {
    $('content').innerHTML=empty(snapshot.state==='error'?'Unable to collect SNMP data':'Discovering your storage center',snapshot.state==='error'?'The web service is running. Check target connectivity and the configured SNMP community. Collection retries automatically.':'The first walk is in progress. This page updates automatically.','array');
  } else {
    $('content').innerHTML=({overview,storage,health,volumes,connectivity,alerts,performance,explorer}[currentView])();
  }
  $('content').setAttribute('aria-busy','false');
}

function showDetails(table, index, oid) {
  let items=[],title='';
  if (oid) { const item=objects.find(o=>o.oid===oid);if(!item)return;items=[item];title=item.name; }
  else {
    const row=rows(table).find(r=>r.index===index);if(!row)return;
    items=Object.entries(row.values).map(([name,value])=>({...value,name,oid:`${fieldMap.get(name)?.oid || ''}.${index}`}));
    title=(schema.tables.find(t=>t.name===table)?.label || table)+' · '+index;
    if(table==='scDiskTable') {
      const config=rows('scDiskConfigTable').find(r=>String(val(r,'scDiskConfigNbr'))===String(val(row,'scDiskNbr')));
      if(config)items.push(...Object.entries(config.values).map(([name,value])=>({...value,name,oid:`${fieldMap.get(name)?.oid || ''}.${config.index}`})));
      title='Disk '+label(row,'scDiskNamePosition');
    }
  }
  $('detail-title').textContent=title;
  $('detail-body').innerHTML=items.map(o=>{const f=fieldMap.get(o.name);return `<div class="field-detail"><div class="field-detail-top"><strong class="mono">${esc(o.name)}</strong><span>${displayValue(o)}</span></div><div class="oid mono">${esc(o.oid)}</div><p>${esc(f?.description || 'No definition is present in the bundled MIB.')}</p>${f?.status==='deprecated'?'<p>Deprecated MIB object</p>':''}${f?.access==='read-write'?'<p>Read-write in the MIB · displayed read-only by this monitor</p>':''}</div>`;}).join('');
  $('detail').showModal();
}

async function fetchJSON(url) {
  const response=await fetch(url,{signal:AbortSignal.timeout(15000),cache:'no-store'});
  if(!response.ok)throw new Error(`HTTP ${response.status}`);
  return response.json();
}
async function update() {
  if(busy)return;busy=true;
  try {
    if(!schema) {schema=await fetchJSON('/api/schema');fieldMap=new Map(schema.fields.map(f=>[f.name,f]));}
    snapshot=await fetchJSON('/api/snapshot');fetchError='';
    if(currentView==='explorer' && rawStamp!==snapshot.lastAttempt) {objects=await fetchJSON('/api/objects');rawStamp=snapshot.lastAttempt;}
    render();
  } catch(error) {fetchError=error.name==='TimeoutError'?'The dashboard request timed out.':error.message;renderStatus();}
  finally {busy=false;}
}
function navigate() {
  const candidate=location.hash.slice(1);currentView=views[candidate]?candidate:'overview';query='';$('search').value='';explorerPage=0;render();
  if(currentView==='explorer')update();
}
$('search').addEventListener('input',event=>{query=event.target.value;explorerPage=0;render();});
$('refresh').addEventListener('click',update);
window.addEventListener('hashchange',navigate);
document.addEventListener('change',event=>{if(event.target.id==='alert-mode'){alertMode=event.target.value;render();}if(event.target.id==='health-filter'){healthFilter=event.target.value;render();}});
$('content').addEventListener('click',event=>{
  const target=event.target.closest('button');if(!target)return;
  if(target.dataset.table)showDetails(target.dataset.table,target.dataset.index);
  if(target.dataset.oid)showDetails(null,null,target.dataset.oid);
  if(target.dataset.page){explorerPage+=target.dataset.page==='next'?1:-1;render();}
});
$('close-detail').addEventListener('click',()=>$('detail').close());
$('detail').addEventListener('click',event=>{if(event.target===$('detail')){const r=$('detail').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)$('detail').close();}});

(async()=>{
  try {schema=await fetchJSON('/api/schema');fieldMap=new Map(schema.fields.map(f=>[f.name,f]));navigate();await update();}
  catch(error){$('content').innerHTML=empty('Dashboard initialization failed',error.message,'alert');}
  setInterval(update,5000);
  setInterval(renderStatus,1000);
})();
