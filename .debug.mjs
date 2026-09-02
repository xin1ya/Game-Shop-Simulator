import { CONFIG } from './src/config.js';
import { newGame } from './src/sim/gameState.js';
import { createRng } from './src/rng.js';
import * as day from './src/sim/day.js';
import * as logistics from './src/sim/logistics.js';

const gs = newGame(42);
const rng = createRng(42);
day.applyMorningActions(gs, { orders: { snacks: 8 } }, rng);
day.rollDailyEvent(gs, rng);
let session = day.startPrepSession(gs, rng);
session.autoStock = true;
let guard = 0;
while (gs.phase === 'PREP' && guard < 10000) { day.stepSession(session, gs, rng, CONFIG.tick); guard++; }

// 检查上架状态
console.log('boba onShelf:', gs.skus.boba_tea.onShelf, 'backroom:', gs.skus.boba_tea.backroom);
console.log('cat_cafe onShelf:', gs.skus.cat_cafe.onShelf);
console.log('snacks onShelf total:', logistics.onShelfOf(gs, 'snacks'));
console.log('shelfState snacks:', logistics.shelfState(gs, 'snacks'));
console.log('displayedSkuCount:', logistics.displayedSkuCount(gs));
console.log('sparseMult:', logistics.sparseDisplayMult(gs));
console.log('skuPrice boba:', gs.skuPrices.boba_tea);

// 追踪一个顾客
day.stepSession(session, gs, rng, CONFIG.tick);
let ticks = 0;
while (session.customers.length === 0 && ticks < 5000) {
  day.stepSession(session, gs, rng, CONFIG.tick);
  ticks++;
}
console.log('first customer arrived at tick', ticks);
const c = session.customers[0];
console.log('customer:', c.type, 'budget:', c.budget, 'state:', c.state);
let trace = 0;
while (c && c.state !== 'GONE' && trace < 3000) {
  day.stepSession(session, gs, rng, CONFIG.tick);
  if (trace % 50 === 0 && c.state !== 'BROWSING') {
    console.log(trace, c.state, 'target:', c.target, 'targetSku:', c.targetSku, 'patience:', c.patience.toFixed(1));
  }
  trace++;
}
console.log('final state:', c.state, 'bought:', c.bought.length, 'satisfaction:', c.satisfaction);
console.log('today: footfall', gs.today.footfall, 'bought', gs.today.bought, 'lost', gs.today.lost);
