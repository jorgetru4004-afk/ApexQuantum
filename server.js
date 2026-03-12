// ═══════════════════════════════════════════════════════════════
//  APEX QUANTUM — 24/7 AI Crypto Trading Server
//  Built with every lesson learned from APEX AI BRAIN stocks
//  Deploy to Railway.app
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const cron      = require('node-cron');
const axios     = require('axios');
const fs        = require('fs');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 8080;

// ── ENVIRONMENT ──
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY  || '';
const COINBASE_KEY    = process.env.COINBASE_API_KEY    || '';
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK     || '';
const SHEETS_WEBHOOK  = process.env.SHEETS_WEBHOOK      || '';

// ── DATA PERSISTENCE ──
const DATA_DIR      = path.join(__dirname, 'data');
const TRADES_FILE   = path.join(DATA_DIR, 'trades.json');
const PATTERNS_FILE = path.join(DATA_DIR, 'patterns.json');
const ROSTER_FILE   = path.join(DATA_DIR, 'roster.json');
const STATE_FILE    = path.join(DATA_DIR, 'state.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('Save error:', e.message); }
}

// ── SETTINGS ──
const SETTINGS = {
  stopLoss:       5,    // tighter for crypto volatility
  takeProfit:     8,
  budget:         200,
  dailyLossLimit: 150,
  maxDailyTrades: 20,   // crypto never sleeps
  maxBots:        10,
  minBots:        3,
  trailingStop:   true, // trailing stop for big moves
  trailingPct:    3,
};

// ── RESTORE SAVED STATE ──
const savedState    = loadJSON(STATE_FILE, {});
let totalPnl        = savedState.totalPnl    || 0;
let totalTrades     = savedState.totalTrades || 0;
let totalWins       = savedState.totalWins   || 0;
let dailyPnl        = savedState.dailyPnl    || 0;
let dailyTrades     = 0;
let dailyLoss       = 0;

// ── COIN ROSTER ──
let coins = loadJSON(ROSTER_FILE, ['BTC','ETH','SOL','DOGE','PEPE']);
let tradeJournal = loadJSON(TRADES_FILE, []);
let patternData  = loadJSON(PATTERNS_FILE, { patterns:{}, totalDecisions:0 });

// ── COIN DATA ──
const COIN_DEFAULTS = {
  BTC:  { name:'Bitcoin',   price:67420,  avgVol:28000000000, color:'#f7931a', sector:'Store of Value' },
  ETH:  { name:'Ethereum',  price:3541,   avgVol:14000000000, color:'#627eea', sector:'Smart Contract' },
  SOL:  { name:'Solana',    price:178,    avgVol:3200000000,  color:'#9945ff', sector:'Layer 1' },
  DOGE: { name:'Dogecoin',  price:0.1823, avgVol:1800000000,  color:'#c2a633', sector:'Meme' },
  PEPE: { name:'Pepe',      price:0.0000132, avgVol:900000000, color:'#3cb371', sector:'Meme' },
  WIF:  { name:'dogwifhat', price:2.84,   avgVol:600000000,   color:'#ff6b9d', sector:'Meme' },
  BONK: { name:'Bonk',      price:0.0000298, avgVol:400000000, color:'#ff8c00', sector:'Meme' },
  AVAX: { name:'Avalanche', price:36.4,   avgVol:800000000,   color:'#e84142', sector:'Layer 1' },
  LINK: { name:'Chainlink', price:14.2,   avgVol:600000000,   color:'#2a5ada', sector:'Oracle' },
  ARB:  { name:'Arbitrum',  price:1.12,   avgVol:400000000,   color:'#28a0f0', sector:'Layer 2' },
};

let COINS       = {};
let bots        = {};
let hist        = {};
let vols24h     = {};
let aiDecisions = {};
let coinHealth  = {};
let rotationLog = [];
let whaleAlerts = [];
let newsItems   = [];
let fearGreed   = { value: 50, label: 'Neutral', color: '#fbbf24' };
let coinbaseConnected = false;
let lastAnalyzeTime   = null;
let lastRotateTime    = null;
let lastScanTime      = null;

