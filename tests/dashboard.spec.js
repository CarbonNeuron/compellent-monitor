const { test, expect } = require('@playwright/test');

const v = (value, label, unit) => ({value,label,unit});
const row = (index, values) => ({index,values});
function fixture() {
  const now = Date.now(), time = new Date(now).toISOString();
  const tables = {
    scScTable: [row('1',{scScName:v('Test SC7020'),scScStatus:v(1,'up'),scScPortsBal:v(1,'true'),scScMgmtIP:v('192.0.2.70'),scScSerial:v(1)})],
    scCtlrTable: [row('1',{scCtlrName:v('Top Controller'),scCtlrStatus:v(1,'up'),scCtlrLeader:v(1,'true'),scCtlrModel:v('SC7020'),scCtlrIpAddr:v('192.0.2.71'),scCtlrServiceTag:v('TEST')})],
    scEnclTable: [row('1',{scEnclNbr:v(1),scEnclName:v('Enclosure 1'),scEnclStatus:v(1,'up'),scEnclModel:v('SC7020')})],
    scDiskTable: [row('1',{scDiskNbr:v(1),scDiskNamePosition:v('01-01'),scDiskStatus:v(1,'up'),scDiskHealthy:v(1,'true'),scDiskEnclosure:v(1),scDiskSize:v(1200,'','GB'),scDiskIoPortType:v(4,'sas')})],
    scDiskConfigTable:[row('1',{scDiskConfigNbr:v(1),scDiskConfigModel:v('Example disk'),scDiskConfigSerial:v('TEST-123')})],
    scDiskFolderTable:[row('2',{scDiskFolderNbr:v(2),scDiskFolderName:v('Assigned'),scDiskFolderStatus:v(1,'up'),scDiskFolderAlrtThr:v(10)})],
    scDiskFolderSUTable:[row('2',{scDiskFolderSUNbr:v(2),scDiskFolderSUTotalSpace2:v(1024,'','GiB'),scDiskFolderSUUsedSpace2:v(256,'','GiB'),scDiskFolderSUAllocSpace:v(512,'','GiB'),scDiskFolderSUFreeSpace:v(412,'','GiB'),scDiskFolderSUSpareSpace:v(100,'','GiB')})],
    scVolumeTable:[row('1',{scVolumeName:v('Production volume'),scVolumeStatus:v(1,'up'),scVolumeNbr:v(1),scVolumeApiIndex:v(101)}),row('2',{scVolumeName:v('<img src=x onerror=alert(1)>'),scVolumeStatus:v(2,'down'),scVolumeNbr:v(2),scVolumeApiIndex:v(102)})],
    scObjCntTable:[row('1',{scObjCntVolumes:v(2),scObjCntServers:v(1),scObjCntReplays:v(3),scObjCntDevsInUse:v(2)})],
    scServerTable:[row('1',{scServerName:v('Server A'),scServerStatus:v(1,'up'),scServerCnctvy:v(1,'up'),scServerPathCount:v(4)})],
    scCacheTable:[row('1',{scCacheName:v('Cache'),scCacheStatus:v(1,'up'),scCacheBatStat:v(1,'normal'),scCacheBatExpr:v('2023-04-17T00:00:00-05:00')})],
    scCtlrTempTable:[row('1.1',{scCtlrTempName:v('CPU'),scCtlrTempStatus:v(1,'up'),scCtlrTempCurrentC:v(40,'','°C'),scCtlrTempNormMaxC:v(70,'','°C')})],
    scAlertTable:[row('1.1',{scAlertStatus:v(1,'critical'),scAlertActive:v(2,'false'),scAlertMessage:v('Historical alert'),scAlertAcknowledged:v(1,'true')}),row('2.1',{scAlertStatus:v(2,'degraded'),scAlertActive:v(1,'true'),scAlertMessage:v('Check connectivity'),scAlertAcknowledged:v(2,'false')})],
    ifTable:[row('1',{ifDescr:v('em0'),ifOperStatus:v(1,'up'),ifSpeed:v(1000000000),ifInOctets:v(1000),ifOutOctets:v(2000)})],
  };
  return {
    target:'192.0.2.70',pollIntervalSeconds:30,state:'ok',lastAttempt:time,lastSuccess:time,objectCount:100,
    sources:[{name:'Dell Storage Center',root:'.1.3.6.1.4.1.674',count:90,durationMs:100,updatedAt:time},{name:'SNMP system',root:'.1.3.6.1.2.1.1',count:8,durationMs:10,updatedAt:time},{name:'Management interfaces',root:'.1.3.6.1.2.1.2',count:2,durationMs:10,updatedAt:time},{name:'Extended interfaces',root:'.1.3.6.1.2.1.31',count:0,durationMs:10,updatedAt:time}],
    scalars:{productIDGlobalStatus:v(3,'ok'),productIDVersion:v('07.04.21'),productIDSerialNumber:v('TEST'),sysUpTime:v(8640000),scLastWorstAlert:v(0)},tables,
    summary:{status:'critical',globalStatus:'ok',disks:1,healthyDisks:1,volumes:2,servers:1,controllers:1,enclosures:1,activeAlerts:1,totalGiB:1024,usedGiB:256,allocatedGiB:512,freeGiB:412,spareGiB:100,maxTempC:40,issues:[]},
    interfaces:[{index:'1',name:'em0',status:'up',speed:1000000000,rxBytesPerSec:1000,txBytesPerSec:2000,errors:0,discards:0}],
    history:[{time:new Date(now-30000).toISOString(),usedGiB:250,maxTempC:39,rxBytesPerSec:null,txBytesPerSec:null},{time,usedGiB:256,maxTempC:40,rxBytesPerSec:1000,txBytesPerSec:2000}],
  };
}
async function setup(page, override) {
  const data = {...fixture(),...override};
  await page.route('**/api/snapshot', route=>route.fulfill({json:data}));
  await page.route('**/api/objects', route=>route.fulfill({json:[{name:'scCtlrTempCurrentC',oid:'.1.3.6.1.4.1.674.11000.2000.500.1.2.19.1.5.1.1',index:'1.1',table:'scCtlrTempTable',type:'Gauge32',value:40,unit:'°C'}]}));
  return data;
}

