import { CONFIG } from './src/config.js';
import { newGame } from './src/sim/gameState.js';
import { createRng } from './src/rng.js';
import * as day from './src/sim/day.js';
import * as logistics from './src/sim/logistics.js';
import { restock } from './src/sim/economy.js';

const gs = newGame(42);
console.log('street keys:', Object.keys(CONFIG.street).join(','));
console.log('doorBoxSlots len:', CONFIG.street.doorBoxSlots.length, 'first:', JSON.stringify(CONFIG.street.doorBoxSlots[0]));
console.log('displayCap:', CONFIG.shelf.displayCap, 'slotsPerShelf:', CONFIG.shelf.slotsPerShelf, 'truckEta:', CONFIG.logistics.truckEta);
console.log('inv:', JSON.stringify(gs.inventory));
console.log('skus:', Object.keys(gs.skus).length, 'shelfSlots:', gs.shelfSlots.length);
console.log('boba backroom:', gs.skus.boba_tea.backroom, 'cat_cafe backroom:', gs.skus.cat_cafe.backroom);
console.log('phase:', gs.phase, 'selfServiceAfter:', CONFIG.checkout.selfServiceAfter);

// 冒烟：一天完整跑通（PREP → OPEN → CLOSING）
const rng = createRng(42);
day.applyMorningActions(gs, { orders: { snacks: 8, boardgame_low: 8, merch: 4 } }, rng);
console.log('after order inv:', JSON.stringify(gs.inventory), 'cash:', gs.cash);
day.rollDailyEvent(gs, rng);
let session = day.startPrepSession(gs, rng);
session.autoStock = true; // headless 虚拟搬运工
console.log('PREP started, deliveries:', gs.logistics.deliveries.length, 'eta:', gs.logistics.deliveries[0]?.eta);
let guard = 0;
while (gs.phase === 'PREP' && guard < 10000) { day.stepSession(session, gs, rng, CONFIG.tick); guard++; }
console.log('after PREP: phase:', gs.phase, 'boxes:', gs.logistics.boxes.length, 'inv:', JSON.stringify(gs.inventory));
console.log('invariant ok:', logistics.stockInvariantOk(gs));
guard = 0;
while (gs.phase === 'OPEN' && guard < 200000) { day.stepSession(session, gs, rng, CONFIG.tick); guard++; }
console.log('after OPEN: phase:', gs.phase, 'footfall:', gs.today.footfall, 'bought:', gs.today.bought, 'lost:', gs.today.lost, 'revenue:', gs.today.revenue);
console.log('inv:', JSON.stringify(gs.inventory), 'invariant:', logistics.stockInvariantOk(gs));
day.closeOutDay(gs);
const report = (await import('./src/sim/economy.js')).settleDay(gs);
console.log('settled day:', report.day, 'cash:', report.cash, 'rep:', report.reputation, 'net:', report.net);