function initCoin(sym) {
  const d = COIN_DEFAULTS[sym] || {
    name: sym, price: parseFloat((Math.random()*100+0.001).toFixed(6)),
    avgVol: Math.floor(Math.random()*500000000+50000000),
    color: '#00f5ff', sector: 'Discovery'
  };
  const p = d.price * (1 + (Math.random()-0.5)*0.02);
  COINS[sym] = {
    sym, name:d.name, price:parseFloat(p.toFixed(8)),
    open: parseFloat((p*0.98).toFixed(8)),
    prev: parseFloat((p*0.97).toFixed(8)),
    high24: parseFloat((p*1.05).toFixed(8)),
    low24:  parseFloat((p*0.94).toFixed(8)),
    change24: parseFloat((Math.random()*20-8).toFixed(2)),
    color: d.color, sector: d.sector, avgVol: d.avgVol,
    marketCap: d.avgVol * 24,
    fundingRate: parseFloat((Math.random()*0.02-0.005).toFixed(4)),
    whaleScore: Math.floor(Math.random()*100),
  };
  hist[sym] = [];
  let hp = p * 0.94;
  for (let i = 0; i < 100; i++) {
    hp = Math.max(0.000001, hp * (1 + (Math.random()-0.49)*0.012));
    hist[sym].push(parseFloat(hp.toFixed(8)));
  }
  hist[sym].push(COINS[sym].price);
  vols24h[sym] = Math.floor(d.avgVol * (0.8 + Math.random()*0.4));
  bots[sym] = {
    on:true, status:'WATCHING', pos:0, entry:0, pnl:0,
    trades:0, wins:0, halted:false,
    vwap: COINS[sym].price, vS: COINS[sym].price, vC:1,
    highWater: COINS[sym].price,
    pattern:'NONE', aiApproved:null, allocated:0,
    sizingLabel:'FULL', confidence:0,
    trailingHigh: 0,
  };
  coinHealth[sym] = { score:50, noTradeCount:0 };
}

coins.forEach(sym => initCoin(sym));

// ── WEBSOCKET BROADCAST ──
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(msg); } catch(e) {}
    }
  });
}

wss.on('connection', ws => {
  console.log('📱 Dashboard connected');
  ws.send(JSON.stringify({ type:'SNAPSHOT', data: getSnapshot() }));
});

function getSnapshot() {
  return {
    coins, COINS, bots, hist, vols24h, aiDecisions,
    coinHealth, rotationLog, whaleAlerts, newsItems, fearGreed,
    totalPnl, totalTrades, totalWins, dailyPnl,
    tradeJournal: tradeJournal.slice(0,100),
    patternData, SETTINGS, coinbaseConnected,
    lastAnalyzeTime, lastRotateTime, lastScanTime,
    serverTime: new Date().toISOString()
  };
}

// ── SAVE STATE ──
function saveState() {
  saveJSON(STATE_FILE, { totalPnl, totalTrades, totalWins, dailyPnl });
}

// ── PRICE SIMULATION ──
function simulatePrices() {
  coins.forEach(sym => {
    const c = COINS[sym];
    if (!c) return;
    // Crypto more volatile — ±1.5% per tick
    const volatility = ['PEPE','BONK','WIF','DOGE'].includes(sym) ? 0.018 : 0.008;
    const chg = (Math.random()-0.488) * volatility;
    c.price = Math.max(0.000001, parseFloat((c.price*(1+chg)).toFixed(8)));
    c.change24 = parseFloat(((c.price-c.prev)/c.prev*100).toFixed(2));
    if (c.price > c.high24) c.high24 = c.price;
    if (c.price < c.low24)  c.low24  = c.price;
    hist[sym].push(c.price);
    if (hist[sym].length > 200) hist[sym].shift();
    vols24h[sym] = Math.floor(c.avgVol * (0.7 + Math.random()*0.6));
    const b = bots[sym];
    b.vC++; b.vS += c.price;
    b.vwap = parseFloat((b.vS/b.vC).toFixed(8));
    if (b.on && !b.halted) runBotLogic(sym);
  });
  broadcast('PRICES', {
    prices:  Object.fromEntries(coins.map(s=>[s, COINS[s]?.price])),
    changes: Object.fromEntries(coins.map(s=>[s, COINS[s]?.change24])),
    vols:    Object.fromEntries(coins.map(s=>[s, vols24h[s]])),
    bots:    Object.fromEntries(coins.map(s=>[s, bots[s]])),
    totalPnl, totalTrades, totalWins, dailyPnl, fearGreed
  });
}

// ── SIGNALS ──
function getSignals(sym) {
  const h = hist[sym], c = COINS[sym], b = bots[sym];
  if (!h || h.length < 20) return { rsi:50, volR:1, momentum:50, macd:0, bb:50, pattern:{name:'NONE',signal:'WAIT'} };
  // RSI
  let g=0, l=0;
  for (let i=h.length-14; i<h.length; i++) {
    const d = h[i]-(h[i-1]||h[i]);
    if (d>0) g+=d; else l-=d;
  }
  const rsi = Math.round(100-100/(1+(g/(l||0.001))));
  // Volume ratio
  const volR = parseFloat((vols24h[sym]/(c.avgVol||1)).toFixed(2));
  // Momentum
  const mom = Math.min(100,Math.max(0,Math.round(50+(c.price-c.open)/(c.open||1)*500)));
  // MACD simplified
  const ema12 = h.slice(-12).reduce((a,b)=>a+b,0)/12;
  const ema26 = h.slice(-26).reduce((a,b)=>a+b,0)/Math.min(26,h.length);
  const macd  = parseFloat(((ema12-ema26)/ema26*100).toFixed(3));
  // Bollinger
  const mean = h.slice(-20).reduce((a,b)=>a+b,0)/20;
  const std  = Math.sqrt(h.slice(-20).map(x=>(x-mean)**2).reduce((a,b)=>a+b,0)/20);
  const bb   = std>0 ? Math.round((c.price-mean)/std*50+50) : 50;
  // Funding rate signal
  const funding = c.fundingRate || 0;
  // Pattern
  const patterns = ['BREAKOUT','BULL FLAG','CUP & HANDLE','ASCENDING TRIANGLE','VWAP RECLAIM','PUMP DETECTED','ACCUMULATION','NONE'];
  const pi = h[h.length-1]>h[h.length-5] ? Math.floor(Math.random()*6) : 7;
  return { rsi, volR, momentum:mom, macd, bb,
           funding: parseFloat((funding*100).toFixed(4)),
           pattern:{ name:patterns[pi], signal:pi<6?'BUY':'WAIT' }};
}

