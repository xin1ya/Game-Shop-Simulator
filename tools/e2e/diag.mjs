import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:'new',args:['--enable-unsafe-swiftshader','--no-sandbox']});
const page = await browser.newPage();
page.on('pageerror',e=>console.log('[pageerror]',String(e).slice(0,200)));
await page.goto('http://localhost:8321/index.html',{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.BGS && document.querySelector('button[data-k="new"]'),{timeout:30000});
await page.click('button[data-k="new"]');
await page.waitForSelector('[data-k="mall"]');
const r = await page.evaluate(()=>({
  cash1: window.BGS.cheat.cash(5000),
  rep1: window.BGS.cheat.rep(25),
  gs: { cash: window.BGS.gs.cash, rep: window.BGS.gs.reputation },
}));
console.log(JSON.stringify(r, null, 1));
await browser.close();
