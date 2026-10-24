import puppeteer from 'puppeteer-core'
const b = await puppeteer.launch({ executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:'new', args:['--no-sandbox'] })
console.log('launched', await b.version())
const p = await b.newPage()
p.on('close',()=>console.log('page closed event'))
try { await p.setViewport({width:390,height:844}); console.log('viewport ok') } catch(e){ console.log('viewport fail:', e.message) }
try { await p.goto('file:///Volumes/软件目录/work/zkxh/deepseek/moss-ai-app/docs/prototype/index.html', {waitUntil:'networkidle0'}); console.log('goto ok') } catch(e){ console.log('goto fail:', e.message) }
await b.close()
