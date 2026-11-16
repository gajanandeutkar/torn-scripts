// ==UserScript==
// @name         Better RR Mug Helper
// @version      7.4
// @description  RR mug helper with FFScouter, mug estimates, manual watch, sound toggle, history, and target alerts. Mobile layout fix and optional attack-tab preload.
// @author       dingus [3188789] modified by nosebleedb [4291486] and IceConqueror [4218513]
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        GM.openInTab
// @connect      api.torn.com
// @connect      ffscouter.com
// @run-at       document-idle
// @noframes
// @license      MIT
// @namespace    torn-rr-mug-helper-custom
// ==/UserScript==
// @ts-nocheck
(function () {
'use strict';
 
const isRRPage = () => {
    try {
        const u = new URL(location.href);
        return u.hostname === 'www.torn.com' && u.pathname === '/page.php' && u.searchParams.get('sid') === 'russianRoulette';
    } catch { return false; }
};
if (!isRRPage()) return;
 
const sel = p => `[class*="${p}___"]`;
const $ = (p, root = document) => root.querySelector(sel(p));
const $$ = (p, root = document) => root.querySelectorAll(sel(p));
const FF_BASE = 'https://ffscouter.com/api/v1';
const REFRESH_MS = 45000;
const TARGET_TTL = 5 * 60 * 1000;
 
const criteria = {
    apiKey: localStorage.getItem('rr_apiKey') || '',
    ffKey: localStorage.getItem('rr_ffKey') || '',
    maxFF: parseFloat(localStorage.getItem('rr_maxFF')) || 2.5,
    minDays: parseInt(localStorage.getItem('rr_minDays'), 10) || 15,
    minMoney: parseInt(localStorage.getItem('rr_minMoney'), 10) || 25000000,
    merits: parseInt(localStorage.getItem('rr_merits'), 10) || 0,
    plunder: parseInt(localStorage.getItem('rr_plunder'), 10) || 0,
    soundEnabled: localStorage.getItem('rr_soundEnabled') !== 'false'
};
 
const watchedUsers = new Map();
const statusCache = new Map();
const ffCache = new Map();
const pendingProfiles = new Set();
const pendingFF = new Set();
const history = [];
const manualWatch = loadManualWatch();
let processing = false;
let collapsed = false;
let soundBtn = null;
let statusLine = null;
 
function esc(v) {
    return String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}
function fmt(n) { return String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function ffColor(ff) {
    const n = Number(ff);
    if (!Number.isFinite(n)) return '#aaa';
    if (n <= 1) return '#4caf50';
    if (n <= 2) return '#8bc34a';
    if (n <= 3) return '#ffeb3b';
    if (n <= 5) return '#ff9800';
    return '#f44336';
}
function mugEstimate(bet, clothing) {
    const wallet = bet * 2;
    const mod = 1 + criteria.merits * 0.05 + criteria.plunder / 100;
    let min = wallet * 0.05 * mod;
    let max = wallet * 0.10 * mod;
    if (clothing) { min *= 0.25; max *= 0.25; }
    min = Math.floor(min); max = Math.floor(max);
    return { min, max, formatted: `$${(min/1e6).toFixed(1)}m-$${(max/1e6).toFixed(1)}m` };
}
 
function loadManualWatch() {
    try {
        const x = JSON.parse(localStorage.getItem('rr_manualWatchIds') || '[]');
        return new Set(Array.isArray(x) ? x.map(String) : []);
    } catch { return new Set(); }
}
function saveManualWatch() { localStorage.setItem('rr_manualWatchIds', JSON.stringify([...manualWatch])); }
function loadTargets() {
    try {
        const x = JSON.parse(localStorage.getItem('rr_active_targets') || '[]');
        return new Map(x.filter(([,d]) => d?.timestamp && Date.now() - d.timestamp < TARGET_TTL));
    } catch { return new Map(); }
}
function saveTargets(m) { localStorage.setItem('rr_active_targets', JSON.stringify([...m.entries()])); }
 
/* ---------- STYLE ---------- */
const style = document.createElement('style');
style.textContent = `
#rr-criteria-panel-wrapper{width:100%;margin-top:10px;box-sizing:border-box}#rr-criteria-panel-wrapper *{box-sizing:border-box}
.rr-box{width:100%;background:#272727;border:1px solid #4a4a4a;border-radius:5px;overflow:hidden;box-shadow:0 2px 7px rgba(0,0,0,.25);color:#ddd;font-family:Arial,sans-serif}
.rr-head{display:flex;align-items:center;justify-content:space-between;gap:10px;background:#111;padding:8px 10px;border-bottom:1px solid #444;font-size:13px;font-weight:bold}.rr-head-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.rr-link{font-size:10px;font-weight:normal;cursor:pointer;text-decoration:underline}
.rr-mini,.rr-sound{border:1px solid #555;background:#222;color:#ddd;height:22px;cursor:pointer;border-radius:3px;font-size:10px;padding:0 7px}.rr-mini{min-width:24px;padding:0}.rr-sound-on{color:#93c47d;border-color:#56794a}.rr-sound-off{color:#e06666;border-color:#7c4949}
.rr-body{padding:10px;background:#292929}.rr-section{margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid #444}.rr-title{color:#f2b124;font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:.5px;margin-bottom:7px}
.rr-deposits{display:flex;gap:7px}.rr-deposit{flex:1;min-width:90px;height:28px!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;color:#fff!important;text-decoration:none!important;font-size:11px!important}
.rr-controls{display:flex;align-items:center;flex-wrap:wrap;gap:8px 10px}.rr-control{display:flex;align-items:center;gap:4px}.rr-control label{color:#aaa;font-size:11px;white-space:nowrap}.rr-input{height:23px!important;padding:2px 5px!important;background:#111!important;color:#fff!important;border:1px solid #555!important;border-radius:2px!important;font-size:11px!important}#crit-api,#crit-ffkey{-webkit-text-security:disc}#crit-api:focus,#crit-ffkey:focus{-webkit-text-security:none}.rr-mode{margin-left:auto;color:#f2b124;font-size:10px;white-space:nowrap}
.rr-status{background:rgba(0,0,0,.25);color:#999;padding:5px 7px;border-radius:3px;font-size:10px;margin-bottom:10px}.rr-list{max-height:280px;overflow-y:auto;background:rgba(0,0,0,.2);border:1px solid #444;border-radius:3px}.rr-placeholder{padding:11px;color:#888;font-size:11px;text-align:center}
.rr-target{display:flex;align-items:center;gap:8px;padding:7px 8px;border-bottom:1px solid #444;font-size:11px;background:rgba(255,255,255,.035)}.rr-target:last-child{border-bottom:0}.rr-target-main{flex:1;min-width:0}.rr-target-details{display:flex;flex-wrap:wrap;gap:8px 12px;margin-top:3px}.rr-name{color:#ddd!important;text-decoration:none!important;font-weight:bold}.rr-name:hover{color:#f2b124!important;text-decoration:underline!important}.rr-bet{color:#93c47d;font-weight:bold}.rr-mugest,.rr-mode-label{color:#f2b124;font-weight:bold}.rr-extra{color:#aaa}.rr-cs{color:#e06666;font-weight:bold;font-size:10px}
.rr-btn{display:inline-flex!important;align-items:center!important;justify-content:center!important;padding:2px 8px!important;font-size:11px!important;cursor:pointer!important;height:24px!important;min-width:60px!important;text-decoration:none!important;color:#fff!important;flex:0 0 auto}.rr-history{display:none;margin-top:10px;border-top:1px dashed #555;padding-top:10px}.rr-history-list{max-height:180px;overflow-y:auto;background:rgba(0,0,0,.3);border:1px solid #3c3c3c;border-radius:3px}.rr-history-entry{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:5px 8px;border-bottom:1px solid #333;font-size:11px;color:#ccc}
.custom-api-data{color:#aaa;font-weight:bold;margin-right:10px;font-size:11px;white-space:nowrap}.rr-watch-control{display:inline-flex;align-items:center;gap:4px;margin-left:8px;padding-left:8px;border-left:1px solid rgba(255,255,255,.12);white-space:nowrap;font-size:9px;flex:0 0 auto}.rr-watch-label{min-width:40px;color:#777;font-weight:bold;text-align:right}.rr-watch-label.on{color:#f2b124}.rr-watch-check{width:14px;height:14px;accent-color:#93c47d;cursor:pointer;margin:0}.rr-auto{background:rgba(242,177,36,.12)!important;box-shadow:inset 0 0 10px rgba(242,177,36,.10)!important}.rr-manual{background:rgba(100,149,237,.11)!important;box-shadow:inset 0 0 10px rgba(100,149,237,.09)!important}
@keyframes rrflash{0%{background:rgba(242,177,36,.42)}100%{background:rgba(242,177,36,0)}}#rr-flash{position:fixed;inset:0;pointer-events:none;z-index:2147483646;opacity:0}#rr-flash.on{opacity:1;animation:rrflash 1.1s ease-out forwards}
@media(max-width:800px){.rr-mode{width:100%;margin-left:0}.rr-deposits{flex-wrap:wrap}}
/* mobile fix: keep helper info inside its own column so it can't cover the player name / profile link */
.custom-api-data{pointer-events:none}
.rr-watch-control{pointer-events:auto;position:relative;z-index:2}
@media(max-width:900px){
[class*="betBlock___"]{flex-wrap:wrap!important;min-width:0!important;height:auto!important;max-height:none!important;overflow:visible!important;row-gap:3px;padding-top:3px;padding-bottom:3px}
.custom-api-data{flex:1 1 100%!important;order:1;display:flex!important;flex-wrap:wrap;justify-content:flex-end;gap:1px 6px;white-space:normal!important;margin:0!important;font-size:10px!important;line-height:1.25;text-align:right}
.custom-api-data>span{margin-left:0!important}
.rr-watch-control{margin-left:10px!important;padding-left:10px!important}
.rr-watch-check{width:24px!important;height:24px!important}
.rr-watch-label{min-width:34px!important;font-size:10px!important}
}
`;
document.head.appendChild(style);
const flash = document.createElement('div'); flash.id = 'rr-flash'; document.body.appendChild(flash);
 
/* ---------- SOUND ---------- */
let audioCtx = null, audioUnlocked = false;
function getAudioCtx() {
    if (!audioCtx) {
        const C = window.AudioContext || window.webkitAudioContext;
        if (!C) return null;
        audioCtx = new C();
    }
    return audioCtx;
}
async function unlockAudio() {
    const c = getAudioCtx(); if (!c) return;
    try { if (c.state === 'suspended') await c.resume(); audioUnlocked = c.state === 'running'; } catch { audioUnlocked = false; }
    updateSoundButton(); updateStatus();
}
document.addEventListener('pointerdown', unlockAudio, {once:true});
document.addEventListener('keydown', unlockAudio, {once:true});
function tone(c,f,t,d,v,type='sine') {
    const o=c.createOscillator(), g=c.createGain(); o.type=type; o.frequency.setValueAtTime(f,t); g.gain.setValueAtTime(.0001,t); g.gain.exponentialRampToValueAtTime(v,t+.015); g.gain.setValueAtTime(v,Math.max(t+.016,t+d-.045)); g.gain.exponentialRampToValueAtTime(.0001,t+d); o.connect(g); g.connect(c.destination); o.start(t); o.stop(t+d+.02);
}
async function playAlert(force=false) {
    if (!force && !criteria.soundEnabled) return;
    const c=getAudioCtx(); if(!c)return;
    try {
        if(c.state==='suspended') await c.resume(); if(c.state!=='running') return; audioUnlocked=true;
        const t=c.currentTime+.02;
        tone(c,1047,t,.10,.14,'square'); tone(c,1319,t+.13,.10,.14,'square'); tone(c,659,t+.28,.14,.16,'triangle'); tone(c,880,t+.48,.20,.14,'square'); tone(c,1320,t+.48,.20,.08,'sine'); tone(c,1175,t+.73,.28,.16,'square'); tone(c,1760,t+.73,.28,.07,'sine');
    } catch(e) { console.warn('[RR Helper] audio error',e); }
}
function updateSoundButton() {
    if(!soundBtn)return;
    soundBtn.textContent = criteria.soundEnabled ? '🔊 Sound ON' : '🔇 Sound OFF';
    soundBtn.classList.toggle('rr-sound-on',criteria.soundEnabled); soundBtn.classList.toggle('rr-sound-off',!criteria.soundEnabled);
}
async function toggleSound(){ criteria.soundEnabled=!criteria.soundEnabled; localStorage.setItem('rr_soundEnabled',String(criteria.soundEnabled)); updateSoundButton(); if(criteria.soundEnabled){await unlockAudio();await playAlert(true);} updateStatus(); }
/* ---------- PRELOAD ATTACK PAGE ---------- */
let preloadOn = localStorage.getItem('rr_preloadAttack') === 'true';
let lastPreloadId = null, lastPreloadAt = 0;
function preloadAttack(id){
    if(!preloadOn) return;
    id = String(id);
    if(id === lastPreloadId && Date.now() - lastPreloadAt < 60000) return;
    lastPreloadId = id; lastPreloadAt = Date.now();
    const url = 'https://www.torn.com/page.php?sid=attack&user2ID=' + id;
    try {
        if (typeof GM_openInTab === 'function') { GM_openInTab(url, { active: false, insert: true, setParent: true }); return; }
        if (typeof GM !== 'undefined' && typeof GM.openInTab === 'function') { GM.openInTab(url, { active: false }); return; }
    } catch (e) { console.warn('[RR Helper] preload failed', e); }
    try { window.open(url, '_blank', 'noopener'); window.focus(); } catch (e) {}
}
function setPreload(on){ preloadOn = !!on; localStorage.setItem('rr_preloadAttack', String(preloadOn)); }

function targetAlert(){ playAlert(); flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on'); }
 
/* ---------- RR ROW DATA ---------- */
const getUserId = row => row.querySelector('a[href*="profiles.php?XID="]')?.href.match(/XID=(\d+)/)?.[1] || null;
const getName = row => row.querySelector('a[href*="profiles.php?XID="]')?.textContent?.trim() || 'Unknown';
function getBet(row) {
    const b=row.querySelector('[class*="betBlock"]'); if(!b)return 0;
    const c=b.cloneNode(true); c.querySelectorAll('.custom-api-data,.rr-watch-control').forEach(x=>x.remove());
    return parseInt(c.textContent.replace(/[^0-9]/g,''),10)||0;
}
function modeFor(id) {
    const d=watchedUsers.get(String(id)); if(!d)return null;
    if(d.auto&&d.manual)return 'AUTO+MANUAL'; if(d.manual)return 'MANUAL'; if(d.auto)return 'AUTO'; return null;
}
function watchRecord(row,id,source) {
    id=String(id); const s=statusCache.get(id)||{}, f=ffCache.get(id)||{};
    const d=watchedUsers.get(id)||{id,name:getName(row),betRaw:getBet(row),isClothingStore:false,daysPlayed:null,state:'Unknown',ff:null,auto:false,manual:false};
    d.name=getName(row); d.betRaw=getBet(row); d.isClothingStore=Boolean(s.isClothingStore??d.isClothingStore); d.daysPlayed=s.daysPlayed??d.daysPlayed; d.state=s.state??d.state; d.ff=f.fair_fight??d.ff;
    if(source==='auto')d.auto=true; if(source==='manual')d.manual=true; watchedUsers.set(id,d); return d;
}
function autoQualifies(id,bet) {
    id=String(id); const s=statusCache.get(id), f=ffCache.get(id); if(!s||!f)return false;
    const ff=Number(f.fair_fight); return Number.isFinite(ff)&&ff<=criteria.maxFF&&s.daysPlayed>=criteria.minDays&&bet>=criteria.minMoney;
}
function stopManual(id){id=String(id);manualWatch.delete(id);saveManualWatch();const d=watchedUsers.get(id);if(d){d.manual=false;if(!d.auto)watchedUsers.delete(id);}}
function setManual(id,on,row){id=String(id);if(on){manualWatch.add(id);saveManualWatch();if(row)watchRecord(row,id,'manual');}else stopManual(id);if(row)applyWatch(row,id,getBet(row));updateStatus();}
function ensureWatchControl(row,id) {
    const b=$('betBlock',row); if(!b)return;
    let w=b.querySelector('.rr-watch-control');
    if(!w){w=document.createElement('span');w.className='rr-watch-control';w.innerHTML='<span class="rr-watch-label">—</span><input class="rr-watch-check" type="checkbox" title="Manual watch: ignores FF / Days / Min Bet.">';b.appendChild(w);w.querySelector('input').addEventListener('change',()=>setManual(w.dataset.userId,w.querySelector('input').checked,row));}
    w.dataset.userId=String(id); w.querySelector('input').checked=manualWatch.has(String(id));
}
function updateWatchControl(row,id){const w=row.querySelector('.rr-watch-control');if(!w)return;const m=modeFor(id),l=w.querySelector('.rr-watch-label');w.querySelector('input').checked=manualWatch.has(String(id));l.textContent=m||'—';l.classList.toggle('on',!!m);}
function applyWatch(row,id,bet){id=String(id);const auto=autoQualifies(id,bet),manual=manualWatch.has(id);if(auto)watchRecord(row,id,'auto');if(manual)watchRecord(row,id,'manual');const d=watchedUsers.get(id);if(d&&!manual&&d.manual){d.manual=false;if(!d.auto)watchedUsers.delete(id);}const final=watchedUsers.get(id);row.classList.remove('rr-auto','rr-manual');if(final?.auto)row.classList.add('rr-auto');else if(final?.manual)row.classList.add('rr-manual');updateWatchControl(row,id);}
 
function dataHTML(s,f,mug){const hasS=!!s, hasF=f?.fair_fight!==undefined&&f?.fair_fight!==null;return `<span style="color:#fff">${hasS?s.daysPlayed+'d':'Days: ...'}</span><span style="color:${ffColor(f?.fair_fight)};margin-left:8px;font-weight:bold">FF: ${hasF?Number(f.fair_fight).toFixed(2):'N/A'}</span><span style="color:${hasS?s.color:'#aaa'};margin-left:8px">[${esc(hasS?s.state:'...')}]</span><span style="color:#f2b124;margin-left:12px">Mug: ${mug.formatted}</span>${s?.isClothingStore?' <span class="rr-cs">[CS]</span>':''}`;}
function renderRow(row,id){const span=row.querySelector('.custom-api-data');if(!span)return;const s=statusCache.get(String(id))||null,f=ffCache.get(String(id))||null,bet=getBet(row),m=mugEstimate(bet,!!s?.isClothingStore);span.innerHTML=dataHTML(s,f,m);applyWatch(row,id,bet);}
 
/* ---------- API ---------- */
function fetchProfile(id,cb){id=String(id);if(!criteria.apiKey){cb(null);return;}const old=statusCache.get(id);if(old&&Date.now()-old.timestamp<REFRESH_MS){cb(old);return;}if(pendingProfiles.has(id))return;pendingProfiles.add(id);GM_xmlhttpRequest({method:'GET',url:`https://api.torn.com/user/${id}?selections=profile&key=${encodeURIComponent(criteria.apiKey)}`,responseType:'text',timeout:12000,onload:r=>{pendingProfiles.delete(id);try{const d=JSON.parse(r.responseText);if(d.error){console.warn('[RR Helper] Torn API',d.error);cb(null);return;}const x={daysPlayed:Number(d.age)||0,state:d.status?.state||'Unknown',color:d.status?.color==='red'?'#e06666':'#93c47d',isClothingStore:d.job?.company_type===5,timestamp:Date.now()};statusCache.set(id,x);cb(x);}catch(e){console.error('[RR Helper] profile parse',e);cb(null);}},onerror:()=>{pendingProfiles.delete(id);cb(null);},ontimeout:()=>{pendingProfiles.delete(id);cb(null);}});}
function fetchFF(id,cb){id=String(id);if(!criteria.ffKey){cb(null);return;}if(ffCache.has(id)){cb(ffCache.get(id));return;}if(pendingFF.has(id))return;pendingFF.add(id);const q=new URLSearchParams({key:criteria.ffKey,targets:id});GM_xmlhttpRequest({method:'GET',url:`${FF_BASE}/get-stats?${q}`,timeout:12000,onload:r=>{pendingFF.delete(id);try{const d=JSON.parse(r.responseText);if(Array.isArray(d)&&d.length){const x={fair_fight:d[0].fair_fight??null};ffCache.set(id,x);cb(x);return;}}catch(e){console.error('[RR Helper] FF parse',e);}cb(null);},onerror:()=>{pendingFF.delete(id);cb(null);},ontimeout:()=>{pendingFF.delete(id);cb(null);}});}
 
function unclipRow(row){
    if(window.innerWidth>900)return;
    let n=row;
    for(let i=0;i<3&&n&&n!==document.body;i++){
        if(n.querySelectorAll&&n.querySelectorAll('[class*="topSection___"]').length>1)break;
        n.style.setProperty('height','auto','important');
        n.style.setProperty('max-height','none','important');
        n.style.setProperty('overflow','visible','important');
        n=n.parentElement;
    }
}
function updateRow(row){const id=getUserId(row);if(!id)return;row.dataset.userId=id;unclipRow(row);const sb=$('statusBlock',row);if(sb)sb.style.display='none';const b=$('betBlock',row);if(!b)return;b.style.display='flex';b.style.flex='1';b.style.justifyContent='flex-end';b.style.alignItems='center';let span=b.querySelector('.custom-api-data');if(!span){span=document.createElement('span');span.className='custom-api-data';span.textContent='[...]';b.prepend(span);}ensureWatchControl(row,id);if(manualWatch.has(String(id)))watchRecord(row,id,'manual');renderRow(row,id);fetchProfile(id,()=>renderRow(row,id));fetchFF(id,()=>renderRow(row,id));}
 
/* ---------- TARGETS / HISTORY ---------- */
function placeholder(){const l=document.getElementById('rr-targets-list');if(l&&!l.querySelector('.rr-target'))l.innerHTML='<div class="rr-placeholder">Targets will appear here when watched players leave the lobby.</div>';}
function renderHistory(){const c=document.getElementById('rr-history-list');if(!c)return;if(!history.length){c.innerHTML='<div class="rr-placeholder">No session history yet.</div>';return;}c.innerHTML='';[...history].reverse().forEach(x=>{const e=document.createElement('div');e.className='rr-history-entry';e.innerHTML=`<span><span style="color:#888">[${esc(x.time)}]</span> <a class="rr-name" href="https://www.torn.com/profiles.php?XID=${x.id}" target="_blank" rel="noopener">${esc(x.name)}</a> — $${fmt(x.betRaw)}</span><a class="torn-btn rr-btn" href="https://www.torn.com/profiles.php?XID=${x.id}" target="_blank" rel="noopener">VIEW</a>`;c.appendChild(e);});}
function addTarget(id,d,loading=false){id=String(id);const l=document.getElementById('rr-targets-list');if(!l||!d||l.querySelector(`[data-target-id="${id}"]`))return;if(l.querySelector('.rr-placeholder'))l.innerHTML='';const mug=mugEstimate(Number(d.betRaw)||0,!!d.isClothingStore);const time=loading?(d.timeStr||'--:--:--'):new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});if(!loading){d.timestamp=Date.now();d.timeStr=time;const t=loadTargets();t.set(id,d);saveTargets(t);history.push({...d,id,time});targetAlert();preloadAttack(id);}
const ff=Number.isFinite(Number(d.ff))?Number(d.ff).toFixed(2):'N/A',days=d.daysPlayed??'N/A',state=d.state||'Unknown',mode=d.watchMode||'AUTO';const e=document.createElement('div');e.className='rr-target';e.dataset.targetId=id;e.innerHTML=`<button class="torn-btn rr-btn rr-remove">REMOVE</button><div class="rr-target-main"><div><span style="color:#888">[${esc(time)}]</span> <a class="rr-name" href="https://www.torn.com/profiles.php?XID=${id}" target="_blank" rel="noopener">${esc(d.name)}</a>${d.isClothingStore?' <span class="rr-cs">[CS]</span>':''}</div><div class="rr-target-details"><span class="rr-bet">Bet: $${fmt(d.betRaw)}</span><span class="rr-mugest">Est. Mug: ${mug.formatted}</span><span class="rr-extra">FF: <b style="color:${ffColor(d.ff)}">${ff}</b></span><span class="rr-extra">Days: ${days}</span><span class="rr-extra">[${esc(state)}]</span><span class="rr-mode-label">${esc(mode)}</span></div></div><a class="torn-btn rr-btn rr-mug" href="https://www.torn.com/page.php?sid=attack&user2ID=${id}" target="_blank" rel="noopener">MUG</a>`;
const remove=()=>{const t=loadTargets();t.delete(id);saveTargets(t);e.remove();placeholder();updateStatus();};e.querySelector('.rr-remove').onclick=remove;e.querySelector('.rr-mug').onclick=()=>setTimeout(remove,0);l.prepend(e);}
 
/* ---------- PANEL ---------- */
function updateStatus(count=null){if(!statusLine)statusLine=document.getElementById('rr-status');if(!statusLine)return;if(count===null)count=$$('topSection').length;let a=0,m=0;for(const d of watchedUsers.values()){if(d.auto)a++;if(d.manual)m++;}const sound=!criteria.soundEnabled?'OFF':audioUnlocked?'ON':'ON / click once';statusLine.textContent=`Players: ${count} | Watching: ${watchedUsers.size} | Auto: ${a} | Manual: ${m} | Targets: ${loadTargets().size} | Torn API: ${criteria.apiKey?'SET':'NOT SET'} | FF: ${criteria.ffKey?'SET':'NOT SET'} | Sound: ${sound}`;updateSoundButton();}
function injectPanel(){if(document.getElementById('rr-criteria-panel-wrapper'))return;const anchor=$('createWrap');if(!anchor?.parentNode)return;const w=document.createElement('div');w.id='rr-criteria-panel-wrapper';w.className=anchor.className;w.innerHTML=`<div class="rr-box"><div class="rr-head"><span>RR Mug Helper</span><div class="rr-head-actions"><button id="rr-sound-btn" class="rr-sound" type="button"></button><span id="rr-history-toggle" class="rr-link" style="color:#f2b124">History</span><span id="rr-clear" class="rr-link" style="color:#aaa">Clear Targets</span><button id="rr-collapse" class="rr-mini" type="button">−</button></div></div><div id="rr-body" class="rr-body"><div class="rr-section"><div class="rr-title">Quick Deposit Links</div><div class="rr-deposits"><a class="torn-btn rr-deposit" href="https://www.torn.com/companies.php?step=your&type=1#/option=funds" target="_blank" rel="noopener">COMPANY</a><a class="torn-btn rr-deposit" href="https://www.torn.com/factions.php?step=your#/tab=armoury" target="_blank" rel="noopener">ARMORY</a><a class="torn-btn rr-deposit" href="https://www.torn.com/page.php?sid=stocks" target="_blank" rel="noopener">STOCKS</a></div></div><div class="rr-section"><div class="rr-controls">
<div class="rr-control"><label>RRMug Key:</label><input id="crit-api" class="rr-input" type="text" value="${esc(criteria.apiKey)}" style="width:100px" placeholder="Torn API"></div>
<div class="rr-control"><label>FF Key:</label><input id="crit-ffkey" class="rr-input" type="text" value="${esc(criteria.ffKey)}" style="width:100px" placeholder="FFScouter"></div>
<div class="rr-control"><label>Max FF:</label><input id="crit-maxff" class="rr-input" type="number" step="0.1" value="${criteria.maxFF}" style="width:50px"></div>
<div class="rr-control"><label>Min Days:</label><input id="crit-days" class="rr-input" type="number" min="0" value="${criteria.minDays}" style="width:55px"></div>
<div class="rr-control"><label>Min Bet:</label><input id="crit-money" class="rr-input" type="text" value="${fmt(criteria.minMoney)}" style="width:95px"></div>
<div class="rr-control"><label style="color:#f2b124">Merits:</label><input id="crit-merits" class="rr-input" type="number" min="0" max="10" value="${criteria.merits}" style="width:42px"></div>
<div class="rr-control"><label style="color:#f2b124">Plunder%:</label><input id="crit-plunder" class="rr-input" type="number" min="0" max="50" value="${criteria.plunder}" style="width:45px"></div>
<div class="rr-mode">Auto-Watch: ON | New Tabs: ON | Manual: ☑ | <label style="color:#f2b124;cursor:pointer"><input id="rr-preload-toggle" type="checkbox" ${preloadOn?'checked':''} style="vertical-align:middle"> Preload attack tab</label></div></div></div><div id="rr-status" class="rr-status">Starting RR scanner…</div><div class="rr-title">Targets</div><div id="rr-targets-list" class="rr-list"><div class="rr-placeholder">Targets will appear here when watched players leave the lobby.</div></div><div id="rr-history-panel" class="rr-history"><div class="rr-title">Session History</div><div id="rr-history-list" class="rr-history-list"></div></div></div></div>`;
anchor.parentNode.insertBefore(w,anchor.nextSibling);soundBtn=document.getElementById('rr-sound-btn');statusLine=document.getElementById('rr-status');updateSoundButton();loadTargets().forEach((d,id)=>addTarget(id,d,true));placeholder();soundBtn.onclick=toggleSound;document.getElementById('rr-preload-toggle').addEventListener('change',e=>setPreload(e.target.checked));document.getElementById('rr-clear').onclick=()=>{localStorage.removeItem('rr_active_targets');document.getElementById('rr-targets-list').innerHTML='<div class="rr-placeholder">Targets will appear here when watched players leave the lobby.</div>';updateStatus();};document.getElementById('rr-history-toggle').onclick=()=>{const p=document.getElementById('rr-history-panel');p.style.display=p.style.display==='block'?'none':'block';if(p.style.display==='block')renderHistory();};document.getElementById('rr-collapse').onclick=()=>{collapsed=!collapsed;document.getElementById('rr-body').style.display=collapsed?'none':'block';document.getElementById('rr-collapse').textContent=collapsed?'+':'−';};
const refresh=()=>{const oldA=criteria.apiKey,oldF=criteria.ffKey;criteria.apiKey=document.getElementById('crit-api').value.trim();criteria.ffKey=document.getElementById('crit-ffkey').value.trim();criteria.maxFF=parseFloat(document.getElementById('crit-maxff').value)||2.5;criteria.minDays=parseInt(document.getElementById('crit-days').value,10)||0;criteria.minMoney=parseInt(document.getElementById('crit-money').value.replace(/[^0-9]/g,''),10)||0;criteria.merits=parseInt(document.getElementById('crit-merits').value,10)||0;criteria.plunder=parseInt(document.getElementById('crit-plunder').value,10)||0;localStorage.setItem('rr_apiKey',criteria.apiKey);localStorage.setItem('rr_ffKey',criteria.ffKey);localStorage.setItem('rr_maxFF',criteria.maxFF);localStorage.setItem('rr_minDays',criteria.minDays);localStorage.setItem('rr_minMoney',criteria.minMoney);localStorage.setItem('rr_merits',criteria.merits);localStorage.setItem('rr_plunder',criteria.plunder);if(oldA!==criteria.apiKey)statusCache.clear();if(oldF!==criteria.ffKey)ffCache.clear();$$('topSection').forEach(updateRow);updateStatus();};['crit-api','crit-ffkey','crit-maxff','crit-days','crit-money','crit-merits','crit-plunder'].forEach(id=>document.getElementById(id).addEventListener('input',e=>{if(id==='crit-money')e.target.value=fmt(e.target.value.replace(/[^0-9]/g,''));refresh();}));updateStatus();}
 
/* ---------- MAIN ---------- */
function processLobby(){if(document.hidden||processing||!isRRPage())return;processing=true;try{injectPanel();const rows=$$('topSection'),ids=new Set();rows.forEach(row=>{const id=getUserId(row);if(!id)return;ids.add(String(id));updateRow(row);const d=watchedUsers.get(String(id));if(d){d.name=getName(row);d.betRaw=getBet(row);const s=statusCache.get(String(id)),f=ffCache.get(String(id));if(s){d.isClothingStore=!!s.isClothingStore;d.daysPlayed=s.daysPlayed;d.state=s.state;}if(f)d.ff=f.fair_fight;}});for(const [id,d] of [...watchedUsers.entries()]){if(ids.has(id))continue;d.watchMode=d.auto&&d.manual?'AUTO+MANUAL':d.manual?'MANUAL':'AUTO';addTarget(id,d);watchedUsers.delete(id);if(manualWatch.has(id)){manualWatch.delete(id);saveManualWatch();}}updateStatus(rows.length);}finally{processing=false;}}
function init(){const root=document.querySelector('.content-wrapper')||document.body;let queued=false;new MutationObserver(()=>{if(queued)return;queued=true;setTimeout(()=>{queued=false;processLobby();},100);}).observe(root,{childList:true,subtree:true});setInterval(processLobby,3000);processLobby();}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