function getPositionSize(sym) {
  const dec = aiDecisions[sym];
  const conf = dec?.confidence || 50;
  const budget = SETTINGS.budget;
  let pct, label;
  if (conf>=90)      { pct=1.00; label='FULL'; }
  else if (conf>=75) { pct=0.75; label='75%'; }
  else if (conf>=60) { pct=0.50; label='50%'; }
  else               { pct=0.25; label='25%'; }
  return { dollars:parseFloat((budget*pct).toFixed(2)), pct, label, conf };
}

// ── BOT LOGIC ──
function runBotLogic(sym) {
  if (dailyTrades >= SETTINGS.maxDailyTrades) return;
  if (dailyLoss   >= SETTINGS.dailyLossLimit) return;
  const c = COINS[sym], b = bots[sym];
  const sg = getSignals(sym);

  // EXIT with trailing stop
  if (b.pos > 0) {
    if (c.price > b.trailingHigh) b.trailingHigh = c.price;
    const pctFromHigh  = (b.trailingHigh - c.price) / b.trailingHigh * 100;
    const pctFromEntry = (c.price - b.entry) / b.entry * 100;
    const trailingHit  = SETTINGS.trailingStop && pctFromHigh >= SETTINGS.trailingPct && pctFromEntry > 0;
    if (pctFromEntry <= -SETTINGS.stopLoss || pctFromEntry >= SETTINGS.takeProfit || trailingHit) {
      const pnl = parseFloat((b.pos*(c.price-b.entry)).toFixed(4));
      b.pnl += pnl; totalPnl = parseFloat((totalPnl+pnl).toFixed(4));
      dailyPnl = parseFloat((dailyPnl+pnl).toFixed(4));
      dailyTrades++; b.trades++; totalTrades++;
      if (pnl>0) { b.wins++; totalWins++; }
      else { dailyLoss += Math.abs(pnl); }
      const reason = trailingHit?'TRAIL':pnl>0?'TARGET':'STOP';
      b.pos=0; b.entry=0; b.trailingHigh=0; b.status='WATCHING';
      const trade = logTrade(sym, b.entry||c.price, c.price, b.allocated, pnl, reason, sg);
      sendDiscordTrade(trade);
      learnFromTrade(sym, trade, aiDecisions[sym]);
      saveState();
      broadcast('TRADE', { trade, bot:bots[sym], totalPnl, totalTrades, totalWins, dailyPnl });
    } else {
      b.status = pctFromEntry > 2 ? '🚀 RIPPING' : pctFromEntry > 0 ? '📈 HOLD' : '⚠️ HOLD';
    }
    return;
  }

  // ENTRY
  const basicReady = sg.rsi < 70 && sg.volR > 1.1 && sg.momentum > 45 && sg.macd > -0.5;
  if (!basicReady) { b.status='WATCHING'; return; }
  const dec = aiDecisions[sym];
  if (!dec || dec.verdict!=='YES') { b.status=dec?'AI SKIP':'WAITING AI'; return; }

  const sizing = getPositionSize(sym);
  b.pos          = parseFloat((sizing.dollars/c.price).toFixed(6));
  b.entry        = c.price;
  b.trailingHigh = c.price;
  b.allocated    = sizing.dollars;
  b.sizingLabel  = sizing.label;
  b.confidence   = sizing.conf;
  b.status       = '⚡ ENTERING';
  b.pattern      = sg.pattern.name;
  b.aiApproved   = true;
  console.log(`⚡ ENTRY: ${sym} @ $${c.price} · ${sizing.label} ($${sizing.dollars}) · ${sizing.conf}% conf`);
  sendDiscordAlert(`⚡ **${sym} ENTRY** @ $${c.price}\n💰 Size: ${sizing.label} ($${sizing.dollars}) · ${sizing.conf}% confidence\n📊 Pattern: ${sg.pattern.name}\n📈 MACD: ${sg.macd} · RSI: ${sg.rsi}`);
  broadcast('ENTRY', { sym, price:c.price, sizing, bot:bots[sym] });
}

