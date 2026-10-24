/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

declare module '@dcloudio/uni-app' {
  export function onLaunch(cb: () => void): void
  export function onShow(cb: () => void): void
  export function onLoad(cb: (query?: Record<string, string>) => void): void
  export function onHide(cb: () => void): void
  /** 页面出栈/关闭（整页编辑器靠它先 flush 再离开） */
  export function onUnload(cb: () => void): void
}
