import puppeteer from 'puppeteer-core'
const BASE='http://127.0.0.1:5188'
const browser = await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:'new',args:['--no-sandbox']})
const p = await browser.newPage()
await p.setViewport({width:390,height:844,isMobile:true,hasTouch:true})
await p.goto(`${BASE}/#/pages/today/today`,{waitUntil:'networkidle0'})
await new Promise(r=>setTimeout(r,800))
const read = () => p.evaluate(()=>JSON.parse(localStorage.getItem('moss.work.dev-a')).tasks[0].title)
async function tryType(label, fn){
  await p.evaluate(()=>{ localStorage.removeItem('moss.work.dev-a') })
  await p.reload({waitUntil:'networkidle0'}); await new Promise(r=>setTimeout(r,500))
  await p.click('.quickin .qin input')
  await fn()
  await new Promise(r=>setTimeout(r,300))
  await p.keyboard.press('Enter')
  await new Promise(r=>setTimeout(r,400))
  console.log(label, '=>', JSON.stringify(await read()))
}
await tryType('ascii-slow', async()=>{ await p.type('.quickin .qin input','hello world',{delay:80}) })
await tryType('cjk-slow', async()=>{ await p.type('.quickin .qin input','交互测试快速记录',{delay:120}) })
await tryType('insertText', async()=>{ await p.evaluate(()=>{ const el=document.querySelector('.quickin .qin input'); el.focus() }) ; await p.keyboard.sendCharacter('整段输入测试') })
await tryType('native-setter', async()=>{
  await p.evaluate(()=>{
    const el=document.querySelector('.quickin .qin input')
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set
    setter.call(el,'原生设值测试')
    el.dispatchEvent(new Event('input',{bubbles:true}))
  })
})
await browser.close()