// ── TRADE LOGGING ──
function logTrade(sym, entry, exit, allocated, pnl, reason, sg) {
  const trade = {
    id: tradeJournal.length+1, sym, entry, exit, allocated, pnl, reason,
    pattern: sg?.pattern?.name||'—',
    rsi: sg?.rsi||0, macd: sg?.macd||0,
    aiVerdict: aiDecisions[sym]?.verdict||'—',
    aiConf: aiDecisions[sym]?.confidence||0,
    fearGreed: fearGreed.value,
    date: new Date().toLocaleDateString(),
    time: new Date().toLocaleTimeString()
  };
  tradeJournal.unshift(trade);
  if (tradeJournal.length>500) tradeJournal.pop();
  saveJSON(TRADES_FILE, tradeJournal);
  if (SHEETS_WEBHOOK) syncSheets(trade).catch(()=>{});
  return trade;
}

// ── PATTERN LEARNING ──
function learnFromTrade(sym, trade, aiDec) {
  if (!aiDec) return;
  const key = `${trade.pattern}_${sym}_${aiDec.verdict}`;
  if (!patternData.patterns[key]) patternData.patterns[key]={wins:0,losses:0,totalPnl:0,avgConf:0,count:0};
  const p=patternData.patterns[key]; p.count++;
  if (trade.pnl>0) p.wins++; else p.losses++;
  p.totalPnl=parseFloat((p.totalPnl+trade.pnl).toFixed(4));
  p.avgConf=parseFloat(((p.avgConf*(p.count-1)+(aiDec.confidence||0))/p.count).toFixed(1));
  patternData.totalDecisions++;
  saveJSON(PATTERNS_FILE, patternData);
}

// ── FEAR & GREED INDEX ──
async function fetchFearGreed() {
  try {
    const resp = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout:5000 });
    const val  = parseInt(resp.data?.data?.[0]?.value||50);
    const label= resp.data?.data?.[0]?.value_classification||'Neutral';
    fearGreed = {
      value: val,
      label,
      color: val<25?'#ff2d55':val<45?'#ff8c00':val<55?'#fbbf24':val<75?'#00ff88':'#00f5ff'
    };
    broadcast('FEAR_GREED', fearGreed);
    console.log(`😨 Fear & Greed: ${val} (${label})`);
  } catch(e) {
    fearGreed = { value: Math.floor(Math.random()*100), label:'Simulated', color:'#fbbf24' };
  }
}

// ── WHALE ALERT SIMULATION ──
function generateWhaleAlert() {
  const whaleCoins  = ['BTC','ETH','SOL','DOGE','PEPE'];
  const sym         = whaleCoins[Math.floor(Math.random()*whaleCoins.length)];
  const amount      = Math.floor(Math.random()*50000000+1000000);
  const types       = ['🐋 WHALE BUY','🐋 WHALE SELL','💎 LARGE TRANSFER','🔥 EXCHANGE INFLOW','📤 EXCHANGE OUTFLOW'];
  const type        = types[Math.floor(Math.random()*types.length)];
  const isBullish   = type.includes('BUY')||type.includes('OUTFLOW');
  const alert = {
    sym, type, amount,
    amountStr: amount >= 1000000 ? `$${(amount/1000000).toFixed(1)}M` : `$${(amount/1000).toFixed(0)}K`,
    bullish: isBullish,
    time: new Date().toLocaleTimeString(),
    impact: amount > 10000000 ? 'HIGH' : amount > 3000000 ? 'MEDIUM' : 'LOW'
  };
  whaleAlerts.unshift(alert);
  if (whaleAlerts.length > 30) whaleAlerts.pop();
  broadcast('WHALE_ALERT', { alert, whaleAlerts });
  if (alert.impact==='HIGH') {
    sendDiscordAlert(`🐋 **WHALE ALERT — ${sym}**\n${type}: ${alert.amountStr}\n📊 Impact: ${alert.impact} · ${isBullish?'🟢 BULLISH':'🔴 BEARISH'}`);
    // Boost coin momentum on whale buy
    if (isBullish && COINS[sym]) {
      COINS[sym].whaleScore = Math.min(100, (COINS[sym].whaleScore||0)+20);
    }
  }
}