test('all dashboard views render under the real CSP without script errors',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await setup(page);await page.goto('/');await expect(page.getByRole('heading',{name:'Array overview',exact:true})).toBeVisible();
  await expect(page.locator('.disk')).toHaveCount(1);
  for(const [nav,title] of [['storage','Physical storage'],['health','System health'],['volumes','Volumes'],['connectivity','Connectivity'],['alerts','Alerts'],['performance','Performance'],['explorer','MIB explorer']]) {
    await page.locator(`#nav a[href="#${nav}"]`).click();
    await expect(page.getByRole('heading',{name:title,exact:true}).first()).toBeVisible();
  }
  await expect(page.locator('.data-table tbody tr')).toHaveCount(1);
  await expect(page.locator('#content')).toContainText('scCtlrTempCurrentC');
  expect(errors).toEqual([]);
});

test('disk details include configuration and close with Escape',async({page})=>{
  await setup(page);await page.goto('/');await page.locator('.disk').click();
  await expect(page.getByRole('dialog')).toBeVisible();await expect(page.locator('#detail-body')).toContainText('TEST-123');
  await expect(page.locator('#detail-body')).toContainText('scDiskConfigSerial');await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('volume search filters rows and agent HTML is rendered as text',async({page})=>{
  await setup(page);await page.goto('/#volumes');await expect(page.locator('.data-table tbody tr')).toHaveCount(2);
  await expect(page.locator('#content img')).toHaveCount(0);await expect(page.locator('#content')).toContainText('<img src=x onerror=alert(1)>');
  await page.getByRole('searchbox').fill('Production');await expect(page.locator('.data-table tbody tr')).toHaveCount(1);
  await page.getByRole('searchbox').fill('does-not-exist');await expect(page.locator('#content')).toContainText('No entries match your search.');
});

test('alert activity filter keeps historical severity separate',async({page})=>{
  await setup(page);await page.goto('/#alerts');await expect(page.locator('.data-table tbody tr')).toHaveCount(1);
  await expect(page.locator('#content')).toContainText('Check connectivity');await expect(page.locator('.data-table')).not.toContainText('Historical alert');
  await page.getByLabel('Alert activity filter').selectOption('all');await expect(page.locator('.data-table tbody tr')).toHaveCount(2);
});

test('SNMP failure displays cached data and a clear stale banner',async({page})=>{
  await setup(page,{state:'error',error:'request timeout'});await page.goto('/');
  await expect(page.locator('#connection-banner')).toContainText('SNMP collection failed');await expect(page.locator('#connection-banner')).toContainText('last complete Dell sample');
  await expect(page.locator('.disk')).toHaveCount(1);
});

test('first failed poll shows the actionable empty state',async({page})=>{
  await setup(page,{state:'error',error:'timeout',lastSuccess:'0001-01-01T00:00:00Z'});await page.goto('/');
  await expect(page.getByRole('heading',{name:'Unable to collect SNMP data'})).toBeVisible();await expect(page.locator('#content')).toContainText('Collection retries automatically.');
});

test('mobile layout remains inside the viewport and navigation works',async({page})=>{
  await page.setViewportSize({width:390,height:844});await setup(page);await page.goto('/');await expect(page.locator('.disk')).toHaveCount(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.getByRole('link',{name:'Performance',exact:true}).click();await expect(page.getByRole('heading',{name:'Performance',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
