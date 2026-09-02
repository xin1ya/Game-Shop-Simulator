import puppeteer from 'puppeteer-core';
for (const proxyArg of ['--proxy-server=127.0.0.1:7890','--proxy-server=http://127.0.0.1:7890','--proxy-server=socks5://127.0.0.1:7890']) {
  const browser = await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:'new',args:['--no-sandbox',proxyArg]});
  try {
    const page = await browser.newPage();
    await page.goto('https://api.ipify.org?format=json',{timeout:15000});
    console.log(proxyArg, '=>', await page.evaluate(()=>document.body.innerText.slice(0,60)));
  } catch (e) { console.log(proxyArg, '=> FAIL', String(e).slice(0,80)); }
  await browser.close();
}