// ── CLAUDE AI BRAIN ──
async function askAI(sym) {
  if (!ANTHROPIC_KEY) {
    aiDecisions[sym] = { verdict:'NO', reason:'No API key', confidence:0, sym, time:new Date().toLocaleTimeString() };
    return;
  }
  const c  = COINS[sym], sg = getSignals(sym), b = bots[sym];
  const fg  = fearGreed.value;
  const whaleScore = c.whaleScore || 50;

  const patternHistory = Object.entries(patternData.patterns)
    .filter(([k])=>k.includes(sym)||k.includes(sg.pattern.name))
    .slice(0,3).map(([k,v])=>`${k}: ${v.wins}W/${v.losses}L $${(v.totalPnl/v.count).toFixed(2)}/trade`)
    .join(', ')||'No history yet';

  const prompt = `You are an elite crypto trading AI. Analyze and respond in JSON only.

Asset: ${sym} (${c.name}, ${c.sector})
Price: $${c.price} (${c.change24}% 24h)
RSI: ${sg.rsi} | MACD: ${sg.macd} | Bollinger: ${sg.bb}/100
Volume: ${sg.volR}x avg | Momentum: ${sg.momentum}/100
Pattern: ${sg.pattern.name} | VWAP: ${c.price>b.vwap?'ABOVE':'BELOW'}
Funding Rate: ${sg.funding}% (negative=bullish, positive=bearish)
Whale Score: ${whaleScore}/100
Fear & Greed Index: ${fg}/100 (${fearGreed.label})
Historical patterns: ${patternHistory}
Bot win rate: ${b.trades>0?Math.round(b.wins/b.trades*100):'N/A'}%

Respond in JSON only:
{"verdict":"YES" or "NO","confidence":0-100,"reason":"2-3 sentences","entry":price,"stop":price,"target":price,"risk":"LOW|MEDIUM|HIGH","timeframe":"1H|4H|1D"}`;

  try {
    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model:'claude-sonnet-4-6', max_tokens:400,
      messages:[{role:'user',content:prompt}]
    }, { headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'} });
    const txt  = resp.data?.content?.[0]?.text||'{}';
    const dec  = JSON.parse(txt.replace(/```json|```/g,'').trim());
    dec.sym    = sym; dec.time = new Date().toLocaleTimeString();
    aiDecisions[sym] = dec;
    console.log(`🧠 ${sym}: ${dec.verdict} (${dec.confidence}%) — ${dec.reason?.slice(0,60)}`);
    broadcast('AI_DECISION', { sym, decision:dec });
    if (dec.verdict==='YES') {
      sendDiscordAlert(`🧠 **AI APPROVED: ${sym}**\n💡 ${dec.reason}\n🎯 Entry $${dec.entry} · Stop $${dec.stop} · Target $${dec.target}\n📊 ${dec.confidence}% conf · Risk: ${dec.risk} · TF: ${dec.timeframe}`);
    }
  } catch(e) {
    console.error(`AI error ${sym}:`, e.message);
    aiDecisions[sym] = { verdict:'ERROR', reason:'Server AI error', confidence:0, sym, time:new Date().toLocaleTimeString() };
  }
}

async function analyzeAllCoins() {
  console.log(`🧠 Analyzing ${coins.length} coins...`);
  lastAnalyzeTime = new Date();
  for (const sym of [...coins]) {
    // Skip if decision is fresh (under 4 min) and no open position
    const dec = aiDecisions[sym];
    const b   = bots[sym];
    if (dec && dec.verdict !== 'ERROR' && dec.verdict !== 'THINKING' && b && b.pos === 0) {
      const decTime = new Date().toDateString() + ' ' + (dec.time || '');
      const age = Date.now() - new Date(decTime).getTime();
      if (age < 240000) continue; // still fresh — skip API call
    }
    await askAI(sym);
    await sleep(600);
  }
  broadcast('ANALYZE_COMPLETE', { count:coins.length, time:lastAnalyzeTime });
}

// ── CRYPTO DISCOVERY ──
async function discoverCoins(scanType) {
  if (!ANTHROPIC_KEY) return;
  const existing = coins.join(', ');
  const scanMap = {
    momentum: 'top momentum crypto with massive volume spikes in the last 24 hours',
    meme:     'trending meme coins with viral potential — new launches, social media buzz',
    defi:     'DeFi tokens with strong fundamentals and recent protocol upgrades',
    whale:    'coins with unusual whale accumulation and large wallet movements detected',
    full:     'top 5 crypto opportunities right now — one each: momentum, meme, DeFi, whale play, wildcard gem'
  };
  const prompt = `You are an elite crypto scanner AI. Currently tracking: ${existing}. Fear & Greed: ${fearGreed.value} (${fearGreed.label}).

Find 5 NEW opportunities for: ${scanMap[scanType]||scanMap.full}

Return ONLY JSON array: [{"sym":"TICKER","name":"Coin Name","price":float,"sector":"sector","score":0-100,"catalyst":"specific reason why now","tags":["TAG"],"ai_verdict":"YES" or "WATCH","confidence":0-100,"entry":float,"stop":float,"target":float,"risk":"LOW|MEDIUM|HIGH"}]

Use real existing crypto tickers. Be specific about catalysts.`;

  try {
    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model:'claude-sonnet-4-6', max_tokens:1000,
      messages:[{role:'user',content:prompt}]
    }, { headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'} });
    const txt     = resp.data?.content?.[0]?.text||'[]';
    const results = JSON.parse(txt.replace(/```json|```/g,'').trim());
    broadcast('DISCOVERY_RESULTS', { results, scanType });
    for (const r of results) {
      if (r.ai_verdict==='YES' && !coins.includes(r.sym) && coins.length < SETTINGS.maxBots) {
        autoAddCoin(r); await sleep(300);
      }
    }
    return results;
  } catch(e) { console.error('Discovery error:', e.message); return []; }
}

// ── ROSTER MANAGEMENT ──
function autoAddCoin(disc) {
  const sym = disc.sym;
  if (coins.includes(sym)) return;
  const colors = ['#00f5ff','#7c3aed','#f59e0b','#ff2d55','#00ff88','#ff6b9d','#06d6a0','#ff8c00'];
  const p = parseFloat(disc.price)||parseFloat((Math.random()*100+0.001).toFixed(6));
  COIN_DEFAULTS[sym] = {
    name: disc.name||sym, price:p,
    avgVol: Math.floor(Math.random()*500000000+50000000),
    color: colors[coins.length%colors.length], sector: disc.sector||'Discovery'
  };
  initCoin(sym);
  if (disc.ai_verdict) {
    aiDecisions[sym] = { sym, verdict:disc.ai_verdict, confidence:disc.confidence||70,
      reason:disc.catalyst||'AI-discovered setup', entry:disc.entry, stop:disc.stop, target:disc.target,
      time:new Date().toLocaleTimeString() };
  }
  coins.push(sym);
  addRotationLog('ADD', sym, disc.catalyst?.slice(0,60)||'AI-selected gem');
  saveJSON(ROSTER_FILE, coins);
  console.log(`➕ Added ${sym}`);
  sendDiscordAlert(`➕ **NEW BOT: ${sym}** (${disc.name||sym})\n🚀 ${disc.catalyst||'AI-selected'}\n🎯 Entry $${disc.entry} · Target $${disc.target}`);
  broadcast('COIN_ADDED', { sym, coin:COINS[sym], bot:bots[sym] });
}

function dropCoin(sym, reason) {
  if (coins.length<=SETTINGS.minBots) return false;
  if (bots[sym]?.pos>0) return false;
  coins = coins.filter(s=>s!==sym);
  delete COINS[sym]; delete bots[sym]; delete hist[sym];
  delete vols24h[sym]; delete aiDecisions[sym]; delete coinHealth[sym];
  addRotationLog('REMOVE', sym, reason);
  saveJSON(ROSTER_FILE, coins);
  console.log(`➖ Dropped ${sym}: ${reason}`);
  sendDiscordAlert(`➖ **DROPPED: ${sym}**\n❌ ${reason}`);
  broadcast('COIN_REMOVED', { sym, reason });
  return true;
}

function scoreCoinHealth() {
  coins.forEach(sym => {
    const b=bots[sym], c=COINS[sym];
    if (!b||!c) return;
    const wr  = b.trades>0?b.wins/b.trades:0.5;
    const act = b.trades>0?Math.min(1,b.trades/8):0.3;
    const sg  = getSignals(sym);
    const sig = (sg.momentum+sg.bb)/200;
    const mom = c.change24>5?1:c.change24>0?0.6:c.change24>-5?0.3:0.1;
    const whale = (c.whaleScore||50)/100*0.2;
    const aiB = aiDecisions[sym]?.verdict==='YES'?0.15:aiDecisions[sym]?.verdict==='NO'?-0.15:0;
    const score = Math.max(0,Math.min(100,Math.round((wr*0.3+act*0.2+sig*0.2+mom*0.15+whale+aiB)*100)));
    if (!coinHealth[sym]) coinHealth[sym]={score:50,noTradeCount:0};
    coinHealth[sym].score=score;
    coinHealth[sym].noTradeCount = b.trades===0?(coinHealth[sym].noTradeCount||0)+1:0;
  });
}

async function rotateRoster() {
  console.log('🔄 Rotating crypto roster...');
  lastRotateTime = new Date();
  scoreCoinHealth();
  const toDrop=[];
  coins.slice().forEach(sym=>{
    const h=coinHealth[sym], b=bots[sym];
    if (!b||b.pos>0) return;
    const dead = (h?.noTradeCount||0)>20&&b.trades===0;
    const poor = b.trades>=5&&(b.wins/b.trades)<0.3;
    const aiNo = aiDecisions[sym]?.verdict==='NO'&&(h?.noTradeCount||0)>8;
    if ((dead||poor||aiNo)&&coins.length-toDrop.length>SETTINGS.minBots)
      toDrop.push({sym,reason:dead?'No activity':poor?'Win rate < 30%':'AI kept rejecting'});
  });
  for (const d of toDrop) { dropCoin(d.sym, d.reason); await sleep(400); }
  if (toDrop.length>0||coins.length<4) await findReplacements(Math.max(toDrop.length,4-coins.length));
  broadcast('ROSTER_UPDATE', { coins, coinHealth, rotationLog });
}

async function findReplacements(count) {
  if (!ANTHROPIC_KEY) return;
  const prompt = `Find ${count} replacement crypto coins to trade. Currently tracking: ${coins.join(', ')}. Need high momentum coins with active catalysts right now. Return ONLY JSON array: [{"sym":"TICKER","name":"Name","price":float,"sector":"sector","score":0-100,"catalyst":"specific reason","ai_verdict":"YES","confidence":0-100,"entry":float,"stop":float,"target":float}]`;
  try {
    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model:'claude-sonnet-4-6', max_tokens:600,
      messages:[{role:'user',content:prompt}]
    }, { headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'} });
    const list = JSON.parse((resp.data?.content?.[0]?.text||'[]').replace(/```json|```/g,'').trim());
    for (const r of list) {
      if (!coins.includes(r.sym)&&coins.length<SETTINGS.maxBots) { autoAddCoin(r); await sleep(300); }
    }
  } catch(e) { console.error('Replacement error:', e.message); }
}

function addRotationLog(action, sym, reason) {
  rotationLog.unshift({ time:new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}), action, sym, reason });
  if (rotationLog.length>50) rotationLog.pop();
}

// ── DISCORD ──
async function sendDiscordAlert(message) {
  if (!DISCORD_WEBHOOK) return;
  try {
    await axios.post(DISCORD_WEBHOOK, {
      username:'⚡ APEX QUANTUM',
      embeds:[{ description:message, color:0x00f5ff, timestamp:new Date().toISOString(),
        footer:{ text:`APEX QUANTUM · 24/7 · ${coins.length} bots · F&G: ${fearGreed.value} ${fearGreed.label}` } }]
    });
  } catch(e) {}
}

async function sendDiscordTrade(trade) {
  if (!DISCORD_WEBHOOK) return;
  const win = trade.pnl>0;
  const wr  = totalTrades>0?Math.round(totalWins/totalTrades*100):0;
  await sendDiscordAlert(
    `${win?'✅':'❌'} **${trade.sym} ${trade.reason}**\n`+
    `💰 P&L: ${win?'+':''}\$${trade.pnl.toFixed(4)} · Conf: ${trade.aiConf}%\n`+
    `📊 Pattern: ${trade.pattern} · RSI: ${trade.rsi} · MACD: ${trade.macd}\n`+
    `😨 Fear & Greed at trade: ${trade.fearGreed}/100\n`+
    `📈 Session: ${win?'+':''}\$${dailyPnl.toFixed(4)} · ${wr}% WR (${totalTrades} total)`
  );
}

async function sendDailyReport() {
  const wr = totalTrades>0?Math.round(totalWins/totalTrades*100):0;
  const top = Object.entries(patternData.patterns)
    .sort(([,a],[,b])=>(b.wins/b.count||0)-(a.wins/a.count||0))
    .slice(0,3).map(([k,v])=>`${k}: ${Math.round(v.wins/v.count*100)}% WR`)
    .join(', ')||'Not enough data';
  await sendDiscordAlert(
    `📊 **DAILY QUANTUM REPORT — ${new Date().toLocaleDateString()}**\n\n`+
    `💰 Today P&L: ${dailyPnl>=0?'+':''}\$${dailyPnl.toFixed(4)}\n`+
    `📈 All-time P&L: ${totalPnl>=0?'+':''}\$${totalPnl.toFixed(4)}\n`+
    `🎯 Win Rate: ${wr}% (${totalWins}W / ${totalTrades-totalWins}L)\n`+
    `😨 Fear & Greed: ${fearGreed.value}/100 (${fearGreed.label})\n`+
    `🤖 Active Bots: ${coins.length}\n`+
    `🧠 Top Patterns: ${top}`
  );
  dailyTrades=0; dailyLoss=0; dailyPnl=0;
  saveState();
}

async function weeklyPatternReview() {
  if (!ANTHROPIC_KEY||Object.keys(patternData.patterns).length<10) return;
  const summary = Object.entries(patternData.patterns).slice(0,20)
    .map(([k,v])=>`${k}: ${v.wins}W/${v.losses}L avgPnL $${(v.totalPnl/v.count).toFixed(4)} avgConf ${v.avgConf}%`)
    .join('\n');
  try {
    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model:'claude-sonnet-4-6', max_tokens:400,
      messages:[{role:'user',content:`You are an AI crypto trading coach. Review this bot's performance:\n${summary}\n\nGive 3 specific actionable insights in under 150 words. Focus on crypto-specific improvements.`}]
    }, { headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'} });
    const insight = resp.data?.content?.[0]?.text||'';
    await sendDiscordAlert(`🧠 **WEEKLY PATTERN REVIEW**\n\n${insight}`);
    broadcast('PATTERN_INSIGHT', { insight, patternData });
  } catch(e) {}
}

// ── GOOGLE SHEETS ──
async function syncSheets(trade) {
  if (!SHEETS_WEBHOOK) return;
  const row=[trade.date,trade.time,trade.sym,trade.entry,trade.exit,trade.allocated,trade.pnl,trade.reason,trade.pattern,trade.rsi,trade.macd,trade.aiVerdict,trade.aiConf,trade.fearGreed];
  await axios.post(SHEETS_WEBHOOK,{values:[row]},{headers:{'Content-Type':'application/json'}});
}

// ── HELPERS ──
function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

// ── CRON SCHEDULE ──
setInterval(simulatePrices, 3000);
setInterval(analyzeAllCoins, 300000); // 5 min — saves API tokens
setInterval(rotateRoster, 300000);
setInterval(()=>discoverCoins('full'), 600000);
setInterval(fetchFearGreed, 300000);
setInterval(()=>{
  if (Math.random()<0.15) generateWhaleAlert(); // 15% chance every 30s
}, 30000);
setInterval(saveState, 60000);

// Daily report midnight UTC
cron.schedule('0 0 * * *', sendDailyReport);
// Weekly pattern review Sunday 8pm ET
cron.schedule('0 20 * * 0', weeklyPatternReview, { timezone:'America/New_York' });
// Daily whale scan 5am ET
cron.schedule('0 5 * * *', async()=>{
  await sendDiscordAlert('🌅 **DAILY SCAN STARTING** — 5:00am\n🔍 AI hunting opportunities...');
  await discoverCoins('full');
  await analyzeAllCoins();
  await sendDiscordAlert('✅ **DAILY SCAN COMPLETE** — Bots loaded and ready');
}, { timezone:'America/New_York' });

// ── REST API ──
app.get('/api/status', (req,res) => {
  res.json({ status:'running', coins:coins.length, totalPnl, totalTrades, totalWins, dailyPnl,
    fearGreed, coinbaseConnected, uptime:process.uptime(),
    lastAnalyze:lastAnalyzeTime, lastRotate:lastRotateTime });
});
app.get('/api/trades', (req,res) => {
  res.json({ trades:tradeJournal.slice(0,100), totalPnl, totalTrades, totalWins, dailyPnl });
});
app.get('/api/patterns', (req,res) => res.json(patternData));
app.post('/api/settings', (req,res) => {
  Object.assign(SETTINGS, req.body);
  broadcast('SETTINGS', SETTINGS);
  res.json({ ok:true, settings:SETTINGS });
});
app.post('/api/analyze-now', async(req,res) => {
  res.json({ ok:true });
  await analyzeAllCoins();
});
app.post('/api/rotate-now', async(req,res) => {
  res.json({ ok:true });
  await rotateRoster();
});
app.post('/api/scan-now', async(req,res) => {
  const {type}=req.body;
  res.json({ ok:true });
  await discoverCoins(type||'full');
});
app.post('/api/add-coin', (req,res) => {
  const {sym}=req.body;
  if (!sym||coins.includes(sym)) return res.json({ok:false,reason:'already tracking'});
  autoAddCoin({sym:sym.toUpperCase(),price:1,sector:'Manual',catalyst:'Manually added',ai_verdict:'WATCH',confidence:50});
  res.json({ok:true,coins});
});
app.post('/api/remove-coin', (req,res) => {
  const {sym,reason}=req.body;
  const ok=dropCoin(sym,reason||'Manually removed');
  res.json({ok,coins});
});
app.get('/', (req,res) => res.sendFile(path.join(__dirname,'index.html')));

// ── START ──
server.listen(PORT, async()=>{
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║      APEX QUANTUM CRYPTO SERVER      ║');
  console.log('║      24/7 AI Trading Engine          ║');
  console.log(`║      Port: ${PORT}                       ║`);
  console.log('╚══════════════════════════════════════╝');
  console.log('');
  console.log(`⚡ Tracking: ${coins.join(', ')}`);
  console.log(`🧠 Claude AI: ${ANTHROPIC_KEY?'✅':'❌ No key'}`);
  console.log(`💬 Discord: ${DISCORD_WEBHOOK?'✅':'❌ No webhook'}`);
  console.log(`📊 All-time P&L: $${totalPnl.toFixed(4)} (${totalTrades} trades)`);
  console.log('');
  await fetchFearGreed();
  await sleep(1000);
  await analyzeAllCoins();
  generateWhaleAlert();
  sendDiscordAlert(
    `🚀 **APEX QUANTUM SERVER STARTED**\n`+
    `⚡ ${coins.length} bots: ${coins.join(', ')}\n`+
    `🧠 Claude AI: ${ANTHROPIC_KEY?'✅':'❌'}\n`+
    `😨 Fear & Greed: ${fearGreed.value}/100 (${fearGreed.label})\n`+
    `💰 All-time P&L: $${totalPnl.toFixed(4)}\n`+
    `⏰ Analyze 2m · Rotate 5m · Scan 10m · Daily scan 5am ET`
  );
  console.log('✅ APEX QUANTUM running — all systems go');
});

process.on('uncaughtException', e=>console.error('Uncaught:',e.message));
process.on('unhandledRejection', e=>console.error('Unhandled:',e?.message||e));
